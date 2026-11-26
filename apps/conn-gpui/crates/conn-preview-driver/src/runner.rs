//! Runs agent preview requests on one desktop tab: T3's `DesktopTabRunner`
//! (`apps/desktop/src/preview/DesktopTabRunner.ts`) over CDP.
//!
//! Operations that act on the page run one at a time in the order they arrive. `status`,
//! `credentialLock` and `dialog` skip that queue, so an agent can read the page, and answer a
//! dialog, while an action waits on one. Failures answer with the error's tag and detail, which
//! the server turns into the agent's message.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use conn_contract::{
    DesktopTabBinding, PreviewAutomationOperation, PreviewAutomationRequest,
    PreviewAutomationResponse, PreviewAutomationResponseError, PreviewViewportSetting,
};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::PageError;
use crate::cdp::Cdp;
use crate::page;
use crate::spec::spec;

/// A pending JavaScript dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialogInfo {
    /// `alert`, `confirm`, `prompt` or `beforeunload`.
    pub dialog_type: String,
    pub message: String,
    pub default_value: String,
}

/// A pending file picker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChooserInfo {
    pub multiple: bool,
    pub accept: String,
}

/// The page a runner drives.
pub trait PageTarget: Send + Sync + 'static {
    /// The page's CDP channel, or `None` once the page is gone.
    fn cdp(&self) -> Option<Arc<dyn Cdp>>;
    /// The page's current address.
    fn url(&self) -> String;
    /// The page's title as the host last saw it (readable while a dialog blocks the page).
    fn title(&self) -> String;
    /// The dialog the page waits on, if one is intercepted.
    fn pending_dialog(&self) -> Option<DialogInfo>;
    /// Answers the intercepted dialog. `false` when none is pending.
    fn handle_dialog(&self, accept: bool, prompt_text: Option<&str>) -> bool;
    /// The file picker the page waits on, if one is intercepted.
    fn pending_file_chooser(&self) -> Option<FileChooserInfo>;
    /// Answers the intercepted file picker (`paths` empty cancels it). `false` when none is
    /// pending.
    fn resolve_file_chooser(&self, paths: &[String]) -> bool;
    /// Whether dialogs and file pickers are held for the agent instead of shown to the user.
    fn set_intercepting(&self, intercept: bool);
    /// Calls `callback` when a dialog or file picker opens or closes.
    fn on_dialog_change(&self, callback: Arc<dyn Fn() + Send + Sync>);
    /// Whether an agent action is running on the page (for the host's indicators).
    fn set_agent_active(&self, _active: bool) {}
}

/// A failed operation: T3's `ServerBrowserOperationError`.
#[derive(Clone, Debug, PartialEq)]
pub struct OperationError {
    pub tag: String,
    pub message: String,
    pub detail: Option<Value>,
}

impl OperationError {
    fn new(tag: &str, message: impl Into<String>, detail: Option<Value>) -> Self {
        Self {
            tag: tag.to_owned(),
            message: message.into(),
            detail,
        }
    }

    fn execution(message: impl Into<String>) -> Self {
        Self::new("PreviewAutomationExecutionError", message, None)
    }

    fn interrupted(reason: &str, message: &str) -> Self {
        Self::new(
            "PreviewAutomationControlInterruptedError",
            message,
            Some(json!(reason)),
        )
    }

