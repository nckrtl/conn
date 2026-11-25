//! Agent browser calls share the server's tab state. A call that names a tab a Conn desktop
//! registered (or follows one there) goes to that desktop, as in T3's broker.
use super::{Args, Cx, ToolError, ToolResult, fail, str_arg};
use conn_contract::{AgentPanelKind, AgentPanelRequest};
use conn_preview::relay::{RelayCall, RelayFailure};
use conn_preview::tabs::Preview;
use serde_json::{Map, Value, json};

/// T3's `PREVIEW_RECORDING_STOP_TIMEOUT_MS`.
const RECORDING_STOP_TIMEOUT_MS: u64 = 120_000;

pub(super) async fn call(cx: &Cx<'_>, name: &str, args: &Args) -> ToolResult {
    let caller = cx.require_thread("This tool")?;
    let read = matches!(
        name,
        "preview_status" | "conn_preview_list" | "preview_snapshot" | "preview_wait_for"
    );
    if !read {
        cx.writing_caller().await?;
    }
    cx.require_preview()?;
    let preview = cx.config().preview.as_ref().ok_or_else(|| {
        ToolError::Message("Preview automation is unavailable for this thread.".into())
    })?;
    if name == "conn_preview_close" {
        let listed = preview.list(&caller.thread_id);
        let runtime = listed
            .get("sessions")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("tabId").and_then(Value::as_str) == str_arg(args, "tabId")
                })
            })
            .map(|item| {
                item.get("runtime")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            });
        match runtime {
            None => return Ok(json!({})),
            // A desktop tab's record closes here; the desktop closes its page on the event.
            Some(runtime) if runtime != "server" => {
                preview
                    .close(&caller.thread_id, str_arg(args, "tabId"))
                    .await
                    .map_err(|error| ToolError::Message(error.to_string()))?;
                return Ok(json!({}));
            }
            Some(_) => {}
        }
    }
    if name == "conn_preview_list" {
        let mut result = preview.list(&caller.thread_id);
        let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
        let sessions = result
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        result["sessions"] = json!(sessions.iter().skip(cursor).take(limit).collect::<Vec<_>>());
        result["nextCursor"] = if cursor.saturating_add(limit) < sessions.len() {
            json!(cursor + limit)
        } else {
            Value::Null
        };
        return Ok(result);
    }
    let operation = match name {
        "preview_open" => "open",
        "preview_snapshot" => "snapshot",
        "preview_act" => str_arg(args, "action").unwrap_or_default(),
        "preview_wait_for" => "waitFor",
        "preview_recording_start" => "recordingStart",
        "preview_recording_stop" => "recordingStop",
        "preview_status" => "status",
        "preview_navigate" => "navigate",
        "preview_resize" => "resize",
        "preview_set_appearance" => "setColorScheme",
        "preview_evaluate" => "evaluate",
        "preview_dialog" => "dialog",
        "preview_cdp_endpoint" => "cdpEndpoint",
        "conn_preview_close" => "close",
        _ => {
            return Err(fail(
                "capability_denied",
                "The browser operation is not served.",
            ));
        }
    };
    let environment = cx.config().environment_id.as_str();
    let tab = str_arg(args, "tabId");
    // Deliberate divergence from T3 (see `conn_preview::relay`): the desktop's integrated browser
    // is the agent's default. A call that names no tab goes to the thread's desktop tab, and when
    // a desktop is connected but has no tab for the thread yet, one is opened in its Browser panel
    // first. The server's own browser serves only a thread without a desktop, or a call that names
    // a server tab. Recordings need the server's browser, so they never default to a desktop.
    let default_to_desktop = !matches!(name, "preview_recording_start" | "preview_recording_stop");
    if tab.is_none()
        && default_to_desktop
        && !matches!(name, "preview_status" | "conn_preview_close")
    {
        open_desktop_tab(cx, preview, environment, &caller.thread_id).await;
    }
    let relay = |operation: &str,
                 input: Value,
                 tab: Option<String>,
                 timeout_ms: Option<u64>,
                 update_current_tab: bool| {
        let (thread, agent) = (caller.thread_id.clone(), caller.provider_session_id.clone());
        let operation = operation.to_owned();
        async move {
            preview
                .relay(RelayCall {
                    environment_id: environment,
                    thread: &thread,
                    agent: &agent,
                    operation: &operation,
                    input,
                    tab: tab.as_deref(),
                    timeout_ms,
                    update_current_tab,
                    desktop_default: default_to_desktop,
                })
                .await
        }
    };
    let (desktop_input, timeout_ms) = desktop_input(name, args);
    // A desktop tab is never "opened" by the agent (T3's runner has no `open`): opening is
    // showing the thread's desktop tab, navigated if the agent gave an address.
    let hosted = preview.desktop_tabs(environment, &caller.thread_id);
    let desktop_open = name == "preview_open"
        && !hosted.is_empty()
        && tab.is_none_or(|tab| hosted.iter().any(|h| h.tab == tab));
    let (operation, desktop_input, timeout_ms) = if desktop_open {
        match args
            .get("url")
            .map(|url| json!({ "url": url }))
            .or_else(|| args.get("target").map(|target| json!({ "target": target })))
        {
            Some(input) => (
                "navigate",
                input,
                args.get("timeoutMs").and_then(Value::as_u64),
            ),
            None => ("status", json!({}), None),
        }
    } else {
        (operation, desktop_input, timeout_ms)
    };
    let routed = if name == "conn_preview_close" {
        None
    } else {
        relay(
            operation,
            desktop_input,
            tab.map(str::to_owned),
            timeout_ms,
            true,
        )
        .await
    };
    let desktop = routed.is_some();
    let mut target_tab = None;
    let value = match routed {
        Some(result) => {
            let relayed = result.map_err(relay_failure)?;
            target_tab = relayed.tab;
            let opened = relayed.value;
            // Only `evaluate` answers with any JSON; the rest must be objects (T3 decodes them).
            if operation != "evaluate" && !opened.is_object() {
                return Err(ToolError::Preview {
                    tag: "PreviewAutomationMalformedResponseError",
                    message: format!(
                        "Preview automation {operation} returned a malformed response."
                    ),
                });
            }
            match (
                name,
                args.get("target"),
                opened.get("tabId").and_then(Value::as_str),
            ) {
                ("preview_open", Some(target), Some(id)) if !desktop_open => {
                    let input = json!({ "target": target });
                    match relay("navigate", input, Some(id.to_owned()), None, true).await {
                        Some(result) => Some(result.map_err(relay_failure)?.value)
                            .filter(Value::is_object)
                            .ok_or_else(|| ToolError::Preview {
                                tag: "PreviewAutomationMalformedResponseError",
                                message:
                                    "Preview automation navigate returned a malformed response."
                                        .into(),
                            })?,
                        None => opened,
                    }
                }
                _ => opened,
            }
        }
        None => {
            let mut input = Value::Object(args.clone());
            if name == "preview_open" && input.get("target").is_some() {
                input.as_object_mut().map(|input| input.remove("url"));
            }
            let mut value = preview
                .invoke(
                    &caller.thread_id,
                    &caller.provider_session_id,
                    operation,
                    input,
                )
                .await
                .map_err(|error| preview_failure(error, operation, args))?;
            if operation == "status" {
                add_desktop_tabs(
                    preview,
                    environment,
                    &caller.thread_id,
                    &caller.provider_session_id,
                    &mut value,
                )
                .await;
            }
            value
        }
    };

    let mut value = if operation == "evaluate" {
        json!({"value":value})
    } else {
        value
    };
    if operation == "status" && !desktop && value.get("tabs").is_none() {
        value["tabs"] = json!([]);
    }
    let withheld = value.pointer("/screenshot/data").and_then(Value::as_str) == Some("");
    if operation == "snapshot"
        && args.get("save").and_then(Value::as_bool) == Some(true)
        && !withheld
    {
        let data = value
            .pointer("/fullScreenshot/data")
            .or_else(|| value.pointer("/screenshot/data"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let url = value
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let path = preview
            .save_screenshot(&url, data)
            .await
            .map_err(|error| ToolError::Message(error.to_string()))?;
        value.as_object_mut().map(|o| o.remove("fullScreenshot"));
        value["screenshotPath"] = json!(path);
        if args.get("includeImage").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({"url":url,"screenshotPath":path}));
        }
    }
    // T3 reads the page again for the tool icon on the tab the result names, else the target.
    let status_tab = if operation == "evaluate" {
        None
    } else {
        value
            .get("tabId")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
    .or(target_tab);
    if desktop && let Some(schema) = crate::catalog::result_schema(name) {
        // A desktop answers with its own runner's fields; T3 encodes them with the tool's schema.
        value = crate::catalog::prune(&schema, value);
    }
    if desktop && name == "preview_status" && tab.is_none() {
        desktop_first(
            preview,
            environment,
            &caller.thread_id,
            &caller.provider_session_id,
            &mut value,
        )
        .await;
    }
    if desktop && !matches!(operation, "open" | "status" | "navigate" | "snapshot") {
        let status = match relay("status", json!({}), status_tab.clone(), Some(500), false).await {
            Some(result) => result.map_or(Value::Null, |r| r.value),
            None => preview.status(
                &caller.thread_id,
                &caller.provider_session_id,
                status_tab.as_deref(),
            ),
        };
        if let Some(url) = status.get("url").and_then(Value::as_str).filter(|url| {
            url.len() <= 4096 && (url.starts_with("http://") || url.starts_with("https://"))
        }) {
            value["toolIcon"] = json!({"_tag":"website","pageUrl":url});
        }
    } else if !desktop
        && !matches!(
            operation,
            "open" | "status" | "navigate" | "snapshot" | "dialog"
        )
    {
        let status = preview.status(
            &caller.thread_id,
            &caller.provider_session_id,
            str_arg(args, "tabId"),
        );
        if let Some(url) = status.get("url").and_then(Value::as_str).filter(|url| {
            url.len() <= 4096 && (url.starts_with("http://") || url.starts_with("https://"))
        }) {
            value["toolIcon"] = json!({"_tag":"website","pageUrl":url});
        }
    }
    Ok(value)
}

