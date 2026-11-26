//! Right-panel surfaces for `conn-app`: Conn tab header, Files explorer + source preview,
//! Diff viewer, local PTY Terminal, and Browser surface.

mod address;
pub(crate) mod annotations;
mod api;
mod browser;
mod browser_context_menu;
mod browser_inline_logins;
mod browser_passkeys;
pub(crate) mod chrome;
mod color;
mod database;
mod device;
mod diff;
mod diff_parser;
pub(crate) mod empty_state;
mod file_kind;
pub(crate) mod file_path;
mod files;
mod files_definition;
pub(crate) mod header;
mod highlight;
mod laravel_toolbar;
pub(crate) mod linked_items;
mod mcp;
mod pull_request;
mod tasks;
mod terminal;
pub(crate) mod terminal_demo;
pub(crate) mod terminal_drawer;
mod terminal_palette;
mod tree;
#[cfg(feature = "zed-files")]
pub(crate) mod zed_preview;

use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;

use conn_client::Connection;
use conn_state::{PanelSurface, RightPanelTab};
use conn_theme::Tokens;
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

use self::api::ApiPanel;
use self::browser::BrowserPanel;
use self::color::to_hsla;
use self::database::DatabasePanel;
use self::device::DevicePanel;
use self::diff::DiffPanel;
use self::files::FilesPanel;
use self::header::{PanelHeaderCallbacks, PanelHeaderProps, render_panel_header};
use self::laravel_toolbar::LaravelToolbarEvent;
use self::linked_items::LinkedItemsPanel;
use self::mcp::McpPanel;
use self::pull_request::PullRequestPanel;
use self::tasks::TasksPanel;
pub(crate) use self::tasks::TasksRuntime;
use self::terminal::TerminalPanel;
use crate::a11y::ConnA11yExt as _;

/// What the right panel asks of the shell.
#[derive(Clone, Debug)]
pub(crate) enum RightPanelEvent {
    DisplayedFileChanged,
    /// The Files tree asked to open a file as its own tab.
    OpenFile(String),
    Definition(conn_contract::source::SourceLocation),
    AttachSource(conn_contract::source::SourceSelection),
    /// A surface asked to show another surface (e.g. Linked items opening a pull request).
    OpenTab(RightPanelTab),
    OpenBrowser(String),
    /// The Files panel asked to add a file mention to the composer's draft.
    InsertMention(String),
    /// A surface asked to send an agent prompt to the active thread (e.g. PR agent actions).
    SendPrompt(String),
    /// Browser or Device panel emitted a project annotation queue action.
    Annotation(annotations::AnnotationAction),
}

impl gpui_kit::EventEmitter<RightPanelEvent> for RightPanel {}

/// Right-panel GPUI entity mounted inside Conn's right-panel card.
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
pub struct RightPanel {
    connection: Option<Connection>,
    tokens: Tokens,
    tab: RightPanelTab,
    open_tabs: Vec<PanelSurface>,
    /// The open file when `tab` is [`RightPanelTab::File`].
    file: Option<String>,
    add_menu_open: bool,
    maximized: bool,
    project_id: Option<String>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    files: Entity<FilesPanel>,
    diff: Entity<DiffPanel>,
    terminal: Entity<TerminalPanel>,
    browsers: HashMap<u64, Entity<BrowserPanel>>,
    browser_id: u64,
    history_project: Option<String>,
    history_hostname: Option<String>,
    environment: String,
    annotations: Vec<conn_state::AnnotationRecord>,
    watching: bool,
    project_ready: bool,
    api: Entity<ApiPanel>,
    database: Entity<DatabasePanel>,
    mcp: Entity<McpPanel>,
    tasks: Option<Entity<TasksPanel>>,
    /// A task an Orbit task card asked for before the Tasks panel was first shown.
    pending_task: Option<i64>,
    tasks_runtime: TasksRuntime,
    pull_request: Entity<PullRequestPanel>,
    pull_requests: Entity<pull_request::inbox::PullRequestInbox>,
    linked_items: Entity<LinkedItemsPanel>,
    device: Entity<DevicePanel>,
    /// True while the right panel is open and nothing covers it (see `set_surface_visible`).
    surface_visible: bool,
    /// False when the shell draws the tab strip in its 44px glass header and the card fill.
    chrome: bool,
}

impl fmt::Debug for RightPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RightPanel")
            .field("tab", &self.tab)
            .field("open_tabs", &self.open_tabs)
            .field("project_id", &self.project_id)
            .field("workspace_root", &self.workspace_root)
            .field("thread_id", &self.thread_id)
            .finish_non_exhaustive()
    }
}

