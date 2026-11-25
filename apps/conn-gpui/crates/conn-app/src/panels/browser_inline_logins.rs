//! Inline Vault login suggestions in the Browser panel (port of T3's
//! `CredentialInlineSuggestions.tsx` and `credentialInline.ts`).
//!
//! When a username, email or password field takes focus on an HTTPS page, the page's watcher
//! (`browser_overlay_bridge.js`) reports the field's kind and rectangle, nothing else. This
//! module turns that into a small picker the host draws under the field. The accounts are
//! native GPUI rows over the web view, so a website never receives the list. Lookups and fills
//! go through the panel's existing Vault paths (`VaultClient::list_logins` and
//! `login_credential`).

use conn_desktop::vault::{
    VaultLoginField, VaultLoginItem, VaultLoginsResponse, VaultLoginsStatus,
};
use conn_theme::Tokens;
use conn_web::Rect as WebRect;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement as _, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, anchored, deferred, div, px,
};
use serde_json::Value;

use super::color::to_hsla;
use super::header::superhero_icon;
use crate::a11y::ConnA11yExt as _;

pub(super) const PICKER_WIDTH_PX: f32 = 280.0;
/// Space between the field and the picker (`sideOffset={6}` in T3).
const PICKER_GAP_PX: f32 = 6.0;
const PICKER_PAD_PX: f32 = 4.0;
const ROW_GAP_PX: f32 = 2.0;
const PICKER_MAX_HEIGHT_PX: f32 = 280.0;
const HEADING_HEIGHT_PX: f32 = 24.0;
const NOTE_HEIGHT_PX: f32 = 30.0;
const LOGIN_HEIGHT_PX: f32 = 42.0;
const LOGIN_PLAIN_HEIGHT_PX: f32 = 30.0;
/// A rectangle larger than this is not a form field.
const MAX_ANCHOR_PX: f64 = 1_000_000.0;
/// The largest integer a page's number can hold exactly.
const MAX_SAFE_REVISION: u64 = 1 << 53;

const VAULT_HEADING: &str = "Vault · this Mac";

/// Which sign-in fields the page shows. Booleans only; no values leave the page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct PageFields {
    pub(super) username: bool,
    pub(super) password: bool,
    pub(super) otp: bool,
}

impl PageFields {
    /// The fields one pick fills, from what the page shows (T3's `fieldsToFill`).
    pub(super) fn fields_to_fill(self) -> Vec<VaultLoginField> {
        if self.password {
            if self.username {
                vec![VaultLoginField::Username, VaultLoginField::Password]
            } else {
                vec![VaultLoginField::Password]
            }
        } else if self.otp {
            vec![VaultLoginField::Otp]
        } else if self.username {
            vec![VaultLoginField::Username]
        } else {
            Vec::new()
        }
    }

    fn only(field: VaultLoginField) -> Self {
        Self {
            username: field == VaultLoginField::Username,
            password: field == VaultLoginField::Password,
            otp: field == VaultLoginField::Otp,
        }
    }
}