fn relay_failure(failure: RelayFailure) -> ToolError {
    ToolError::Preview {
        tag: failure.tag,
        message: failure.message,
    }
}

/// The input T3's preview handlers send to a host, without `tabId` (it travels apart), and
/// the call's timeout.
fn desktop_input(name: &str, args: &Args) -> (Value, Option<u64>) {
    let mut input: Map<String, Value> = args.clone();
    input.remove("tabId");
    let timeout = |input: &Map<String, Value>| input.get("timeoutMs").and_then(Value::as_u64);
    let flag = |key: &str| args.get(key).and_then(Value::as_bool) == Some(true);
    let timeout_ms = match name {
        "preview_open" => {
            if input.contains_key("target") {
                input.remove("target");
                input.remove("url");
            }
            if let Some(open) = args.get("open").or_else(|| args.get("show")).cloned() {
                input.insert("open".into(), open.clone());
                input.insert("show".into(), open);
            }
            input.entry("reuseExistingTab").or_insert(Value::Bool(true));
            None
        }
        "preview_snapshot" => {
            input.remove("includeImage");
            input.remove("save");
            if flag("save") {
                input.insert("fullScreenshot".into(), Value::Bool(true));
            }
            if !flag("includeImage") && !flag("save") {
                input.insert("pixelsRequired".into(), Value::Bool(false));
            }
            None
        }
        "preview_act" => {
            input.remove("action");
            timeout(&input)
        }
        "preview_recording_stop" => {
            input.insert("transferToEnvironment".into(), Value::Bool(true));
            Some(RECORDING_STOP_TIMEOUT_MS)
        }
        "preview_navigate" | "preview_resize" | "preview_wait_for" => timeout(&input),
        _ => None,
    };
    (Value::Object(input), timeout_ms)
}

