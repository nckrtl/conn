//! Hosts one desktop browser tab for agents: a port of T3 Conn's `hostDesktopTab`
//! (`apps/web/src/rpc/desktopTabRelay.ts`).
//!
//! The host registers the tab with the server (`preview.desktopRegister`), reads the request
//! stream (`preview.desktopRequests`), runs each request on the tab through a
//! [`DesktopTabExecutor`], and answers (`preview.desktopRespond`). Each transport connection
//! gets a fresh registration: when the connection drops and returns, when the stream ends, or
//! when [`DesktopTabHost::rehost`] asks for it, the host disconnects the executor and
//! registers again. A reply that belongs to a retired registration is never forwarded.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use conn_contract::{
    DesktopTabBinding, DesktopTabConnection, PreviewAdjustInput, PreviewAutomationOperation,
    PreviewAutomationRequest, PreviewAutomationResponse, PreviewAutomationResponseError,
    PreviewAutomationStreamEvent, PreviewCloseInput, PreviewListResult, PreviewOpenInput,
    PreviewOpenInputColorScheme, PreviewOpenInputRuntime, PreviewReportStatusInput,
    PreviewResizeInput, PreviewSessionSnapshot, PreviewViewportSetting,
};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::ClientError;

/// What T3 answers when the tab cannot run a request.
pub const UNAVAILABLE_MESSAGE: &str = "Desktop tab is unavailable.";

/// How long the host waits before it registers again after a failure (T3's 1 second).
const RETRY_DELAY: Duration = Duration::from_secs(1);

/// The boxed future of one preview RPC.
pub type ApiFuture<T> = Pin<Box<dyn Future<Output = Result<T, ClientError>> + Send + 'static>>;

/// The `preview.*` calls a desktop host makes. [`crate::Connection`] implements it; tests use a
/// fake.
pub trait PreviewApi: Send + Sync + 'static {
    /// `preview.open`.
    fn open(&self, input: PreviewOpenInput) -> ApiFuture<PreviewSessionSnapshot>;
    /// `preview.close`.
    fn close(&self, input: PreviewCloseInput) -> ApiFuture<()>;
    /// `preview.reportStatus`.
    fn report_status(&self, input: PreviewReportStatusInput) -> ApiFuture<()>;
    /// `preview.list`.
    fn list(&self, thread_id: String) -> ApiFuture<PreviewListResult>;
    /// `preview.desktopRegister`.
    fn register(&self, binding: DesktopTabBinding) -> ApiFuture<DesktopTabConnection>;
    /// `preview.desktopRequests`. Dropping the result releases the registration.
    fn requests(&self, connection_id: &str) -> Box<dyn DesktopRequests>;
    /// `preview.desktopRespond`.
    fn respond(&self, response: PreviewAutomationResponse) -> ApiFuture<()>;
    /// `preview.resize`.
    fn resize(&self, input: PreviewResizeInput) -> ApiFuture<PreviewSessionSnapshot>;
    /// `preview.adjust`.
    fn adjust(&self, input: PreviewAdjustInput) -> ApiFuture<PreviewSessionSnapshot>;
}

/// The request stream of one registration.
pub trait DesktopRequests: Send {
    /// The next stream event, or `None` once the stream ended.
    fn next(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<PreviewAutomationStreamEvent>> + Send + '_>>;
}

/// What the host needs from the tab's page (T3's `previewBridge`).
pub trait DesktopTabExecutor: Send + Sync + 'static {
    /// Drops what the executor holds for the previous registration (`disconnectTabHost`).
    fn disconnect(&self) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
    /// Readies the page for the registration (`connectTabHost`).
    fn connect(
        &self,
        binding: DesktopTabBinding,
        connection_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>>;
    /// Runs one request (`executeTabRequest`). An `Err` answers the request as unavailable.
    fn execute(
        &self,
        connection_id: String,
        request: PreviewAutomationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<PreviewAutomationResponse, String>> + Send + 'static>>;
}

/// The tab's snapshot as the client holds it (T3's `readThreadPreviewState(...).sessions[tabId]`).
pub trait HostedTabState: Send + Sync + 'static {
    /// The current snapshot, or `None` while the tab has none.
    fn snapshot(&self) -> Option<PreviewSessionSnapshot>;
    /// Takes a snapshot the server returned after a viewport or appearance change
    /// (`updatePreviewServerSnapshot`).
    fn apply_snapshot(&self, snapshot: PreviewSessionSnapshot);
    /// The device name agents see for this tab.
    fn device_name(&self) -> String;
    /// A `preview.list` the host read after a registration attempt, to resolve the tab's owner.
    fn observe_list(&self, _result: PreviewListResult) {}
}

/// Timing of a [`DesktopTabHost`].
#[derive(Clone, Copy, Debug)]
pub struct HostOptions {
    /// Wait before registering again after a failure.
    pub retry_delay: Duration,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            retry_delay: RETRY_DELAY,
        }
    }
}

