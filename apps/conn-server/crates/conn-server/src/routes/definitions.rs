use crate::{AppState, http::require_scope, methods::files::Layout};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use conn_contract::source::DefinitionRequest;

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/api/files/definition", post(definition))
}

async fn definition(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<DefinitionRequest>,
) -> Response {
    // Laravel resolves framework symbols by running the workspace's PHP.
    for scope in ["filesystem:read", "terminal:operate"] {
        if let Err(response) = require_scope(&state, &headers, scope) {
            return *response;
        }
    }
    let Some(files) = state.deps.files else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(root) = Layout::load(state.engine.as_ref())
        .await
        .thread_root(&input.thread_id)
    else {
        return (StatusCode::NOT_FOUND, "Thread workspace is unavailable.").into_response();
    };
    match files
        .navigation
        .definition(&root, input.query, &files.internal)
        .await
    {
        Ok(targets) => Json(targets).into_response(),
        Err(message) => (StatusCode::UNPROCESSABLE_ENTITY, message).into_response(),
    }
}
