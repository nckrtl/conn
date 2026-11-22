//! [`ConnCore`] lifecycle, event pump, and [`CoreListener`] foreign callback trait.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use conn_client::{ClientEvent, Connection, ServerConfig};
use conn_contract::OrchestrationV2ThreadStreamItem;
use conn_state::{ShellState, ThreadState};
use tokio::sync::mpsc;
use tracing::warn;

use crate::coalesce::SnapshotCoalescer;
use crate::types::{
    FfiConnectionStatus, FfiCredential, FfiError, FfiShellSnapshot, FfiThreadSnapshot,
    build_shell_snapshot, build_thread_snapshot,
};

const TAG_SUBSCRIBE_SHELL: &str = "orchestration.subscribeShell";
const TAG_SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";
/// Maximum time `Drop` waits for worker threads to wind down when dropped off-runtime.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(250);

/// Foreign callback listener implemented in Swift to receive state updates from [`ConnCore`].
///
/// Every method is called with no internal locks held. Shell and thread snapshot callbacks are
/// coalesced to at most one call per 50 ms window per channel, always flushing the latest state.
#[uniffi::export(with_foreign)]
pub trait CoreListener: Send + Sync {
    fn on_status(&self, status: FfiConnectionStatus);
    fn on_bearer_issued(&self, token: String);
    fn on_shell(&self, snapshot: FfiShellSnapshot);
    fn on_thread(&self, snapshot: FfiThreadSnapshot);
    fn on_error(&self, message: String);
}

enum PumpControl {
    OpenThread(String),
    CloseThread(String),
    Shutdown,
}

/// UniFFI handle to a running `conn-server` connection, state reducer, and Tokio runtime.
#[derive(uniffi::Object)]
pub struct ConnCore {
    runtime: Option<tokio::runtime::Runtime>,
    runtime_handle: tokio::runtime::Handle,
    connection: Connection,
    ctrl_tx: mpsc::UnboundedSender<PumpControl>,
    /// Tracks whether each known thread currently has an active run, so [`Self::send_message`]
    /// chooses `start_immediately` vs `queue_after_active` without blocking the pump task.
    thread_working: Arc<RwLock<HashMap<String, bool>>>,
    disconnected: AtomicBool,
}

