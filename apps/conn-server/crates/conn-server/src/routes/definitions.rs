use crate::{AppState, http::require_scope, methods::files::Layout};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use conn_contract::source::{DefinitionRequest, PreparePhpNavigation};
use std::sync::Arc;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/files/definition", post(definition))
        .route("/api/files/prepare-php", post(prepare_php))
}

#[derive(serde::Deserialize)]
struct Options {
    #[serde(default)]
    mode: conn_files::navigation::DefinitionMode,
}

async fn navigation_workspace(
    state: &AppState,
    headers: &HeaderMap,
    thread: &str,
) -> Result<(Arc<conn_files::Files>, String), Response> {
    // Laravel resolves framework symbols by running the workspace's PHP.
    for scope in ["filesystem:read", "terminal:operate"] {
        if let Err(response) = require_scope(state, headers, scope) {
            return Err(*response);
        }
    }
    let Some(files) = state.deps.files.clone() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE.into_response());
    };
    let Some(root) = Layout::load(state.engine.as_ref())
        .await
        .thread_root(thread)
    else {
        return Err((StatusCode::NOT_FOUND, "Thread workspace is unavailable.").into_response());
    };
    Ok((files, root))
}

async fn prepare_php(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PreparePhpNavigation>,
) -> Result<Json<()>, Response> {
    let (files, root) = navigation_workspace(&state, &headers, &input.thread_id).await?;
    files
        .navigation
        .warm_php(&root, input.path, &files.internal)
        .await
        .map(Json)
        .map_err(|message| (StatusCode::UNPROCESSABLE_ENTITY, message).into_response())
}

async fn definition(
    State(state): State<AppState>,
    Query(options): Query<Options>,
    headers: HeaderMap,
    Json(input): Json<DefinitionRequest>,
) -> Result<Json<Vec<conn_contract::source::DefinitionTarget>>, Response> {
    let (files, root) = navigation_workspace(&state, &headers, &input.thread_id).await?;
    files
        .navigation
        .lookup(&root, input.query, &files.internal, options.mode)
        .await
        .map(Json)
        .map_err(|message| (StatusCode::UNPROCESSABLE_ENTITY, message).into_response())
}
