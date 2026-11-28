use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use conn_contract::{
    AnnotationList, AnnotationProjectInput, OrchestrationV2ShellStreamItem,
    OrchestrationV2SubscribeShellInput, OrchestrationV2SubscribeThreadInput,
    OrchestrationV2ThreadStreamItem, ServerConfigStreamEvent, SubscribeServerConfigPayload,
    source::DesktopPanelSubscription,
};
use conn_wire::{Exit, FromClient, FromServer, Request, RequestId, frame_parts};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{debug, warn};
use yawc::{Frame, OpCode, WebSocketError};

use crate::auth::{TokenExchangeError, exchange_pairing_code};
use crate::wire::{
    Backoff, IncomingServerFrame, MAX_JOINED_MESSAGE_BYTES, build_ws_url,
    decode_server_message_raw, decode_thread_stream_item, encode_client_frame,
    extract_shell_sequence, extract_thread_sequence,
};
use crate::{ClientError, ClientEvent, ConnectionStatus, Credential, ServerConfig, StreamId};

const TAG_SUBSCRIBE_SHELL: &str = "orchestration.subscribeShell";
const TAG_SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";
const TAG_PANELS_REQUESTS: &str = "panels.requests";
const TAG_ANNOTATIONS_SUBSCRIBE: &str = "annotations.subscribe";
const TAG_SUBSCRIBE_SERVER_CONFIG: &str = "subscribeServerConfig";
const TAG_DISPATCH_COMMAND: &str = "orchestration.dispatchCommand";
const PING_INTERVAL: Duration = Duration::from_secs(5);
/// Store-owned background threads that may open (catch up) at once. The open thread (rank 0)
/// never waits; the others queue by rank, so the visible state comes first and twenty threads
/// do not compete for one socket and one server store at the same time.
const BACKGROUND_OPENINGS: usize = 2;
const MAX_MISSED_PONGS: u8 = 2;
/// How long the TCP connect plus WebSocket upgrade may take before the attempt counts as failed.
/// Without it, a server that accepts the socket but never answers the upgrade (a restarting
/// server behind a TCP forward) holds the driver forever, and every queued call with it.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// How many sessions a retry-safe call may be sent on before it fails with the session's error.
const MAX_CALL_ATTEMPTS: u8 = 3;

pub(crate) enum Command {
    SubscribeShell {
        include_idle_subagents: bool,
    },
    SubscribeServerConfig,
    SubscribeThread(String),
    /// A thread whose rows a local store keeps: it owns the resume cursor (`wire.md`).
    SubscribeThreadFrom {
        thread_id: String,
        after: Option<i64>,
        priority: u32,
    },
    /// The store committed this thread's rows through `after`: resume from there.
    SetThreadCursor {
        thread_id: String,
        after: i64,
    },
    RefreshThread(String),
    UnsubscribeThread(String),
    /// Ends the thread subscription and also drops its kept sequence.
    ForgetThread(String),
    SubscribePanelRequests(DesktopPanelSubscription),
    UnsubscribePanelRequests,
    SubscribeAnnotations(String),
    UnsubscribeAnnotations(String),
    Call {
        tag: String,
        payload: Value,
        reply: oneshot::Sender<Result<Value, ClientError>>,
    },
    StartStream {
        stream_id: StreamId,
        tag: String,
        payload: Value,
        tx: mpsc::Sender<Value>,
    },
    CancelStream(StreamId),
    Reconnect,
    Close,
}

struct ThreadSubState {
    after_sequence: Option<i64>,
    request_id: Option<RequestId>,
    /// When the current `subscribeThread` request went out (for `CONN_GPUI_PERF_LOG`).
    subscribed_at: Option<std::time::Instant>,
    /// Order of the last subscribe or refresh asked for this thread. A new session resubscribes
    /// the most recent first, so the thread the user just opened does not wait behind hundreds of
    /// background cache streams.
    touched: u64,
    /// A local store owns `after_sequence` (it moves only after the store commits) and the
    /// stream opens with `changesAfterSequence`.
    store_owned: bool,
    /// Lower goes first when a new session subscribes again; ties go most recent first.
    priority: u32,
    /// A store-owned background thread whose subscribe went out and whose `synchronized` has
    /// not come yet: it holds one of the [`BACKGROUND_OPENINGS`] slots.
    opening: bool,
    /// Its subscribe should go out but has not: new, re-requested, or the session restarted.
    /// A stream the server ended stays out until something asks for it again.
    waiting: bool,
}

impl ThreadSubState {
    const fn new(after_sequence: Option<i64>, touched: u64) -> Self {
        Self {
            after_sequence,
            request_id: None,
            subscribed_at: None,
            touched,
            store_owned: false,
            priority: u32::MAX,
            opening: false,
            waiting: true,
        }
    }
}

enum ActiveStream {
    Shell,
    ServerConfig,
    Thread(String),
    PanelRequests,
    Annotations(String),
    Generic {
        stream_id: StreamId,
        tx: mpsc::Sender<Value>,
    },
}

struct PendingCall {
    tag: String,
    payload: Value,
    reply: oneshot::Sender<Result<Value, ClientError>>,
    /// Sessions this call was already sent on without an answer.
    attempts: u8,
}

impl PendingCall {
    /// Whether sending this call again after a lost session cannot do its work twice.
    /// `dispatchCommand` is deduplicated by `commandId` on the server: a repeat returns the
    /// first receipt.
    fn retry_safe(&self) -> bool {
        self.tag == TAG_DISPATCH_COMMAND
            && self
                .payload
                .get("commandId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
    }
}

struct PendingStream {
    stream_id: StreamId,
    tag: String,
    payload: Value,
    tx: mpsc::Sender<Value>,
}

struct DriverState {
    config: ServerConfig,
    shared_bearer: Arc<RwLock<Option<String>>>,
    http: reqwest::Client,
    backoff: Backoff,
    next_request_id: i64,
    shell_subscribed: bool,
    include_idle_subagents: bool,
    shell_after_sequence: Option<i64>,
    shell_request_id: Option<RequestId>,
    server_config_subscribed: bool,
    server_config_request_id: Option<RequestId>,
    thread_subs: HashMap<String, ThreadSubState>,
    /// An opening slot freed: send the subscribes that wait for one.
    admit_due: bool,
    /// Last observed stream sequence per thread, preserved across `UnsubscribeThread` ->
    /// `SubscribeThread` so switching back replays deltas instead of re-downloading a snapshot.
    thread_last_sequences: HashMap<String, i64>,
    panel_subscription: Option<DesktopPanelSubscription>,
    panel_request_id: Option<RequestId>,
    annotation_subs: HashMap<String, Option<RequestId>>,
    pending_calls: Vec<PendingCall>,
    pending_streams: Vec<PendingStream>,
    in_flight_unary: HashMap<RequestId, PendingCall>,
    /// Source of [`ThreadSubState::touched`].
    touch_counter: u64,
    in_flight_streams: HashMap<RequestId, ActiveStream>,
    generic_stream_ids: HashMap<StreamId, RequestId>,
    closed: bool,
}

impl DriverState {
    fn new(
        config: ServerConfig,
        shared_bearer: Arc<RwLock<Option<String>>>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            config,
            shared_bearer,
            http,
            backoff: Backoff::new(),
            next_request_id: 1,
            shell_subscribed: false,
            include_idle_subagents: false,
            shell_after_sequence: None,
            shell_request_id: None,
            server_config_subscribed: false,
            server_config_request_id: None,
            thread_subs: HashMap::new(),
            admit_due: false,
            thread_last_sequences: HashMap::new(),
            panel_subscription: None,
            panel_request_id: None,
            annotation_subs: HashMap::new(),
            pending_calls: Vec::new(),
            pending_streams: Vec::new(),
            in_flight_unary: HashMap::new(),
            touch_counter: 0,
            in_flight_streams: HashMap::new(),
            generic_stream_ids: HashMap::new(),
            closed: false,
        }
    }

