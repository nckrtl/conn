//! End to end against a disposable `conn-server` (the `desktop_relay_e2e` example, in a temp
//! state directory): the desktop side registers a tab through the real relay host, runs agent
//! requests on a scripted page with the real `DesktopTabRunner`, and an agent calls the server's
//! preview tools over `/mcp`, as a provider would.
//!
//! Set `CONN_RELAY_E2E_BIN` to the example's binary
//! (`cargo build -p conn-server --example desktop_relay_e2e` in `apps/conn-server`); without it
//! the test does nothing, as `crates/conn-client/tests/live_server.rs` does without its binary.

#![expect(clippy::unwrap_used, clippy::expect_used, reason = "a test")]

use std::io::{BufRead, BufReader};
use std::pin::Pin;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use conn_client::preview::{
    DesktopTabExecutor, DesktopTabHost, HostOptions, HostedTabState, HostedTarget, PreviewApi,
};
use conn_client::{Connection, ConnectionStatus, Credential, ServerConfig};
use conn_contract::{
    DesktopTabBinding, PreviewAutomationRequest, PreviewAutomationResponse, PreviewOpenInput,
    PreviewSessionSnapshot, PreviewViewportSetting, PreviewViewportSettingFill, lit,
};
use conn_preview_driver::{
    Cdp, CdpFuture, DesktopTabRunner, DialogInfo, EventListener, FileChooserInfo, PageTarget,
    Subscription,
};
use serde_json::{Value, json};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A page at `http://app.test/` that answers the CDP calls the runner makes.
struct Page {
    calls: AtomicUsize,
}

impl Cdp for Page {
    fn send(&self, method: &str, params: Value) -> CdpFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let expression = params["expression"].as_str().unwrap_or_default().to_owned();
        let reply = match method {
            "Page.getFrameTree" => Ok(json!({"frameTree": {"frame": {"id": "frame"}}})),
            "Page.createIsolatedWorld" => Ok(json!({"executionContextId": 7})),
            "Page.getLayoutMetrics" => Ok(json!({
                "cssLayoutViewport": {"clientWidth": 1000, "clientHeight": 700},
                "cssVisualViewport": {"clientWidth": 1000.0, "clientHeight": 700.0},
            })),
            "Page.captureScreenshot" => Ok(json!({"data": "c2NyZWVu"})),
            "Runtime.evaluate" if params.get("contextId").is_some() => {
                Ok(json!({"result": {"value": utility_value(&expression)}}))
            }
            "Runtime.evaluate" => Ok(json!({"result": {"value": match expression.as_str() {
                "document.title" => json!("App"),
                "6*7" => json!(42),
                e if e.contains("__t3codeCredentialLocked") => json!(false),
                other => json!(format!("ran {other}")),
            }}})),
            _ => Ok(json!({})),
        };
        Box::pin(std::future::ready(reply))
    }
    fn on_event(&self, _: EventListener) -> Subscription {
        Subscription::new(|| {})
    }
}

/// What the injected engine would answer for each utility-world script the runner sends.
fn utility_value(expression: &str) -> Value {
    if expression == "!!globalThis.__connInjected" {
        json!(true)
    } else if expression.contains("__connRefGeneration") {
        json!({
            "url": "http://app.test/", "title": "App",
            "visibleText": "Hello from the desktop tab",
            "accessibilityTree": "- heading \"Hello\" [ref=t3-g-e1]",
        })
    } else {
        // The dotted-input read and the sensitive-values read: none on this page.
        json!([])
    }
}

struct Target {
    page: Arc<Page>,
}

impl PageTarget for Target {
    fn cdp(&self) -> Option<Arc<dyn Cdp>> {
        Some(self.page.clone())
    }
    fn url(&self) -> String {
        "http://app.test/".to_owned()
    }
    fn title(&self) -> String {
        "App".to_owned()
    }
    fn pending_dialog(&self) -> Option<DialogInfo> {
        None
    }
    fn handle_dialog(&self, _: bool, _: Option<&str>) -> bool {
        false
    }
    fn pending_file_chooser(&self) -> Option<FileChooserInfo> {
        None
    }
    fn resolve_file_chooser(&self, _: &[String]) -> bool {
        false
    }
    fn set_intercepting(&self, _: bool) {}
    fn on_dialog_change(&self, _: Arc<dyn Fn() + Send + Sync>) {}
}

type BoxFuture<T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'static>>;

/// The desktop side, as the app wires it: a runner per registration on the page.
struct Executor {
    target: Arc<Target>,
    runner: Mutex<Option<Arc<DesktopTabRunner>>>,
    registrations: AtomicUsize,
}

