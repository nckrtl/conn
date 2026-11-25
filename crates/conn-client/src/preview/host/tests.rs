//! Ports of T3's `desktopTabRelay.test.ts`, against a fake server and a fake page.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

use conn_contract::{
    PreviewAutomationStreamEventConnected, PreviewAutomationStreamEventRequest, PreviewNavStatus,
    PreviewNavStatusIdle, PreviewViewportSettingFill, lit,
};
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use super::*;

fn snapshot(runtime: Option<PreviewOpenInputRuntime>) -> PreviewSessionSnapshot {
    PreviewSessionSnapshot {
        thread_id: "thread".to_owned(),
        tab_id: "tab".to_owned(),
        nav_status: PreviewNavStatus::Idle(PreviewNavStatusIdle { tag: lit::Idle }),
        can_go_back: false,
        can_go_forward: false,
        viewport: Some(PreviewViewportSetting::Fill(PreviewViewportSettingFill {
            tag: lit::Fill,
        })),
        color_scheme: None,
        zoom_factor: None,
        profile_id: None,
        runtime,
        host: None,
        hosted_here: None,
        headless: None,
        automation_owner: None,
        reveal: None,
        reveal_request: None,
        updated_at: "2026-11-25T00:00:00Z".to_owned(),
    }
}

fn request(
    connection_id: &str,
    operation: PreviewAutomationOperation,
) -> PreviewAutomationStreamEvent {
    PreviewAutomationStreamEvent::Request(PreviewAutomationStreamEventRequest {
        r#type: lit::Request,
        connection_id: connection_id.to_owned(),
        request: PreviewAutomationRequest {
            request_id: format!("{operation:?}"),
            thread_id: "thread".to_owned(),
            tab_id: Some("tab".to_owned()),
            tab_id_explicit: None,
            agent_session_id: None,
            operation,
            input: json!({}),
            timeout_ms: 1000,
        },
    })
}

struct FakeStream {
    rx: mpsc::UnboundedReceiver<PreviewAutomationStreamEvent>,
    dropped: Arc<AtomicBool>,
    changed: Arc<Notify>,
}

impl Drop for FakeStream {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
}

impl DesktopRequests for FakeStream {
    fn next(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<PreviewAutomationStreamEvent>> + Send + '_>> {
        Box::pin(self.rx.recv())
    }
}

#[derive(Default)]
struct FakeApi {
    registrations: AtomicUsize,
    /// Register outcomes to use before succeeding: `true` fails.
    failures: Mutex<VecDeque<bool>>,
    streams: Mutex<
        Vec<(
            String,
            mpsc::UnboundedSender<PreviewAutomationStreamEvent>,
            Arc<AtomicBool>,
        )>,
    >,
    commands: Mutex<Vec<&'static str>>,
    responses: Mutex<Vec<PreviewAutomationResponse>>,
    changed: Arc<Notify>,
}

impl FakeApi {
    fn send(&self, connection: &str, event: PreviewAutomationStreamEvent) {
        let streams = self.streams.lock().unwrap();
        let (_, tx, _) = streams
            .iter()
            .find(|(id, _, _)| id == connection)
            .expect("stream exists");
        tx.send(event).expect("stream open");
    }
    fn dropped(&self, connection: &str) -> bool {
        self.streams
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _, _)| id == connection)
            .is_some_and(|(_, _, dropped)| dropped.load(Ordering::SeqCst))
    }
    fn end_stream(&self, connection: &str) {
        // Dropping the sender ends the stream.
        self.streams
            .lock()
            .unwrap()
            .retain(|(id, _, _)| id != connection);
    }
    fn responses(&self) -> Vec<(String, String)> {
        self.responses
            .lock()
            .unwrap()
            .iter()
            .map(|r| (r.connection_id.clone(), r.request_id.clone()))
            .collect()
    }
    async fn until(&self, ready: impl Fn(&Self) -> bool) {
        loop {
            let notified = self.changed.notified();
            if ready(self) {
                return;
            }
            notified.await;
        }
    }
}

fn done<T: Send + 'static>(value: Result<T, ClientError>) -> ApiFuture<T> {
    Box::pin(std::future::ready(value))
}

