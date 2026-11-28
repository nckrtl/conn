//! HTTP routes: the environment descriptor, pairing and auth, and the `/ws` upgrade.
//! Shapes follow `packages/contracts/src/environmentHttp.ts` and `auth.ts`.

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    Extension, Form, Json, Router,
    extract::{ConnectInfo, Path, Query, Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use conn_engine::{Engine, EngineError, ThreadHistory, ThreadTranscript};

use conn_support::time::iso_from_ms;

use crate::{
    auth::{
        self, AccessChange, AuthStore, ClientInfo, ExchangeError, PairingRequest, Principal,
        scope_response,
    },
    scopes,
    session::{self, SessionOptions},
    settings::BatchError,
    table::{CallContext, Failure, MethodTable},
};

pub const ORCHESTRATION_PROTOCOL_VERSION: u32 = 2;
const ORCHESTRATION_PROTOCOL_QUERY_PARAM: &str = "orchestrationProtocol";
const ORCHESTRATION_PROTOCOL_HEADER: &str = "x-t3-orchestration-protocol";
/// The largest client message `/ws` accepts.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub table: Arc<MethodTable>,
    pub auth: Arc<AuthStore>,
    /// `ExecutionEnvironmentDescriptor`, current after each reload (`crate::reload`).
    pub descriptor: tokio::sync::watch::Receiver<Value>,
    /// Backs the orchestration snapshot routes; without it they answer 404.
    pub engine: Option<Arc<dyn Engine>>,
    /// The services the method table was built from, for the routes in `routes/`.
    pub deps: crate::methods::Deps,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("table", &self.table)
            .field("auth", &self.auth)
            .field("descriptor", &self.descriptor)
            .field("deps", &self.deps)
            .finish_non_exhaustive()
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/.well-known/t3/environment", get(descriptor))
        .route("/api/auth/session", get(session_state))
        .route("/oauth/token", post(token))
        .route("/api/auth/websocket-ticket", post(ticket))
        .route("/api/auth/websocket-ticket/{use}", post(ticket_for))
        .route("/api/auth/pairing-token", post(pairing_token))
        .route("/api/auth/pairing-links/revoke", post(revoke_pairing_link))
        .route("/api/auth/clients", get(clients))
        .route("/api/auth/clients/revoke", post(revoke_client))
        .route("/api/auth/clients/extend", post(extend_client))
        .route("/api/auth/logout", post(logout))
        .route(
            "/api/auth/clients/revoke-others",
            post(revoke_other_clients),
        )
        .route("/api/orchestration/shell", get(shell_snapshot))
        .route("/api/projects/mutate", post(projects_mutate))
        .route(
            "/api/settings/provider-instances",
            get(provider_instances).post(mutate_provider_instances),
        )
        .route(
            "/api/orchestration/threads/{thread_id}",
            get(thread_snapshot),
        )
        .route(
            "/api/orchestration/threads/{thread_id}/transcript",
            get(thread_transcript),
        )
        .route(
            "/api/orchestration/threads/{thread_id}/history",
            get(thread_history),
        )
        .route(
            "/api/orchestration/threads/{thread_id}/outline",
            get(thread_outline),
        )
        .route(
            "/api/orchestration/threads/{thread_id}/window",
            get(thread_window),
        )
        .route("/ws", get(ws))
        .merge(crate::routes::router())
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

/// Packaged T3 allows any origin: credentials are bearer tokens, never cookies.
async fn cors(request: Request, next: Next) -> Response {
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "authorization, b3, traceparent, content-type, dpop, x-t3-orchestration-protocol",
        ),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}

/// The T3 server serves its web client here. This server has none (clients are the Conn apps),
/// but the root must still answer 2xx: Conn desktop's SSH setup (`__ssh-helper wait-ready`,
/// `packages/ssh`) probes `GET /` on the host's loopback server before it reuses it, and
/// without a 2xx it would neither attach nor start a second server.
async fn root() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><meta charset=\"utf-8\"><title>Conn Server</title>\
         <p>This is a Conn Server. Connect to it from a Conn app.</p>\n",
    )
        .into_response()
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let coverage = state.table.coverage();
    // The T3 server has no `/health`; this route is how a caller tells the Conn Server apart.
    Json(json!({
        "status": "ok",
        "server": "conn-server",
        "version": env!("CARGO_PKG_VERSION"),
        "contractDigest": conn_contract::contract_digest(),
        "methods": { "implemented": coverage.implemented, "total": coverage.total },
    }))
}

async fn descriptor(State(state): State<AppState>) -> Json<Value> {
    Json(state.descriptor.borrow().clone())
}

async fn session_state(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let Some(principal) = bearer(&headers).and_then(|t| state.auth.authenticate_bearer(t)) else {
        return Json(json!({ "authenticated": false, "auth": state.auth.descriptor() }));
    };
    let mut body = scope_response(&principal.scopes);
    body["authenticated"] = json!(true);
    body["auth"] = state.auth.descriptor();
    body["sessionMethod"] = json!("bearer-access-token");
    body["expiresAt"] = json!(iso_from_ms(principal.expires_at_ms));
    Json(body)
}

/// `AuthTokenExchangeRequest`, form encoded.
#[derive(Deserialize)]
struct TokenRequest {
    grant_type: String,
    subject_token: String,
    subject_token_type: String,
    requested_token_type: String,
    scope: Option<String>,
    client_label: Option<String>,
    client_device_type: Option<String>,
    client_os: Option<String>,
}

const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
const BOOTSTRAP_TOKEN_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";

/// `CREDENTIAL_RESPONSE_HEADERS`: no cache may keep a response that carries a credential.
fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

async fn token(
    State(state): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Form(request): Form<TokenRequest>,
) -> Response {
    // The exchange writes `auth.json` and may read T3's pairing table: blocking work.
    let exchanged =
        tokio::task::spawn_blocking(move || exchange_token(&state, peer, &headers, request)).await;
    no_store(exchanged.unwrap_or_else(|_| internal_reason("access_token_issuance_failed")))
}

fn exchange_token(
    state: &AppState,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: &HeaderMap,
    request: TokenRequest,
) -> Response {
    if request.grant_type != GRANT_TYPE
        || request.subject_token_type != BOOTSTRAP_TOKEN_TYPE
        || request.requested_token_type != ACCESS_TOKEN_TYPE
    {
        return error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_command",
        );
    }
    // A DPoP client expects a key-bound token. A bearer token would drop that binding,
    // so refuse before the code is spent.
    if headers.contains_key("dpop") {
        return auth_invalid("invalid_credential");
    }
    let requested: Option<Vec<String>> = request
        .scope
        .as_deref()
        .map(|scope| scope.split_whitespace().map(str::to_owned).collect());
    let device_type = request.client_device_type.filter(|d| {
        matches!(
            d.as_str(),
            "desktop" | "mobile" | "tablet" | "bot" | "unknown"
        )
    });
    let client = ClientInfo::from_request(
        request.client_label,
        device_type,
        request.client_os.filter(|o| !o.trim().is_empty()),
        headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
        peer.map(|Extension(ConnectInfo(addr))| addr.ip().to_canonical().to_string()),
    );
    match state
        .auth
        .exchange(&request.subject_token, requested.as_deref(), client)
    {
        Ok(issued) => Json(json!({
            "access_token": issued.token,
            "issued_token_type": ACCESS_TOKEN_TYPE,
            "token_type": "Bearer",
            "expires_in": issued.principal.expires_at_ms.saturating_sub(conn_support::time::now_ms()) / 1000,
            "scope": issued.principal.scopes.join(" "),
        }))
        .into_response(),
        Err(ExchangeError::InvalidCredential) => auth_invalid("invalid_credential"),
        Err(ExchangeError::InvalidScope) => error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_scope",
        ),
        Err(ExchangeError::ScopeNotGranted) => error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "scope_not_granted",
        ),
        Err(ExchangeError::Storage) => internal_reason("access_token_issuance_failed"),
    }
}

async fn ticket(State(state): State<AppState>, headers: HeaderMap) -> Response {
    issue_ticket(&state, &headers, None)
}

async fn ticket_for(
    State(state): State<AppState>,
    Path(route): Path<String>,
    headers: HeaderMap,
) -> Response {
    if route != "rpc" && route != "media" {
        return StatusCode::NOT_FOUND.into_response();
    }
    issue_ticket(&state, &headers, Some(&route))
}

fn issue_ticket(state: &AppState, headers: &HeaderMap, route: Option<&str>) -> Response {
    let Some(token) = bearer(headers) else {
        return auth_invalid("missing_credential");
    };
    match state.auth.issue_ticket(token, route) {
        Some((ticket, expires_at_ms)) => no_store(
            Json(json!({ "ticket": ticket, "expiresAt": iso_from_ms(expires_at_ms) }))
                .into_response(),
        ),
        None => auth_invalid("invalid_credential"),
    }
}

/// `AuthCreatePairingCredentialInput`, plus Conn's `sessionTtl` for the session the code grants.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PairingTokenRequest {
    label: Option<String>,
    scopes: Option<Vec<String>>,
    access: Option<String>,
    purpose: Option<String>,
    /// Any JSON value, so `null` and numbers reach [`session_ttl`] and get its 400.
    #[serde(default, deserialize_with = "present")]
    session_ttl: Option<Value>,
}

/// A field that is present, `null` included; a missing one stays `None` (`serde(default)`).
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// A request's `sessionTtl`: only the string `until-revoked` is taken.
fn session_ttl(value: &Value) -> Option<u64> {
    value.as_str().and_then(auth::parse_session_ttl)
}

/// A `sessionTtl` other than `until-revoked`: 400.
fn invalid_session_ttl() -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "EnvironmentRequestInvalidError",
        "invalid_session_ttl",
        "session_ttl_must_be_until_revoked",
    )
}

/// The bearer session behind a request, or the 401 refusing it.
fn authenticated(state: &AppState, headers: &HeaderMap) -> Result<Principal, Box<Response>> {
    let Some(token) = bearer(headers) else {
        return Err(Box::new(auth_invalid("missing_credential")));
    };
    state
        .auth
        .authenticate_bearer(token)
        .ok_or_else(|| Box::new(auth_invalid("invalid_credential")))
}

/// The bearer session behind a request that needs `scope`, or the response refusing it.
pub(crate) fn require_scope(
    state: &AppState,
    headers: &HeaderMap,
    scope: &str,
) -> Result<Principal, Box<Response>> {
    let principal = authenticated(state, headers)?;
    if !principal.has_scope(scope) {
        return Err(Box::new(scope_required(scope)));
    }
    Ok(principal)
}

/// `EnvironmentScopeRequiredError`, 403.
pub(crate) fn scope_required(scope: &str) -> Response {
    Json(scope_required_body(scope)).with_status(StatusCode::FORBIDDEN)
}

fn scope_required_body(scope: &str) -> Value {
    json!({
        "_tag": "EnvironmentScopeRequiredError",
        "code": "insufficient_scope",
        "requiredScope": auth::legacy_parent(scope),
        "requiredPermission": scope,
        "traceId": trace_id(),
    })
}

fn internal(reason: &str, error: std::io::Error) -> Response {
    eprintln!("conn-server: {reason}: {error}");
    Json(json!({
        "_tag": "EnvironmentInternalError",
        "code": "internal_error",
        "reason": reason,
        "traceId": trace_id(),
    }))
    .with_status(StatusCode::INTERNAL_SERVER_ERROR)
}

/// `POST /api/auth/pairing-token`: a one-time link with the standard scopes or the ones named,
/// each of which the caller must hold. Orbit's Gateway creates its device links here.
async fn pairing_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<PairingTokenRequest>>,
) -> Response {
    // The auth store rereads and writes `auth.json` under a file lock: blocking work, off the
    // runtime thread.
    let request = body.map(|Json(b)| b).unwrap_or_default();
    tokio::task::spawn_blocking(move || pairing_token_blocking(&state, &headers, request))
        .await
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn pairing_token_blocking(
    state: &AppState,
    headers: &HeaderMap,
    request: PairingTokenRequest,
) -> Response {
    let principal = match require_scope(state, headers, "access:write") {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let session_ttl_ms = match &request.session_ttl {
        None => None,
        Some(ttl) => match session_ttl(ttl) {
            Some(ms) => Some(ms),
            None => return invalid_session_ttl(),
        },
    };
    // A peer-link code (`peerLinkPairingCodes`): the scopes its access needs, spent only by a link.
    if let (Some(access), Some("peer-link")) =
        (request.access.as_deref(), request.purpose.as_deref())
        && auth::is_mcp_access(access)
    {
        if let Some(missing) = auth::mcp_client_scopes(access)
            .iter()
            .find(|s| !principal.has_scope(s))
        {
            return scope_required(missing);
        }
        let label = request.label.filter(|l| !l.trim().is_empty());
        let issued = match state
            .auth
            .issue_peer_link_pairing(access, label, session_ttl_ms)
        {
            Ok(issued) => issued,
            Err(e) => return internal("pairing_credential_issuance_failed", e),
        };
        let mut body = json!({
            "id": issued.id,
            "credential": issued.code,
            "expiresAt": iso_from_ms(issued.expires_at_ms),
            "access": access,
            "purpose": "peer-link",
        });
        if let Some(label) = issued.label {
            body["label"] = json!(label);
        }
        return no_store(Json(body).into_response());
    }
    // MCP approval codes (`access` alone) are not served: only peer-link codes are. A
    // `purpose` without its `access` matches no branch of `AuthCreatePairingCredentialInput`,
    // so it is refused too, never issued as an ordinary pairing code.
    if request.access.is_some() || request.purpose.is_some() {
        return error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_scope",
        );
    }
    let scopes: Vec<String> = request.scopes.unwrap_or_else(|| {
        auth::STANDARD_SCOPES
            .iter()
            .map(|s| s.to_string())
            .collect()
    });
    let mut unique = scopes.clone();
    unique.sort();
    unique.dedup();
    if scopes.is_empty()
        || unique.len() != scopes.len()
        || !scopes.iter().all(|s| auth::is_grant_scope(s))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_scope",
        );
    }
    if let Some(missing) = scopes.iter().find(|s| !principal.has_scope(s)) {
        return scope_required(missing);
    }
    let label = request.label.filter(|l| !l.trim().is_empty());
    let issued = match state.auth.issue_pairing(PairingRequest {
        scopes,
        label,
        ttl_ms: auth::PAIRING_CODE_TTL_MS,
        session_ttl_ms,
    }) {
        Ok(issued) => issued,
        Err(e) => return internal("pairing_credential_issuance_failed", e),
    };
    let mut body = json!({
        "id": issued.id,
        "credential": issued.code,
        "expiresAt": iso_from_ms(issued.expires_at_ms),
    });
    if let Some(label) = issued.label {
        body["label"] = json!(label);
    }
    // The T3 server sends no cache headers here; the body is a credential all the same.
    no_store(Json(body).into_response())
}