impl DesktopTabExecutor for Executor {
    fn disconnect(&self) -> BoxFuture<()> {
        if let Some(runner) = self.runner.lock().unwrap().take() {
            runner.close();
        }
        Box::pin(std::future::ready(()))
    }
    fn connect(
        &self,
        binding: DesktopTabBinding,
        connection_id: String,
    ) -> BoxFuture<Result<(), String>> {
        self.registrations.fetch_add(1, Ordering::SeqCst);
        *self.runner.lock().unwrap() = Some(DesktopTabRunner::new(
            self.target.clone(),
            binding,
            connection_id,
        ));
        Box::pin(std::future::ready(Ok(())))
    }
    fn execute(
        &self,
        connection_id: String,
        request: PreviewAutomationRequest,
    ) -> BoxFuture<Result<PreviewAutomationResponse, String>> {
        let runner = self
            .runner
            .lock()
            .unwrap()
            .clone()
            .filter(|r| r.connection_id() == connection_id);
        Box::pin(async move {
            let runner = runner.ok_or_else(|| "not registered".to_owned())?;
            Ok(runner.respond(request).await)
        })
    }
}

struct State(Mutex<Option<PreviewSessionSnapshot>>);

impl HostedTabState for State {
    fn snapshot(&self) -> Option<PreviewSessionSnapshot> {
        self.0.lock().unwrap().clone()
    }
    fn apply_snapshot(&self, snapshot: PreviewSessionSnapshot) {
        *self.0.lock().unwrap() = Some(snapshot);
    }
    fn device_name(&self) -> String {
        "Test Device".to_owned()
    }
}

/// One MCP tool call, as a provider makes it.
struct Agent {
    http: reqwest::Client,
    url: String,
    authorization: String,
    session: String,
    next: u64,
}

impl Agent {
    async fn open(url: &str, authorization: &str) -> Self {
        let http = reqwest::Client::new();
        let mut agent = Self {
            http,
            url: url.to_owned(),
            authorization: authorization.to_owned(),
            session: String::new(),
            next: 1,
        };
        let (_, headers) = agent
            .post(
                json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
                "protocolVersion":"2025-06-18","capabilities":{},
                "clientInfo":{"name":"e2e","version":"0"}}}),
            )
            .await;
        agent.session = headers.expect("a session id");
        agent
    }

    async fn post(&self, body: Value) -> (Value, Option<String>) {
        let mut request = self
            .http
            .post(&self.url)
            .header("authorization", &self.authorization)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if !self.session.is_empty() {
            request = request.header("mcp-session-id", &self.session);
        }
        let response = request
            .body(body.to_string())
            .send()
            .await
            .expect("mcp reply");
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = response.text().await.expect("mcp body");
        let json_text = text
            .lines()
            .find_map(|line| line.strip_prefix("data:"))
            .map_or(text.as_str(), str::trim);
        (
            serde_json::from_str(json_text).expect("json-rpc reply"),
            session,
        )
    }

    /// The whole `result` of a `tools/call`.
    async fn call(&mut self, tool: &str, arguments: Value) -> Value {
        self.next += 1;
        let (reply, _) = self
            .post(json!({"jsonrpc":"2.0","id":self.next,"method":"tools/call",
                "params":{"name":tool,"arguments":arguments}}))
            .await;
        reply["result"].clone()
    }
}

/// The desktop's `panels.respond`: it showed the panel.
async fn answer_panel(connection: &Connection, request_id: &str) {
    let response = conn_contract::source::DesktopPanelResponse {
        panel: conn_contract::AgentPanelResponse {
            request_id: request_id.to_owned(),
            ok: true,
            device_name: Some("Test Device".to_owned()),
            error: None,
            database: None,
            mcp: None,
            mcp_call: None,
        },
        selection: None,
    };
    connection
        .call::<_, ()>("panels.respond", &response)
        .await
        .expect("panels.respond");
}

