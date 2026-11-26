//! The runner against a scripted page: the shape of T3's answers, its errors, and its queue.

use conn_contract::{
    PreviewNavStatus, PreviewNavStatusIdle, PreviewOpenInputRuntime, PreviewSessionSnapshot,
    PreviewViewportSettingFill, lit,
};

use super::*;
use crate::cdp::{CdpFuture, EventListener, Subscription};

type Script = dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync;

/// The CDP side of a page: answers calls from a script.
struct FakeCdp {
    script: Box<Script>,
    sent: Mutex<Vec<(String, Value)>>,
    listeners: Mutex<Vec<EventListener>>,
}

impl Cdp for FakeCdp {
    fn send(&self, method: &str, params: Value) -> CdpFuture {
        self.sent
            .lock()
            .unwrap()
            .push((method.to_owned(), params.clone()));
        let reply = (self.script)(method, &params);
        Box::pin(async move { reply })
    }
    fn on_event(&self, listener: EventListener) -> Subscription {
        self.listeners.lock().unwrap().push(listener);
        Subscription::new(|| {})
    }
}

/// A page that answers CDP calls from a script, falling back to a quiet blank page.
struct FakePage {
    cdp: Arc<FakeCdp>,
    dialog: Mutex<Option<DialogInfo>>,
    chooser: Mutex<Option<FileChooserInfo>>,
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    intercepting: AtomicBool,
    resolved_paths: Mutex<Vec<String>>,
    url: Mutex<String>,
    live: AtomicBool,
}

impl FakePage {
    fn new(
        script: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            cdp: Arc::new(FakeCdp {
                script: Box::new(script),
                sent: Mutex::default(),
                listeners: Mutex::default(),
            }),
            dialog: Mutex::default(),
            chooser: Mutex::default(),
            on_change: Mutex::default(),
            intercepting: AtomicBool::new(false),
            resolved_paths: Mutex::default(),
            url: Mutex::new("http://localhost:3000/".to_owned()),
            live: AtomicBool::new(true),
        })
    }

    fn set_dialog(&self, dialog: Option<DialogInfo>) {
        *self.dialog.lock().unwrap() = dialog;
        if let Some(callback) = self.on_change.lock().unwrap().clone() {
            callback();
        }
    }

    fn methods(&self) -> Vec<String> {
        self.cdp
            .sent
            .lock()
            .unwrap()
            .iter()
            .map(|(m, _)| m.clone())
            .collect()
    }
}

/// The calls the utility world needs, then `fallback` for the rest.
fn page_script(
    fallback: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
) -> impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static {
    move |method, params| match method {
        "Page.getFrameTree" => Ok(json!({"frameTree": {"frame": {"id": "frame"}}})),
        "Page.createIsolatedWorld" => Ok(json!({"executionContextId": 7})),
        "Page.getLayoutMetrics" => Ok(json!({
            "cssLayoutViewport": {"clientWidth": 800, "clientHeight": 600},
            "cssVisualViewport": {"clientWidth": 800.0, "clientHeight": 600.0},
        })),
        "Runtime.evaluate" => {
            let expression = params["expression"].as_str().unwrap_or_default();
            if params.get("contextId").is_some() {
                if expression == "!!globalThis.__connInjected" {
                    return Ok(json!({"result": {"value": true}}));
                }
                // The waitFor condition holds at once.
                if expression.contains("urlIncludes") {
                    return Ok(json!({"result": {"value": true}}));
                }
                // Other utility-world work: the sensitive-values read.
                return Ok(json!({"result": {"value": []}}));
            }
            if expression.contains("__t3codeCredentialLocked") {
                return Ok(json!({"result": {"value": false}}));
            }
            if expression == "document.title" {
                return Ok(json!({"result": {"value": "Home"}}));
            }
            fallback(method, params)
        }
        _ => fallback(method, params),
    }
}

impl PageTarget for FakePage {
    fn cdp(&self) -> Option<Arc<dyn Cdp>> {
        self.live
            .load(Ordering::SeqCst)
            .then(|| -> Arc<dyn Cdp> { self.cdp.clone() })
    }
    fn url(&self) -> String {
        self.url.lock().unwrap().clone()
    }
    fn title(&self) -> String {
        "Cached title".to_owned()
    }
    fn pending_dialog(&self) -> Option<DialogInfo> {
        self.dialog.lock().unwrap().clone()
    }
    fn handle_dialog(&self, _accept: bool, _prompt_text: Option<&str>) -> bool {
        let had = self.dialog.lock().unwrap().take().is_some();
        if let Some(callback) = self.on_change.lock().unwrap().clone() {
            callback();
        }
        had
    }
    fn pending_file_chooser(&self) -> Option<FileChooserInfo> {
        self.chooser.lock().unwrap().clone()
    }
    fn resolve_file_chooser(&self, paths: &[String]) -> bool {
        *self.resolved_paths.lock().unwrap() = paths.to_vec();
        self.chooser.lock().unwrap().take().is_some()
    }
    fn set_intercepting(&self, intercept: bool) {
        self.intercepting.store(intercept, Ordering::SeqCst);
    }
    fn on_dialog_change(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        *self.on_change.lock().unwrap() = Some(callback);
    }
}

