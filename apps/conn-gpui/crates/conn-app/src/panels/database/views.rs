//! Stateless UI renderers for the Database surface: the `dropdown-glass` connection menu,
//! the scrollable result rows grid (`RowsGrid`), the table column structure list
//! (`StructureList`), and the connection error alert.

use crate::a11y::ConnA11yExt as _;
use conn_desktop::database::DatabaseColumn;
use conn_desktop::database::api::{
    ConnectionSource, DatabaseQueryResult, PanelConnection, connection_target,
};
use conn_desktop::vault::VaultErrorKind;
use conn_theme::{Appearance, Tokens};
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::input::{Enter, Input, InputState, MoveDown, MoveUp};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    Anchor, AnyElement, BoxShadow, Context, Entity, FontWeight, IntoElement, MouseButton,
    ParentElement, Role, ScrollHandle, SharedString, Styled, anchored, deferred, div, point, px,
    relative,
};

use super::super::chrome::{
    self, ConnTooltipExt as _, FloatingSurfaceExt as _, ROW_PAD_START_PX, UI_LINE_HEIGHT_PX,
    UI_TEXT_PX, XS_TEXT_PX,
};
use super::super::color::to_hsla;
use super::super::header::superhero_icon;
use super::DatabasePanel;
use super::picker::{MENU_SIDE_OFFSET_PX, MENU_WINDOW_MARGIN_PX, MenuPlacement, PickerRows};
use super::store::{CellDisplay, format_cell_value, format_column_details, measure_column_widths};
use crate::theme::MONO_FONT;

/// The menu's width. It is fixed, so filtering does not make it jump.
const MENU_WIDTH_PX: f32 = 340.0;
/// The search row's height: a 20px line with 10px above and 10px below, and its border.
const SEARCH_ROW_HEIGHT_PX: f32 = 41.0;

/// Everything the connection menu draws.
pub(crate) struct ConnectionMenuView<'a> {
    pub(crate) tokens: &'a Tokens,
    /// Every connection, before the search narrows them. The search shows only with some.
    pub(crate) total: usize,
    pub(crate) rows: &'a PickerRows,
    pub(crate) highlight: usize,
    pub(crate) selected: Option<&'a PanelConnection>,
    pub(crate) vault_status: Option<VaultErrorKind>,
    pub(crate) vault_error: Option<&'a str>,
    pub(crate) input: &'a Entity<InputState>,
    pub(crate) scroll: &'a ScrollHandle,
    pub(crate) placement: MenuPlacement,
}

/// What the menu measures with every row shown, to tell whether it would reach the window edge.
pub(crate) fn menu_wanted_height(
    rows: &PickerRows,
    total: usize,
    selected: Option<&PanelConnection>,
    vault_status: Option<VaultErrorKind>,
) -> f32 {
    let headings = usize::from(!rows.connections.is_empty()) + usize::from(!rows.vault.is_empty());
    let mut footer_rows = 1;
    if vault_status.is_some() {
        footer_rows += 1;
    }
    if selected.is_some_and(|conn| conn.source != ConnectionSource::Vault) {
        footer_rows += 1;
    }
    let search = if total > 0 { SEARCH_ROW_HEIGHT_PX } else { 0.0 };
    // Rows are 28px; headings 24px; padding and dividers add 8px each.
    search + 28.0 * (rows.len() + footer_rows) as f32 + 24.0 * headings as f32 + 16.0
}