/// The focused field's kind and rectangle in the page's viewport (CSS pixels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct InlineAnchor {
    pub(super) field: VaultLoginField,
    pub(super) page: PageFields,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum InlineEventKind {
    Focus,
    Layout,
    Dismiss,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct InlineEvent {
    pub(super) kind: InlineEventKind,
    pub(super) anchor: Option<InlineAnchor>,
}

/// Rejects malformed guest metadata, including off-page and unreasonable rectangles
/// (`parseCredentialInlineEvent`).
pub(super) fn parse_inline_event(value: &Value) -> Option<InlineEvent> {
    let object = value.as_object()?;
    object
        .get("revision")?
        .as_u64()
        .filter(|revision| *revision <= MAX_SAFE_REVISION)?;
    let kind = match object.get("kind")?.as_str()? {
        "focus" => InlineEventKind::Focus,
        "layout" => InlineEventKind::Layout,
        "dismiss" => InlineEventKind::Dismiss,
        _ => return None,
    };
    let anchor = match object.get("anchor")? {
        Value::Null => None,
        anchor => Some(parse_anchor(anchor)?),
    };
    Some(InlineEvent { kind, anchor })
}

fn parse_anchor(value: &Value) -> Option<InlineAnchor> {
    let object = value.as_object()?;
    let field = match object.get("field")?.as_str()? {
        "username" => VaultLoginField::Username,
        "password" => VaultLoginField::Password,
        "otp" => VaultLoginField::Otp,
        _ => return None,
    };
    let number = |key: &str| object.get(key)?.as_f64().filter(|n| n.is_finite());
    let (x, y) = (number("x")?, number("y")?);
    let (width, height) = (number("width")?, number("height")?);
    let (viewport_width, viewport_height) = (number("viewportWidth")?, number("viewportHeight")?);
    if width <= 0.0
        || height <= 0.0
        || viewport_width <= 0.0
        || viewport_height <= 0.0
        || width > MAX_ANCHOR_PX
        || height > MAX_ANCHOR_PX
        || viewport_width > MAX_ANCHOR_PX
        || viewport_height > MAX_ANCHOR_PX
        || x + width <= 0.0
        || y + height <= 0.0
        || x >= viewport_width
        || y >= viewport_height
    {
        return None;
    }
    // A watcher that does not say what else the page shows fills the focused field alone.
    let page = object.get("page").and_then(Value::as_object).map_or_else(
        || PageFields::only(field),
        |page| {
            let flag = |key: &str| page.get(key).and_then(Value::as_bool).unwrap_or(false);
            PageFields {
                username: flag("username"),
                password: flag("password"),
                otp: flag("otp"),
            }
        },
    );
    Some(InlineAnchor {
        field,
        page,
        x,
        y,
        width,
        height,
        viewport_width,
        viewport_height,
    })
}

/// The field's rectangle in window coordinates: the page's viewport scaled onto the web view
/// (`credentialInlineRect`).
pub(super) fn anchor_rect(anchor: &InlineAnchor, view: WebRect) -> WebRect {
    let scale_x = f64::from(view.width) / anchor.viewport_width;
    let scale_y = f64::from(view.height) / anchor.viewport_height;
    WebRect {
        x: (f64::from(view.x) + anchor.x * scale_x) as f32,
        y: (f64::from(view.y) + anchor.y * scale_y) as f32,
        width: (anchor.width * scale_x) as f32,
        height: (anchor.height * scale_y) as f32,
    }
}

/// Top-left corner of a picker of `size` for a field at `field`: under it, left edges aligned,
/// kept inside the web view. It flips above the field when it does not fit below and does fit
/// above.
pub(super) fn picker_origin(field: WebRect, size: (f32, f32), view: WebRect) -> (f32, f32) {
    let (width, height) = size;
    let below = field.y + field.height + PICKER_GAP_PX;
    let above = field.y - PICKER_GAP_PX - height;
    let y = if below + height <= view.y + view.height || above < view.y {
        below
    } else {
        above
    };
    let max_x = (view.x + view.width - width).max(view.x);
    (field.x.clamp(view.x, max_x), y)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PickerRow {
    Heading(&'static str),
    Login {
        id: String,
        title: String,
        username: Option<String>,
    },
    /// A status line: not a choice.
    Note(String),
    Unlock {
        retry: bool,
    },
}

impl PickerRow {
    fn actionable(&self) -> bool {
        matches!(self, Self::Login { .. } | Self::Unlock { .. })
    }

    fn height(&self) -> f32 {
        match self {
            Self::Heading(_) => HEADING_HEIGHT_PX,
            Self::Login {
                username: Some(_), ..
            } => LOGIN_HEIGHT_PX,
            Self::Login { .. } => LOGIN_PLAIN_HEIGHT_PX,
            Self::Note(_) | Self::Unlock { .. } => NOTE_HEIGHT_PX,
        }
    }
}

/// What choosing a row does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RowAction {
    Fill(String),
    Unlock,
}

/// What a key press does while the picker is up.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum KeyOutcome {
    /// Not the picker's key: the page gets it.
    Pass,
    /// The picker took it; the page does not see it.
    Handled,
    /// Enter on a row. The picker took the key.
    Run(RowAction),
    /// Escape closed the picker. The page still gets the key, as in T3.
    Dismissed,
}

#[derive(Default)]
pub(super) struct InlineLogins {
    anchor: Option<InlineAnchor>,
    open: bool,
    /// The row the keyboard or pointer is on.
    cursor: Option<usize>,
    loading: bool,
    status: Option<VaultLoginsStatus>,
    items: Vec<VaultLoginItem>,
    /// Why the last pick did not fill, shown in the picker.
    feedback: Option<String>,
    /// The native unlock prompt is up: the page losing focus must not close the picker.
    unlocking: bool,
    generation: u64,
}

impl InlineLogins {
    pub(super) fn anchor(&self) -> Option<&InlineAnchor> {
        self.anchor.as_ref()
    }

    /// The picker is on screen.
    pub(super) fn shown(&self) -> bool {
        self.open && self.anchor.is_some()
    }

    /// Takes what the watcher reported. Returns `true` when a field took focus and the picker
    /// opened, so the caller looks up logins.
    pub(super) fn apply_event(&mut self, event: &InlineEvent) -> bool {
        self.anchor = event.anchor;
        if self.anchor.is_none() || event.kind == InlineEventKind::Dismiss {
            if !self.unlocking {
                self.close();
            }
            return false;
        }
        if event.kind == InlineEventKind::Focus {
            self.open = true;
            self.cursor = None;
            self.feedback = None;
            return true;
        }
        false
    }

    pub(super) fn close(&mut self) {
        self.open = false;
        self.cursor = None;
    }

    /// Forgets the field and the lookup: a new page, or a panel that left the screen.
    pub(super) fn reset(&mut self) {
        self.anchor = None;
        self.open = false;
        self.cursor = None;
        self.loading = false;
        self.unlocking = false;
        self.status = None;
        self.items.clear();
        self.feedback = None;
        self.generation += 1;
    }

    /// Starts a lookup unless one is running (T3 skips a refresh while Vault is busy; an unlock
    /// goes ahead anyway). Returns the lookup's generation.
    pub(super) fn begin_lookup(&mut self, allow_unlock: bool) -> Option<u64> {
        if self.loading && !allow_unlock {
            return None;
        }
        self.generation += 1;
        self.loading = true;
        self.unlocking = allow_unlock;
        self.feedback = None;
        Some(self.generation)
    }

    /// Takes a lookup's answer. A stale one (the page changed, or a newer lookup began) is
    /// dropped and `false` returned.
    pub(super) fn finish_lookup(&mut self, generation: u64, response: VaultLoginsResponse) -> bool {
        if generation != self.generation {
            return false;
        }
        self.loading = false;
        self.unlocking = false;
        self.status = Some(response.status);
        self.items = response.items;
        if !self
            .cursor
            .and_then(|index| self.rows().into_iter().nth(index))
            .is_some_and(|row| row.actionable())
        {
            self.cursor = None;
        }
        true
    }

    /// A fill ended without a value. Shows why, and keeps the picker up for another try.
    pub(super) fn fail(&mut self, message: &str) {
        self.feedback = Some(message.to_owned());
        if self.anchor.is_some() {
            self.open = true;
        }
    }

    pub(super) fn rows(&self) -> Vec<PickerRow> {
        let mut rows = vec![PickerRow::Heading(VAULT_HEADING)];
        if let Some(feedback) = &self.feedback {
            rows.push(PickerRow::Note(feedback.clone()));
        }
        rows.extend(self.items.iter().map(|item| {
            PickerRow::Login {
                id: item.id.clone(),
                title: item.title.clone(),
                username: item
                    .username
                    .clone()
                    .filter(|username| *username != item.title),
            }
        }));
        if self.loading {
            rows.push(PickerRow::Note("Checking Vault…".to_owned()));
        } else {
            match self.status {
                Some(VaultLoginsStatus::Locked) => rows.push(PickerRow::Unlock { retry: false }),
                Some(VaultLoginsStatus::Error) => rows.push(PickerRow::Unlock { retry: true }),
                Some(VaultLoginsStatus::Unavailable) => {
                    rows.push(PickerRow::Note("Vault is not installed".to_owned()));
                }
                Some(VaultLoginsStatus::Ok) if self.items.is_empty() => {
                    rows.push(PickerRow::Note("No Vault logins for this site".to_owned()));
                }
                Some(VaultLoginsStatus::Ok) | None => {}
            }
        }
        rows
    }

    /// The picker's size in logical pixels, from its rows.
    pub(super) fn size(&self) -> (f32, f32) {
        let rows = self.rows();
        let gaps = ROW_GAP_PX * rows.len().saturating_sub(1) as f32;
        let content: f32 = rows.iter().map(PickerRow::height).sum::<f32>() + gaps;
        let height = (content + PICKER_PAD_PX * 2.0 + 2.0).min(PICKER_MAX_HEIGHT_PX);
        (PICKER_WIDTH_PX, height)
    }

    /// Highlights the row under the pointer (a heading or a status line takes no highlight).
    pub(super) fn hover(&mut self, index: usize) {
        if self.rows().get(index).is_some_and(PickerRow::actionable) {
            self.cursor = Some(index);
        }
    }

    /// Moves the keyboard highlight to the next (`forward`) or previous row you can choose,
    /// wrapping at the ends.
    pub(super) fn step(&mut self, forward: bool) {
        let rows = self.rows();
        let choices: Vec<usize> = (0..rows.len()).filter(|&i| rows[i].actionable()).collect();
        if choices.is_empty() {
            self.cursor = None;
            return;
        }
        let at = self
            .cursor
            .and_then(|cursor| choices.iter().position(|&row| row == cursor));
        let next = match (at, forward) {
            (None, true) => 0,
            (None, false) => choices.len() - 1,
            (Some(i), true) => (i + 1) % choices.len(),
            (Some(i), false) => (i + choices.len() - 1) % choices.len(),
        };
        self.cursor = Some(choices[next]);
    }

    pub(super) fn action(&self, index: usize) -> Option<RowAction> {
        match self.rows().into_iter().nth(index)? {
            PickerRow::Login { id, .. } => Some(RowAction::Fill(id)),
            PickerRow::Unlock { .. } => Some(RowAction::Unlock),
            PickerRow::Heading(_) | PickerRow::Note(_) => None,
        }
    }

    /// Arrow keys move the highlight, Enter picks it, Escape closes the picker. Anything else,
    /// and Enter with no highlight (it submits the form), goes to the page.
    pub(super) fn handle_key(&mut self, key: &str) -> KeyOutcome {
        if !self.shown() {
            return KeyOutcome::Pass;
        }
        match key {
            // With nothing to choose the arrow keys are the page's (scrolling, say).
            "down" | "up" if !self.rows().iter().any(PickerRow::actionable) => KeyOutcome::Pass,
            "down" => {
                self.step(true);
                KeyOutcome::Handled
            }
            "up" => {
                self.step(false);
                KeyOutcome::Handled
            }
            "enter" => self
                .cursor
                .and_then(|index| self.action(index))
                .map_or(KeyOutcome::Pass, KeyOutcome::Run),
            "escape" => {
                self.close();
                KeyOutcome::Dismissed
            }
            _ => KeyOutcome::Pass,
        }
    }

    /// The fields one pick fills.
    pub(super) fn fields_to_fill(&self) -> Vec<VaultLoginField> {
        let Some(anchor) = &self.anchor else {
            return Vec::new();
        };
        let fields = anchor.page.fields_to_fill();
        if fields.is_empty() {
            vec![anchor.field]
        } else {
            fields
        }
    }
}

/// What the picker's rows do in the panel that owns them.
pub(super) struct PickerActions<T> {
    pub(super) choose: fn(&mut T, usize, &mut Window, &mut Context<'_, T>),
    pub(super) hover: fn(&mut T, usize, &mut Context<'_, T>),
    /// A press outside the picker.
    pub(super) dismiss: fn(&mut T, &mut Window, &mut Context<'_, T>),
}

/// The picker with its top-left corner at `origin` (window coordinates), above everything else.
pub(super) fn render_picker<T: 'static>(
    state: &InlineLogins,
    origin: (f32, f32),
    tokens: &Tokens,
    actions: &PickerActions<T>,
    cx: &mut Context<'_, T>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let dismiss = actions.dismiss;

    // Styled like the toolbar's Vault popover. The surface blocks the mouse for the whole card
    // (what `floating_surface` does), so rows of the page behind it do not light up and a
    // press does not reach the page.
    let mut list = v_flex()
        .id("browser-vault-inline")
        .test_support()
        .a11y_group("browser.vault.inline", "Saved logins for this field")
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down_out(cx.listener(move |this, _, window, cx| dismiss(this, window, cx)))
        .w(px(PICKER_WIDTH_PX))
        .max_h(px(PICKER_MAX_HEIGHT_PX))
        .overflow_y_scroll()
        .p(px(PICKER_PAD_PX))
        .gap(px(ROW_GAP_PX))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(to_hsla(tokens.shell_inner_border))
        .shadow_lg();

    for (index, row) in state.rows().into_iter().enumerate() {
        let highlighted = state.cursor == Some(index) && row.actionable();
        let height = row.height();
        match row {
            PickerRow::Heading(label) => {
                list = list.child(
                    div()
                        .id(SharedString::from(format!("browser-vault-inline-{index}")))
                        .a11y_group(format!("browser.vault.inline.heading.{index}"), label)
                        .h(px(height))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .text_size(px(11.0))
                        .text_color(muted)
                        .child(label),
                );
            }
            PickerRow::Note(text) => {
                list = list.child(
                    div()
                        .id(SharedString::from(format!("browser-vault-inline-{index}")))
                        .a11y_group(format!("browser.vault.inline.note.{index}"), text.clone())
                        .h(px(height))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .text_size(px(12.0))
                        .text_color(muted)
                        .child(text),
                );
            }
            PickerRow::Login {
                id,
                title,
                username,
            } => {
                let label = match &username {
                    Some(username) => format!("{title}, {username}"),
                    None => title.clone(),
                };
                let text = v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .truncate()
                            .child(title),
                    )
                    .children(username.map(|username| {
                        div()
                            .text_size(px(11.0))
                            .text_color(muted)
                            .truncate()
                            .child(username)
                    }));
                list = list.child(row_shell(
                    index,
                    format!("browser.vault.inline.login.{id}"),
                    label,
                    height,
                    highlighted,
                    highlight,
                    actions,
                    cx,
                    h_flex()
                        .w_full()
                        .gap(px(8.0))
                        .items_center()
                        .child(superhero_icon("superhero/key.svg", 13.0, fg))
                        .child(text),
                ));
            }
            PickerRow::Unlock { retry } => {
                let label = if retry {
                    "Retry Vault…"
                } else {
                    "Unlock Vault…"
                };
                list = list.child(row_shell(
                    index,
                    "browser.vault.inline.unlock".to_owned(),
                    label.to_owned(),
                    height,
                    highlighted,
                    highlight,
                    actions,
                    cx,
                    h_flex()
                        .w_full()
                        .gap(px(8.0))
                        .items_center()
                        .child(superhero_icon("superhero/lock.svg", 13.0, fg))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(label),
                        ),
                ));
            }
        }
    }

    deferred(
        anchored()
            .position(gpui_kit::point(px(origin.0), px(origin.1)))
            .snap_to_window_with_margin(px(8.0))
            .child(list),
    )
    .with_priority(6)
    .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "one row's look and wiring, called twice"
)]
fn row_shell<T: 'static>(
    index: usize,
    ax_id: String,
    label: String,
    height: f32,
    highlighted: bool,
    highlight: gpui_kit::Hsla,
    actions: &PickerActions<T>,
    cx: &mut Context<'_, T>,
    content: gpui_kit::Div,
) -> impl gpui_kit::IntoElement {
    let choose = actions.choose;
    let hover = actions.hover;
    div()
        .id(SharedString::from(format!("browser-vault-inline-{index}")))
        .test_support()
        .a11y(gpui_kit::Role::MenuItem, ax_id, label)
        .aria_selected(highlighted)
        .h(px(height))
        .px(px(8.0))
        .flex()
        .items_center()
        .rounded(px(8.0))
        .cursor_pointer()
        .when(highlighted, |row| row.bg(highlight))
        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
            if *hovered {
                hover(this, index, cx);
            }
        }))
        .on_click(cx.listener(move |this, _, window, cx| {
            cx.stop_propagation();
            choose(this, index, window, cx);
        }))
        .child(content)
}

