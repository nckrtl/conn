//! The queued-message tray above the composer.
//!
//! Messages sent while a turn runs wait in the thread's queue. They are not timeline items: they
//! sit in a rounded tray, inset from the composer card's sides, whose bottom edge tucks behind the
//! card: a card peeking out from behind the prompt box. Each row is one queued message, top to bottom in the order the server
//! sends them, with `Steer` (send it into the running turn now), a trash button, and a `…` menu
//! (`Edit`, `Move up`, `Move down`). A row also drags up or down to change its place.
//!
//! The queue itself is server state: `Steer`, remove, edit and reorder are the existing
//! `queued-message.promote-to-steer` / `queued-run.start`, `queued-run.cancel`, `queued-run.edit`
//! and `queued-run.reorder` commands. The tray only draws it and emits [`ChatEvent`]s.

use std::time::{Duration, Instant};

use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, FocusHandle, Hsla,
    InteractiveElement as _, IntoElement as _, KeyDownEvent, MouseButton, MouseDownEvent,
    ParentElement as _, Pixels, Point, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, anchored, deferred, div, px,
};

use super::{ChatEvent, ChatView, icons};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::sidebar::thread_menu::{
    MENU_DISABLED_OPACITY, MENU_FONT_PX, MENU_LINE_PX, MENU_ROW_HEIGHT_PX, MENU_ROW_RADIUS_PX,
    MenuHighlight, menu_surface,
};
use crate::theme::{hsla, hsla_alpha};

/// Height of one queued message row.
pub(super) const ROW_HEIGHT_PX: f32 = 34.0;
/// Padding between the tray's edge and its rows.
const TRAY_PAD_PX: f32 = 4.0;
/// The tray shows this many rows, then scrolls. The half row says there is more below.
const MAX_VISIBLE_ROWS: f32 = 4.5;
/// How far the tray's bottom edge runs behind the composer card. It covers the composer's
/// rounded top corners, so the tray's sides carry on down behind them.
const TUCK_PX: f32 = 16.0;
/// How far the tray's left and right edges sit inside the composer's. Clear of the composer's
/// 16px corner curve, so the tucked part never shows past it.
pub(super) const TRAY_INSET_PX: f32 = 20.0;
/// Corner radius of the tray: the composer's.
const TRAY_RADIUS_PX: f32 = 16.0;
/// How far from the composer's fill toward the border colour the light tray's fill sits.
const LIGHT_FILL_MIX: f32 = 0.55;
/// An optimistic order the server has not confirmed is dropped after this long.
const ORDER_OVERRIDE_TTL: Duration = Duration::from_secs(5);

/// The tallest the rows area gets before it scrolls.
pub(super) const fn rows_max_height_px() -> f32 {
    ROW_HEIGHT_PX * MAX_VISIBLE_ROWS + TRAY_PAD_PX * 2.0
}

// ---------------------------------------------------------------------------------------------
// Reordering: which run a moved row goes before.
// ---------------------------------------------------------------------------------------------

/// Where moving the row at `from` to `slot` puts it, as the `beforeRunId` of `queued-run.reorder`.
///
/// `slot` is a gap between rows: `0` is above the first row and `run_ids.len()` is below the last.
/// Returns `None` when the move changes nothing (the row's own gaps, or a gap that is not there),
/// `Some(None)` to send the row to the end of the queue, and `Some(Some(id))` to put it right
/// before that run.
#[must_use]
pub(super) fn reorder_target<'a>(
    run_ids: &[&'a str],
    from: usize,
    slot: usize,
) -> Option<Option<&'a str>> {
    if from >= run_ids.len() || slot > run_ids.len() || slot == from || slot == from + 1 {
        return None;
    }
    Some(run_ids.get(slot).copied())
}

/// The queue order after moving the row at `from` into `slot` (see [`reorder_target`]).
#[must_use]
fn moved_order(run_ids: &[&str], from: usize, slot: usize) -> Vec<String> {
    let mut order: Vec<String> = run_ids.iter().map(|id| (*id).to_owned()).collect();
    if from >= order.len() || slot > order.len() {
        return order;
    }
    let moving = order.remove(from);
    order.insert(if slot > from { slot - 1 } else { slot }, moving);
    order
}

/// The gap a `Move up` (`-1`) or `Move down` (`1`) sends the row at `index` to, or `None` at the
/// ends of the queue.
#[must_use]
pub(super) fn step_slot(index: usize, total: usize, step: i8) -> Option<usize> {
    match step {
        s if s < 0 && index > 0 => Some(index - 1),
        s if s > 0 && index + 1 < total => Some(index + 2),
        _ => None,
    }
}