fn binding() -> DesktopTabBinding {
    DesktopTabBinding {
        environment_id: "environment".to_owned(),
        thread_id: "thread".to_owned(),
        tab_id: "tab".to_owned(),
        device_name: "Test Mac".to_owned(),
        snapshot: PreviewSessionSnapshot {
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
            runtime: Some(PreviewOpenInputRuntime::Desktop),
            host: None,
            hosted_here: None,
            headless: None,
            automation_owner: None,
            reveal: None,
            reveal_request: None,
            updated_at: "2026-11-25T00:00:00Z".to_owned(),
        },
    }
}

fn runner(page: &Arc<FakePage>) -> Arc<DesktopTabRunner> {
    DesktopTabRunner::new(page.clone(), binding(), "connection-1".to_owned())
}

fn request(operation: PreviewAutomationOperation, input: Value) -> PreviewAutomationRequest {
    PreviewAutomationRequest {
        request_id: "request-1".to_owned(),
        thread_id: "thread".to_owned(),
        tab_id: Some("tab".to_owned()),
        tab_id_explicit: None,
        agent_session_id: None,
        operation,
        input,
        timeout_ms: 1000,
    }
}

fn result(response: &PreviewAutomationResponse) -> &Value {
    assert!(response.ok, "answer failed: {:?}", response.error);
    response
        .result
        .as_ref()
        .and_then(Option::as_ref)
        .expect("a result")
}

#[tokio::test]
async fn status_describes_the_hosted_tab_like_t3() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let response = runner(&page)
        .respond(request(PreviewAutomationOperation::Status, json!({})))
        .await;
    assert_eq!(response.client_id, "desktop");
    assert_eq!(response.connection_id, "connection-1");
    assert_eq!(response.request_id, "request-1");
    let status = result(&response);
    assert_eq!(status["available"], true);
    assert_eq!(status["visible"], true);
    assert_eq!(status["tabId"], "tab");
    assert_eq!(status["url"], "http://localhost:3000/");
    assert_eq!(status["title"], "Home");
    assert_eq!(status["loading"], false);
    assert_eq!(status["viewportSetting"], json!({"_tag": "fill"}));
    assert_eq!(status["viewport"], json!({"width": 800, "height": 600}));
    assert_eq!(status["dialog"], Value::Null);
    assert_eq!(status["fileChooser"], Value::Null);
    assert_eq!(
        status["control"],
        json!({"owner": "unclaimed", "ownedByCaller": true, "generation": 0})
    );
    assert_eq!(
        status["tabs"],
        json!([{
            "tabId": "tab",
            "url": "http://localhost:3000/",
            "host": "Test Mac",
            "runtime": "desktop",
            "owner": "unclaimed",
        }])
    );
}

#[tokio::test]
async fn refuses_a_request_for_another_tab_or_thread() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    for mutate in [
        (|r: &mut PreviewAutomationRequest| r.tab_id = Some("other".to_owned())) as fn(&mut _),
        |r| r.tab_id = None,
        |r| r.thread_id = "other".to_owned(),
    ] {
        let mut asked = request(PreviewAutomationOperation::Status, json!({}));
        mutate(&mut asked);
        let response = runner.respond(asked).await;
        let error = response.error.expect("refused");
        assert_eq!(error.tag, "PreviewAutomationControlInterruptedError");
        assert_eq!(error.detail, Some(Some(json!("agentMismatch"))));
        assert_eq!(error.message, "Desktop tab operation failed.");
    }
}