#[cfg(test)]
impl InlineLogins {
    /// The rows as their accessible labels.
    pub(super) fn labels(&self) -> Vec<String> {
        self.rows()
            .into_iter()
            .map(|row| match row {
                PickerRow::Heading(label) => label.to_owned(),
                PickerRow::Login {
                    title, username, ..
                } => match username {
                    Some(username) => format!("{title}, {username}"),
                    None => title,
                },
                PickerRow::Note(text) => text,
                PickerRow::Unlock { retry: true } => "Retry Vault…".to_owned(),
                PickerRow::Unlock { retry: false } => "Unlock Vault…".to_owned(),
            })
            .collect()
    }
}

/// Canned Vault answers for tests, by host. Tests never reach the real Vault.
#[cfg(test)]
pub(super) fn stub_logins(url: &str, allow_unlock: bool) -> VaultLoginsResponse {
    let answer = |status, items| VaultLoginsResponse {
        status,
        items,
        error: None,
    };
    let login = |id: &str, title: &str, username: &str| VaultLoginItem {
        id: id.to_owned(),
        title: title.to_owned(),
        username: Some(username.to_owned()),
        source: "vault".to_owned(),
    };
    if url.contains("locked.example") && !allow_unlock {
        return answer(VaultLoginsStatus::Locked, Vec::new());
    }
    if url.contains("unavailable.example") {
        return answer(VaultLoginsStatus::Unavailable, Vec::new());
    }
    if url.contains("empty.example") {
        return answer(VaultLoginsStatus::Ok, Vec::new());
    }
    answer(
        VaultLoginsStatus::Ok,
        vec![
            login("aaa", "Example", "me@example.com"),
            login("bbb", "Work", "work@example.com"),
        ],
    )
}

