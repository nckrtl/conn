//! Page operations over CDP: T3's `PageOperations` (`packages/shared/src/previewPage.ts`), as
//! `conn-preview/src/page.rs` ports them for the server's own browser. Browser-side work uses
//! Playwright's pinned injected DOM engine; Rust owns the transport.

use std::time::Duration;

use serde_json::{Value, json};

use crate::PageError;
use crate::cdp::Cdp;
use crate::spec::{INJECTED_JS, spec};

fn err(error: impl ToString) -> PageError {
    PageError(error.to_string())
}

/// Runs `body` in the page's utility world, where Playwright's `injected` script lives.
pub(crate) async fn utility(cdp: &dyn Cdp, body: &str) -> Result<Value, PageError> {
    let tree = cdp
        .send("Page.getFrameTree", json!({}))
        .await
        .map_err(err)?;
    let frame = tree
        .pointer("/frameTree/frame/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            PageError(
                "The page changed while capturing its snapshot. Take another snapshot.".into(),
            )
        })?;
    let world = cdp
        .send(
            "Page.createIsolatedWorld",
            json!({"frameId": frame, "worldName": "t3-preview"}),
        )
        .await
        .map_err(err)?;
    let context = world
        .get("executionContextId")
        .and_then(Value::as_u64)
        .ok_or_else(|| PageError("The preview page has no execution context.".into()))?;
    let present = cdp
        .send(
            "Runtime.evaluate",
            json!({"contextId": context, "expression": "!!globalThis.__connInjected", "returnByValue": true}),
        )
        .await
        .map_err(err)?;
    if present.pointer("/result/value").and_then(Value::as_bool) != Some(true) {
        let script = format!(
            "(()=>{{const module={{exports:{{}}}};{INJECTED_JS}\nglobalThis.__connInjected=new (module.exports.InjectedScript())(window,{{isUnderTest:false,sdkLanguage:'javascript',testIdAttributeName:'data-testid',stableRafCount:1,browserName:'chromium',customEngines:[],isUtilityWorld:true}});return true;}})()"
        );
        evaluate_world(cdp, context, &script).await?;
    }
    let script = format!("(async()=>{{const injected=globalThis.__connInjected;{body}}})()");
    evaluate_world(cdp, context, &script).await
}