#[expect(dead_code, reason = "wired into the shell by the orchestrator")]
#[expect(
    unreachable_pub,
    reason = "binary crate module; public API for orchestrator wiring"
)]
impl RightPanel {
    /// Creates a new [`RightPanel`] entity with the active theme [`Tokens`] and optional
    /// [`Connection`] to `conn-server`.
    pub fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        tasks_runtime: TasksRuntime,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let files = cx.new(|cx| FilesPanel::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe(&files, |_, _, event: &files::FilesEvent, cx| match event {
            files::FilesEvent::DisplayedFileChanged => {
                cx.emit(RightPanelEvent::DisplayedFileChanged);
                cx.notify();
            }
            files::FilesEvent::Definition(location) => {
                cx.emit(RightPanelEvent::Definition(location.clone()))
            }
            files::FilesEvent::Attach(s) => cx.emit(RightPanelEvent::AttachSource(s.clone())),
            files::FilesEvent::OpenFile(path) => cx.emit(RightPanelEvent::OpenFile(path.clone())),
            files::FilesEvent::RevealFolder => {
                cx.emit(RightPanelEvent::OpenTab(RightPanelTab::Files))
            }
            files::FilesEvent::AddToChat(mention) => {
                cx.emit(RightPanelEvent::InsertMention(mention.clone()));
            }
            files::FilesEvent::OpenInBrowser(url) => {
                cx.emit(RightPanelEvent::OpenBrowser(url.clone()));
            }
        })
        .detach();
        let diff = cx.new(|_| DiffPanel::new(tokens.clone(), connection.clone()));
        let terminal = cx.new(|cx| TerminalPanel::new(tokens.clone(), cx));
        let api = cx.new(|cx| ApiPanel::new(tokens.clone(), window, cx));
        let api_toolbar = api.read(cx).laravel_toolbar();
        cx.subscribe(
            &api_toolbar,
            |this, _, event: &LaravelToolbarEvent, cx| match event {
                LaravelToolbarEvent::OpenQuery(sql) => {
                    this.database
                        .update(cx, |panel, cx| panel.set_agent_sql(sql.clone(), cx));
                    cx.emit(RightPanelEvent::OpenTab(RightPanelTab::Database));
                }
            },
        )
        .detach();
        let database = cx.new(|cx| DatabasePanel::new(tokens.clone(), window, cx));
        let mcp = cx.new(|cx| McpPanel::new(tokens.clone(), window, cx));
        let pull_request =
            cx.new(|cx| PullRequestPanel::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe(
            &pull_request,
            |this, _, event: &pull_request::PullRequestEvent, cx| match event {
                pull_request::PullRequestEvent::OpenInbox => {
                    this.set_tab(RightPanelTab::PullRequests, cx);
                    cx.emit(RightPanelEvent::OpenTab(RightPanelTab::PullRequests));
                }
                pull_request::PullRequestEvent::SendPrompt(prompt) => {
                    cx.emit(RightPanelEvent::SendPrompt(prompt.clone()));
                }
            },
        )
        .detach();
        let pull_requests = cx.new(|cx| {
            pull_request::inbox::PullRequestInbox::new(
                tokens.clone(),
                connection.clone(),
                window,
                cx,
            )
        });
        cx.subscribe(
            &pull_requests,
            |this, _, target: &pull_request::inbox::OpenRequest, cx| {
                let entry = &target.0;
                this.pull_request.update(cx, |panel, cx| {
                    panel.open_pull_request(
                        entry.project_id.clone(),
                        Some(entry.host.clone()),
                        entry.repository.clone(),
                        entry.number,
                        Some(entry.url.clone()),
                        cx,
                    )
                });
                this.set_tab(RightPanelTab::PullRequest, cx);
                cx.emit(RightPanelEvent::OpenTab(RightPanelTab::PullRequest));
            },
        )
        .detach();
        let linked_items =
            cx.new(|cx| LinkedItemsPanel::new(tokens.clone(), connection.clone(), window, cx));
        let device = cx.new(|cx| DevicePanel::new(tokens.clone(), connection.clone(), window, cx));
        cx.subscribe(
            &device,
            |_, _, action: &annotations::AnnotationAction, cx| {
                cx.emit(RightPanelEvent::Annotation(action.clone()));
            },
        )
        .detach();
        cx.subscribe(&linked_items, Self::on_linked_items_event)
            .detach();

        Self {
            connection,
            tokens,
            tab: RightPanelTab::Files,
            open_tabs: vec![PanelSurface::Kind(RightPanelTab::Files)],
            file: None,
            add_menu_open: false,
            maximized: false,
            project_id: None,
            workspace_root: None,
            thread_id: None,
            files,
            diff,
            terminal,
            browsers: HashMap::new(),
            browser_id: 1,
            history_project: None,
            history_hostname: None,
            environment: String::new(),
            annotations: Vec::new(),
            watching: false,
            project_ready: false,
            api,
            database,
            mcp,
            tasks: None,
            pending_task: None,
            tasks_runtime,
            pull_request,
            pull_requests,
            linked_items,
            device,
            chrome: true,
            surface_visible: false,
        }
    }

    /// Renders only the active surface; the shell owns the tab strip and the card.
    pub fn set_embedded(&mut self, embedded: bool, cx: &mut Context<'_, Self>) {
        self.chrome = !embedded;
        cx.notify();
    }

    fn ensure_browser(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<BrowserPanel> {
        if let Some(browser) = self.browsers.get(&self.browser_id) {
            return browser.clone();
        }
        let browser = cx.new(|cx| {
            let mut browser =
                BrowserPanel::new(self.tokens.clone(), self.connection.clone(), window, cx);
            browser.set_environment(self.environment.clone(), cx);
            browser.set_history_context(
                self.history_project.clone(),
                self.history_hostname.clone(),
                cx,
            );
            browser.set_project(self.project_id.clone(), cx);
            browser.set_workspace_root(self.workspace_root.clone(), cx);
            browser.sync_annotations(
                self.annotations.clone(),
                self.watching,
                self.project_ready,
                cx,
            );
            browser.set_visible(
                self.surface_visible && self.tab == RightPanelTab::Browser,
                cx,
            );
            browser
        });
        cx.subscribe(
            &browser,
            |this, source, action: &annotations::AnnotationAction, cx| {
                if this.browsers.get(&this.browser_id) == Some(&source) {
                    cx.emit(RightPanelEvent::Annotation(action.clone()));
                }
            },
        )
        .detach();
        let toolbar = browser.read(cx).laravel_toolbar();
        let id = self.browser_id;
        cx.subscribe(&toolbar, move |this, _, event: &LaravelToolbarEvent, cx| {
            if this.browser_id == id
                && let LaravelToolbarEvent::OpenQuery(sql) = event
            {
                this.database
                    .update(cx, |p, cx| p.set_agent_sql(sql.clone(), cx));
                cx.emit(RightPanelEvent::OpenTab(RightPanelTab::Database));
            }
        })
        .detach();
        self.browsers.insert(id, browser.clone());
        browser
    }

    /// Loads a URL in the selected page, creating its CEF view on first use.
    pub fn navigate_browser(
        &mut self,
        url: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.ensure_browser(window, cx)
            .update(cx, |b, cx| b.navigate(url, cx));
    }

    pub fn remove_surface(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        self.release_closed_file(surface, cx);
        self.open_tabs.retain(|tab| tab != surface);
        if let Some(id) = surface.browser_id()
            && let Some(browser) = self.browsers.remove(&id)
        {
            browser.update(cx, |p, cx| p.set_visible(false, cx));
        }
    }

    /// Diagnostic state of the Browser tab.
    #[cfg(feature = "automation")]
    pub fn browser_state(&self, cx: &App) -> serde_json::Value {
        self.browsers
            .get(&self.browser_id)
            .map(|p| p.read(cx).automation_state())
            .unwrap_or_default()
    }

    /// The Browser tab's page title (empty before a page loads).
    #[cfg_attr(
        not(feature = "automation"),
        expect(dead_code, reason = "driven by the automation hook")
    )]
    pub fn browser_title(&self, cx: &App) -> String {
        self.browsers
            .get(&self.browser_id)
            .map(|p| p.read(cx).title())
            .unwrap_or_default()
    }