/// A canned fill answer for tests, by login id. The value is a fixed placeholder.
#[cfg(test)]
pub(super) fn stub_fill(item_id: &str) -> conn_desktop::vault::VaultLoginFillLookup {
    use conn_desktop::vault::VaultLoginFillLookup;
    match item_id {
        "missing" => VaultLoginFillLookup::ItemNotFound,
        _ => VaultLoginFillLookup::Value("stub-secret".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
    use gpui_kit::{
        AnyWindowHandle, AppContext as _, Bounds, IntoElement, Point, Render, TestAppContext,
        WindowBounds, WindowOptions, div, px, size,
    };
    use serde_json::json;

    use super::*;

    fn view() -> WebRect {
        WebRect {
            x: 100.0,
            y: 50.0,
            width: 500.0,
            height: 250.0,
        }
    }

    fn anchor_json(field: &str) -> Value {
        json!({
            "field": field,
            "page": {"username": true, "password": true, "otp": false},
            "x": 100.0, "y": 40.0, "width": 200.0, "height": 30.0,
            "viewportWidth": 1000.0, "viewportHeight": 500.0,
        })
    }

    fn event_json(kind: &str, anchor: Value) -> Value {
        json!({"revision": 3, "kind": kind, "anchor": anchor})
    }

    fn event(kind: &str, field: &str) -> InlineEvent {
        parse_inline_event(&event_json(kind, anchor_json(field))).expect("a valid event")
    }

    fn response(
        status: VaultLoginsStatus,
        items: &[(&str, &str, Option<&str>)],
    ) -> VaultLoginsResponse {
        VaultLoginsResponse {
            status,
            items: items
                .iter()
                .map(|(id, title, username)| VaultLoginItem {
                    id: (*id).to_owned(),
                    title: (*title).to_owned(),
                    username: username.map(str::to_owned),
                    source: "vault".to_owned(),
                })
                .collect(),
            error: None,
        }
    }

    /// A picker open on a username field with two logins.
    fn open_picker() -> InlineLogins {
        let mut state = InlineLogins::default();
        assert!(state.apply_event(&event("focus", "username")));
        let generation = state.begin_lookup(false).expect("a lookup starts");
        assert!(state.finish_lookup(
            generation,
            response(
                VaultLoginsStatus::Ok,
                &[
                    ("aaa", "Example", Some("me@example.com")),
                    ("bbb", "Work", Some("work@example.com")),
                ],
            ),
        ));
        state
    }

    // ── Event parsing ───────────────────────────────────────────────────────────────

    #[test]
    fn a_focus_report_parses_into_a_kind_and_an_anchor() {
        let parsed = event("focus", "password");
        assert_eq!(parsed.kind, InlineEventKind::Focus);
        let anchor = parsed.anchor.expect("an anchor");
        assert_eq!(anchor.field, VaultLoginField::Password);
        assert_eq!(
            anchor.page,
            PageFields {
                username: true,
                password: true,
                otp: false
            }
        );
    }

    #[test]
    fn layout_and_dismiss_reports_parse_and_dismiss_may_carry_no_anchor() {
        assert_eq!(event("layout", "username").kind, InlineEventKind::Layout);
        let dismissed = parse_inline_event(&event_json("dismiss", Value::Null)).expect("parses");
        assert_eq!(dismissed.kind, InlineEventKind::Dismiss);
        assert_eq!(dismissed.anchor, None);
    }

    #[test]
    fn a_watcher_that_names_no_page_fields_fills_the_focused_field_alone() {
        let mut anchor = anchor_json("otp");
        anchor.as_object_mut().expect("object").remove("page");
        let parsed = parse_inline_event(&event_json("focus", anchor)).expect("parses");
        let page = parsed.anchor.expect("anchor").page;
        assert_eq!(page.fields_to_fill(), vec![VaultLoginField::Otp]);
    }

    #[test]
    fn malformed_reports_are_rejected() {
        let with = |key: &str, value: Value| {
            let mut anchor = anchor_json("username");
            anchor
                .as_object_mut()
                .expect("object")
                .insert(key.into(), value);
            event_json("focus", anchor)
        };
        let rejected = [
            json!(null),
            json!("focus"),
            json!({"kind": "focus", "anchor": null}),
            json!({"revision": 1, "anchor": null}),
            json!({"revision": 1, "kind": "focus"}),
            json!({"revision": 1.5, "kind": "focus", "anchor": null}),
            json!({"revision": -1, "kind": "focus", "anchor": null}),
            json!({"revision": 9_007_199_254_740_993_u64, "kind": "focus", "anchor": null}),
            json!({"revision": 1, "kind": "keyboard", "anchor": null}),
            json!({"revision": 1, "kind": "focus", "anchor": "field"}),
            with("field", json!("search")),
            with("field", json!(7)),
            with("width", json!(0)),
            with("height", json!(-4)),
            with("width", json!("wide")),
            with("x", json!(null)),
            with("viewportWidth", json!(0)),
            with("viewportHeight", json!(-1)),
            // Entirely off the page.
            with("x", json!(1000)),
            with("y", json!(500)),
            with("x", json!(-300)),
            with("y", json!(-31)),
            // Not a form field.
            with("width", json!(5_000_000)),
            with("viewportWidth", json!(5_000_000)),
        ];
        for value in &rejected {
            assert_eq!(parse_inline_event(value), None, "{value} must be rejected");
        }
    }

    #[test]
    fn a_field_partly_off_the_page_still_parses() {
        let mut anchor = anchor_json("username");
        anchor["x"] = json!(-50.0);
        anchor["y"] = json!(490.0);
        assert!(parse_inline_event(&event_json("layout", anchor)).is_some());
    }

    // ── Anchor and placement maths ──────────────────────────────────────────────────

    #[test]
    fn the_anchor_is_scaled_from_the_page_viewport_onto_the_web_view() {
        let anchor = event("focus", "username").anchor.expect("anchor");
        // The page is 1000x500 CSS px shown in a 500x250 view at (100, 50): half size.
        let rect = anchor_rect(&anchor, view());
        assert_eq!(
            rect,
            WebRect {
                x: 150.0,
                y: 70.0,
                width: 100.0,
                height: 15.0
            }
        );
    }

    #[test]
    fn a_page_shown_at_its_own_size_maps_one_to_one() {
        let anchor = event("focus", "username").anchor.expect("anchor");
        let same = WebRect {
            x: 10.0,
            y: 20.0,
            width: 1000.0,
            height: 500.0,
        };
        let rect = anchor_rect(&anchor, same);
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (110.0, 60.0, 200.0, 30.0)
        );
    }

    #[test]
    fn the_picker_sits_under_the_field_with_aligned_left_edges() {
        let field = WebRect {
            x: 150.0,
            y: 70.0,
            width: 100.0,
            height: 15.0,
        };
        let big = WebRect {
            height: 900.0,
            ..view()
        };
        assert_eq!(picker_origin(field, (280.0, 100.0), big), (150.0, 91.0));
    }

    #[test]
    fn the_picker_flips_above_when_it_does_not_fit_below_but_fits_above() {
        let field = WebRect {
            x: 150.0,
            y: 240.0,
            width: 100.0,
            height: 30.0,
        };
        // Below: 276 + 120 > 300. Above: 240 - 6 - 120 = 114 >= 50.
        assert_eq!(picker_origin(field, (280.0, 120.0), view()), (150.0, 114.0));
        // Too tall for either side: stays below, as Base UI does without room.
        assert_eq!(picker_origin(field, (280.0, 260.0), view()), (150.0, 276.0));
    }

    #[test]
    fn the_picker_stays_inside_the_view_sideways() {
        let near_right = WebRect {
            x: 560.0,
            y: 70.0,
            width: 30.0,
            height: 20.0,
        };
        assert_eq!(picker_origin(near_right, (280.0, 80.0), view()).0, 320.0);
        let left_of_view = WebRect {
            x: 20.0,
            ..near_right
        };
        assert_eq!(picker_origin(left_of_view, (280.0, 80.0), view()).0, 100.0);
        // A view narrower than the picker pins the picker to its left edge.
        let narrow = WebRect {
            width: 200.0,
            ..view()
        };
        assert_eq!(picker_origin(near_right, (280.0, 80.0), narrow).0, 100.0);
    }

    // ── Which fields one pick fills ─────────────────────────────────────────────────

    #[test]
    fn one_pick_fills_what_the_page_shows() {
        let page = |username, password, otp| PageFields {
            username,
            password,
            otp,
        };
        let (u, p, o) = (
            VaultLoginField::Username,
            VaultLoginField::Password,
            VaultLoginField::Otp,
        );
        assert_eq!(page(true, true, false).fields_to_fill(), vec![u, p]);
        assert_eq!(page(false, true, false).fields_to_fill(), vec![p]);
        assert_eq!(page(false, true, true).fields_to_fill(), vec![p]);
        assert_eq!(page(true, false, true).fields_to_fill(), vec![o]);
        assert_eq!(page(true, false, false).fields_to_fill(), vec![u]);
        assert_eq!(page(false, false, false).fields_to_fill(), Vec::new());
    }

    // ── Picker state ────────────────────────────────────────────────────────────────

    #[test]
    fn focus_opens_the_picker_and_asks_for_a_lookup() {
        let mut state = InlineLogins::default();
        assert!(!state.shown());
        assert!(state.apply_event(&event("focus", "username")));
        assert!(state.shown());
    }

    #[test]
    fn a_layout_report_moves_the_anchor_without_opening_or_reopening() {
        let mut state = InlineLogins::default();
        assert!(!state.apply_event(&event("layout", "username")));
        assert!(!state.shown(), "layout alone never opens the picker");

        let mut state = open_picker();
        state.close();
        assert!(!state.apply_event(&event("layout", "username")));
        assert!(
            !state.shown(),
            "a closed picker stays closed through layout"
        );
        assert!(state.anchor().is_some());
    }

    #[test]
    fn dismiss_or_a_lost_anchor_closes_the_picker() {
        let mut state = open_picker();
        assert!(!state.apply_event(&event("dismiss", "username")));
        assert!(!state.shown());

        let mut state = open_picker();
        let gone = parse_inline_event(&event_json("layout", Value::Null)).expect("parses");
        assert!(!state.apply_event(&gone));
        assert!(!state.shown(), "a field that left the page closes it");
        assert!(state.anchor().is_none());
    }

    #[test]
    fn the_native_unlock_prompt_keeps_the_picker_when_the_page_loses_focus() {
        let mut state = InlineLogins::default();
        assert!(state.apply_event(&event("focus", "password")));
        assert!(state.begin_lookup(true).is_some());
        let gone = parse_inline_event(&event_json("dismiss", Value::Null)).expect("parses");
        state.apply_event(&gone);
        assert!(!state.shown(), "no anchor, nothing to draw under");
        assert!(state.open, "but the picker is still wanted");
        state.apply_event(&event("dismiss", "password"));
        assert!(state.open, "a dismiss during unlock does not close it");
        let generation = state.generation;
        state.finish_lookup(generation, response(VaultLoginsStatus::Ok, &[]));
        state.apply_event(&event("dismiss", "password"));
        assert!(!state.open, "once the prompt is over a dismiss closes it");
    }

    #[test]
    fn a_lookup_does_not_start_while_one_runs_unless_it_is_an_unlock() {
        let mut state = InlineLogins::default();
        let first = state.begin_lookup(false).expect("starts");
        assert_eq!(state.begin_lookup(false), None);
        let unlock = state.begin_lookup(true).expect("an unlock goes ahead");
        assert!(unlock > first);
        assert!(!state.finish_lookup(first, response(VaultLoginsStatus::Locked, &[])));
        assert!(state.loading, "the stale answer changed nothing");
        assert!(state.finish_lookup(unlock, response(VaultLoginsStatus::Ok, &[])));
        assert!(!state.loading);
    }

    #[test]
    fn reset_drops_the_field_the_logins_and_any_answer_still_coming() {
        let mut state = open_picker();
        let pending = state.begin_lookup(false).expect("starts");
        state.reset();
        assert!(!state.shown());
        assert!(state.items.is_empty());
        assert!(!state.finish_lookup(pending, response(VaultLoginsStatus::Ok, &[])));
        assert_eq!(state.status, None);
    }

    // ── Rows ────────────────────────────────────────────────────────────────────────

    #[test]
    fn logins_list_by_title_with_the_username_beneath() {
        let state = open_picker();
        assert_eq!(
            state.labels(),
            vec![
                VAULT_HEADING.to_owned(),
                "Example, me@example.com".to_owned(),
                "Work, work@example.com".to_owned(),
            ]
        );
    }

    #[test]
    fn a_username_equal_to_the_title_is_not_repeated() {
        let mut state = InlineLogins::default();
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(
            generation,
            response(
                VaultLoginsStatus::Ok,
                &[
                    ("a", "me@example.com", Some("me@example.com")),
                    ("b", "Bare", None),
                ],
            ),
        );
        assert_eq!(state.labels()[1..], ["me@example.com", "Bare"]);
    }

    #[test]
    fn a_locked_vault_offers_unlock_and_a_failed_one_offers_retry() {
        let mut state = InlineLogins::default();
        let generation = state.begin_lookup(false).expect("starts");
        assert_eq!(state.labels()[1], "Checking Vault…");
        state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[]));
        assert_eq!(state.labels()[1], "Unlock Vault…");
        assert_eq!(state.action(1), Some(RowAction::Unlock));

        let generation = state.begin_lookup(true).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Error, &[]));
        assert_eq!(state.labels()[1], "Retry Vault…");
    }

    #[test]
    fn empty_and_missing_vaults_say_so_and_offer_nothing_to_pick() {
        let mut state = InlineLogins::default();
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Ok, &[]));
        assert_eq!(state.labels()[1], "No Vault logins for this site");
        assert_eq!(state.action(1), None);
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Unavailable, &[]));
        assert_eq!(state.labels()[1], "Vault is not installed");
        assert_eq!(state.action(1), None);
        assert_eq!(state.action(0), None, "the heading is not a choice");
    }

    #[test]
    fn a_failed_fill_shows_why_and_reopens_the_picker() {
        let mut state = open_picker();
        state.close();
        state.fail("Vault unlock cancelled.");
        assert!(state.shown());
        assert_eq!(state.labels()[1], "Vault unlock cancelled.");
        assert!(state.apply_event(&event("focus", "username")));
        assert!(
            !state
                .labels()
                .contains(&"Vault unlock cancelled.".to_owned()),
            "the next focus starts clean"
        );
    }

    #[test]
    fn the_picker_height_follows_its_rows_and_is_capped() {
        let state = open_picker();
        // Heading 24 + two logins 42 + two gaps 2 + padding 8 + border 2.
        assert_eq!(
            state.size(),
            (PICKER_WIDTH_PX, 24.0 + 42.0 * 2.0 + 4.0 + 10.0)
        );
        let mut many = InlineLogins::default();
        let generation = many.begin_lookup(false).expect("starts");
        let items: Vec<(String, String)> = (0..30)
            .map(|i| (format!("id{i}"), format!("Login {i}")))
            .collect();
        let refs: Vec<(&str, &str, Option<&str>)> = items
            .iter()
            .map(|(id, title)| (id.as_str(), title.as_str(), Some("user")))
            .collect();
        many.finish_lookup(generation, response(VaultLoginsStatus::Ok, &refs));
        assert_eq!(many.size().1, PICKER_MAX_HEIGHT_PX);
    }

    // ── Keyboard ────────────────────────────────────────────────────────────────────

    #[test]
    fn keys_go_to_the_page_while_the_picker_is_closed() {
        let mut state = InlineLogins::default();
        for key in ["down", "up", "enter", "escape", "a"] {
            assert_eq!(state.handle_key(key), KeyOutcome::Pass, "{key}");
        }
        let mut state = open_picker();
        state.close();
        assert_eq!(state.handle_key("down"), KeyOutcome::Pass);
    }

    #[test]
    fn arrow_keys_walk_the_logins_and_wrap() {
        let mut state = open_picker();
        assert_eq!(state.handle_key("down"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(1));
        assert_eq!(state.handle_key("down"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(2));
        assert_eq!(state.handle_key("down"), KeyOutcome::Handled);
        assert_eq!(
            state.cursor,
            Some(1),
            "wraps past the last login, skipping the heading"
        );
        assert_eq!(state.handle_key("up"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(2), "wraps back");
    }

    #[test]
    fn arrow_keys_go_to_the_page_when_there_is_nothing_to_choose() {
        let mut state = InlineLogins::default();
        state.apply_event(&event("focus", "username"));
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Ok, &[]));
        assert!(state.shown());
        assert_eq!(state.handle_key("down"), KeyOutcome::Pass);
        assert_eq!(state.handle_key("up"), KeyOutcome::Pass);
        assert_eq!(state.cursor, None);
    }

    #[test]
    fn up_from_nothing_starts_at_the_last_login() {
        let mut state = open_picker();
        assert_eq!(state.handle_key("up"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(2));
    }

    #[test]
    fn enter_picks_the_highlighted_login_and_otherwise_goes_to_the_page() {
        let mut state = open_picker();
        assert_eq!(
            state.handle_key("enter"),
            KeyOutcome::Pass,
            "with no highlight Enter submits the form"
        );
        state.handle_key("down");
        state.handle_key("down");
        assert_eq!(
            state.handle_key("enter"),
            KeyOutcome::Run(RowAction::Fill("bbb".to_owned()))
        );
    }

    #[test]
    fn enter_on_the_unlock_row_asks_to_unlock() {
        let mut state = InlineLogins::default();
        state.apply_event(&event("focus", "password"));
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[]));
        state.handle_key("down");
        assert_eq!(
            state.handle_key("enter"),
            KeyOutcome::Run(RowAction::Unlock)
        );
    }

    #[test]
    fn escape_closes_the_picker_and_other_keys_pass() {
        let mut state = open_picker();
        assert_eq!(state.handle_key("tab"), KeyOutcome::Pass);
        assert_eq!(state.handle_key("x"), KeyOutcome::Pass);
        assert_eq!(state.handle_key("escape"), KeyOutcome::Dismissed);
        assert!(!state.shown());
    }

    #[test]
    fn the_highlight_follows_the_pointer_but_not_onto_a_heading_or_note() {
        let mut state = open_picker();
        state.hover(0);
        assert_eq!(state.cursor, None);
        state.hover(2);
        assert_eq!(state.cursor, Some(2));
        state.hover(99);
        assert_eq!(state.cursor, Some(2));
    }

    #[test]
    fn a_new_answer_drops_a_highlight_that_no_longer_points_at_a_login() {
        let mut state = open_picker();
        state.hover(2);
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Ok, &[]));
        assert_eq!(state.cursor, None);
    }

    // ── Headless GPUI: the card as drawn ────────────────────────────────────────────

    struct Harness {
        state: InlineLogins,
        tokens: Tokens,
        chosen: Rc<RefCell<Vec<usize>>>,
        outside_presses: Rc<Cell<usize>>,
        behind_hovered: Rc<Cell<bool>>,
    }

    impl Render for Harness {
        fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
            let behind = self.behind_hovered.clone();
            // A full-window element under the picker: the page.
            let page = div()
                .id("probe-behind-picker")
                .test_support()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .on_hover(move |hovered, _, _| behind.set(*hovered));
            let actions = PickerActions::<Self> {
                choose: |this, index, _, _| this.chosen.borrow_mut().push(index),
                hover: |this, index, _| this.state.hover(index),
                dismiss: |this, _, _| this.outside_presses.set(this.outside_presses.get() + 1),
            };
            div()
                .size_full()
                .relative()
                .child(page)
                .child(render_picker(
                    &self.state,
                    (40.0, 40.0),
                    &self.tokens,
                    &actions,
                    cx,
                ))
        }
    }

    struct Mounted {
        window: AnyWindowHandle,
        chosen: Rc<RefCell<Vec<usize>>>,
        outside_presses: Rc<Cell<usize>>,
        behind_hovered: Rc<Cell<bool>>,
    }

    fn mount(cx: &mut TestAppContext, state: InlineLogins) -> Mounted {
        let chosen = Rc::new(RefCell::new(Vec::new()));
        let outside_presses = Rc::new(Cell::new(0));
        let behind_hovered = Rc::new(Cell::new(false));
        let (c, o, b) = (
            chosen.clone(),
            outside_presses.clone(),
            behind_hovered.clone(),
        );
        let window = cx.update(|cx| {
            gpui_kit::init(cx);
            let Some(theme) = conn_theme::theme_by_id("dark-ocean") else {
                panic!("dark-ocean must be a built-in theme");
            };
            let tokens = Tokens::derive(&theme);
            crate::theme::apply_kit_theme(&tokens, cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(800.0), px(600.0)),
                ))),
                ..Default::default()
            };
            let mut state = Some(state);
            let Ok((window, _view)) = gpui_kit::open_window(options, cx, move |_, cx| {
                cx.new(|_| Harness {
                    state: state.take().unwrap_or_default(),
                    tokens,
                    chosen: c,
                    outside_presses: o,
                    behind_hovered: b,
                })
            }) else {
                panic!("failed to open headless test window");
            };
            window
        });
        let rendered = cx.update_window(window, |_, window, cx| window.render_frame(cx));
        assert!(rendered.is_ok(), "the harness window is open");
        Mounted {
            window,
            chosen,
            outside_presses,
            behind_hovered,
        }
    }

    #[gpui_kit::test]
    fn clicking_a_login_row_chooses_it(cx: &mut TestAppContext) {
        let mounted = mount(cx, open_picker());
        let clicked = cx.update_window(mounted.window, |_, window, cx| {
            window.click("browser-vault-inline-2", cx);
        });
        assert!(clicked.is_ok());
        assert_eq!(*mounted.chosen.borrow(), vec![2]);
    }

    #[gpui_kit::test]
    fn the_unlock_row_is_clickable_and_a_status_row_is_not_a_choice(cx: &mut TestAppContext) {
        let mut state = InlineLogins::default();
        state.apply_event(&event("focus", "password"));
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[]));
        let mounted = mount(cx, state);
        let found = cx.update_window(mounted.window, |_, window, _| {
            (
                window.try_find("browser-vault-inline-1").is_some(),
                window.try_find("browser-vault-inline-0").is_some(),
            )
        });
        assert_eq!(found.ok(), Some((true, false)), "the heading is not a row");
        let clicked = cx.update_window(mounted.window, |_, window, cx| {
            window.click("browser-vault-inline-1", cx);
        });
        assert!(clicked.is_ok());
        assert_eq!(*mounted.chosen.borrow(), vec![1]);
    }

    #[gpui_kit::test]
    fn hover_stays_on_the_picker_and_never_reaches_the_page_behind(cx: &mut TestAppContext) {
        let mounted = mount(cx, open_picker());
        let off_picker = Point {
            x: px(700.0),
            y: px(500.0),
        };
        let move_to = |cx: &mut TestAppContext,
                       at: &dyn Fn(&mut Window) -> Point<gpui_kit::Pixels>| {
            let moved = cx.update_window(mounted.window, |_, window, cx| {
                window.render_frame(cx);
                let at = at(window);
                window.pointer_move(at, None, cx);
                window.render_frame(cx);
            });
            assert!(moved.is_ok());
        };
        move_to(cx, &|_| off_picker);
        assert!(
            mounted.behind_hovered.get(),
            "the page is hovered off the picker"
        );
        move_to(cx, &|w| w.find("browser-vault-inline-1").bounds().center());
        assert!(
            !mounted.behind_hovered.get(),
            "hovering a login row must not hover the page behind it"
        );
        move_to(cx, &|_| off_picker);
        assert!(
            mounted.behind_hovered.get(),
            "the picker only blocks what lies under it"
        );
    }

    #[gpui_kit::test]
    fn a_press_outside_the_picker_dismisses_it_and_a_press_on_it_does_not(cx: &mut TestAppContext) {
        let mounted = mount(cx, open_picker());
        let pressed = cx.update_window(mounted.window, |_, window, cx| {
            window.click("browser-vault-inline-1", cx);
        });
        assert!(pressed.is_ok());
        assert_eq!(
            mounted.outside_presses.get(),
            0,
            "a row press is not outside"
        );
        let pressed = cx.update_window(mounted.window, |_, window, cx| {
            window.click_at(
                "probe-behind-picker",
                Point {
                    x: px(700.0),
                    y: px(500.0),
                },
                cx,
            );
        });
        assert!(pressed.is_ok());
        assert_eq!(mounted.outside_presses.get(), 1);
    }
}