async fn evaluate_world(cdp: &dyn Cdp, context: u64, script: &str) -> Result<Value, PageError> {
    let value = cdp
        .send(
            "Runtime.evaluate",
            json!({"contextId": context, "expression": script, "returnByValue": true, "awaitPromise": true}),
        )
        .await
        .map_err(err)?;
    if let Some(details) = value.get("exceptionDetails") {
        return Err(PageError(
            details
                .pointer("/exception/description")
                .or_else(|| details.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("The browser page operation failed.")
                .into(),
        ));
    }
    Ok(value
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}

/// Values of masked inputs and inputs filled with a credential, to redact results against.
pub(crate) async fn secrets(cdp: &dyn Cdp) -> Result<Vec<String>, PageError> {
    let script = &spec()?.scripts.sensitive;
    let values = utility(cdp, &format!("return {script};")).await?;
    let values = values
        .as_array()
        .ok_or_else(|| PageError("The browser could not check hidden values.".into()))?;
    if values.len() > 64 {
        return Err(PageError(
            "The browser page holds too many hidden values to read safely.".into(),
        ));
    }
    let mut result = Vec::new();
    for value in values {
        if let Some(value) = value.as_str() {
            if value.len() > 4096 {
                return Err(PageError(
                    "A password field holds a value too long to hide, so no snapshot was taken."
                        .into(),
                ));
            }
            if !value.is_empty() {
                result.push(value.to_owned());
            }
        }
    }
    Ok(result)
}

/// Replaces every occurrence of a secret (raw, URI-encoded or JSON-escaped) in the strings and
/// keys of `value` (T3's `redactSensitiveValues`).
pub(crate) fn redact(value: &mut Value, secrets: &[String]) {
    let mut variants = Vec::new();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        variants.push(secret.clone());
        variants.push(encode_component(secret));
        if let Ok(escaped) = serde_json::to_string(secret)
            && let Some(inner) = escaped.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
        {
            variants.push(inner.into());
        }
    }
    variants.sort_by_key(|s| std::cmp::Reverse(s.len()));
    variants.dedup();
    redact_in(value, &variants);
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn redact_in(value: &mut Value, variants: &[String]) {
    let redact_text = |text: &str| {
        if variants
            .iter()
            .any(|s| s.encode_utf16().count() < 4 && s == text)
        {
            return "[redacted]".into();
        }
        let mut text = text.to_owned();
        for secret in variants.iter().filter(|s| s.encode_utf16().count() >= 4) {
            text = text.replace(secret, "[redacted]");
        }
        text
    };
    match value {
        Value::String(text) => *text = redact_text(text),
        Value::Array(items) => {
            for item in items {
                redact_in(item, variants);
            }
        }
        Value::Object(fields) => {
            let original = std::mem::take(fields);
            for (key, mut value) in original {
                redact_in(&mut value, variants);
                fields.insert(redact_text(&key), value);
            }
        }
        _ => {}
    }
}

/// `PageOperations.snapshot`: the page's text, accessibility tree and a screenshot. The
/// screenshot is left out (empty data) when `include_image` is false.
pub(crate) async fn snapshot(
    cdp: &dyn Cdp,
    include_image: bool,
    generation: &str,
) -> Result<Value, PageError> {
    let tree = cdp
        .send("Page.getFrameTree", json!({}))
        .await
        .map_err(err)?;
    // Child-frame snapshots fail closed until their DOM readers can be verified.
    if tree
        .pointer("/frameTree/childFrames")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        return Err(PageError("A frame on the page didn't answer within 1000ms, so its content couldn't be checked for hidden values. Try the snapshot again.".into()));
    }
    let scripts = &spec()?.scripts;
    let read_dotted = format!("return {};", scripts.dotted);
    let before = utility(cdp, &read_dotted).await?;
    let mut page = utility(
        cdp,
        &format!(
            "globalThis.__connRefGeneration={};const result={};const tree=injected.ariaSnapshot(document.body,{{mode:'ai',boxes:true}});const MASKED_VALUE='••••••••';const ServerBrowserOperationError=Error;{}const dotted=dottedPattern({});result.url=withoutDataPayload(result.url);const safeTree=withoutTreeDataPayloads(tree);result.visibleText=dotted?result.visibleText.replace(dotted,MASKED_VALUE):result.visibleText;result.accessibilityTree=(dotted?maskTree(safeTree,dotted):safeTree).replace(/\\[ref=((?:f\\d+)?e\\d+)\\]/g,(_,ref)=>'[ref=t3-'+globalThis.__connRefGeneration+'-'+ref+']');return result;",
            json!(generation),
            scripts.snapshot,
            scripts.mask,
            before
        ),
    )
    .await?;
    let metrics = cdp
        .send("Page.getLayoutMetrics", json!({}))
        .await
        .map_err(err)?;
    let width = metrics
        .pointer("/cssVisualViewport/clientWidth")
        .and_then(Value::as_f64)
        .unwrap_or(1280.);
    let height = metrics
        .pointer("/cssVisualViewport/clientHeight")
        .and_then(Value::as_f64)
        .unwrap_or(800.);
    let scale = (1280. / (width * 2.)).min(1.);
    let data = if include_image {
        let screenshot = cdp
            .send(
                "Page.captureScreenshot",
                json!({"format":"png","captureBeyondViewport":false,"clip":{"x":0,"y":0,"width":width,"height":height,"scale":scale}}),
            )
            .await
            .map_err(err)?;
        screenshot
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        String::new()
    };
    let after = utility(cdp, &read_dotted).await?;
    if before != after {
        return Err(PageError(
            "The page changed while capturing its snapshot. Take another snapshot.".into(),
        ));
    }
    for key in ["visibleText", "accessibilityTree"] {
        if let Some(text) = page.get(key).and_then(Value::as_str).map(str::to_owned) {
            page[key] = json!(text.chars().take(20_000).collect::<String>());
        }
    }
    page["consoleEntries"] = json!([]);
    page["networkEntries"] = json!([]);
    page["actionTimeline"] = json!([]);
    page["screenshot"] = json!({
        "mimeType": "image/png",
        "width": (width * 2. * scale).round() as u64,
        "height": (height * 2. * scale).round() as u64,
        "data": data,
    });
    Ok(page)
}

const LOCATOR_JS: &str = r#"const raw=input.locator??input.selector;let selector=raw;if(selector?.startsWith('aria-ref=')){const match=/^aria-ref=t3-(\S+?)-((?:f\d+)?e\d+)$/.exec(selector);if(!match||match[1]!==globalThis.__connRefGeneration)throw Error('__conn_stale_ref');selector='aria-ref='+match[2];}const parsed=selector===undefined?null:injected.parseSelector(selector);const element=parsed===null?document.activeElement:injected.querySelector(parsed,document,true);"#;

/// The absolute upload paths in `input`.
pub(crate) fn upload_paths(input: &Value) -> Result<&Vec<Value>, PageError> {
    let paths = input
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| PageError("Upload paths are missing.".into()))?;
    for path in paths {
        let path = path
            .as_str()
            .ok_or_else(|| PageError("Upload paths are missing.".into()))?;
        if !std::path::Path::new(path).is_absolute() {
            return Err(PageError(format!("Upload paths must be absolute: {path}")));
        }
    }
    Ok(paths)
}