    /// T3's `toOperationError` for what the page operations raise.
    fn from_page(error: PageError) -> Self {
        let message = error.0;
        let first = message.lines().next().unwrap_or(&message).to_owned();
        let strip = |text: &str, marker: &str| {
            text.strip_prefix(marker)
                .map_or_else(|| text.to_owned(), |rest| rest.trim_start().to_owned())
        };
        if message.contains("__conn_stale_ref") {
            return Self::new(
                "PreviewAutomationInvalidSelectorError",
                "This element ref is stale or belongs to another tab. Take a fresh snapshot and use its locator.",
                Some(json!({"staleRef": true})),
            );
        }
        if message.starts_with("__conn_result_too_large") {
            return Self::new(
                "PreviewAutomationResultTooLargeError",
                strip(&first, "__conn_result_too_large"),
                Some(json!({"maximumBytes": page::MAX_EVALUATION_BYTES})),
            );
        }
        if message.starts_with("__conn_timeout") {
            return Self::new(
                "PreviewAutomationTimeoutError",
                strip(&first, "__conn_timeout"),
                None,
            );
        }
        if message.contains("timed out after") || message.contains("Timeout") {
            return Self::new("PreviewAutomationTimeoutError", first, None);
        }
        let lower = message.to_lowercase();
        if lower.contains("while parsing selector")
            || lower.contains("unknown engine")
            || lower.contains("unexpected token")
        {
            return Self::new("PreviewAutomationInvalidSelectorError", first, None);
        }
        if message.contains("__conn_not_editable")
            || lower.contains("not an <input>")
            || lower.contains("not editable")
            || lower.contains("not an editable")
        {
            return Self::new("PreviewAutomationTargetNotEditableError", first, None);
        }
        Self::execution(first)
    }
}

impl From<PageError> for OperationError {
    fn from(error: PageError) -> Self {
        Self::from_page(error)
    }
}

type OpResult = Result<Value, OperationError>;

const DEFAULT_TIMEOUT_MS: u64 = 15_000;

struct State {
    setting: Value,
    color_scheme: String,
    secrets: Vec<String>,
    last_viewport: Option<(i64, i64)>,
    closed: bool,
}

/// One hosted tab's runner. One per registration, as in T3.
pub struct DesktopTabRunner {
    target: Arc<dyn PageTarget>,
    binding: DesktopTabBinding,
    connection_id: String,
    state: Mutex<State>,
    acting: AtomicBool,
    resolving_dialogs: AtomicUsize,
    /// Serializes the operations that act on the page (T3's `SessionControl` queue).
    queue: tokio::sync::Mutex<()>,
    dialog_changed: Notify,
    snapshots: AtomicUsize,
}

impl std::fmt::Debug for DesktopTabRunner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopTabRunner")
            .field("tab", &self.binding.tab_id)
            .field("connection", &self.connection_id)
            .finish_non_exhaustive()
    }
}