    fn next_touch(&mut self) -> u64 {
        self.touch_counter = self.touch_counter.wrapping_add(1);
        self.touch_counter
    }

    /// Marks `thread_id` as just asked for, adding it (with its kept cursor) when it is new.
    /// Returns whether the thread was new.
    fn touch_thread(&mut self, thread_id: &str) -> bool {
        let touched = self.next_touch();
        if let Some(sub) = self.thread_subs.get_mut(thread_id) {
            sub.touched = touched;
            return false;
        }
        let last_seq = self.thread_last_sequences.get(thread_id).copied();
        self.thread_subs
            .insert(thread_id.to_owned(), ThreadSubState::new(last_seq, touched));
        true
    }

    /// Thread subscriptions in the order a new session sends them: the most recently asked for
    /// first.
    fn thread_ids_by_recency(&self) -> Vec<String> {
        let mut ids: Vec<(&String, (u32, u64))> = self
            .thread_subs
            .iter()
            .map(|(id, sub)| (id, (sub.priority, sub.touched)))
            .collect();
        // A store's rank first (the open thread is 0), then the most recently asked for.
        ids.sort_by(|a, b| {
            (a.1.0, std::cmp::Reverse(a.1.1), a.0).cmp(&(b.1.0, std::cmp::Reverse(b.1.1), b.0))
        });
        ids.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// After a session ends: calls that are safe to send again wait for the next session (in
    /// the order they were first sent); every other call fails with `reason`, because the server
    /// may have done its work already.
    fn requeue_or_fail_in_flight_calls(&mut self, reason: &str) {
        let mut in_flight: Vec<(RequestId, PendingCall)> = self.in_flight_unary.drain().collect();
        in_flight.sort_by_key(|(id, _)| match id {
            RequestId::Number(n) => *n,
            RequestId::String(_) => i64::MAX,
        });
        let mut retry = Vec::new();
        for (_, mut call) in in_flight {
            call.attempts = call.attempts.saturating_add(1);
            if call.retry_safe() && call.attempts < MAX_CALL_ATTEMPTS && !call.reply.is_closed() {
                retry.push(call);
            } else {
                let _ = call
                    .reply
                    .send(Err(ClientError::Connection(reason.to_owned())));
            }
        }
        // Retried calls go before calls queued while the session was down.
        retry.append(&mut self.pending_calls);
        self.pending_calls = retry;
    }

    fn alloc_request_id(&mut self) -> RequestId {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        RequestId::Number(id)
    }

    fn fail_all_calls(&mut self, make_err: impl Fn() -> ClientError) {
        for (_, call) in self.in_flight_unary.drain() {
            let _ = call.reply.send(Err(make_err()));
        }
        for pending in self.pending_calls.drain(..) {
            let _ = pending.reply.send(Err(make_err()));
        }
    }

    fn clear_active_streams(&mut self) {
        self.in_flight_streams.clear();
        self.generic_stream_ids.clear();
        self.shell_request_id = None;
        self.server_config_request_id = None;
        self.panel_request_id = None;
        for sub in self.thread_subs.values_mut() {
            sub.request_id = None;
            sub.opening = false;
            sub.waiting = true;
        }
        for req_id in self.annotation_subs.values_mut() {
            *req_id = None;
        }
    }

    fn reset_thread(&mut self, thread_id: &str) -> Option<RequestId> {
        self.thread_last_sequences.remove(thread_id);
        let touched = self.next_touch();
        self.thread_subs
            .insert(thread_id.to_owned(), ThreadSubState::new(None, touched))
            .and_then(|sub| sub.request_id)
    }

    /// Ends `thread_id`'s subscription and drops its cursor. Returns the stream to interrupt.
    fn forget_thread(&mut self, thread_id: &str) -> Option<RequestId> {
        self.thread_last_sequences.remove(thread_id);
        self.thread_subs
            .remove(thread_id)
            .and_then(|sub| sub.request_id)
    }

    /// Adds or re-ranks a store-owned subscription. True when it needs a request on the wire.
    fn subscribe_from(&mut self, thread_id: String, after: Option<i64>, priority: u32) -> bool {
        let touched = self.next_touch();
        match self.thread_subs.get_mut(&thread_id) {
            Some(sub) if sub.store_owned => {
                sub.priority = priority;
                sub.touched = touched;
                sub.waiting |= sub.request_id.is_none();
                sub.waiting
            }
            _ => {
                // The store's cursor is the only one: never a sequence remembered from before.
                self.thread_last_sequences.remove(&thread_id);
                let mut sub = ThreadSubState::new(after, touched);
                sub.store_owned = true;
                sub.priority = priority;
                self.thread_subs.insert(thread_id, sub);
                true
            }
        }
    }

    /// Whether `thread_id`'s subscribe may go out now: always, except a store-owned background
    /// thread while [`BACKGROUND_OPENINGS`] others are still opening.
    fn may_open(&self, thread_id: &str) -> bool {
        let background = |sub: &ThreadSubState| sub.store_owned && sub.priority > 0;
        match self.thread_subs.get(thread_id) {
            Some(sub) if background(sub) => {
                self.thread_subs
                    .values()
                    .filter(|sub| background(sub) && sub.opening)
                    .count()
                    < BACKGROUND_OPENINGS
            }
            _ => true,
        }
    }

    /// Frees `thread_id`'s opening slot: its `synchronized` came, or its stream ended.
    fn opened(&mut self, thread_id: &str) {
        if let Some(sub) = self.thread_subs.get_mut(thread_id)
            && std::mem::take(&mut sub.opening)
        {
            self.admit_due = true;
        }
    }

    fn set_cursor(&mut self, thread_id: &str, after: i64) {
        if let Some(sub) = self
            .thread_subs
            .get_mut(thread_id)
            .filter(|s| s.store_owned)
        {
            sub.after_sequence = Some(sub.after_sequence.map_or(after, |seq| seq.max(after)));
        }
    }

    fn handle_offline_command(&mut self, cmd: Command) {
        match cmd {
            Command::SubscribeShell {
                include_idle_subagents,
            } => {
                self.include_idle_subagents = include_idle_subagents;
                self.shell_subscribed = true;
            }
            Command::SubscribeServerConfig => {
                self.server_config_subscribed = true;
            }
            Command::RefreshThread(thread_id) => {
                self.reset_thread(&thread_id);
            }
            Command::SubscribeThread(thread_id) => {
                self.touch_thread(&thread_id);
            }
            Command::SubscribeThreadFrom {
                thread_id,
                after,
                priority,
            } => {
                self.subscribe_from(thread_id, after, priority);
            }
            Command::SetThreadCursor { thread_id, after } => {
                self.set_cursor(&thread_id, after);
            }
            Command::UnsubscribeThread(thread_id) => {
                if let Some(sub) = self.thread_subs.remove(&thread_id)
                    && !sub.store_owned
                    && let Some(seq) = sub.after_sequence
                {
                    self.thread_last_sequences.insert(thread_id, seq);
                }
            }
            Command::ForgetThread(thread_id) => {
                self.forget_thread(&thread_id);
            }
            Command::SubscribePanelRequests(subscription) => {
                self.panel_subscription = Some(subscription);
            }
            Command::UnsubscribePanelRequests => {
                self.panel_subscription = None;
            }
            Command::SubscribeAnnotations(project_id) => {
                self.annotation_subs.entry(project_id).or_insert(None);
            }
            Command::UnsubscribeAnnotations(project_id) => {
                self.annotation_subs.remove(&project_id);
            }
            Command::Call {
                tag,
                payload,
                reply,
            } => {
                self.pending_calls.push(PendingCall {
                    tag,
                    payload,
                    reply,
                    attempts: 0,
                });
            }
            Command::StartStream {
                stream_id,
                tag,
                payload,
                tx,
            } => {
                self.pending_streams.push(PendingStream {
                    stream_id,
                    tag,
                    payload,
                    tx,
                });
            }
            Command::CancelStream(stream_id) => {
                self.pending_streams.retain(|s| s.stream_id != stream_id);
            }
            Command::Reconnect => {
                self.backoff.reset();
            }
            Command::Close => {
                self.closed = true;
            }
        }
    }
}

/// Checks the driver makes around the WebSocket handshake ([`crate::StartOptions`]).
pub(crate) struct Guards {
    /// On a 401 or 403 handshake, stop with [`ConnectionStatus::Failed`] instead of retrying.
    pub(crate) stop_on_auth_rejection: bool,
    /// Set on every such refusal; read through [`crate::Connection::auth_rejected`].
    pub(crate) auth_seen: Arc<AtomicBool>,
    /// Before each handshake, the server's descriptor must name this environment, or the
    /// bearer is never sent. Shared, so it can be set once the environment is learned.
    pub(crate) expected_environment: Arc<std::sync::Mutex<Option<String>>>,
    /// The environment a server named instead; read through
    /// [`crate::Connection::identity_mismatch`].
    pub(crate) mismatch: Arc<std::sync::Mutex<Option<String>>>,
}

/// The message [`ConnectionStatus::Failed`] carries after an auth rejection.
pub(crate) const AUTH_REJECTED_MESSAGE: &str = "The server rejected this device's sign-in.";

/// The message [`ConnectionStatus::Failed`] carries when another environment answers.
pub(crate) const IDENTITY_CHANGED_MESSAGE: &str =
    "Another environment answers at this server's address.";

/// Reads the server's environment id (`/.well-known/t3/environment`), without credentials.
/// `None` when the server can't be reached or doesn't say.
async fn fetch_environment(base: &url::Url) -> Option<String> {
    let url = base.join(".well-known/t3/environment").ok()?;
    // No redirects: the answer must come from this host, not one it points to.
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = http
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    let body: Value = response.json().await.ok()?;
    body.get("environmentId")?.as_str().map(str::to_owned)
}

fn is_auth_rejection(err: &WebSocketError) -> bool {
    matches!(err, WebSocketError::InvalidStatusCode(401 | 403))
}

pub(crate) async fn run(
    config: ServerConfig,
    shared_bearer: Arc<RwLock<Option<String>>>,
    http: reqwest::Client,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
    events_tx: mpsc::Sender<ClientEvent>,
    guards: Guards,
) {
    let mut state = DriverState::new(config, shared_bearer, http);

    if events_tx
        .send(ClientEvent::Status(ConnectionStatus::Connecting))
        .await
        .is_err()
    {
        return;
    }

    loop {
        drain_pending_commands(&mut state, &mut cmd_rx);
        if state.closed {
            break;
        }

        let expected = guards
            .expected_environment
            .lock()
            .ok()
            .and_then(|slot| slot.clone());
        if let Some(expected) = expected.as_deref() {
            match fetch_environment(&state.config.http_base_url).await {
                Some(found) if found == expected => {}
                Some(found) => {
                    warn!("conn-client: {found} answers where {expected} was expected");
                    if let Ok(mut slot) = guards.mismatch.lock() {
                        *slot = Some(found);
                    }
                    state.fail_all_calls(|| {
                        ClientError::Connection(IDENTITY_CHANGED_MESSAGE.to_owned())
                    });
                    let _ = events_tx
                        .send(ClientEvent::Status(ConnectionStatus::Failed(
                            IDENTITY_CHANGED_MESSAGE.to_owned(),
                        )))
                        .await;
                    return;
                }
                // Not reachable (or silent): no handshake, so the bearer stays here.
                None => {
                    if !wait_backoff(&mut state, &mut cmd_rx, &events_tx).await {
                        break;
                    }
                    continue;
                }
            }
        }

        let token = match resolve_bearer(&mut state, &events_tx).await {
            Ok(token) => token,
            Err(ResolveError::Fatal(msg)) => {
                warn!("conn-client fatal auth failure: {msg}");
                state.fail_all_calls(|| ClientError::Auth(msg.clone()));
                let _ = events_tx
                    .send(ClientEvent::Status(ConnectionStatus::Failed(msg)))
                    .await;
                return;
            }
            Err(ResolveError::Retryable(msg)) => {
                debug!("conn-client retryable auth error: {msg}");
                if !wait_backoff(&mut state, &mut cmd_rx, &events_tx).await {
                    break;
                }
                continue;
            }
        };

        let (ws_url, ws_request) = match build_ws_request(&state.config.http_base_url, &token) {
            Ok(req) => req,
            Err(err) => {
                let msg = err.to_string();
                state.fail_all_calls(|| ClientError::Connection(msg.clone()));
                let _ = events_tx
                    .send(ClientEvent::Status(ConnectionStatus::Failed(msg)))
                    .await;
                return;
            }
        };

        // Offers permessage-deflate; the server chooses the context settings.
        // `with_no_delay` (TCP_NODELAY): every client frame is a small Ack or Request. With
        // Nagle on, a `subscribeThread` sent right after an Ack waits for the server's delayed
        // TCP ACK (up to ~200 ms on macOS) before it leaves the socket.
        let ws_options = yawc::Options::default()
            .with_max_payload_read(MAX_JOINED_MESSAGE_BYTES)
            .with_utf8()
            .with_no_delay()
            .with_compression_level(yawc::CompressionLevel::fast())
            .with_compression_threshold(256);
        let handshake = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            yawc::WebSocket::connect(ws_url)
                .with_options(ws_options)
                .with_request(ws_request),
        );
        let connected = match handshake.await {
            Ok(result) => result,
            Err(_) => {
                debug!("conn-client websocket handshake timed out after {HANDSHAKE_TIMEOUT:?}");
                if state.closed || !wait_backoff(&mut state, &mut cmd_rx, &events_tx).await {
                    break;
                }
                continue;
            }
        };
        match connected {
            Ok(ws_stream) => {
                state.backoff.reset();
                if events_tx
                    .send(ClientEvent::Status(ConnectionStatus::Connected))
                    .await
                    .is_err()
                {
                    break;
                }

                let session_result = run_session(&mut state, ws_stream, &mut cmd_rx, &events_tx);
                let outcome = Box::pin(session_result).await;
                state.requeue_or_fail_in_flight_calls("connection closed");
                state.clear_active_streams();

                match outcome {
                    SessionOutcome::Closed => break,
                    SessionOutcome::ReconnectNow => {
                        state.backoff.reset();
                        if events_tx
                            .send(ClientEvent::Status(ConnectionStatus::Connecting))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    SessionOutcome::Disconnected(reason) => {
                        debug!("conn-client disconnected: {reason}");
                    }
                }
            }
            Err(err) => {
                debug!("conn-client websocket connect failed: {err}");
                if is_auth_rejection(&err) {
                    guards.auth_seen.store(true, Ordering::Release);
                    if guards.stop_on_auth_rejection {
                        state
                            .fail_all_calls(|| ClientError::Auth(AUTH_REJECTED_MESSAGE.to_owned()));
                        let _ = events_tx
                            .send(ClientEvent::Status(ConnectionStatus::Failed(
                                AUTH_REJECTED_MESSAGE.to_owned(),
                            )))
                            .await;
                        return;
                    }
                }
            }
        }

        if state.closed {
            break;
        }
        if !wait_backoff(&mut state, &mut cmd_rx, &events_tx).await {
            break;
        }
    }

    state.fail_all_calls(|| ClientError::Closed);
}

enum ResolveError {
    Fatal(String),
    Retryable(String),
}

async fn resolve_bearer(
    state: &mut DriverState,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> Result<String, ResolveError> {
    match &state.config.credential {
        Credential::Bearer(token) => Ok(token.clone()),
        Credential::PairingCode(code) => {
            let code = code.clone();
            match exchange_pairing_code(&state.http, &state.config.http_base_url, &code).await {
                Ok(token) => {
                    state.config.credential = Credential::Bearer(token.clone());
                    if let Ok(mut guard) = state.shared_bearer.write() {
                        *guard = Some(token.clone());
                    }
                    let _ = events_tx
                        .send(ClientEvent::BearerIssued(token.clone()))
                        .await;
                    Ok(token)
                }
                Err(TokenExchangeError::Rejected(msg)) => Err(ResolveError::Fatal(msg)),
                Err(TokenExchangeError::Retryable(msg)) => Err(ResolveError::Retryable(msg)),
            }
        }
    }
}

fn build_ws_request(
    http_base_url: &url::Url,
    bearer_token: &str,
) -> Result<(url::Url, yawc::HttpRequestBuilder), ClientError> {
    let ws_url = build_ws_url(http_base_url)?;
    let auth_header = reqwest::header::HeaderValue::from_str(&format!("Bearer {bearer_token}"))
        .map_err(|err| ClientError::Auth(format!("invalid bearer token header: {err}")))?;
    let request =
        yawc::HttpRequestBuilder::new().header(reqwest::header::AUTHORIZATION, auth_header);
    Ok((ws_url, request))
}

fn drain_pending_commands(state: &mut DriverState, cmd_rx: &mut mpsc::UnboundedReceiver<Command>) {
    while let Ok(cmd) = cmd_rx.try_recv() {
        state.handle_offline_command(cmd);
    }
}

/// Sleeps for the next backoff interval while continuing to accept commands.
/// Returns `false` if the client was closed or the event receiver was dropped.
async fn wait_backoff(
    state: &mut DriverState,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> bool {
    let (attempt, delay) = state.backoff.next_delay();
    if events_tx
        .send(ClientEvent::Status(ConnectionStatus::Reconnecting {
            attempt,
        }))
        .await
        .is_err()
    {
        return false;
    }

    let sleep = tokio::time::sleep(delay);
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            () = &mut sleep => return true,
            maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                Some(Command::Reconnect) => {
                    state.backoff.reset();
                    return true;
                }
                Some(cmd) => {
                    state.handle_offline_command(cmd);
                    if state.closed {
                        return false;
                    }
                }
                None => {
                    state.closed = true;
                    return false;
                }
            }
        }
    }
}