/// `click`, `hover`, `type`, `select`, `press`, `scroll`, `drag` and `upload` (into a located
/// file input).
pub(crate) async fn action(cdp: &dyn Cdp, action: &str, input: &Value) -> Result<Value, PageError> {
    let input_json = serde_json::to_string(input).map_err(err)?;
    if action == "press" {
        return press(cdp, input).await;
    }
    if action == "scroll" {
        utility(cdp, &format!("const input={input_json};{LOCATOR_JS}if(!element&&parsed)throw Error('The target element is not attached.');(parsed?element:window).scrollBy(input.deltaX??0,input.deltaY??0);return null;")).await?;
        return Ok(json!({}));
    }
    if action == "type" {
        let result = utility(cdp, &format!("const input={input_json};{LOCATOR_JS}if(!element)throw Error('__conn_not_editable');const state=await injected.checkElementStates(element,['visible','enabled','editable']);if(state&&state!=='done')throw Error('__conn_not_editable');if(input.clear)return injected.fill(element,input.text);injected.focusNode(element,false);return 'needsinput';")).await?;
        if result.as_str() == Some("needsinput") {
            cdp.send(
                "Input.insertText",
                json!({"text": input.get("text").and_then(Value::as_str).unwrap_or_default()}),
            )
            .await
            .map_err(err)?;
        }
        return Ok(json!({}));
    }
    if action == "select" {
        return utility(cdp, &format!("const input={input_json};{LOCATOR_JS}if(!element||element.tagName!=='SELECT')throw Error('__conn_not_editable');const values=input.values.map(v=>{{const option=[...element.options].find(o=>o.value===v)??[...element.options].find(o=>o.label.trim()===v.trim());return {{value:option?.value??v}};}});const selected=injected.selectOptions(element,values);return {{selected}};")).await;
    }
    if action == "upload" {
        let paths = input.get("paths");
        let node = utility(cdp, &format!("const input={input_json};{LOCATOR_JS}if(!element||element.tagName!=='INPUT'||element.type!=='file')throw Error('__conn_not_editable');element.setAttribute('data-conn-upload', 'active');return true;")).await?;
        if node != true {
            return Err(PageError("The upload target is not available.".into()));
        }
        let result = async {
            let doc = cdp.send("DOM.getDocument", json!({})).await.map_err(err)?;
            let root = doc
                .pointer("/root/nodeId")
                .and_then(Value::as_u64)
                .ok_or_else(|| PageError("The upload document is not available.".into()))?;
            let node = cdp
                .send(
                    "DOM.querySelector",
                    json!({"nodeId": root, "selector": "[data-conn-upload=active]"}),
                )
                .await
                .map_err(err)?;
            cdp.send(
                "DOM.setFileInputFiles",
                json!({"nodeId": node.get("nodeId"), "files": paths}),
            )
            .await
            .map_err(err)?;
            Ok::<_, PageError>(())
        }
        .await;
        let cleared = utility(cdp, "for (const node of document.querySelectorAll('[data-conn-upload=active]')) node.removeAttribute('data-conn-upload');return null;").await;
        result?;
        cleared?;
        return Ok(json!({}));
    }
    if action == "drag" {
        let from = point(cdp, &json!({"locator": input.get("source")})).await?;
        let to = point(cdp, &json!({"locator": input.get("target")})).await?;
        mouse(cdp, "mouseMoved", &from, "none", 0).await?;
        mouse(cdp, "mousePressed", &from, "left", 1).await?;
        mouse(cdp, "mouseMoved", &to, "left", 1).await?;
        mouse(cdp, "mouseReleased", &to, "left", 1).await?;
        return Ok(json!({}));
    }
    let point = point(cdp, input).await?;
    mouse(cdp, "mouseMoved", &point, "none", 0).await?;
    if action == "click" {
        let button = input
            .get("button")
            .and_then(Value::as_str)
            .unwrap_or("left");
        let count = input.get("clickCount").and_then(Value::as_u64).unwrap_or(1);
        for click in 1..=count {
            mouse(cdp, "mousePressed", &point, button, click).await?;
            mouse(cdp, "mouseReleased", &point, button, click).await?;
        }
    }
    Ok(json!({}))
}