    #[cfg(feature = "automation")]
    pub fn browser_preview_eval(
        &mut self,
        expression: &str,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.browsers
            .get(&self.browser_id)
            .ok_or_else(|| "Browser tab is not open".to_owned())?
            .update(cx, |b, _| b.start_preview_eval(expression))
    }

    #[cfg(feature = "automation")]
    pub fn browser_preview_call(
        &mut self,
        op: &str,
        params: &serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, String>>, String> {
        self.browsers
            .get(&self.browser_id)
            .ok_or_else(|| "Browser tab is not open".to_owned())?
            .update(cx, |b, _| b.start_preview_call(op, params))
    }

    #[cfg(feature = "automation")]
    pub fn browser_screenshot(
        &self,
        path: &std::path::Path,
        cx: &App,
    ) -> Result<serde_json::Value, String> {
        self.browsers
            .get(&self.browser_id)
            .ok_or_else(|| "Browser tab is not open".to_owned())?
            .read(cx)
            .save_browser_screenshot(path)
    }

    /// Places an agent-provided SQL query in the Database editor without executing it.
    pub fn set_database_sql(&mut self, sql: String, cx: &mut Context<'_, Self>) {
        self.database
            .update(cx, |panel, cx| panel.set_agent_sql(sql, cx));
    }

    /// Runs an agent's read-only SQL query in the Database panel and resolves with its result.
    pub fn run_agent_database_query(
        &mut self,
        sql: String,
        connection: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelDatabaseResult, String>>
    {
        self.database
            .update(cx, |panel, cx| panel.run_agent_query(sql, connection, cx))
    }

    /// Connects an MCP server in the MCP panel for an agent and resolves with its tools list.
    pub fn run_agent_mcp_connect(
        &mut self,
        spec: conn_contract::AgentPanelMcpServer,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelMcpResult, String>> {
        self.mcp
            .update(cx, |panel, cx| panel.run_agent_connect(spec, cx))
    }

    /// Calls an MCP tool in the MCP panel for an agent and resolves with its output.
    pub fn run_agent_mcp_call(
        &mut self,
        call: conn_contract::AgentPanelMcpCall,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelMcpCallResult, String>>
    {
        self.mcp
            .update(cx, |panel, cx| panel.run_agent_call(call, cx))
    }

    /// Syncs the active project's live annotations queue and Watch state into Browser and Device.
    pub fn set_annotations(
        &mut self,
        annotations: Vec<conn_state::AnnotationRecord>,
        watching: bool,
        project_ready: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.annotations.clone_from(&annotations);
        self.watching = watching;
        self.project_ready = project_ready;
        if let Some(browser) = self.browsers.get(&self.browser_id) {
            browser.update(cx, |p, cx| {
                p.sync_annotations(annotations.clone(), watching, project_ready, cx)
            });
        }
        self.device.update(cx, |p, cx| {
            p.sync_annotations(annotations, watching, project_ready, cx);
        });
    }

    /// Updates the live `conn-server` connection across every server-backed right-panel surface.
    pub fn set_connection(&mut self, connection: Option<Connection>, cx: &mut Context<'_, Self>) {
        match (&self.connection, &connection) {
            (Some(old), Some(new)) if old.same_connection(new) => return,
            (None, None) => return,
            _ => {}
        }
        self.connection.clone_from(&connection);
        self.files
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.diff
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.pull_request
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.pull_requests
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        self.linked_items
            .update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        for browser in self.browsers.values() {
            browser.update(cx, |p, cx| p.set_connection(connection.clone(), cx));
        }
        self.device
            .update(cx, |p, cx| p.set_connection(connection, cx));
        cx.notify();
    }

    /// Hands the live server config to the surfaces that read its settings.
    pub fn set_server_config(
        &mut self,
        config: std::sync::Arc<conn_state::providers::ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.device
            .update(cx, |panel, cx| panel.set_server_config(config, cx));
    }

    /// The terminal view, which the shell also hosts as a bottom drawer under the chat.
    pub(crate) fn terminal_entity(&self) -> Entity<TerminalPanel> {
        self.terminal.clone()
    }

    /// A different thread may have edited the project's saved requests or connections.
    pub fn reload_project_settings(&self, cx: &mut Context<'_, Self>) {
        self.api.update(cx, |p, _| p.reload_store());
        self.database.update(cx, |p, _| p.reload_store());
        self.mcp.update(cx, |p, _| p.reload_store());
    }

    /// Updates theme tokens across the tab strip and every right-panel surface.
    pub fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens.clone();
        self.files
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.diff
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.terminal
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.api
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.database
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.mcp
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        if let Some(tasks) = &self.tasks {
            tasks.update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        }
        self.pull_request
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.pull_requests
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.linked_items
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        self.device
            .update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        for browser in self.browsers.values() {
            browser.update(cx, |p, cx| p.set_tokens(tokens.clone(), cx));
        }
        cx.notify();
    }

    /// The Conn server (Orbit environment) the thread runs on.
    pub fn set_environment(&mut self, environment_id: String, cx: &mut Context<'_, Self>) {
        self.api.update(cx, |api, cx| {
            api.set_environment(environment_id.clone(), cx)
        });
        if self.environment != environment_id {
            self.environment = environment_id;
            for browser in self.browsers.values() {
                browser.update(cx, |p, cx| p.set_environment(self.environment.clone(), cx));
            }
        }
    }

    pub(crate) fn set_browser_history_context(
        &mut self,
        project: Option<String>,
        hostname: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.history_project == project && self.history_hostname == hostname {
            return;
        }
        self.history_project = project;
        self.history_hostname = hostname;
        for browser in self.browsers.values() {
            browser.update(cx, |p, cx| {
                p.set_history_context(
                    self.history_project.clone(),
                    self.history_hostname.clone(),
                    cx,
                );
            });
        }
    }

    /// Updates the active project, workspace root, and thread context.
    pub fn set_context(
        &mut self,
        project_id: Option<String>,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        thread_shell: Option<&conn_state::ThreadShell>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_id != project_id || self.workspace_root != workspace_root {
            let key = project_id.clone();
            self.api.update(cx, |p, cx| p.set_project(key.clone(), cx));
            for_each_project_panel(self, key, workspace_root.clone(), cx);
        }
        self.project_id = project_id;
        if self.workspace_root != workspace_root {
            self.workspace_root = workspace_root.clone();
            self.files
                .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
            self.diff
                .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
            self.terminal
                .update(cx, |p, cx| p.set_workspace_root(workspace_root, cx));
        }
        if self.thread_id != thread_id {
            self.files
                .update(cx, |files, cx| files.set_thread(thread_id.clone(), cx));
            self.thread_id = thread_id.clone();
            self.files
                .update(cx, |p, _| p.set_signing_thread(thread_id.clone()));
            self.diff
                .update(cx, |p, cx| p.set_thread(thread_id.clone(), cx));
        }
        let root = self.workspace_root.clone();
        for_each_thread_panel(self, root, thread_id, thread_shell, cx);
        cx.notify();
    }

    /// Points the Diff panel at one turn's checkpoint diff (`Turn n-1 → n`), or every turn when
    /// the run has no ordinal, and reveals `file_path` once it loads. The caller selects the Diff
    /// tab; a panel not yet bound to its thread applies the request when it is.
    pub fn open_turn_diff(
        &mut self,
        turn: Option<i64>,
        file_path: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        self.diff
            .update(cx, |p, cx| p.open_turn_diff(turn, file_path, cx));
    }

    /// The Diff panel's scope label and the file still waiting to be revealed, for tests.
    #[cfg(test)]
    pub(crate) fn diff_focus_state(&self, cx: &gpui_kit::App) -> (String, Option<String>) {
        self.diff.read(cx).focus_state()
    }

    /// Shows one Orbit task's detail in the Tasks panel. The caller selects the Tasks tab; a panel
    /// not yet created opens the task when it is.
    pub fn open_task(&mut self, task_id: i64, cx: &mut Context<'_, Self>) {
        match &self.tasks {
            Some(tasks) => tasks.update(cx, |panel, cx| panel.open_task(task_id, cx)),
            None => self.pending_task = Some(task_id),
        }
        cx.notify();
    }

    /// Whether live surfaces (native CEF browser view, device video/input streams) may run:
    /// the shell passes `true` only when the right panel is open and no GPUI overlay covers it.
    pub fn set_surface_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        self.surface_visible = visible;
        self.sync_surface_visibility(cx);
    }

    #[cfg(feature = "zed-files")]
    pub(crate) fn file_modifiers_changed(
        &self,
        modifiers: gpui_kit::Modifiers,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.surface_visible && self.tab == RightPanelTab::File {
            self.files.update(cx, |panel, cx| {
                if modifiers == gpui_kit::Modifiers::command() {
                    panel.zed_definition_at(window.mouse_position(), false, window, cx);
                } else {
                    panel.cancel_hover();
                }
            });
        }
    }

    fn sync_surface_visibility(&mut self, cx: &mut Context<'_, Self>) {
        if !self.surface_visible || self.tab != RightPanelTab::File {
            self.files.update(cx, |files, _| files.cancel_reveal());
        }
        let shows = |tab: RightPanelTab| self.surface_visible && self.tab == tab;
        let (show_browser, show_device) =
            (shows(RightPanelTab::Browser), shows(RightPanelTab::Device));
        let (show_diff, show_pr, show_linked) = (
            shows(RightPanelTab::Diff),
            shows(RightPanelTab::PullRequest),
            shows(RightPanelTab::LinkedItems),
        );
        if let Some(browser) = self.browsers.get(&self.browser_id) {
            browser.update(cx, |b, cx| b.set_visible(show_browser, cx));
        }
        self.device
            .update(cx, |d, cx| d.set_visible(show_device, cx));
        if let Some(tasks) = &self.tasks {
            tasks.update(cx, |p, cx| p.set_active(shows(RightPanelTab::Tasks), cx));
        }
        // Diff, Pull request and Linked items load only while shown, as in Conn. Before, every
        // thread switch fired their git, GitHub and three full `getThreadProjection` calls
        // whether or not the right panel was open, competing with the thread snapshot.
        self.diff.update(cx, |p, cx| p.set_active(show_diff, cx));
        self.pull_request
            .update(cx, |p, cx| p.set_active(show_pr, cx));
        self.pull_requests.update(cx, |p, cx| {
            p.set_active(shows(RightPanelTab::PullRequests), cx)
        });
        self.linked_items
            .update(cx, |p, cx| p.set_active(show_linked, cx));
    }

    /// Switches the active right-panel tab (opening it if not yet in `open_tabs`),
    /// lazily spawning the terminal PTY on first visit.
    pub fn set_tab(&mut self, tab: RightPanelTab, cx: &mut Context<'_, Self>) {
        if tab == RightPanelTab::File {
            if let Some(path) = self.file.clone() {
                self.set_file(path, cx);
            }
            return;
        }
        let surface = if tab == RightPanelTab::Browser && self.browser_id > 1 {
            PanelSurface::Browser(self.browser_id)
        } else {
            PanelSurface::Kind(tab)
        };
        if !self.open_tabs.contains(&surface) {
            self.open_tabs.push(surface);
        }
        self.add_menu_open = false;
        if self.tab == RightPanelTab::File || tab == RightPanelTab::Files {
            self.files.update(cx, |p, cx| p.show_tree(cx));
        }
        if self.tab == tab {
            cx.notify();
            return;
        }
        self.tab = tab;
        self.sync_surface_visibility(cx);
        if tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }
        cx.notify();
    }

    /// Reveals `line` of the file tab now showing (or loading) and flashes it.
    pub fn reveal_line(&mut self, line: usize, cx: &mut Context<'_, Self>) {
        self.files.update(cx, |p, cx| p.reveal_line(line, cx));
    }

    #[cfg(feature = "automation")]
    pub(crate) fn spike_files_state(
        &self,
        window: &Window,
        cx: &gpui_kit::App,
    ) -> serde_json::Value {
        self.files.read(cx).spike_files_state(window, cx)
    }
    pub(crate) fn selected_source(
        &self,
        cx: &gpui_kit::App,
    ) -> Option<conn_contract::source::SourceSelection> {
        (self.tab == RightPanelTab::File)
            .then(|| self.files.read(cx).selected_source(cx))
            .flatten()
    }

    pub(crate) fn reveal_lines(
        &mut self,
        path: String,
        lines: conn_contract::source::SourceLines,
        excerpt: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
        self.files
            .update(cx, |files, cx| files.reveal_lines(path, lines, excerpt, cx))
    }

    /// Shows the file at `path` (project-relative) as its own surface, as Conn's `file` tab.
    pub fn set_file(&mut self, path: String, cx: &mut Context<'_, Self>) {
        let surface = PanelSurface::File(path.clone());
        if !self.open_tabs.contains(&surface) {
            self.open_tabs.push(surface);
        }
        self.add_menu_open = false;
        self.tab = RightPanelTab::File;
        self.file = Some(path.clone());
        self.files.update(cx, |p, cx| p.show_preview_at(path, cx));
        self.sync_surface_visibility(cx);
        cx.notify();
    }

    /// Shows `surface`.
    pub fn set_surface(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        if let Some(id) = surface.browser_id()
            && id != self.browser_id
        {
            if let Some(old) = self.browsers.get(&self.browser_id) {
                old.update(cx, |b, cx| b.set_visible(false, cx));
            }
            self.browser_id = id;
            self.sync_surface_visibility(cx);
        }
        match surface {
            PanelSurface::Browser(_) => self.set_tab(RightPanelTab::Browser, cx),
            PanelSurface::Kind(tab) => self.set_tab(*tab, cx),
            PanelSurface::File(path) => self.set_file(path.clone(), cx),
        }
    }

    pub(crate) fn displayed_surface(
        &self,
        requested: PanelSurface,
        tabs: &[PanelSurface],
        cx: &gpui_kit::App,
    ) -> PanelSurface {
        if matches!(requested, PanelSurface::File(_))
            && let Some(held) = self.files.read(cx).held_file()
            && let Some(tab) = tabs.iter().find(|tab| matches!(tab, PanelSurface::File(path) if file_path::split_line_suffix(path).0 == held))
        {
            return tab.clone();
        }
        requested
    }

    /// The active surface.
    #[must_use]
    pub fn surface(&self) -> PanelSurface {
        match (&self.tab, &self.file) {
            (RightPanelTab::Browser, _) if self.browser_id > 1 => {
                PanelSurface::Browser(self.browser_id)
            }
            (RightPanelTab::File, Some(path)) => PanelSurface::File(path.clone()),
            (tab, _) => PanelSurface::Kind(*tab),
        }
    }

    pub(crate) fn release_closed_file(&mut self, tab: &PanelSurface, cx: &mut Context<'_, Self>) {
        if let PanelSurface::File(path) = tab {
            self.files.update(cx, |files, cx| {
                files.release_closed_file(file_path::split_line_suffix(path).0, cx)
            });
        }
    }

    /// Closes an open tab if more than one tab is open, activating an adjacent tab if needed.
    pub fn close_tab(&mut self, surface: &PanelSurface, cx: &mut Context<'_, Self>) {
        if self.open_tabs.len() <= 1 {
            return;
        }
        if let Some(pos) = self.open_tabs.iter().position(|t| t == surface) {
            self.open_tabs.remove(pos);
            self.remove_surface(surface, cx);
            if &self.surface() == surface {
                let next = self
                    .open_tabs
                    .get(pos.saturating_sub(1))
                    .cloned()
                    .unwrap_or(PanelSurface::Kind(RightPanelTab::Files));
                self.set_surface(&next, cx);
            }
            cx.notify();
        }
    }

    /// Returns the currently active right-panel tab.
    #[must_use]
    pub fn tab(&self) -> RightPanelTab {
        self.tab
    }

    /// Returns the list of currently open right-panel tabs.
    #[must_use]
    pub fn open_tabs(&self) -> &[PanelSurface] {
        &self.open_tabs
    }

    /// Renders the 44px header tab strip (`RightPanelTabs`), suitable for mounting either
    /// inside [`RightPanel::render`] or directly in the shell's glass header row.
    pub fn render_tabs(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let entity = cx.entity();
        let callbacks = PanelHeaderCallbacks {
            on_select_tab: {
                let entity = entity.clone();
                Rc::new(move |surface: PanelSurface, _, cx| {
                    entity.update(cx, |this, cx| this.set_surface(&surface, cx));
                })
            },
            on_close_tab: Some({
                let entity = entity.clone();
                Rc::new(move |surface: PanelSurface, _, cx| {
                    entity.update(cx, |this, cx| this.close_tab(&surface, cx));
                })
            }),
            on_toggle_add_menu: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |this, cx| {
                        this.add_menu_open = !this.add_menu_open;
                        cx.notify();
                    });
                })
            },
            on_add_tab: {
                let entity = entity.clone();
                Rc::new(move |tab, _, cx| {
                    entity.update(cx, |this, cx| {
                        this.set_surface(&PanelSurface::for_add(tab, &this.open_tabs), cx)
                    });
                })
            },
            on_toggle_maximize: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |this, cx| {
                        this.maximized = !this.maximized;
                        cx.notify();
                    });
                })
            },
            on_toggle_panel: Rc::new(move |_, cx| {
                entity.update(cx, |this, cx| {
                    this.add_menu_open = false;
                    cx.notify();
                });
            }),
            on_open_sidebar: Rc::new(|_, _| {}),
        };

        let active = self.displayed_surface(self.surface(), &self.open_tabs, cx);
        render_panel_header(
            PanelHeaderProps {
                open_tabs: &self.open_tabs,
                active_tab: &active,
                maximized: self.maximized,
                show_maximize: true,
                owns_window_leading_edge: false,
                panel_open: true,
                add_menu_open: self.add_menu_open,
                available_tabs: &RightPanelTab::MENU_ORDER,
                has_project: true,
                tokens: &self.tokens,
            },
            callbacks,
        )
        .into_any_element()
    }
}