/// A row's one-line text: whitespace folded, or a stand-in when it only carries attachments.
#[must_use]
fn preview_text(text: &str, attachment_count: usize) -> String {
    let folded: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect();
    if !folded.is_empty() {
        return folded;
    }
    match attachment_count {
        0 => "Queued message".to_owned(),
        1 => "1 attachment".to_owned(),
        n => format!("{n} attachments"),
    }
}

// ---------------------------------------------------------------------------------------------
// The `…` menu.
// ---------------------------------------------------------------------------------------------

/// A row of a queued message's `…` menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum QueueMenuAction {
    Edit,
    MoveUp,
    MoveDown,
}

impl QueueMenuAction {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Edit => "Edit",
            Self::MoveUp => "Move up",
            Self::MoveDown => "Move down",
        }
    }

    fn ax_id(self) -> &'static str {
        match self {
            Self::Edit => "chat.queue.menu.edit",
            Self::MoveUp => "chat.queue.menu.move-up",
            Self::MoveDown => "chat.queue.menu.move-down",
        }
    }
}

/// The menu rows of the message at `index` of `total`, each with whether it can run: `Move up` is
/// off for the first message and `Move down` for the last.
#[must_use]
pub(super) fn menu_actions(index: usize, total: usize) -> [(QueueMenuAction, bool); 3] {
    [
        (QueueMenuAction::Edit, true),
        (
            QueueMenuAction::MoveUp,
            step_slot(index, total, -1).is_some(),
        ),
        (
            QueueMenuAction::MoveDown,
            step_slot(index, total, 1).is_some(),
        ),
    ]
}

/// The open `…` menu of one queued message.
pub(super) struct QueueMenu {
    run_id: String,
    position: Point<Pixels>,
    cursor: Option<usize>,
    /// What had the keyboard when the menu opened; it gets it back when the menu closes.
    return_focus: Option<FocusHandle>,
    /// The menu takes the keyboard on its first paint.
    focus_pending: bool,
}

/// Moves the highlight one enabled row down (`forward`) or up, wrapping at the ends.
#[must_use]
fn step_cursor(cursor: Option<usize>, enabled: &[bool], forward: bool) -> Option<usize> {
    let len = enabled.len();
    let mut at = cursor;
    for _ in 0..len {
        at = Some(match (at, forward) {
            (None, true) => 0,
            (None, false) => len - 1,
            (Some(i), true) => (i + 1) % len,
            (Some(i), false) => (i + len - 1) % len,
        });
        if at.is_some_and(|i| enabled[i]) {
            return at;
        }
    }
    cursor
}

// ---------------------------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------------------------

/// An order shown at once after a reorder, until the server's own order arrives.
struct OrderOverride {
    run_ids: Vec<String>,
    at: Instant,
}

/// What the tray remembers between frames.
pub(super) struct QueueState {
    menu: Option<QueueMenu>,
    /// The run being dragged, while a drag is over the tray.
    dragging: Option<String>,
    /// The gap the drag would drop into (see [`reorder_target`]).
    drop_slot: Option<usize>,
    order_override: Option<OrderOverride>,
    scroll: ScrollHandle,
}

impl QueueState {
    pub(super) fn new() -> Self {
        Self {
            menu: None,
            dragging: None,
            drop_slot: None,
            order_override: None,
            scroll: ScrollHandle::new(),
        }
    }

    /// Whether the `…` menu is open.
    pub(super) fn has_open_menu(&self) -> bool {
        self.menu.is_some()
    }
}

/// What a drag carries: the queued run it moves.
#[derive(Clone)]
struct QueueDrag {
    run_id: String,
    label: SharedString,
    colors: DragColors,
}

#[derive(Clone, Copy)]
struct DragColors {
    fg: Hsla,
    muted: Hsla,
    bg: Hsla,
    border: Hsla,
}

/// The row that follows the pointer while it drags: the row, lifted by a shadow.
struct QueueDragPreview {
    drag: QueueDrag,
}

impl Render for QueueDragPreview {
    fn render(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<'_, Self>,
    ) -> impl gpui_kit::IntoElement {
        let colors = self.drag.colors;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .h(px(ROW_HEIGHT_PX))
            .max_w(px(420.0))
            .px(px(10.0))
            .rounded(px(10.0))
            .bg(colors.bg)
            .border_1()
            .border_color(colors.border)
            .shadow(vec![gpui_kit::BoxShadow {
                color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.28),
                offset: gpui_kit::point(px(0.0), px(6.0)),
                blur_radius: px(16.0),
                spread_radius: px(0.0),
                inset: false,
            }])
            .text_size(px(13.0))
            .line_height(px(18.0))
            .text_color(colors.fg)
            .child(icons::icon(icons::REPLY_INDENT, 14.0, colors.muted))
            .child(div().min_w_0().truncate().child(self.drag.label.clone()))
    }
}