#[derive(Deserialize)]
struct IdRequest {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdRequest {
    session_id: String,
}

async fn revoke_pairing_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<IdRequest>,
) -> Response {
    if let Err(response) = require_scope(&state, &headers, "access:write") {
        return *response;
    }
    match state.auth.revoke_pairing_link(&request.id) {
        Ok(revoked) => Json(json!({ "revoked": revoked })).into_response(),
        Err(e) => internal("pairing_link_revoke_failed", e),
    }
}

/// `GET /api/auth/clients`: the Gateway checks a session's owner here before revoking it.
async fn clients(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match require_scope(&state, &headers, "access:read") {
        Ok(principal) => {
            Json(state.auth.client_sessions(Some(&principal.session_id))).into_response()
        }
        Err(response) => *response,
    }
}

async fn revoke_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SessionIdRequest>,
) -> Response {
    let principal = match require_scope(&state, &headers, "access:write") {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state
        .auth
        .revoke_session(Some(&principal.session_id), &request.session_id)
    {
        Ok(Ok(revoked)) => Json(json!({ "revoked": revoked })).into_response(),
        Ok(Err(auth::RevokeCurrentSession)) => Json(json!({
            "_tag": "EnvironmentOperationForbiddenError",
            "code": "operation_forbidden",
            "reason": "current_session_revoke_not_allowed",
            "traceId": trace_id(),
        }))
        .with_status(StatusCode::FORBIDDEN),
        Err(e) => internal("client_session_revoke_failed", e),
    }
}

/// `POST /api/auth/logout` (Conn only): ends the caller's own session, which
/// `/api/auth/clients/revoke` refuses. Any session may call it, native or MCP. A repeat gets
/// the usual 401, which a caller counts as done. Sessions here are bearer tokens, so no
/// cookie to clear.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    tokio::task::spawn_blocking(move || {
        let Some(token) = bearer(&headers) else {
            return auth_invalid("missing_credential");
        };
        match state.auth.logout(token) {
            Ok(Some(id)) => {
                no_store(Json(json!({ "sessionId": id, "revoked": true })).into_response())
            }
            Ok(None) => auth_invalid("invalid_credential"),
            Err(e) => internal("client_session_revoke_failed", e),
        }
    })
    .await
    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtendRequest {
    session_id: Option<String>,
    /// Any JSON value, missing as `null`, so every value but `until-revoked` gets the 400.
    #[serde(default)]
    session_ttl: Value,
}

/// `POST /api/auth/clients/extend` (Conn only): moves a session's end out, the caller's own
/// without `sessionId`. Orbit upgrades held sessions here instead of pairing again, and a
/// peer link's holder upgrades its own MCP session.
async fn extend_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ExtendRequest>,
) -> Response {
    tokio::task::spawn_blocking(move || extend_client_blocking(&state, &headers, request))
        .await
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn extend_client_blocking(
    state: &AppState,
    headers: &HeaderMap,
    request: ExtendRequest,
) -> Response {
    // A peer link's MCP session may extend itself, so links upgrade without a re-pair.
    // Any other MCP session, and any `sessionId`, needs a native session with access:write.
    let mcp = bearer(headers).and_then(|token| state.auth.authenticate_mcp_client(token));
    let id = match (mcp, request.session_id) {
        (Some(mcp), None) if mcp.peer_link => mcp.session_id,
        (Some(_), _) => return scope_required("access:write"),
        (None, session_id) => match require_scope(state, headers, "access:write") {
            Ok(principal) => session_id.unwrap_or(principal.session_id),
            Err(response) => return *response,
        },
    };
    let Some(ttl_ms) = session_ttl(&request.session_ttl) else {
        return invalid_session_ttl();
    };
    match state.auth.extend_session(&id, ttl_ms) {
        Ok(Ok(expires_at_ms)) => Json(json!({
            "sessionId": id,
            "expiresAt": iso_from_ms(expires_at_ms),
        }))
        .into_response(),
        Ok(Err(auth::ExtendError::NotFound)) => error(
            StatusCode::NOT_FOUND,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "client_session_not_found",
        ),
        Ok(Err(auth::ExtendError::CarriedFromT3)) => error(
            StatusCode::CONFLICT,
            "EnvironmentOperationForbiddenError",
            "operation_forbidden",
            "t3_session_extend_not_allowed",
        ),
        Err(e) => internal("client_session_extend_failed", e),
    }
}

async fn revoke_other_clients(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let principal = match require_scope(&state, &headers, "access:write") {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    match state.auth.revoke_other_sessions(&principal.session_id) {
        Ok(count) => Json(json!({ "revokedCount": count })).into_response(),
        Err(e) => internal("client_session_revoke_failed", e),
    }
}

/// Checks what every `/api/orchestration/*` route requires: the protocol header, a bearer
/// token with `orchestration:read`, and an engine.
fn orchestration_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Arc<dyn Engine>, Box<Response>> {
    if headers
        .get(ORCHESTRATION_PROTOCOL_HEADER)
        .and_then(|v| v.to_str().ok())
        != Some("2")
    {
        return Err(Box::new(error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_command",
        )));
    }
    require_scope(state, headers, "orchestration:read")?;
    state
        .engine
        .clone()
        .ok_or_else(|| Box::new(StatusCode::NOT_FOUND.into_response()))
}

fn snapshot_failed<E>(reason: &str, error: EngineError<E>) -> Response {
    if let EngineError::Internal(message) = &error {
        eprintln!("{reason}: {message}");
    }
    Json(json!({
        "_tag": "EnvironmentInternalError",
        "code": "internal_error",
        "reason": reason,
        "traceId": trace_id(),
    }))
    .with_status(StatusCode::INTERNAL_SERVER_ERROR)
}

/// `GET /api/orchestration/shell` (`answerShellSnapshot`): `{"resumable":true}` when the
/// shell stream can resume from `resumeFrom`, else the snapshot with the query's omissions,
/// as `subscribeShell` trims it.
async fn shell_snapshot(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    let flag = |name: &str| query.get(name).is_some_and(|v| v == "1");
    let options = conn_engine::HttpShellQuery {
        omit_idle_subagents: flag("omitIdleSubagents"),
        omit_older_settled: flag("omitOlderSettled"),
        // `Number.isSafeInteger(resumeFrom) && resumeFrom >= 0`.
        resume_from: query
            .get("resumeFrom")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|v| *v < (1 << 53)),
    };
    match engine.http_shell_snapshot(options).await {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => Json(json!({"resumable": true})).into_response(),
        Err(error) => snapshot_failed("orchestration_snapshot_failed", error),
    }
}

/// `GET /api/orchestration/threads/:threadId`. An unknown thread is a plain 404, never the
/// structured not-found error, which would make the client mark the thread deleted.
async fn thread_snapshot(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    match engine.thread_snapshot(thread_id.into()).await {
        Ok(Some(snapshot)) => Json(snapshot).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => snapshot_failed("orchestration_thread_snapshot_failed", error),
    }
}

async fn thread_outline(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    history_result(engine.thread_outline(thread_id.into()).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowQuery {
    entry_id: String,
}

async fn thread_window(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<WindowQuery>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    history_result(engine.thread_window(thread_id.into(), query.entry_id).await)
}

fn history_result<T: serde::Serialize, E>(result: Result<Option<T>, EngineError<E>>) -> Response {
    match result {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => snapshot_failed("orchestration_thread_history_failed", error),
    }
}

/// Full-thread exports at once, as T3's `transcriptExportPermits`: each holds a whole
/// projection in memory.
static TRANSCRIPT_EXPORTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// `GET /api/orchestration/threads/:threadId/transcript` (`OrchestrationV2ThreadTranscript`):
/// the thread's visible turn items for the composer's context import. As T3's
/// `getThreadTranscript`, the items are the stored ones, not cut for transport. A transcript
/// whose file (header line plus one JSON line per item) would pass
/// `PROVIDER_SEND_TURN_MAX_FILE_BYTES` is refused with `thread_transcript_too_large`; the
/// engine stops reading at that row (`Engine::thread_transcript`). An
/// unknown thread is T3's `EnvironmentResourceNotFoundError`: the caller is a command, not the
/// thread view.
async fn thread_transcript(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    let Ok(_permit) = TRANSCRIPT_EXPORTS.acquire().await else {
        return internal_reason("orchestration_thread_snapshot_failed");
    };
    let environment_id = state.descriptor.borrow()["environmentId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let limit = conn_contract::PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    // The engine reads and encodes off the runtime thread, and stops at the limit.
    match engine
        .thread_transcript(thread_id.into(), environment_id, limit)
        .await
    {
        Ok(ThreadTranscript::Body(body)) => (
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )],
            body,
        )
            .into_response(),
        Ok(ThreadTranscript::NotFound) => error(
            StatusCode::NOT_FOUND,
            "EnvironmentResourceNotFoundError",
            "not_found",
            "thread_not_found",
        ),
        Ok(ThreadTranscript::TooLarge) => error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "thread_transcript_too_large",
        ),
        Err(error) => snapshot_failed("orchestration_thread_snapshot_failed", error),
    }
}

/// `GET /api/orchestration/threads/:threadId/history?cursor=` (`OrchestrationV2ThreadHistoryPage`):
/// the page before a bounded snapshot's or an earlier page's cursor (T3's `threadHistoryPage`).
/// `view=conversation` leaves work rows out. Work folding (`deferWork`, `view=work`) is not
/// served: this server's snapshots fold no work.
async fn thread_history(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let engine = match orchestration_access(&state, &headers) {
        Ok(engine) => engine,
        Err(response) => return *response,
    };
    let invalid = || {
        error(
            StatusCode::BAD_REQUEST,
            "EnvironmentRequestInvalidError",
            "invalid_request",
            "invalid_history_cursor",
        )
    };
    let Some(cursor) = query.get("cursor").cloned() else {
        return invalid();
    };
    let view = match query.get("view").map(String::as_str) {
        Some("messages") => conn_engine::HistoryView::Messages,
        Some("conversation") => conn_engine::HistoryView::Conversation,
        _ => conn_engine::HistoryView::Timeline,
    };
    match engine
        .thread_history_page(
            thread_id.into(),
            cursor,
            query.get("throughEntryId").cloned(),
            view,
        )
        .await
    {
        Ok(ThreadHistory::Page(page)) => Json(page).into_response(),
        Ok(ThreadHistory::NotFound) => error(
            StatusCode::NOT_FOUND,
            "EnvironmentResourceNotFoundError",
            "not_found",
            "thread_not_found",
        ),
        Ok(ThreadHistory::InvalidCursor) => invalid(),
        Err(error) => snapshot_failed("orchestration_thread_history_failed", error),
    }
}

/// `POST /api/projects/mutate`: `projects.mutate` over HTTP, so `conn-server project add`
/// reaches a running server without a WebSocket (Orbit adds its project this way). The body
/// is the method's payload. It needs the same scopes as over `/ws`
/// (`requiredScopesForProjectMutation`): changing scripts, which run on the host, takes
/// `settings:write` too. Errors answer as `project/http.ts` does.
async fn projects_mutate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let principal = match authenticated(&state, &headers) {
        Ok(principal) => principal,
        Err(response) => return *response,
    };
    let context = CallContext {
        principal: Some(Arc::new(principal)),
        ..CallContext::default()
    };
    if let Err(failure) = scopes::check("projects.mutate", &context, &body) {
        let (Failure::Fail(error) | Failure::Die(error)) = failure;
        let scope = error
            .get("requiredPermission")
            .and_then(Value::as_str)
            .unwrap_or("orchestration:operate");
        return scope_required(scope);
    }
    let Some(engine) = &state.engine else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match engine.call("projects.mutate", body).await {
        Ok(result) => Json(result).into_response(),
        Err(EngineError::Rejected(error)) if is_invalid_project_command(&error) => error_invalid(),
        Err(EngineError::Rejected(error)) => {
            eprintln!("conn-server: project_mutation_failed: {error}");
            internal_reason("project_mutation_failed")
        }
        Err(EngineError::Internal(message)) => {
            eprintln!("conn-server: project_mutation_failed: {message}");
            internal_reason("project_mutation_failed")
        }
    }
}

const PROVIDERS_MANAGE: &str = "providers:manage";