async fn point(cdp: &dyn Cdp, input: &Value) -> Result<Value, PageError> {
    if input.get("x").is_some() && input.get("y").is_some() {
        return Ok(json!({"x": input.get("x"), "y": input.get("y")}));
    }
    let input = serde_json::to_string(input).map_err(err)?;
    loop {
        let result = utility(cdp, &format!("const input={input};{LOCATOR_JS}if(!element)throw Error('The target element is not attached.');const state=await injected.checkElementStates(element,['visible','stable','enabled']);if(state)throw Error('The target element is not ready.');element.scrollIntoView({{block:'center',inline:'center'}});const rect=element.getBoundingClientRect();const point={{x:Math.max(0,rect.x)+Math.min(rect.width,innerWidth-Math.max(0,rect.x))/2,y:Math.max(0,rect.y)+Math.min(rect.height,innerHeight-Math.max(0,rect.y))/2}};const hit=injected.expectHitTarget(point,element);if(hit!=='done')throw Error('The target element is obscured.');return point;")).await;
        match result {
            Err(error) if error.0.contains("The target element is") => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            result => return result,
        }
    }
}

async fn mouse(
    cdp: &dyn Cdp,
    kind: &str,
    point: &Value,
    button: &str,
    count: u64,
) -> Result<(), PageError> {
    cdp.send(
        "Input.dispatchMouseEvent",
        json!({"type": kind, "x": point.get("x"), "y": point.get("y"), "button": button, "clickCount": count}),
    )
    .await
    .map_err(err)?;
    Ok(())
}

