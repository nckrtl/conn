use super::*;

fn call<'a>(operation: &'a str, tab: Option<&'a str>, update: bool) -> RelayCall<'a> {
    RelayCall {
        environment_id: "env",
        thread: "thread",
        agent: "agent",
        operation,
        input: json!({}),
        tab,
        timeout_ms: Some(50),
        update_current_tab: update,
        desktop_default: true,
    }
}

async fn request(feed: &mut DesktopFeed) -> Value {
    loop {
        let event = feed.receiver.recv().await.expect("an event");
        if event["type"] == "request" {
            return event;
        }
    }
}

fn answer(relay: &Relay, session: &str, event: &Value, response: Value) {
    let mut response = response;
    response["clientId"] = json!("desktop");
    response["connectionId"] = event["connectionId"].clone();
    response["requestId"] = event["request"]["requestId"].clone();
    relay.respond(session, &response);
}

#[tokio::test]
async fn a_tab_has_one_host_and_its_stream_belongs_to_the_registering_session() {
    let relay = Relay::default();
    let id = relay.register("s1", "env", "thread", "tab", "Mac").unwrap();
    assert_eq!(
        relay.register("s2", "env", "thread", "tab", "Mac"),
        Err("conflict")
    );
    assert_eq!(relay.requests("s2", &id).err(), Some("session"));
    let mut feed = relay.requests("s1", &id).unwrap();
    assert_eq!(relay.requests("s1", &id).err(), Some("session"));
    let connected = feed.receiver.recv().await.unwrap();
    assert_eq!(connected, json!({"type":"connected","connectionId":id}));
    drop(feed);
    // The stream's end frees the tab for the next registration.
    assert!(relay.register("s2", "env", "thread", "tab", "Mac").is_ok());
}

#[tokio::test(start_paused = true)]
async fn a_registration_without_its_stream_expires() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    tokio::time::sleep(REGISTRATION_GRACE + Duration::from_secs(1)).await;
    assert_eq!(relay.requests("s", &id).err(), Some("session"));
    assert!(relay.tabs("env", "thread").is_empty());
}

#[tokio::test]
async fn calls_follow_an_explicit_desktop_tab_until_an_open() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    let worker = relay.clone();
    let named =
        tokio::spawn(async move { worker.invoke(call("snapshot", Some("tab"), true)).await });
    let event = request(&mut feed).await;
    assert_eq!(event["request"]["tabIdExplicit"], true);
    assert_eq!(
        event["request"]["agentSessionId"],
        "env\u{0}agent\u{0}thread"
    );
    // An answer from another session never reaches the request.
    answer(
        &relay,
        "other",
        &event,
        json!({"ok":true,"result":{"wrong":true}}),
    );
    answer(
        &relay,
        "s",
        &event,
        json!({"ok":true,"result":{"url":"http://x/"}}),
    );
    let relayed = named.await.unwrap().unwrap().unwrap();
    assert_eq!(relayed.value["url"], "http://x/");
    assert_eq!(relayed.tab.as_deref(), Some("tab"));
    // The tab is now current: the next call without a tab goes there too.
    let worker = relay.clone();
    let follow = tokio::spawn(async move { worker.invoke(call("click", None, true)).await });
    let event = request(&mut feed).await;
    assert_eq!(event["request"]["tabId"], "tab");
    assert_eq!(event["request"]["tabIdExplicit"], false);
    answer(
        &relay,
        "s",
        &event,
        json!({"ok":false,"error":{"_tag":"PreviewAutomationTabNotFoundError","message":"x"}}),
    );
    let failure = follow.await.unwrap().unwrap().unwrap_err();
    assert_eq!(failure.tag, "PreviewAutomationTabNotFoundError");
    assert_eq!(
        failure.message,
        "Preview tab tab was not found for click. Omit tabId to use the current tab, or call preview_open."
    );
    // `open` is never relayed: the caller turns it into a navigation of a desktop tab, or opens
    // a server tab, and the assignment it ends falls back to the thread's newest desktop tab.
    assert!(relay.invoke(call("open", None, true)).await.is_none());
    assert_eq!(
        relay.default_tab("env", "thread", "agent").as_deref(),
        Some("tab")
    );
}