impl Render for RightPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        if self.tab == RightPanelTab::Terminal {
            self.terminal.update(cx, |p, cx| p.ensure_started(cx));
        }

        let card_bg = to_hsla(self.tokens.shell_card);
        let divider = to_hsla(self.tokens.shell_divider);
        let body: AnyElement = match self.tab {
            RightPanelTab::Files | RightPanelTab::File => self.files.clone().into_any_element(),
            RightPanelTab::Diff => self.diff.clone().into_any_element(),
            RightPanelTab::Terminal => self.terminal.clone().into_any_element(),
            RightPanelTab::Browser => self.ensure_browser(window, cx).into_any_element(),
            RightPanelTab::Api => self.api.clone().into_any_element(),
            RightPanelTab::Database => self.database.clone().into_any_element(),
            RightPanelTab::Mcp => self.mcp.clone().into_any_element(),
            RightPanelTab::Tasks => self
                .tasks
                .get_or_insert_with(|| {
                    cx.new(|cx| {
                        let mut tasks =
                            TasksPanel::new(self.tokens.clone(), &self.tasks_runtime, window, cx);
                        tasks.set_project(self.project_id.clone(), self.workspace_root.clone(), cx);
                        if let Some(task_id) = self.pending_task.take() {
                            tasks.open_task(task_id, cx);
                        }
                        tasks
                    })
                })
                .clone()
                .into_any_element(),
            RightPanelTab::PullRequests => self.pull_requests.clone().into_any_element(),
            RightPanelTab::PullRequest => self.pull_request.clone().into_any_element(),
            RightPanelTab::LinkedItems => self.linked_items.clone().into_any_element(),
            RightPanelTab::Device => self.device.clone().into_any_element(),
        };

        let surface_label = header::panel_tab_label(self.tab);
        let surface_ax_id = gpui_kit::SharedString::from(format!(
            "panel.surface.{}",
            surface_label.to_ascii_lowercase().replace(' ', "-")
        ));
        let wrapped_body = div()
            .id(gpui_kit::SharedString::from(format!(
                "right-panel-surface-{surface_label}"
            )))
            .a11y(gpui_kit::Role::TabPanel, surface_ax_id, surface_label)
            .flex_1()
            .min_h_0()
            .w_full()
            .child(body);

        if !self.chrome {
            return v_flex().size_full().child(wrapped_body);
        }
        v_flex()
            .size_full()
            .bg(card_bg)
            .child(self.render_tabs(cx))
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(wrapped_body)
    }
}