/// A running host. Dropping it stops the host and releases the registration.
#[derive(Debug)]
pub struct DesktopTabHost {
    closed: Arc<AtomicBool>,
    closed_tx: watch::Sender<bool>,
    rehost_tx: watch::Sender<u64>,
    task: Option<JoinHandle<()>>,
}

impl DesktopTabHost {
    /// Starts hosting `thread_id`'s tab `tab_id`. `connected` says whether the environment
    /// connection is up; the host registers while it is, and starts over on each new connection.
    #[must_use]
    pub fn start(
        runtime: &tokio::runtime::Handle,
        api: Arc<dyn PreviewApi>,
        executor: Arc<dyn DesktopTabExecutor>,
        state: Arc<dyn HostedTabState>,
        target: HostedTarget,
        connected: watch::Receiver<bool>,
        options: HostOptions,
    ) -> Self {
        let closed = Arc::new(AtomicBool::new(false));
        let (closed_tx, closed_rx) = watch::channel(false);
        let (rehost_tx, rehost_rx) = watch::channel(0_u64);
        let ctx = Ctx {
            api,
            executor,
            state,
            target,
            options,
            closed: closed.clone(),
            closed_rx,
            connected,
            rehost_rx,
            generation: Arc::new(AtomicU64::new(0)),
        };
        let task = runtime.spawn(run(ctx));
        Self {
            closed,
            closed_tx,
            rehost_tx,
            task: Some(task),
        }
    }

    /// Registers again on the same page, as T3 does when the thread's run stops: scripts that
    /// connected directly to the old registration lose access.
    pub fn rehost(&self) {
        self.rehost_tx.send_modify(|count| *count += 1);
    }
}

impl Drop for DesktopTabHost {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.closed_tx.send(true);
        // The task finishes on its own: it drops the stream and disconnects the executor.
        drop(self.task.take());
    }
}

/// The tab a host serves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedTarget {
    pub environment_id: String,
    pub thread_id: String,
    pub tab_id: String,
}

struct Ctx {
    api: Arc<dyn PreviewApi>,
    executor: Arc<dyn DesktopTabExecutor>,
    state: Arc<dyn HostedTabState>,
    target: HostedTarget,
    options: HostOptions,
    closed: Arc<AtomicBool>,
    closed_rx: watch::Receiver<bool>,
    connected: watch::Receiver<bool>,
    rehost_rx: watch::Receiver<u64>,
    generation: Arc<AtomicU64>,
}

/// Why one registration attempt ended.
enum Attempt {
    /// The host was dropped.
    Closed,
    /// The connection changed or a rehost was asked for: start over now.
    Rehost,
    /// Failed, or the stream ended while the connection stayed up: start over after a delay.
    Retry,
    /// The tab has nothing to register: wait for a change.
    Idle,
}

impl Ctx {
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn connected_now(&self) -> bool {
        *self.connected.borrow()
    }

    /// T3's `live(version)`.
    fn live(&self, version: u64) -> bool {
        !self.is_closed()
            && self.connected_now()
            && self.generation.load(Ordering::Acquire) == version
    }