/// Conn's deliberate divergence from T3: with a desktop tab on the thread, a call without a
/// tab goes to the desktop. See the module documentation of `crate::relay`.
#[tokio::test]
async fn a_call_without_a_tab_defaults_to_the_threads_desktop_tab() {
    let relay = Relay::default();
    // No desktop for the thread: the server's own browser.
    assert!(relay.invoke(call("snapshot", None, true)).await.is_none());
    assert_eq!(relay.default_tab("env", "thread", "agent"), None);

    let first = relay.register("s", "env", "thread", "one", "Mac").unwrap();
    let mut first_feed = relay.requests("s", &first).unwrap();
    let second = relay.register("s", "env", "thread", "two", "Mac").unwrap();
    let mut second_feed = relay.requests("s", &second).unwrap();
    // Another thread's and another environment's tabs are not this thread's.
    let other = relay
        .register("s", "env", "other-thread", "three", "Mac")
        .unwrap();
    let _other_feed = relay.requests("s", &other).unwrap();

    // The agent has no current tab: the newest registered one serves it.
    assert_eq!(
        relay.default_tab("env", "thread", "agent").as_deref(),
        Some("two")
    );
    let worker = relay.clone();
    let task = tokio::spawn(async move { worker.invoke(call("snapshot", None, true)).await });
    let event = request(&mut second_feed).await;
    assert_eq!(event["request"]["threadId"], "thread");
    assert_eq!(event["request"]["tabIdExplicit"], false);
    assert_eq!(
        event["request"]["tabId"], "two",
        "a default-routed request still names the tab the desktop hosts"
    );
    answer(
        &relay,
        "s",
        &event,
        json!({"ok":true,"result":{"tabId":"two"}}),
    );
    assert!(task.await.unwrap().unwrap().is_ok());

    // Naming the other desktop tab moves the agent there, and it stays current.
    let worker = relay.clone();
    let task = tokio::spawn(async move { worker.invoke(call("click", Some("one"), true)).await });
    let event = request(&mut first_feed).await;
    answer(
        &relay,
        "s",
        &event,
        json!({"ok":true,"result":{"tabId":"one"}}),
    );
    assert!(task.await.unwrap().unwrap().is_ok());
    assert_eq!(
        relay.default_tab("env", "thread", "agent").as_deref(),
        Some("one")
    );
    let worker = relay.clone();
    let task = tokio::spawn(async move { worker.invoke(call("click", None, true)).await });
    let event = request(&mut first_feed).await;
    assert_eq!(event["request"]["tabId"], "one");
    answer(&relay, "s", &event, json!({"ok":true,"result":{}}));
    assert!(task.await.unwrap().unwrap().is_ok());

    // Another agent on the same thread gets the thread's newest tab, not this agent's.
    let mut other_agent = call("snapshot", None, true);
    other_agent.agent = "agent-2";
    let worker = relay.clone();
    let task = tokio::spawn(async move { worker.invoke(other_agent).await });
    let event = request(&mut second_feed).await;
    answer(&relay, "s", &event, json!({"ok":true,"result":{}}));
    assert!(task.await.unwrap().unwrap().is_ok());
}

#[tokio::test]
async fn an_explicit_server_tab_and_server_only_calls_never_default_to_the_desktop() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let _feed = relay.requests("s", &id).unwrap();
    // A tab no desktop hosts is the server's own, even with a desktop tab on the thread.
    assert!(
        relay
            .invoke(call("snapshot", Some("server-tab"), true))
            .await
            .is_none()
    );
    // A server-only call (recordings) stays on the server unless it names a desktop tab.
    let mut server_only = call("recordingStart", None, true);
    server_only.desktop_default = false;
    assert!(relay.invoke(server_only).await.is_none());
}

/// Once an agent has a current desktop tab, a recording call without a tab still goes to the
/// server's browser, and the agent keeps its current tab.
#[tokio::test]
async fn a_recording_does_not_follow_the_agents_current_desktop_tab() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    let worker = relay.clone();
    let task = tokio::spawn(async move { worker.invoke(call("snapshot", None, true)).await });
    let event = request(&mut feed).await;
    answer(
        &relay,
        "s",
        &event,
        json!({"ok":true,"result":{"tabId":"tab"}}),
    );
    assert!(task.await.unwrap().unwrap().is_ok());
    for operation in ["recordingStart", "recordingStop"] {
        let mut server_only = call(operation, None, true);
        server_only.desktop_default = false;
        assert!(relay.invoke(server_only).await.is_none());
    }
    assert_eq!(
        relay.default_tab("env", "thread", "agent").as_deref(),
        Some("tab")
    );
}

/// The relay itself keeps recordings and CDP endpoints off the desktop when no tab is named,
/// even for a caller that allows the desktop default.
#[tokio::test]
async fn recordings_and_cdp_endpoints_without_a_tab_stay_on_the_server_whatever_the_caller_says() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    // A current desktop tab exists, and the thread's newest tab is this one.
    let worker = relay.clone();
    let task = tokio::spawn(async move { worker.invoke(call("snapshot", None, true)).await });
    let event = request(&mut feed).await;
    answer(
        &relay,
        "s",
        &event,
        json!({"ok":true,"result":{"tabId":"tab"}}),
    );
    assert!(task.await.unwrap().unwrap().is_ok());
    for operation in ["recordingStart", "recordingStop", "cdpEndpoint"] {
        assert!(
            relay.invoke(call(operation, None, true)).await.is_none(),
            "{operation} reached the desktop"
        );
    }
    assert_eq!(
        relay.default_tab("env", "thread", "agent").as_deref(),
        Some("tab"),
        "the agent keeps its current desktop tab"
    );
}