impl PreviewApi for FakeApi {
    fn open(&self, _: PreviewOpenInput) -> ApiFuture<PreviewSessionSnapshot> {
        done(Ok(snapshot(None)))
    }
    fn close(&self, _: PreviewCloseInput) -> ApiFuture<()> {
        done(Ok(()))
    }
    fn report_status(&self, _: PreviewReportStatusInput) -> ApiFuture<()> {
        done(Ok(()))
    }
    fn list(&self, _: String) -> ApiFuture<PreviewListResult> {
        done(Ok(PreviewListResult {
            sessions: vec![],
            server_epoch: "epoch".to_owned(),
            revision: 0,
        }))
    }
    fn register(&self, _: DesktopTabBinding) -> ApiFuture<DesktopTabConnection> {
        let failed = self.failures.lock().unwrap().pop_front().unwrap_or(false);
        if failed {
            self.changed.notify_waiters();
            return done(Err(ClientError::Closed));
        }
        let number = self.registrations.fetch_add(1, Ordering::SeqCst) + 1;
        self.changed.notify_waiters();
        done(Ok(DesktopTabConnection {
            connection_id: format!("connection-{number}"),
        }))
    }
    fn requests(&self, connection_id: &str) -> Box<dyn DesktopRequests> {
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(PreviewAutomationStreamEvent::Connected(
            PreviewAutomationStreamEventConnected {
                r#type: lit::Connected,
                connection_id: connection_id.to_owned(),
            },
        ));
        let dropped = Arc::new(AtomicBool::new(false));
        self.streams
            .lock()
            .unwrap()
            .push((connection_id.to_owned(), tx, dropped.clone()));
        self.changed.notify_waiters();
        Box::new(FakeStream {
            rx,
            dropped,
            changed: self.changed.clone(),
        })
    }
    fn respond(&self, response: PreviewAutomationResponse) -> ApiFuture<()> {
        self.commands.lock().unwrap().push("respond");
        self.responses.lock().unwrap().push(response);
        self.changed.notify_waiters();
        done(Ok(()))
    }
    fn resize(&self, _: PreviewResizeInput) -> ApiFuture<PreviewSessionSnapshot> {
        self.commands.lock().unwrap().push("resize");
        done(Ok(snapshot(None)))
    }
    fn adjust(&self, _: PreviewAdjustInput) -> ApiFuture<PreviewSessionSnapshot> {
        self.commands.lock().unwrap().push("adjust");
        done(Ok(snapshot(None)))
    }
}

type ExecuteFn = dyn Fn(
        String,
        PreviewAutomationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<PreviewAutomationResponse, String>> + Send>>
    + Send
    + Sync;

struct FakeExecutor {
    connects: Mutex<Vec<String>>,
    disconnects: AtomicUsize,
    execute: Box<ExecuteFn>,
    changed: Notify,
}

impl FakeExecutor {
    fn new(execute: Box<ExecuteFn>) -> Arc<Self> {
        Arc::new(Self {
            connects: Mutex::default(),
            disconnects: AtomicUsize::new(0),
            execute,
            changed: Notify::new(),
        })
    }
    fn ok(
        connection_id: &str,
        request: &PreviewAutomationRequest,
        result: Value,
    ) -> PreviewAutomationResponse {
        PreviewAutomationResponse {
            client_id: "desktop".to_owned(),
            connection_id: connection_id.to_owned(),
            request_id: request.request_id.clone(),
            ok: true,
            result: Some(Some(result)),
            error: None,
        }
    }
    async fn until_connects(&self, count: usize) {
        loop {
            let notified = self.changed.notified();
            if self.connects.lock().unwrap().len() >= count {
                return;
            }
            notified.await;
        }
    }
}

impl DesktopTabExecutor for FakeExecutor {
    fn disconnect(&self) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        self.disconnects.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {})
    }
    fn connect(
        &self,
        _: DesktopTabBinding,
        connection_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>> {
        self.connects.lock().unwrap().push(connection_id);
        self.changed.notify_waiters();
        Box::pin(async { Ok(()) })
    }
    fn execute(
        &self,
        connection_id: String,
        request: PreviewAutomationRequest,
    ) -> Pin<Box<dyn Future<Output = Result<PreviewAutomationResponse, String>> + Send + 'static>>
    {
        (self.execute)(connection_id, request)
    }
}

struct FakeState {
    snapshot: Mutex<Option<PreviewSessionSnapshot>>,
    applied: Mutex<Vec<PreviewSessionSnapshot>>,
}

impl FakeState {
    fn new(snapshot: Option<PreviewSessionSnapshot>) -> Arc<Self> {
        Arc::new(Self {
            snapshot: Mutex::new(snapshot),
            applied: Mutex::default(),
        })
    }
}