/// One queued message as the tray draws it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct QueueRow {
    /// The timeline entry id.
    pub(super) id: String,
    /// The queued run the queue commands name. Empty for a placeholder the server has not
    /// confirmed yet, which only shows.
    pub(super) run_id: String,
    pub(super) preview: String,
}

/// The tray's surface colours: the fill, one step off the composer's so the two read apart in
/// light and dark themes, and the border they share.
#[must_use]
pub(super) fn tray_surface_colors(tokens: &Tokens) -> (Hsla, Hsla) {
    let fill = match tokens.appearance {
        // The light theme's surfaces are all within a few percent of white, so no single one
        // reads apart from the composer's `card`. Halfway to the opaque `border` colour does.
        conn_theme::Appearance::Light => {
            let (card, border) = (tokens.card, tokens.border);
            hsla(conn_theme::Rgba {
                r: card.r + (border.r - card.r) * LIGHT_FILL_MIX,
                g: card.g + (border.g - card.g) * LIGHT_FILL_MIX,
                b: card.b + (border.b - card.b) * LIGHT_FILL_MIX,
                a: 1.0,
            })
        }
        conn_theme::Appearance::Dark => hsla(tokens.shell_raised),
    };
    (fill, hsla(tokens.shell_inner_border))
}

impl ChatView {
    /// The queued messages in the order the tray shows them: the server's, unless a reorder the
    /// server has not echoed yet is showing.
    pub(super) fn queue_rows(&self) -> Vec<QueueRow> {
        let mut rows: Vec<QueueRow> = self
            .cache
            .queued_runs()
            .map(|queued| QueueRow {
                id: queued.id.to_owned(),
                run_id: queued.run_id.to_owned(),
                preview: preview_text(queued.text, queued.attachment_count),
            })
            .collect();
        if let Some(over) = self
            .queue
            .order_override
            .as_ref()
            .filter(|over| over.at.elapsed() < ORDER_OVERRIDE_TTL)
        {
            let same_runs = rows.len() == over.run_ids.len()
                && rows.iter().all(|row| over.run_ids.contains(&row.run_id));
            if same_runs {
                rows.sort_by_key(|row| over.run_ids.iter().position(|id| *id == row.run_id));
            }
        }
        rows
    }

    /// Drops what the tray remembers about a finished sync: an optimistic order the server's order
    /// has caught up with (or that no longer fits the queue), and a drag that ended.
    pub(super) fn reconcile_queue_state(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(over) = &self.queue.order_override {
            let current: Vec<&str> = self
                .cache
                .queued_runs()
                .map(|queued| queued.run_id)
                .collect();
            let caught_up = current
                .iter()
                .copied()
                .eq(over.run_ids.iter().map(String::as_str));
            let same_runs = current.len() == over.run_ids.len()
                && current
                    .iter()
                    .all(|run| over.run_ids.iter().any(|id| id == run));
            if caught_up || !same_runs || over.at.elapsed() >= ORDER_OVERRIDE_TTL {
                self.queue.order_override = None;
                cx.notify();
            }
        }
        let still_queued = |run: &String| self.cache.queued_runs().any(|q| q.run_id == run);
        if self
            .queue
            .menu
            .as_ref()
            .is_some_and(|m| !still_queued(&m.run_id))
        {
            self.queue.menu = None;
            cx.notify();
        }
    }

    /// Forgets a drag that ended without a drop on a row (GPUI sends no event for that).
    pub(super) fn clear_stale_queue_drag(&mut self, cx: &App) {
        if (self.queue.dragging.is_some() || self.queue.drop_slot.is_some())
            && !cx.has_active_drag()
        {
            self.queue.dragging = None;
            self.queue.drop_slot = None;
        }
    }

    /// A reorder failed: show the server's order again.
    pub(crate) fn queue_reorder_failed(&mut self, cx: &mut Context<'_, Self>) {
        if self.queue.order_override.take().is_some() {
            cx.notify();
        }
    }

    /// Whether the queue tray is showing any message.
    #[cfg(test)]
    pub(crate) fn queue_tray_run_ids_for_test(&self) -> Vec<String> {
        self.queue_rows()
            .into_iter()
            .map(|row| row.run_id)
            .collect()
    }

    /// The queued run the composer is editing, if any.
    #[cfg(test)]
    pub(crate) fn editing_queued_run_id_for_test(&self) -> Option<String> {
        self.editing_queued_run_id.clone()
    }

    /// How many rows the timeline list holds.
    #[cfg(test)]
    pub(crate) fn timeline_item_count_for_test(&self) -> usize {
        self.cache.items().len()
    }

    /// How far the tray's rows scroll, at most, as a pixel distance (`0` when they all fit).
    #[cfg(test)]
    pub(crate) fn queue_tray_max_scroll_for_test(&self) -> f32 {
        f32::from(self.queue.scroll.max_offset().y).abs()
    }