/// T3's broker adds the thread's desktop tabs to a server browser status, each read again
/// from its desktop (500 ms, without moving the agent's tab).
async fn add_desktop_tabs(
    preview: &Preview,
    environment: &str,
    thread: &str,
    agent: &str,
    status: &mut Value,
) {
    let hosted = preview.desktop_tabs(environment, thread);
    if hosted.is_empty() || !status.is_object() {
        return;
    }
    let mut tabs = Vec::with_capacity(hosted.len());
    for tab in hosted {
        let mut entry = json!({"tabId":tab.tab,"url":null,"host":tab.device,"runtime":"desktop","hostedHere":false,"owner":"unclaimed"});
        let read = preview
            .relay(RelayCall {
                environment_id: environment,
                thread,
                agent,
                operation: "status",
                input: json!({}),
                tab: Some(&tab.tab),
                timeout_ms: Some(500),
                update_current_tab: false,
                desktop_default: false,
            })
            .await;
        if let Some(Ok(page)) = read {
            entry["url"] = page.value.get("url").cloned().unwrap_or(Value::Null);
            if let Some(owner) = page.value.pointer("/control/owner") {
                entry["owner"] = owner.clone();
            }
        }
        tabs.push(entry);
    }
    status["available"] = json!(true);
    // Desktop tabs lead: they are where an agent's calls go by default.
    if let Some(existing) = status.get_mut("tabs").and_then(Value::as_array_mut) {
        tabs.append(existing);
    }
    status["tabs"] = Value::Array(tabs);
}

