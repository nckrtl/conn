//! Hosts the Browser panel's tabs for agents, as T3 Conn's desktop does (`hostDesktopTab`).
//!
//! Every browser tab of every thread this app holds is a desktop tab on its thread's server:
//! the host opens its record (`preview.open`), registers it (`preview.desktopRegister`), runs the
//! agent requests the server relays (`preview.desktopRequests`) on the tab's Chromium page, and
//! reports navigation (`preview.reportStatus`). A tab that closes releases its registration and
//! record. The relay logic lives in [`conn_client::preview`]; the page work in
//! [`conn_preview_driver`]; this file ties both to the app's tabs.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use conn_client::Connection;
use conn_client::preview::{
    DesktopTabExecutor, DesktopTabHost, HostOptions, HostedTabState, PreviewApi,
};
use conn_contract::{
    DesktopTabBinding, PreviewAutomationOperation, PreviewAutomationRequest,
    PreviewAutomationResponse, PreviewCloseInput, PreviewNavStatus, PreviewNavStatusLoadFailed,
    PreviewNavStatusLoading, PreviewNavStatusSuccess, PreviewOpenInput, PreviewOpenInputRuntime,
    PreviewReportStatusInput, PreviewSessionSnapshot, PreviewViewportSetting,
    PreviewViewportSettingFill, lit,
};
use conn_preview_driver::{
    Cdp, CdpFuture, DesktopTabRunner, DialogInfo, EventListener, FileChooserInfo, PageTarget,
    Subscription,
};
use conn_state::{BrowserTabId, PanelOwner};
use conn_web::{CdpHandle, PageControl};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

/// How long a request waits for a tab's page to exist before it answers as unavailable.
const PAGE_WAIT: Duration = Duration::from_secs(15);
const PAGE_POLL: Duration = Duration::from_millis(50);
/// How long the host waits before it retries opening a tab's record.
const OPEN_RETRY: Duration = Duration::from_secs(1);

/// What the host asks the UI thread to do: the page lives in a GPUI entity.
#[derive(Debug)]
pub(crate) enum UiRequest {
    /// Make tab `0`'s browser and its Chromium page, even while hidden.
    Materialize(BrowserTabId),
}

/// What the host reads from a tab's page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PageFacts {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// `(code, description)` of the last main-frame load that failed.
    pub load_error: Option<(i64, String)>,
}

/// A tab's page as the host sees it: thread-safe facts and, while Chromium has a view for the
/// tab, the channel to drive it. The same handle serves the tab across browsers the panel closes
/// and makes again.
#[derive(Default)]
pub(crate) struct BrowserHandle {
    facts: Mutex<PageFacts>,
    control: Mutex<Option<PageControl>>,
    dialog_listener: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
    intercepting: AtomicBool,
    focus_emulated: AtomicBool,
}

impl std::fmt::Debug for BrowserHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserHandle").finish_non_exhaustive()
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl BrowserHandle {
    /// Records the page's facts. Returns `true` if they changed.
    pub(crate) fn set_facts(&self, facts: PageFacts) -> bool {
        let mut held = locked(&self.facts);
        if *held == facts {
            return false;
        }
        *held = facts;
        true
    }

    pub(crate) fn facts(&self) -> PageFacts {
        locked(&self.facts).clone()
    }

    /// The tab's address and title while it has no page, so a status read can answer.
    pub(crate) fn set_resting_facts(&self, url: &str, title: &str) {
        if locked(&self.control).is_none() {
            let mut facts = locked(&self.facts);
            if facts.url != url || facts.title != title {
                facts.url = url.to_owned();
                facts.title = title.to_owned();
            }
        }
    }

    /// The Chromium page came or went.
    pub(crate) fn set_control(&self, control: Option<PageControl>) {
        self.focus_emulated.store(false, Ordering::Release);
        if let Some(control) = &control {
            let listener = self.dialog_listener.clone();
            control.on_dialog_change(move || {
                let callback = locked(&listener).clone();
                if let Some(callback) = callback {
                    callback();
                }
            });
            let intercept = self.intercepting.load(Ordering::Acquire);
            control.set_intercept_dialogs(intercept);
            control.set_intercept_file_dialogs(intercept);
        }
        *locked(&self.control) = control;
    }

    pub(crate) fn control(&self) -> Option<PageControl> {
        locked(&self.control).clone()
    }
}