#[tokio::test]
async fn recordings_stay_off_desktop_tabs() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let _feed = relay.requests("s", &id).unwrap();
    let failure = relay
        .invoke(call("recordingStart", Some("tab"), true))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(
        failure.message,
        "Preview automation recordingStart failed: Recording is not supported on desktop tabs."
    );
}

#[tokio::test(start_paused = true)]
async fn a_silent_desktop_times_out_and_is_released_but_a_slow_read_is_not() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    let read = relay
        .invoke(call("status", Some("tab"), false))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(
        read.message,
        "Preview automation status timed out after 50ms."
    );
    assert_eq!(relay.tabs("env", "thread").len(), 1);
    let action = relay
        .invoke(call("click", Some("tab"), true))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(action.tag, "PreviewAutomationTimeoutError");
    // The host is gone: its stream ends so the desktop registers again.
    assert!(relay.tabs("env", "thread").is_empty());
    while feed.receiver.recv().await.is_some() {}
}

#[tokio::test]
async fn a_host_that_leaves_fails_its_pending_requests() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    let worker = relay.clone();
    let pending = tokio::spawn(async move {
        let mut long = call("click", Some("tab"), true);
        long.timeout_ms = Some(60_000);
        worker.invoke(long).await
    });
    let _ = request(&mut feed).await;
    drop(feed);
    let failure = pending.await.unwrap().unwrap().unwrap_err();
    assert_eq!(failure.tag, "PreviewAutomationClientDisconnectedError");
    assert!(failure.message.ends_with("disconnected during click."));
    assert!(lock(&relay.0).pending.is_empty());
}

#[test]
fn remote_errors_read_as_t3_reports_them() {
    let context = Context {
        operation: "type".into(),
        environment_id: "env".into(),
        client_id: "desktop-1".into(),
        connection_id: "c".into(),
        request_id: "preview-0".into(),
        tab: None,
        timeout_ms: 15_000,
        selector: Some(("selector", 3)),
        sequence: 0,
    };
    let message = |error: Value| context.classify(Some(&error)).message;
    assert_eq!(
        message(json!({"_tag":"PreviewAutomationTargetNotEditableError","message":""})),
        "Preview automation type requires an editable selector (3 characters)."
    );
    assert_eq!(
        message(
            json!({"_tag":"PreviewAutomationControlInterruptedError","message":"","detail":"tabLimit"})
        ),
        "Too many server browser tabs are open. Close one with conn_preview_close, or reuse a tabId from preview_status tabs."
    );
    assert_eq!(
        message(
            json!({"_tag":"PreviewAutomationTimeoutError","message":"","detail":{"timeoutMs":99_999,"pendingStages":["frames","screenshot"]}})
        ),
        "Preview automation type timed out after 15000ms. Waiting for: frames, screenshot."
    );
    assert_eq!(
        context.classify(None).message,
        "Preview automation client desktop-1 returned a malformed response for type."
    );
}

#[tokio::test]
async fn a_cancelled_call_leaves_no_pending_request() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    let worker = relay.clone();
    let call_task = tokio::spawn(async move {
        let mut long = call("click", Some("tab"), true);
        long.timeout_ms = Some(60_000);
        worker.invoke(long).await
    });
    let _ = request(&mut feed).await;
    assert_eq!(lock(&relay.0).pending.len(), 1);
    call_task.abort();
    let _ = call_task.await;
    assert!(lock(&relay.0).pending.is_empty());
}

#[tokio::test]
async fn an_explicit_server_tab_stays_on_the_server_while_a_desktop_tab_is_current() {
    let relay = Relay::default();
    let id = relay.register("s", "env", "thread", "tab", "Mac").unwrap();
    let mut feed = relay.requests("s", &id).unwrap();
    let worker = relay.clone();
    let first = tokio::spawn(async move { worker.invoke(call("click", Some("tab"), true)).await });
    let event = request(&mut feed).await;
    answer(&relay, "s", &event, json!({"ok":true,"result":{}}));
    assert!(first.await.unwrap().unwrap().is_ok());
    assert!(
        relay
            .invoke(call("click", Some("server-tab"), true))
            .await
            .is_none()
    );
}
