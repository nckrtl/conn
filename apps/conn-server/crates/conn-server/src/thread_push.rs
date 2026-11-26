//! Tells the Orbit Gateway about a host thread, so the Gateway's thread librarian can file it
//! within seconds (`POST /api/v1/conn/environments/{environment}/threads`, route
//! `conn:thread:record`). Every thread is created through a Conn Server and the Gateway never
//! polls a host, so this push is the only way the Gateway learns of a thread.
//!
//! - The engine writes one row per thread to `thread_push_outbox` in the commit that starts the
//!   thread's first run, and again when its title changes (`conn-engine/src/thread_push.rs`).
//!   The turn never waits: this module drains the table on its own task.
//! - A failed send is retried until the Gateway answers 2xx: after 1 s, 5 s, 30 s, then every
//!   5 minutes. The table is SQLite, so rows survive a restart and a Gateway outage. A repeat
//!   call is safe; the Gateway updates the thread.
//! - A refusal that may pass is retried too: 401, 403, 404, 408, 409, 423, 425, 429 and every
//!   5xx, such as the Gateway not yet knowing this server while its registration completes.
//!   Any other refusal drops the row, since the same call cannot succeed.
//! - It acts only for a server Orbit has registered: one with a live session labeled
//!   "Orbit Gateway", which `t3-orbit-register` issues. Any other server drops its rows.
//!   Container servers and inert copies never write rows.
//! - The Gateway is `ORBIT_GATEWAY_URL` when set, else the address `environment link-orbit`
//!   last used (`orbit-gateway-url` in the state folder), else `https://gateway.orbit`.
//! - Orbit knows this machine by its WireGuard address, so the call carries no credential. It
//!   goes through the system `curl`, as the Orbit link does.
//!
//! The title is the only thread content that leaves the server, and it is never logged.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use conn_engine::{BoxFuture, SqliteEngine};
use serde_json::json;

use crate::attention::{SendError, backoff};
use crate::orbit_link::DEFAULT_GATEWAY_URL;

/// Overrides the Gateway address. `t3-orbit-register` reads the same variable.
pub const GATEWAY_VAR: &str = "ORBIT_GATEWAY_URL";
/// The state file that holds the Gateway address `environment link-orbit` last used.
pub const GATEWAY_FILE: &str = "orbit-gateway-url";
/// The label of the admin session `t3-orbit-register` issues for the Gateway.
pub const REGISTRATION_LABEL: &str = "Orbit Gateway";
/// How long curl may take. The Gateway answers in milliseconds.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
/// Threads read from the outbox per pass.
const BATCH: usize = 32;
/// How long the drain waits after the outbox itself failed to answer.
const STORE_RETRY: Duration = Duration::from_secs(30);

/// A host thread the Gateway should hear of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewThread {
    pub environment_id: String,
    pub thread_id: String,
    pub title: String,
}

/// Where the call goes. Tests use an in-memory sender.
pub trait ThreadSender: Send + Sync {
    fn record(&self, thread: NewThread) -> BoxFuture<'static, Result<(), SendError>>;
}

/// Whether Orbit has registered this server. Read at each pass, since registration can finish
/// after the server starts.
pub type Registered = Arc<dyn Fn() -> bool + Send + Sync>;

/// The registered check for a server whose sessions live in `auth`.
pub fn registered_by(auth: Arc<crate::auth::AuthStore>) -> Registered {
    Arc::new(move || auth.has_session_labeled(REGISTRATION_LABEL))
}

/// The Gateway through the system curl.
#[derive(Debug)]
pub struct CurlSender {
    state_dir: PathBuf,
}

impl CurlSender {
    pub fn new(state_dir: PathBuf) -> Self {
        Self { state_dir }
    }
}

impl ThreadSender for CurlSender {
    fn record(&self, thread: NewThread) -> BoxFuture<'static, Result<(), SendError>> {
        let state_dir = self.state_dir.clone();
        Box::pin(async move {
            // Reading the state file and running curl both block.
            let answer = tokio::task::spawn_blocking(move || {
                let (url, body) = request(&gateway_base(&state_dir), &thread);
                crate::orbit_link::curl_json("POST", &url, &body, SEND_TIMEOUT)
            })
            .await
            .map_err(|error| SendError::RetryLater(error.to_string()))?
            .map_err(SendError::RetryLater)?;
            match answer.0 {
                200..300 => Ok(()),
                status => Err(classify(status)),
            }
        })
    }
}

/// What a refusal with `status` means: worth another try, or final.
pub fn classify(status: u16) -> SendError {
    let reason = format!("the Gateway answered {status}");
    if status >= 500 || matches!(status, 401 | 403 | 404 | 408 | 409 | 423 | 425 | 429) {
        SendError::RetryLater(reason)
    } else {
        SendError::Rejected(reason)
    }
}

/// The URL and the JSON body of `conn:thread:record`.
fn request(base: &str, thread: &NewThread) -> (String, String) {
    let url = format!(
        "{base}/api/v1/conn/environments/{}/threads",
        conn_support::ids::encode_component(&thread.environment_id)
    );
    let body = json!({"thread_id": thread.thread_id, "title": thread.title}).to_string();
    (url, body)
}

/// `value` without a trailing slash, if it is an http(s) URL.
fn url_of(value: Option<&str>) -> Option<String> {
    let value = value?.trim().trim_end_matches('/');
    (value.starts_with("https://") || value.starts_with("http://")).then(|| value.to_owned())
}

