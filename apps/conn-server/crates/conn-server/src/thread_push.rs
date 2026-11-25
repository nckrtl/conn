//! Tells the Orbit Gateway about a host thread as soon as it starts, so the Gateway's thread
//! librarian can file it within seconds instead of waiting for its next read of this server's
//! shell (`POST /api/v1/conn/environments/{environment}/threads`, route `conn:thread:record`).
//!
//! - Off unless `ORBIT_GATEWAY_URL` names the Gateway. Registration with Orbit is an outside
//!   script (`scripts/orbit/t3-orbit-register`) and leaves no state here, so this variable is
//!   how a registered host turns the push on. Container servers and inert copies never push.
//! - One call per thread, when its first turn starts (`run_ordinal == 1`). The thread's
//!   shell row decides whether it is a host thread: not a subagent, a delegated task or a side
//!   chat, not archived (the rule attention events use).
//! - Fire and forget. The turn never waits: the call runs on its own task with a short
//!   time limit. A failure is logged and dropped; the Gateway's own read stays the fallback.
//! - Orbit knows this machine by its WireGuard address, so the call carries no credential.
//!   It goes through the system `curl`, as the Orbit link does.
//!
//! The title is the only thread content that leaves the server, and it is never logged.

use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use conn_engine::{BoxFuture, SqliteEngine, TurnObserver, TurnPoint};
use serde_json::{Value, json};

/// The variable that names the Gateway and turns the push on.
pub const GATEWAY_VAR: &str = "ORBIT_GATEWAY_URL";
/// How long curl may take. The Gateway answers in milliseconds; a slow one is not worth waiting for.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// A host thread the Gateway should hear of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewThread {
    pub environment_id: String,
    pub thread_id: String,
    pub title: String,
}

/// Where the call goes. Tests use an in-memory sender.
pub trait ThreadSender: Send + Sync {
    fn record(&self, thread: NewThread) -> BoxFuture<'static, Result<(), String>>;
}

/// The Gateway through the system curl.
#[derive(Debug)]
pub struct CurlSender {
    base: String,
}

impl CurlSender {
    pub fn new(gateway_url: &str) -> Self {
        Self {
            base: gateway_url.trim_end_matches('/').to_owned(),
        }
    }
}

impl ThreadSender for CurlSender {
    fn record(&self, thread: NewThread) -> BoxFuture<'static, Result<(), String>> {
        let (url, body) = request(&self.base, &thread);
        Box::pin(async move {
            let (status, _) = tokio::task::spawn_blocking(move || {
                crate::orbit_link::curl_json("POST", &url, &body, SEND_TIMEOUT)
            })
            .await
            .map_err(|error| error.to_string())??;
            if (200..300).contains(&status) {
                Ok(())
            } else {
                Err(format!("the Gateway answered {status}"))
            }
        })
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

/// The Gateway address `ORBIT_GATEWAY_URL` holds, if it is an http(s) URL.
pub fn gateway_url(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (value.starts_with("https://") || value.starts_with("http://")).then(|| value.to_owned())
}

/// The sender for this process's environment, or `None` when the push is off.
pub fn sender_from_env() -> Option<Arc<dyn ThreadSender>> {
    let value = std::env::var(GATEWAY_VAR).ok();
    let url = gateway_url(value.as_deref());
    if url.is_none() && value.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        eprintln!("conn-server: {GATEWAY_VAR} is not an http(s) URL; the thread push stays off");
    }
    url.map(|url| Arc::new(CurlSender::new(&url)) as Arc<dyn ThreadSender>)
}

/// The title to announce for the thread this shell row describes, or `None` when the thread is
/// not one the Gateway should file: a subagent, a delegated task, a side chat, an archived
/// thread, or one without a title (the Gateway refuses an empty one).
fn title_to_announce(shell: &Value) -> Option<String> {
    if !conn_engine::listed_host_thread(shell) {
        return None;
    }
    let title = shell["title"].as_str()?.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

/// A turn observer that announces each thread's first turn, then hands every turn to `inner`.
pub struct ThreadPush {
    inner: Arc<dyn TurnObserver>,
    sender: Arc<dyn ThreadSender>,
    environment_id: String,
    /// Set once the engine exists; it needs this observer. Weak: the engine owns the observer.
    engine: OnceLock<Weak<SqliteEngine>>,
}

impl std::fmt::Debug for ThreadPush {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThreadPush")
            .field("environment_id", &self.environment_id)
            .finish_non_exhaustive()
    }
}

impl ThreadPush {
    pub fn new(
        inner: Arc<dyn TurnObserver>,
        sender: Arc<dyn ThreadSender>,
        environment_id: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner,
            sender,
            environment_id,
            engine: OnceLock::new(),
        })
    }

    /// Gives the observer the engine whose shell rows it reads. Before this, it announces nothing.
    pub fn attach(&self, engine: &Arc<SqliteEngine>) {
        let _ = self.engine.set(Arc::downgrade(engine));
    }

    /// Starts the call on its own task; the turn does not wait for it.
    fn announce(&self, thread_id: String) {
        let Some(engine) = self.engine.get().and_then(Weak::upgrade) else {
            return;
        };
        let sender = self.sender.clone();
        let environment_id = self.environment_id.clone();
        tokio::spawn(async move {
            let shell = match engine.thread_shell(thread_id.clone()).await {
                Ok(Some(shell)) => shell,
                Ok(None) => return,
                Err(error) => {
                    eprintln!("conn-server: thread push: cannot read thread {thread_id}: {error}");
                    return;
                }
            };
            let Some(title) = title_to_announce(&shell) else {
                return;
            };
            let call = sender.record(NewThread {
                environment_id,
                thread_id: thread_id.clone(),
                title,
            });
            // The sender has its own limit; this one keeps a stuck sender from living on.
            match tokio::time::timeout(SEND_TIMEOUT + Duration::from_secs(1), call).await {
                Ok(Ok(())) => {}
                Ok(Err(reason)) => eprintln!(
                    "conn-server: thread push: the Orbit Gateway was not told of thread {thread_id}: {reason}"
                ),
                Err(_) => eprintln!(
                    "conn-server: thread push: the Orbit Gateway was not told of thread {thread_id}: timed out"
                ),
            }
        });
    }
}

impl TurnObserver for ThreadPush {
    fn turn_started(&self, point: TurnPoint) -> BoxFuture<'_, ()> {
        if point.run_ordinal == 1 {
            self.announce(point.thread_id.clone());
        }
        self.inner.turn_started(point)
    }

    fn turn_ended(&self, point: TurnPoint, status: String) -> BoxFuture<'_, ()> {
        self.inner.turn_ended(point, status)
    }
}

#[cfg(test)]
#[path = "thread_push_tests.rs"]
mod tests;