impl HostedTabState for FakeState {
    fn snapshot(&self) -> Option<PreviewSessionSnapshot> {
        self.snapshot.lock().unwrap().clone()
    }
    fn apply_snapshot(&self, snapshot: PreviewSessionSnapshot) {
        self.applied.lock().unwrap().push(snapshot);
    }
    fn device_name(&self) -> String {
        "Test Mac".to_owned()
    }
}

fn target() -> HostedTarget {
    HostedTarget {
        environment_id: "environment".to_owned(),
        thread_id: "thread".to_owned(),
        tab_id: "tab".to_owned(),
    }
}

fn start(
    api: &Arc<FakeApi>,
    executor: &Arc<FakeExecutor>,
    state: &Arc<FakeState>,
    connected: bool,
) -> (DesktopTabHost, watch::Sender<bool>) {
    let (tx, rx) = watch::channel(connected);
    let host = DesktopTabHost::start(
        &tokio::runtime::Handle::current(),
        api.clone(),
        executor.clone(),
        state.clone(),
        target(),
        rx,
        HostOptions::default(),
    );
    (host, tx)
}

#[tokio::test(start_paused = true)]
async fn reads_status_during_an_action_and_never_forwards_a_retired_reply() {
    let api = Arc::new(FakeApi::default());
    let navigation = Arc::new(Notify::new());
    let release = navigation.clone();
    let executor = FakeExecutor::new(Box::new(move |connection, request| {
        let release = release.clone();
        Box::pin(async move {
            if request.operation == PreviewAutomationOperation::Navigate {
                release.notified().await;
            }
            Ok(FakeExecutor::ok(&connection, &request, json!({})))
        })
    }));
    let state = FakeState::new(Some(snapshot(Some(PreviewOpenInputRuntime::Desktop))));
    let (_host, connected) = start(&api, &executor, &state, true);

    executor.until_connects(1).await;
    api.send(
        "connection-1",
        request("connection-1", PreviewAutomationOperation::Navigate),
    );
    api.send(
        "connection-1",
        request("connection-1", PreviewAutomationOperation::Status),
    );
    api.until(|api| !api.responses().is_empty()).await;
    assert_eq!(
        api.responses(),
        [("connection-1".to_owned(), "Status".to_owned())],
        "status answers while navigate still runs"
    );

    connected.send(false).unwrap();
    connected.send(true).unwrap();
    executor.until_connects(2).await;
    assert_eq!(executor.connects.lock().unwrap()[1], "connection-2");
    api.until(|api| api.dropped("connection-1")).await;

    navigation.notify_waiters();
    api.send(
        "connection-2",
        request("connection-2", PreviewAutomationOperation::Snapshot),
    );
    api.until(|api| api.responses().len() == 2).await;
    assert_eq!(
        api.responses(),
        [
            ("connection-1".to_owned(), "Status".to_owned()),
            ("connection-2".to_owned(), "Snapshot".to_owned()),
        ],
        "the retired navigate reply is dropped"
    );
}

#[tokio::test(start_paused = true)]
async fn retries_a_failed_registration_without_another_user_action() {
    let api = Arc::new(FakeApi::default());
    api.failures.lock().unwrap().push_back(true);
    let executor = FakeExecutor::new(Box::new(|connection, request| {
        Box::pin(async move { Ok(FakeExecutor::ok(&connection, &request, json!({}))) })
    }));
    let state = FakeState::new(Some(snapshot(None)));
    let (_host, _connected) = start(&api, &executor, &state, true);

    api.until(|api| api.failures.lock().unwrap().is_empty())
        .await;
    tokio::time::advance(Duration::from_millis(999)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        api.registrations.load(Ordering::SeqCst),
        0,
        "waits the full second"
    );
    tokio::time::advance(Duration::from_millis(2)).await;
    executor.until_connects(1).await;
    assert_eq!(executor.connects.lock().unwrap()[0], "connection-1");
}