/// Conn's `ConnectionMenu` popup (`dropdown-glass`, `sideOffset={6}`, `align="start"`): a search
/// field, the connections in a list that scrolls, and the actions below it.
pub(crate) fn render_connection_menu(
    view: &ConnectionMenuView<'_>,
    cx: &mut Context<'_, DatabasePanel>,
) -> AnyElement {
    let tokens = view.tokens;
    let entity = cx.entity();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let checked_bg = chrome::alpha(tokens.foreground, 0.08);
    let divider = chrome::alpha(tokens.foreground, 0.08);
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (18.0, 44.0, 0.80),
        Appearance::Light => (16.0, 40.0, 0.55),
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    };

    let mut menu = v_flex()
        .id("db-connection-menu")
        .test_support()
        .a11y_group("panel.database.connection-menu", "Connections")
        .w(px(MENU_WIDTH_PX))
        .max_h(px(view.placement.max_height))
        .rounded(px(8.0))
        .overflow_hidden()
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .floating_surface()
        // A click inside the menu is not a click outside it: the panel closes the menu on those.
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    if view.total > 0 {
        // The same search row as the model picker and the command palette.
        menu = menu.child(
            h_flex()
                .id("db-connection-search")
                .test_support()
                .a11y_group("panel.database.connection-search", "Search connections")
                .flex_none()
                .w_full()
                .h(px(SEARCH_ROW_HEIGHT_PX))
                .items_center()
                .gap(px(8.0))
                .px(px(12.0))
                .border_b_1()
                .border_color(divider)
                .capture_action(cx.listener(|panel, _: &MoveUp, _, cx| {
                    panel.move_menu_highlight(-1, cx);
                    cx.stop_propagation();
                }))
                .capture_action(cx.listener(|panel, _: &MoveDown, _, cx| {
                    panel.move_menu_highlight(1, cx);
                    cx.stop_propagation();
                }))
                .capture_action(cx.listener(|panel, _: &Enter, _, cx| {
                    panel.confirm_menu_highlight(cx);
                    cx.stop_propagation();
                }))
                .child(superhero_icon("superhero/search.svg", 14.0, muted))
                .child(
                    div().flex_1().min_w_0().child(
                        Input::new(view.input)
                            .aria_label("Search connections")
                            .appearance(false)
                            .pl(px(0.0))
                            .text_size(px(14.0))
                            .line_height(px(20.0)),
                    ),
                ),
        );
    }

    let heading = |id: &'static str, label: &'static str| {
        div()
            .id(id)
            .test_support()
            .a11y(Role::Heading, format!("panel.database.{id}"), label)
            .flex_shrink_0()
            .px(px(8.0))
            .py(px(4.0))
            .text_size(px(12.0))
            .text_color(muted)
            .child(label)
    };

    let selected_id = view.selected.map(|conn| conn.id.as_str());
    let mut list = v_flex()
        .id("db-connection-list")
        .test_support()
        .a11y_group("panel.database.connection-list", "Connection list")
        .w_full()
        .min_h_0()
        .p(px(4.0))
        .overflow_y_scroll()
        .track_scroll(view.scroll);

    let mut row_index = 0;
    for (group, label, group_id) in [
        (
            &view.rows.connections,
            "Connections",
            "db-connection-heading",
        ),
        (&view.rows.vault, "Vault", "db-vault-heading"),
    ] {
        if group.is_empty() {
            continue;
        }
        list = list.child(heading(group_id, label));
        for connection in group {
            let is_selected = selected_id == Some(connection.id.as_str());
            let is_highlighted = row_index == view.highlight;
            row_index += 1;
            let target = connection_target(&connection.connection, connection.ssh_host.as_deref());
            let id = connection.id.clone();
            let entity = entity.clone();
            list = list.child(
                h_flex()
                    .id(SharedString::from(format!("db-conn-item-{id}")))
                    .test_support()
                    .a11y_button(
                        format!("panel.database.connection.{id}"),
                        connection.name.clone(),
                    )
                    .flex_shrink_0()
                    .w_full()
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .when(is_selected, |el| el.bg(checked_bg))
                    .when(is_highlighted, |el| el.bg(highlight))
                    .hover(move |s| s.bg(highlight))
                    // A long name is cut with an ellipsis; the tooltip has all of it.
                    .conn_tooltip(format!("{} · {target}", connection.name), tokens)
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        cx.stop_propagation();
                        let id = id.clone();
                        entity.update(cx, |panel, cx| panel.select_connection(&id, cx));
                    })
                    .child(div().min_w_0().truncate().child(connection.name.clone()))
                    .child(
                        div()
                            .ml_auto()
                            .min_w_0()
                            .truncate()
                            .pl(px(12.0))
                            .text_color(muted)
                            .child(target),
                    ),
            );
        }
    }
    if view.rows.is_empty() && view.total > 0 {
        list = list.child(
            div()
                .id("db-connection-no-matches")
                .test_support()
                .a11y_group("panel.database.connection-no-matches", "No matches")
                .px(px(8.0))
                .py(px(8.0))
                .text_size(px(14.0))
                .line_height(px(20.0))
                .text_color(muted)
                .child("No matches"),
        );
    }
    if view.total > 0 {
        menu = menu.child(list);
    }

    // The actions stay below the list, so a long list never pushes them out of the window.
    let mut footer = v_flex()
        .id("db-connection-footer")
        .flex_none()
        .w_full()
        .p(px(4.0));
    if view.total > 0 {
        footer = footer.border_t_1().border_color(divider);
    }

    let menu_action = |id: &'static str,
                       label: &'static str,
                       on_pick: Box<
        dyn Fn(&mut DatabasePanel, &mut gpui_kit::Window, &mut Context<'_, DatabasePanel>),
    >| {
        let entity = entity.clone();
        h_flex()
            .id(id)
            .test_support()
            .a11y_button(format!("panel.database.{id}"), label)
            .w_full()
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .items_center()
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(14.0))
            .line_height(px(20.0))
            .text_color(fg)
            .hover(move |s| s.bg(highlight))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                entity.update(cx, |panel, cx| on_pick(panel, window, cx));
            })
            .child(div().min_w_0().flex_1().truncate().child(label))
    };
    let separator = || div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider);

    footer = footer.child(menu_action(
        "db-menu-add",
        "Add connection…",
        Box::new(|panel, window, cx| panel.begin_add_connection(true, window, cx)),
    ));

    match view.vault_status {
        Some(VaultErrorKind::Locked) => {
            footer = footer.child(separator());
            footer = footer.child(menu_action(
                "db-menu-unlock-vault",
                "Unlock Vault…",
                Box::new(|panel, _, cx| panel.unlock_vault(cx)),
            ));
        }
        Some(VaultErrorKind::Error) => {
            footer = footer.child(separator());
            let msg = view.vault_error.unwrap_or("Vault unavailable").to_owned();
            footer = footer.child(
                div()
                    .px(px(8.0))
                    .py(px(4.0))
                    .text_size(px(12.0))
                    .text_color(muted)
                    .child(msg),
            );
            footer = footer.child(menu_action(
                "db-menu-retry-vault",
                "Retry Vault",
                Box::new(|panel, _, cx| panel.retry_vault(cx)),
            ));
        }
        _ => {}
    }

    if let Some(selected) = view.selected
        && selected.source != ConnectionSource::Vault
    {
        let label = if selected.source == ConnectionSource::Env {
            "Copy to a new connection…"
        } else {
            "Edit connection…"
        };
        footer = footer.child(menu_action(
            "db-menu-edit",
            label,
            Box::new(|panel, window, cx| panel.begin_edit_selected(window, cx)),
        ));
    }

    if view
        .selected
        .is_some_and(|conn| conn.source == ConnectionSource::Manual)
    {
        footer = footer.child(menu_action(
            "db-menu-delete",
            "Delete connection",
            Box::new(|panel, _, cx| panel.delete_selected_connection(cx)),
        ));
    }
    menu = menu.child(footer);

    // Below the trigger, or above it when the window has more room there. `anchored` keeps the
    // menu inside the window sideways, as the other panel menus do.
    let opens_up = view.placement.opens_up;
    let edge = if opens_up {
        div().top(px(-MENU_SIDE_OFFSET_PX))
    } else {
        div().top(px(chrome::CONTROL_HEIGHT_PX + MENU_SIDE_OFFSET_PX))
    };
    deferred(
        edge.absolute().left(px(0.0)).child(
            anchored()
                .anchor(if opens_up {
                    Anchor::BottomLeft
                } else {
                    Anchor::TopLeft
                })
                .snap_to_window_with_margin(px(MENU_WINDOW_MARGIN_PX))
                .child(menu),
        ),
    )
    .with_priority(2)
    .into_any_element()
}