async fn press(cdp: &dyn Cdp, input: &Value) -> Result<Value, PageError> {
    let mut chord = input
        .get("modifiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut building = String::new();
    for c in input
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
    {
        if c == '+' && !building.is_empty() {
            chord.push(std::mem::take(&mut building));
        } else {
            building.push(c);
        }
    }
    chord.push(building);
    let keys = &spec()?.keys;
    let descriptions = chord
        .iter()
        .map(|name| {
            keys.get(if name == "ControlOrMeta" {
                "Control"
            } else {
                name.as_str()
            })
            .cloned()
            .ok_or_else(|| PageError(format!("keyboard.press: Unknown key: \"{name}\"")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut modifiers = 0u64;
    for description in &descriptions {
        modifiers |= modifier(description);
        dispatch_key(cdp, description, modifiers, true).await?;
    }
    for description in descriptions.iter().rev() {
        modifiers &= !modifier(description);
        dispatch_key(cdp, description, modifiers, false).await?;
    }
    Ok(json!({}))
}

fn modifier(description: &Value) -> u64 {
    match description.get("key").and_then(Value::as_str) {
        Some("Alt") => 1,
        Some("Control") => 2,
        Some("Meta") => 4,
        Some("Shift") => 8,
        _ => 0,
    }
}

async fn dispatch_key(
    cdp: &dyn Cdp,
    description: &Value,
    modifiers: u64,
    down: bool,
) -> Result<(), PageError> {
    let description = if modifiers & 8 != 0 {
        description.get("shifted").unwrap_or(description)
    } else {
        description
    };
    let text = if modifiers & 7 == 0 {
        description
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        ""
    };
    cdp.send(
        "Input.dispatchKeyEvent",
        json!({
            "type": if !down { "keyUp" } else if text.is_empty() { "rawKeyDown" } else { "keyDown" },
            "key": description.get("key"),
            "code": description.get("code"),
            "windowsVirtualKeyCode": description.get("keyCode"),
            "location": description.get("location"),
            "text": if down { text } else { "" },
            "modifiers": modifiers,
        }),
    )
    .await
    .map_err(err)?;
    Ok(())
}

/// `PageOperations.waitFor`.
pub(crate) async fn wait_for(cdp: &dyn Cdp, input: &Value) -> Result<Value, PageError> {
    let timeout = input
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(15_000);
    let script = format!(
        "const input={input};{LOCATOR_JS}return (parsed===null||injected.querySelectorAll(parsed,document).length>0)&&(input.text===undefined||(document.body?.innerText??'').includes(input.text))&&(input.urlIncludes===undefined||location.href.includes(input.urlIncludes));"
    );
    let result = tokio::time::timeout(Duration::from_millis(timeout), async {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match utility(cdp, &script).await {
                Ok(value) if value == true => return Ok(json!({})),
                Err(error) if error.0.contains("__conn_stale_ref") => return Err(error),
                _ => {}
            }
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        Err(PageError(format!(
            "Preview automation waitFor timed out after {timeout}ms."
        )))
    })
}

/// What a click that timed out may have done to its target (`namedTargetTimeout`).
pub(crate) async fn target_timeout(cdp: &dyn Cdp, input: &Value) -> String {
    let selector = input.get("locator").or_else(|| input.get("selector"));
    let Some(selector) = selector else {
        return String::new();
    };
    let target = serde_json::to_string(selector).unwrap_or_default();
    let target = if target.chars().count() > 200 {
        format!("{}...", target.chars().take(200).collect::<String>())
    } else {
        target
    };
    let script = format!(
        "const input={input};{LOCATOR_JS}return injected.querySelectorAll(parsed,document).length;"
    );
    match tokio::time::timeout(Duration::from_millis(250), utility(cdp, &script)).await {
        Ok(Ok(value)) if value.as_u64() == Some(0) => format!(
            " The click may have happened and removed its target or navigated; check the page before retrying. No element matches {target} after the timeout; take a fresh snapshot and use its locator."
        ),
        Ok(Ok(_)) => format!(
            " The click may have happened; check the page before retrying. {target} still matches an element after the timeout."
        ),
        _ => format!(
            " The click may have happened; check the page before retrying. Whether {target} still matches an element is unknown."
        ),
    }
}

/// `PageOperations.evaluate`.
pub(crate) async fn evaluate(
    cdp: &dyn Cdp,
    input: &Value,
    timeout_ms: u64,
) -> Result<Value, PageError> {
    let expression = input.get("expression").cloned().unwrap_or(Value::Null);
    let params = json!({
        "expression": expression,
        "awaitPromise": input.get("awaitPromise").and_then(Value::as_bool).unwrap_or(true),
        "returnByValue": true,
    });
    let first = tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        cdp.send("Runtime.evaluate", params.clone()),
    )
    .await;
    let mut result = match first {
        Ok(result) => result.map_err(err)?,
        Err(_) => return Err(evaluation_timeout(cdp, timeout_ms).await),
    };
    // A parse error has a scriptId but no stack and ran nothing, so the REPL mode (top-level
    // await) can retry it.
    if result
        .pointer("/exceptionDetails/exception/className")
        .and_then(Value::as_str)
        == Some("SyntaxError")
        && result.pointer("/exceptionDetails/scriptId").is_some()
        && result.pointer("/exceptionDetails/stackTrace").is_none()
        && input
            .get("expression")
            .and_then(Value::as_str)
            .is_some_and(|s| s.contains("await"))
    {
        let mut params = params;
        params["replMode"] = json!(true);
        result = match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            cdp.send("Runtime.evaluate", params),
        )
        .await
        {
            Ok(result) => result.map_err(err)?,
            Err(_) => return Err(evaluation_timeout(cdp, timeout_ms).await),
        };
    }
    if let Some(details) = result.get("exceptionDetails") {
        return Err(PageError(
            details
                .pointer("/exception/description")
                .or_else(|| details.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("JavaScript failed.")
                .to_owned(),
        ));
    }
    let value = result
        .pointer("/result/value")
        .cloned()
        .or_else(|| result.pointer("/result/description").cloned())
        .unwrap_or(Value::Null);
    let bytes = serde_json::to_vec(&value).map_err(err)?.len();
    if bytes > MAX_EVALUATION_BYTES {
        return Err(PageError(format!(
            "__conn_result_too_large Evaluation result is {bytes} bytes; the limit is {MAX_EVALUATION_BYTES}."
        )));
    }
    Ok(value)
}

/// T3's `MAX_EVALUATION_BYTES`.
pub(crate) const MAX_EVALUATION_BYTES: usize = 64_000;

async fn evaluation_timeout(cdp: &dyn Cdp, timeout_ms: u64) -> PageError {
    // Stops a busy script; an awaited promise is abandoned and settles unread.
    let _ = cdp.send("Runtime.terminateExecution", json!({})).await;
    PageError(format!(
        "__conn_timeout Evaluation did not finish within {timeout_ms}ms and was stopped."
    ))
}

/// `PageOperations.credentialLocked`.
pub(crate) async fn credential_locked(cdp: &dyn Cdp) -> Result<bool, PageError> {
    let value = cdp
        .send(
            "Runtime.evaluate",
            json!({"expression": "window[\"__t3codeCredentialLocked\"] === true", "returnByValue": true}),
        )
        .await
        .map_err(err)?;
    value
        .pointer("/result/value")
        .and_then(Value::as_bool)
        .ok_or_else(|| PageError("Credential lock state could not be checked.".into()))
}

/// `PageOperations.fillCredential`: inserts a test-login value into the input the field
/// expression finds. The value goes only to CDP: never into an expression, a result, an error
/// or the action timeline.
pub(crate) async fn fill_credential(
    cdp: &dyn Cdp,
    page_origin: impl Fn() -> Option<String>,
    input: &Value,
    remember: impl Fn(&str),
) -> Result<Value, PageError> {
    const GROUP: &str = "t3code-credential-fill";
    let status = |status: &str| Ok(json!({ "status": status }));
    let expected = input
        .get("expectedOrigin")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let field = input.get("field").cloned().unwrap_or(Value::Null);
    if page_origin().as_deref() != Some(expected) {
        return status("origin_mismatch");
    }
    let scripts = &spec()?.scripts;
    let call = |object: String, declaration: String, arguments: Vec<Value>| async move {
        let response = cdp
            .send(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object, "functionDeclaration": declaration,
                    "arguments": arguments.into_iter().map(|value| json!({"value": value})).collect::<Vec<_>>(),
                    "returnByValue": true, "userGesture": true,
                }),
            )
            .await
            .ok()?;
        if response.get("exceptionDetails").is_some() {
            return None;
        }
        response
            .pointer("/result/value")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let outcome = async {
        let found = cdp
            .send(
                "Runtime.evaluate",
                json!({"expression": input.get("fieldExpression"), "returnByValue": false, "objectGroup": GROUP}),
            )
            .await
            .ok();
        let object = found
            .as_ref()
            .filter(|f| f.get("exceptionDetails").is_none())
            .filter(|f| f.pointer("/result/subtype").and_then(Value::as_str) == Some("node"))
            .and_then(|f| f.pointer("/result/objectId").and_then(Value::as_str))
            .map(str::to_owned);
        let Some(object) = object else {
            return "field_not_found";
        };
        match call(
            object.clone(),
            scripts.credential_prepare.clone(),
            vec![field.clone()],
        )
        .await
        .as_deref()
        {
            Some("ready") => {}
            Some("not_editable") => return "not_editable",
            _ => return "insert_failed",
        }
        // The page may have navigated while the field was found.
        if page_origin().as_deref() != Some(expected) {
            return "origin_mismatch";
        }
        let value = input.get("value").cloned().unwrap_or(Value::Null);
        // Remembered before it goes in, so redaction covers it from then on.
        if field != "username"
            && let Some(secret) = value.as_str()
        {
            remember(secret);
        }
        match call(
            object,
            scripts.credential_insert.clone(),
            vec![field.clone(), value, json!(expected), json!(false)],
        )
        .await
        .as_deref()
        {
            Some("filled") => "filled",
            Some("origin_mismatch") => "origin_mismatch",
            _ => "insert_failed",
        }
    }
    .await;
    let _ = cdp
        .send("Runtime.releaseObjectGroup", json!({"objectGroup": GROUP}))
        .await;
    status(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_keys_encoded_values_and_overlapping_secrets_but_keeps_short_substrings() {
        let mut value = json!({"pass word":"raw pass word and pass%20word", "short":"x is fine", "exact":"x", "json":"line\\nsecret"});
        redact(
            &mut value,
            &[
                "pass word".into(),
                "pass".into(),
                "x".into(),
                "line\nsecret".into(),
            ],
        );
        assert_eq!(
            value,
            json!({"[redacted]":"raw [redacted] and [redacted]","short":"x is fine","exact":"[redacted]","json":"[redacted]"})
        );
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_component("a b&c/é"), "a%20b%26c%2F%C3%A9");
        assert_eq!(encode_component("-_.!~*'()"), "-_.!~*'()");
    }
}