enum SessionOutcome {
    Closed,
    ReconnectNow,
    Disconnected(String),
}

type WsStream = yawc::TcpWebSocket;

async fn run_session(
    state: &mut DriverState,
    ws_stream: WsStream,
    cmd_rx: &mut mpsc::UnboundedReceiver<Command>,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> SessionOutcome {
    let (mut ws_write, mut ws_read) = ws_stream.split();
    let mut joiner = frame_parts::Joiner::new(MAX_JOINED_MESSAGE_BYTES);
    // When the first part of the message being joined arrived (`CONN_GPUI_PERF_LOG`).
    let mut message_started_at: Option<std::time::Instant> = None;

    // Resubscribe desired shell and thread streams and flush any queued calls/streams.
    if let Err(err) = restore_subscriptions_and_pending(state, &mut ws_write).await {
        return SessionOutcome::Disconnected(err);
    }

    let mut ping_interval = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    ping_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut missed_pongs: u8 = 0;

    loop {
        tokio::select! {
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(frame) if frame.opcode() == OpCode::Text => {
                        let Ok(text) = std::str::from_utf8(frame.payload()) else {
                            return SessionOutcome::Disconnected("ws text is not UTF-8".to_owned());
                        };
                        // Receiving any text frame (including multi-part snapshot chunks) proves
                        // the server connection is live; don't let keepalive drop a huge snapshot
                        // mid-transfer while the server is busy streaming frame parts.
                        missed_pongs = 0;
                        let part_at = std::time::Instant::now();
                        let started_at = *message_started_at.get_or_insert(part_at);
                        let whole = match joiner.push(text) {
                            Ok(Some(whole)) => {
                                message_started_at = None;
                                whole
                            }
                            Ok(None) => continue,
                            Err(frame_parts::TooLarge) => {
                                eprintln!(
                                    "conn-client: reassembled frame exceeded max size ({MAX_JOINED_MESSAGE_BYTES} bytes)"
                                );
                                return SessionOutcome::Disconnected(
                                    "reassembled frame exceeded max size".to_owned(),
                                );
                            }
                        };
                        let timing = MessageTiming {
                            started_at,
                            bytes: whole.len(),
                        };
                        let frames = match decode_server_message_raw(&whole) {
                            Ok(frames) => frames,
                            Err(err) => {
                                eprintln!("conn-client failed to decode server frame: {err}");
                                warn!("conn-client failed to decode server frame: {err}");
                                continue;
                            }
                        };
                        for frame in frames {
                            if let Err(outcome) = handle_incoming_frame(
                                state,
                                frame,
                                &mut ws_write,
                                events_tx,
                                &mut missed_pongs,
                                timing,
                            ).await {
                                return outcome;
                            }
                        }
                    }
                    // yawc answers pings itself and ends the stream on a read error.
                    Some(frame) if frame.opcode() == OpCode::Close => {
                        return SessionOutcome::Disconnected("server closed websocket".to_owned());
                    }
                    None => {
                        return SessionOutcome::Disconnected("websocket closed or failed".to_owned());
                    }
                    Some(_) => {}
                }
            }
            _ = ping_interval.tick() => {
                if missed_pongs >= MAX_MISSED_PONGS {
                    return SessionOutcome::Disconnected("missed 2 keepalive pongs".to_owned());
                }
                missed_pongs = missed_pongs.saturating_add(1);
                if let Err(err) = send_client_frame(&mut ws_write, &FromClient::Ping).await {
                    return SessionOutcome::Disconnected(err);
                }
            }
            maybe_cmd = cmd_rx.recv() => {
                match maybe_cmd {
                    Some(Command::Close) | None => {
                        state.closed = true;
                        let _ = send_client_frame(&mut ws_write, &FromClient::Eof).await;
                        let _ = ws_write.send(Frame::close(yawc::close::CloseCode::Normal, "")).await;
                        return SessionOutcome::Closed;
                    }
                    Some(Command::Reconnect) => {
                        let _ = ws_write.send(Frame::close(yawc::close::CloseCode::Normal, "")).await;
                        return SessionOutcome::ReconnectNow;
                    }
                    Some(cmd) => {
                        if let Err(err) = handle_online_command(state, cmd, &mut ws_write).await {
                            return SessionOutcome::Disconnected(err);
                        }
                    }
                }
            }
        }
    }
}