/// `GET /api/settings/provider-instances`: `providerInstances` of the settings as
/// `server.getSettings` sends them, secrets left out. Orbit reads what it provisioned here.
async fn provider_instances(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = require_providers_manage(&state, &headers) {
        return *response;
    }
    let Some(environment) = &state.deps.environment else {
        return engine_unavailable();
    };
    crate::settings::refresh(environment).await;
    provider_instances_view(&environment.settings.for_client())
}

/// `POST /api/settings/provider-instances` (ADR 0274): up to 32 `providerInstanceMutation`s
/// of `server.updateSettings`, applied in order and saved once with one revision and the live
/// reconcile (`SettingsStore::apply_provider_instances`). A failed mutation saves nothing.
/// The credential and the engine are checked before the body is read. The body holds
/// secrets: nothing here logs it.
async fn mutate_provider_instances(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    if let Err(response) = require_providers_manage(&state, &headers) {
        return *response;
    }
    let (Some(_), Some(environment)) = (&state.engine, &state.deps.environment) else {
        return engine_unavailable();
    };
    let Ok(body) = axum::body::to_bytes(body, MAX_MESSAGE_BYTES).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let mutations = match provider_instance_mutations(&body) {
        Ok(mutations) => mutations,
        Err(message) => return invalid_mutation(0, message),
    };
    let environment = environment.clone();
    let saved = tokio::task::spawn_blocking(move || {
        environment.settings.apply_provider_instances(mutations)
    })
    .await;
    match saved {
        Ok(Ok(view)) => provider_instances_view(&view),
        Ok(Err(BatchError::Invalid { index, message })) => invalid_mutation(index, &message),
        Ok(Err(BatchError::Failed(error))) => {
            eprintln!(
                "conn-server: provider_instances_update_failed: {}",
                error.operation
            );
            internal_reason("provider_instances_update_failed")
        }
        Err(_) => internal_reason("provider_instances_update_failed"),
    }
}

/// [`require_scope`] for `providers:manage`; the 403 also carries the `scope_required` reason
/// that ADR 0274 names.
fn require_providers_manage(state: &AppState, headers: &HeaderMap) -> Result<(), Box<Response>> {
    let principal = authenticated(state, headers)?;
    if principal.has_scope(PROVIDERS_MANAGE) {
        return Ok(());
    }
    let mut body = scope_required_body(PROVIDERS_MANAGE);
    body["reason"] = json!("scope_required");
    Err(Box::new(Json(body).with_status(StatusCode::FORBIDDEN)))
}

/// The request's `mutations` list; each one is checked in order by the settings store.
fn provider_instance_mutations(body: &[u8]) -> Result<Vec<Value>, &'static str> {
    let body: Value = serde_json::from_slice(body).map_err(|_| "the body is not JSON")?;
    match body.get("mutations") {
        Some(Value::Array(mutations)) => Ok(mutations.clone()),
        _ => Err("the body holds no mutations list"),
    }
}

/// `{"providerInstances": …}` from a client view of the settings.
fn provider_instances_view(settings: &Value) -> Response {
    let instances = settings
        .get("providerInstances")
        .cloned()
        .unwrap_or_else(|| json!({}));
    Json(json!({ "providerInstances": instances })).into_response()
}

/// ADR 0274's 400 body, exactly: Orbit's Gateway reads `reason` and `index`.
fn invalid_mutation(index: usize, message: &str) -> Response {
    Json(json!({ "reason": "invalid_mutation", "index": index, "message": message }))
        .with_status(StatusCode::BAD_REQUEST)
}

/// ADR 0274's 503 body, exactly.
fn engine_unavailable() -> Response {
    Json(json!({ "reason": "engine_unavailable" })).with_status(StatusCode::SERVICE_UNAVAILABLE)
}

/// `failProjectMutation`: a project the request names wrongly is the caller's error.
fn is_invalid_project_command(error: &Value) -> bool {
    matches!(
        error["cause"]["_tag"].as_str(),
        Some(
            "ProjectNotFoundError"
                | "ProjectConflictError"
                | "ProjectNotEmptyError"
                | "ProjectInvalidError"
        )
    )
}

fn error_invalid() -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "EnvironmentRequestInvalidError",
        "invalid_request",
        "invalid_command",
    )
}

/// `EnvironmentInternalError`, 500. The cause goes to the log, never to the client.
pub(crate) fn internal_reason(reason: &str) -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "EnvironmentInternalError",
        "internal_error",
        reason,
    )
}

async fn ws(
    upgrade: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if query
        .get(ORCHESTRATION_PROTOCOL_QUERY_PARAM)
        .map(String::as_str)
        != Some("2")
    {
        return Json(json!({
            "code": "orchestration_protocol_incompatible",
            "message": format!("Update this client to one that supports orchestration protocol {ORCHESTRATION_PROTOCOL_VERSION}."),
            "orchestrationProtocolVersion": ORCHESTRATION_PROTOCOL_VERSION,
        }))
        .with_status(StatusCode::UPGRADE_REQUIRED);
    }
    let Some(principal) = authenticate_upgrade(&state, &query, &headers, "rpc") else {
        let reason =
            if query.contains_key("wsTicket") || headers.contains_key(header::AUTHORIZATION) {
                "invalid_credential"
            } else {
                "missing_credential"
            };
        return auth_invalid(reason);
    };
    let session_id = principal.session_id.clone();
    let options = SessionOptions {
        frame_parts: query.contains_key(conn_wire::frame_parts::QUERY_PARAM),
        max_message_bytes: MAX_MESSAGE_BYTES,
        context: CallContext {
            headers: Vec::new(),
            principal: Some(Arc::new(principal)),
            ..CallContext::default()
        },
        gate: None,
    };
    let table = state.table.clone();
    let auth = state.auth;
    upgrade
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            let _connected = auth.connect(&session_id);
            // A revoked session loses its open sockets at once, as with the T3 server.
            tokio::select! {
                _ = session::run(socket, table, options) => {}
                _ = revoked(&auth, &session_id) => {}
            }
        })
}

/// A periodic check that never catches up. tokio's default (`Burst`) fires every missed tick
/// back to back: after a 3-day container freeze, 8,640 checks at once for a 30 s period.
pub(crate) fn check_every(period: Duration) -> tokio::time::Interval {
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval
}

/// Resolves once `session_id` is revoked or expires, here or by another process (the CLI).
pub(crate) async fn revoked(auth: &AuthStore, session_id: &str) {
    let mut changes = auth.subscribe();
    let mut check = check_every(Duration::from_secs(30));
    loop {
        tokio::select! {
            change = changes.recv() => match change {
                Ok(AccessChange::ClientRemoved(id)) if id == session_id => return,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_))
                    if !auth.session_active(session_id) => return,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
                _ => {}
            },
            _ = check.tick() => {
                if !auth.session_active(session_id) {
                    return;
                }
            }
        }
    }
}

/// `authenticateWebSocketUpgrade`: a ticket for the route's scope, else a bearer header.
pub(crate) fn authenticate_upgrade(
    state: &AppState,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    scope: &str,
) -> Option<Principal> {
    match query
        .get("wsTicket")
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    {
        Some(ticket) => state.auth.authenticate_ticket(ticket, scope),
        None => bearer(headers).and_then(|t| state.auth.authenticate_bearer(t)),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

fn trace_id() -> String {
    auth::random_hex(16)
}

pub(crate) fn auth_invalid(reason: &str) -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        "EnvironmentAuthInvalidError",
        "auth_invalid",
        reason,
    )
}

fn error(status: StatusCode, tag: &str, code: &str, reason: &str) -> Response {
    Json(json!({ "_tag": tag, "code": code, "reason": reason, "traceId": trace_id() }))
        .with_status(status)
}

trait WithStatus {
    fn with_status(self, status: StatusCode) -> Response;
}

impl<T: IntoResponse> WithStatus for T {
    fn with_status(self, status: StatusCode) -> Response {
        (status, self).into_response()
    }
}