/// Adapts the page's CEF CDP handle to the driver's [`Cdp`].
struct CefCdp(CdpHandle);

impl Cdp for CefCdp {
    fn send(&self, method: &str, params: Value) -> CdpFuture {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.0.send(
            method,
            params,
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        );
        Box::pin(async move {
            rx.await
                .unwrap_or_else(|_| Err("The browser page closed.".to_owned()))
        })
    }

    fn on_event(&self, listener: EventListener) -> Subscription {
        let handle = self.0.clone();
        let id =
            handle.add_event_listener(Arc::new(move |method, params| listener(method, params)));
        Subscription::new(move || handle.remove_event_listener(id))
    }
}

impl PageTarget for BrowserHandle {
    fn cdp(&self) -> Option<Arc<dyn Cdp>> {
        self.control()
            .map(|control| -> Arc<dyn Cdp> { Arc::new(CefCdp(control.cdp())) })
    }

    fn url(&self) -> String {
        locked(&self.facts).url.clone()
    }

    fn title(&self) -> String {
        locked(&self.facts).title.clone()
    }

    fn pending_dialog(&self) -> Option<DialogInfo> {
        self.control()?.pending_js_dialog().map(|d| DialogInfo {
            dialog_type: d.dialog_type,
            message: d.message,
            default_value: d.default_value,
        })
    }

    fn handle_dialog(&self, accept: bool, prompt_text: Option<&str>) -> bool {
        self.control()
            .is_some_and(|control| control.handle_js_dialog(accept, prompt_text))
    }

    fn pending_file_chooser(&self) -> Option<FileChooserInfo> {
        self.control()?
            .pending_file_chooser()
            .map(|c| FileChooserInfo {
                multiple: c.multiple,
                accept: c.accept,
            })
    }

    fn resolve_file_chooser(&self, paths: &[String]) -> bool {
        self.control()
            .is_some_and(|control| control.resolve_file_chooser(paths))
    }

    fn set_intercepting(&self, intercept: bool) {
        self.intercepting.store(intercept, Ordering::Release);
        if let Some(control) = self.control() {
            control.set_intercept_dialogs(intercept);
            control.set_intercept_file_dialogs(intercept);
        }
    }

    fn on_dialog_change(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        // The page's own callback forwards to this slot, whether the page exists yet or not.
        *locked(&self.dialog_listener) = Some(callback);
    }
}

/// The handles of every tab the app knows, shared by the host and the Browser panel.
#[derive(Debug, Default)]
pub(crate) struct Handles(Mutex<HashMap<BrowserTabId, Arc<BrowserHandle>>>);

impl Handles {
    pub(crate) fn get_or_create(&self, id: BrowserTabId) -> Arc<BrowserHandle> {
        locked(&self.0).entry(id).or_default().clone()
    }

    fn get(&self, id: BrowserTabId) -> Option<Arc<BrowserHandle>> {
        locked(&self.0).get(&id).cloned()
    }

    fn remove(&self, id: BrowserTabId) {
        locked(&self.0).remove(&id);
    }
}

/// A browser tab the app holds.
#[derive(Clone, Debug)]
pub(crate) struct DesiredTab {
    pub owner: PanelOwner,
    pub id: BrowserTabId,
    /// The address the tab shows or will load, and its title, while it has no page.
    pub url: String,
    pub title: String,
}