async fn eventually<T>(what: &str, mut probe: impl AsyncFnMut() -> Option<T>) -> T {
    let began = Instant::now();
    loop {
        if let Some(value) = probe().await {
            return value;
        }
        assert!(
            began.elapsed() < Duration::from_secs(20),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
#[expect(clippy::too_many_lines, reason = "one scenario, read top to bottom")]
async fn agent_preview_calls_reach_the_desktop_tab_a_host_registered() {
    let Ok(server_bin) = std::env::var("CONN_RELAY_E2E_BIN") else {
        eprintln!("CONN_RELAY_E2E_BIN is not set: skipping the desktop relay end-to-end test");
        return;
    };
    let state_dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(&server_bin)
        .arg(state_dir.path())
        .arg(project_dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("the server starts");
    let stdout = child.stdout.take().unwrap();
    let _guard = ChildGuard(child);
    let (line_tx, line_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with('{') {
                let _ = line_tx.send(line);
                break;
            }
        }
    });
    let info: Value = serde_json::from_str(
        &line_rx
            .recv_timeout(Duration::from_secs(60))
            .expect("the server printed its details"),
    )
    .unwrap();
    let thread = info["threadId"].as_str().unwrap().to_owned();

    // The desktop's connection.
    let (connection, mut events) = Connection::start(
        ServerConfig {
            http_base_url: url::Url::parse(info["url"].as_str().unwrap()).unwrap(),
            credential: Credential::PairingCode(info["pairingCode"].as_str().unwrap().to_owned()),
        },
        &tokio::runtime::Handle::current(),
    );
    let (connected_tx, connected) = tokio::sync::watch::channel(false);
    let (panel_tx, mut panel_rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                conn_client::ClientEvent::Status(status) => {
                    connected_tx.send_replace(matches!(status, ConnectionStatus::Connected));
                }
                conn_client::ClientEvent::PanelRequest(request) => {
                    let _ = panel_tx.send(request);
                }
                _ => {}
            }
        }
    });
    let mut up = connected.clone();
    tokio::time::timeout(Duration::from_secs(30), up.wait_for(|up| *up))
        .await
        .expect("connected in time")
        .unwrap();

    // The tab's record, as the app opens it, then hosted through the real relay host.
    let api: Arc<dyn PreviewApi> = Arc::new(connection.clone());
    let record = api
        .open(PreviewOpenInput {
            thread_id: thread.clone(),
            url: None,
            viewport: Some(PreviewViewportSetting::Fill(PreviewViewportSettingFill {
                tag: lit::Fill,
            })),
            profile_id: None,
            runtime: None,
            color_scheme: None,
            zoom_factor: None,
            reveal: None,
        })
        .await
        .expect("preview.open");
    let tab = record.tab_id.clone();
    let page = Arc::new(Page {
        calls: AtomicUsize::new(0),
    });
    let executor = Arc::new(Executor {
        target: Arc::new(Target { page: page.clone() }),
        runner: Mutex::new(None),
        registrations: AtomicUsize::new(0),
    });
    let host = DesktopTabHost::start(
        &tokio::runtime::Handle::current(),
        api.clone(),
        executor.clone(),
        Arc::new(State(Mutex::new(Some(record)))),
        HostedTarget {
            environment_id: info["environmentId"].as_str().unwrap().to_owned(),
            thread_id: thread.clone(),
            tab_id: tab.clone(),
        },
        connected.clone(),
        HostOptions::default(),
    );

    // `preview.list` shows the registered tab, with its host.
    let listed = eventually("the tab to register", async || {
        let listed = api.list(thread.clone()).await.ok()?;
        listed
            .sessions
            .into_iter()
            .find(|s| s.tab_id == tab && s.host.is_some())
    })
    .await;
    assert_eq!(listed.host.as_deref(), Some("Test Device"));
    assert_eq!(listed.thread_id, thread);

    let mut agent = Agent::open(
        info["mcpUrl"].as_str().unwrap(),
        info["mcpAuthorization"].as_str().unwrap(),
    )
    .await;

    // No `tabId` anywhere below: the desktop tab is the agent's default.
    let status = agent.call("preview_status", json!({})).await;
    assert_eq!(status["isError"], false, "{status}");
    let status = &status["structuredContent"];
    assert_eq!(
        status["tabId"],
        tab.as_str(),
        "the desktop tab is the default target"
    );
    assert_eq!(status["url"], "http://app.test/");
    assert_eq!(status["title"], "App");
    assert_eq!(status["tabs"][0]["tabId"], tab.as_str());
    assert_eq!(status["tabs"][0]["runtime"], "desktop");
    assert_eq!(status["tabs"][0]["host"], "Test Device");

    let snapshot = agent.call("preview_snapshot", json!({})).await;
    assert_eq!(snapshot["isError"], false, "{snapshot}");
    assert_eq!(
        snapshot["structuredContent"]["visibleText"],
        "Hello from the desktop tab"
    );
    assert!(
        snapshot["structuredContent"]["accessibilityTree"]
            .as_str()
            .unwrap()
            .contains("heading \"Hello\"")
    );

    let evaluated = agent
        .call("preview_evaluate", json!({"expression": "6*7"}))
        .await;
    assert_eq!(evaluated["isError"], false, "{evaluated}");
    assert_eq!(evaluated["structuredContent"]["value"], 42);

    // `preview_open` shows the desktop tab instead of opening a server tab beside it.
    let opened = agent.call("preview_open", json!({})).await;
    assert_eq!(opened["isError"], false, "{opened}");
    assert_eq!(opened["structuredContent"]["tabId"], tab.as_str());

    // What the desktop cannot do answers as T3's runner does, and does not hang.
    let endpoint = agent.call("preview_cdp_endpoint", json!({})).await;
    assert_eq!(endpoint["isError"], true);
    assert!(
        endpoint["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Preview automation cdpEndpoint failed on client desktop-"),
        "{endpoint}"
    );

    // A tab no desktop hosts is a server tab: it stays on the server, away from the page.
    let before = page.calls.load(Ordering::SeqCst);
    let server_tab = agent
        .call("preview_snapshot", json!({"tabId": "server-tab"}))
        .await;
    assert_eq!(server_tab["isError"], true);
    assert_eq!(
        server_tab["structuredContent"]["error"]["_tag"],
        "PreviewAutomationTabNotFoundError"
    );
    assert_eq!(
        page.calls.load(Ordering::SeqCst),
        before,
        "the page was not touched"
    );

    // A reconnect: the host registers the same tab again, and the agent still reaches it.
    let registrations = executor.registrations.load(Ordering::SeqCst);
    connection.reconnect();
    eventually("the second registration", async || {
        (executor.registrations.load(Ordering::SeqCst) > registrations).then_some(())
    })
    .await;
    let again = eventually("the agent to reach the tab again", async || {
        let status = agent.call("preview_status", json!({})).await;
        (status["isError"] == false && status["structuredContent"]["url"] == "http://app.test/")
            .then_some(status)
    })
    .await;
    assert_eq!(again["structuredContent"]["tabId"], tab.as_str());

    // Dropping the host releases the registration: the server's own browser is the default again.
    drop(host);
    eventually("the registration to end", async || {
        let listed = api.list(thread.clone()).await.ok()?;
        listed
            .sessions
            .iter()
            .all(|s| s.tab_id != tab || s.host.is_none())
            .then_some(())
    })
    .await;
    let after = agent.call("preview_snapshot", json!({})).await;
    assert_eq!(
        after["structuredContent"]["error"]["_tag"], "PreviewAutomationTabNotFoundError",
        "no desktop tab, no desktop connected for panels: the server's browser answers"
    );

    // A desktop is connected (it listens for panel requests) but has no tab for the thread: the
    // agent's call asks it to open its Browser panel without taking focus, and the tab it opens
    // and registers serves the call. No server tab is made.
    connection.subscribe_panel_requests(Some("Test Device".to_owned()));
    eventually("the panel subscription", async || {
        // The server counts a desktop once its stream is open: `panel_open` reaches it then.
        let call = agent.call("panel_open", json!({"panel": "diff", "focusWindow": false}));
        let desktop = async {
            match tokio::time::timeout(Duration::from_millis(300), panel_rx.recv()).await {
                Ok(Some(request)) => {
                    answer_panel(&connection, &request.panel.request_id).await;
                    true
                }
                _ => false,
            }
        };
        let (_, reached) = tokio::join!(call, desktop);
        reached.then_some(())
    })
    .await;
    let navigate = agent.call("preview_navigate", json!({"url": "http://localhost:3000"}));
    let desktop = async {
        let request = tokio::time::timeout(Duration::from_secs(20), panel_rx.recv())
            .await
            .expect("the desktop is asked to open its Browser panel")
            .expect("a panel request");
        assert_eq!(request.panel.panel, conn_contract::AgentPanelKind::Browser);
        assert_eq!(request.panel.thread_id, thread);
        assert!(
            !request.panel.focus_window,
            "the panel opens without taking focus"
        );
        // The app opens the tab (a record and a registration), then answers the request.
        let record = api
            .open(PreviewOpenInput {
                thread_id: thread.clone(),
                url: None,
                viewport: None,
                profile_id: None,
                runtime: None,
                color_scheme: None,
                zoom_factor: None,
                reveal: None,
            })
            .await
            .expect("preview.open");
        let new_tab = record.tab_id.clone();
        let host = DesktopTabHost::start(
            &tokio::runtime::Handle::current(),
            api.clone(),
            executor.clone(),
            Arc::new(State(Mutex::new(Some(record)))),
            HostedTarget {
                environment_id: info["environmentId"].as_str().unwrap().to_owned(),
                thread_id: thread.clone(),
                tab_id: new_tab.clone(),
            },
            connected.clone(),
            HostOptions::default(),
        );
        answer_panel(&connection, &request.panel.request_id).await;
        (new_tab, host)
    };
    let (reply, (new_tab, _host)) = tokio::join!(navigate, desktop);
    assert_eq!(reply["isError"], false, "{reply}");
    assert_eq!(reply["structuredContent"]["tabId"], new_tab.as_str());
    assert_eq!(reply["structuredContent"]["url"], "http://app.test/");
}