async fn restore_subscriptions_and_pending<S>(
    state: &mut DriverState,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    // Calls first: the server reads its store one request at a time, so a send queued while the
    // server was away must not wait behind every resubscribed stream's replay.
    let pending_calls = std::mem::take(&mut state.pending_calls);
    for call in pending_calls {
        send_unary_call(state, call, ws_write).await?;
    }

    if state.shell_subscribed && state.shell_request_id.is_none() {
        send_shell_subscribe(state, ws_write).await?;
    }

    if state.server_config_subscribed && state.server_config_request_id.is_none() {
        send_server_config_subscribe(state, ws_write).await?;
    }

    // Each kept cursor asks only for what changed while the session was down.
    admit_threads(state, ws_write).await?;

    if state.panel_subscription.is_some() && state.panel_request_id.is_none() {
        send_panel_requests_subscribe(state, ws_write).await?;
    }

    let project_ids: Vec<String> = state.annotation_subs.keys().cloned().collect();
    for project_id in project_ids {
        send_annotations_subscribe(state, &project_id, ws_write).await?;
    }

    let pending_streams = std::mem::take(&mut state.pending_streams);
    for stream in pending_streams {
        send_generic_stream(
            state,
            stream.stream_id,
            stream.tag,
            stream.payload,
            stream.tx,
            ws_write,
        )
        .await?;
    }

    Ok(())
}

