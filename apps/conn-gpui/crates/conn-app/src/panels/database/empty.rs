//! The Database panel with no connection chosen (`NoConnection` in the desktop lab's
//! `DatabasePanel.tsx`, `.lab-db-pick` in `DatabasePanel.css`). A project with no database at all
//! gets the shared empty state. A project with databases but none open gets a plain list, 16px
//! below the toolbar: its connections, then Vault. The toolbar's + adds a connection.

use std::rc::Rc;

use conn_desktop::database::api::{ConnectionSource, PanelConnection, connection_target};
use conn_desktop::vault::VaultErrorKind;
use conn_theme::Tokens;
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, IntoElement, ParentElement, Role, SharedString, Styled, Window, div, px,
};

use super::DatabasePanel;
use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::panels::chrome::{UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::empty_state::{self, EmptyAction, EmptyState};
use crate::panels::header::superhero_icon;

/// `.lab-empty-list`: 300px wide lists.
const LIST_MAX_WIDTH_PX: f32 = 300.0;
/// `.lab-db-pick`: the list starts 16px below the toolbar.
const PICK_TOP_PAD_PX: f32 = 16.0;

impl DatabasePanel {
    /// Connections the picker lists: the `.env` one, then the saved ones.
    fn known_connections(&self) -> Vec<PanelConnection> {
        let mut known = Vec::new();
        known.extend(self.env_connection.clone());
        if let Some(key) = self.project_key.as_deref() {
            known.extend_from_slice(self.store.saved_connections(key));
        }
        known
    }

    pub(super) fn render_empty_no_connection(
        &self,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let known = self.known_connections();
        // A locked Vault may hold databases, so it keeps the list (and its Unlock row) in play.
        let vault_waiting = matches!(
            self.vault_status,
            Some(VaultErrorKind::Locked | VaultErrorKind::Error)
        );
        // The empty state is only for a project with no database at all.
        if known.is_empty() && self.vault_connections.is_empty() && !vault_waiting {
            return self.render_no_database(window, cx);
        }
        self.render_pick_list(&known, vault_waiting, cx)
    }

    fn render_no_database(&self, window: &Window, cx: &mut Context<'_, Self>) -> AnyElement {
        let entity = cx.entity();
        let description = vec![
            empty_state::word("This"),
            empty_state::word("project's"),
            empty_state::code(".env", ""),
            empty_state::word("has"),
            empty_state::word("no"),
            empty_state::code("DB_CONNECTION", "."),
        ]
        .into_iter()
        .chain(
            "Connect a database to browse its tables and run read-only queries."
                .split(' ')
                .map(empty_state::word),
        )
        .collect();
        empty_state::render_empty_state(
            window,
            &self.tokens,
            EmptyState {
                id: "db-empty",
                ax_id: "panel.database.empty",
                label: "Database connections",
                icon: "superhero/database.svg",
                title: SharedString::from("No database connected"),
                description,
                actions: vec![EmptyAction {
                    id: SharedString::from("db-empty-add"),
                    ax_id: SharedString::from("panel.database.empty.add"),
                    label: SharedString::from("Add connection"),
                    icon: Some("superhero/add.svg"),
                    on_click: Rc::new(move |window, cx| {
                        entity.update(cx, |panel, cx| panel.begin_add_connection(true, window, cx));
                    }),
                }],
            },
        )
    }

    /// `.lab-db-pick`: "Connections" and "Vault" lists, with no button: the toolbar's + adds one.
    fn render_pick_list(
        &self,
        known: &[PanelConnection],
        vault_waiting: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let muted = to_hsla(tokens.muted_foreground);
        let show_vault = !self.vault_connections.is_empty() || vault_waiting;

        let heading_style = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .test_support()
                .a11y(Role::Heading, format!("panel.database.pick.{id}"), label)
                .px(px(10.0))
                .mb(px(6.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(label)
        };

        let mut block = v_flex()
            .id("db-pick")
            .test_support()
            .a11y_group("panel.database.pick", "Database connections")
            .flex_1()
            .min_h_0()
            .w_full()
            .items_center()
            .overflow_y_scroll()
            .pt(px(PICK_TOP_PAD_PX))
            .px(px(24.0))
            .pb(px(24.0));

        if !known.is_empty() {
            let mut section = v_flex()
                .id("db-pick-connections")
                .test_support()
                .a11y_group("panel.database.pick.connections", "Project connections")
                .w_full()
                .max_w(px(LIST_MAX_WIDTH_PX))
                .gap(px(2.0))
                .text_left()
                .child(heading_style("db-pick-connections-heading", "Connections"));
            for connection in known {
                section = section.child(self.pick_row(connection, cx));
            }
            block = block.child(section);
        }

        if show_vault {
            let mut section = v_flex()
                .id("db-pick-vault")
                .test_support()
                .a11y_group("panel.database.pick.vault", "Vault databases")
                .w_full()
                .max_w(px(LIST_MAX_WIDTH_PX))
                // 16px under the connections; nothing above the first list.
                .when(!known.is_empty(), |s| s.mt(px(16.0)))
                .gap(px(2.0))
                .text_left()
                .child(heading_style("db-pick-vault-heading", "Vault"));
            for connection in &self.vault_connections {
                section = section.child(self.pick_row(connection, cx));
            }
            match self.vault_status {
                Some(VaultErrorKind::Locked) => {
                    section = section.child(self.vault_action_row(
                        "db-pick-unlock-vault",
                        "Unlock Vault…",
                        |panel, cx| panel.unlock_vault(cx),
                        cx,
                    ));
                }
                Some(VaultErrorKind::Error) => {
                    let message = self
                        .vault_error
                        .clone()
                        .unwrap_or_else(|| "Vault unavailable".to_owned());
                    section = section
                        .child(
                            div()
                                .px(px(10.0))
                                .py(px(4.0))
                                .text_size(px(XS_TEXT_PX))
                                .line_height(px(XS_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(message),
                        )
                        .child(self.vault_action_row(
                            "db-pick-retry-vault",
                            "Retry Vault",
                            |panel, cx| panel.retry_vault(cx),
                            cx,
                        ));
                }
                _ => {}
            }
            block = block.child(section);
        }

        block.into_any_element()
    }

    /// `.lab-empty-list button`: icon, name, muted target, chevron.
    fn pick_row(&self, connection: &PanelConnection, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let muted = to_hsla(tokens.muted_foreground);
        let target = if connection.source == ConnectionSource::Vault {
            connection.connection.database.clone()
        } else {
            connection_target(&connection.connection, connection.ssh_host.as_deref())
        };
        let id = connection.id.clone();
        let leading: AnyElement = match (connection.source, icons::vault_mark(16.0)) {
            (ConnectionSource::Vault, Some(mark)) => mark,
            _ => div()
                .mx(px(1.0))
                .child(superhero_icon("superhero/database.svg", 14.0, muted))
                .into_any_element(),
        };
        empty_row_shell(
            tokens,
            SharedString::from(format!("db-pick-row-{id}")),
            format!("panel.database.pick.connection.{id}"),
            connection.name.clone(),
            leading,
            target,
            move |_, _, cx| {
                let id = id.clone();
                entity.update(cx, |panel, cx| panel.select_connection(&id, cx));
            },
        )
    }

    fn vault_action_row(
        &self,
        id: &'static str,
        label: &'static str,
        action: fn(&mut DatabasePanel, &mut Context<'_, DatabasePanel>),
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let muted = to_hsla(tokens.muted_foreground);
        let leading = div()
            .mx(px(1.0))
            .child(superhero_icon("superhero/lock.svg", 14.0, muted))
            .into_any_element();
        empty_row_shell(
            tokens,
            SharedString::from(id),
            format!("panel.database.pick.{id}"),
            label.to_owned(),
            leading,
            String::new(),
            move |_, _, cx| entity.update(cx, action),
        )
    }
}

fn empty_row_shell(
    tokens: &Tokens,
    id: SharedString,
    ax_id: String,
    name: String,
    leading: AnyElement,
    target: String,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);
    let mut row = h_flex()
        .id(id)
        .test_support()
        .a11y_button(ax_id, name.clone())
        .w_full()
        .min_w_0()
        .px(px(10.0))
        .py(px(7.0))
        .gap(px(8.0))
        .items_center()
        .rounded(px(8.0))
        .cursor_pointer()
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(fg)
        .hover(move |s| s.bg(hover))
        .on_click(on_click)
        .child(leading)
        .child(div().min_w_0().truncate().child(name));
    row = row.child(
        div()
            .ml_auto()
            .min_w_0()
            .truncate()
            .text_size(px(XS_TEXT_PX))
            .text_color(muted)
            .child(target),
    );
    row.child(superhero_icon("superhero/chevron-right.svg", 12.0, muted))
        .into_any_element()
}