#[tokio::test]
async fn evaluate_returns_the_value_and_redacts_hidden_inputs() {
    let script = page_script(|method, params| {
        assert_eq!(method, "Runtime.evaluate");
        assert_eq!(params["returnByValue"], true);
        assert_eq!(params["awaitPromise"], true);
        Ok(json!({"result": {"value": "token hunter22 here"}}))
    });
    // The page holds a password input worth redacting; its value comes from the utility world.
    let page = FakePage::new(move |method, params| {
        if params.get("contextId").is_some()
            && params["expression"]
                .as_str()
                .is_some_and(|e| e.contains("credentialFilled"))
        {
            return Ok(json!({"result": {"value": ["hunter22"]}}));
        }
        script(method, params)
    });
    let response = runner(&page)
        .respond(request(
            PreviewAutomationOperation::Evaluate,
            json!({"expression": "document.body.innerText"}),
        ))
        .await;
    assert_eq!(result(&response), &json!("token [redacted] here"));
}

#[tokio::test]
async fn evaluate_reports_a_page_exception_as_an_execution_error() {
    let page = FakePage::new(page_script(|_, _| {
        Ok(
            json!({"exceptionDetails": {"text": "Uncaught", "exception": {"description": "ReferenceError: nope is not defined"}}}),
        )
    }));
    let response = runner(&page)
        .respond(request(
            PreviewAutomationOperation::Evaluate,
            json!({"expression": "nope"}),
        ))
        .await;
    let error = response.error.expect("failed");
    assert_eq!(error.tag, "PreviewAutomationExecutionError");
    assert_eq!(error.message, "Desktop tab operation failed.");
}

#[tokio::test]
async fn evaluate_refuses_a_result_over_the_limit() {
    let big = "x".repeat(70_000);
    let page = FakePage::new(page_script(move |_, _| {
        Ok(json!({"result": {"value": big}}))
    }));
    let response = runner(&page)
        .respond(request(
            PreviewAutomationOperation::Evaluate,
            json!({"expression": "'x'.repeat(70000)"}),
        ))
        .await;
    let error = response.error.expect("failed");
    assert_eq!(error.tag, "PreviewAutomationResultTooLargeError");
    assert_eq!(error.detail, Some(Some(json!({"maximumBytes": 64_000}))));
}

#[tokio::test]
async fn evaluate_is_blocked_while_saved_credentials_lock_the_document() {
    let page = FakePage::new(|method, params| {
        if method == "Runtime.evaluate"
            && params["expression"]
                .as_str()
                .is_some_and(|e| e.contains("__t3codeCredentialLocked"))
        {
            return Ok(json!({"result": {"value": true}}));
        }
        page_script(|_, _| Ok(json!({})))(method, params)
    });
    let response = runner(&page)
        .respond(request(
            PreviewAutomationOperation::Evaluate,
            json!({"expression": "1"}),
        ))
        .await;
    assert_eq!(
        response.error.expect("blocked").tag,
        "PreviewAutomationCredentialLockError"
    );
}

#[tokio::test]
async fn unsupported_operations_answer_with_t3s_error_and_never_hang() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    let error = runner
        .execute(&request(PreviewAutomationOperation::CdpEndpoint, json!({})))
        .await
        .expect_err("not served");
    assert_eq!(error.tag, "PreviewAutomationExecutionError");
    assert_eq!(error.message, "Not supported on desktop tabs: cdpEndpoint.");
    assert!(
        !page.intercepting.load(Ordering::SeqCst),
        "no action left running"
    );
}