#[cfg(test)]
mod tests {
    /// A thaw after a freeze in which the monotonic clock ran on: one tick, then the period.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_check_fires_once_after_a_long_freeze() {
        let mut check = super::check_every(std::time::Duration::from_secs(30));
        check.tick().await;
        for jump in [10 * 60, 2 * 3600, 3 * 86_400] {
            tokio::time::advance(std::time::Duration::from_secs(jump)).await;
            let mut ticks = 0;
            while tokio::time::timeout(std::time::Duration::ZERO, check.tick())
                .await
                .is_ok()
            {
                ticks += 1;
            }
            assert_eq!(ticks, 1, "after +{jump}s");
        }
    }

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    /// Conn desktop's SSH setup reuses a host's server only when `GET /` answers 2xx.
    #[tokio::test]
    async fn the_root_answers_for_the_ssh_readiness_probe() {
        let (addr, _) = serve().await;
        let (status, _) = call(addr, "GET / HTTP/1.1", "").await;
        assert_eq!(status, 200);
    }

    async fn serve() -> (std::net::SocketAddr, Arc<AuthStore>) {
        serve_with(None).await
    }

    async fn serve_with(engine: Option<Arc<dyn Engine>>) -> (std::net::SocketAddr, Arc<AuthStore>) {
        serve_with_deps(engine, Default::default()).await
    }

    async fn serve_with_deps(
        engine: Option<Arc<dyn Engine>>,
        deps: crate::methods::Deps,
    ) -> (std::net::SocketAddr, Arc<AuthStore>) {
        let auth = AuthStore::in_memory();
        let state = AppState {
            table: Arc::new(MethodTable::new()),
            auth: auth.clone(),
            descriptor: crate::environment::fixed_descriptor(crate::environment::descriptor(
                "env-test", "Test", false, None,
            )),
            engine,
            deps,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(state)).await });
        (addr, auth)
    }

    /// A server whose auth store keeps `auth.json` in a temp folder, with `/mcp` served.
    async fn serve_on_disk(dir: &std::path::Path) -> (std::net::SocketAddr, Arc<AuthStore>) {
        let auth = AuthStore::open(dir.join("auth.json")).unwrap();
        let environment = Arc::new(
            crate::environment::Environment::load(dir, None, dir.to_owned(), Default::default())
                .unwrap(),
        );
        let engine: Arc<dyn Engine> = Arc::new(
            conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
                dir.join("engine.sqlite"),
            ))
            .unwrap(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut deps = crate::methods::Deps {
            environment: Some(environment),
            engine: Some(engine),
            ..Default::default()
        };
        deps.mcp = crate::routes::mcp::service(&deps, addr);
        let state = AppState {
            table: Arc::new(MethodTable::new()),
            auth: auth.clone(),
            descriptor: crate::environment::fixed_descriptor(crate::environment::descriptor(
                "env-test", "Test", false, None,
            )),
            engine: None,
            deps,
        };
        tokio::spawn(async move { axum::serve(listener, router(state)).await });
        (addr, auth)
    }

    /// How long a 100 ms sleep on this (single) runtime thread takes while `request` runs: a
    /// handler that blocks the thread delays it by as long as it blocks.
    async fn sleep_while(
        addr: std::net::SocketAddr,
        head: &'static str,
        body: &'static str,
    ) -> Duration {
        let request = tokio::spawn(async move { call(addr, head, body).await });
        let started = std::time::Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let slept = started.elapsed();
        request.await.unwrap();
        slept
    }

    /// Minting a pairing code writes `auth.json` under its file lock. While another process
    /// holds the lock, the runtime thread must stay free.
    #[tokio::test(flavor = "current_thread")]
    async fn a_pairing_code_write_waits_off_the_runtime_thread() {
        let dir = std::env::temp_dir().join(format!("conn-http-lock-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (addr, auth) = serve_on_disk(&dir).await;
        let token = auth
            .issue_session(auth::SessionRequest {
                scopes: auth::STANDARD_SCOPES
                    .iter()
                    .map(|s| (*s).to_owned())
                    .collect(),
                label: None,
                subject: None,
                ttl_ms: auth::SESSION_TTL_MS,
            })
            .unwrap()
            .token;
        let (held, release) = (std::sync::mpsc::channel(), std::sync::mpsc::channel::<()>());
        let lock = dir.join("auth.lock");
        let holder = std::thread::spawn(move || {
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(lock)
                .unwrap();
            file.lock().unwrap();
            held.0.send(()).unwrap();
            let _ = release.1.recv_timeout(Duration::from_millis(800));
        });
        held.1.recv().unwrap();
        let head: &'static str = Box::leak(
            format!("POST /api/auth/pairing-token HTTP/1.1\r\nauthorization: Bearer {token}\r\ncontent-type: application/json").into_boxed_str(),
        );
        let request = tokio::spawn(async move {
            call(addr, head, r#"{"access":"auto","purpose":"peer-link"}"#).await
        });
        let started = std::time::Instant::now();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let slept = started.elapsed();
        release.0.send(()).unwrap();
        let (status, _) = request.await.unwrap();
        holder.join().unwrap();
        assert_eq!(status, 200);
        assert!(
            slept < Duration::from_millis(400),
            "the runtime thread was blocked for {slept:?}"
        );
    }

    /// `/mcp` authenticates through the auth store, which rereads `auth.json` when another
    /// process changed it. A slow read (here a FIFO with no writer yet) must not block the
    /// runtime thread.
    #[tokio::test(flavor = "current_thread")]
    async fn mcp_reads_the_auth_store_off_the_runtime_thread() {
        let dir = std::env::temp_dir().join(format!("conn-http-fifo-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (addr, _auth) = serve_on_disk(&dir).await;
        let file = dir.join("auth.json");
        let _ = std::fs::remove_file(&file);
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&file)
                .status()
                .unwrap()
                .success(),
            "mkfifo"
        );
        // After 800 ms, feed every reader the FIFO gets (each reread sees a new stamp).
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = std::thread::spawn({
            let done = done.clone();
            move || {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                std::thread::sleep(Duration::from_millis(800));
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Ok(mut fifo) = std::fs::OpenOptions::new()
                        .write(true)
                        .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
                        .open(&file)
                    {
                        let _ = fifo.write_all(br#"{"version":1,"sessions":[],"pairingLinks":[]}"#);
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        });
        let slept = sleep_while(
            addr,
            "POST /mcp HTTP/1.1\r\nauthorization: Bearer unknown\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream",
            "{}",
        )
        .await;
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        writer.join().unwrap();
        assert!(
            slept < Duration::from_millis(400),
            "the runtime thread was blocked for {slept:?}"
        );
    }

    /// `logout` takes an MCP-audience bearer too: it ends that session, and `/mcp` then
    /// refuses the token.
    #[tokio::test(flavor = "current_thread")]
    async fn logout_ends_an_mcp_session() {
        let dir =
            std::env::temp_dir().join(format!("conn-http-mcp-logout-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let (addr, auth) = serve_on_disk(&dir).await;
        let issued = auth
            .issue_mcp_client_session(
                "Agent",
                "auto",
                false,
                ClientInfo::default(),
                auth::MAX_TTL_MS,
            )
            .unwrap();
        let bearer = format!("authorization: Bearer {}", issued.token);
        let init = format!(
            "POST /mcp HTTP/1.1\r\n{bearer}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream"
        );
        let body = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;
        assert_eq!(call(addr, &init, body).await.0, 200);
        let (status, reply) = call(
            addr,
            &format!("POST /api/auth/logout HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        assert_eq!(status, 200, "{reply}");
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap(),
            json!({"sessionId": issued.principal.session_id, "revoked": true})
        );
        assert_eq!(call(addr, &init, body).await.0, 401);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One HTTP/1.1 request; returns the status and the body.
    async fn call(addr: std::net::SocketAddr, head: &str, body: &str) -> (u16, String) {
        let (status, _, body) = call_full(addr, head, body).await;
        (status, body)
    }

    /// One HTTP/1.1 request; returns the status, the lowercased response head and the body.
    async fn call_full(
        addr: std::net::SocketAddr,
        head: &str,
        body: &str,
    ) -> (u16, String, String) {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "{head}\r\nhost: {addr}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            bytes.extend_from_slice(&buf[..n]);
            // An upgraded socket stays open; its headers are all there is to read.
            let upgraded =
                bytes.starts_with(b"HTTP/1.1 101") && bytes.windows(4).any(|w| w == b"\r\n\r\n");
            if n == 0 || upgraded {
                break;
            }
        }
        let response = String::from_utf8(bytes).unwrap();
        let status = response[9..12].parse().unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
        (status, head.to_ascii_lowercase(), body.to_owned())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mcp_accepts_maximum_escaped_inline_html_but_bounds_the_body() {
        let tool: Value = include_str!("../../conn-mcp/src/catalog.jsonl")
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|tool| tool["name"] == "html_render")
            .unwrap();
        let max = tool["inputSchema"]["properties"]["html"]["maxLength"]
            .as_u64()
            .unwrap() as usize;
        let title_max = tool["inputSchema"]["properties"]["title"]["maxLength"]
            .as_u64()
            .unwrap() as usize;
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"html_render","arguments":{{"html":"{}","title":"{}","height":100}}}}}}"#,
            "\\u0061".repeat(max),
            "\\u0061".repeat(title_max)
        );
        let (addr, _) = serve().await;
        assert_eq!(
            call(addr, "POST /mcp HTTP/1.1", &body).await.0,
            404,
            "valid HTML must reach the handler"
        );
        let over_limit = " ".repeat(body.len() + 64 * 1024);
        assert_eq!(call(addr, "POST /mcp HTTP/1.1", &over_limit).await.0, 413);
    }

    const UPGRADE: &str = "connection: upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==";

    #[tokio::test(flavor = "current_thread")]
    async fn preview_stream_requires_read_scope_and_a_media_ticket() {
        let (addr, auth) = serve().await;
        let url = "/api/preview-stream/ws?threadId=thread&tabId=missing";
        let request = |credential: &str| format!("GET {url} HTTP/1.1\r\n{UPGRADE}\r\n{credential}");
        assert_eq!(call(addr, &request(""), "").await.0, 401);
        let session = |scopes: Vec<String>| {
            auth.issue_session(auth::SessionRequest {
                scopes,
                label: None,
                subject: None,
                ttl_ms: auth::SESSION_TTL_MS,
            })
            .unwrap()
            .token
        };
        let terminal = session(vec!["terminal:operate".into()]);
        assert_eq!(
            call(
                addr,
                &request(&format!("authorization: Bearer {terminal}")),
                ""
            )
            .await
            .0,
            403
        );
        let read = session(vec!["orchestration:read".into()]);
        assert_eq!(
            call(addr, &request(&format!("authorization: Bearer {read}")), "")
                .await
                .0,
            404
        );
        let blank_ticket = format!(
            "GET {url}&wsTicket=%20%20 HTTP/1.1\r\n{UPGRADE}\r\nauthorization: Bearer {read}"
        );
        assert_eq!(call(addr, &blank_ticket, "").await.0, 404);
        let ticket = auth.issue_ticket(&read, Some("rpc")).unwrap().0;
        let head = format!("GET {url}&wsTicket={ticket} HTTP/1.1\r\n{UPGRADE}");
        assert_eq!(call(addr, &head, "").await.0, 401);
        let ticket = auth.issue_ticket(&read, Some("media")).unwrap().0;
        let head = format!("GET {url}&wsTicket={ticket} HTTP/1.1\r\n{UPGRADE}");
        assert_eq!(call(addr, &head, "").await.0, 404);
        assert_eq!(
            call(addr, &head, "").await.0,
            404,
            "media tickets remain usable for reconnects"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pairs_and_authenticates_the_socket() {
        let (addr, auth) = serve().await;
        let (status, body) = call(addr, "GET /.well-known/t3/environment HTTP/1.1", "").await;
        assert_eq!(status, 200);
        let descriptor: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(descriptor["orchestrationProtocolVersion"], 2);

        let (_, body) = call(addr, "GET /api/auth/session HTTP/1.1", "").await;
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["authenticated"],
            false
        );

        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let form = format!(
            "grant_type={}&subject_token={code}&subject_token_type={}&requested_token_type={}",
            "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
            "urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap",
            "urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
        );
        let head = "POST /oauth/token HTTP/1.1\r\ncontent-type: application/x-www-form-urlencoded";
        let (status, body) = call(addr, head, &form).await;
        assert_eq!(status, 200, "{body}");
        let token: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(token["token_type"], "Bearer");
        let access = token["access_token"].as_str().unwrap();
        // The code is spent.
        let (status, body) = call(addr, head, &form).await;
        assert_eq!(status, 401);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "invalid_credential"
        );

        let bearer = format!("authorization: Bearer {access}");
        let (_, body) = call(
            addr,
            &format!("GET /api/auth/session HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        let session: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(session["authenticated"], true);
        assert_eq!(session["sessionMethod"], "bearer-access-token");

        let (status, body) = call(
            addr,
            &format!("POST /api/auth/websocket-ticket/rpc HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let ticket: Value = serde_json::from_str(&body).unwrap();
        let ticket = ticket["ticket"].as_str().unwrap();

        let ws = |query: String| format!("GET /ws?{query} HTTP/1.1\r\n{UPGRADE}");
        let (status, _) = call(
            addr,
            &ws(format!("orchestrationProtocol=2&wsTicket={ticket}")),
            "",
        )
        .await;
        assert_eq!(status, 101);
        let (status, body) = call(
            addr,
            &ws("orchestrationProtocol=2&wsTicket=forged".into()),
            "",
        )
        .await;
        assert_eq!(
            (
                status,
                serde_json::from_str::<Value>(&body).unwrap()["reason"].clone()
            ),
            (401, json!("invalid_credential"))
        );
        let (status, body) = call(addr, &ws("orchestrationProtocol=2".into()), "").await;
        assert_eq!(
            (
                status,
                serde_json::from_str::<Value>(&body).unwrap()["reason"].clone()
            ),
            (401, json!("missing_credential"))
        );
        // The bearer token is not accepted as a ticket.
        let (status, _) = call(
            addr,
            &ws(format!("orchestrationProtocol=2&wsTicket={access}")),
            "",
        )
        .await;
        assert_eq!(status, 401);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn orchestration_snapshots_need_the_protocol_header_and_a_bearer() {
        let dir = std::env::temp_dir().join(format!("conn-server-http-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        config.projects = vec![conn_engine::ProjectConfig {
            title: "P".into(),
            workspace_root: "/tmp/p".into(),
        }];
        let engine: Arc<dyn Engine> = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let (addr, auth) = serve_with(Some(engine)).await;
        let access = auth
            .exchange(
                &auth
                    .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap()
            .token;
        let bearer = format!("authorization: Bearer {access}");
        let header = "x-t3-orchestration-protocol: 2";
        let get = |path: &str, headers: &[&str]| {
            let head = [format!("GET {path} HTTP/1.1")]
                .into_iter()
                .chain(headers.iter().map(|h| (*h).to_owned()))
                .collect::<Vec<_>>()
                .join("\r\n");
            async move { call(addr, &head, "").await }
        };

        let shell = "/api/orchestration/shell";
        assert_eq!(get(shell, &[&bearer]).await.0, 400);
        assert_eq!(get(shell, &[header]).await.0, 401);
        assert_eq!(
            get(shell, &[header, "authorization: Bearer forged"])
                .await
                .0,
            401
        );
        let (status, body) = get(shell, &[header, &bearer]).await;
        assert_eq!(status, 200, "{body}");
        let snapshot: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(snapshot["projects"][0]["title"], "P");
        // `answerShellSnapshot`: a current cursor gets the small confirmation; a cursor past
        // the head or one that is not a safe integer gets the snapshot again.
        let sequence = snapshot["snapshotSequence"].as_u64().unwrap();
        let (status, body) = get(
            &format!("{shell}?resumeFrom={sequence}"),
            &[header, &bearer],
        )
        .await;
        assert_eq!((status, body.as_str()), (200, r#"{"resumable":true}"#));
        for cursor in [
            format!("{}", sequence + 1),
            "-1".into(),
            "abc".into(),
            "9007199254740992".into(),
        ] {
            let (status, body) =
                get(&format!("{shell}?resumeFrom={cursor}"), &[header, &bearer]).await;
            assert_eq!(status, 200, "{body}");
            let replaced: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(replaced["snapshotSequence"], sequence, "{cursor}");
        }
        // The opt-in gives the trimmed snapshot a fresh `subscribeShell` sends.
        let (_, body) = get(&format!("{shell}?omitOlderSettled=1"), &[header, &bearer]).await;
        let trimmed: Value = serde_json::from_str(&body).unwrap();
        assert!(trimmed["olderSettled"].is_object(), "{trimmed}");
        // An unknown thread is a plain 404, never the structured not-found error.
        let (status, body) = get("/api/orchestration/threads/nope", &[header, &bearer]).await;
        assert_eq!((status, body.as_str()), (404, ""));
        // The transcript route answers T3's structured not-found error, and needs the same
        // header and bearer.
        let transcript = "/api/orchestration/threads/nope/transcript";
        assert_eq!(get(transcript, &[&bearer]).await.0, 400);
        assert_eq!(get(transcript, &[header]).await.0, 401);
        let (status, body) = get(transcript, &[header, &bearer]).await;
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            (status, &body["_tag"], &body["reason"]),
            (
                404,
                &json!("EnvironmentResourceNotFoundError"),
                &json!("thread_not_found")
            )
        );

        // `project add` on a running server: an operate-scoped bearer adds the project now.
        let root = dir.to_string_lossy().into_owned();
        let add = json!({"type": "project.create", "commandId": "add-1",
            "projectId": conn_engine::SqliteEngine::project_id_for(&root),
            "title": "Added", "workspaceRoot": root})
        .to_string();
        let post = |auth_header: String| {
            let head = format!(
                "POST /api/projects/mutate HTTP/1.1\r\ncontent-type: application/json\r\n{auth_header}"
            );
            let add = add.clone();
            async move { call(addr, &head, &add).await }
        };
        assert_eq!(post("x-none: 1".into()).await.0, 401);
        let (status, body) = post(bearer.clone()).await;
        assert_eq!(status, 200, "{body}");
        let (_, body) = get(shell, &[header, &bearer]).await;
        let snapshot: Value = serde_json::from_str(&body).unwrap();
        let titles: Vec<&str> = snapshot["projects"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["title"].as_str())
            .collect();
        assert!(titles.contains(&"Added"), "{titles:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A server with on-disk settings and the engine, for the provider instance routes.
    async fn serve_settings(
        dir: &std::path::Path,
        instances: Option<Arc<crate::instances::Instances>>,
    ) -> (std::net::SocketAddr, Arc<AuthStore>, crate::methods::Deps) {
        let environment = Arc::new(
            crate::environment::Environment::load(dir, None, dir.to_owned(), Default::default())
                .unwrap(),
        );
        let engine: Arc<dyn Engine> = Arc::new(
            conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
                dir.join("engine.sqlite"),
            ))
            .unwrap(),
        );
        let deps = crate::methods::Deps {
            environment: Some(environment),
            engine: Some(engine.clone()),
            instances,
            ..Default::default()
        };
        let (addr, auth) = serve_with_deps(Some(engine), deps.clone()).await;
        (addr, auth, deps)
    }

    fn token(auth: &AuthStore, scopes: &[&str]) -> String {
        auth.issue_session(auth::SessionRequest {
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            label: None,
            subject: None,
            ttl_ms: auth::SESSION_TTL_MS,
        })
        .unwrap()
        .token
    }

    const INSTANCES: &str = "/api/settings/provider-instances";

    async fn instances_get(addr: std::net::SocketAddr, token: &str) -> (u16, Value) {
        let (status, body) = call(
            addr,
            &format!("GET {INSTANCES} HTTP/1.1\r\nauthorization: Bearer {token}"),
            "",
        )
        .await;
        (status, serde_json::from_str(&body).unwrap())
    }

    async fn instances_post(
        addr: std::net::SocketAddr,
        token: &str,
        mutations: Value,
    ) -> (u16, Value) {
        let (status, body) = instances_post_raw(
            addr,
            &format!("authorization: Bearer {token}"),
            &json!({ "mutations": mutations }).to_string(),
        )
        .await;
        (status, serde_json::from_str(&body).unwrap())
    }

    async fn instances_post_raw(
        addr: std::net::SocketAddr,
        header: &str,
        body: &str,
    ) -> (u16, String) {
        call(
            addr,
            &format!("POST {INSTANCES} HTTP/1.1\r\ncontent-type: application/json\r\n{header}"),
            body,
        )
        .await
    }

    /// A POST with a 3 MiB body. The server may answer and close before the body is sent,
    /// so a failed write is expected; the status comes from what the server sent.
    async fn oversized_post(addr: std::net::SocketAddr, header: &str) -> u16 {
        let body = format!(r#"{{"mutations":[],"pad":"{}"}}"#, "x".repeat(3 << 20));
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let head = format!(
            "POST {INSTANCES} HTTP/1.1\r\nhost: {addr}\r\ncontent-type: application/json\r\n\
             {header}\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        let _ = stream.write_all(body.as_bytes()).await;
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes)
            .get(9..12)
            .and_then(|status| status.parse().ok())
            .unwrap_or(0)
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "conn-server-instances-{name}-{}",
            auth::random_hex(6)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn revision(deps: &crate::methods::Deps) -> u64 {
        *deps
            .environment
            .as_ref()
            .unwrap()
            .settings
            .subscribe()
            .borrow()
    }

    fn raw_instance(deps: &crate::methods::Deps, id: &str) -> Value {
        deps.environment.as_ref().unwrap().settings.raw()["providerInstances"][id].clone()
    }

    /// The file as it is: its bytes and its inode, which a save (a rename) replaces.
    fn file_state(path: &std::path::Path) -> (Vec<u8>, u64) {
        use std::os::unix::fs::MetadataExt;
        (
            std::fs::read(path).unwrap(),
            std::fs::metadata(path).unwrap().ino(),
        )
    }

    /// Every value in the secret store.
    fn stored_secrets(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir.join("secrets"))
            .map(|entries| {
                entries
                    .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn agy(api_key: Value, environment: Value) -> Value {
        json!({"driver": "antigravity", "enabled": true,
               "config": {"authMethod": "gemini-api-key", "apiKey": api_key},
               "environment": environment})
    }

    /// The contract's bodies: `{reason, index, message}` and nothing else.
    fn assert_invalid(status: u16, body: &Value, index: usize) {
        assert_eq!(status, 400, "{body}");
        let keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["index", "message", "reason"], "{body}");
        assert_eq!(body["reason"], "invalid_mutation");
        assert_eq!(body["index"], index, "{body}");
        assert!(body["message"].is_string());
    }

    /// Both routes take a Bearer session with `providers:manage`, with the bodies the other
    /// routes answer, before the body is read: an oversized body still gets 401 or 403.
    #[tokio::test(flavor = "current_thread")]
    async fn provider_instance_routes_need_a_session_with_providers_manage() {
        let dir = temp("auth");
        let (addr, auth, _) = serve_settings(&dir, None).await;
        let other = token(&auth, &["orchestration:read", "settings:write"]);
        for method in ["GET", "POST"] {
            let request = |header: String| {
                let head = format!(
                    "{method} {INSTANCES} HTTP/1.1\r\ncontent-type: application/json\r\n{header}"
                );
                async move {
                    let (status, body) = call(addr, &head, r#"{"mutations":[]}"#).await;
                    (status, serde_json::from_str::<Value>(&body).unwrap())
                }
            };
            let (status, body) = request("x-none: 1".into()).await;
            assert_eq!(
                (status, &body["reason"]),
                (401, &json!("missing_credential"))
            );
            let (status, body) = request("authorization: Bearer forged".into()).await;
            assert_eq!(
                (status, &body["reason"]),
                (401, &json!("invalid_credential"))
            );
            let (status, body) = request(format!("authorization: Bearer {other}")).await;
            assert_eq!(status, 403, "{method}");
            assert_eq!(body["_tag"], "EnvironmentScopeRequiredError");
            assert_eq!(body["reason"], "scope_required");
            assert_eq!(body["requiredPermission"], "providers:manage");
        }
        assert_eq!(oversized_post(addr, "x-none: 1").await, 401);
        let header = format!("authorization: Bearer {other}");
        assert_eq!(oversized_post(addr, &header).await, 403);
        assert!(!dir.join("settings.json").exists(), "a refused POST saved");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// GET serves the client view: a saved secret field and a sensitive variable show only
    /// the markers, and a secret field of a shape no client sends (a number, a list) shows
    /// the marker too, never its value.
    #[tokio::test(flavor = "current_thread")]
    async fn provider_instances_are_read_without_their_secrets() {
        let dir = temp("get");
        std::fs::write(
            dir.join("settings.json"),
            json!({"providerInstances": {
                "agyRouted": {"driver": "antigravity", "enabled": true,
                    "config": {"authMethod": "gemini-api-key", "apiKey": "inline-key-1f2e"},
                    "environment": [
                        {"name": "GOOGLE_GEMINI_BASE_URL", "value": "http://router:8317"},
                        {"name": "ROUTER_TOKEN", "value": "inline-token-9a8b", "sensitive": true}]},
                "agyNumber": {"driver": "antigravity", "config": {"apiKey": 424_242}},
                "openList": {"driver": "opencode", "config": {"serverPassword": ["list-secret-7c"]}},
                "agyPadded": {"driver": " antigravity ", "config": {"apiKey": "padded-key-1"}},
                "openPadded": {"driver": " opencode ", "config": {"serverPassword": "padded-pass-2"}}}})
            .to_string(),
        )
        .unwrap();
        let (addr, auth, _) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let (status, body) = instances_get(addr, &admin).await;
        assert_eq!(status, 200, "{body}");
        let text = body.to_string();
        for secret in [
            "inline-key-1f2e",
            "inline-token-9a8b",
            "424242",
            "list-secret-7c",
            "padded-key-1",
            "padded-pass-2",
        ] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        let instances = &body["providerInstances"];
        let instance = &instances["agyRouted"];
        assert_eq!(instance["config"]["apiKey"], "••••••");
        assert_eq!(instance["environment"][0]["value"], "http://router:8317");
        assert_eq!(instance["environment"][1]["value"], "");
        assert_eq!(instance["environment"][1]["valueRedacted"], true);
        assert_eq!(instances["agyNumber"]["config"]["apiKey"], "••••••");
        assert_eq!(instances["openList"]["config"]["serverPassword"], "••••••");
        assert_eq!(instances["agyPadded"]["config"]["apiKey"], "••••••");
        assert_eq!(
            instances["openPadded"]["config"]["serverPassword"],
            "••••••"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The mutations apply in order and save once; a failure at any index saves nothing and
    /// names the first failing index, whichever check fails. A remove with an instance is
    /// refused, not applied.
    #[tokio::test(flavor = "current_thread")]
    async fn provider_instance_mutations_apply_together_or_not_at_all() {
        let dir = temp("atomic");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let codex = |name: &str| json!({"driver": "codex", "displayName": name});
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([
                {"operation": "create", "instanceId": "a", "instance": codex("A")},
                {"operation": "upsert", "instanceId": "b", "instance": codex("B")},
                {"operation": "upsert", "instanceId": "a", "instance": codex("A2")},
                {"operation": "remove", "instanceId": "b"},
            ]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["providerInstances"], json!({"a": codex("A2")}));
        assert_eq!(instances_get(addr, &admin).await.1, body);
        let saved = std::fs::read(dir.join("settings.json")).unwrap();
        let before = revision(&deps);

        let refused = [
            (
                json!([{"operation": "upsert", "instanceId": "c", "instance": codex("C")},
                    {"operation": "rename", "instanceId": "a"}]),
                1,
            ),
            (json!([{"operation": "upsert", "instance": codex("C")}]), 0),
            (
                json!([{"operation": "upsert", "instanceId": "c", "instance": codex("C")},
                    {"operation": "remove", "instanceId": "a"},
                    {"operation": "create", "instanceId": "d"}]),
                2,
            ),
            (
                json!([{"operation": "remove", "instanceId": "a"},
                    {"operation": "upsert", "instanceId": "c", "instance": {"driver": 7}}]),
                1,
            ),
            // `create` refuses an id the settings hold.
            (
                json!([{"operation": "upsert", "instanceId": "c", "instance": codex("C")},
                    {"operation": "create", "instanceId": "a", "instance": codex("A3")}]),
                1,
            ),
            // The first failure wins over a later shape error.
            (
                json!([{"operation": "create", "instanceId": "a", "instance": codex("A3")},
                    {"operation": "rename", "instanceId": "a"}]),
                0,
            ),
            // A remove carries no instance.
            (
                json!([{"operation": "remove", "instanceId": "a", "instance": codex("A")}]),
                0,
            ),
            (
                Value::Array(
                    (0..33)
                        .map(|i| {
                            json!({"operation": "upsert", "instanceId": format!("x{i}"),
                                    "instance": codex("X")})
                        })
                        .collect(),
                ),
                32,
            ),
        ];
        for (mutations, index) in refused {
            let (status, body) = instances_post(addr, &admin, mutations).await;
            assert_invalid(status, &body, index);
        }
        assert_eq!(std::fs::read(dir.join("settings.json")).unwrap(), saved);
        assert_eq!(revision(&deps), before);
        assert_eq!(raw_instance(&deps, "a"), codex("A2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refusal names the field and the type, never the submitted value.
    #[tokio::test(flavor = "current_thread")]
    async fn refused_mutations_never_echo_their_values() {
        let dir = temp("echo");
        let (addr, auth, _) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let cases = [
            (agy(json!(13_579), json!([])), "13579"),
            (
                agy(
                    json!("k"),
                    json!([{"name": "TOKEN", "value": 987_654, "sensitive": true}]),
                ),
                "987654",
            ),
            (
                agy(
                    json!("k"),
                    json!([{"name": "TOKEN", "value": {"literal": "lit-s3cr3t"}, "sensitive": true}]),
                ),
                "lit-s3cr3t",
            ),
            (
                agy(
                    json!("k"),
                    json!([{"name": "TOKEN", "value": "",
                            "secret": {"literal": "ref-s3cr3t"}, "sensitive": true}]),
                ),
                "ref-s3cr3t",
            ),
        ];
        for (instance, secret) in cases {
            let (status, body) = instances_post(
                addr,
                &admin,
                json!([{"operation": "upsert", "instanceId": "agy", "instance": instance}]),
            )
            .await;
            assert_invalid(status, &body, 0);
            assert!(!body.to_string().contains(secret), "{body}");
        }
        assert!(!dir.join("settings.json").exists());
        assert!(stored_secrets(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ids, drivers and variable names follow the contract's rules and are stored trimmed, so
    /// the registry and the secret fields find them.
    #[tokio::test(flavor = "current_thread")]
    async fn provider_instance_names_are_checked_and_stored_trimmed() {
        let dir = temp("names");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        for (id, driver, name) in [
            ("agy Routed", "antigravity", "TOKEN"),
            ("agyRouted", "anti gravity", "TOKEN"),
            ("agyRouted", "antigravity", "BAD-NAME"),
        ] {
            let mut instance = agy(json!("k"), json!([{"name": name, "value": "v"}]));
            instance["driver"] = json!(driver);
            let (status, body) = instances_post(
                addr,
                &admin,
                json!([{"operation": "upsert", "instanceId": id, "instance": instance}]),
            )
            .await;
            assert_invalid(status, &body, 0);
        }
        let mut instance = agy(
            json!("trim-key-4d5e"),
            json!([{"name": " GOOGLE_GEMINI_BASE_URL ", "value": "http://router:8317"}]),
        );
        instance["driver"] = json!(" antigravity ");
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": " agyRouted ", "instance": instance}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let saved = &body["providerInstances"]["agyRouted"];
        assert_eq!(saved["driver"], "antigravity");
        assert_eq!(saved["environment"][0]["name"], "GOOGLE_GEMINI_BASE_URL");
        assert_eq!(saved["config"]["apiKey"], "••••••");
        let file = std::fs::read_to_string(dir.join("settings.json")).unwrap();
        assert!(!file.contains("trim-key-4d5e") && !file.contains(" agyRouted "));
        assert_eq!(
            raw_instance(&deps, "agyRouted")["config"]["apiKey"],
            "trim-key-4d5e"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A marker in a batch means the value the batch staged before it: a rotation and then an
    /// echo keeps the new key, and a removal and then a re-creation with markers brings back
    /// no removed credential. Config fields and sensitive variables alike.
    #[tokio::test(flavor = "current_thread")]
    async fn batch_secret_markers_follow_the_staged_mutations() {
        let dir = temp("order");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let env = |value: &str| json!([{"name": "TOKEN", "value": value, "sensitive": true}]);
        let echoed =
            json!([{"name": "TOKEN", "value": "", "sensitive": true, "valueRedacted": true}]);
        let upsert = |instance: Value| json!({"operation": "upsert", "instanceId": "agy", "instance": instance});
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([upsert(agy(json!("old-key-1"), env("old-tok-1")))]),
        )
        .await;
        assert_eq!(status, 200, "{body}");

        let (status, body) = instances_post(
            addr,
            &admin,
            json!([
                upsert(agy(json!("new-key-2"), env("new-tok-2"))),
                upsert(agy(json!("••••••"), echoed.clone()))
            ]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let saved = raw_instance(&deps, "agy");
        assert_eq!(saved["config"]["apiKey"], "new-key-2");
        assert_eq!(saved["environment"][0]["value"], "new-tok-2");

        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "remove", "instanceId": "agy"},
                   {"operation": "create", "instanceId": "agy",
                    "instance": agy(json!("••••••"), echoed)}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let saved = raw_instance(&deps, "agy");
        assert_eq!(saved["config"]["apiKey"], "");
        assert_eq!(saved["environment"][0]["value"], "");
        let stored = stored_secrets(&dir);
        assert!(
            !stored
                .iter()
                .any(|v| v.contains("key-") || v.contains("tok-")),
            "{} left",
            stored.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A refused batch writes nothing: an inline secret an outside edit left in the file
    /// stays where it is until a batch succeeds.
    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_batch_leaves_the_file_and_the_store_alone() {
        let dir = temp("refused");
        let (addr, auth, _) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            json!({"providerInstances": {"a": agy(json!("ext-inline-1"), json!([]))}}).to_string(),
        )
        .unwrap();
        let before = file_state(&path);
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "create", "instanceId": "a", "instance": agy(json!("k"), json!([]))}]),
        )
        .await;
        assert_invalid(status, &body, 0);
        assert_eq!(file_state(&path), before);
        assert!(stored_secrets(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An upsert of what an edit on disk already holds writes nothing, but publishes the
    /// settings the server had not loaded, so the registry reconciles them.
    #[tokio::test(flavor = "current_thread")]
    async fn an_upsert_matching_a_disk_edit_still_publishes_it() {
        let dir = temp("disk");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let path = dir.join("settings.json");
        let instance = json!({"driver": "codex", "displayName": "B"});
        std::fs::write(
            &path,
            json!({"providerInstances": {"b": instance}}).to_string(),
        )
        .unwrap();
        let before = (file_state(&path), revision(&deps));
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "b", "instance": instance}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["providerInstances"]["b"], instance);
        assert_eq!(file_state(&path), before.0);
        assert!(revision(&deps) > before.1);
        assert_eq!(raw_instance(&deps, "b"), instance);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An upsert of what is saved, secrets inline or echoed as markers, writes nothing,
    /// publishes no revision and answers the same body; the comparison is per final slot, so a
    /// public and a sensitive variable of one name do not count as a change. Secrets move to
    /// the store and the response shows them redacted.
    #[tokio::test(flavor = "current_thread")]
    async fn provider_instance_upserts_move_secrets_and_are_idempotent() {
        let dir = temp("secrets");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let instance = agy(
            json!("router-key-5c6d"),
            json!([
                {"name": "GOOGLE_GEMINI_BASE_URL", "value": "http://router:8317", "sensitive": false},
                {"name": "ROUTER_TOKEN", "value": "public-first", "sensitive": false},
                {"name": "ROUTER_TOKEN", "value": "router-token-7e8f", "sensitive": true}]),
        );
        let upsert =
            json!([{"operation": "upsert", "instanceId": "agyRouted", "instance": instance}]);
        let (status, first) = instances_post(addr, &admin, upsert.clone()).await;
        assert_eq!(status, 200, "{first}");
        let text = first.to_string();
        assert!(!text.contains("router-key-5c6d") && !text.contains("router-token-7e8f"));
        assert_eq!(
            first["providerInstances"]["agyRouted"]["config"]["apiKey"],
            "••••••"
        );
        let path = dir.join("settings.json");
        let file = std::fs::read_to_string(&path).unwrap();
        assert!(!file.contains("router-key-5c6d") && !file.contains("router-token-7e8f"));
        let stored = stored_secrets(&dir);
        assert!(stored.iter().any(|v| v == "router-key-5c6d"));
        assert!(stored.iter().any(|v| v == "router-token-7e8f"));
        assert_eq!(
            raw_instance(&deps, "agyRouted")["config"]["apiKey"],
            "router-key-5c6d"
        );

        let before = (file_state(&path), revision(&deps));
        let echoed = json!([{"operation": "upsert", "instanceId": "agyRouted",
            "instance": first["providerInstances"]["agyRouted"]}]);
        for again in [upsert, echoed] {
            let (status, body) = instances_post(addr, &admin, again).await;
            assert_eq!((status, &body), (200, &first));
            assert_eq!(revision(&deps), before.1);
            assert_eq!(file_state(&path), before.0);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// GET of an instance whose secret field holds a number, a list or a boolean shows the
    /// marker; echoing that instance back keeps the original value and changes nothing.
    #[tokio::test(flavor = "current_thread")]
    async fn an_echoed_marker_keeps_a_value_the_store_never_held() {
        let dir = temp("unstored");
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            json!({"providerInstances": {
                "agyList": {"driver": "antigravity", "config": {"apiKey": [1, 2]}},
                "agyNumber": {"driver": "antigravity", "config": {"apiKey": 7}},
                "agyBool": {"driver": "antigravity", "config": {"apiKey": true}}}})
            .to_string(),
        )
        .unwrap();
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let (_, view) = instances_get(addr, &admin).await;
        let before = (file_state(&path), revision(&deps));
        let echo: Vec<Value> = ["agyList", "agyNumber", "agyBool"]
            .iter()
            .map(|id| {
                json!({"operation": "upsert", "instanceId": id,
                       "instance": view["providerInstances"][id]})
            })
            .collect();
        let (status, body) = instances_post(addr, &admin, Value::Array(echo)).await;
        assert_eq!((status, &body), (200, &view));
        assert_eq!(file_state(&path), before.0);
        assert_eq!(revision(&deps), before.1);
        assert_eq!(
            raw_instance(&deps, "agyList")["config"]["apiKey"],
            json!([1, 2])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Numbers compare as the file stores them (`1.0` is `1`), nested ones too: repeating an
    /// upsert with them publishes no revision.
    #[tokio::test(flavor = "current_thread")]
    async fn repeated_upserts_with_whole_floats_publish_nothing() {
        let dir = temp("numbers");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let upsert = json!([{"operation": "upsert", "instanceId": "c", "instance":
            {"driver": "codex", "config": {"ratio": 1.0, "nested": [{"depth": 2.0}]}}}]);
        let (status, first) = instances_post(addr, &admin, upsert.clone()).await;
        assert_eq!(status, 200, "{first}");
        let path = dir.join("settings.json");
        let before = (file_state(&path), revision(&deps));
        let (status, again) = instances_post(addr, &admin, upsert).await;
        assert_eq!((status, &again), (200, &first));
        assert_eq!(revision(&deps), before.1);
        assert_eq!(file_state(&path), before.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A driver decodes its own config: any JSON passes, as `server.updateSettings` takes it.
    #[tokio::test(flavor = "current_thread")]
    async fn an_opaque_config_is_accepted() {
        let dir = temp("opaque");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let configs = [json!([1, 2]), json!("text"), json!(5), json!(true)];
        for (position, config) in configs.iter().enumerate() {
            let id = format!("ext{position}");
            let (status, body) = instances_post(
                addr,
                &admin,
                json!([{"operation": "upsert", "instanceId": id,
                        "instance": {"driver": "extDriver", "config": config}}]),
            )
            .await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(raw_instance(&deps, &id)["config"], *config);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A secret reference follows `SecretReference`: a provider slug and a one-line path of
    /// at most 1024 characters, both non-empty. Anything else is refused and nothing is saved.
    #[tokio::test(flavor = "current_thread")]
    async fn invalid_secret_references_are_refused() {
        let dir = temp("references");
        let (addr, auth, _) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let bad = [
            json!({"provider": "", "reference": ""}),
            json!({"provider": "op", "reference": "  "}),
            json!({"provider": "one password", "reference": "vault/item"}),
            json!({"provider": "op", "reference": "vault\nitem"}),
            json!({"provider": "op", "reference": "r".repeat(1025)}),
        ];
        for reference in bad {
            for instance in [
                agy(reference.clone(), json!([])),
                agy(
                    json!("k"),
                    json!([{"name": "TOKEN", "value": reference, "sensitive": true}]),
                ),
                agy(
                    json!("k"),
                    json!([{"name": "TOKEN", "value": "", "secret": reference, "sensitive": true}]),
                ),
            ] {
                let (status, body) = instances_post(
                    addr,
                    &admin,
                    json!([{"operation": "upsert", "instanceId": "agy", "instance": instance}]),
                )
                .await;
                assert_invalid(status, &body, 0);
            }
        }
        assert!(!dir.join("settings.json").exists());
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "agy", "instance":
                agy(json!({"provider": "op", "reference": "vault/item"}), json!([]))}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A successful batch runs the migrations every save runs: a legacy GitHub token an
    /// outside edit left inline becomes a source control host, its token in the store.
    #[tokio::test(flavor = "current_thread")]
    async fn a_successful_batch_runs_the_settings_migrations() {
        let dir = temp("migrate");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            json!({"github": {"tokens": {"github.com": "gh-inline-1"}}}).to_string(),
        )
        .unwrap();
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "c",
                    "instance": {"driver": "codex"}}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let file = std::fs::read_to_string(&path).unwrap();
        assert!(!file.contains("gh-inline-1"), "the token stayed inline");
        assert!(stored_secrets(&dir).iter().any(|v| v == "gh-inline-1"));
        let raw = deps.environment.as_ref().unwrap().settings.raw();
        assert_eq!(
            raw["sourceControlHosts"]["github"]["tokens"]["github.com"],
            "gh-inline-1"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// After a failed load is repaired, the batch's load is the reload: a later refresh finds
    /// nothing to reload and publishes no second revision.
    #[tokio::test(flavor = "current_thread")]
    async fn a_batch_after_a_failed_load_publishes_once() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("retry");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let settings = &deps.environment.as_ref().unwrap().settings;
        assert!(settings.needs_reload());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let admin = token(&auth, &["providers:manage"]);
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "c",
                    "instance": {"driver": "codex"}}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let after = revision(&deps);
        assert!(!settings.needs_reload());
        settings.reload_if_failed();
        assert_eq!(revision(&deps), after);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A body takes the same limit as a `/ws` message: one valid mutation with a config over
    /// 1 MiB is saved.
    #[tokio::test(flavor = "current_thread")]
    async fn a_large_valid_mutation_is_accepted() {
        let dir = temp("large");
        let (addr, auth, deps) = serve_settings(&dir, None).await;
        let admin = token(&auth, &["providers:manage"]);
        let blob = "x".repeat(3 << 19);
        let (status, _) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "c",
                    "instance": {"driver": "codex", "config": {"blob": blob}}}]),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(raw_instance(&deps, "c")["config"]["blob"], blob);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Without the engine the POST answers ADR 0274's 503 body, before it reads the body, and
    /// saves nothing.
    #[tokio::test(flavor = "current_thread")]
    async fn provider_instance_mutations_need_the_engine() {
        let dir = temp("engine");
        let environment = Arc::new(
            crate::environment::Environment::load(&dir, None, dir.clone(), Default::default())
                .unwrap(),
        );
        let deps = crate::methods::Deps {
            environment: Some(environment),
            ..Default::default()
        };
        let (addr, auth) = serve_with_deps(None, deps).await;
        let admin = token(&auth, &["providers:manage"]);
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "a", "instance": {"driver": "codex"}}]),
        )
        .await;
        assert_eq!(
            (status, body),
            (503, json!({"reason": "engine_unavailable"}))
        );
        let (status, body) =
            instances_post_raw(addr, &format!("authorization: Bearer {admin}"), "not json").await;
        assert_eq!(status, 503);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"reason": "engine_unavailable"})
        );
        assert!(!dir.join("settings.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The live reconcile: an Antigravity instance that Orbit enables over POST, keyed and
    /// pointed at the router, is built and probed with no restart. The local `agy` fixture
    /// completes the ACP handshake (`initialize`, `session/new`), so the same running registry
    /// shows the instance ready and authenticated. The fixture records the router URL it was
    /// started with.
    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn a_posted_antigravity_instance_becomes_available_without_a_restart() {
        let dir = temp("reconcile");
        let agy_path = dir.join("bin").join("agy");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let seen = dir.join("base-url");
        conn_support::test_util::executable(
            &agy_path,
            &format!(
                r#"#!/bin/sh
printf '%s' "$GOOGLE_GEMINI_BASE_URL" > '{seen}'
if [ "$1" = --version ]; then echo 1.5.13; exit 0; fi
while IFS= read -r line; do
  id=${{line##*,\"id\":}}
  id=${{id%%[,\}}]*}}
  case "$line" in
    *'"method":"initialize"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"protocolVersion":1,"agentCapabilities":{{}}}}}}\n' "$id" ;;
    *'"method":"session/new"'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{"sessionId":"s-1"}}}}\n' "$id" ;;
    *'"method":'*) printf '{{"jsonrpc":"2.0","id":%s,"result":{{}}}}\n' "$id" ;;
  esac
done
"#,
                seen = seen.display()
            ),
        )
        .unwrap();
        let config = conn_provider_acp::AntigravityConfig {
            state_dir: dir.clone(),
            attachments_dir: None,
            self_command: None,
            model_manifest: Default::default(),
            status_notifier: Default::default(),
        };
        let registry = Arc::new(crate::instances::Instances::new(
            &[conn_provider_acp::ANTIGRAVITY.driver],
            Arc::new(move |id: &str, _: &str, entry: Option<&Value>| {
                Some(
                    Arc::new(conn_provider_acp::AntigravityProvider::for_instance(
                        id.into(),
                        config.clone(),
                        entry,
                    )) as Arc<dyn conn_provider::Provider>,
                )
            }),
        ));
        let (addr, auth, deps) = serve_settings(&dir, Some(registry.clone())).await;
        registry
            .reconcile(
                &deps.providers,
                &deps.environment.as_ref().unwrap().settings.raw(),
            )
            .await;
        crate::methods::provider::start_status_refresh(&deps);
        assert!(deps.providers.get("agyRouted").is_none());
        let mut statuses = deps.provider_status.subscribe();

        let admin = token(&auth, &["providers:manage"]);
        let mut instance = agy(
            json!("router-key-3b4c"),
            json!([{"name": "GOOGLE_GEMINI_BASE_URL",
                    "value": "http://router:8317", "sensitive": false}]),
        );
        instance["config"]["binaryPath"] = json!(agy_path.display().to_string());
        let (status, body) = instances_post(
            addr,
            &admin,
            json!([{"operation": "upsert", "instanceId": "agyRouted", "instance": instance}]),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let entry = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                if let Some(entry) = deps
                    .providers
                    .get("agyRouted")
                    .and_then(|p| p.server_provider_entry(""))
                    .filter(|entry| entry["status"] == "ready")
                {
                    return entry;
                }
                statuses.changed().await.unwrap();
            }
        })
        .await
        .expect("the instance did not become ready");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["installed"], true);
        assert_eq!(entry["driver"], "antigravity");
        assert_eq!(entry["auth"]["status"], "authenticated", "{entry}");
        assert_eq!(entry["auth"]["type"], "gemini-api-key");
        assert_eq!(
            std::fs::read_to_string(&seen).unwrap(),
            "http://router:8317"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `requiredScopesForProjectMutation` holds over HTTP as over `/ws`: scripts run on the
    /// host, so a session without `settings:write` may not store them.
    #[tokio::test(flavor = "current_thread")]
    async fn project_mutations_over_http_need_the_ws_scopes() {
        let dir =
            std::env::temp_dir().join(format!("conn-server-http-scopes-{}", auth::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let config = conn_engine::EngineConfig::new(dir.join("engine.sqlite"));
        let engine: Arc<dyn Engine> = Arc::new(conn_engine::SqliteEngine::open(config).unwrap());
        let (addr, auth) = serve_with(Some(engine)).await;
        let session = |scopes: &[&str]| {
            auth.issue_session(auth::SessionRequest {
                scopes: scopes.iter().map(|s| s.to_string()).collect(),
                label: None,
                subject: None,
                ttl_ms: auth::SESSION_TTL_MS,
            })
            .unwrap()
            .token
        };
        let operate = session(&["orchestration:read", "orchestration:operate"]);
        let admin = session(&[
            "orchestration:read",
            "orchestration:operate",
            "settings:write",
        ]);
        let root = dir.to_string_lossy().into_owned();
        let project_id = conn_engine::SqliteEngine::project_id_for(&root);
        let post = |token: &str, body: Value| {
            let head = format!(
                "POST /api/projects/mutate HTTP/1.1\r\ncontent-type: application/json\r\nauthorization: Bearer {token}"
            );
            async move { call(addr, &head, &body.to_string()).await }
        };
        let with_scripts = json!({"type": "project.create", "commandId": "c1",
            "projectId": project_id, "title": "P", "workspaceRoot": root,
            "scripts": [{"id": "s", "name": "s", "command": "touch /tmp/x", "icon": "play",
                         "runOnWorktreeCreate": true}]});
        let (status, body) = post(&operate, with_scripts.clone()).await;
        assert_eq!(status, 403, "{body}");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["_tag"], "EnvironmentScopeRequiredError");
        assert_eq!(body["requiredPermission"], "settings:write");
        assert_eq!(body["requiredScope"], "orchestration:operate");
        // Without scripts, operate is enough.
        let plain = json!({"type": "project.create", "commandId": "c2",
            "projectId": project_id, "title": "P", "workspaceRoot": root});
        let (status, body) = post(&operate, plain.clone()).await;
        assert_eq!(status, 200, "{body}");
        // A conflict is the caller's error, with no internal text.
        let mut again = plain;
        again["commandId"] = json!("c3");
        let (status, body) = post(&admin, again).await;
        assert_eq!(status, 400, "{body}");
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["reason"], "invalid_command");
        assert!(
            body.get("cause").is_none() && body.get("message").is_none(),
            "{body}"
        );
        // A read-only session gets the same body shape on the snapshot routes.
        let reader = session(&["access:read"]);
        let (status, body) = call(
            addr,
            &format!("GET /api/orchestration/shell HTTP/1.1\r\nx-t3-orchestration-protocol: 2\r\nauthorization: Bearer {reader}"),
            "",
        )
        .await;
        assert_eq!(status, 403);
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["requiredPermission"], "orchestration:read");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn access_routes_issue_scoped_links_list_and_revoke_clients() {
        let (addr, auth) = serve().await;
        let admin = auth
            .issue_session(auth::SessionRequest {
                scopes: vec![
                    "access:read".into(),
                    "access:write".into(),
                    "relay:read".into(),
                ],
                label: Some("Orbit Gateway".into()),
                subject: None,
                ttl_ms: auth::SESSION_TTL_MS,
            })
            .unwrap();
        let bearer = format!("authorization: Bearer {}", admin.token);
        let post = |path: &str, body: &str| {
            let head =
                format!("POST {path} HTTP/1.1\r\n{bearer}\r\ncontent-type: application/json");
            let body = body.to_owned();
            async move { call(addr, &head, &body).await }
        };

        let (status, body) = post(
            "/api/auth/pairing-token",
            r#"{"label":"node via Orbit","scopes":["relay:read","access:read"]}"#,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let link: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(link["label"], "node via Orbit");
        // A scope the caller lacks is refused with the exact permission.
        let (status, body) = post(
            "/api/auth/pairing-token",
            r#"{"scopes":["settings:write"]}"#,
        )
        .await;
        assert_eq!(status, 403);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["requiredPermission"],
            "settings:write"
        );
        let (status, _) = post(
            "/api/auth/pairing-token",
            r#"{"scopes":["access:read","access:read"]}"#,
        )
        .await;
        assert_eq!(status, 400);
        // `purpose: "peer-link"` needs its `access`; alone, or with any other purpose, it is
        // refused and no code is issued (`AuthCreatePairingCredentialInput`).
        let links_before = auth.pairing_links().len();
        for body in [
            r#"{"purpose":"peer-link"}"#,
            r#"{"purpose":"peer-link","scopes":["access:read"]}"#,
            r#"{"purpose":"startup"}"#,
        ] {
            let (status, reply) = post("/api/auth/pairing-token", body).await;
            assert_eq!(status, 400, "{body}: {reply}");
            assert!(!reply.contains(r#""credential""#), "{body}: {reply}");
        }
        assert_eq!(auth.pairing_links().len(), links_before);
        // `sessionTtl` takes only `until-revoked`, on plain and peer-link codes. Any other
        // explicit value, `null` and numbers too, is 400; only an omitted field keeps the default.
        for body in [
            r#"{"sessionTtl":"30d"}"#,
            r#"{"sessionTtl":null}"#,
            r#"{"sessionTtl":3600}"#,
            r#"{"sessionTtl":0}"#,
            r#"{"access":"auto","purpose":"peer-link","sessionTtl":"forever"}"#,
            r#"{"access":"auto","purpose":"peer-link","sessionTtl":null}"#,
            r#"{"access":"auto","purpose":"peer-link","sessionTtl":3600}"#,
        ] {
            let (status, reply) = post("/api/auth/pairing-token", body).await;
            assert_eq!(status, 400, "{body}: {reply}");
            assert_eq!(
                serde_json::from_str::<Value>(&reply).unwrap()["code"],
                "invalid_session_ttl",
                "{body}: {reply}"
            );
        }
        let (status, body) = post(
            "/api/auth/pairing-token",
            r#"{"scopes":["access:read"],"sessionTtl":"until-revoked"}"#,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let long: Value = serde_json::from_str(&body).unwrap();
        let held = auth
            .exchange(
                long["credential"].as_str().unwrap(),
                None,
                ClientInfo::default(),
            )
            .unwrap();
        assert!(
            held.principal.expires_at_ms > admin.principal.expires_at_ms + auth::SESSION_TTL_MS
        );

        let device = auth
            .exchange(
                link["credential"].as_str().unwrap(),
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let (status, body) = call(
            addr,
            &format!("GET /api/auth/clients HTTP/1.1\r\n{bearer}"),
            "",
        )
        .await;
        assert_eq!(status, 200);
        let clients: Vec<Value> = serde_json::from_str(&body).unwrap();
        assert_eq!(clients.len(), 3);
        assert!(
            clients
                .iter()
                .any(|c| c["current"] == true && c["client"]["label"] == "Orbit Gateway")
        );

        // `extend`: the caller's own session without `sessionId`, another's with it.
        let (status, body) = post(
            "/api/auth/clients/extend",
            r#"{"sessionTtl":"until-revoked"}"#,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let extended: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(extended["sessionId"], admin.principal.session_id.as_str());
        // The 30-day device session lacks access:write: it may not extend, not even itself.
        let before = auth
            .authenticate_bearer(&device.token)
            .unwrap()
            .expires_at_ms;
        let device_head = format!(
            "POST /api/auth/clients/extend HTTP/1.1\r\nauthorization: Bearer {}\r\ncontent-type: application/json",
            device.token
        );
        for body in [
            r#"{"sessionTtl":"until-revoked"}"#.to_owned(),
            format!(
                r#"{{"sessionId":"{}","sessionTtl":"until-revoked"}}"#,
                device.principal.session_id
            ),
        ] {
            let (status, reply) = call(addr, &device_head, &body).await;
            assert_eq!(status, 403, "{body}: {reply}");
            assert_eq!(
                serde_json::from_str::<Value>(&reply).unwrap()["requiredPermission"],
                "access:write"
            );
        }
        assert_eq!(
            auth.authenticate_bearer(&device.token)
                .unwrap()
                .expires_at_ms,
            before
        );
        // A peer link's MCP session extends itself, and only itself. Other MCP sessions may not.
        let mcp_session = |peer_link| {
            auth.issue_mcp_client_session(
                "Conn · holder",
                "auto-accept-edits",
                peer_link,
                ClientInfo::default(),
                auth::MCP_CLIENT_SESSION_TTL_MS,
            )
            .unwrap()
        };
        let (peer, agent) = (mcp_session(true), mcp_session(false));
        let mcp_head = |token: &str| {
            format!(
                "POST /api/auth/clients/extend HTTP/1.1\r\nauthorization: Bearer {token}\r\ncontent-type: application/json"
            )
        };
        for (token, body) in [
            (
                &peer.token,
                format!(
                    r#"{{"sessionId":"{}","sessionTtl":"until-revoked"}}"#,
                    peer.principal.session_id
                ),
            ),
            (&agent.token, r#"{"sessionTtl":"until-revoked"}"#.to_owned()),
        ] {
            let (status, reply) = call(addr, &mcp_head(token), &body).await;
            assert_eq!(status, 403, "{body}: {reply}");
        }
        let (status, body) = call(
            addr,
            &mcp_head(&peer.token),
            r#"{"sessionTtl":"until-revoked"}"#,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        let extended: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(extended["sessionId"], peer.principal.session_id.as_str());
        let a_year_on = iso_from_ms(peer.principal.expires_at_ms + 365 * 24 * 3_600_000);
        assert!(extended["expiresAt"].as_str().unwrap() > a_year_on.as_str());
        for token in [&peer.token, &agent.token] {
            auth.logout(token).unwrap().unwrap();
        }
        let device_ttl =
            |ttl: &str| format!(r#"{{"sessionId":"{}"{ttl}}}"#, device.principal.session_id);
        for ttl in [
            r#","sessionTtl":"1h""#,
            r#","sessionTtl":null"#,
            r#","sessionTtl":3600"#,
            "",
        ] {
            let (status, reply) = post("/api/auth/clients/extend", &device_ttl(ttl)).await;
            assert_eq!(status, 400, "{ttl}: {reply}");
            assert_eq!(
                serde_json::from_str::<Value>(&reply).unwrap()["code"],
                "invalid_session_ttl",
                "{ttl}: {reply}"
            );
        }
        let (status, body) = post(
            "/api/auth/clients/extend",
            &device_ttl(r#","sessionTtl":"until-revoked""#),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert!(
            auth.authenticate_bearer(&device.token)
                .unwrap()
                .expires_at_ms
                > admin.principal.expires_at_ms + auth::SESSION_TTL_MS
        );
        let (status, _) = post(
            "/api/auth/clients/extend",
            r#"{"sessionId":"no-such-session","sessionTtl":"until-revoked"}"#,
        )
        .await;
        assert_eq!(status, 404);

        let mine = format!(r#"{{"sessionId":"{}"}}"#, admin.principal.session_id);
        let (status, body) = post("/api/auth/clients/revoke", &mine).await;
        assert_eq!(status, 403);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "current_session_revoke_not_allowed"
        );
        let theirs = format!(r#"{{"sessionId":"{}"}}"#, device.principal.session_id);
        let (status, body) = post("/api/auth/clients/revoke", &theirs).await;
        assert_eq!((status, body.as_str()), (200, r#"{"revoked":true}"#));
        assert!(auth.authenticate_bearer(&device.token).is_none());

        let unused = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap();
        let (_, body) = post(
            "/api/auth/pairing-links/revoke",
            &format!(r#"{{"id":"{}"}}"#, unused.id),
        )
        .await;
        assert_eq!(body, r#"{"revoked":true}"#);
        // `logout` ends the caller's own until-revoked session at once, with no access:write,
        // and announces it so its sockets close. A repeat is the normal 401.
        let mut changes = auth.subscribe();
        let held_bearer = format!("authorization: Bearer {}", held.token);
        let logout = format!("POST /api/auth/logout HTTP/1.1\r\n{held_bearer}");
        let (status, body) = call(addr, &logout, "").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"sessionId": held.principal.session_id, "revoked": true})
        );
        assert_eq!(
            changes.try_recv().unwrap(),
            AccessChange::ClientRemoved(held.principal.session_id.clone())
        );
        assert!(auth.authenticate_bearer(&held.token).is_none());
        let (status, _) = call(addr, &logout, "").await;
        assert_eq!(status, 401);
        let (status, _) = call(
            addr,
            &format!("GET /api/auth/clients HTTP/1.1\r\n{held_bearer}"),
            "",
        )
        .await;
        assert_eq!(status, 401);
        let (_, body) = post("/api/auth/clients/revoke-others", "").await;
        assert_eq!(body, r#"{"revokedCount":0}"#);
        // Without access:read the list is refused.
        let (status, _) = call(addr, "GET /api/auth/clients HTTP/1.1", "").await;
        assert_eq!(status, 401);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_revoked_session_loses_its_open_socket() {
        let (addr, auth) = serve().await;
        let session = auth
            .exchange(
                &auth
                    .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                ClientInfo::default(),
            )
            .unwrap();
        let (ticket, _) = auth.issue_ticket(&session.token, Some("rpc")).unwrap();
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET /ws?orchestrationProtocol=2&wsTicket={ticket} HTTP/1.1\r\nhost: {addr}\r\n{UPGRADE}\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(buf[..n].starts_with(b"HTTP/1.1 101"));
        // Connected sockets show in the access list.
        let listed = auth.client_session(&session.principal.session_id, None);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut connected = listed.is_some_and(|s| s.connected);
        while !connected && tokio::time::Instant::now() < deadline {
            tokio::task::yield_now().await;
            connected = auth
                .client_session(&session.principal.session_id, None)
                .is_some_and(|s| s.connected);
        }
        assert!(connected);
        auth.revoke_session(None, &session.principal.session_id)
            .unwrap()
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "the socket stayed open after revocation");
    }

    /// The preview viewer socket ends with its session too, on revoke and on logout.
    #[tokio::test(flavor = "current_thread")]
    async fn a_revoked_session_loses_its_preview_socket() {
        let root = std::env::temp_dir().join(format!("conn-http-preview-{}", auth::random_hex(6)));
        let preview = conn_preview::tabs::Preview::with_fixture(
            root.clone(),
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../conn-preview/tests/fake-chrome.py"),
        );
        let opened = preview
            .invoke("thread", "agent", "open", json!({}))
            .await
            .unwrap();
        let tab = opened["tabId"].as_str().unwrap().to_owned();
        let (addr, auth) = serve_with_deps(
            None,
            crate::methods::Deps {
                preview: Some(preview.clone()),
                ..Default::default()
            },
        )
        .await;
        for end in ["revoke", "logout"] {
            let session = auth
                .issue_session(auth::SessionRequest {
                    scopes: vec!["orchestration:read".into()],
                    label: None,
                    subject: None,
                    ttl_ms: auth::MAX_TTL_MS,
                })
                .unwrap();
            let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
            let request = format!(
                "GET /api/preview-stream/ws?threadId=thread&tabId={tab} HTTP/1.1\r\nhost: {addr}\r\nauthorization: Bearer {}\r\n{UPGRADE}\r\n\r\n",
                session.token
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            assert!(
                buf[..n].starts_with(b"HTTP/1.1 101"),
                "{end}: {}",
                String::from_utf8_lossy(&buf[..n])
            );
            match end {
                "revoke" => {
                    auth.revoke_session(None, &session.principal.session_id)
                        .unwrap()
                        .unwrap();
                }
                _ => {
                    let logout = format!(
                        "POST /api/auth/logout HTTP/1.1\r\nauthorization: Bearer {}",
                        session.token
                    );
                    assert_eq!(call(addr, &logout, "").await.0, 200);
                }
            }
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => continue,
                    }
                }
            })
            .await;
            assert!(closed.is_ok(), "the preview socket stayed open after {end}");
        }
        preview.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    /// Revocation ends the preview socket while a viewer command waits on the browser: the
    /// fake browser never answers `Input.insertText`, and the socket still closes at once.
    #[tokio::test(flavor = "current_thread")]
    async fn a_preview_socket_closes_mid_command_on_revoke_and_logout() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
        let root = std::env::temp_dir().join(format!("conn-http-hang-{}", auth::random_hex(6)));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("hang-Input.insertText"), "").unwrap();
        let pending = root.join("pending-Input.insertText");
        let preview = conn_preview::tabs::Preview::with_fixture(
            root.clone(),
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../conn-preview/tests/fake-chrome.py"),
        );
        let opened = preview
            .invoke("thread", "agent", "open", json!({}))
            .await
            .unwrap();
        let tab = opened["tabId"].as_str().unwrap().to_owned();
        let (addr, auth) = serve_with_deps(
            None,
            crate::methods::Deps {
                preview: Some(preview.clone()),
                ..Default::default()
            },
        )
        .await;
        for end in ["revoke", "logout"] {
            let _ = std::fs::remove_file(&pending);
            let session = auth
                .issue_session(auth::SessionRequest {
                    scopes: vec!["orchestration:read".into(), "preview:operate".into()],
                    label: None,
                    subject: None,
                    ttl_ms: auth::MAX_TTL_MS,
                })
                .unwrap();
            let mut request =
                format!("ws://{addr}/api/preview-stream/ws?threadId=thread&tabId={tab}")
                    .into_client_request()
                    .unwrap();
            request.headers_mut().insert(
                "authorization",
                format!("Bearer {}", session.token).parse().unwrap(),
            );
            let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
            let (mut socket, _) = tokio_tungstenite::client_async(request, tcp).await.unwrap();
            // The control message first; take control, then send a command the browser holds.
            let control = socket.next().await.unwrap().unwrap();
            assert!(matches!(control, Message::Text(_)), "{end}: {control:?}");
            socket
                .send(Message::Text(
                    json!({"type": "takeControl"}).to_string().into(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    json!({"type": "text", "text": "x"}).to_string().into(),
                ))
                .await
                .unwrap();
            let arrived = tokio::time::timeout(Duration::from_secs(5), async {
                while !pending.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            assert!(
                arrived.is_ok(),
                "{end}: the command never reached the browser"
            );
            match end {
                "revoke" => {
                    auth.revoke_session(None, &session.principal.session_id)
                        .unwrap()
                        .unwrap();
                }
                _ => {
                    let logout = format!(
                        "POST /api/auth/logout HTTP/1.1\r\nauthorization: Bearer {}",
                        session.token
                    );
                    assert_eq!(call(addr, &logout, "").await.0, 200);
                }
            }
            // The browser's reply never comes, so only revocation can close the socket.
            let closed = tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(Ok(message)) = socket.next().await {
                    if matches!(message, Message::Close(_)) {
                        break;
                    }
                }
            })
            .await;
            assert!(
                closed.is_ok(),
                "the preview socket stayed open mid-command after {end}"
            );
        }
        preview.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    /// `CREDENTIAL_RESPONSE_HEADERS`: no cache may keep a token or a ticket.
    #[tokio::test(flavor = "current_thread")]
    async fn credential_responses_are_never_cached() {
        let (addr, auth) = serve().await;
        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let form = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token={code}&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
        );
        let head = "POST /oauth/token HTTP/1.1\r\ncontent-type: application/x-www-form-urlencoded";
        let (status, response_head, body) = call_full(addr, head, &form).await;
        assert_eq!(status, 200, "{body}");
        let token: Value = serde_json::from_str(&body).unwrap();
        let bearer = format!(
            "authorization: Bearer {}",
            token["access_token"].as_str().unwrap()
        );
        let mut heads = vec![response_head];
        for path in [
            "/api/auth/websocket-ticket",
            "/api/auth/websocket-ticket/rpc",
        ] {
            let (status, head, _) =
                call_full(addr, &format!("POST {path} HTTP/1.1\r\n{bearer}"), "").await;
            assert_eq!(status, 200);
            heads.push(head);
        }
        let (status, head, _) = call_full(
            addr,
            &format!("POST /api/auth/pairing-token HTTP/1.1\r\n{bearer}\r\ncontent-type: application/json"),
            "{}",
        )
        .await;
        assert_eq!(status, 200);
        heads.push(head);
        for head in heads {
            assert!(head.contains("\r\ncache-control: no-store"), "{head}");
            assert!(head.contains("\r\npragma: no-cache"), "{head}");
        }
    }

    /// A storage failure in the exchange is the server's fault (`access_token_issuance_failed`),
    /// never a bad credential.
    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn a_storage_failure_in_the_exchange_answers_500() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conn-server-http-ro-{}", auth::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let auth = AuthStore::open(dir.join("auth.json")).unwrap();
        let state = AppState {
            table: Arc::new(MethodTable::new()),
            auth: auth.clone(),
            descriptor: crate::environment::fixed_descriptor(crate::environment::descriptor(
                "env-test", "Test", false, None,
            )),
            engine: None,
            deps: Default::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(state)).await });
        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let form = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token={code}&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
        );
        let head = "POST /oauth/token HTTP/1.1\r\ncontent-type: application/x-www-form-urlencoded";
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let (status, body) = call(addr, head, &form).await;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(status, 500, "{body}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["reason"],
            "access_token_issuance_failed"
        );
        // The code was not spent.
        let (status, body) = call(addr, head, &form).await;
        assert_eq!(status, 200, "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn refuses_other_protocol_versions_before_auth() {
        let (addr, _) = serve().await;
        for query in ["", "orchestrationProtocol=1", "orchestrationProtocol=3"] {
            let (status, body) =
                call(addr, &format!("GET /ws?{query} HTTP/1.1\r\n{UPGRADE}"), "").await;
            assert_eq!(status, 426);
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["code"], "orchestration_protocol_incompatible");
            assert_eq!(body["orchestrationProtocolVersion"], 2);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dpop_exchanges_are_refused_without_spending_the_code() {
        let (addr, auth) = serve().await;
        let code = auth
            .issue_pairing_code(None, auth::PAIRING_CODE_TTL_MS)
            .unwrap()
            .code;
        let form = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token={code}&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
        );
        let head = "POST /oauth/token HTTP/1.1\r\ncontent-type: application/x-www-form-urlencoded";
        let (status, _) = call(addr, &format!("{head}\r\ndpop: x.y.z"), &form).await;
        assert_eq!(status, 401);
        let (status, _) = call(addr, head, &form).await;
        assert_eq!(status, 200);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn pull_request_diff_http_requires_the_read_scope_and_preserves_typed_errors() {
        let (addr, auth) = serve().await;
        let session = |scopes: &[&str]| {
            auth.issue_session(auth::SessionRequest {
                scopes: scopes.iter().map(|s| s.to_string()).collect(),
                label: None,
                subject: None,
                ttl_ms: auth::SESSION_TTL_MS,
            })
            .expect("session")
            .token
        };
        let denied = session(&["access:read"]);
        let reader = session(&["orchestration:read"]);
        let head = "POST /api/pull-requests/diff HTTP/1.1\r\ncontent-type: application/json";
        let body = json!({"projectId":"missing","host":"github.com","repository":"a/b","number":7})
            .to_string();
        assert_eq!(call(addr, head, &body).await.0, 401, "bearer required");
        assert_eq!(
            call(addr, head, "{").await.0,
            401,
            "auth precedes JSON decoding"
        );
        assert_eq!(
            call(
                addr,
                &format!("{head}\r\nauthorization: Bearer {denied}"),
                "{"
            )
            .await
            .0,
            403,
            "scope precedes JSON decoding"
        );
        let (status, body_denied) = call(
            addr,
            &format!("{head}\r\nauthorization: Bearer {denied}"),
            &body,
        )
        .await;
        assert_eq!(status, 403, "{body_denied}");
        let denied: Value = serde_json::from_str(&body_denied).expect("permission error");
        assert_eq!(
            denied["requiredPermission"], "orchestration:read",
            "HTTP and WS use the same permission"
        );
        let (status, error) = call(
            addr,
            &format!("{head}\r\nauthorization: Bearer {reader}"),
            &body,
        )
        .await;
        assert_eq!(status, 503, "{error}");
        let error: Value = serde_json::from_str(&error).expect("typed PR error");
        assert_eq!(
            error["_tag"], "PullRequestUnavailableError",
            "typed error body"
        );
    }
}