impl fmt::Debug for ConnCore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnCore")
            .field("connection", &self.connection)
            .field("disconnected", &self.disconnected.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Drop for ConnCore {
    fn drop(&mut self) {
        self.disconnect();
        if let Some(runtime) = self.runtime.take() {
            if tokio::runtime::Handle::try_current().is_ok() {
                // Dropping a Tokio Runtime inside a Tokio worker panics; shut down in background.
                runtime.shutdown_background();
            } else {
                runtime.shutdown_timeout(SHUTDOWN_TIMEOUT);
            }
        }
    }
}

impl ConnCore {
    fn is_thread_working(&self, thread_id: &str) -> bool {
        self.thread_working
            .read()
            .ok()
            .and_then(|map| map.get(thread_id).copied())
            .unwrap_or(false)
    }
}

#[uniffi::export]
impl ConnCore {
    /// Connects to `server_url` with `credential`, subscribes to `orchestration.subscribeShell`,
    /// and starts pumping state snapshots to `listener`.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::InvalidUrl`] if `server_url` is not a valid `http` or `https` URL,
    /// or [`FfiError::Connection`] if the background Tokio runtime cannot be created.
    #[uniffi::constructor]
    pub fn connect(
        server_url: String,
        credential: FfiCredential,
        listener: Arc<dyn CoreListener>,
    ) -> Result<Arc<Self>, FfiError> {
        let http_base_url = parse_server_url(&server_url)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("conn-ffi")
            .enable_all()
            .build()
            .map_err(|err| FfiError::Connection {
                message: format!("failed to build tokio runtime: {err}"),
            })?;

        let runtime_handle = runtime.handle().clone();
        let config = ServerConfig {
            http_base_url,
            credential: credential.into(),
        };
        let (connection, events_rx) = Connection::start(config, &runtime_handle);
        connection.subscribe_shell();

        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
        let thread_working = Arc::new(RwLock::new(HashMap::new()));

        runtime_handle.spawn(run_pump(
            connection.clone(),
            events_rx,
            ctrl_rx,
            listener,
            Arc::clone(&thread_working),
        ));

        Ok(Arc::new(Self {
            runtime: Some(runtime),
            runtime_handle,
            connection,
            ctrl_tx,
            thread_working,
            disconnected: AtomicBool::new(false),
        }))
    }

    /// Loads and subscribes to `thread_id`, emitting snapshots to [`CoreListener::on_thread`].
    pub fn open_thread(&self, thread_id: String) {
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        let _ = self.ctrl_tx.send(PumpControl::OpenThread(thread_id));
    }

    /// Unsubscribes from `thread_id` while retaining its cached timeline for fast re-open.
    pub fn close_thread(&self, thread_id: String) {
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        let _ = self.ctrl_tx.send(PumpControl::CloseThread(thread_id));
    }

    /// Dispatches a user message to `thread_id` via `orchestration.dispatchCommand`.
    ///
    /// Executes on this [`ConnCore`]'s owned Tokio runtime so foreign async callers (such as
    /// Swift concurrency) do not need an ambient Tokio executor.
    ///
    /// # Errors
    ///
    /// Returns [`FfiError::Closed`] if disconnected, or the mapped transport/RPC [`FfiError`].
    pub async fn send_message(&self, thread_id: String, text: String) -> Result<(), FfiError> {
        if self.disconnected.load(Ordering::Acquire) {
            return Err(FfiError::Closed);
        }
        let working = self.is_thread_working(&thread_id);
        let command = conn_client::commands::send_message(&thread_id, &text, &[], working, None)
            .map_err(|err| FfiError::Rpc {
                message: format!("failed to build message.dispatch command: {err}"),
            })?;
        let connection = self.connection.clone();
        self.runtime_handle
            .spawn(async move { connection.dispatch_command(command).await })
            .await
            .map_err(|_| FfiError::Closed)?
            .map(|_| ())
            .map_err(FfiError::from)
    }

    /// Drops the active socket or reconnect backoff and reconnects immediately (e.g. when the
    /// iOS app returns to the foreground).
    pub fn reconnect(&self) {
        if self.disconnected.load(Ordering::Acquire) {
            return;
        }
        self.connection.reconnect();
    }

    /// Closes the connection and stops the background event pump. Safe to call more than once.
    pub fn disconnect(&self) {
        if self.disconnected.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.ctrl_tx.send(PumpControl::Shutdown);
        self.connection.close();
    }
}

fn parse_server_url(raw: &str) -> Result<url::Url, FfiError> {
    let url = url::Url::parse(raw.trim()).map_err(|err| FfiError::InvalidUrl {
        message: err.to_string(),
    })?;
    match url.scheme() {
        "http" | "https" if url.has_host() => Ok(url),
        _ => Err(FfiError::InvalidUrl {
            message: format!("expected http:// or https:// URL with host, got `{raw}`"),
        }),
    }
}

struct PumpState {
    connection: Connection,
    listener: Arc<dyn CoreListener>,
    shell: ShellState,
    threads: HashMap<String, ThreadState>,
    open_threads: HashSet<String>,
    ended_threads: HashSet<String>,
    shell_snapshot_required: bool,
    coalescer: SnapshotCoalescer,
    thread_working: Arc<RwLock<HashMap<String, bool>>>,
}

impl PumpState {
    fn handle_control(&mut self, ctrl: PumpControl) -> bool {
        match ctrl {
            PumpControl::OpenThread(thread_id) => {
                let is_newly_opened = self.open_threads.insert(thread_id.clone());
                self.ended_threads.remove(&thread_id);
                let cached_snapshot = self
                    .threads
                    .get(&thread_id)
                    .filter(|state| state.synchronized || !state.entries.is_empty())
                    .map(build_thread_snapshot);
                self.threads
                    .entry(thread_id.clone())
                    .or_insert_with(|| ThreadState::new(thread_id.clone()));
                if is_newly_opened {
                    self.connection.subscribe_thread(&thread_id);
                }
                if let Some(snapshot) = cached_snapshot {
                    self.emit_or_buffer_thread(snapshot);
                }
                true
            }
            PumpControl::CloseThread(thread_id) => {
                let was_open = self.open_threads.remove(&thread_id);
                self.ended_threads.remove(&thread_id);
                self.coalescer.cancel_thread(&thread_id);
                if was_open {
                    self.connection.unsubscribe_thread(&thread_id);
                }
                true
            }
            PumpControl::Shutdown => false,
        }
    }

    fn handle_event(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Status(status) => {
                self.listener.on_status(status.into());
            }
            ClientEvent::BearerIssued(token) => {
                self.listener.on_bearer_issued(token);
            }
            ClientEvent::Shell(item) => {
                let change = self.shell.apply(item);
                if !change.threads_changed.is_empty() {
                    self.resubscribe_ended_threads();
                }
                if change.snapshot_required {
                    self.shell_snapshot_required = true;
                    self.connection.subscribe_shell();
                }
                let snapshot = build_shell_snapshot(&self.shell);
                self.emit_or_buffer_shell(snapshot);
            }
            ClientEvent::Thread { thread_id, item } => {
                let force_emit = matches!(
                    item,
                    OrchestrationV2ThreadStreamItem::Snapshot(_)
                        | OrchestrationV2ThreadStreamItem::Synchronized(_)
                );
                let state = self
                    .threads
                    .entry(thread_id.clone())
                    .or_insert_with(|| ThreadState::new(thread_id.clone()));
                let changed = state.apply(item);
                let working = state.working;
                let snapshot = if self.open_threads.contains(&thread_id) && (changed || force_emit)
                {
                    Some(build_thread_snapshot(state))
                } else {
                    None
                };
                if let Ok(mut guard) = self.thread_working.write() {
                    guard.insert(thread_id, working);
                }
                if let Some(snapshot) = snapshot {
                    self.emit_or_buffer_thread(snapshot);
                }
            }
            ClientEvent::StreamEnded { tag, key, error } => {
                if let Some(ref err) = error {
                    warn!("conn-ffi stream ended ({tag}, key={key}): {err}");
                    self.listener.on_error(err.clone());
                }
                if tag == TAG_SUBSCRIBE_SHELL {
                    if self.shell_snapshot_required || error.is_none() {
                        self.shell_snapshot_required = false;
                        self.connection.subscribe_shell();
                    }
                } else if tag == TAG_SUBSCRIBE_THREAD && self.open_threads.contains(&key) {
                    self.ended_threads.insert(key);
                    if error.is_none() {
                        self.resubscribe_ended_threads();
                    }
                }
            }
            ClientEvent::PanelRequest(_) | ClientEvent::Annotations { .. } => {}
        }
    }

    fn resubscribe_ended_threads(&mut self) {
        let ready: Vec<String> = self
            .ended_threads
            .iter()
            .filter(|id| self.open_threads.contains(*id) && self.shell.find_thread(id).is_some())
            .cloned()
            .collect();
        for id in ready {
            self.ended_threads.remove(&id);
            self.connection.subscribe_thread(&id);
        }
    }

    fn emit_or_buffer_shell(&mut self, snapshot: FfiShellSnapshot) {
        if let Some(ready) = self.coalescer.push_shell(snapshot, Instant::now()) {
            self.listener.on_shell(ready);
        }
    }

    fn emit_or_buffer_thread(&mut self, snapshot: FfiThreadSnapshot) {
        if let Some(ready) = self.coalescer.push_thread(snapshot, Instant::now()) {
            self.listener.on_thread(ready);
        }
    }

    fn flush_due(&mut self) {
        let (shell, threads) = self.coalescer.drain_due(Instant::now());
        if let Some(snapshot) = shell {
            self.listener.on_shell(snapshot);
        }
        for snapshot in threads {
            self.listener.on_thread(snapshot);
        }
    }
}