/// Conn Server before 0.5.4 relays `preview_open` on a named desktop tab as T3's `open`. The
/// host serves one tab, so `open` shows it: it answers with the tab's status, and loads the
/// address first when the agent gave one.
#[tokio::test]
async fn open_on_the_hosted_tab_answers_its_status_and_loads_a_given_url() {
    let page = FakePage::new(page_script(|method, _| match method {
        "Page.navigate" => Ok(json!({"frameId": "frame"})),
        _ => Ok(json!({})),
    }));
    let runner = runner(&page);
    let response = runner
        .respond(request(
            PreviewAutomationOperation::Open,
            json!({"reuseExistingTab": true}),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let result = response.result.flatten().expect("a status");
    assert_eq!(result["tabId"], "tab");
    assert!(
        !page
            .cdp
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|(method, _)| method == "Page.navigate"),
        "an open without an address stays on the page"
    );
    // A same-document navigation commits without a loader, so nothing waits for DOM content.
    let response = runner
        .respond(request(
            PreviewAutomationOperation::Open,
            json!({"url": "localhost:5173/app", "reuseExistingTab": true}),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sent = page.cdp.sent.lock().unwrap();
    let navigate = sent
        .iter()
        .find(|(method, _)| method == "Page.navigate")
        .expect("navigated");
    assert_eq!(navigate.1["url"], "http://localhost:5173/app");
}

#[tokio::test]
async fn navigate_needs_a_url_and_names_t3s_limit() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let error = runner(&page)
        .execute(&request(
            PreviewAutomationOperation::Navigate,
            json!({"target": {"kind": "port", "port": 3000}}),
        ))
        .await
        .expect_err("needs a url");
    assert_eq!(
        error.message,
        "Not supported on desktop tabs yet. Navigate with a URL."
    );
}

#[tokio::test]
async fn navigate_sends_the_normalized_url_and_waits_for_dom_content() {
    let page = FakePage::new(page_script(|method, _| match method {
        "Page.enable" => Ok(json!({})),
        "Page.navigate" => Ok(json!({"frameId": "frame", "loaderId": "loader"})),
        _ => Ok(json!({})),
    }));
    let runner = runner(&page);
    let firing = page.clone();
    tokio::spawn(async move {
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let listeners = firing.cdp.listeners.lock().unwrap().clone();
            if !listeners.is_empty() {
                for listener in listeners {
                    listener("Page.domContentEventFired", &json!({}));
                }
                return;
            }
        }
    });
    let response = runner
        .respond(request(
            PreviewAutomationOperation::Navigate,
            json!({"url": "localhost:5173/app"}),
        ))
        .await;
    assert!(response.ok, "{:?}", response.error);
    let sent = page.cdp.sent.lock().unwrap();
    let navigate = sent
        .iter()
        .find(|(method, _)| method == "Page.navigate")
        .expect("navigated");
    assert_eq!(navigate.1["url"], "http://localhost:5173/app");
}

#[tokio::test]
async fn a_pending_dialog_blocks_actions_until_preview_dialog_answers_it() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    page.set_dialog(Some(DialogInfo {
        dialog_type: "confirm".to_owned(),
        message: "Sure?".to_owned(),
        default_value: String::new(),
    }));
    assert!(
        page.intercepting.load(Ordering::SeqCst),
        "dialogs stay held while one is pending"
    );

    let status = runner
        .respond(request(PreviewAutomationOperation::Status, json!({})))
        .await;
    let status = result(&status);
    assert_eq!(
        status["dialog"],
        json!({"type": "confirm", "message": "Sure?", "defaultValue": ""})
    );
    assert_eq!(
        status["title"], "Cached title",
        "no page script runs under a dialog"
    );

    let blocked = runner
        .respond(request(
            PreviewAutomationOperation::Scroll,
            json!({"deltaY": 10}),
        ))
        .await;
    let error = blocked.error.expect("blocked");
    assert_eq!(error.tag, "PreviewAutomationControlInterruptedError");
    assert_eq!(error.detail, Some(Some(json!("dialogPending"))));

    let snapshot = runner
        .respond(request(PreviewAutomationOperation::Snapshot, json!({})))
        .await;
    assert_eq!(
        snapshot.error.expect("blocked").detail,
        Some(Some(json!("dialogPending")))
    );

    let answered = runner
        .respond(request(
            PreviewAutomationOperation::Dialog,
            json!({"accept": true}),
        ))
        .await;
    assert_eq!(result(&answered)["dialog"], Value::Null);
    assert!(!page.intercepting.load(Ordering::SeqCst));

    let none = runner
        .respond(request(
            PreviewAutomationOperation::Dialog,
            json!({"accept": true}),
        ))
        .await;
    assert_eq!(
        none.error.expect("none pending").tag,
        "PreviewAutomationExecutionError"
    );
}

#[tokio::test]
async fn upload_without_a_locator_uses_the_open_file_picker() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    let error = runner
        .execute(&request(
            PreviewAutomationOperation::Upload,
            json!({"paths": ["/tmp/a.txt"]}),
        ))
        .await
        .expect_err("no picker");
    assert_eq!(
        error.message,
        "No file picker is open. Click the upload control first, or pass a file input locator."
    );
    *page.chooser.lock().unwrap() = Some(FileChooserInfo {
        multiple: false,
        accept: ".txt".to_owned(),
    });
    let status = runner
        .respond(request(PreviewAutomationOperation::Status, json!({})))
        .await;
    assert_eq!(
        result(&status)["fileChooser"],
        json!({"multiple": false, "accept": ".txt"})
    );
    runner
        .execute(&request(
            PreviewAutomationOperation::Upload,
            json!({"paths": ["/tmp/a.txt"]}),
        ))
        .await
        .expect("uploaded");
    assert_eq!(*page.resolved_paths.lock().unwrap(), ["/tmp/a.txt"]);
    let relative = runner
        .execute(&request(
            PreviewAutomationOperation::Upload,
            json!({"paths": ["a.txt"]}),
        ))
        .await
        .expect_err("relative");
    assert!(relative.message.contains("must be absolute"));
}