/// An environment's connection, as the host needs it.
#[derive(Clone)]
pub(crate) struct EnvConnection {
    pub environment: String,
    pub api: Arc<dyn PreviewApi>,
    /// The connection behind `api`, to tell a new connection from the same one. `None` in tests,
    /// which keep one `api` per link.
    pub connection: Option<Connection>,
    pub connected: bool,
}

impl EnvConnection {
    /// An environment reached through `connection`.
    pub(crate) fn of(environment: String, connection: &Connection, connected: bool) -> Self {
        Self {
            environment,
            api: Arc::new(connection.clone()),
            connection: Some(connection.clone()),
            connected,
        }
    }
}

struct EnvLink {
    api: Arc<dyn PreviewApi>,
    connection: Option<Connection>,
    connected: watch::Sender<bool>,
}

impl EnvLink {
    fn same(&self, other: &EnvConnection) -> bool {
        match (&self.connection, &other.connection) {
            (Some(a), Some(b)) => a.same_connection(b),
            // Tests keep one `api` per link. Compare the data pointers: two `Arc<dyn>` of one value
            // can carry different vtable pointers.
            (None, None) => std::ptr::addr_eq(Arc::as_ptr(&self.api), Arc::as_ptr(&other.api)),
            _ => false,
        }
    }
}

/// The tab's snapshot as this app holds it (T3's `readThreadPreviewState(...).sessions[tabId]`).
struct TabState {
    snapshot: Mutex<Option<PreviewSessionSnapshot>>,
    device: String,
}

impl HostedTabState for TabState {
    fn snapshot(&self) -> Option<PreviewSessionSnapshot> {
        locked(&self.snapshot).clone()
    }
    fn apply_snapshot(&self, snapshot: PreviewSessionSnapshot) {
        *locked(&self.snapshot) = Some(snapshot);
    }
    fn device_name(&self) -> String {
        self.device.clone()
    }
}

struct HostedTab {
    owner: PanelOwner,
    environment: String,
    state: Arc<TabState>,
    api: Arc<dyn PreviewApi>,
    task: JoinHandle<()>,
    /// Reports go out one at a time, in order: the server keeps the last it hears.
    reports: mpsc::UnboundedSender<PreviewReportStatusInput>,
    report_task: JoinHandle<()>,
    last_reported: Option<(&'static str, String, String)>,
}

/// Hosts the app's browser tabs for agents.
pub(crate) struct PreviewHost {
    runtime: tokio::runtime::Handle,
    device: String,
    handles: Arc<Handles>,
    ui: mpsc::UnboundedSender<UiRequest>,
    envs: HashMap<String, EnvLink>,
    tabs: HashMap<BrowserTabId, HostedTab>,
    /// States of tabs restarting on a new connection: their records stay open.
    kept: HashMap<BrowserTabId, Arc<TabState>>,
    /// Server tabs this app hosts, so no two tabs adopt the same orphaned record.
    claimed: Arc<Mutex<HashSet<String>>>,
}

impl std::fmt::Debug for PreviewHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewHost")
            .field("tabs", &self.tabs.len())
            .finish_non_exhaustive()
    }
}

impl PreviewHost {
    /// A host that runs on `runtime`; `ui` carries what only the UI thread can do.
    pub(crate) fn new(
        runtime: tokio::runtime::Handle,
        device: String,
        ui: mpsc::UnboundedSender<UiRequest>,
    ) -> Self {
        Self {
            runtime,
            device,
            handles: Arc::new(Handles::default()),
            ui,
            envs: HashMap::new(),
            tabs: HashMap::new(),
            kept: HashMap::new(),
            claimed: Arc::default(),
        }
    }

    pub(crate) fn handles(&self) -> Arc<Handles> {
        self.handles.clone()
    }

    pub(crate) fn set_device_name(&mut self, device: String) {
        self.device = device;
    }