/// Hands the selected thread's project and folder to the project-scoped surfaces.
impl RightPanel {
    fn on_linked_items_event(
        &mut self,
        _: Entity<LinkedItemsPanel>,
        event: &linked_items::LinkedItemsEvent,
        cx: &mut Context<'_, Self>,
    ) {
        match event {
            linked_items::LinkedItemsEvent::OpenPullRequest {
                project_id,
                host,
                repository,
                number,
                url,
            } => {
                let Some(project_id) = project_id.clone().or_else(|| self.project_id.clone())
                else {
                    open_external(url);
                    return;
                };
                let (host, repository, number, url) =
                    (host.clone(), repository.clone(), *number, url.clone());
                self.pull_request.update(cx, |p, cx| {
                    p.open_pull_request(project_id, Some(host), repository, number, Some(url), cx);
                });
                self.set_tab(RightPanelTab::PullRequest, cx);
                cx.emit(RightPanelEvent::OpenTab(RightPanelTab::PullRequest));
            }
            // Conn opens an Issue surface; until conn-gpui has one, the tracker's page.
            linked_items::LinkedItemsEvent::OpenIssue { url, .. } => open_external(url),
        }
    }
}

/// Opens `url` in the default browser.
fn open_external(url: &str) {
    if let Err(err) = std::process::Command::new("open").arg(url).spawn() {
        log::warn!("could not open {url}: {err}");
    }
}

