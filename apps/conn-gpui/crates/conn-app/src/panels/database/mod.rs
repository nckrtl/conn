//! The Database surface (Conn `apps/web/src/database/DatabasePanel.tsx`): the project's
//! database from `.env` and saved manual connections, their tables, a table's columns, and
//! read-only SQL executed natively via [`conn_desktop::database::DatabaseRunner`].

mod empty;
mod form;
mod picker;
mod store;
mod views;

use std::cell::Cell;
use std::rc::Rc;

use conn_desktop::database::api::{
    CallOptions, ConnectionSource, DatabaseQueryResult, PanelConnection, browse_table_sql,
    connection_key, connection_target, describe_database_table, list_database_tables,
    new_connection, panel_connection_from_vault, run_read_only_query,
};
use conn_desktop::database::{DatabaseColumn, DatabaseRunner};
use conn_desktop::vault::VaultErrorKind;
use conn_theme::Tokens;
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Bounds, Context, Entity, FontWeight, IntoElement, KeyDownEvent, MouseButton,
    ParentElement, Pixels, Render, ScrollHandle, SharedString, Styled, Subscription, Window,
    canvas, div, px, relative,
};

use self::form::ConnectionFormState;
use self::picker::{PickerRows, menu_placement, step_row};
use self::store::{
    DatabaseStore, active_connection, filter_tables, finalize_draft, format_result_summary,
    load_env_connection, load_store, project_connections, save_store,
};
use self::views::{
    ConnectionMenuView, menu_wanted_height, render_connection_alert, render_connection_menu,
    render_rows_grid, render_structure_list,
};
use super::chrome::{
    self, ConnTooltipExt as _, ICON_BUTTON_GLYPH_PX, ROW_PAD_START_PX, SectionTab,
    UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::color::to_hsla;
use super::header::superhero_icon;
use crate::a11y::ConnA11yExt as _;
use crate::theme::MONO_FONT;

/// Maximum width of the responsive table sidebar.
const TABLE_LIST_WIDTH_PX: f32 = 208.0;
/// Height of the results section switcher.
const RESULT_TABS_HEIGHT_PX: f32 = 44.0;
/// Height of the SQL editor, including the result duration.
const SQL_EDITOR_HEIGHT_PX: f32 = 96.0;
/// Outer left padding of the SQL editor; with the editor's own inset the text sits 16px in.
const SQL_EDITOR_PAD_START_PX: f32 = 3.0;
/// Top padding of the SQL editor so its first line centres on the table search text.
const SQL_EDITOR_PAD_TOP_PX: f32 = 7.0;
/// Placeholder shown in the SQL editor (`DatabasePanel.tsx`).
const SQL_PLACEHOLDER: &str = "select * from users limit 100";
const PILL_RADIUS_PX: f32 = 9999.0;
/// The remembered connection of a project the user disconnected. It is kept in `database.json`
/// so the empty state also shows after a restart (`select("")` in the desktop lab).
const DISCONNECTED: &str = "";

#[derive(Debug, Clone)]
struct KeyedLoad<T> {
    key: String,
    loading: bool,
    data: Option<T>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct QueryState {
    key: String,
    running: bool,
    result: Option<DatabaseQueryResult>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct PickedTable {
    key: String,
    table: String,
}

/// The Database panel entity.
pub(crate) struct DatabasePanel {
    tokens: Tokens,
    project_key: Option<String>,
    workspace_root: Option<String>,
    store: DatabaseStore,
    runner: DatabaseRunner,
    env_connection: Option<PanelConnection>,
    vault_connections: Vec<PanelConnection>,
    vault_status: Option<VaultErrorKind>,
    vault_error: Option<String>,
    allow_unlock_next: bool,
    pub(super) editing: Option<ConnectionFormState>,
    menu_open: bool,
    /// The connection menu's search field, its text, the highlighted row and its list's scroll.
    menu_input: Entity<InputState>,
    menu_query: String,
    menu_highlight: usize,
    menu_scroll: ScrollHandle,
    /// Where the menu's trigger was painted: the menu fits itself into the room around it.
    trigger_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    filter: String,
    clear_filter_pending: bool,
    filter_input: Entity<InputState>,
    sql_input: Entity<EditorState>,
    /// `(project_key, connection_id)` currently loaded into `sql_input`.
    synced_sql: Option<(String, String)>,
    pending_agent_sql: Option<String>,
    tab: &'static str,
    refresh_nonce: u64,
    reconnect_next: bool,
    tables_load: Option<KeyedLoad<Vec<String>>>,
    columns_load: Option<KeyedLoad<Vec<DatabaseColumn>>>,
    picked: Option<PickedTable>,
    query: Option<QueryState>,
    run_id: u64,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for DatabasePanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DatabasePanel")
            .field("project_key", &self.project_key)
            .field("workspace_root", &self.workspace_root)
            .field("tab", &self.tab)
            .field("editing", &self.editing.is_some())
            .finish_non_exhaustive()
    }
}

impl DatabasePanel {
    pub(super) fn reload_store(&mut self) {
        self.store = load_store();
        self.synced_sql = None;
    }
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let filter_input = cx.new(|cx| InputState::new(window, cx).placeholder("Tables"));
        let menu_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search connections…"));
        let sql_input = cx.new(|cx| {
            EditorState::new(window, cx)
                .placeholder(SQL_PLACEHOLDER)
                .language("sql")
                .line_number(false)
                .folding(false)
                .auto_close(false)
                .smart_indent(false)
                .searchable(false)
        });

        let filter_sub = cx.subscribe(&filter_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.filter = input.read(cx).value().to_string();
                cx.notify();
            }
        });
        let menu_sub = cx.subscribe(&menu_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let query = input.read(cx).value().to_string();
                if query != this.menu_query {
                    this.menu_query = query;
                    this.menu_highlight = 0;
                    this.menu_scroll.scroll_to_item(0);
                    cx.notify();
                }
            }
        });
        let sql_sub = cx.subscribe(&sql_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let next_sql = input.read(cx).value().to_string();
                let Some(project_key) = this.project_key.clone() else {
                    return;
                };
                let Some(connection_id) = this.selected_connection().map(|c| c.id) else {
                    return;
                };
                if this.store.sql(&project_key, &connection_id) == next_sql {
                    return;
                }
                this.store.set_sql(&project_key, &connection_id, next_sql);
                save_store(&this.store);
                cx.notify();
            }
        });

        Self {
            tokens,
            project_key: None,
            workspace_root: None,
            store: load_store(),
            runner: DatabaseRunner::new(),
            env_connection: None,
            vault_connections: Vec::new(),
            vault_status: None,
            vault_error: None,
            allow_unlock_next: false,
            editing: None,
            menu_open: false,
            menu_input,
            menu_query: String::new(),
            menu_highlight: 0,
            menu_scroll: ScrollHandle::new(),
            trigger_bounds: Rc::new(Cell::new(None)),
            filter: String::new(),
            clear_filter_pending: false,
            filter_input,
            sql_input,
            synced_sql: None,
            pending_agent_sql: None,
            tab: "rows",
            refresh_nonce: 0,
            reconnect_next: false,
            tables_load: None,
            columns_load: None,
            picked: None,
            query: None,
            run_id: 0,
            _subscriptions: vec![filter_sub, menu_sub, sql_sub],
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread's project (Conn keys panel state by project) and its folder.
    pub(crate) fn set_project(
        &mut self,
        project_key: Option<String>,
        workspace_root: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_key == project_key && self.workspace_root == workspace_root {
            return;
        }
        self.project_key = project_key;
        self.workspace_root = workspace_root;
        self.env_connection = load_env_connection(self.workspace_root.as_deref());
        self.editing = None;
        self.menu_open = false;
        self.filter.clear();
        self.clear_filter_pending = true;
        self.synced_sql = None;
        self.picked = None;
        self.query = None;
        self.tables_load = None;
        self.columns_load = None;
        self.load_vault_databases(false, cx);
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    pub(super) fn load_vault_databases(&mut self, allow_unlock: bool, cx: &mut Context<'_, Self>) {
        if cfg!(test) {
            return;
        }
        let vault = self.runner.vault().clone();
        if !vault.is_installed() {
            self.vault_connections.clear();
            self.vault_status = Some(VaultErrorKind::Unavailable);
            self.vault_error = None;
            return;
        }
        let task = crate::live::RT.spawn(async move { vault.list_databases(allow_unlock).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                match outcome {
                    Ok(Ok(dbs)) => {
                        panel.vault_connections =
                            dbs.iter().map(panel_connection_from_vault).collect();
                        panel.vault_status = None;
                        panel.vault_error = None;
                    }
                    Ok(Err(err)) => {
                        panel.vault_connections.clear();
                        panel.vault_status = Some(err.kind);
                        panel.vault_error = Some(err.message);
                    }
                    Err(join_err) => {
                        panel.vault_connections.clear();
                        panel.vault_status = Some(VaultErrorKind::Error);
                        panel.vault_error = Some(join_err.to_string());
                    }
                }
                panel.ensure_tables_loaded(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn connections(&self) -> Vec<PanelConnection> {
        let saved = self
            .project_key
            .as_deref()
            .map_or(&[][..], |key| self.store.saved_connections(key));
        let mut all = project_connections(self.env_connection.as_ref(), saved);
        all.extend(self.vault_connections.iter().cloned());
        all
    }

    fn selected_connection(&self) -> Option<PanelConnection> {
        let connections = self.connections();
        let remembered = self
            .project_key
            .as_deref()
            .and_then(|key| self.store.remembered_connection(key));
        // An empty id is a disconnect: it never falls back to the `.env` or the first one.
        if remembered == Some(DISCONNECTED) {
            return None;
        }
        active_connection(&connections, remembered)
    }

    fn current_sql(&self, connection_id: &str) -> String {
        self.project_key.as_deref().map_or_else(String::new, |key| {
            self.store.sql(key, connection_id).to_owned()
        })
    }

    fn take_call_options(&mut self) -> CallOptions {
        let reconnect = self.reconnect_next;
        let allow_unlock = self.allow_unlock_next;
        self.reconnect_next = false;
        self.allow_unlock_next = false;
        CallOptions {
            reconnect,
            allow_unlock,
        }
    }

    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.clear_filter_pending {
            self.clear_filter_pending = false;
            self.filter_input
                .update(cx, |state, cx| state.set_value(String::new(), window, cx));
        }
        let (Some(project_key), Some(connection)) =
            (self.project_key.clone(), self.selected_connection())
        else {
            return;
        };
        if let Some(sql) = self.pending_agent_sql.take() {
            self.store.set_sql(&project_key, &connection.id, sql);
            save_store(&self.store);
        }
        let target = (project_key.clone(), connection.id.clone());
        if self.synced_sql.as_ref() == Some(&target) {
            return;
        }
        self.synced_sql = Some(target);
        let sql = self.store.sql(&project_key, &connection.id).to_owned();
        self.sql_input
            .update(cx, |state, cx| state.set_value(sql, window, cx));
    }

    fn ensure_tables_loaded(&mut self, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.selected_connection() else {
            self.tables_load = None;
            return;
        };
        let key = format!("{}:{}", connection_key(&connection), self.refresh_nonce);
        if self
            .tables_load
            .as_ref()
            .is_some_and(|state| state.key == key)
        {
            return;
        }
        let options = self.take_call_options();
        self.tables_load = Some(KeyedLoad {
            key: key.clone(),
            loading: true,
            data: None,
            error: None,
        });
        // A test never reaches a database: its runtime thread would finish the load while the
        // test scheduler runs something else. The load stays pending, as the Vault load does.
        if cfg!(test) {
            return;
        }
        let runner = self.runner.clone();
        let db_conn = connection.connection;
        let task = crate::live::RT
            .spawn(async move { list_database_tables(&runner, &db_conn, options).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                if panel
                    .tables_load
                    .as_ref()
                    .is_none_or(|state| state.key != key)
                {
                    return;
                }
                match outcome {
                    Ok(Ok(tables)) => {
                        panel.tables_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: Some(tables),
                            error: None,
                        });
                    }
                    Ok(Err(error)) => {
                        panel.tables_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(error.to_string()),
                        });
                    }
                    Err(join_error) => {
                        panel.tables_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(join_error.to_string()),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn ensure_columns_loaded(
        &mut self,
        connection: &PanelConnection,
        table: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let conn_key = connection_key(connection);
        let key = format!("{conn_key}:{table}:{}", self.refresh_nonce);
        if self
            .columns_load
            .as_ref()
            .is_some_and(|state| state.key == key)
        {
            return;
        }
        let options = self.take_call_options();
        self.columns_load = Some(KeyedLoad {
            key: key.clone(),
            loading: true,
            data: None,
            error: None,
        });
        let runner = self.runner.clone();
        let db_conn = connection.connection.clone();
        let table_name = table.to_owned();
        let task = crate::live::RT.spawn(async move {
            describe_database_table(&runner, &db_conn, &table_name, options).await
        });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                if panel
                    .columns_load
                    .as_ref()
                    .is_none_or(|state| state.key != key)
                {
                    return;
                }
                match outcome {
                    Ok(Ok(columns)) => {
                        panel.columns_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: Some(columns),
                            error: None,
                        });
                    }
                    Ok(Err(error)) => {
                        panel.columns_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(error.to_string()),
                        });
                    }
                    Err(join_error) => {
                        panel.columns_load = Some(KeyedLoad {
                            key,
                            loading: false,
                            data: None,
                            error: Some(join_error.to_string()),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Places an agent-provided SQL query in the editor without running it.
    pub(crate) fn set_agent_sql(&mut self, sql: String, cx: &mut Context<'_, Self>) {
        self.pending_agent_sql = Some(sql);
        self.synced_sql = None;
        self.tab = "rows";
        cx.notify();
    }

    /// Executes an agent's read-only SQL query in the Database panel so the user sees the live
    /// rows, and returns the truncated [`conn_contract::AgentPanelDatabaseResult`].
    pub(crate) fn run_agent_query(
        &mut self,
        sql: String,
        connection_name: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> tokio::sync::oneshot::Receiver<Result<conn_contract::AgentPanelDatabaseResult, String>>
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if sql.trim().is_empty() {
            let _ = tx.send(Err("SQL query is empty.".to_owned()));
            return rx;
        }
        let connections = self.connections();
        let wanted = connection_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let picked = match wanted {
            Some(name) => connections
                .iter()
                .find(|c| c.name.trim().eq_ignore_ascii_case(name))
                .cloned(),
            None => self.selected_connection(),
        };
        let Some(connection) = picked else {
            let names = if connections.is_empty() {
                "none".to_owned()
            } else {
                connections
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let msg = match wanted {
                Some(name) => {
                    format!("No database connection named \"{name}\". Connections: {names}.")
                }
                None => format!(
                    "No database connection configured for this project. Connections: {names}."
                ),
            };
            let _ = tx.send(Err(msg));
            return rx;
        };

        self.pending_agent_sql = None;
        if let Some(project_key) = self.project_key.clone() {
            self.store.set_connection(&project_key, &connection.id);
            self.store
                .set_sql(&project_key, &connection.id, sql.clone());
            save_store(&self.store);
        }
        self.synced_sql = None;
        self.tab = "rows";

        let key = connection_key(&connection);
        self.run_id = self.run_id.wrapping_add(1);
        let run_id = self.run_id;
        let previous_result = self
            .query
            .as_ref()
            .filter(|q| q.key == key)
            .and_then(|q| q.result.clone());
        self.query = Some(QueryState {
            key: key.clone(),
            running: true,
            result: previous_result,
            error: None,
        });
        cx.notify();

        let options = self.take_call_options();
        let runner = self.runner.clone();
        let db_conn = connection.connection.clone();
        let task = crate::live::RT
            .spawn(async move { run_read_only_query(&runner, &db_conn, &sql, options).await });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let reply = match &outcome {
                Ok(Ok(result)) => {
                    let agent_res =
                        conn_desktop::database::api::agent_query_result(&connection, result);
                    Ok(conn_contract::AgentPanelDatabaseResult {
                        connection: agent_res.connection,
                        columns: agent_res.columns,
                        row_count: conn_contract::support::JsNumber(agent_res.row_count as f64),
                        rows: agent_res
                            .rows
                            .into_iter()
                            .map(|row| row.into_iter().collect())
                            .collect(),
                        truncated: agent_res.truncated,
                    })
                }
                Ok(Err(error)) => Err(error.to_string()),
                Err(join_error) => Err(join_error.to_string()),
            };
            let _ = this.update(cx, |panel, cx| {
                if panel.run_id == run_id {
                    panel.query = Some(match outcome {
                        Ok(Ok(result)) => QueryState {
                            key,
                            running: false,
                            result: Some(result),
                            error: None,
                        },
                        Ok(Err(error)) => QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(error.to_string()),
                        },
                        Err(join_error) => QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(join_error.to_string()),
                        },
                    });
                    cx.notify();
                }
            });
            let _ = tx.send(reply);
        })
        .detach();
        rx
    }

    fn run_sql(&mut self, statement: String, cx: &mut Context<'_, Self>) {
        if statement.trim().is_empty() {
            return;
        }
        let Some(connection) = self.selected_connection() else {
            return;
        };
        let key = connection_key(&connection);
        self.run_id = self.run_id.wrapping_add(1);
        let run_id = self.run_id;
        self.tab = "rows";
        let previous_result = self
            .query
            .as_ref()
            .filter(|q| q.key == key)
            .and_then(|q| q.result.clone());
        self.query = Some(QueryState {
            key: key.clone(),
            running: true,
            result: previous_result,
            error: None,
        });
        cx.notify();

        let options = self.take_call_options();
        let runner = self.runner.clone();
        let db_conn = connection.connection;
        let task = crate::live::RT.spawn(async move {
            run_read_only_query(&runner, &db_conn, &statement, options).await
        });
        cx.spawn(async move |this, cx| {
            let outcome = task.await;
            let _ = this.update(cx, |panel, cx| {
                if panel.run_id != run_id {
                    return;
                }
                match outcome {
                    Ok(Ok(result)) => {
                        panel.query = Some(QueryState {
                            key,
                            running: false,
                            result: Some(result),
                            error: None,
                        });
                    }
                    Ok(Err(error)) => {
                        panel.query = Some(QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(error.to_string()),
                        });
                    }
                    Err(join_error) => {
                        panel.query = Some(QueryState {
                            key,
                            running: false,
                            result: None,
                            error: Some(join_error.to_string()),
                        });
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn run_current_sql(&mut self, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.selected_connection() else {
            return;
        };
        let sql = self.current_sql(&connection.id);
        self.run_sql(sql, cx);
    }

    fn open_table(&mut self, name: String, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.selected_connection() else {
            return;
        };
        let key = connection_key(&connection);
        let statement = browse_table_sql(connection.connection.driver, &name);
        self.picked = Some(PickedTable {
            key,
            table: name.clone(),
        });
        if let Some(project_key) = self.project_key.clone() {
            self.store
                .set_sql(&project_key, &connection.id, statement.clone());
            save_store(&self.store);
            self.synced_sql = Some((project_key, connection.id.clone()));
        }
        self.sql_input.update(cx, |state, cx| {
            state.set_value(statement.clone(), window, cx)
        });
        self.ensure_columns_loaded(&connection, &name, cx);
        self.run_sql(statement, cx);
    }

    /// Opens the connection menu with an empty search that has the keyboard, or closes it.
    fn toggle_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.menu_open = !self.menu_open;
        if self.menu_open {
            self.reset_menu_search(window, cx);
            self.menu_input
                .update(cx, |input, cx| input.focus(window, cx));
            if self.vault_connections.is_empty() || self.vault_status.is_some() {
                self.load_vault_databases(false, cx);
            }
        }
        cx.notify();
    }

    fn reset_menu_search(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.menu_query.clear();
        self.menu_highlight = 0;
        self.menu_scroll.scroll_to_item(0);
        self.menu_input
            .update(cx, |input, cx| input.set_value("", window, cx));
    }

    /// The connections the menu shows for the current search.
    fn menu_rows(&self) -> PickerRows {
        PickerRows::new(&self.connections(), &self.menu_query)
    }

    /// Moves the highlight over the rows the search keeps and scrolls it into view.
    pub(super) fn move_menu_highlight(&mut self, delta: isize, cx: &mut Context<'_, Self>) {
        let rows = self.menu_rows();
        if rows.is_empty() {
            return;
        }
        self.menu_highlight = step_row(self.menu_highlight, delta, rows.len());
        self.menu_scroll
            .scroll_to_item(rows.child_index(self.menu_highlight));
        cx.notify();
    }

    /// Enter in the search: picks the highlighted row.
    pub(super) fn confirm_menu_highlight(&mut self, cx: &mut Context<'_, Self>) {
        let rows = self.menu_rows();
        let Some(id) = rows.get(self.menu_highlight).map(|c| c.id.clone()) else {
            return;
        };
        self.select_connection(&id, cx);
    }

    /// Escape in the open menu: it clears the search first, then closes the menu.
    fn escape_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.menu_query.is_empty() {
            self.menu_open = false;
        } else {
            self.reset_menu_search(window, cx);
        }
        cx.notify();
    }

    pub(super) fn select_connection(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        if let Some(project_key) = self.project_key.clone() {
            self.store.set_connection(&project_key, id);
            save_store(&self.store);
        }
        self.menu_open = false;
        self.allow_unlock_next = id.starts_with("vault:");
        self.synced_sql = None;
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    /// Closes the open connection and shows the empty state. The choice is saved, so neither a
    /// reload nor a refresh brings the `.env` database back.
    pub(super) fn disconnect(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(project_key) = self.project_key.clone() {
            self.store.set_connection(&project_key, DISCONNECTED);
            save_store(&self.store);
        }
        self.menu_open = false;
        self.editing = None;
        self.picked = None;
        self.query = None;
        self.tables_load = None;
        self.columns_load = None;
        self.synced_sql = None;
        self.run_id = self.run_id.wrapping_add(1);
        cx.notify();
    }

    /// "Unlock Vault…": lists the Vault databases again and lets Vault ask for its unlock.
    pub(super) fn unlock_vault(&mut self, cx: &mut Context<'_, Self>) {
        self.menu_open = false;
        self.allow_unlock_next = true;
        self.load_vault_databases(true, cx);
        cx.notify();
    }

    /// "Retry Vault" after a Vault error.
    pub(super) fn retry_vault(&mut self, cx: &mut Context<'_, Self>) {
        self.menu_open = false;
        self.load_vault_databases(true, cx);
        cx.notify();
    }

    pub(super) fn begin_add_connection(
        &mut self,
        seed_from_env: bool,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let seed = if seed_from_env {
            self.env_connection.as_ref()
        } else {
            None
        };
        let draft = new_connection(seed);
        self.menu_open = false;
        self.editing = Some(ConnectionFormState::new(draft, window, cx));
        cx.notify();
    }

    pub(super) fn begin_edit_selected(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(selected) = self.selected_connection() else {
            return;
        };
        let draft = if selected.source == ConnectionSource::Env {
            new_connection(Some(&selected))
        } else {
            selected
        };
        self.menu_open = false;
        self.editing = Some(ConnectionFormState::new(draft, window, cx));
        cx.notify();
    }

    pub(super) fn delete_selected_connection(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(project_key), Some(selected)) =
            (self.project_key.clone(), self.selected_connection())
        else {
            return;
        };
        if selected.source != ConnectionSource::Manual {
            return;
        }
        self.store.remove_connection(&project_key, &selected.id);
        save_store(&self.store);
        self.menu_open = false;
        self.synced_sql = None;
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    pub(super) fn cancel_editing(&mut self, cx: &mut Context<'_, Self>) {
        self.editing = None;
        cx.notify();
    }

    pub(super) fn save_editing(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(form) = self.editing.take() else {
            return;
        };
        if !form.can_save() {
            self.editing = Some(form);
            return;
        }
        let saved = finalize_draft(form.draft);
        if let Some(project_key) = self.project_key.clone() {
            self.store.save_connection(&project_key, saved);
            save_store(&self.store);
        }
        self.synced_sql = None;
        self.sync_inputs(window, cx);
        self.ensure_tables_loaded(cx);
        cx.notify();
    }

    fn refresh(&mut self, cx: &mut Context<'_, Self>) {
        self.reconnect_next = true;
        self.env_connection = load_env_connection(self.workspace_root.as_deref());
        self.load_vault_databases(false, cx);
        self.refresh_nonce = self.refresh_nonce.wrapping_add(1);
        self.tables_load = None;
        self.columns_load = None;
        self.ensure_tables_loaded(cx);
        if let Some(connection) = self.selected_connection() {
            let conn_key = connection_key(&connection);
            if let Some(table) = self
                .picked
                .as_ref()
                .filter(|p| p.key == conn_key)
                .map(|p| p.table.clone())
            {
                self.ensure_columns_loaded(&connection, &table, cx);
            }
        }
        cx.notify();
    }

    fn render_toolbar(
        &self,
        selected: Option<&PanelConnection>,
        tables_loading: bool,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let hover = to_hsla(tokens.shell_highlight);

        let mut trigger = chrome::toolbar_group(tokens)
            .id("db-connection-trigger")
            .test_support()
            .a11y_button(
                "database.connection.trigger",
                selected.map_or_else(
                    || "Choose a connection".to_owned(),
                    |conn| format!("Database connection: {}", conn.name),
                ),
            )
            .min_w_0()
            .max_w_full()
            .px(px(10.0))
            .gap(px(6.0))
            .items_center()
            .rounded(px(PILL_RADIUS_PX))
            .aria_expanded(self.menu_open)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .cursor_pointer()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .hover(move |s| s.bg(hover))
            .on_click({
                let entity = entity.clone();
                move |_, window, cx| {
                    entity.update(cx, |panel, cx| panel.toggle_menu(window, cx));
                }
            })
            .child(superhero_icon(
                "superhero/database.svg",
                ICON_BUTTON_GLYPH_PX,
                muted,
            ))
            .child(div().min_w_0().truncate().child(selected.map_or_else(
                || "Choose a connection".to_owned(),
                |conn| conn.name.clone(),
            )));

        if let Some(conn) = selected
            && conn.source != ConnectionSource::Vault
        {
            trigger = trigger.child(div().min_w_0().truncate().text_color(muted).child(
                connection_target(&conn.connection, conn.ssh_host.as_deref()),
            ));
        }

        trigger = trigger.child(superhero_icon(
            "superhero/chevron-down.svg",
            ICON_BUTTON_GLYPH_PX,
            muted,
        ));

        // Records where the trigger is, so the menu can fit the room above or below it.
        let trigger_bounds = Rc::clone(&self.trigger_bounds);
        let mut connection_anchor = div()
            .relative()
            .min_w_0()
            .flex_shrink(1.0)
            .child(
                canvas(
                    move |bounds, _, _| trigger_bounds.set(Some(bounds)),
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .child(trigger.flex_shrink(1.0));
        if self.menu_open {
            let total = self.connections().len();
            let rows = self.menu_rows();
            let wanted = menu_wanted_height(&rows, total, selected, self.vault_status);
            let placement = menu_placement(
                self.trigger_bounds.get(),
                window.viewport_size().height.as_f32(),
                wanted,
            );
            connection_anchor = connection_anchor.child(render_connection_menu(
                &ConnectionMenuView {
                    tokens,
                    total,
                    rows: &rows,
                    highlight: self.menu_highlight,
                    selected,
                    vault_status: self.vault_status,
                    vault_error: self.vault_error.as_deref(),
                    input: &self.menu_input,
                    scroll: &self.menu_scroll,
                    placement,
                },
                cx,
            ));
        }

        let refresh_icon = if tables_loading {
            "superhero/spinner.svg"
        } else {
            "superhero/refresh.svg"
        };
        // With nothing open there is nothing to reload: the same slot adds a connection.
        let tool_group = if selected.is_some() {
            chrome::icon_button("db-refresh-btn", refresh_icon, tokens, false, {
                let entity = entity.clone();
                move |_, _, cx| entity.update(cx, |panel, cx| panel.refresh(cx))
            })
            .test_support()
            .ml_auto()
            .size(px(chrome::CONTROL_HEIGHT_PX))
            .bg(to_hsla(tokens.shell_control))
            .border_1()
            .border_color(to_hsla(tokens.shell_divider_header))
            .conn_tooltip("Reload .env and tables", tokens)
            .into_any_element()
        } else {
            toolbar_tool(
                "db-add-btn",
                "superhero/add.svg",
                "Add connection",
                tokens,
                {
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |panel, cx| panel.begin_add_connection(true, window, cx));
                    }
                },
            )
            .ml_auto()
            .into_any_element()
        };

        // `.lab-db-toolbar`: 8px padding and a 32px control make 49px with the border. The
        // shared `toolbar_row` pads 7.5px and 11.5px; Tasks and the lab use 8px all round.
        let mut toolbar = chrome::toolbar_row(tokens)
            .id("db-toolbar")
            .test_support()
            .p(px(8.0))
            .child(connection_anchor)
            .child(tool_group);
        if let Some(connection) = selected.filter(|_| self.editing.is_none()) {
            let running = self
                .query
                .as_ref()
                .is_some_and(|q| q.key == connection_key(connection) && q.running);
            let disabled = running || self.current_sql(&connection.id).trim().is_empty();
            let icon = if running {
                "superhero/spinner.svg"
            } else {
                "superhero/play.svg"
            };
            let run_entity = entity.clone();
            let button = chrome::toolbar_group(tokens)
                .id("db-run-btn")
                .test_support()
                .a11y_button("panel.db-run-btn", "Run")
                .px(px(8.0))
                .gap(px(6.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(fg)
                .when(disabled, |el| el.opacity(0.4))
                .when(!disabled, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_click(move |_, _, cx| {
                            run_entity.update(cx, |panel, cx| panel.run_current_sql(cx))
                        })
                })
                .child(superhero_icon(icon, ICON_BUTTON_GLYPH_PX, muted))
                .child("Run");
            toolbar = toolbar.child(button).child(toolbar_tool(
                "db-disconnect-btn",
                "superhero/unplug.svg",
                "Disconnect",
                tokens,
                move |_, _, cx| entity.update(cx, |panel, cx| panel.disconnect(cx)),
            ));
        }
        toolbar.into_any_element()
    }

    fn render_workspace(
        &self,
        connection: &PanelConnection,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let conn_key = connection_key(connection);
        let expected_tables_key = format!("{conn_key}:{}", self.refresh_nonce);
        let tables_load = self
            .tables_load
            .as_ref()
            .filter(|load| load.key == expected_tables_key);
        let tables_loading = tables_load.is_some_and(|load| load.loading);
        let tables_error = tables_load.and_then(|load| load.error.as_deref());
        let tables = tables_load.and_then(|load| load.data.as_deref());

        let selected_table = self
            .picked
            .as_ref()
            .filter(|p| p.key == conn_key)
            .map(|p| p.table.as_str());

        let expected_columns_key =
            selected_table.map(|table| format!("{conn_key}:{table}:{}", self.refresh_nonce));
        let columns_load = expected_columns_key.as_deref().and_then(|expected| {
            self.columns_load
                .as_ref()
                .filter(|load| load.key == expected)
        });
        let columns = columns_load.and_then(|load| load.data.as_deref());
        let columns_error = columns_load.and_then(|load| load.error.as_deref());

        let current_query = self.query.as_ref().filter(|q| q.key == conn_key);
        let result = current_query.and_then(|q| q.result.as_ref());
        let running = current_query.is_some_and(|q| q.running);
        let query_error = current_query.and_then(|q| q.error.as_deref());
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);
        let highlight = to_hsla(tokens.shell_highlight);
        let row_hover = chrome::alpha(tokens.foreground, 0.04);

        // Table search and rows share the same left and right edges.
        let filter_field = chrome::soft_input_group(tokens)
            .id("db-table-filter")
            .a11y_group("panel.database.filter", "Filter tables")
            .px(px(9.0))
            .gap(px(6.0))
            .child(superhero_icon("superhero/search.svg", 14.0, muted))
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(&self.filter_input)
                        .aria_label("Filter tables")
                        .appearance(false)
                        .text_size(px(UI_TEXT_PX)),
                ),
            );

        let mut table_rows = v_flex()
            .id("db-tables-scroll")
            .a11y_group("panel.database.tables", "Tables")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .gap(px(chrome::LIST_ROW_GAP_PX))
            .px(px(chrome::LIST_INLINE_INSET_PX))
            .pb(px(8.0));

        if tables_loading {
            table_rows = table_rows.child(
                h_flex()
                    .w_full()
                    .justify_center()
                    .py(px(12.0))
                    .child(superhero_icon("superhero/spinner.svg", 16.0, muted)),
            );
        }
        if let Some(tables) = tables {
            let visible = filter_tables(tables, &self.filter);
            if visible.is_empty() {
                table_rows = table_rows.child(
                    div()
                        .px(px(10.0))
                        .py(px(8.0))
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child("No tables"),
                );
            } else {
                for name in visible {
                    let is_selected = selected_table == Some(name.as_str());
                    let click_name = name.clone();
                    let entity = entity.clone();
                    table_rows = table_rows.child(
                        h_flex()
                            .id(SharedString::from(format!("db-table-{name}")))
                            .a11y_button(format!("panel.database.table.{name}"), name.clone())
                            .aria_selected(is_selected)
                            .flex_shrink_0()
                            .h(px(chrome::LIST_ROW_HEIGHT_PX))
                            .w_full()
                            .items_center()
                            .rounded(px(chrome::LIST_ROW_RADIUS_PX))
                            .px(px(chrome::LIST_ROW_INSET_PX))
                            .pt(px(5.0))
                            .pb(px(7.0))
                            .cursor_pointer()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(if is_selected { fg } else { muted })
                            .when(is_selected, |el| el.bg(highlight))
                            .when(!is_selected, |el| {
                                el.hover(move |s| s.bg(row_hover).text_color(fg))
                            })
                            .on_click(move |_, window, cx| {
                                let table = click_name.clone();
                                entity.update(cx, |panel, cx| panel.open_table(table, window, cx));
                            })
                            .child(div().min_w_0().flex_1().truncate().child(name)),
                    );
                }
            }
        }

        let left_column = v_flex()
            .w(relative(0.29))
            .min_w(px(100.0))
            .max_w(px(TABLE_LIST_WIDTH_PX))
            .flex_shrink_0()
            .min_h_0()
            .border_r_1()
            .border_color(divider)
            .child(
                div()
                    .flex_shrink_0()
                    .pt(px(8.0))
                    .px(px(chrome::LIST_INLINE_INSET_PX))
                    .pb(px(chrome::SEARCH_LIST_GAP_PX))
                    .child(filter_field),
            )
            .child(table_rows);

        // ── Right column: SQL editor + Result tabs + Results ─────────────────
        let sql_editor = v_flex()
            .w_full()
            .flex_shrink_0()
            .h(px(SQL_EDITOR_HEIGHT_PX))
            .border_b_1()
            .border_color(divider)
            .child(
                div()
                    .id("db-sql-scroll")
                    .a11y_group("panel.database.sql", "SQL editor")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_y_scroll()
                    // The editor adds ~13px of its own inner padding: this puts the query text
                    // 16px from the column edge, and its first line on the table search text's
                    // vertical centre.
                    .pl(px(SQL_EDITOR_PAD_START_PX))
                    .pr(px(ROW_PAD_START_PX))
                    .pt(px(SQL_EDITOR_PAD_TOP_PX))
                    .pb(px(12.0))
                    .font_family(SharedString::from(MONO_FONT))
                    .child(
                        Editor::new(&self.sql_input)
                            .h(relative(1.0))
                            .aria_label("SQL query")
                            .font_family(SharedString::from(MONO_FONT))
                            .appearance(false)
                            .text_size(px(XS_TEXT_PX)),
                    ),
            )
            .when_some(result, |editor, result| {
                editor.child(
                    div()
                        .flex_shrink_0()
                        .text_right()
                        .pr(px(12.0))
                        .pb(px(4.0))
                        .font_family(SharedString::from(MONO_FONT))
                        .text_size(px(11.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(format_result_summary(result)),
                )
            });

        let tabs = [
            SectionTab {
                id: "rows",
                label: "Rows",
                count: result.map(|res| res.row_count),
            },
            SectionTab {
                id: "structure",
                label: "Structure",
                count: columns.map(<[DatabaseColumn]>::len),
            },
        ];
        let tabs_bar = chrome::section_tabs(
            "db-result-tabs",
            tokens,
            &tabs,
            self.tab,
            None,
            move |next_tab, _, cx| {
                entity.update(cx, |panel, cx| {
                    panel.tab = next_tab;
                    cx.notify();
                });
            },
        )
        .h(px(RESULT_TABS_HEIGHT_PX))
        .gap(px(10.0))
        // The first tab label starts on the SQL query's left edge too.
        .pl(px(views::RESULT_FIRST_COLUMN_PAD_START_PX))
        .pr(px(8.0));

        let result_body: AnyElement = if self.tab == "rows" {
            if let Some(err) = query_error {
                chrome::warning_notice(tokens, err.to_owned()).into_any_element()
            } else if let Some(res) = result {
                render_rows_grid(tokens, res)
            } else {
                div()
                    .px(px(ROW_PAD_START_PX))
                    .py(px(12.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(if running {
                        "Running…"
                    } else {
                        "Pick a table, or write a query and press ⌘↵."
                    })
                    .into_any_element()
            }
        } else if selected_table.is_none() {
            div()
                .px(px(ROW_PAD_START_PX))
                .py(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("Pick a table to see its columns.")
                .into_any_element()
        } else if let Some(err) = columns_error {
            chrome::warning_notice(tokens, err.to_owned()).into_any_element()
        } else if let Some(cols) = columns {
            render_structure_list(tokens, cols)
        } else {
            h_flex()
                .w_full()
                .justify_center()
                .py(px(12.0))
                .child(superhero_icon("superhero/spinner.svg", 16.0, muted))
                .into_any_element()
        };

        let right_column = v_flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(sql_editor)
            .child(tabs_bar)
            .child(
                div()
                    .id("db-result-scroll")
                    .a11y_group("panel.database.results", "Query results")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .when(self.tab == "rows" && result.is_some(), |el| {
                        el.overflow_x_scroll()
                    })
                    .when(self.tab != "rows" || result.is_none(), |el| {
                        el.overflow_y_scroll()
                    })
                    .child(result_body),
            );

        let mut container = v_flex().flex_1().min_h_0().w_full();
        if let Some(err) = tables_error {
            container = container.child(render_connection_alert(tokens, err));
        }
        container
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .items_stretch()
                    .child(left_column)
                    .child(right_column),
            )
            .into_any_element()
    }
}

/// A round 32px toolbar tool (`.lab-db-toolbar .tool`): a raised pill with a 14px glyph.
fn toolbar_tool(
    id: &'static str,
    icon_path: &'static str,
    label: &'static str,
    tokens: &Tokens,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> impl IntoElement + Styled {
    let hover = to_hsla(tokens.shell_highlight);
    div()
        .id(id)
        .test_support()
        .a11y_button(format!("panel.{id}"), label)
        .flex()
        .flex_shrink_0()
        .size(px(chrome::CONTROL_HEIGHT_PX))
        .items_center()
        .justify_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tokens.shell_control))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider_header))
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .on_click(on_click)
        .child(superhero_icon(
            icon_path,
            ICON_BUTTON_GLYPH_PX,
            to_hsla(tokens.muted_foreground),
        ))
        .conn_tooltip(label, tokens)
}

impl Render for DatabasePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.sync_inputs(window, cx);
        if self.project_key.is_none() {
            return chrome::empty_state(
                &self.tokens,
                "Database connections are only available from a project thread.",
            )
            .into_any_element();
        }

        let selected = self.selected_connection();
        let tables_loading = selected.as_ref().is_some_and(|conn| {
            let expected = format!("{}:{}", connection_key(conn), self.refresh_nonce);
            self.tables_load
                .as_ref()
                .is_some_and(|load| load.key == expected && load.loading)
        });

        let toolbar = self.render_toolbar(selected.as_ref(), tables_loading, window, cx);
        let body: AnyElement = if let Some(form) = &self.editing {
            form.render(&self.tokens, window, cx)
        } else if let Some(connection) = &selected {
            self.render_workspace(connection, cx)
        } else {
            self.render_empty_no_connection(window, cx)
        };

        v_flex()
            .id("database-panel")
            .a11y_group("panel.database", "Database")
            .size_full()
            // Capture phase intercepts Cmd+Enter / Ctrl+Enter before the SQL editor inserts a newline.
            .capture_key_down(cx.listener(|panel, event: &KeyDownEvent, window, cx| {
                let k = &event.keystroke;
                if panel.menu_open && k.key == "escape" {
                    panel.escape_menu(window, cx);
                    cx.stop_propagation();
                    return;
                }
                if k.key == "escape"
                    && let Some(form) = panel.editing.as_mut()
                    && form.driver_menu_open
                {
                    form.driver_menu_open = false;
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                if panel.editing.is_none()
                    && k.key == "enter"
                    && (k.modifiers.platform || k.modifiers.control)
                {
                    panel.run_current_sql(cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|panel, _, _, cx| {
                    if panel.menu_open {
                        panel.menu_open = false;
                        cx.notify();
                    }
                    if let Some(form) = panel.editing.as_mut()
                        && form.driver_menu_open
                    {
                        form.driver_menu_open = false;
                        cx.notify();
                    }
                }),
            )
            .when(self.menu_open, |el| el.on_mouse_down_out(cx.listener(|panel, _, _, cx| { panel.menu_open = false; cx.notify(); })))
            .child(toolbar)
            .child(body)
            .into_any_element()
    }
}