    /// Brings the hosted tabs and environment links in line with what the app holds.
    pub(crate) fn sync(&mut self, envs: Vec<EnvConnection>, tabs: Vec<DesiredTab>) {
        let mut renewed = HashSet::new();
        for env in &envs {
            match self.envs.get(&env.environment) {
                Some(link) if link.same(env) => {
                    // Only a change wakes the tabs: `send_replace` would make each of them
                    // register again on every sync.
                    link.connected.send_if_modified(|connected| {
                        let changed = *connected != env.connected;
                        *connected = env.connected;
                        changed
                    });
                }
                _ => {
                    let (connected, _) = watch::channel(env.connected);
                    self.envs.insert(
                        env.environment.clone(),
                        EnvLink {
                            api: env.api.clone(),
                            connection: env.connection.clone(),
                            connected,
                        },
                    );
                    renewed.insert(env.environment.clone());
                }
            }
        }
        self.envs
            .retain(|name, _| envs.iter().any(|env| &env.environment == name));

        let wanted: HashMap<BrowserTabId, &DesiredTab> = tabs
            .iter()
            .filter(|tab| self.envs.contains_key(&tab.owner.environment))
            .map(|tab| (tab.id, tab))
            .collect();
        let stale: Vec<(BrowserTabId, bool)> = self
            .tabs
            .iter()
            .filter_map(|(id, hosted)| {
                let tab = wanted.get(id);
                let gone = tab.is_none_or(|tab| tab.owner != hosted.owner);
                // A renewed connection keeps the tab's record: the tab restarts on the new link.
                let renew = renewed.contains(&hosted.environment);
                // A tab whose environment left the list is dropped without a word: nothing says
                // its server would hear it.
                let closes = gone && self.envs.contains_key(&hosted.environment);
                (gone || renew).then_some((*id, closes))
            })
            .collect();
        for (id, close_record) in stale {
            self.stop(id, close_record);
        }
        for (id, tab) in &wanted {
            let handle = self.handles.get_or_create(*id);
            handle.set_resting_facts(&tab.url, &tab.title);
            if !self.tabs.contains_key(id) {
                self.start(tab);
            }
        }
        // Handles of tabs that are gone no longer matter.
        let live: HashSet<BrowserTabId> = tabs.iter().map(|tab| tab.id).collect();
        locked(&self.handles.0).retain(|id, _| live.contains(id));
    }

    fn start(&mut self, tab: &DesiredTab) {
        let Some(link) = self.envs.get(&tab.owner.environment) else {
            return;
        };
        let api = link.api.clone();
        let connected = link.connected.subscribe();
        let state = self.kept.remove(&tab.id).unwrap_or_else(|| {
            Arc::new(TabState {
                snapshot: Mutex::new(None),
                device: self.device.clone(),
            })
        });
        let executor = Arc::new(HostExecutor {
            tab: tab.id,
            handles: self.handles.clone(),
            ui: self.ui.clone(),
            runner: Mutex::new(None),
            state: state.clone(),
            device: self.device.clone(),
        });
        let target = conn_client::preview::HostedTarget {
            environment_id: tab.owner.environment.clone(),
            thread_id: tab.owner.thread.clone(),
            tab_id: String::new(),
        };
        let task = self.runtime.spawn(drive_tab(
            api.clone(),
            executor,
            state.clone(),
            target,
            connected,
            self.claimed.clone(),
        ));
        let (reports, mut queued) = mpsc::unbounded_channel::<PreviewReportStatusInput>();
        let report_api = api.clone();
        let report_task = self.runtime.spawn(async move {
            while let Some(input) = queued.recv().await {
                let _ = report_api.report_status(input).await;
            }
        });
        self.tabs.insert(
            tab.id,
            HostedTab {
                owner: tab.owner.clone(),
                environment: tab.owner.environment.clone(),
                state,
                api,
                task,
                reports,
                report_task,
                last_reported: None,
            },
        );
    }