/// The Gateway address: the override, else the one `link-orbit` saved, else the default.
fn pick_gateway(from_env: Option<&str>, from_file: Option<&str>) -> String {
    url_of(from_env)
        .or_else(|| url_of(from_file))
        .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_owned())
}

/// Reads the override and the state file. Blocking.
fn gateway_base(state_dir: &Path) -> String {
    let from_file = std::fs::read_to_string(state_dir.join(GATEWAY_FILE)).ok();
    pick_gateway(
        std::env::var(GATEWAY_VAR).ok().as_deref(),
        from_file.as_deref(),
    )
}

/// Saves the address a successful `environment link-orbit` used, so the push follows it.
/// Blocking. A failure is logged: the link itself worked.
pub fn remember_gateway(state_dir: &Path, gateway_url: &str) {
    let Some(url) = url_of(Some(gateway_url)) else {
        return;
    };
    let file = state_dir.join(GATEWAY_FILE);
    if let Err(error) = conn_support::fs::write_atomic(&file, format!("{url}\n").as_bytes(), 0o644)
    {
        eprintln!("conn-server: cannot save {}: {error}", file.display());
    }
}

/// What one pass did, for the log and the tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pass {
    pub sent: usize,
    pub retried: usize,
    pub rejected: usize,
    /// Rows dropped because Orbit has not registered this server.
    pub unregistered: usize,
    /// When the next row is due, by the engine's clock.
    pub next_due: Option<u64>,
}

/// Sends every thread that is due now, once. Never logs a title.
pub async fn drain_once(
    engine: &SqliteEngine,
    sender: &dyn ThreadSender,
    registered: &Registered,
    environment_id: &str,
) -> Result<Pass, String> {
    let now = engine.now_millis();
    let mut pass = Pass::default();
    let rows = engine.thread_push_due(now, BATCH).await?;
    if !rows.is_empty() && !registered() {
        for row in &rows {
            engine
                .thread_push_delivered(&row.thread_id, &row.title)
                .await?;
        }
        pass.unregistered = rows.len();
    } else {
        for row in rows {
            let call = sender.record(NewThread {
                environment_id: environment_id.to_owned(),
                thread_id: row.thread_id.clone(),
                title: row.title.clone(),
            });
            // The sender has its own limit; this one keeps a stuck sender from holding the pass.
            let answer = tokio::time::timeout(SEND_TIMEOUT + Duration::from_secs(1), call)
                .await
                .unwrap_or_else(|_| Err(SendError::RetryLater("timed out".into())));
            match answer {
                Ok(()) => {
                    engine
                        .thread_push_delivered(&row.thread_id, &row.title)
                        .await?;
                    pass.sent += 1;
                }
                Err(SendError::RetryLater(reason)) => {
                    let attempts = row.attempts.saturating_add(1);
                    if attempts == 1 {
                        eprintln!(
                            "conn-server: thread push: the Orbit Gateway was not told of thread {}: {reason}; retrying",
                            row.thread_id
                        );
                    }
                    let wait = u64::try_from(backoff(attempts).as_millis()).unwrap_or(u64::MAX);
                    engine
                        .thread_push_retry(
                            &row.thread_id,
                            &row.title,
                            attempts,
                            now.saturating_add(wait),
                        )
                        .await?;
                    pass.retried += 1;
                }
                Err(SendError::Rejected(reason)) => {
                    eprintln!(
                        "conn-server: thread push: thread {} dropped: {reason}",
                        row.thread_id
                    );
                    engine
                        .thread_push_delivered(&row.thread_id, &row.title)
                        .await?;
                    pass.rejected += 1;
                }
            }
        }
    }
    pass.next_due = engine.thread_push_next_due().await?;
    Ok(pass)
}

/// Drains the outbox for as long as the server runs: at start (rows left from before a
/// restart), after each commit that wrote a row, and when a retry comes due. Starts nothing
/// when the engine has thread pushes off.
pub fn spawn(
    engine: Arc<SqliteEngine>,
    sender: Arc<dyn ThreadSender>,
    registered: Registered,
    environment_id: String,
) -> Option<tokio::task::JoinHandle<()>> {
    let signal = engine.thread_push_signal()?;
    Some(tokio::spawn(async move {
        loop {
            let wait =
                match drain_once(&engine, sender.as_ref(), &registered, &environment_id).await {
                    Ok(pass) => pass.next_due.map(|at| {
                        let wait = Duration::from_millis(at.saturating_sub(engine.now_millis()));
                        // A due row this pass could not read must not spin the loop.
                        if pass.sent + pass.retried + pass.rejected + pass.unregistered == 0 {
                            wait.max(Duration::from_secs(1))
                        } else {
                            wait
                        }
                    }),
                    Err(error) => {
                        eprintln!("conn-server: thread push outbox: {error}");
                        Some(STORE_RETRY)
                    }
                };
            match wait {
                Some(Duration::ZERO) => tokio::task::yield_now().await,
                Some(wait) => {
                    tokio::select! {
                        () = signal.notified() => {}
                        () = tokio::time::sleep(wait) => {}
                    }
                }
                None => signal.notified().await,
            }
        }
    }))
}

#[cfg(test)]
#[path = "thread_push_tests.rs"]
mod tests;