    /// How far the tray's rows are scrolled.
    #[cfg(test)]
    pub(crate) fn queue_tray_scrolled_for_test(&self) -> f32 {
        -f32::from(self.queue.scroll.offset().y)
    }

    // ----- actions -------------------------------------------------------------------------

    /// `Edit`: loads the queued message into the composer.
    pub(super) fn edit_queued_run(
        &mut self,
        run_id: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(found) = self
            .cache
            .queued_runs()
            .find(|queued| queued.run_id == run_id)
            .map(|queued| queued.id.to_owned())
        else {
            return;
        };
        let Some((text, attachments)) = self.cache.rows().iter().find_map(|row| match &row.entry {
            conn_state::TimelineEntry::QueuedUser {
                run_id: row_run,
                text,
                attachments,
                ..
            } if row_run == run_id => Some((text.clone(), attachments.clone())),
            _ => None,
        }) else {
            return;
        };
        self.begin_edit_queued(found, run_id.to_owned(), text, attachments, window, cx);
    }

    /// `Steer`: sends the queued message into the running turn now (or starts a turn with it when
    /// the thread is idle).
    fn steer_queued_run(&mut self, run_id: &str, cx: &mut Context<'_, Self>) {
        cx.emit(ChatEvent::PromoteQueuedMessage {
            run_id: run_id.to_owned(),
        });
    }

    /// The trash button: removes the queued message from the queue.
    fn remove_queued_run(&mut self, run_id: &str, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.editing_queued_run_id.as_deref() == Some(run_id) {
            self.cancel_edit_queued(window, cx);
        }
        cx.emit(ChatEvent::CancelQueuedMessage {
            run_id: run_id.to_owned(),
        });
    }

    /// Moves a queued message into the gap `slot` (see [`reorder_target`]): the order shows at
    /// once, and the server is asked to deliver it in that order.
    pub(super) fn reorder_queued_run(
        &mut self,
        run_id: &str,
        slot: usize,
        cx: &mut Context<'_, Self>,
    ) {
        let rows = self.queue_rows();
        let run_ids: Vec<&str> = rows.iter().map(|row| row.run_id.as_str()).collect();
        let Some(from) = run_ids.iter().position(|id| *id == run_id) else {
            return;
        };
        let Some(before) = reorder_target(&run_ids, from, slot) else {
            return;
        };
        // A message the server has not confirmed has no run to name.
        if run_id.is_empty() || before.is_some_and(str::is_empty) {
            return;
        }
        let order = moved_order(&run_ids, from, slot);
        let before_run_id = before.map(str::to_owned);
        self.queue.order_override = Some(OrderOverride {
            run_ids: order,
            at: Instant::now(),
        });
        cx.emit(ChatEvent::ReorderQueuedMessage {
            run_id: run_id.to_owned(),
            before_run_id,
        });
        cx.notify();
    }

    /// `Move up` / `Move down`.
    pub(super) fn step_queued_run(&mut self, run_id: &str, step: i8, cx: &mut Context<'_, Self>) {
        let rows = self.queue_rows();
        let Some(index) = rows.iter().position(|row| row.run_id == run_id) else {
            return;
        };
        if let Some(slot) = step_slot(index, rows.len(), step) {
            self.reorder_queued_run(run_id, slot, cx);
        }
    }

    fn note_queue_drag_over(&mut self, run_id: &str, slot: usize, cx: &mut Context<'_, Self>) {
        if self.queue.dragging.as_deref() != Some(run_id) || self.queue.drop_slot != Some(slot) {
            self.queue.dragging = Some(run_id.to_owned());
            self.queue.drop_slot = Some(slot);
            cx.notify();
        }
    }

    fn drop_queue_drag(&mut self, run_id: &str, cx: &mut Context<'_, Self>) {
        let slot = self.queue.drop_slot.take();
        self.queue.dragging = None;
        match slot {
            Some(slot) => self.reorder_queued_run(run_id, slot, cx),
            None => cx.notify(),
        }
    }

    // ----- the `…` menu --------------------------------------------------------------------

    fn open_queue_menu(
        &mut self,
        run_id: String,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let return_focus = window.focused(cx);
        self.queue.menu = Some(QueueMenu {
            run_id,
            position,
            cursor: None,
            return_focus,
            focus_pending: true,
        });
        cx.notify();
    }