/// Hands the selected thread and its folder to the thread-scoped surfaces.
fn for_each_thread_panel(
    panel: &RightPanel,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    thread_shell: Option<&conn_state::ThreadShell>,
    cx: &mut Context<'_, RightPanel>,
) {
    let pr_fields = thread_shell.map(pull_request::PrThreadFields::from);
    panel.pull_request.update(cx, |p, cx| {
        p.set_thread(workspace_root.clone(), thread_id.clone(), pr_fields, cx);
    });
    let linked_shell = thread_shell.map(conn_contract::to_json);
    panel.linked_items.update(cx, |p, cx| {
        p.set_thread(workspace_root.clone(), thread_id.clone(), linked_shell, cx);
    });
    panel.device.update(cx, |p, cx| {
        p.set_thread(workspace_root, thread_id, cx);
    });
}

fn for_each_project_panel(
    panel: &RightPanel,
    project_key: Option<String>,
    workspace_root: Option<String>,
    cx: &mut Context<'_, RightPanel>,
) {
    panel.database.update(cx, |p, cx| {
        p.set_project(project_key.clone(), workspace_root.clone(), cx);
    });
    panel.mcp.update(cx, |p, cx| {
        p.set_project(project_key.clone(), workspace_root.clone(), cx);
    });
    for browser in panel.browsers.values() {
        browser.update(cx, |p, cx| {
            p.set_project(project_key.clone(), cx);
            p.set_workspace_root(workspace_root.clone(), cx);
        });
    }
    panel
        .api
        .update(cx, |p, cx| p.set_workspace_root(workspace_root.clone(), cx));
    if let Some(tasks) = &panel.tasks {
        tasks.update(cx, |p, cx| p.set_project(project_key, workspace_root, cx));
    }
}