async fn handle_online_command<S>(
    state: &mut DriverState,
    cmd: Command,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    match cmd {
        Command::SubscribeShell {
            include_idle_subagents,
        } => {
            state.include_idle_subagents = include_idle_subagents;
            state.shell_subscribed = true;
            if state.shell_request_id.is_none() {
                send_shell_subscribe(state, ws_write).await?;
            }
        }
        Command::SubscribeServerConfig => {
            state.server_config_subscribed = true;
            if state.server_config_request_id.is_none() {
                send_server_config_subscribe(state, ws_write).await?;
            }
        }
        Command::RefreshThread(thread_id) => {
            if let Some(request_id) = state.reset_thread(&thread_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
            send_thread_subscribe(state, &thread_id, ws_write).await?;
        }
        Command::SubscribeThread(thread_id) => {
            let added = state.touch_thread(&thread_id);
            let needs_send = added
                || state
                    .thread_subs
                    .get(&thread_id)
                    .is_some_and(|existing| existing.request_id.is_none());
            if needs_send {
                send_thread_subscribe(state, &thread_id, ws_write).await?;
            }
        }
        Command::SubscribeThreadFrom {
            thread_id,
            after,
            priority,
        } => {
            if state.subscribe_from(thread_id.clone(), after, priority)
                && state.may_open(&thread_id)
            {
                send_thread_subscribe(state, &thread_id, ws_write).await?;
            }
        }
        Command::SetThreadCursor { thread_id, after } => {
            state.set_cursor(&thread_id, after);
        }
        Command::UnsubscribeThread(thread_id) => {
            if let Some(sub) = state.thread_subs.remove(&thread_id) {
                if !sub.store_owned
                    && let Some(seq) = sub.after_sequence
                {
                    state.thread_last_sequences.insert(thread_id, seq);
                }
                if let Some(request_id) = sub.request_id {
                    state.in_flight_streams.remove(&request_id);
                    send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
                }
            }
            admit_threads(state, ws_write).await?;
        }
        Command::ForgetThread(thread_id) => {
            if let Some(request_id) = state.forget_thread(&thread_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::SubscribePanelRequests(subscription) => {
            let next = Some(subscription);
            if state.panel_subscription != next {
                if let Some(request_id) = state.panel_request_id.take() {
                    state.in_flight_streams.remove(&request_id);
                    send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
                }
                state.panel_subscription = next;
            }
            if state.panel_request_id.is_none() {
                send_panel_requests_subscribe(state, ws_write).await?;
            }
        }
        Command::UnsubscribePanelRequests => {
            state.panel_subscription = None;
            if let Some(request_id) = state.panel_request_id.take() {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::SubscribeAnnotations(project_id) => {
            let needs_send = match state.annotation_subs.get(&project_id) {
                Some(existing) => existing.is_none(),
                None => {
                    state.annotation_subs.insert(project_id.clone(), None);
                    true
                }
            };
            if needs_send {
                send_annotations_subscribe(state, &project_id, ws_write).await?;
            }
        }
        Command::UnsubscribeAnnotations(project_id) => {
            if let Some(Some(request_id)) = state.annotation_subs.remove(&project_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::Call {
            tag,
            payload,
            reply,
        } => {
            let call = PendingCall {
                tag,
                payload,
                reply,
                attempts: 0,
            };
            send_unary_call(state, call, ws_write).await?;
        }
        Command::StartStream {
            stream_id,
            tag,
            payload,
            tx,
        } => {
            send_generic_stream(state, stream_id, tag, payload, tx, ws_write).await?;
        }
        Command::CancelStream(stream_id) => {
            if let Some(request_id) = state.generic_stream_ids.remove(&stream_id) {
                state.in_flight_streams.remove(&request_id);
                send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await?;
            }
        }
        Command::Reconnect => {}
        Command::Close => {
            state.closed = true;
        }
    }
    Ok(())
}

async fn send_shell_subscribe<S>(state: &mut DriverState, ws_write: &mut S) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let input = OrchestrationV2SubscribeShellInput {
        after_sequence: state.shell_after_sequence,
        http_snapshot_fallback: None,
        known_project_identities: None,
        request_completion_marker: Some(true),
        omit_idle_subagents: Some(!state.include_idle_subagents),
        omit_older_settled: Some(true),
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode subscribeShell payload: {err}"))?;
    let request_id = state.alloc_request_id();
    state.shell_request_id = Some(request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::Shell);
    send_request(ws_write, request_id, TAG_SUBSCRIBE_SHELL, payload).await
}

/// `subscribeServerConfig`: the config snapshot, then provider, settings and keybinding changes.
/// Asks for `providerStatusDeltas`, which leave out the models, slash commands and skills the
/// client holds; the other opt-ins stay off because this client reads none of what they add.
async fn send_server_config_subscribe<S>(
    state: &mut DriverState,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let input = SubscribeServerConfigPayload {
        environment_themes: None,
        usage_limit_sources: None,
        usage_limits_command: None,
        workspace_snapshots_on_demand: None,
        provider_catalogs_on_demand: None,
        provider_catalog_digests: None,
        provider_status_deltas: Some(true),
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode subscribeServerConfig payload: {err}"))?;
    let request_id = state.alloc_request_id();
    state.server_config_request_id = Some(request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::ServerConfig);
    send_request(ws_write, request_id, TAG_SUBSCRIBE_SERVER_CONFIG, payload).await
}

/// Sends the subscribes that wait and may go now ([`DriverState::may_open`]), by rank and then
/// recency: the open thread at once, background threads as opening slots free.
async fn admit_threads<S>(state: &mut DriverState, ws_write: &mut S) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    for thread_id in state.thread_ids_by_recency() {
        let waiting = state
            .thread_subs
            .get(&thread_id)
            .is_some_and(|sub| sub.waiting && sub.request_id.is_none());
        if waiting && state.may_open(&thread_id) {
            send_thread_subscribe(state, &thread_id, ws_write).await?;
        }
    }
    Ok(())
}

async fn send_thread_subscribe<S>(
    state: &mut DriverState,
    thread_id: &str,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let store_owned = state
        .thread_subs
        .get(thread_id)
        .is_some_and(|s| s.store_owned);
    let after_sequence = state
        .thread_subs
        .get(thread_id)
        .and_then(|s| s.after_sequence)
        .or_else(|| {
            (!store_owned)
                .then(|| state.thread_last_sequences.get(thread_id).copied())
                .flatten()
        });
    let (after_sequence, changes_after_sequence) = if store_owned {
        (None, after_sequence)
    } else {
        (after_sequence, None)
    };
    let input = OrchestrationV2SubscribeThreadInput {
        thread_id: thread_id.to_owned(),
        after_sequence,
        changes_after_sequence,
        // T3 always asks for `synchronized`: it ends "Loading thread…" for threads whose
        // snapshot has no rows, and marks the end of an `afterSequence` replay.
        request_completion_marker: Some(true),
        // Opt in to bounded snapshots (newest ~75 items / 10 turns) with on-demand `/history`
        // paging; servers that don't support bounded snapshots ignore this flag safely.
        // `acceptDeferredWork` and `acceptCompactIds` stay off until lazy body fetch & idTable
        // decoding are wired.
        accept_bounded_snapshot: Some(true),
        accept_deferred_work: None,
        accept_compact_turn_items: Some(true),
        // A store keeps rows as the server sends them, so it takes whole bodies.
        accept_deduped_bodies: (!store_owned).then_some(true),
        accept_compact_ids: None,
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode subscribeThread payload: {err}"))?;
    let request_id = state.alloc_request_id();
    if let Some(sub) = state.thread_subs.get_mut(thread_id) {
        sub.request_id = Some(request_id.clone());
        sub.subscribed_at = Some(std::time::Instant::now());
        sub.opening = sub.store_owned && sub.priority > 0;
        sub.waiting = false;
    }
    state.in_flight_streams.insert(
        request_id.clone(),
        ActiveStream::Thread(thread_id.to_owned()),
    );
    let result = send_request(ws_write, request_id, TAG_SUBSCRIBE_THREAD, payload).await;
    crate::perf_log!("client.subscribe_sent thread={thread_id} after_sequence={after_sequence:?}");
    result
}

async fn send_panel_requests_subscribe<S>(
    state: &mut DriverState,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let Some(input) = &state.panel_subscription else {
        return Ok(());
    };
    let payload = serde_json::to_value(input)
        .map_err(|err| format!("failed to encode panels.requests payload: {err}"))?;
    let request_id = state.alloc_request_id();
    state.panel_request_id = Some(request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::PanelRequests);
    send_request(ws_write, request_id, TAG_PANELS_REQUESTS, payload).await
}

async fn send_annotations_subscribe<S>(
    state: &mut DriverState,
    project_id: &str,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let input = AnnotationProjectInput {
        project_id: project_id.to_owned(),
    };
    let payload = serde_json::to_value(&input)
        .map_err(|err| format!("failed to encode annotations.subscribe payload: {err}"))?;
    let request_id = state.alloc_request_id();
    if let Some(slot) = state.annotation_subs.get_mut(project_id) {
        *slot = Some(request_id.clone());
    }
    state.in_flight_streams.insert(
        request_id.clone(),
        ActiveStream::Annotations(project_id.to_owned()),
    );
    send_request(ws_write, request_id, TAG_ANNOTATIONS_SUBSCRIBE, payload).await
}

async fn send_unary_call<S>(
    state: &mut DriverState,
    mut call: PendingCall,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    // The caller stopped waiting: nothing would read the answer.
    if call.reply.is_closed() {
        return Ok(());
    }
    let request_id = state.alloc_request_id();
    let tag = call.tag.clone();
    // A retry-safe call keeps its payload, so a lost session can send it again.
    let payload = if call.retry_safe() {
        call.payload.clone()
    } else {
        std::mem::take(&mut call.payload)
    };
    state.in_flight_unary.insert(request_id.clone(), call);
    send_request(ws_write, request_id, &tag, payload).await
}

async fn send_generic_stream<S>(
    state: &mut DriverState,
    stream_id: StreamId,
    tag: String,
    payload: Value,
    tx: mpsc::Sender<Value>,
    ws_write: &mut S,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let request_id = state.alloc_request_id();
    state
        .generic_stream_ids
        .insert(stream_id, request_id.clone());
    state
        .in_flight_streams
        .insert(request_id.clone(), ActiveStream::Generic { stream_id, tx });
    send_request(ws_write, request_id, &tag, payload).await
}

async fn send_request<S>(
    ws_write: &mut S,
    id: RequestId,
    tag: &str,
    payload: Value,
) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let frame = FromClient::Request(Request {
        id,
        tag: tag.to_owned(),
        payload,
        headers: Vec::new(),
        is_notification: None,
        discard: None,
        trace_id: None,
        span_id: None,
        sampled: None,
    });
    send_client_frame(ws_write, &frame).await
}

async fn send_client_frame<S>(ws_write: &mut S, frame: &FromClient) -> Result<(), String>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    let text = encode_client_frame(frame)
        .map_err(|err| format!("failed to serialize client frame: {err}"))?;
    ws_write
        .send(Frame::text(text))
        .await
        .map_err(|err| format!("ws send failed: {err}"))
}

/// When a whole server message started arriving and how big it was (`CONN_GPUI_PERF_LOG`).
#[derive(Clone, Copy)]
struct MessageTiming {
    started_at: std::time::Instant,
    bytes: usize,
}

async fn handle_incoming_frame<S>(
    state: &mut DriverState,
    frame: IncomingServerFrame,
    ws_write: &mut S,
    events_tx: &mpsc::Sender<ClientEvent>,
    missed_pongs: &mut u8,
    timing: MessageTiming,
) -> Result<(), SessionOutcome>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    match frame {
        IncomingServerFrame::Chunk { request_id, values } => {
            handle_chunk_raw(state, request_id, values, ws_write, events_tx, timing).await?;
        }
        IncomingServerFrame::Other(FromServer::Pong) => {
            *missed_pongs = 0;
        }
        IncomingServerFrame::Other(FromServer::Chunk { request_id, values }) => {
            let raw_values: Vec<Box<RawValue>> = values
                .into_iter()
                .filter_map(|v| {
                    serde_json::to_string(&v)
                        .ok()
                        .and_then(|s| RawValue::from_string(s).ok())
                })
                .collect();
            handle_chunk_raw(state, request_id, raw_values, ws_write, events_tx, timing).await?;
        }
        IncomingServerFrame::Other(FromServer::Exit { request_id, exit }) => {
            handle_exit(state, request_id, exit, events_tx).await?;
        }
        IncomingServerFrame::Other(FromServer::Defect { defect }) => {
            for (_, call) in state.in_flight_unary.drain() {
                let _ = call.reply.send(Err(ClientError::Rpc(defect.clone())));
            }
        }
        IncomingServerFrame::Other(FromServer::ClientProtocolError { error, request_ids }) => {
            match request_ids {
                Some(ids) => {
                    for id in ids {
                        if let Some(call) = state.in_flight_unary.remove(&id) {
                            let _ = call.reply.send(Err(ClientError::Rpc(error.clone())));
                        }
                    }
                }
                None => {
                    for (_, call) in state.in_flight_unary.drain() {
                        let _ = call.reply.send(Err(ClientError::Rpc(error.clone())));
                    }
                }
            }
        }
        IncomingServerFrame::Other(FromServer::Request(_)) => {}
    }
    // An opening slot freed (a thread's `synchronized`, or its stream ended): send the
    // subscribes waiting for one. Once here, so no frame path can miss it.
    if std::mem::take(&mut state.admit_due) {
        admit_threads(state, ws_write)
            .await
            .map_err(SessionOutcome::Disconnected)?;
    }
    Ok(())
}

async fn handle_chunk_raw<S>(
    state: &mut DriverState,
    request_id: RequestId,
    values: Vec<Box<RawValue>>,
    ws_write: &mut S,
    events_tx: &mpsc::Sender<ClientEvent>,
    timing: MessageTiming,
) -> Result<(), SessionOutcome>
where
    S: futures::Sink<Frame, Error = WebSocketError> + Unpin,
{
    // Always acknowledge chunks immediately so server streams never stall.
    send_client_frame(
        ws_write,
        &FromClient::Ack {
            request_id: request_id.clone(),
        },
    )
    .await
    .map_err(SessionOutcome::Disconnected)?;

    let mut drop_generic_stream: Option<StreamId> = None;

    match state.in_flight_streams.get(&request_id) {
        Some(ActiveStream::Shell) => {
            for raw in values {
                match serde_json::from_str::<OrchestrationV2ShellStreamItem>(raw.get()) {
                    Ok(item) => {
                        if matches!(item, OrchestrationV2ShellStreamItem::SnapshotRequired(_)) {
                            state.shell_after_sequence = None;
                        } else if let Some(seq) = extract_shell_sequence(&item) {
                            state.shell_after_sequence = Some(seq);
                        }
                        if events_tx.send(ClientEvent::Shell(item)).await.is_err() {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        eprintln!("conn-client failed to decode shell stream item: {err}");
                        warn!("conn-client failed to decode shell stream item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::ServerConfig) => {
            for raw in values {
                match serde_json::from_str::<ServerConfigStreamEvent>(raw.get()) {
                    Ok(event) => {
                        if events_tx
                            .send(ClientEvent::ServerConfig(Box::new(event)))
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        warn!("conn-client failed to decode subscribeServerConfig item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::Thread(thread_id)) => {
            let thread_id = thread_id.clone();
            for raw in values {
                let decode_start = std::time::Instant::now();
                match decode_thread_stream_item(raw.get()) {
                    Ok(item) => {
                        if crate::perf::enabled() {
                            log_thread_item_decoded(state, &thread_id, &item, timing, decode_start);
                        }
                        let store_owned = state
                            .thread_subs
                            .get(&thread_id)
                            .is_some_and(|s| s.store_owned);
                        if store_owned
                            && matches!(item, OrchestrationV2ThreadStreamItem::Synchronized(_))
                        {
                            state.opened(&thread_id);
                        }
                        if !store_owned && let Some(seq) = extract_thread_sequence(&item) {
                            state.thread_last_sequences.insert(thread_id.clone(), seq);
                            if let Some(sub) = state.thread_subs.get_mut(&thread_id) {
                                sub.after_sequence = Some(seq);
                            }
                        }
                        if events_tx
                            .send(ClientEvent::Thread {
                                thread_id: thread_id.clone(),
                                item,
                            })
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        eprintln!(
                            "conn-client failed to decode thread stream item ({thread_id}): {err}"
                        );
                        warn!("conn-client failed to decode thread stream item: {err}");
                        // A store must not move its cursor past a change it never saw.
                        if state
                            .thread_subs
                            .get(&thread_id)
                            .is_some_and(|s| s.store_owned)
                            && events_tx
                                .send(ClientEvent::ThreadStale {
                                    thread_id: thread_id.clone(),
                                })
                                .await
                                .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                }
            }
        }
        Some(ActiveStream::PanelRequests) => {
            for raw in values {
                match serde_json::from_str::<conn_contract::source::DesktopPanelRequest>(raw.get())
                {
                    Ok(request) => {
                        if events_tx
                            .send(ClientEvent::PanelRequest(request))
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        warn!("conn-client failed to decode panels.requests item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::Annotations(project_id)) => {
            let project_id = project_id.clone();
            for raw in values {
                match serde_json::from_str::<AnnotationList>(raw.get()) {
                    Ok(list) => {
                        if events_tx
                            .send(ClientEvent::Annotations {
                                project_id: project_id.clone(),
                                annotations: list.annotations,
                            })
                            .await
                            .is_err()
                        {
                            return Err(SessionOutcome::Closed);
                        }
                    }
                    Err(err) => {
                        warn!("conn-client failed to decode annotations.subscribe item: {err}");
                    }
                }
            }
        }
        Some(ActiveStream::Generic { stream_id, tx }) => {
            let stream_id = *stream_id;
            let tx = tx.clone();
            for raw in values {
                let Ok(value) = serde_json::from_str::<Value>(raw.get()) else {
                    continue;
                };
                if tx.send(value).await.is_err() {
                    drop_generic_stream = Some(stream_id);
                    break;
                }
            }
        }
        None => {}
    }

    if let Some(stream_id) = drop_generic_stream {
        state.in_flight_streams.remove(&request_id);
        state.generic_stream_ids.remove(&stream_id);
        let _ = send_client_frame(ws_write, &FromClient::Interrupt { request_id }).await;
    }

    Ok(())
}

fn log_thread_item_decoded(
    state: &DriverState,
    thread_id: &str,
    item: &OrchestrationV2ThreadStreamItem,
    timing: MessageTiming,
    decode_start: std::time::Instant,
) {
    let kind = match item {
        OrchestrationV2ThreadStreamItem::Snapshot(_) => "snapshot",
        OrchestrationV2ThreadStreamItem::Synchronized(_) => "synchronized",
        OrchestrationV2ThreadStreamItem::Event(_) | OrchestrationV2ThreadStreamItem::Event2(_) => {
            "event"
        }
    };
    let since_subscribe = state
        .thread_subs
        .get(thread_id)
        .and_then(|sub| sub.subscribed_at)
        .map_or(f64::NAN, crate::perf::ms_since);
    crate::perf_log!(
        "client.decoded thread={thread_id} kind={kind} message_bytes={} receive_ms={:.1} decode_ms={:.1} +{since_subscribe:.1}ms",
        timing.bytes,
        decode_start.duration_since(timing.started_at).as_secs_f64() * 1000.0,
        crate::perf::ms_since(decode_start),
    );
}

async fn handle_exit(
    state: &mut DriverState,
    request_id: RequestId,
    exit: Exit,
    events_tx: &mpsc::Sender<ClientEvent>,
) -> Result<(), SessionOutcome> {
    if let Some(PendingCall { reply, .. }) = state.in_flight_unary.remove(&request_id) {
        let result = match exit {
            Exit::Success { value } => Ok(value),
            Exit::Failure { cause } => {
                let cause_json = serde_json::to_value(&cause).unwrap_or(Value::Null);
                Err(ClientError::Rpc(cause_json))
            }
        };
        let _ = reply.send(result);
        return Ok(());
    }

    if let Some(stream) = state.in_flight_streams.remove(&request_id) {
        let error = match exit {
            Exit::Success { .. } => None,
            Exit::Failure { cause } => Some(
                serde_json::to_string(&cause)
                    .unwrap_or_else(|_| "stream exited with failure".to_owned()),
            ),
        };
        match stream {
            ActiveStream::Shell => {
                if state.shell_request_id.as_ref() == Some(&request_id) {
                    state.shell_request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_SUBSCRIBE_SHELL.to_owned(),
                        key: String::new(),
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::ServerConfig => {
                if state.server_config_request_id.as_ref() == Some(&request_id) {
                    state.server_config_request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_SUBSCRIBE_SERVER_CONFIG.to_owned(),
                        key: String::new(),
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::Thread(thread_id) => {
                if let Some(sub) = state.thread_subs.get_mut(&thread_id)
                    && sub.request_id.as_ref() == Some(&request_id)
                {
                    sub.request_id = None;
                    if std::mem::take(&mut sub.opening) {
                        state.admit_due = true;
                    }
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_SUBSCRIBE_THREAD.to_owned(),
                        key: thread_id,
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::PanelRequests => {
                if state.panel_request_id.as_ref() == Some(&request_id) {
                    state.panel_request_id = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_PANELS_REQUESTS.to_owned(),
                        key: String::new(),
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::Annotations(project_id) => {
                if let Some(slot) = state.annotation_subs.get_mut(&project_id)
                    && slot.as_ref() == Some(&request_id)
                {
                    *slot = None;
                }
                if events_tx
                    .send(ClientEvent::StreamEnded {
                        tag: TAG_ANNOTATIONS_SUBSCRIBE.to_owned(),
                        key: project_id,
                        error,
                    })
                    .await
                    .is_err()
                {
                    return Err(SessionOutcome::Closed);
                }
            }
            ActiveStream::Generic { stream_id, .. } => {
                state.generic_stream_ids.remove(&stream_id);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> DriverState {
        let base = url::Url::parse("http://127.0.0.1:9").unwrap_or_else(|e| panic!("{e}"));
        DriverState::new(
            ServerConfig {
                http_base_url: base,
                credential: Credential::Bearer("test".into()),
            },
            Arc::new(RwLock::new(None)),
            reqwest::Client::new(),
        )
    }

    /// A store's cursor is the only one for its thread: a thread it forgot and keeps again
    /// starts cold, never from a sequence remembered from an earlier subscription.
    #[test]
    fn a_store_owned_thread_never_resumes_from_a_remembered_cursor() {
        let mut state = state();
        state.thread_last_sequences.insert("t".into(), 7);
        state.subscribe_from("t".into(), Some(5), 1);
        state.set_cursor("t", 9);
        state.handle_offline_command(Command::UnsubscribeThread("t".into()));
        assert!(
            !state.thread_last_sequences.contains_key("t"),
            "no cursor kept"
        );
        state.subscribe_from("t".into(), None, 1);
        assert_eq!(
            state.thread_subs.get("t").and_then(|s| s.after_sequence),
            None
        );
    }

    /// What `send_thread_subscribe` records when a subscribe goes out.
    fn sent(state: &mut DriverState, id: &str) {
        if let Some(sub) = state.thread_subs.get_mut(id) {
            sub.request_id = Some(RequestId::Number(1));
            sub.opening = sub.store_owned && sub.priority > 0;
            sub.waiting = false;
        }
    }

    /// The open thread never waits; background threads open two at a time, and a slot frees
    /// when an opening's `synchronized` comes.
    #[test]
    fn background_threads_open_two_at_a_time() {
        let mut state = state();
        for (id, rank) in [("a", 1), ("b", 2), ("c", 3)] {
            state.subscribe_from(id.into(), None, rank);
        }
        assert!(state.may_open("a"));
        sent(&mut state, "a");
        sent(&mut state, "b");
        assert!(!state.may_open("c"), "both slots taken");
        state.subscribe_from("open".into(), None, 0);
        assert!(state.may_open("open"), "the open thread never waits");
        state.opened("a");
        assert!(state.admit_due && state.may_open("c"), "a slot freed");
    }

    /// A stream the server ended is not sent again by the queue; asking again re-queues it.
    #[test]
    fn an_ended_stream_waits_until_asked_again() {
        let mut state = state();
        state.subscribe_from("t".into(), Some(3), 1);
        sent(&mut state, "t");
        if let Some(sub) = state.thread_subs.get_mut("t") {
            sub.request_id = None;
            sub.opening = false;
        }
        assert!(
            !state.thread_subs.get("t").is_some_and(|s| s.waiting),
            "parked"
        );
        assert!(state.subscribe_from("t".into(), Some(3), 1), "asked again");
        assert!(state.thread_subs.get("t").is_some_and(|s| s.waiting));
    }

    /// A thread's `synchronized`, arriving as an ordinary stream chunk, frees its slot and the
    /// next waiting thread's subscribe goes out. (The raw chunk path once skipped this, so
    /// only the first two background threads ever caught up.)
    #[tokio::test]
    async fn a_synchronized_chunk_admits_the_next_waiting_thread() {
        let mut state = state();
        for (id, rank) in [("a", 1), ("b", 2), ("c", 3)] {
            state.subscribe_from(id.into(), None, rank);
        }
        sent(&mut state, "a");
        sent(&mut state, "b");
        let request_id = RequestId::Number(1);
        state
            .in_flight_streams
            .insert(request_id.clone(), ActiveStream::Thread("a".into()));
        let mut frames = Vec::new();
        let sink = futures::sink::unfold(&mut frames, |frames, frame: Frame| async move {
            frames.push(frame);
            Ok::<_, WebSocketError>(frames)
        });
        let mut sink = std::pin::pin!(sink);
        let (events_tx, mut events_rx) = mpsc::channel(16);
        let synchronized = RawValue::from_string(r#"{"kind":"synchronized"}"#.into())
            .unwrap_or_else(|e| panic!("{e}"));
        let frame = IncomingServerFrame::Chunk {
            request_id,
            values: vec![synchronized],
        };
        let timing = MessageTiming {
            started_at: std::time::Instant::now(),
            bytes: 0,
        };
        let mut missed = 0;
        let handled = handle_incoming_frame(
            &mut state,
            frame,
            &mut sink,
            &events_tx,
            &mut missed,
            timing,
        )
        .await;
        assert!(handled.is_ok());
        assert!(events_rx.try_recv().is_ok(), "the marker reached the app");
        assert!(
            state
                .thread_subs
                .get("c")
                .is_some_and(|s| s.request_id.is_some()),
            "the waiting thread was sent"
        );
    }

    /// A new session subscribes the store's ranks first (the open thread is 0).
    #[test]
    fn a_new_session_subscribes_by_rank_then_recency() {
        let mut state = state();
        state.subscribe_from("background".into(), None, 3);
        state.subscribe_from("open".into(), None, 0);
        state.handle_offline_command(Command::SubscribeThread("plain".into()));
        assert_eq!(
            state.thread_ids_by_recency(),
            ["open", "background", "plain"]
        );
    }
}