    /// Stops hosting tab `id`: its registration ends, and its record closes when the tab itself
    /// is gone.
    fn stop(&mut self, id: BrowserTabId, close_record: bool) {
        let Some(hosted) = self.tabs.remove(&id) else {
            return;
        };
        hosted.task.abort();
        hosted.report_task.abort();
        if !close_record {
            self.kept.insert(id, hosted.state.clone());
        }
        if close_record {
            self.handles.remove(id);
            let snapshot = locked(&hosted.state.snapshot).clone();
            if let Some(snapshot) = snapshot {
                locked(&self.claimed).remove(&snapshot.tab_id);
                let api = hosted.api.clone();
                self.runtime.spawn(async move {
                    let _ = api
                        .close(PreviewCloseInput {
                            thread_id: snapshot.thread_id,
                            tab_id: Some(snapshot.tab_id),
                        })
                        .await;
                });
            }
        }
    }

    /// Reports each tab's navigation to its server (`preview.reportStatus`) when it changed.
    pub(crate) fn report_status(&mut self) {
        for (id, hosted) in &mut self.tabs {
            let Some(snapshot) = locked(&hosted.state.snapshot).clone() else {
                continue;
            };
            let Some(handle) = self.handles.get(*id) else {
                continue;
            };
            let facts = handle.facts();
            let Some((kind, status)) = nav_status(&facts) else {
                continue;
            };
            let key = (kind, facts.url.clone(), facts.title.clone());
            if kind != "LoadFailed" && hosted.last_reported.as_ref() == Some(&key) {
                continue;
            }
            hosted.last_reported = Some(key);
            if let Some(mirror) = locked(&hosted.state.snapshot).as_mut() {
                mirror.nav_status = status.clone();
                mirror.can_go_back = facts.can_go_back;
                mirror.can_go_forward = facts.can_go_forward;
            }
            let input = PreviewReportStatusInput {
                thread_id: snapshot.thread_id,
                tab_id: snapshot.tab_id,
                nav_status: status,
                can_go_back: facts.can_go_back,
                can_go_forward: facts.can_go_forward,
            };
            let _ = hosted.reports.send(input);
        }
    }

    /// Closes every hosted tab's record, for the app's quit. Waits a moment for the server.
    pub(crate) fn close_all(&mut self) {
        let mut closes = Vec::new();
        for (_, hosted) in self.tabs.drain() {
            hosted.task.abort();
            hosted.report_task.abort();
            if let Some(snapshot) = locked(&hosted.state.snapshot).clone() {
                let api = hosted.api.clone();
                closes.push(async move {
                    let _ = api
                        .close(PreviewCloseInput {
                            thread_id: snapshot.thread_id,
                            tab_id: Some(snapshot.tab_id),
                        })
                        .await;
                });
            }
        }
        if closes.is_empty() {
            return;
        }
        let wait = futures::future::join_all(closes);
        let runtime = self.runtime.clone();
        let _ = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    runtime.block_on(async {
                        tokio::time::timeout(Duration::from_millis(750), wait).await
                    })
                })
                .join()
        });
    }

    /// The hosted tabs, each with its server tab id once it has a record.
    #[cfg(test)]
    pub(crate) fn hosted_for_test(&self) -> Vec<(BrowserTabId, Option<String>)> {
        let mut out: Vec<_> = self
            .tabs
            .iter()
            .map(|(id, hosted)| {
                let record = locked(&hosted.state.snapshot)
                    .as_ref()
                    .map(|s| s.tab_id.clone());
                (*id, record)
            })
            .collect();
        out.sort_by_key(|(id, _)| *id);
        out
    }
}

impl Drop for PreviewHost {
    fn drop(&mut self) {
        for hosted in self.tabs.values() {
            hosted.task.abort();
            hosted.report_task.abort();
        }
    }
}

