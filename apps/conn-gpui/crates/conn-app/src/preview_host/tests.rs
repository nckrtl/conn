//! The preview host against a fake server: which tabs register, and when they stop.

use std::sync::atomic::AtomicUsize;
use std::time::Instant;

use conn_client::preview::{ApiFuture, DesktopRequests};
use conn_contract::{
    DesktopTabConnection, PreviewAdjustInput, PreviewAutomationStreamEvent,
    PreviewAutomationStreamEventConnected, PreviewAutomationStreamEventRequest, PreviewListResult,
    PreviewNavStatusIdle, PreviewOpenInputRuntime, PreviewResizeInput, PreviewSessionSnapshot,
};

use super::*;

fn snapshot(thread: &str, tab: &str, host: Option<&str>) -> PreviewSessionSnapshot {
    PreviewSessionSnapshot {
        thread_id: thread.to_owned(),
        tab_id: tab.to_owned(),
        nav_status: PreviewNavStatus::Idle(PreviewNavStatusIdle { tag: lit::Idle }),
        can_go_back: false,
        can_go_forward: false,
        viewport: Some(PreviewViewportSetting::Fill(PreviewViewportSettingFill {
            tag: lit::Fill,
        })),
        color_scheme: None,
        zoom_factor: None,
        profile_id: None,
        runtime: Some(PreviewOpenInputRuntime::Desktop),
        host: host.map(str::to_owned),
        hosted_here: None,
        headless: None,
        automation_owner: None,
        reveal: None,
        reveal_request: None,
        updated_at: "2026-11-25T00:00:00Z".to_owned(),
    }
}

struct Stream {
    rx: mpsc::UnboundedReceiver<PreviewAutomationStreamEvent>,
    live: Arc<AtomicBool>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
    }
}

impl DesktopRequests for Stream {
    fn next(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<PreviewAutomationStreamEvent>> + Send + '_>> {
        Box::pin(self.rx.recv())
    }
}

/// A server that records what a host does to it.
#[derive(Default)]
pub(crate) struct FakeServer {
    opened: AtomicUsize,
    /// `(thread, server tab)` of each registration, in order.
    registered: Mutex<Vec<(String, String)>>,
    closed: Mutex<Vec<String>>,
    reports: Mutex<Vec<PreviewReportStatusInput>>,
    responses: Mutex<Vec<PreviewAutomationResponse>>,
    orphans: Mutex<Vec<PreviewSessionSnapshot>>,
    /// Open request streams: connection id, its sender, whether it still lives.
    streams: Mutex<
        Vec<(
            String,
            mpsc::UnboundedSender<PreviewAutomationStreamEvent>,
            Arc<AtomicBool>,
        )>,
    >,
}

impl FakeServer {
    pub(crate) fn live_streams(&self) -> usize {
        self.streams
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, _, live)| live.load(Ordering::SeqCst))
            .count()
    }
    pub(crate) fn registrations(&self) -> Vec<(String, String)> {
        self.registered.lock().unwrap().clone()
    }
    pub(crate) fn closed(&self) -> Vec<String> {
        self.closed.lock().unwrap().clone()
    }
}

fn done<T: Send + 'static>(value: T) -> ApiFuture<T> {
    Box::pin(std::future::ready(Ok(value)))
}

impl PreviewApi for FakeServer {
    fn open(&self, input: PreviewOpenInput) -> ApiFuture<PreviewSessionSnapshot> {
        let number = self.opened.fetch_add(1, Ordering::SeqCst) + 1;
        done(snapshot(
            &input.thread_id,
            &format!("server-tab-{number}"),
            None,
        ))
    }
    fn close(&self, input: PreviewCloseInput) -> ApiFuture<()> {
        self.closed
            .lock()
            .unwrap()
            .push(input.tab_id.unwrap_or_default());
        done(())
    }
    fn report_status(&self, input: PreviewReportStatusInput) -> ApiFuture<()> {
        self.reports.lock().unwrap().push(input);
        done(())
    }
    fn list(&self, thread_id: String) -> ApiFuture<PreviewListResult> {
        let sessions = self
            .orphans
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.thread_id == thread_id)
            .cloned()
            .collect();
        done(PreviewListResult {
            sessions,
            server_epoch: "epoch".to_owned(),
            revision: 0,
        })
    }
    fn register(&self, binding: DesktopTabBinding) -> ApiFuture<DesktopTabConnection> {
        let mut registered = self.registered.lock().unwrap();
        registered.push((binding.thread_id, binding.tab_id));
        done(DesktopTabConnection {
            connection_id: format!("connection-{}", registered.len()),
        })
    }
    fn requests(&self, connection_id: &str) -> Box<dyn DesktopRequests> {
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(PreviewAutomationStreamEvent::Connected(
            PreviewAutomationStreamEventConnected {
                r#type: lit::Connected,
                connection_id: connection_id.to_owned(),
            },
        ));
        let live = Arc::new(AtomicBool::new(true));
        self.streams
            .lock()
            .unwrap()
            .push((connection_id.to_owned(), tx, live.clone()));
        Box::new(Stream { rx, live })
    }
    fn respond(&self, response: PreviewAutomationResponse) -> ApiFuture<()> {
        self.responses.lock().unwrap().push(response);
        done(())
    }
    fn resize(&self, input: PreviewResizeInput) -> ApiFuture<PreviewSessionSnapshot> {
        done(snapshot(&input.thread_id, &input.tab_id, None))
    }
    fn adjust(&self, input: PreviewAdjustInput) -> ApiFuture<PreviewSessionSnapshot> {
        done(snapshot(&input.thread_id, &input.tab_id, None))
    }
}