#[tokio::test]
async fn resize_and_color_scheme_apply_emulation_and_report_the_choice() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    let resized = runner
        .respond(request(
            PreviewAutomationOperation::Resize,
            json!({"mode": "freeform", "width": 500, "height": 700}),
        ))
        .await;
    let resized = result(&resized);
    assert_eq!(resized["tabId"], "tab");
    assert_eq!(
        resized["setting"],
        json!({"_tag": "freeform", "width": 500, "height": 700})
    );
    assert!(
        page.methods()
            .contains(&"Emulation.setDeviceMetricsOverride".to_owned())
    );

    let filled = runner
        .respond(request(
            PreviewAutomationOperation::Resize,
            json!({"mode": "fill"}),
        ))
        .await;
    assert_eq!(result(&filled)["setting"], json!({"_tag": "fill"}));
    assert!(
        page.methods()
            .contains(&"Emulation.clearDeviceMetricsOverride".to_owned())
    );

    let scheme = runner
        .respond(request(
            PreviewAutomationOperation::SetColorScheme,
            json!({"colorScheme": "dark"}),
        ))
        .await;
    assert_eq!(
        result(&scheme),
        &json!({"tabId": "tab", "colorScheme": "dark"})
    );
    let sent = page.cdp.sent.lock().unwrap();
    let media = sent
        .iter()
        .find(|(m, _)| m == "Emulation.setEmulatedMedia")
        .expect("emulated");
    assert_eq!(media.1["features"][0]["value"], "dark");
}

#[tokio::test]
async fn actions_queued_together_all_complete() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    let first = runner.respond(request(
        PreviewAutomationOperation::WaitFor,
        json!({"timeoutMs": 500}),
    ));
    let second = runner.respond(request(
        PreviewAutomationOperation::WaitFor,
        json!({"timeoutMs": 500}),
    ));
    let (first, second) = tokio::join!(first, second);
    assert!(
        first.ok && second.ok,
        "{:?} {:?}",
        first.error,
        second.error
    );
}

#[tokio::test]
async fn closing_the_runner_releases_dialogs_and_refuses_new_work() {
    let page = FakePage::new(page_script(|_, _| Ok(json!({}))));
    let runner = runner(&page);
    page.set_dialog(Some(DialogInfo {
        dialog_type: "alert".to_owned(),
        message: "Hi".to_owned(),
        default_value: String::new(),
    }));
    runner.close();
    assert!(page.pending_dialog().is_none(), "the dialog is dismissed");
    assert!(!page.intercepting.load(Ordering::SeqCst));
    let response = runner
        .respond(request(PreviewAutomationOperation::Status, json!({})))
        .await;
    assert_eq!(
        response.error.expect("closed").tag,
        "PreviewAutomationControlInterruptedError"
    );
}

#[test]
fn normalizes_preview_urls_like_t3() {
    assert_eq!(
        normalize_preview_url("localhost:5173").unwrap(),
        "http://localhost:5173/"
    );
    assert_eq!(
        normalize_preview_url("example.com/a b").unwrap(),
        "https://example.com/a%20b"
    );
    assert_eq!(
        normalize_preview_url("  https://example.com ").unwrap(),
        "https://example.com/"
    );
    assert!(normalize_preview_url("").unwrap_err().contains("empty"));
    assert!(
        normalize_preview_url("javascript:alert(1)")
            .unwrap_err()
            .contains("unsupported-protocol")
    );
    assert!(
        normalize_preview_url("ftp://example.com")
            .unwrap_err()
            .contains("unsupported-protocol: ftp:")
    );
}

#[test]
fn page_errors_map_to_t3s_error_tags() {
    let tag = |message: &str| OperationError::from_page(PageError(message.to_owned())).tag;
    assert_eq!(
        tag("Error: __conn_stale_ref"),
        "PreviewAutomationInvalidSelectorError"
    );
    assert_eq!(
        tag("Unknown engine \"x\" while parsing selector"),
        "PreviewAutomationInvalidSelectorError"
    );
    assert_eq!(
        tag("__conn_not_editable"),
        "PreviewAutomationTargetNotEditableError"
    );
    assert_eq!(
        tag("Preview automation click timed out after 15ms."),
        "PreviewAutomationTimeoutError"
    );
    assert_eq!(tag("boom"), "PreviewAutomationExecutionError");
    assert_eq!(
        OperationError::from_page(PageError("Error: __conn_stale_ref".to_owned())).detail,
        Some(json!({"staleRef": true}))
    );
}