/// T3's `buildReportInput` navigation status; `None` for a blank tab, which is not reported.
fn nav_status(facts: &PageFacts) -> Option<(&'static str, PreviewNavStatus)> {
    let blank = facts.url.is_empty() || facts.url == "about:blank";
    if let Some((code, description)) = &facts.load_error
        && !blank
    {
        return Some((
            "LoadFailed",
            PreviewNavStatus::LoadFailed(PreviewNavStatusLoadFailed {
                tag: lit::LoadFailed,
                url: facts.url.clone(),
                title: facts.title.clone(),
                code: *code,
                description: description.clone(),
                download: None,
            }),
        ));
    }
    if blank {
        return None;
    }
    Some(if facts.loading {
        (
            "Loading",
            PreviewNavStatus::Loading(PreviewNavStatusLoading {
                tag: lit::Loading,
                url: facts.url.clone(),
                title: facts.title.clone(),
            }),
        )
    } else {
        (
            "Success",
            PreviewNavStatus::Success(PreviewNavStatusSuccess {
                tag: lit::Success,
                url: facts.url.clone(),
                title: facts.title.clone(),
            }),
        )
    })
}

/// Opens the tab's record once (`preview.open`), then hosts the tab until the task is aborted.
async fn drive_tab(
    api: Arc<dyn PreviewApi>,
    executor: Arc<HostExecutor>,
    state: Arc<TabState>,
    mut target: conn_client::preview::HostedTarget,
    mut connected: watch::Receiver<bool>,
    claimed: Arc<Mutex<HashSet<String>>>,
) {
    loop {
        if let Some(snapshot) = locked(&state.snapshot).clone() {
            target.tab_id = snapshot.tab_id;
            break;
        }
        if !*connected.borrow() {
            if connected.changed().await.is_err() {
                return;
            }
            continue;
        }
        // A record a previous run of this app left, with no host, becomes this tab's: it is
        // how T3 adopts orphaned tabs, and it keeps the server from filling with dead records.
        if let Ok(listed) = api.list(target.thread_id.clone()).await {
            let orphan = {
                let mut held = locked(&claimed);
                listed
                    .sessions
                    .into_iter()
                    .find(|s| {
                        s.runtime != Some(PreviewOpenInputRuntime::Server)
                            && s.host.is_none()
                            && !held.contains(&s.tab_id)
                    })
                    .inspect(|s| {
                        held.insert(s.tab_id.clone());
                    })
            };
            if let Some(orphan) = orphan {
                *locked(&state.snapshot) = Some(orphan);
                continue;
            }
        }
        let opened = api
            .open(PreviewOpenInput {
                thread_id: target.thread_id.clone(),
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
            .await;
        match opened {
            // A blank tab starts Idle, as T3's empty tab does.
            Ok(snapshot) => {
                locked(&claimed).insert(snapshot.tab_id.clone());
                *locked(&state.snapshot) = Some(snapshot);
            }
            Err(_) => tokio::time::sleep(OPEN_RETRY).await,
        }
    }
    let host = DesktopTabHost::start(
        &tokio::runtime::Handle::current(),
        api,
        executor,
        state,
        target,
        connected,
        HostOptions::default(),
    );
    // The host runs until this task is dropped.
    let _host = host;
    std::future::pending::<()>().await;
}

/// Runs agent requests for one tab on its page.
struct HostExecutor {
    tab: BrowserTabId,
    handles: Arc<Handles>,
    ui: mpsc::UnboundedSender<UiRequest>,
    runner: Mutex<Option<Arc<DesktopTabRunner>>>,
    state: Arc<TabState>,
    device: String,
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

impl HostExecutor {
    /// The tab's page, made if the panel has none yet.
    async fn page(
        handles: Arc<Handles>,
        ui: mpsc::UnboundedSender<UiRequest>,
        tab: BrowserTabId,
    ) -> Result<(Arc<BrowserHandle>, PageControl), String> {
        let handle = handles.get_or_create(tab);
        if let Some(control) = handle.control() {
            return Ok((handle, control));
        }
        let _ = ui.send(UiRequest::Materialize(tab));
        let deadline = tokio::time::Instant::now() + PAGE_WAIT;
        loop {
            if let Some(control) = handle.control() {
                return Ok((handle, control));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("The tab has no page.".to_owned());
            }
            tokio::time::sleep(PAGE_POLL).await;
        }
    }

    /// `status` for a tab that has no page: T3's shape, from what the tab holds.
    fn resting_status(&self, handle: &BrowserHandle) -> Value {
        let facts = handle.facts();
        let tab_id = locked(&self.state.snapshot)
            .as_ref()
            .map(|s| s.tab_id.clone())
            .unwrap_or_default();
        let setting = locked(&self.state.snapshot)
            .as_ref()
            .and_then(|s| s.viewport.as_ref())
            .and_then(|v| serde_json::to_value(v).ok())
            .unwrap_or_else(|| json!({"_tag": "fill"}));
        json!({
            "available": true,
            "visible": false,
            "tabId": tab_id,
            "url": facts.url,
            "title": facts.title,
            "loading": false,
            "viewportSetting": setting,
            "viewport": Value::Null,
            "dialog": Value::Null,
            "fileChooser": Value::Null,
            "control": {"owner": "unclaimed", "ownedByCaller": true, "generation": 0},
            "tabs": [{
                "tabId": tab_id,
                "url": facts.url,
                "host": self.device,
                "runtime": "desktop",
                "owner": "unclaimed",
            }],
        })
    }
}

impl DesktopTabExecutor for HostExecutor {
    fn disconnect(&self) -> BoxFuture<()> {
        let runner = locked(&self.runner).take();
        let handle = self.handles.get(self.tab);
        Box::pin(async move {
            if let Some(runner) = runner {
                runner.close();
            }
            if let Some(handle) = handle
                && let Some(control) = handle.control()
                && handle.focus_emulated.swap(false, Ordering::AcqRel)
            {
                let _ = CefCdp(control.cdp())
                    .send(
                        "Emulation.setFocusEmulationEnabled",
                        json!({"enabled": false}),
                    )
                    .await;
            }
        })
    }

    fn connect(
        &self,
        binding: DesktopTabBinding,
        connection_id: String,
    ) -> BoxFuture<Result<(), String>> {
        let handle = self.handles.get_or_create(self.tab);
        let runner = DesktopTabRunner::new(handle, binding, connection_id);
        *locked(&self.runner) = Some(runner);
        Box::pin(std::future::ready(Ok(())))
    }

    fn execute(
        &self,
        connection_id: String,
        request: PreviewAutomationRequest,
    ) -> BoxFuture<Result<PreviewAutomationResponse, String>> {
        let runner = locked(&self.runner)
            .clone()
            .filter(|runner| runner.connection_id() == connection_id);
        let handles = self.handles.clone();
        let ui = self.ui.clone();
        let tab = self.tab;
        let handle = self.handles.get_or_create(tab);
        let resting = (request.operation == PreviewAutomationOperation::Status
            && handle.control().is_none())
        .then(|| self.resting_status(&handle));
        Box::pin(async move {
            let runner = runner.ok_or_else(|| "The tab is not registered.".to_owned())?;
            if let Some(status) = resting {
                return Ok(PreviewAutomationResponse {
                    client_id: "desktop".to_owned(),
                    connection_id,
                    request_id: request.request_id,
                    ok: true,
                    result: Some(Some(status)),
                    error: None,
                });
            }
            let (handle, control) = Self::page(handles, ui, tab).await?;
            // Keeps the page focused for the agent while the app's window is not.
            if !handle.focus_emulated.swap(true, Ordering::AcqRel) {
                let _ = CefCdp(control.cdp())
                    .send(
                        "Emulation.setFocusEmulationEnabled",
                        json!({"enabled": true}),
                    )
                    .await;
            }
            Ok(runner.respond(request).await)
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;