impl DesktopTabRunner {
    /// A runner for `binding`'s tab on `target`, answering as registration `connection_id`.
    #[must_use]
    pub fn new(
        target: Arc<dyn PageTarget>,
        binding: DesktopTabBinding,
        connection_id: String,
    ) -> Arc<Self> {
        let setting = binding
            .snapshot
            .viewport
            .as_ref()
            .and_then(|setting| serde_json::to_value(setting).ok())
            .unwrap_or_else(|| json!({"_tag": "fill"}));
        let color_scheme = binding
            .snapshot
            .color_scheme
            .and_then(|scheme| serde_json::to_value(scheme).ok())
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "system".to_owned());
        let runner = Arc::new(Self {
            target,
            binding,
            connection_id,
            state: Mutex::new(State {
                setting,
                color_scheme,
                secrets: Vec::new(),
                last_viewport: None,
                closed: false,
            }),
            acting: AtomicBool::new(false),
            resolving_dialogs: AtomicUsize::new(0),
            queue: tokio::sync::Mutex::new(()),
            dialog_changed: Notify::new(),
            snapshots: AtomicUsize::new(0),
        });
        let weak = Arc::downgrade(&runner);
        runner.target.on_dialog_change(Arc::new(move || {
            if let Some(runner) = weak.upgrade() {
                runner.dialog_changed.notify_waiters();
                runner.sync_intercepting();
            }
        }));
        runner
    }

    /// The registration this runner answers for.
    #[must_use]
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    /// Stops answering and lets dialogs reach the user again. The page stays open.
    pub fn close(&self) {
        self.lock().closed = true;
        self.acting.store(false, Ordering::Release);
        self.target.set_agent_active(false);
        self.target.set_intercepting(false);
        if self.target.pending_dialog().is_some() {
            self.target.handle_dialog(false, None);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// T3's `ownsDialogs`.
    fn owns_dialogs(&self) -> bool {
        !self.is_closed()
            && (self.acting.load(Ordering::Acquire)
                || self.resolving_dialogs.load(Ordering::Acquire) > 0
                || self.target.pending_dialog().is_some())
    }

    fn sync_intercepting(&self) {
        self.target.set_intercepting(self.owns_dialogs());
    }

    fn set_acting(&self, acting: bool) {
        self.acting.store(acting, Ordering::Release);
        self.target.set_agent_active(acting);
        self.sync_intercepting();
    }

    fn cdp(&self) -> Result<Arc<dyn Cdp>, OperationError> {
        if self.is_closed() {
            return Err(OperationError::interrupted(
                "closed",
                "This browser tab is closed.",
            ));
        }
        self.target
            .cdp()
            .ok_or_else(|| OperationError::interrupted("closed", "This browser tab is closed."))
    }

    /// Answers `request` (T3's `respond`).
    pub async fn respond(&self, request: PreviewAutomationRequest) -> PreviewAutomationResponse {
        let identity = |ok| PreviewAutomationResponse {
            client_id: "desktop".to_owned(),
            connection_id: self.connection_id.clone(),
            request_id: request.request_id.clone(),
            ok,
            result: None,
            error: None,
        };
        match self.execute(&request).await {
            Ok(mut result) => {
                // Pixels follow the same credential lock policy as server snapshots.
                let screenshot = (request.operation == PreviewAutomationOperation::Snapshot)
                    .then(|| result.as_object_mut().and_then(|o| o.remove("screenshot")))
                    .flatten();
                page::redact(&mut result, &self.lock().secrets.clone());
                if let (Some(screenshot), Some(object)) = (screenshot, result.as_object_mut()) {
                    object.insert("screenshot".to_owned(), screenshot);
                }
                PreviewAutomationResponse {
                    result: Some(Some(result)),
                    ..identity(true)
                }
            }
            Err(error) => {
                let mut detail = error.detail;
                if let Some(detail) = detail.as_mut() {
                    page::redact(detail, &self.lock().secrets.clone());
                }
                PreviewAutomationResponse {
                    error: Some(PreviewAutomationResponseError {
                        tag: error.tag,
                        message: "Desktop tab operation failed.".to_owned(),
                        detail: detail.map(Some),
                    }),
                    ..identity(false)
                }
            }
        }
    }

    async fn viewport(&self) -> Result<(i64, i64), OperationError> {
        let metrics = self
            .cdp()?
            .send("Page.getLayoutMetrics", json!({}))
            .await
            .map_err(OperationError::execution)?;
        let read = |key: &str| {
            metrics
                .pointer(&format!("/cssLayoutViewport/{key}"))
                .and_then(Value::as_i64)
        };
        let size = (
            read("clientWidth").unwrap_or_default(),
            read("clientHeight").unwrap_or_default(),
        );
        self.lock().last_viewport = Some(size);
        Ok(size)
    }

    /// Adds the values of masked inputs to what results are redacted against.
    async fn refresh_secrets(&self) -> Result<(), OperationError> {
        let found = page::secrets(&*self.cdp()?).await?;
        let mut state = self.lock();
        for secret in found {
            if !state.secrets.contains(&secret) {
                state.secrets.push(secret);
            }
        }
        Ok(())
    }

    async fn assert_script_allowed(&self) -> Result<(), OperationError> {
        if page::credential_locked(&*self.cdp()?).await? {
            return Err(OperationError::new(
                "PreviewAutomationCredentialLockError",
                "Saved credentials block scripts in this document.",
                None,
            ));
        }
        Ok(())
    }

    /// Runs one request.
    pub async fn execute(&self, request: &PreviewAutomationRequest) -> OpResult {
        if self.is_closed()
            || self.target.cdp().is_none()
            || request.tab_id.as_deref() != Some(self.binding.tab_id.as_str())
            || request.thread_id != self.binding.thread_id
        {
            return Err(OperationError::interrupted(
                "agentMismatch",
                "This desktop tab belongs to another thread.",
            ));
        }
        match request.operation {
            PreviewAutomationOperation::Status => self.status().await,
            PreviewAutomationOperation::CredentialLock => Ok(json!({
                "tabId": self.binding.tab_id,
                "locked": page::credential_locked(&*self.cdp()?).await?,
                "available": true,
            })),
            PreviewAutomationOperation::Snapshot => {
                let _turn = self.queue.lock().await;
                self.snapshot().await
            }
            // Dialog resolution must bypass a click waiting in the serial queue.
            PreviewAutomationOperation::Dialog => self.dialog(request).await,
            _ => {
                let _turn = self.queue.lock().await;
                if self.target.pending_dialog().is_some() {
                    return Err(OperationError::interrupted(
                        "dialogPending",
                        "A browser dialog is pending. Read preview_status and use preview_dialog first.",
                    ));
                }
                self.refresh_secrets().await?;
                self.set_acting(true);
                let result = self.act(request).await;
                self.set_acting(false);
                result
            }
        }
    }

    async fn status(&self) -> OpResult {
        let dialog = self.target.pending_dialog();
        let (title, viewport) = if dialog.is_some() {
            (self.target.title(), self.lock().last_viewport)
        } else {
            let cdp = self.cdp()?;
            let title = cdp
                .send(
                    "Runtime.evaluate",
                    json!({"expression": "document.title", "returnByValue": true}),
                )
                .await
                .ok()
                .and_then(|v| {
                    v.pointer("/result/value")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            (title, Some(self.viewport().await?))
        };
        let url = self.target.url();
        let owner = if self.acting.load(Ordering::Acquire) {
            "agent"
        } else {
            "unclaimed"
        };
        let setting = self.lock().setting.clone();
        let mut result = json!({
            "available": true,
            "visible": true,
            "tabId": self.binding.tab_id,
            "url": url,
            "title": title,
            "loading": false,
            "viewportSetting": setting,
            "viewport": viewport.map(|(width, height)| json!({"width": width, "height": height})),
            "dialog": dialog.map(|d| json!({
                "type": d.dialog_type,
                "message": d.message,
                "defaultValue": d.default_value,
            })),
            "fileChooser": self.target.pending_file_chooser().map(|c| json!({
                "multiple": c.multiple,
                "accept": c.accept,
            })),
            "control": {"owner": owner, "ownedByCaller": true, "generation": 0},
            "tabs": [{
                "tabId": self.binding.tab_id,
                "url": url,
                "host": self.binding.device_name,
                "runtime": "desktop",
                "owner": owner,
            }],
        });
        if self.target.pending_dialog().is_none() {
            self.refresh_secrets().await?;
        }
        page::redact(&mut result, &self.lock().secrets.clone());
        Ok(result)
    }

    async fn snapshot(&self) -> OpResult {
        if self.target.pending_dialog().is_some() {
            return Err(OperationError::interrupted(
                "dialogPending",
                "A browser dialog is pending. Read preview_status.",
            ));
        }
        let cdp = self.cdp()?;
        // Check both sides of capture: a credential fill or disconnect may land while reading.
        let initially_locked = page::credential_locked(&*cdp).await?;
        let sequence = self.snapshots.fetch_add(1, Ordering::AcqRel) + 1;
        let namespace: String = self
            .connection_id
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(8)
            .collect();
        let generation = format!("{namespace}-{sequence:x}");
        let mut snapshot = tokio::time::timeout(
            Duration::from_secs(10),
            page::snapshot(&*cdp, !initially_locked, &generation),
        )
        .await
        .map_err(|_| {
            OperationError::new(
                "PreviewAutomationTimeoutError",
                "Snapshot capture timed out after 10000ms. Try the snapshot again.",
                Some(json!({"timeoutMs": 10_000})),
            )
        })??;
        let locked = page::credential_locked(&*cdp).await?;
        self.refresh_secrets().await?;
        if locked && let Some(screenshot) = snapshot.get_mut("screenshot") {
            *screenshot = json!({
                "mimeType": screenshot.get("mimeType").cloned().unwrap_or(json!("image/png")),
                "width": 0,
                "height": 0,
                "data": "",
            });
        }
        let secrets = self.lock().secrets.clone();
        let screenshot = snapshot
            .as_object_mut()
            .and_then(|o| o.remove("screenshot"));
        page::redact(&mut snapshot, &secrets);
        if let (Some(screenshot), Some(object)) = (screenshot, snapshot.as_object_mut()) {
            object.insert("screenshot".to_owned(), screenshot);
        }
        Ok(snapshot)
    }

    async fn dialog(&self, request: &PreviewAutomationRequest) -> OpResult {
        let accept = request
            .input
            .get("accept")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let prompt = request.input.get("promptText").and_then(Value::as_str);
        if self.target.pending_dialog().is_none() {
            return Err(OperationError::execution("No dialog is pending."));
        }
        self.resolving_dialogs.fetch_add(1, Ordering::AcqRel);
        let handled = self.target.handle_dialog(accept, prompt);
        let result = if handled {
            self.status().await
        } else {
            Err(OperationError::execution("No dialog is pending."))
        };
        self.resolving_dialogs.fetch_sub(1, Ordering::AcqRel);
        self.sync_intercepting();
        result
    }

    /// The operations that act on the page, inside the queue.
    async fn act(&self, request: &PreviewAutomationRequest) -> OpResult {
        let cdp = self.cdp()?;
        let input = &request.input;
        let timeout = input
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .or_else(|| u64::try_from(request.timeout_ms).ok().filter(|ms| *ms > 0))
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        let operation = serde_json::to_value(request.operation)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        match request.operation {
            PreviewAutomationOperation::Navigate => {
                self.navigate(&*cdp, input, timeout).await?;
                self.status().await
            }
            // This host serves one tab, so `open` on it is showing that tab: it loads the address
            // the agent gave, else answers with the tab as it is. Servers before Conn Server 0.5.4
            // send `open` for a named desktop tab instead of turning it into a navigation.
            PreviewAutomationOperation::Open => {
                if open_names_a_target(input) {
                    self.navigate(&*cdp, input, timeout).await?;
                }
                self.status().await
            }
            PreviewAutomationOperation::Click
            | PreviewAutomationOperation::Type
            | PreviewAutomationOperation::Hover
            | PreviewAutomationOperation::Drag
            | PreviewAutomationOperation::Press
            | PreviewAutomationOperation::Scroll => {
                let mut input = input.clone();
                if let Some(args) = input.as_object_mut() {
                    args.remove("action");
                }
                let run = tokio::time::timeout(
                    Duration::from_millis(timeout),
                    page::action(&*cdp, &operation, &input),
                );
                // A click that opens a dialog does not finish until the dialog is answered.
                let dialog_opened = async {
                    loop {
                        let changed = self.dialog_changed.notified();
                        if self.target.pending_dialog().is_some() {
                            return;
                        }
                        changed.await;
                    }
                };
                let outcome = if request.operation == PreviewAutomationOperation::Click {
                    tokio::select! {
                        outcome = run => Some(outcome),
                        () = dialog_opened => None,
                    }
                } else {
                    Some(run.await)
                };
                match outcome {
                    None => Ok(json!({})),
                    Some(Ok(result)) => result.map(|_| json!({})).map_err(Into::into),
                    Some(Err(_)) => {
                        let reason = if request.operation == PreviewAutomationOperation::Click {
                            page::target_timeout(&*cdp, &input).await
                        } else {
                            String::new()
                        };
                        Err(OperationError::new(
                            "PreviewAutomationTimeoutError",
                            format!(
                                "Preview automation {operation} timed out after {timeout}ms.{reason}"
                            ),
                            (!reason.is_empty()).then(|| json!({"reason": reason.trim()})),
                        ))
                    }
                }
            }
            PreviewAutomationOperation::Select => {
                let result = page::action(&*cdp, "select", input).await?;
                self.refresh_secrets().await?;
                Ok(result)
            }
            PreviewAutomationOperation::WaitFor => {
                page::wait_for(&*cdp, input).await?;
                Ok(json!({}))
            }
            PreviewAutomationOperation::Upload => {
                page::upload_paths(input)?;
                let located = input.get("locator").is_some() || input.get("selector").is_some();
                if located {
                    page::action(&*cdp, "upload", input).await?;
                } else {
                    if self.target.pending_file_chooser().is_none() {
                        return Err(OperationError::execution(
                            "No file picker is open. Click the upload control first, or pass a file input locator.",
                        ));
                    }
                    let paths = page::upload_paths(input)?
                        .iter()
                        .filter_map(|p| p.as_str().map(str::to_owned))
                        .collect::<Vec<_>>();
                    self.target.resolve_file_chooser(&paths);
                }
                Ok(json!({}))
            }
            PreviewAutomationOperation::CredentialFill => {
                self.assert_script_allowed().await?;
                let target = self.target.clone();
                let secrets = &self.state;
                let result = page::fill_credential(
                    &*cdp,
                    move || origin_of(&target.url()),
                    input,
                    |value| {
                        let mut state = secrets.lock().unwrap_or_else(PoisonError::into_inner);
                        if !state.secrets.iter().any(|held| held == value) {
                            state.secrets.push(value.to_owned());
                        }
                    },
                )
                .await?;
                Ok(result)
            }
            PreviewAutomationOperation::Evaluate => {
                self.assert_script_allowed().await?;
                let value = page::evaluate(&*cdp, input, timeout).await?;
                self.refresh_secrets().await?;
                let mut value = value;
                page::redact(&mut value, &self.lock().secrets.clone());
                Ok(value)
            }
            PreviewAutomationOperation::Resize => {
                let setting = resolve_viewport(input)?;
                if setting.get("_tag").and_then(Value::as_str) == Some("fill") {
                    cdp.send("Emulation.clearDeviceMetricsOverride", json!({}))
                        .await
                        .map_err(OperationError::execution)?;
                } else {
                    cdp.send(
                        "Emulation.setDeviceMetricsOverride",
                        json!({
                            "width": setting.get("width"),
                            "height": setting.get("height"),
                            "deviceScaleFactor": 0,
                            "mobile": false,
                        }),
                    )
                    .await
                    .map_err(OperationError::execution)?;
                }
                self.lock().setting = setting.clone();
                let (width, height) = self.viewport().await?;
                Ok(json!({
                    "tabId": self.binding.tab_id,
                    "setting": setting,
                    "viewport": {"width": width, "height": height},
                }))
            }
            PreviewAutomationOperation::SetColorScheme => {
                let scheme = input
                    .get("colorScheme")
                    .and_then(Value::as_str)
                    .filter(|s| matches!(*s, "system" | "light" | "dark"))
                    .ok_or_else(|| OperationError::execution("Invalid color scheme."))?
                    .to_owned();
                cdp.send(
                    "Emulation.setEmulatedMedia",
                    json!({"features": [{
                        "name": "prefers-color-scheme",
                        "value": if scheme == "system" { "" } else { scheme.as_str() },
                    }]}),
                )
                .await
                .map_err(OperationError::execution)?;
                self.lock().color_scheme = scheme.clone();
                Ok(json!({"tabId": self.binding.tab_id, "colorScheme": scheme}))
            }
            // `cdpEndpoint` needs a local endpoint for scripts; this host has none.
            _ => Err(OperationError::execution(format!(
                "Not supported on desktop tabs: {operation}."
            ))),
        }
    }

    async fn navigate(
        &self,
        cdp: &dyn Cdp,
        input: &Value,
        timeout: u64,
    ) -> Result<(), OperationError> {
        let url = navigation_url(input).ok_or_else(|| {
            OperationError::execution("Not supported on desktop tabs yet. Navigate with a URL.")
        })?;
        let url = normalize_preview_url(url).map_err(OperationError::execution)?;
        let loaded = Arc::new(Notify::new());
        let flag = Arc::new(AtomicBool::new(false));
        let _subscription = {
            let (loaded, flag) = (loaded.clone(), flag.clone());
            cdp.on_event(Arc::new(move |method, _| {
                if method == "Page.domContentEventFired" {
                    flag.store(true, Ordering::Release);
                    loaded.notify_waiters();
                }
            }))
        };
        let _ = cdp.send("Page.enable", json!({})).await;
        let result = cdp
            .send("Page.navigate", json!({"url": url}))
            .await
            .map_err(OperationError::execution)?;
        if let Some(reason) = result.get("errorText").and_then(Value::as_str) {
            return Err(OperationError::execution(format!(
                "page.goto: {reason} at {url}"
            )));
        }
        // Same-document navigations commit without a DOMContentLoaded event.
        if result.get("loaderId").is_none() {
            return Ok(());
        }
        let wait = async {
            loop {
                let notified = loaded.notified();
                if flag.load(Ordering::Acquire) {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(Duration::from_millis(timeout), wait)
            .await
            .map_err(|_| {
                OperationError::new(
                    "PreviewAutomationTimeoutError",
                    format!("page.goto: Timeout {timeout}ms exceeded."),
                    None,
                )
            })
    }
}

/// The address a `navigate` loads: its `url`, else a `target` of kind `url`.
fn navigation_url(input: &Value) -> Option<&str> {
    input.get("url").and_then(Value::as_str).or_else(|| {
        let target = input.get("target")?;
        (target.get("kind").and_then(Value::as_str) == Some("url"))
            .then(|| target.get("url").and_then(Value::as_str))
            .flatten()
    })
}

/// Whether an `open` names somewhere to go: a `url`, or any `target` (a target this host cannot
/// load, such as a port, fails as `navigate` does rather than being dropped).
fn open_names_a_target(input: &Value) -> bool {
    input.get("url").and_then(Value::as_str).is_some() || input.get("target").is_some()
}

/// `new URL(url).origin`, for the credential origin check.
fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

/// T3's `resolvePreviewViewport` for a `resize` input.
pub(crate) fn resolve_viewport(input: &Value) -> Result<Value, OperationError> {
    let mode = input
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let setting = match mode {
        "fill" => json!({"_tag": "fill"}),
        "freeform" => json!({
            "_tag": "freeform",
            "width": input.get("width"),
            "height": input.get("height"),
        }),
        _ => {
            let name = input
                .get("preset")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let preset = spec()
                .map_err(OperationError::from)?
                .presets
                .iter()
                .find(|p| p.get("id").and_then(Value::as_str) == Some(name))
                .ok_or_else(|| OperationError::execution("Unknown viewport preset."))?;
            let (mut width, mut height) = (
                preset.get("width").cloned().unwrap_or(Value::Null),
                preset.get("height").cloned().unwrap_or(Value::Null),
            );
            if input.get("orientation").and_then(Value::as_str) == Some("landscape") {
                std::mem::swap(&mut width, &mut height);
            }
            json!({"_tag": "preset", "presetId": name, "width": width, "height": height})
        }
    };
    // The contract's own decoder rejects sizes the browser cannot take.
    serde_json::from_value::<PreviewViewportSetting>(setting.clone())
        .map_err(|_| OperationError::execution("Invalid viewport size."))?;
    Ok(setting)
}

/// T3's `normalizePreviewUrl` (`packages/shared/src/preview.ts`).
pub(crate) fn normalize_preview_url(raw: &str) -> Result<String, String> {
    let invalid = |reason: &str, protocol: Option<String>| {
        format!(
            "Invalid preview URL ({reason}{}; input length {}). Use an http(s) URL or a schemeless host such as localhost:5173. With preview_open, omit url when creating a new tab to open a blank tab.",
            protocol.map(|p| format!(": {p}")).unwrap_or_default(),
            raw.encode_utf16().count()
        )
    };
    let trimmed = raw.trim();
    let explicit = trimmed
        .split_once(':')
        .map(|(p, _)| p)
        .filter(|p| {
            !p.is_empty()
                && p.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
        })
        .map(|s| format!("{}:", s.to_ascii_lowercase()));
    if trimmed.is_empty() {
        return Err(invalid("empty", None));
    }
    let non_web: HashSet<&str> = spec()
        .map(|s| s.non_web_schemes.iter().map(String::as_str).collect())
        .unwrap_or_default();
    if explicit.as_deref().is_some_and(|p| non_web.contains(p)) {
        return Err(invalid("unsupported-protocol", explicit));
    }
    let host = trimmed.split(['/', ':']).next().unwrap_or_default();
    let local = matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "0.0.0.0"
    ) || trimmed.starts_with("[::1]")
        || trimmed.starts_with("[::]");
    let has_scheme = explicit.is_some() && trimmed.contains("://");
    let candidate = if has_scheme {
        trimmed.to_owned()
    } else {
        format!("{}://{trimmed}", if local { "http" } else { "https" })
    };
    let url = url::Url::parse(&candidate)
        .map_err(|_| invalid("parse", Some(if local { "http:" } else { "https:" }.into())))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid(
            "unsupported-protocol",
            Some(format!("{}:", url.scheme())),
        ));
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests;