async fn run_pump(
    connection: Connection,
    mut events_rx: mpsc::Receiver<ClientEvent>,
    mut ctrl_rx: mpsc::UnboundedReceiver<PumpControl>,
    listener: Arc<dyn CoreListener>,
    thread_working: Arc<RwLock<HashMap<String, bool>>>,
) {
    let mut state = PumpState {
        connection,
        listener,
        shell: ShellState::default(),
        threads: HashMap::new(),
        open_threads: HashSet::new(),
        ended_threads: HashSet::new(),
        shell_snapshot_required: false,
        coalescer: SnapshotCoalescer::default(),
        thread_working,
    };

    loop {
        if let Some(deadline) = state.coalescer.next_deadline() {
            let sleep_until = tokio::time::Instant::from_std(deadline);
            tokio::select! {
                biased;
                maybe_ctrl = ctrl_rx.recv() => {
                    let Some(ctrl) = maybe_ctrl else { break };
                    if !state.handle_control(ctrl) {
                        break;
                    }
                }
                () = tokio::time::sleep_until(sleep_until) => {
                    state.flush_due();
                }
                maybe_event = events_rx.recv() => {
                    let Some(first) = maybe_event else { break };
                    state.handle_event(first);
                    while let Ok(more) = events_rx.try_recv() {
                        state.handle_event(more);
                    }
                    state.flush_due();
                }
            }
        } else {
            tokio::select! {
                biased;
                maybe_ctrl = ctrl_rx.recv() => {
                    let Some(ctrl) = maybe_ctrl else { break };
                    if !state.handle_control(ctrl) {
                        break;
                    }
                }
                maybe_event = events_rx.recv() => {
                    let Some(first) = maybe_event else { break };
                    state.handle_event(first);
                    while let Ok(more) = events_rx.try_recv() {
                        state.handle_event(more);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    use conn_wire::{Exit, FromClient, FromServer, encode_server_frame};
    use futures::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;
    use crate::types::FfiTimelineEntry;

    #[derive(Default)]
    struct RecordedState {
        statuses: Vec<FfiConnectionStatus>,
        bearers: Vec<String>,
        shells: Vec<FfiShellSnapshot>,
        threads: Vec<FfiThreadSnapshot>,
        errors: Vec<String>,
    }

    #[derive(Default)]
    struct RecordingListener {
        inner: Mutex<RecordedState>,
        notify: Condvar,
    }

    impl RecordingListener {
        fn wait_for<F>(&self, timeout: Duration, mut pred: F) -> bool
        where
            F: FnMut(&RecordedState) -> bool,
        {
            let deadline = Instant::now() + timeout;
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            while !pred(&guard) {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return false;
                };
                let (next, wait_res) = self
                    .notify
                    .wait_timeout(guard, remaining)
                    .expect("listener condvar not poisoned");
                guard = next;
                if wait_res.timed_out() {
                    return pred(&guard);
                }
            }
            true
        }
    }

    impl CoreListener for RecordingListener {
        fn on_status(&self, status: FfiConnectionStatus) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.statuses.push(status);
            self.notify.notify_all();
        }

        fn on_bearer_issued(&self, token: String) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.bearers.push(token);
            self.notify.notify_all();
        }

        fn on_shell(&self, snapshot: FfiShellSnapshot) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.shells.push(snapshot);
            self.notify.notify_all();
        }

        fn on_thread(&self, snapshot: FfiThreadSnapshot) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.threads.push(snapshot);
            self.notify.notify_all();
        }

        fn on_error(&self, message: String) {
            let mut guard = self.inner.lock().expect("listener mutex not poisoned");
            guard.errors.push(message);
            self.notify.notify_all();
        }
    }

    #[test]
    fn rejects_invalid_server_urls() {
        let listener = Arc::new(RecordingListener::default());
        let err = ConnCore::connect(
            "not-a-url".to_owned(),
            FfiCredential::Bearer {
                token: "tok".to_owned(),
            },
            listener.clone(),
        )
        .expect_err("invalid url must fail");
        assert!(
            matches!(err, FfiError::InvalidUrl { .. }),
            "expected InvalidUrl, got {err:?}"
        );

        let err = ConnCore::connect(
            "ftp://example.com".to_owned(),
            FfiCredential::Bearer {
                token: "tok".to_owned(),
            },
            listener,
        )
        .expect_err("non-http scheme must fail");
        assert!(
            matches!(err, FfiError::InvalidUrl { .. }),
            "expected InvalidUrl for ftp scheme, got {err:?}"
        );
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    fn end_to_end_mock_server_streams_shell_thread_and_sends_message_from_foreign_executor()
    -> Result<(), Box<dyn std::error::Error>> {
        let server_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let snapshot_raw = conn_state::testkit::synthetic_thread_snapshot_json(
            conn_state::testkit::SyntheticThread {
                turns: 1,
                commands_per_turn: 1,
                command_output_bytes: 24,
                assistant_bytes: 32,
            },
        );
        let mut snapshot_val: serde_json::Value = serde_json::from_str(&snapshot_raw)?;
        snapshot_val["projection"]["thread"]["id"] = json!("thread-1");

        let (addr, dispatched_rx) = server_rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let addr = listener.local_addr()?;
            let (dispatched_tx, dispatched_rx) = mpsc::unbounded_channel::<serde_json::Value>();
            tokio::spawn(async move {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                    return;
                };
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let Ok(frames) = conn_wire::decode_client_message(&text) else {
                        continue;
                    };
                    for frame in frames {
                        let FromClient::Request(req) = frame else {
                            continue;
                        };
                        match req.tag.as_str() {
                            "orchestration.subscribeShell" => {
                                let chunk = FromServer::Chunk {
                                    request_id: req.id,
                                    values: vec![
                                        json!({
                                            "kind": "snapshot",
                                            "snapshot": {
                                                "schemaVersion": 1,
                                                "snapshotSequence": 1,
                                                "projects": [{
                                                    "id": "p1",
                                                    "title": "Demo",
                                                    "workspaceRoot": "/tmp/demo",
                                                    "defaultModelSelection": null,
                                                    "scripts": [],
                                                    "createdAt": "2026-11-22T10:00:00Z",
                                                    "updatedAt": "2026-11-22T10:00:00Z",
                                                    "archivedAt": null
                                                }],
                                                "threads": [],
                                                "archivedThreads": []
                                            }
                                        }),
                                        json!({ "kind": "synchronized" }),
                                    ],
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&chunk).into()))
                                    .await;
                            }
                            "orchestration.subscribeThread" => {
                                let chunk = FromServer::Chunk {
                                    request_id: req.id,
                                    values: vec![
                                        snapshot_val.clone(),
                                        json!({ "kind": "synchronized" }),
                                    ],
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&chunk).into()))
                                    .await;
                            }
                            "orchestration.dispatchCommand" => {
                                let _ = dispatched_tx.send(req.payload.clone());
                                let reply = FromServer::Exit {
                                    request_id: req.id,
                                    exit: Exit::success(json!({ "ok": true })),
                                };
                                let _ = ws
                                    .send(Message::Text(encode_server_frame(&reply).into()))
                                    .await;
                            }
                            _ => {}
                        }
                    }
                }
            });
            Ok::<_, std::io::Error>((addr, dispatched_rx))
        })?;

        // Drive server_rt in a background thread so the current thread stays non-Tokio.
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let server_thread = std::thread::spawn(move || {
            server_rt.block_on(async {
                let _ = stop_rx.await;
            });
        });

        let listener = Arc::new(RecordingListener::default());
        let core = ConnCore::connect(
            format!("http://{addr}"),
            FfiCredential::Bearer {
                token: "test-bearer".to_owned(),
            },
            listener.clone(),
        )?;

        assert!(
            listener.wait_for(Duration::from_secs(5), |s| {
                s.shells
                    .last()
                    .is_some_and(|sh| sh.synchronized && sh.projects.len() == 1)
            }),
            "must receive synchronized shell snapshot"
        );

        core.open_thread("thread-1".to_owned());
        assert!(
            listener.wait_for(Duration::from_secs(5), |s| {
                s.threads
                    .last()
                    .is_some_and(|th| th.thread_id == "thread-1" && th.entries.len() == 3)
            }),
            "open_thread must emit thread snapshot with 3 entries"
        );
        {
            let guard = listener.inner.lock().expect("listener lock");
            let latest = guard.threads.last().expect("thread snapshot present");
            assert!(
                matches!(latest.entries[0], FfiTimelineEntry::User { .. }),
                "first timeline entry is User"
            );
        }

        // Await send_message from a non-Tokio executor (just like Swift concurrency via UniFFI).
        assert!(
            tokio::runtime::Handle::try_current().is_err(),
            "test thread must have no ambient Tokio runtime"
        );
        futures::executor::block_on(
            core.send_message("thread-1".to_owned(), "Hello iOS".to_owned()),
        )?;

        let mut dispatched_rx = dispatched_rx;
        let dispatched = dispatched_rx
            .try_recv()
            .expect("server must receive orchestration.dispatchCommand");
        assert_eq!(dispatched["type"], json!("message.dispatch"));
        assert_eq!(dispatched["threadId"], json!("thread-1"));
        assert_eq!(dispatched["text"], json!("Hello iOS"));

        core.close_thread("thread-1".to_owned());
        core.disconnect();
        let _ = stop_tx.send(());
        let _ = server_thread.join();
        Ok(())
    }
}