    /// Resolves when something that retires the current registration happens.
    async fn interrupted(&mut self) -> Interrupt {
        tokio::select! {
            _ = self.closed_rx.changed() => Interrupt::Closed,
            changed = self.connected.changed() => {
                if changed.is_err() { Interrupt::Closed } else { Interrupt::Changed }
            }
            changed = self.rehost_rx.changed() => {
                if changed.is_err() { Interrupt::Closed } else { Interrupt::Changed }
            }
        }
    }
}

enum Interrupt {
    Closed,
    Changed,
}

async fn run(mut ctx: Ctx) {
    loop {
        if ctx.is_closed() {
            break;
        }
        // Wait for a connection.
        if !ctx.connected_now() {
            match ctx.interrupted().await {
                Interrupt::Closed => break,
                Interrupt::Changed => continue,
            }
        }
        let version = ctx.generation.fetch_add(1, Ordering::AcqRel) + 1;
        ctx.connected.borrow_and_update();
        ctx.rehost_rx.borrow_and_update();
        match attempt(&mut ctx, version).await {
            Attempt::Closed => break,
            Attempt::Rehost => {}
            Attempt::Retry => {
                if !ctx.live(version) {
                    continue;
                }
                let delay = ctx.options.retry_delay;
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    interrupt = ctx.interrupted() => {
                        if matches!(interrupt, Interrupt::Closed) {
                            break;
                        }
                    }
                }
            }
            Attempt::Idle => match ctx.interrupted().await {
                Interrupt::Closed => break,
                Interrupt::Changed => {}
            },
        }
    }
    ctx.executor.disconnect().await;
}

async fn attempt(ctx: &mut Ctx, version: u64) -> Attempt {
    ctx.executor.disconnect().await;
    if ctx.is_closed() {
        return Attempt::Closed;
    }
    if !ctx.live(version) {
        return Attempt::Rehost;
    }
    let Some(snapshot) = ctx.state.snapshot() else {
        return Attempt::Idle;
    };
    if snapshot.runtime == Some(PreviewOpenInputRuntime::Server) {
        return Attempt::Idle;
    }
    let binding = DesktopTabBinding {
        environment_id: ctx.target.environment_id.clone(),
        thread_id: ctx.target.thread_id.clone(),
        tab_id: snapshot.tab_id.clone(),
        device_name: ctx.state.device_name(),
        snapshot,
    };
    let registration = ctx.api.register(binding.clone()).await;
    // Registration can lose a race to another desktop. Resolve the owner instead of retrying a
    // local guest forever against that live host.
    if let Ok(list) = ctx.api.list(ctx.target.thread_id.clone()).await {
        ctx.state.observe_list(list);
    }
    let Ok(DesktopTabConnection { connection_id }) = registration else {
        return Attempt::Retry;
    };
    // Even if a disconnect overtook registration, subscribe and drop the stream so the server
    // releases the reservation instead of waiting for its expiry.
    let mut stream = ctx.api.requests(&connection_id);
    if !ctx.live(version) {
        return if ctx.is_closed() {
            Attempt::Closed
        } else {
            Attempt::Rehost
        };
    }
    let mut connect = ctx.executor.connect(binding, connection_id.clone());
    let mut ready = false;
    let mut queued: Vec<PreviewAutomationRequest> = Vec::new();
    loop {
        tokio::select! {
            result = &mut connect, if !ready => {
                if !ctx.live(version) {
                    return retire(ctx);
                }
                match result {
                    Ok(()) => {
                        ready = true;
                        for request in queued.drain(..) {
                            deliver(ctx, version, &connection_id, request);
                        }
                    }
                    Err(_) => return Attempt::Retry,
                }
            }
            event = stream.next() => {
                let Some(event) = event else {
                    return if ctx.live(version) { Attempt::Retry } else { retire(ctx) };
                };
                let PreviewAutomationStreamEvent::Request(event) = event else {
                    continue;
                };
                if event.connection_id != connection_id {
                    continue;
                }
                // Keep reading while an action runs: the page serializes mutations itself and
                // allows status reads during navigation.
                if ready {
                    deliver(ctx, version, &connection_id, event.request);
                } else {
                    queued.push(event.request);
                }
            }
            interrupt = ctx.interrupted() => {
                // Retire the registration before anything else can answer for it.
                ctx.generation.fetch_add(1, Ordering::AcqRel);
                return match interrupt {
                    Interrupt::Closed => Attempt::Closed,
                    Interrupt::Changed => Attempt::Rehost,
                };
            }
        }
    }
}