/// `preview_status` for an agent whose calls default to a desktop tab: `status` is that tab's own
/// (its `tabId` is the default target), and `tabs` lists the thread's desktop tabs first, the
/// default tab leading them, then any server tabs.
async fn desktop_first(
    preview: &Preview,
    environment: &str,
    thread: &str,
    agent: &str,
    status: &mut Value,
) {
    let default = preview.desktop_default_tab(environment, thread, agent);
    let mut listing = json!({});
    add_desktop_tabs(preview, environment, thread, agent, &mut listing).await;
    let mut tabs: Vec<Value> = listing
        .get("tabs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // `false` sorts first, and the sort is stable: the default tab leads, the rest keep order.
    tabs.sort_by_key(|tab| tab.get("tabId").and_then(Value::as_str) != default.as_deref());
    let server = preview.status(thread, agent, None);
    if let Some(server_tabs) = server.get("tabs").and_then(Value::as_array) {
        tabs.extend(server_tabs.iter().cloned());
    }
    if status.is_object() && !tabs.is_empty() {
        status["tabs"] = Value::Array(tabs);
    }
}

/// How long a call waits for a desktop tab it asked the desktop to open.
const DESKTOP_TAB_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// With a desktop connected and no desktop tab on the thread, asks the desktop to open its
/// Browser panel (without taking the window's focus) and waits for the tab it makes to register.
/// Without a desktop, or if it does not answer, nothing changes: the server's browser serves.
async fn open_desktop_tab(cx: &Cx<'_>, preview: &Preview, environment: &str, thread: &str) {
    if !preview.desktop_tabs(environment, thread).is_empty() {
        return;
    }
    let Some(panels) = cx.config().panels.as_ref().filter(|p| p.has_desktop()) else {
        return;
    };
    let request = AgentPanelRequest {
        request_id: format!("preview-open-{}", conn_support::uuid_v4()),
        thread_id: thread.to_owned(),
        panel: AgentPanelKind::Browser,
        tab_id: None,
        sql: None,
        connection: None,
        run: None,
        mcp_server: None,
        mcp_call: None,
        focus_window: false,
    };
    if panels.show(request, DESKTOP_TAB_WAIT).await.is_err() {
        return;
    }
    let deadline = tokio::time::Instant::now() + DESKTOP_TAB_WAIT;
    while preview.desktop_tabs(environment, thread).is_empty()
        && tokio::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn preview_failure(error: conn_preview::Error, operation: &str, args: &Args) -> ToolError {
    let raw = error.to_string();
    let first = raw.lines().next().unwrap_or_default();
    let text = if first.contains("strict mode violation") {
        let api = if matches!(operation, "type" | "select") {
            "locator.evaluate"
        } else {
            "locator.scrollIntoViewIfNeeded"
        };
        format!("{api}: {first}")
    } else {
        first.to_owned()
    };
    let missing = matches!(
        text.as_str(),
        "No server preview tab is open for this thread. Call preview_open first."
            | "The requested server preview tab does not exist."
    );
    let interrupted = text.starts_with("Multiple browser tabs")
        || text.starts_with("Too many server browser tabs")
        || text.starts_with("A browser dialog is pending")
        || text.starts_with("A human controls")
        || text.starts_with("This tab belongs")
        || text.starts_with("This tab has no agent owner");
    let tag = if missing {
        "PreviewAutomationTabNotFoundError"
    } else if interrupted {
        "PreviewAutomationControlInterruptedError"
    } else if text.contains("timed out after") {
        "PreviewAutomationTimeoutError"
    } else if text.contains("__conn_stale_ref")
        || text.contains("while parsing selector")
        || text.contains("Unknown engine")
    {
        "PreviewAutomationInvalidSelectorError"
    } else if text.contains("__conn_not_editable") || text.contains("Element is not an <input>") {
        "PreviewAutomationTargetNotEditableError"
    } else {
        "PreviewAutomationExecutionError"
    };
    let target = if args.contains_key("locator") {
        "locator"
    } else if args.contains_key("selector") {
        "selector"
    } else {
        "focused-element"
    };
    let count = str_arg(args, target)
        .unwrap_or_default()
        .encode_utf16()
        .count();
    let message = if missing {
        str_arg(args, "tabId").map_or_else(
            || format!("No active preview tab was found for {operation}. Call preview_open first."),
            |id| format!("Preview tab {id} was not found for {operation}. Omit tabId to use the current tab, or call preview_open."),
        )
    } else if tag == "PreviewAutomationInvalidSelectorError" {
        let kind = if text.contains("__conn_stale_ref") {
            "stale"
        } else if target == "locator" {
            "invalid.locator"
        } else {
            "invalid.selector"
        };
        conn_preview::tool_error(kind, operation, count)
    } else if tag == "PreviewAutomationTargetNotEditableError" {
        conn_preview::tool_error(&format!("editable.{target}"), operation, count)
    } else if text.starts_with("This tab belongs") {
        "This browser tab belongs to another agent session or a human. Open your own tab.".into()
    } else if interrupted || text.starts_with("Preview automation ") {
        text
    } else {
        format!("Preview automation {operation} failed: {text}")
    };
    ToolError::Preview { tag, message }
}