/// Top connection error alert (`tablesLoad.error` in `DatabasePanel.tsx`).
pub(crate) fn render_connection_alert(tokens: &Tokens, error: &str) -> AnyElement {
    let warning = to_hsla(tokens.warning);
    div()
        .w_full()
        .flex_shrink_0()
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider))
        .p(px(8.0))
        .child(
            h_flex()
                .items_start()
                .gap(px(8.0))
                .rounded(px(8.0))
                .bg(chrome::alpha(tokens.warning, 0.10))
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(warning)
                .child(div().mt(px(2.0)).flex_shrink_0().child(superhero_icon(
                    "superhero/error-circle.svg",
                    16.0,
                    warning,
                )))
                .child(div().flex_1().min_w_0().child(error.to_owned())),
        )
        .into_any_element()
}

/// The header and rows share a horizontal viewport. Only the rows scroll vertically.
pub(crate) fn render_rows_grid(tokens: &Tokens, result: &DatabaseQueryResult) -> AnyElement {
    if result.columns.is_empty() {
        return div()
            .px(px(ROW_PAD_START_PX))
            .py(px(12.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(to_hsla(tokens.muted_foreground))
            .child("The query returned no columns.")
            .into_any_element();
    }

    let mono: SharedString = MONO_FONT.into();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let null_color = chrome::alpha(tokens.muted_foreground, 0.7);
    let divider = to_hsla(tokens.shell_divider);
    let header_bg = to_hsla(tokens.shell_card);
    let row_hover = chrome::alpha(tokens.foreground, 0.04);

    let widths = measure_column_widths(result);
    let total_width: f32 = widths.iter().sum();
    let last_col = widths.len().saturating_sub(1);

    let mut header_row = h_flex()
        .id("db-results-header")
        .a11y_group("panel.database.results.header", "Result columns")
        .flex_shrink_0()
        .w_full()
        .min_w(px(total_width))
        .items_center()
        .bg(header_bg)
        .border_b_1()
        .border_color(divider)
        .font_family(mono.clone())
        .text_size(px(XS_TEXT_PX))
        .line_height(px(17.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(muted);

    for (index, column) in result.columns.iter().enumerate() {
        let width = widths.get(index).copied().unwrap_or(120.0);
        let mut cell = div()
            .px(px(12.0))
            // The first column starts on the SQL query's left edge.
            .when(index == 0, |cell| cell.pl(px(RESULT_FIRST_COLUMN_PAD_START_PX)))
            .py(px(10.0))
            .overflow_hidden()
            .whitespace_nowrap()
            .truncate()
            .child(column.clone());
        if index == last_col {
            cell = cell.flex_1().min_w(px(width));
        } else {
            cell = cell.w(px(width)).flex_shrink_0();
        }
        header_row = header_row.child(cell);
    }

    let mut body = v_flex()
        .id("db-results-body")
        .w_full()
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .font_family(mono)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(17.0));

    for (row_index, row) in result.rows.iter().enumerate() {
        let mut line = h_flex()
            .id(SharedString::from(format!("db-row-{row_index}")))
            .a11y_group(
                format!("panel.database.row.{row_index}"),
                format!("Result row {}", row_index + 1),
            )
            .flex_shrink_0()
            .w_full()
            .min_w(px(total_width))
            .items_center()
            .border_b_1()
            .border_color(divider)
            .text_color(fg)
            .hover(move |s| s.bg(row_hover));

        for (col_index, column) in result.columns.iter().enumerate() {
            let width = widths.get(col_index).copied().unwrap_or(120.0);
            let mut cell = div()
                .px(px(12.0))
                .when(col_index == 0, |cell| {
                    cell.pl(px(RESULT_FIRST_COLUMN_PAD_START_PX))
                })
                .py(px(10.0))
                .overflow_hidden()
                .whitespace_nowrap()
                .truncate();
            if col_index == last_col {
                cell = cell.flex_1().min_w(px(width));
            } else {
                cell = cell.w(px(width)).flex_shrink_0();
            }
            match format_cell_value(row.get(column)) {
                CellDisplay::Null => {
                    cell = cell.italic().text_color(null_color).child("NULL");
                }
                CellDisplay::Text(text) => {
                    cell = cell.child(text);
                }
            }
            line = line.child(cell);
        }
        body = body.child(line);
    }

    v_flex()
        .size_full()
        .min_w(px(total_width))
        .child(header_row)
        .child(body)
        .into_any_element()
}

/// Column metadata list (`StructureList` in `DatabasePanel.tsx`).
pub(crate) fn render_structure_list(tokens: &Tokens, columns: &[DatabaseColumn]) -> AnyElement {
    let mono: SharedString = MONO_FONT.into();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let warning = to_hsla(tokens.warning);
    let divider = to_hsla(tokens.shell_divider);

    let mut list = v_flex().w_full().pb(px(8.0));
    for column in columns {
        let mut name_col = h_flex()
            .w(relative(0.4))
            .flex_shrink_0()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .font_family(mono.clone())
            .text_size(px(XS_TEXT_PX))
            .line_height(px(17.0))
            .text_color(fg)
            .child(div().min_w_0().child(column.name.clone()));

        if column.primary {
            name_col = name_col.child(superhero_icon("superhero/key.svg", 12.0, warning));
        }

        list = list.child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(12.0))
                .py(px(8.0))
                .px(px(16.0))
                .border_b_1()
                .border_color(divider)
                .child(name_col)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .font_family(mono.clone())
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(17.0))
                        .text_color(muted)
                        .child(format_column_details(column)),
                ),
        );
    }
    list.into_any_element()
}

/// Left padding of a result table's first column (header and rows), so its text starts where the
/// SQL query above does (16px in from the column edge).
pub(super) const RESULT_FIRST_COLUMN_PAD_START_PX: f32 = 16.0;