/// An attempt ended because the connection or the host changed under it.
fn retire(ctx: &Ctx) -> Attempt {
    if ctx.is_closed() {
        Attempt::Closed
    } else {
        Attempt::Rehost
    }
}

fn unavailable(connection_id: &str, request_id: &str) -> PreviewAutomationResponse {
    PreviewAutomationResponse {
        client_id: "desktop".to_owned(),
        connection_id: connection_id.to_owned(),
        request_id: request_id.to_owned(),
        ok: false,
        result: None,
        error: Some(PreviewAutomationResponseError {
            tag: "PreviewAutomationExecutionError".to_owned(),
            message: UNAVAILABLE_MESSAGE.to_owned(),
            detail: None,
        }),
    }
}

/// Runs one request without blocking the stream, and answers it if its registration is still
/// the live one.
fn deliver(ctx: &Ctx, version: u64, connection_id: &str, request: PreviewAutomationRequest) {
    let api = ctx.api.clone();
    let executor = ctx.executor.clone();
    let state = ctx.state.clone();
    let generation = ctx.generation.clone();
    let closed = ctx.closed.clone();
    let connected = ctx.connected.clone();
    let thread_id = ctx.target.thread_id.clone();
    let connection_id = connection_id.to_owned();
    let live = move || {
        !closed.load(Ordering::Acquire)
            && *connected.borrow()
            && generation.load(Ordering::Acquire) == version
    };
    tokio::spawn(async move {
        if !live() {
            return;
        }
        let mut response = match executor
            .execute(connection_id.clone(), request.clone())
            .await
        {
            Ok(response) => response,
            Err(_) => unavailable(&connection_id, &request.request_id),
        };
        if !live() {
            return;
        }
        if response.ok
            && let Some(Some(result)) = response.result.as_ref()
        {
            // Publish rendering choices through the same state as the panel controls. The
            // runner has already applied the operation.
            let published =
                publish_choice(&*api, &*state, &thread_id, &request, result, &live).await;
            if published.is_err() {
                response = unavailable(&connection_id, &request.request_id);
            }
        }
        if !live() {
            return;
        }
        let _ = api.respond(response).await;
    });
}

async fn publish_choice(
    api: &dyn PreviewApi,
    state: &dyn HostedTabState,
    thread_id: &str,
    request: &PreviewAutomationRequest,
    result: &serde_json::Value,
    live: &impl Fn() -> bool,
) -> Result<(), ()> {
    let Some(tab_id) = request.tab_id.clone() else {
        return Ok(());
    };
    match request.operation {
        PreviewAutomationOperation::Resize => {
            let setting = result
                .get("setting")
                .cloned()
                .and_then(|value| serde_json::from_value::<PreviewViewportSetting>(value).ok())
                .ok_or(())?;
            let resized = api
                .resize(PreviewResizeInput {
                    thread_id: thread_id.to_owned(),
                    tab_id,
                    viewport: setting,
                })
                .await
                .map_err(|_| ())?;
            if live() {
                state.apply_snapshot(resized);
            }
        }
        PreviewAutomationOperation::SetColorScheme => {
            let scheme = result
                .get("colorScheme")
                .cloned()
                .and_then(|value| serde_json::from_value::<PreviewOpenInputColorScheme>(value).ok())
                .ok_or(())?;
            let adjusted = api
                .adjust(PreviewAdjustInput {
                    thread_id: thread_id.to_owned(),
                    tab_id,
                    color_scheme: Some(scheme),
                    zoom_factor: None,
                    hard_reload: None,
                    clear: None,
                })
                .await
                .map_err(|_| ())?;
            if live() {
                state.apply_snapshot(adjusted);
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests;