    pub(super) fn close_queue_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if let Some(menu) = self.queue.menu.take() {
            if let Some(handle) = menu.return_focus {
                window.focus(&handle, cx);
            }
            cx.notify();
        }
    }

    /// The enabled flags of the open menu's rows.
    fn queue_menu_enabled(&self) -> Vec<bool> {
        let Some(menu) = &self.queue.menu else {
            return Vec::new();
        };
        let rows = self.queue_rows();
        let index = rows.iter().position(|row| row.run_id == menu.run_id);
        match index {
            Some(index) => menu_actions(index, rows.len())
                .iter()
                .map(|(_, enabled)| *enabled)
                .collect(),
            None => vec![false; 3],
        }
    }

    fn queue_menu_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let enabled = self.queue_menu_enabled();
        let Some(menu) = &mut self.queue.menu else {
            return;
        };
        match event.keystroke.key.as_str() {
            "down" | "up" => {
                menu.cursor = step_cursor(menu.cursor, &enabled, event.keystroke.key == "down");
                cx.notify();
            }
            "enter" | "space" => {
                if let Some(index) = menu.cursor
                    && enabled.get(index).copied().unwrap_or(false)
                {
                    let action = [
                        QueueMenuAction::Edit,
                        QueueMenuAction::MoveUp,
                        QueueMenuAction::MoveDown,
                    ][index];
                    self.run_queue_menu_action(action, window, cx);
                }
            }
            "escape" | "tab" => self.close_queue_menu(window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    /// Runs the chosen row on the menu's message and closes the menu.
    pub(super) fn run_queue_menu_action(
        &mut self,
        action: QueueMenuAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(run_id) = self.queue.menu.as_ref().map(|menu| menu.run_id.clone()) else {
            return;
        };
        self.close_queue_menu(window, cx);
        match action {
            QueueMenuAction::Edit => self.edit_queued_run(&run_id, window, cx),
            QueueMenuAction::MoveUp => self.step_queued_run(&run_id, -1, cx),
            QueueMenuAction::MoveDown => self.step_queued_run(&run_id, 1, cx),
        }
    }

    /// The `…` menu, anchored at the pointer above everything else.
    pub(super) fn render_queue_menu(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        self.queue.menu.as_ref()?;
        let rows = self.queue_rows();
        let (position, cursor, run_id, focus_pending) = {
            let menu = self.queue.menu.as_mut()?;
            let pending = std::mem::take(&mut menu.focus_pending);
            (menu.position, menu.cursor, menu.run_id.clone(), pending)
        };
        if focus_pending {
            window.focus(&self.link_menu_focus, cx);
        }
        let index = rows.iter().position(|row| row.run_id == run_id)?;
        let actions = menu_actions(index, rows.len());
        let tokens = self.tokens.clone();
        let highlight = MenuHighlight::new(&tokens);
        let fg = hsla(tokens.popover_foreground);
        let mut list = menu_surface(SharedString::from("chat-queue-menu"), &tokens)
            .a11y(
                gpui_kit::Role::Menu,
                "chat.queue.menu",
                "Queued message menu",
            )
            .track_focus(&self.link_menu_focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.queue_menu_key(event, window, cx);
            }))
            .on_mouse_down_out(
                cx.listener(|this, _, window, cx| this.close_queue_menu(window, cx)),
            );
        for (row_index, (action, enabled)) in actions.into_iter().enumerate() {
            let highlighted = enabled && cursor == Some(row_index);
            let row = div()
                .id(SharedString::from(format!("chat-queue-menu-{row_index}")))
                .a11y(gpui_kit::Role::MenuItem, action.ax_id(), action.label())
                .aria_selected(highlighted)
                .flex()
                .items_center()
                .w_full()
                .min_h(px(MENU_ROW_HEIGHT_PX))
                .px(px(8.0))
                .py(px(4.0))
                .rounded(px(MENU_ROW_RADIUS_PX))
                .text_size(px(MENU_FONT_PX))
                .line_height(px(MENU_LINE_PX))
                .text_color(if highlighted { highlight.fg } else { fg })
                .when(highlighted, |row| row.bg(highlight.bg))
                .when(!enabled, |row| row.opacity(MENU_DISABLED_OPACITY))
                .when(enabled, |row| {
                    row.cursor_pointer()
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered
                                && let Some(menu) = &mut this.queue.menu
                                && menu.cursor != Some(row_index)
                            {
                                menu.cursor = Some(row_index);
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.run_queue_menu_action(action, window, cx);
                        }))
                })
                .child(div().flex_1().min_w_0().truncate().child(action.label()));
            #[cfg(test)]
            let row = gpui_kit::TestSupportExt::test_support(row);
            list = list.child(row);
        }
        #[cfg(test)]
        let list = gpui_kit::TestSupportExt::test_support(list);
        Some(
            deferred(
                anchored()
                    .position(position)
                    .snap_to_window_with_margin(px(8.0))
                    .child(list),
            )
            .with_priority(6)
            .into_any_element(),
        )
    }

    // ----- the tray ------------------------------------------------------------------------

    /// The tray: one row per queued message, or `None` for an empty queue.
    pub(super) fn render_queue_tray(&self, cx: &mut Context<'_, Self>) -> Option<AnyElement> {
        let rows = self.queue_rows();
        if rows.is_empty() {
            return None;
        }
        let total = rows.len();
        let (fill, border) = tray_surface_colors(&self.tokens);

        // The gap a drag would drop into, hidden when dropping there changes nothing.
        let drop_slot = self.queue.drop_slot.filter(|slot| {
            let from = self
                .queue
                .dragging
                .as_deref()
                .and_then(|run| rows.iter().position(|row| row.run_id == run));
            from.is_none_or(|from| *slot != from && *slot != from + 1)
        });

        let list = div()
            .id("chat-queue-rows")
            .flex()
            .flex_col()
            .w_full()
            .p(px(TRAY_PAD_PX))
            .max_h(px(rows_max_height_px()))
            .overflow_y_scroll()
            .track_scroll(&self.queue.scroll);
        #[cfg(test)]
        let list = gpui_kit::TestSupportExt::test_support(list);
        let mut list = list;
        for (index, row) in rows.iter().enumerate() {
            list = list.child(self.render_queue_row(index, total, row, drop_slot, cx));
        }

        let tray = div()
            .id("chat-queue-tray")
            .a11y_group("chat.queue", "Queued messages")
            .relative()
            // Narrower than the composer: a card peeking out from behind it.
            .mx(px(TRAY_INSET_PX))
            // Runs behind the composer card, which paints over the tucked part.
            .mb(px(-TUCK_PX))
            .pb(px(TUCK_PX))
            .rounded_t(px(TRAY_RADIUS_PX))
            .bg(fill)
            .border_1()
            .border_color(border)
            .overflow_hidden()
            .child(list);
        #[cfg(test)]
        let tray = gpui_kit::TestSupportExt::test_support(tray);
        Some(tray.into_any_element())
    }

    fn render_queue_row(
        &self,
        index: usize,
        total: usize,
        row: &QueueRow,
        drop_slot: Option<usize>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let hover_bg = hsla(tokens.shell_highlight);
        let primary = hsla(tokens.primary);
        let (tray_fill, tray_border) = tray_surface_colors(tokens);

        let id = row.id.clone();
        let run_id = row.run_id.clone();
        let has_run_id = !run_id.is_empty();
        let is_editing =
            has_run_id && self.editing_queued_run_id.as_deref() == Some(run_id.as_str());
        let is_dragged = self.queue.dragging.as_deref() == Some(run_id.as_str()) && has_run_id;
        let menu_open = self
            .queue
            .menu
            .as_ref()
            .is_some_and(|menu| menu.run_id == run_id);
        let line_above = drop_slot == Some(index);
        let line_below = drop_slot == Some(total) && index + 1 == total;

        let icon_button = |element_id: String, ax_id: String, label: &'static str| {
            div()
                .id(SharedString::from(element_id))
                .a11y_button(SharedString::from(ax_id), label)
                .flex()
                .items_center()
                .justify_center()
                .size(px(24.0))
                .rounded(px(6.0))
                .text_color(muted)
        };

        let mut actions = div()
            .flex()
            .flex_row()
            .flex_shrink_0()
            .items_center()
            .gap(px(2.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(muted);

        if is_editing {
            let cancel = div()
                .id(SharedString::from(format!("chat-queue-cancel-edit-{id}")))
                .a11y_button(
                    SharedString::from(format!("chat.queue.cancel-edit.{id}")),
                    "Cancel editing queued message",
                )
                .flex()
                .items_center()
                .h(px(24.0))
                .px(px(8.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_color(muted)
                .hover(move |s| s.bg(hover_bg).text_color(fg))
                .on_click(cx.listener(|view, _, window, cx| view.cancel_edit_queued(window, cx)))
                .child("Cancel");
            #[cfg(test)]
            let cancel = gpui_kit::TestSupportExt::test_support(cancel);
            actions = actions
                .child(
                    div()
                        .px(px(4.0))
                        .text_color(fg)
                        .child("Editing in the composer"),
                )
                .child(cancel);
        } else {
            let steer_tooltip = if self.working {
                "Send into the current turn"
            } else {
                "Start a turn with this message"
            };
            let run_for_steer = run_id.clone();
            let steer = div()
                .id(SharedString::from(format!("chat-queue-steer-{id}")))
                .a11y_button(
                    SharedString::from(format!("chat.queue.steer.{id}")),
                    "Steer",
                )
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(24.0))
                .px(px(6.0))
                .rounded(px(6.0))
                .text_color(muted)
                .when(has_run_id, |el| {
                    el.cursor_pointer()
                        .hover(move |s| s.bg(hover_bg).text_color(fg))
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.steer_queued_run(&run_for_steer, cx);
                        }))
                })
                .conn_tooltip(steer_tooltip, tokens)
                .child(icons::icon(icons::REPLY_INDENT, 12.0, muted))
                .child("Steer");
            #[cfg(test)]
            let steer = gpui_kit::TestSupportExt::test_support(steer);

            let run_for_remove = run_id.clone();
            let trash = icon_button(
                format!("chat-queue-remove-{id}"),
                format!("chat.queue.remove.{id}"),
                "Remove queued message",
            )
            .when(has_run_id, |el| {
                el.cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.remove_queued_run(&run_for_remove, window, cx);
                    }))
            })
            .conn_tooltip("Remove from queue", tokens)
            .child(icons::icon(icons::DELETE, 14.0, muted));
            #[cfg(test)]
            let trash = gpui_kit::TestSupportExt::test_support(trash);

            let run_for_menu = run_id.clone();
            let more = icon_button(
                format!("chat-queue-more-{id}"),
                format!("chat.queue.more.{id}"),
                "More actions for queued message",
            )
            .when(menu_open, |el| el.bg(hover_bg).text_color(fg))
            .when(has_run_id, |el| {
                el.cursor_pointer()
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |view, event: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            view.open_queue_menu(run_for_menu.clone(), event.position, window, cx);
                        }),
                    )
            })
            .conn_tooltip("More", tokens)
            .child(icons::icon(icons::MORE_HORIZONTAL, 14.0, muted));
            #[cfg(test)]
            let more = gpui_kit::TestSupportExt::test_support(more);

            actions = actions.child(steer).child(trash).child(more);
        }

        let drag_colors = DragColors {
            fg,
            muted,
            bg: tray_fill,
            border: tray_border,
        };
        let label = SharedString::from(row.preview.clone());
        let a11y_label = format!("Queued message {} of {total}: {}", index + 1, row.preview);

        let row_el = div()
            .id(SharedString::from(format!("chat-queue-row-{id}")))
            .a11y_group(SharedString::from(format!("chat.queue.row.{id}")), a11y_label)
            .relative()
            .flex()
            .flex_row()
            .flex_shrink_0()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .h(px(ROW_HEIGHT_PX))
            .pl(px(10.0))
            .pr(px(4.0))
            .rounded(px(8.0))
            .when(is_editing, |el| el.bg(hsla_alpha(tokens.primary, 0.12)))
            .when(!is_editing, |el| el.hover(move |s| s.bg(hover_bg)))
            .when(is_dragged, |el| el.opacity(0.4))
            .child(icons::icon(
                icons::REPLY_INDENT,
                14.0,
                hsla_alpha(tokens.muted_foreground, 0.8),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.0))
                    .line_height(px(18.0))
                    .text_color(fg)
                    .child(label.clone()),
            )
            .child(actions)
            // The drop indicator: a line in the gap the drag would drop into.
            .when(line_above, |el| el.child(drop_line(primary, true)))
            .when(line_below, |el| el.child(drop_line(primary, false)));

        let row_el = if has_run_id && !is_editing {
            let drag = QueueDrag {
                run_id,
                label,
                colors: drag_colors,
            };
            row_el
                .on_drag(drag, |drag, _offset, _window, cx| {
                    cx.new(|_| QueueDragPreview { drag: drag.clone() })
                })
                .on_drag_move::<QueueDrag>(cx.listener(
                    move |view, event: &DragMoveEvent<QueueDrag>, _window, cx| {
                        if !event.bounds.contains(&event.event.position) {
                            return;
                        }
                        let dragged = event.drag(cx).run_id.clone();
                        let slot = if event.event.position.y <= event.bounds.center().y {
                            index
                        } else {
                            index + 1
                        };
                        view.note_queue_drag_over(&dragged, slot, cx);
                    },
                ))
                .on_drop::<QueueDrag>(cx.listener(|view, dragged: &QueueDrag, _, cx| {
                    view.drop_queue_drag(&dragged.run_id, cx);
                }))
        } else {
            row_el
        };
        #[cfg(test)]
        let row_el = gpui_kit::TestSupportExt::test_support(row_el);
        row_el.into_any_element()
    }
}