struct Fixture {
    host: PreviewHost,
    server: Arc<FakeServer>,
    ui: mpsc::UnboundedReceiver<UiRequest>,
}

impl Fixture {
    fn new() -> Self {
        let (tx, ui) = mpsc::unbounded_channel();
        Self {
            host: PreviewHost::new(tokio::runtime::Handle::current(), "Test Mac".to_owned(), tx),
            server: Arc::default(),
            ui,
        }
    }

    fn env(&self, connected: bool) -> EnvConnection {
        EnvConnection {
            environment: "env".to_owned(),
            api: self.server.clone(),
            connection: None,
            connected,
        }
    }

    fn tab(thread: &str, id: BrowserTabId, url: &str) -> DesiredTab {
        DesiredTab {
            owner: PanelOwner::new("env", thread),
            id,
            url: url.to_owned(),
            title: String::new(),
        }
    }
}

/// Polls until `condition` holds; the host works on the Tokio runtime.
async fn eventually(what: &str, condition: impl Fn() -> bool) {
    let began = Instant::now();
    while !condition() {
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_tab_gets_a_record_and_registers() {
    let mut fx = Fixture::new();
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the registration", || !fx.server.registrations().is_empty()).await;
    assert_eq!(
        fx.server.registrations(),
        [("thread-a".to_owned(), "server-tab-1".to_owned())],
        "a blank tab registers under the record the server opened for it"
    );
    assert_eq!(fx.server.opened.load(Ordering::SeqCst), 1);
    assert_eq!(
        fx.host.hosted_for_test(),
        [(1, Some("server-tab-1".to_owned()))]
    );

    // The same tabs again change nothing.
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(fx.server.opened.load(Ordering::SeqCst), 1);
    assert_eq!(fx.server.registrations().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_tab_releases_its_registration_and_record() {
    let mut fx = Fixture::new();
    fx.host.sync(
        vec![fx.env(true)],
        vec![
            Fixture::tab("thread-a", 1, ""),
            Fixture::tab("thread-a", 2, ""),
        ],
    );
    eventually("both registrations", || {
        fx.server.registrations().len() == 2
    })
    .await;
    eventually("both streams", || fx.server.live_streams() == 2).await;
    // Which tab opened first is up to the runtime: read each tab's record.
    let records = fx.host.hosted_for_test();
    let record_of = |id: BrowserTabId| {
        records
            .iter()
            .find(|(tab, _)| *tab == id)
            .and_then(|(_, record)| record.clone())
            .expect("a record")
    };

    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 2, "")]);
    eventually("the close", || fx.server.closed().len() == 1).await;
    assert_eq!(fx.server.closed(), [record_of(1)]);
    eventually("the stream to end", || fx.server.live_streams() == 1).await;
    assert_eq!(fx.host.hosted_for_test(), [(2, Some(record_of(2)))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tabs_of_every_thread_stay_registered_when_the_shown_thread_changes() {
    let mut fx = Fixture::new();
    // Thread A shows with one tab, then thread B shows with another; A's tab parks.
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("A's registration", || fx.server.registrations().len() == 1).await;
    fx.host.sync(
        vec![fx.env(true)],
        vec![
            Fixture::tab("thread-a", 1, ""),
            Fixture::tab("thread-b", 2, ""),
        ],
    );
    eventually("B's registration", || fx.server.registrations().len() == 2).await;
    assert_eq!(
        fx.server.registrations(),
        [
            ("thread-a".to_owned(), "server-tab-1".to_owned()),
            ("thread-b".to_owned(), "server-tab-2".to_owned()),
        ]
    );
    assert!(fx.server.closed().is_empty(), "a parked tab stays open");
    assert_eq!(fx.server.live_streams(), 2, "and registered");

    // Thread B's panel goes (a deleted thread): only its tab leaves.
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("B's close", || fx.server.closed() == ["server-tab-2"]).await;
    assert_eq!(fx.host.hosted_for_test().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_that_becomes_a_thread_moves_its_tab_to_the_thread() {
    let mut fx = Fixture::new();
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the registration", || fx.server.registrations().len() == 1).await;
    // Same tab id, another owner: the record belongs to the thread it was opened for.
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-z", 1, "")]);
    eventually("the move", || fx.server.registrations().len() == 2).await;
    assert_eq!(fx.server.registrations()[1].0, "thread-z");
    assert_eq!(fx.server.closed(), ["server-tab-1"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_opens_while_disconnected_and_registration_follows_each_reconnect() {
    let mut fx = Fixture::new();
    fx.host
        .sync(vec![fx.env(false)], vec![Fixture::tab("thread-a", 1, "")]);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fx.server.opened.load(Ordering::SeqCst),
        0,
        "no record while offline"
    );

    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the first registration", || {
        fx.server.registrations().len() == 1
    })
    .await;

    // The connection drops and returns: the same record registers again, as a new connection.
    fx.host
        .sync(vec![fx.env(false)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the stream to end", || fx.server.live_streams() == 0).await;
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the second registration", || {
        fx.server.registrations().len() == 2
    })
    .await;
    let registrations = fx.server.registrations();
    assert_eq!(
        registrations[0], registrations[1],
        "the same tab registers again"
    );
    assert_eq!(
        fx.server.opened.load(Ordering::SeqCst),
        1,
        "the record is kept"
    );
    assert!(fx.server.closed().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_connection_to_the_server_keeps_each_tabs_record() {
    let mut fx = Fixture::new();
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the first registration", || {
        fx.server.registrations().len() == 1
    })
    .await;

    // A restarted client connection is another `api` for the same environment.
    let second = Arc::new(FakeServer::default());
    let renewed = EnvConnection {
        environment: "env".to_owned(),
        api: second.clone(),
        connection: None,
        connected: true,
    };
    fx.host
        .sync(vec![renewed], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the registration on the new link", || {
        second.registrations().len() == 1
    })
    .await;
    assert_eq!(
        second.registrations()[0],
        ("thread-a".to_owned(), "server-tab-1".to_owned()),
        "the tab registers under the record it already has"
    );
    assert_eq!(second.opened.load(Ordering::SeqCst), 0);
    assert!(fx.server.closed().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_orphaned_record_is_adopted_instead_of_opening_another() {
    let mut fx = Fixture::new();
    fx.server
        .orphans
        .lock()
        .unwrap()
        .push(snapshot("thread-a", "old-tab", None));
    // A record another desktop hosts is not an orphan.
    fx.server.orphans.lock().unwrap().push(snapshot(
        "thread-a",
        "hosted-elsewhere",
        Some("Other Mac"),
    ));
    fx.host.sync(
        vec![fx.env(true)],
        vec![
            Fixture::tab("thread-a", 1, ""),
            Fixture::tab("thread-a", 2, ""),
        ],
    );
    eventually("both registrations", || {
        fx.server.registrations().len() == 2
    })
    .await;
    let mut tabs: Vec<String> = fx
        .server
        .registrations()
        .into_iter()
        .map(|(_, t)| t)
        .collect();
    tabs.sort();
    assert_eq!(
        tabs,
        ["old-tab", "server-tab-1"],
        "one tab adopts, the other opens"
    );
    assert_eq!(fx.server.opened.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn navigation_is_reported_once_per_change() {
    let mut fx = Fixture::new();
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 1, "")]);
    eventually("the registration", || fx.server.registrations().len() == 1).await;
    let handle = fx.host.handles().get_or_create(1);

    // A blank page reports nothing, as T3's `buildReportInput` does.
    fx.host.report_status();
    assert!(fx.server.reports.lock().unwrap().is_empty());

    let facts = |loading, title: &str| PageFacts {
        url: "http://localhost:3000/".to_owned(),
        title: title.to_owned(),
        loading,
        can_go_back: true,
        can_go_forward: false,
        load_error: None,
    };
    handle.set_facts(facts(true, ""));
    fx.host.report_status();
    fx.host.report_status();
    handle.set_facts(facts(false, "Home"));
    fx.host.report_status();
    eventually("both reports", || {
        fx.server.reports.lock().unwrap().len() == 2
    })
    .await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    let reports = fx.server.reports.lock().unwrap().clone();
    assert_eq!(reports.len(), 2, "a repeated state is not reported again");
    assert!(matches!(
        reports[0].nav_status,
        PreviewNavStatus::Loading(_)
    ));
    assert!(matches!(
        reports[1].nav_status,
        PreviewNavStatus::Success(_)
    ));
    assert_eq!(reports[1].tab_id, "server-tab-1");
    assert_eq!(reports[1].thread_id, "thread-a");
    assert!(reports[1].can_go_back && !reports[1].can_go_forward);

    // A load failure reports each time.
    handle.set_facts(PageFacts {
        load_error: Some((-105, "ERR_NAME_NOT_RESOLVED".to_owned())),
        ..facts(false, "")
    });
    fx.host.report_status();
    eventually("the failure report", || {
        fx.server.reports.lock().unwrap().len() == 3
    })
    .await;
    assert!(matches!(
        fx.server.reports.lock().unwrap()[2].nav_status,
        PreviewNavStatus::LoadFailed(_)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_status_request_for_a_tab_without_a_page_answers_from_what_the_tab_holds() {
    let mut fx = Fixture::new();
    fx.host.sync(
        vec![fx.env(true)],
        vec![Fixture::tab("thread-a", 1, "http://localhost:3000/docs")],
    );
    eventually("the registration", || fx.server.registrations().len() == 1).await;
    let tx = fx.server.streams.lock().unwrap()[0].1.clone();
    tx.send(PreviewAutomationStreamEvent::Request(
        PreviewAutomationStreamEventRequest {
            r#type: lit::Request,
            connection_id: "connection-1".to_owned(),
            request: PreviewAutomationRequest {
                request_id: "preview-0".to_owned(),
                thread_id: "thread-a".to_owned(),
                tab_id: Some("server-tab-1".to_owned()),
                tab_id_explicit: None,
                agent_session_id: None,
                operation: PreviewAutomationOperation::Status,
                input: json!({}),
                timeout_ms: 1000,
            },
        },
    ))
    .unwrap();
    eventually("the answer", || {
        !fx.server.responses.lock().unwrap().is_empty()
    })
    .await;
    let response = fx.server.responses.lock().unwrap()[0].clone();
    assert!(response.ok, "{:?}", response.error);
    let result = response.result.flatten().expect("a result");
    assert_eq!(result["tabId"], "server-tab-1");
    assert_eq!(result["url"], "http://localhost:3000/docs");
    assert_eq!(result["tabs"][0]["host"], "Test Mac");
    assert_eq!(result["tabs"][0]["runtime"], "desktop");
    assert!(
        fx.ui.try_recv().is_err(),
        "a status read does not make a page for the tab"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_for_a_tab_without_a_page_asks_the_window_to_make_it() {
    let mut fx = Fixture::new();
    fx.host
        .sync(vec![fx.env(true)], vec![Fixture::tab("thread-a", 7, "")]);
    eventually("the registration", || fx.server.registrations().len() == 1).await;
    let tx = fx.server.streams.lock().unwrap()[0].1.clone();
    tx.send(PreviewAutomationStreamEvent::Request(
        PreviewAutomationStreamEventRequest {
            r#type: lit::Request,
            connection_id: "connection-1".to_owned(),
            request: PreviewAutomationRequest {
                request_id: "preview-1".to_owned(),
                thread_id: "thread-a".to_owned(),
                tab_id: Some("server-tab-1".to_owned()),
                tab_id_explicit: None,
                agent_session_id: None,
                operation: PreviewAutomationOperation::Evaluate,
                input: json!({"expression": "1+1"}),
                timeout_ms: 1000,
            },
        },
    ))
    .unwrap();
    let began = Instant::now();
    let request = loop {
        if let Ok(request) = fx.ui.try_recv() {
            break request;
        }
        assert!(began.elapsed() < Duration::from_secs(5), "no page request");
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert!(matches!(request, UiRequest::Materialize(7)));
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_everything_closes_every_record() {
    let mut fx = Fixture::new();
    fx.host.sync(
        vec![fx.env(true)],
        vec![
            Fixture::tab("thread-a", 1, ""),
            Fixture::tab("thread-b", 2, ""),
        ],
    );
    eventually("both registrations", || {
        fx.server.registrations().len() == 2
    })
    .await;
    let server = fx.server.clone();
    let mut host = fx.host;
    // `close_all` blocks for the server, so it runs off the runtime's thread.
    tokio::task::spawn_blocking(move || host.close_all())
        .await
        .unwrap();
    let mut closed = server.closed();
    closed.sort();
    assert_eq!(closed, ["server-tab-1", "server-tab-2"]);
}

#[test]
fn nav_status_follows_t3s_report_rules() {
    let facts = |url: &str, loading: bool| PageFacts {
        url: url.to_owned(),
        loading,
        ..PageFacts::default()
    };
    assert!(nav_status(&facts("", false)).is_none());
    assert!(nav_status(&facts("about:blank", false)).is_none());
    assert_eq!(nav_status(&facts("http://a/", true)).unwrap().0, "Loading");
    assert_eq!(nav_status(&facts("http://a/", false)).unwrap().0, "Success");
}