#[tokio::test(start_paused = true)]
async fn publishes_viewport_and_appearance_and_rehosts_on_request() {
    let api = Arc::new(FakeApi::default());
    let executor = FakeExecutor::new(Box::new(|connection, request| {
        Box::pin(async move {
            let result = if request.operation == PreviewAutomationOperation::Resize {
                json!({"tabId":"tab","setting":{"_tag":"freeform","width":500,"height":700},"viewport":{"width":500,"height":700}})
            } else {
                json!({"tabId":"tab","colorScheme":"dark"})
            };
            Ok(FakeExecutor::ok(&connection, &request, result))
        })
    }));
    let state = FakeState::new(Some(snapshot(None)));
    let (host, _connected) = start(&api, &executor, &state, true);

    executor.until_connects(1).await;
    for (index, operation) in [
        PreviewAutomationOperation::Resize,
        PreviewAutomationOperation::SetColorScheme,
    ]
    .into_iter()
    .enumerate()
    {
        api.send("connection-1", request("connection-1", operation));
        api.until(|api| api.responses().len() == index + 1).await;
    }
    assert_eq!(
        *api.commands.lock().unwrap(),
        ["resize", "respond", "adjust", "respond"],
        "each choice is published before its answer"
    );
    assert_eq!(state.applied.lock().unwrap().len(), 2);

    host.rehost();
    executor.until_connects(2).await;
    assert_eq!(executor.connects.lock().unwrap()[1], "connection-2");
    api.until(|api| api.dropped("connection-1")).await;
}

#[tokio::test(start_paused = true)]
async fn registers_again_after_the_stream_ends_while_connected() {
    let api = Arc::new(FakeApi::default());
    let executor = FakeExecutor::new(Box::new(|connection, request| {
        Box::pin(async move { Ok(FakeExecutor::ok(&connection, &request, json!({}))) })
    }));
    let state = FakeState::new(Some(snapshot(None)));
    let (_host, _connected) = start(&api, &executor, &state, true);

    executor.until_connects(1).await;
    // The broker ends only this stream; the connection stays healthy.
    api.end_stream("connection-1");
    tokio::time::advance(Duration::from_millis(1001)).await;
    executor.until_connects(2).await;
    assert_eq!(executor.connects.lock().unwrap()[1], "connection-2");
}

#[tokio::test(start_paused = true)]
async fn answers_a_failed_execution_as_unavailable() {
    let api = Arc::new(FakeApi::default());
    let executor = FakeExecutor::new(Box::new(|_, _| Box::pin(async { Err("gone".to_owned()) })));
    let state = FakeState::new(Some(snapshot(None)));
    let (_host, _connected) = start(&api, &executor, &state, true);

    executor.until_connects(1).await;
    api.send(
        "connection-1",
        request("connection-1", PreviewAutomationOperation::Status),
    );
    api.until(|api| !api.responses().is_empty()).await;
    let responses = api.responses.lock().unwrap();
    let error = responses[0].error.as_ref().expect("an error answer");
    assert!(!responses[0].ok);
    assert_eq!(error.tag, "PreviewAutomationExecutionError");
    assert_eq!(error.message, UNAVAILABLE_MESSAGE);
}

#[tokio::test(start_paused = true)]
async fn hosts_nothing_for_a_server_tab_or_a_tab_without_a_snapshot() {
    let api = Arc::new(FakeApi::default());
    let executor = FakeExecutor::new(Box::new(|connection, request| {
        Box::pin(async move { Ok(FakeExecutor::ok(&connection, &request, json!({}))) })
    }));
    for state in [
        FakeState::new(None),
        FakeState::new(Some(snapshot(Some(PreviewOpenInputRuntime::Server)))),
    ] {
        let (_host, _connected) = start(&api, &executor, &state, true);
        tokio::time::advance(Duration::from_secs(5)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(api.registrations.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn dropping_the_host_releases_the_registration_and_the_page() {
    let api = Arc::new(FakeApi::default());
    let executor = FakeExecutor::new(Box::new(|connection, request| {
        Box::pin(async move { Ok(FakeExecutor::ok(&connection, &request, json!({}))) })
    }));
    let state = FakeState::new(Some(snapshot(None)));
    let (host, _connected) = start(&api, &executor, &state, true);

    executor.until_connects(1).await;
    let before = executor.disconnects.load(Ordering::SeqCst);
    drop(host);
    api.until(|api| api.dropped("connection-1")).await;
    tokio::task::yield_now().await;
    assert!(
        executor.disconnects.load(Ordering::SeqCst) > before,
        "the page is released too"
    );
    tokio::time::advance(Duration::from_secs(5)).await;
    assert_eq!(
        api.registrations.load(Ordering::SeqCst),
        1,
        "no registration after drop"
    );
}