/// The 2px line that marks where a dragged row would land, along the top or bottom of a row.
fn drop_line(color: Hsla, top: bool) -> AnyElement {
    let line = div()
        .absolute()
        .left(px(8.0))
        .right(px(8.0))
        .h(px(2.0))
        .rounded_full()
        .bg(color);
    if top { line.top_0() } else { line.bottom_0() }.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{
        QueueMenuAction, menu_actions, moved_order, preview_text, reorder_target, step_cursor,
        step_slot,
    };

    const IDS: [&str; 4] = ["a", "b", "c", "d"];

    #[test]
    fn a_row_dropped_in_a_gap_goes_before_the_row_below_that_gap() {
        // Down: `a` into the gap above `c` goes before `c`.
        assert_eq!(reorder_target(&IDS, 0, 2), Some(Some("c")));
        // Up: `d` into the gap above `b`.
        assert_eq!(reorder_target(&IDS, 3, 1), Some(Some("b")));
        // The gap below the last row sends it to the end.
        assert_eq!(reorder_target(&IDS, 0, 4), Some(None));
        // The first gap puts it first.
        assert_eq!(reorder_target(&IDS, 2, 0), Some(Some("a")));
    }

    #[test]
    fn a_row_dropped_back_in_one_of_its_own_gaps_does_not_move() {
        assert_eq!(reorder_target(&IDS, 1, 1), None);
        assert_eq!(reorder_target(&IDS, 1, 2), None);
        assert_eq!(reorder_target(&IDS, 3, 4), None);
        assert_eq!(reorder_target(&IDS, 0, 0), None);
        // There is no such row or gap.
        assert_eq!(reorder_target(&IDS, 9, 0), None);
        assert_eq!(reorder_target(&IDS, 0, 5), None);
    }

    #[test]
    fn the_new_order_puts_the_row_in_the_gap() {
        assert_eq!(moved_order(&IDS, 0, 2), ["b", "a", "c", "d"]);
        assert_eq!(moved_order(&IDS, 0, 4), ["b", "c", "d", "a"]);
        assert_eq!(moved_order(&IDS, 3, 1), ["a", "d", "b", "c"]);
        assert_eq!(moved_order(&IDS, 2, 0), ["c", "a", "b", "d"]);
        assert_eq!(moved_order(&IDS, 1, 2), ["a", "b", "c", "d"]);
    }

    #[test]
    fn the_new_order_matches_what_the_server_does_with_before_run_id() {
        // The server removes the run, then inserts it before `beforeRunId` (or at the end).
        for from in 0..IDS.len() {
            for slot in 0..=IDS.len() {
                let Some(before) = reorder_target(&IDS, from, slot) else {
                    continue;
                };
                let mut server: Vec<&str> = IDS.to_vec();
                let moving = server.remove(from);
                let at = before.map_or(server.len(), |id| {
                    server
                        .iter()
                        .position(|run| *run == id)
                        .expect("a queued run")
                });
                server.insert(at, moving);
                assert_eq!(
                    moved_order(&IDS, from, slot),
                    server,
                    "from {from} into gap {slot}"
                );
            }
        }
    }

    #[test]
    fn move_up_and_down_step_one_row_and_stop_at_the_ends() {
        assert_eq!(
            step_slot(0, 3, -1),
            None,
            "the first message cannot move up"
        );
        assert_eq!(
            step_slot(2, 3, 1),
            None,
            "the last message cannot move down"
        );
        assert_eq!(step_slot(1, 3, -1), Some(0));
        assert_eq!(step_slot(1, 3, 1), Some(3));
        assert_eq!(step_slot(0, 3, 1), Some(2));
        assert_eq!(step_slot(0, 1, 1), None);
        assert_eq!(step_slot(0, 1, -1), None);
        // Moving one down is "before the run after the next one".
        assert_eq!(reorder_target(&IDS, 0, 2), Some(Some("c")));
        assert_eq!(reorder_target(&IDS, 2, 4), Some(None));
    }

    #[test]
    fn the_menu_disables_the_moves_that_have_nowhere_to_go() {
        let enabled = |index, total| menu_actions(index, total).map(|(_, enabled)| enabled);
        assert_eq!(enabled(0, 3), [true, false, true]);
        assert_eq!(enabled(1, 3), [true, true, true]);
        assert_eq!(enabled(2, 3), [true, true, false]);
        assert_eq!(enabled(0, 1), [true, false, false]);
        assert_eq!(menu_actions(0, 2)[0].0, QueueMenuAction::Edit);
        assert_eq!(
            menu_actions(0, 2).map(|(action, _)| action.label()),
            ["Edit", "Move up", "Move down"]
        );
    }

    #[test]
    fn the_menu_keyboard_skips_disabled_rows() {
        let enabled = [true, false, true];
        assert_eq!(step_cursor(None, &enabled, true), Some(0));
        assert_eq!(step_cursor(Some(0), &enabled, true), Some(2));
        assert_eq!(step_cursor(Some(2), &enabled, true), Some(0));
        assert_eq!(step_cursor(Some(0), &enabled, false), Some(2));
        assert_eq!(step_cursor(None, &enabled, false), Some(2));
        assert_eq!(step_cursor(Some(1), &[false, false, false], true), Some(1));
    }

    #[test]
    fn a_row_shows_one_folded_line_of_its_message() {
        assert_eq!(
            preview_text("fix the\n  bug\n\nplease", 0),
            "fix the bug please"
        );
        assert_eq!(preview_text("   ", 0), "Queued message");
        assert_eq!(preview_text("", 1), "1 attachment");
        assert_eq!(preview_text("", 3), "3 attachments");
        assert_eq!(preview_text(&"x".repeat(1000), 0).chars().count(), 300);
    }
}
