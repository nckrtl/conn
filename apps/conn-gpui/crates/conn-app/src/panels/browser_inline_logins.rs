//! Inline Vault login suggestions in the Browser panel (port of T3's
//! `CredentialInlineSuggestions.tsx` and `credentialInline.ts`), drawn like the picker of Vault's
//! Chrome extension (`ChromeExtension/picker.html`, `picker.js`, `inline.js`).
//!
//! When a username, email or password field takes focus on an HTTPS page, the page's watcher
//! (`browser_overlay_bridge.js`) reports the field's kind and rectangle, nothing else. This
//! module turns that into a small picker the host draws under the field. The accounts are
//! native GPUI rows over the web view, so a website never receives the list. Lookups and fills
//! go through the panel's existing Vault paths (`VaultClient::list_logins` and
//! `login_credential`).
//!
//! Every size, colour and wording below is the extension's, taken from its source. The extension
//! follows the system's light or dark look; this picker follows the app theme's.

use conn_desktop::vault::{
    VaultLoginField, VaultLoginItem, VaultLoginsResponse, VaultLoginsStatus,
};
use conn_theme::{Appearance, Tokens};
use conn_web::Rect as WebRect;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AnyElement, BoxShadow, Context, FontWeight, Hsla, Image, ImageFormat, InteractiveElement as _,
    IntoElement as _, MouseButton, ObjectFit, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, TestSupportExt as _, Window,
    anchored, deferred, div, hsla, img, point, px, rgb, rgba, svg,
};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

use crate::a11y::ConnA11yExt as _;

// ── The extension's numbers (`picker.html`, `inline.js` `position()`) ──────────────────────────

/// `Math.max(280, field width)`: the picker is as wide as the field, but not narrower than this.
const MIN_WIDTH_PX: f32 = 280.0;
/// `Math.min(…, 420, …)`.
const MAX_WIDTH_PX: f32 = 420.0;
/// Space kept to the edge of the page (`visibleWidth - 16`, `x + 8`).
const EDGE_MARGIN_PX: f32 = 8.0;
/// Space between the field and the picker (`box.bottom + 6`).
const PICKER_GAP_PX: f32 = 6.0;
/// `Math.min(292, Math.max(40, …))`: the picker's height.
const PICKER_MAX_HEIGHT_PX: f32 = 292.0;
const PICKER_MIN_HEIGHT_PX: f32 = 40.0;
/// The frame's `border-radius`.
const PICKER_RADIUS_PX: f32 = 14.0;
/// `#panel { padding: 6px }`.
const PANEL_PAD_PX: f32 = 6.0;
/// `.entry { padding: 9px; border-radius: 8px; gap: 10px }`.
const ROW_PAD_PX: f32 = 9.0;
const ROW_RADIUS_PX: f32 = 8.0;
const ROW_GAP_PX: f32 = 10.0;
/// `button:focus-visible { outline: 2px solid …; outline-offset: -2px }`: a ring inside the row.
const RING_PX: f32 = 2.0;
/// `.icon { width: 29px; height: 29px; border-radius: 7px }`, `.icon img { 21px; radius 5px }`.
const TILE_PX: f32 = 29.0;
const TILE_RADIUS_PX: f32 = 7.0;
const SITE_ICON_PX: f32 = 21.0;
const SITE_ICON_RADIUS_PX: f32 = 5.0;
/// `.icon svg { 17px }` (the key) and `.icon svg.mark { 15px }` (the Vault mark).
const KEY_PX: f32 = 17.0;
const MARK_PX: f32 = 15.0;
/// `.name { font-size: 14px; font-weight: 500 }`, `.username { font-size: 13px; margin-top: 2px }`.
const NAME_PX: f32 = 14.0;
const USERNAME_PX: f32 = 13.0;
const USERNAME_TOP_PX: f32 = 2.0;
/// The browser's `line-height: normal` for those two sizes in the system font.
const NAME_LINE_PX: f32 = 17.0;
const USERNAME_LINE_PX: f32 = 16.0;
/// `#status { font-size: 14px; margin: 6px 8px; line-height: 1.4 }`.
const STATUS_PX: f32 = 14.0;
const STATUS_LINE_PX: f32 = 19.6;
const STATUS_MARGIN_Y_PX: f32 = 6.0;
const STATUS_MARGIN_X_PX: f32 = 8.0;
/// `#status.error { font-size: 13px; padding: 9px 10px; margin: 3px 3px 6px; border-radius: 8px }`.
const ERROR_PX: f32 = 13.0;
const ERROR_LINE_PX: f32 = 18.2;
const ERROR_PAD_Y_PX: f32 = 9.0;
const ERROR_PAD_X_PX: f32 = 10.0;
const ERROR_MARGIN_X_PX: f32 = 3.0;
const ERROR_MARGIN_TOP_PX: f32 = 3.0;
const ERROR_MARGIN_BOTTOM_PX: f32 = 6.0;
/// Average glyph widths, to guess where a status line wraps (sizing only; layout wraps for real).
const STATUS_CHAR_PX: f32 = 7.0;
const ERROR_CHAR_PX: f32 = 6.5;

/// A rectangle larger than this is not a form field.
const MAX_ANCHOR_PX: f64 = 1_000_000.0;
/// The largest integer a page's number can hold exactly.
const MAX_SAFE_REVISION: u64 = 1 << 53;

/// How long a lookup that never prompts may take. Vault answers a locked or unlocked list at
/// once, so a longer wait means the relay is stuck.
#[cfg(not(test))]
const LOOKUP_DEADLINE: Duration = Duration::from_secs(10);
/// How long an unlock may take: Vault's own prompt stays up for under two minutes.
#[cfg(not(test))]
const UNLOCK_DEADLINE: Duration = Duration::from_secs(125);
#[cfg(test)]
const LOOKUP_DEADLINE: Duration = Duration::from_millis(300);
#[cfg(test)]
const UNLOCK_DEADLINE: Duration = Duration::from_millis(600);
/// The panel's own timer waits this much longer than the lookup's deadline, so the lookup's
/// answer comes first and the timer only catches a lookup that never came back at all.
const WATCHDOG_SLACK: Duration = Duration::from_secs(2);

/// The longest a lookup may run before the picker gives up on it.
pub(super) fn lookup_deadline(allow_unlock: bool) -> Duration {
    if allow_unlock {
        UNLOCK_DEADLINE
    } else {
        LOOKUP_DEADLINE
    }
}

/// When the panel's own timer fires for a lookup.
pub(super) fn watchdog_delay(allow_unlock: bool) -> Duration {
    lookup_deadline(allow_unlock) + WATCHDOG_SLACK
}

/// What the picker shows when Vault does not answer in time.
fn timed_out_response() -> VaultLoginsResponse {
    VaultLoginsResponse {
        status: VaultLoginsStatus::Error,
        items: Vec::new(),
        error: Some("Vault did not answer in time.".to_owned()),
    }
}

/// Runs a Vault lookup under its deadline. A lookup that outlasts it is dropped, which stops the
/// relay process, and reads as a Vault error the picker can show and retry.
pub(super) async fn bounded_lookup(
    allow_unlock: bool,
    lookup: impl Future<Output = VaultLoginsResponse>,
) -> VaultLoginsResponse {
    tokio::time::timeout(lookup_deadline(allow_unlock), lookup)
        .await
        .unwrap_or_else(|_| timed_out_response())
}

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

/// The picker's width: the field's, but at least 280 and at most 420, and never wider than the
/// view less its margins (`Math.min(Math.max(280, box.width), 420, visibleWidth - 16)`).
pub(super) fn picker_width(field: WebRect, view: WebRect) -> f32 {
    field
        .width
        .clamp(MIN_WIDTH_PX, MAX_WIDTH_PX)
        .min(view.width - 2.0 * EDGE_MARGIN_PX)
        .max(0.0)
}

/// Top-left corner of a picker of `size` for a field at `field`: directly under it, left edges
/// aligned, kept inside the web view (`inline.js` `position()`). It sits above the field when
/// there is no room below, and then stays at least 8 px from the view's top and bottom.
pub(super) fn picker_origin(field: WebRect, size: (f32, f32), view: WebRect) -> (f32, f32) {
    let (width, height) = size;
    let field_bottom = field.y + field.height;
    let view_bottom = view.y + view.height;
    let y = if field_bottom + height + EDGE_MARGIN_PX <= view_bottom {
        field_bottom + PICKER_GAP_PX
    } else {
        let above = field.y - height - PICKER_GAP_PX;
        let lowest = view_bottom - height - EDGE_MARGIN_PX;
        (view.y + EDGE_MARGIN_PX).max(above.min(lowest))
    };
    let right_most = view.x + view.width - width - EDGE_MARGIN_PX;
    ((view.x + EDGE_MARGIN_PX).max(field.x.min(right_most)), y)
}

/// A status line is a short line of text, or an error in a tinted box.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PickerRow {
    Login {
        id: String,
        title: String,
        username: Option<String>,
    },
    /// A status line: not a choice. `error` draws it in the extension's red box.
    Note {
        text: String,
        error: bool,
    },
    Unlock {
        retry: bool,
    },
}

impl PickerRow {
    fn status(text: impl Into<String>) -> Self {
        Self::Note {
            text: text.into(),
            error: false,
        }
    }

    fn error(text: impl Into<String>) -> Self {
        Self::Note {
            text: text.into(),
            error: true,
        }
    }

    fn actionable(&self) -> bool {
        matches!(self, Self::Login { .. } | Self::Unlock { .. })
    }

    /// How many lines `text` takes where `room` px of width remain.
    fn lines(text: &str, room: f32, char_px: f32) -> f32 {
        let per_line = (room / char_px).floor().max(1.0);
        (text.chars().count() as f32 / per_line).ceil().max(1.0)
    }

    /// The row's height in a picker `width` wide, as the extension's CSS lays it out.
    fn height(&self, width: f32) -> f32 {
        let row = |content: f32| content + 2.0 * ROW_PAD_PX;
        match self {
            Self::Login {
                username: Some(_), ..
            } => row(TILE_PX.max(NAME_LINE_PX + USERNAME_TOP_PX + USERNAME_LINE_PX)),
            // The extension still lays out an empty username line under the name.
            Self::Login { .. } | Self::Unlock { retry: false } => row(TILE_PX),
            Self::Unlock { retry: true } => row(NAME_LINE_PX),
            Self::Note { text, error: false } => {
                let room = width - 2.0 * PANEL_PAD_PX - 2.0 * STATUS_MARGIN_X_PX;
                Self::lines(text, room, STATUS_CHAR_PX) * STATUS_LINE_PX + 2.0 * STATUS_MARGIN_Y_PX
            }
            Self::Note { text, error: true } => {
                let room =
                    width - 2.0 * PANEL_PAD_PX - 2.0 * ERROR_MARGIN_X_PX - 2.0 * ERROR_PAD_X_PX;
                Self::lines(text, room, ERROR_CHAR_PX) * ERROR_LINE_PX
                    + 2.0 * ERROR_PAD_Y_PX
                    + ERROR_MARGIN_TOP_PX
                    + ERROR_MARGIN_BOTTOM_PX
            }
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

/// The icon the page itself declares, as PNG from the browser. The picker shows it on each login's
/// tile when the logins are for that same site.
struct PageIcon {
    host: String,
    image: Arc<Image>,
}

/// The host of an HTTPS address.
fn https_host(address: &str) -> Option<String> {
    let parsed = url::Url::parse(address.trim()).ok()?;
    (parsed.scheme() == "https")
        .then(|| parsed.host_str().map(str::to_ascii_lowercase))
        .flatten()
}

#[derive(Default)]
pub(super) struct InlineLogins {
    anchor: Option<InlineAnchor>,
    open: bool,
    /// The row the keyboard is on (the extension's focused button).
    cursor: Option<usize>,
    loading: bool,
    status: Option<VaultLoginsStatus>,
    /// What Vault said went wrong, for the error line.
    error: Option<String>,
    items: Vec<VaultLoginItem>,
    /// Why the last pick did not fill, shown in the picker.
    feedback: Option<String>,
    /// The native unlock prompt is up: the page losing focus must not close the picker.
    unlocking: bool,
    generation: u64,
    /// The page's own icon. A reload keeps it; another site's address hides it.
    icon: Option<PageIcon>,
}

impl InlineLogins {
    pub(super) fn anchor(&self) -> Option<&InlineAnchor> {
        self.anchor.as_ref()
    }

    /// The picker is on screen.
    pub(super) fn shown(&self) -> bool {
        self.open && self.anchor.is_some()
    }

    /// Keeps the icon the browser fetched for `page`, an HTTPS address. Returns `true` when it
    /// replaced what showed.
    pub(super) fn set_icon(&mut self, page: &str, png: Vec<u8>) -> bool {
        let Some(host) = https_host(page) else {
            return false;
        };
        if png.is_empty() {
            return false;
        }
        let image = Arc::new(Image::from_bytes(ImageFormat::Png, png));
        self.icon = Some(PageIcon { host, image });
        true
    }

    /// The icon for the site at `page`, if the browser reported one for that host.
    pub(super) fn icon_for(&self, page: &str) -> Option<Arc<Image>> {
        let host = https_host(page)?;
        self.icon
            .as_ref()
            .filter(|icon| icon.host == host)
            .map(|icon| icon.image.clone())
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
        self.error = None;
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
        self.error = response.error;
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

    /// The lookup `generation` has run out of time without an answer. Shows the error row so the
    /// picker never sits on "Loading…". Returns `true` when that changed what shows; a lookup
    /// that already answered, or was replaced, is left alone.
    pub(super) fn expire_lookup(&mut self, generation: u64) -> bool {
        if !self.loading {
            return false;
        }
        self.finish_lookup(generation, timed_out_response())
    }

    /// A fill ended without a value. Shows why, and keeps the picker up for another try.
    pub(super) fn fail(&mut self, message: &str) {
        self.feedback = Some(message.to_owned());
        if self.anchor.is_some() {
            self.open = true;
        }
    }

    /// The picker's rows, with the extension's wording: no heading, one row per login, and a
    /// status line or an Unlock button when there is no login to show.
    pub(super) fn rows(&self) -> Vec<PickerRow> {
        let mut rows = Vec::new();
        if let Some(feedback) = &self.feedback {
            rows.push(PickerRow::error(feedback.clone()));
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
            rows.push(PickerRow::status(if self.unlocking {
                "Unlocking Vault…"
            } else {
                "Loading…"
            }));
        } else {
            match self.status {
                Some(VaultLoginsStatus::Locked) => rows.push(PickerRow::Unlock { retry: false }),
                Some(VaultLoginsStatus::Error) => {
                    rows.push(PickerRow::error(
                        self.error
                            .clone()
                            .filter(|error| !error.is_empty())
                            .unwrap_or_else(|| "Vault could not answer.".to_owned()),
                    ));
                    rows.push(PickerRow::Unlock { retry: true });
                }
                Some(VaultLoginsStatus::Unavailable) => {
                    rows.push(PickerRow::status("Vault is not installed"));
                }
                Some(VaultLoginsStatus::Ok) if self.items.is_empty() => {
                    rows.push(PickerRow::status("No matching login."));
                }
                Some(VaultLoginsStatus::Ok) | None => {}
            }
        }
        rows
    }

    /// The picker's size in logical pixels for a field at `field` in `view`: the extension's
    /// width rule, and the height of its rows, between 40 and 292 and within the view.
    pub(super) fn size(&self, field: WebRect, view: WebRect) -> (f32, f32) {
        let width = picker_width(field, view);
        let content: f32 = self.rows().iter().map(|row| row.height(width)).sum();
        let height = (content + 2.0 * PANEL_PAD_PX)
            .ceil()
            .clamp(PICKER_MIN_HEIGHT_PX, PICKER_MAX_HEIGHT_PX);
        let room = (view.height - 2.0 * EDGE_MARGIN_PX).max(PICKER_MIN_HEIGHT_PX);
        (width, height.min(room))
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
            PickerRow::Note { .. } => None,
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

/// The extension's colours (`picker.html`'s `light-dark(light, dark)` pairs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Palette {
    /// `:root { background }`.
    pub(super) surface: Hsla,
    /// `:root { color }`: names, and the key and Vault mark.
    pub(super) text: Hsla,
    /// `#status`, `.username`.
    pub(super) muted: Hsla,
    /// `button:hover`.
    pub(super) hover: Hsla,
    /// `.icon { background }`.
    pub(super) tile: Hsla,
    /// The focus ring: the text colour.
    pub(super) ring: Hsla,
    /// `#status.error { color, background }`.
    pub(super) error_text: Hsla,
    pub(super) error_fill: Hsla,
}

impl Palette {
    pub(super) fn of(appearance: Appearance) -> Self {
        match appearance {
            Appearance::Dark => Self {
                surface: rgb(0x242426).into(),
                text: rgb(0xeeeeee).into(),
                muted: rgb(0xbbbbbb).into(),
                hover: rgb(0x37373c).into(),
                tile: rgb(0x3f3f44).into(),
                ring: rgb(0xeeeeee).into(),
                error_text: rgb(0xff6b61).into(),
                error_fill: rgba(0xff453a26).into(),
            },
            Appearance::Light => Self {
                surface: rgb(0xfafafa).into(),
                text: rgb(0x202024).into(),
                muted: rgb(0x666666).into(),
                hover: rgb(0xeaeaf0).into(),
                tile: rgb(0xe7e7ec).into(),
                ring: rgb(0x202024).into(),
                error_text: rgb(0xc4271c).into(),
                error_fill: rgba(0xff3b3014).into(),
            },
        }
    }
}

/// What the picker's rows do in the panel that owns them.
pub(super) struct PickerActions<T> {
    pub(super) choose: fn(&mut T, usize, &mut Window, &mut Context<'_, T>),
    /// A press outside the picker.
    pub(super) dismiss: fn(&mut T, &mut Window, &mut Context<'_, T>),
}

/// The 29 px tile at a row's start: the page's icon on a rounded square, or `fallback` (the key)
/// when the browser reported none.
fn tile(site_icon: Option<Arc<Image>>, fallback: AnyElement, palette: &Palette) -> AnyElement {
    div()
        .size(px(TILE_PX))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(TILE_RADIUS_PX))
        .overflow_hidden()
        .bg(palette.tile)
        .child(match site_icon {
            Some(image) => img(image)
                .size(px(SITE_ICON_PX))
                .rounded(px(SITE_ICON_RADIUS_PX))
                .object_fit(ObjectFit::Contain)
                .into_any_element(),
            None => fallback,
        })
        .into_any_element()
}

/// The picker, `size` wide and high with its top-left corner at `origin` (window coordinates),
/// above everything else. `site_icon` is the page's own icon, if the browser reported one.
pub(super) fn render_picker<T: 'static>(
    state: &InlineLogins,
    origin: (f32, f32),
    size: (f32, f32),
    tokens: &Tokens,
    site_icon: Option<&Arc<Image>>,
    actions: &PickerActions<T>,
    cx: &mut Context<'_, T>,
) -> AnyElement {
    let palette = Palette::of(tokens.appearance);
    let dismiss = actions.dismiss;

    // The surface blocks the mouse for the whole card (what `floating_surface` does), so rows of
    // the page behind it do not light up and a press does not reach the page.
    let mut list = v_flex()
        .id("browser-vault-inline")
        .test_support()
        .a11y_group("browser.vault.inline", "Saved logins for this field")
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_mouse_down_out(cx.listener(move |this, _, window, cx| dismiss(this, window, cx)))
        .w(px(size.0))
        .max_h(px(size.1))
        .overflow_y_scroll()
        .p(px(PANEL_PAD_PX))
        .rounded(px(PICKER_RADIUS_PX))
        .bg(palette.surface)
        .text_color(palette.text)
        .font_family(".SystemUIFont")
        // `box-shadow: 0 8px 32px #0004`.
        .shadow(vec![BoxShadow {
            color: hsla(0.0, 0.0, 0.0, 0x44 as f32 / 255.0),
            offset: point(px(0.0), px(8.0)),
            blur_radius: px(32.0),
            spread_radius: px(0.0),
            inset: false,
        }]);

    for (index, row) in state.rows().into_iter().enumerate() {
        let highlighted = state.cursor == Some(index) && row.actionable();
        match row {
            PickerRow::Note { text, error: false } => {
                list = list.child(
                    div()
                        .id(SharedString::from(format!("browser-vault-inline-{index}")))
                        .a11y_group(format!("browser.vault.inline.note.{index}"), text.clone())
                        .mx(px(STATUS_MARGIN_X_PX))
                        .my(px(STATUS_MARGIN_Y_PX))
                        .text_size(px(STATUS_PX))
                        .line_height(px(STATUS_LINE_PX))
                        .text_color(palette.muted)
                        .child(text),
                );
            }
            PickerRow::Note { text, error: true } => {
                list = list.child(
                    div()
                        .id(SharedString::from(format!("browser-vault-inline-{index}")))
                        .a11y_group(format!("browser.vault.inline.note.{index}"), text.clone())
                        .mx(px(ERROR_MARGIN_X_PX))
                        .mt(px(ERROR_MARGIN_TOP_PX))
                        .mb(px(ERROR_MARGIN_BOTTOM_PX))
                        .px(px(ERROR_PAD_X_PX))
                        .py(px(ERROR_PAD_Y_PX))
                        .rounded(px(ROW_RADIUS_PX))
                        .bg(palette.error_fill)
                        .text_size(px(ERROR_PX))
                        .line_height(px(ERROR_LINE_PX))
                        .text_color(palette.error_text)
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
                let key = svg()
                    .path("brand/vault-key.svg")
                    .size(px(KEY_PX))
                    .flex_none()
                    .text_color(palette.text)
                    .into_any_element();
                let text = v_flex()
                    .min_w_0()
                    .flex_1()
                    .child(
                        div()
                            .text_size(px(NAME_PX))
                            .line_height(px(NAME_LINE_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.text)
                            .truncate()
                            .child(title),
                    )
                    .children(username.map(|username| {
                        div()
                            .mt(px(USERNAME_TOP_PX))
                            .text_size(px(USERNAME_PX))
                            .line_height(px(USERNAME_LINE_PX))
                            .text_color(palette.muted)
                            .truncate()
                            .child(username)
                    }));
                list = list.child(row_shell(
                    index,
                    format!("browser.vault.inline.login.{id}"),
                    label,
                    highlighted,
                    &palette,
                    actions,
                    cx,
                    h_flex()
                        .w_full()
                        .gap(px(ROW_GAP_PX))
                        .items_center()
                        .child(tile(site_icon.cloned(), key, &palette))
                        .child(text),
                ));
            }
            PickerRow::Unlock { retry } => {
                let label = if retry { "Try again" } else { "Unlock Vault" };
                let content = h_flex().w_full().gap(px(ROW_GAP_PX)).items_center();
                // "Try again" is plain text; "Unlock Vault" has the Vault mark on a tile.
                let content = if retry {
                    content.child(
                        div()
                            .text_size(px(NAME_PX))
                            .line_height(px(NAME_LINE_PX))
                            .text_color(palette.text)
                            .child(label),
                    )
                } else {
                    let mark = svg()
                        .path("brand/vault-mark.svg")
                        .size(px(MARK_PX))
                        .flex_none()
                        .text_color(palette.text)
                        .into_any_element();
                    content.child(tile(None, mark, &palette)).child(
                        div()
                            .text_size(px(NAME_PX))
                            .line_height(px(NAME_LINE_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.text)
                            .child(label),
                    )
                };
                list = list.child(row_shell(
                    index,
                    "browser.vault.inline.unlock".to_owned(),
                    label.to_owned(),
                    highlighted,
                    &palette,
                    actions,
                    cx,
                    content,
                ));
            }
        }
    }

    deferred(
        anchored()
            .position(point(px(origin.0), px(origin.1)))
            .snap_to_window_with_margin(px(EDGE_MARGIN_PX))
            .child(list),
    )
    .with_priority(6)
    .into_any_element()
}

/// One row as a button: padded, rounded, lit under the pointer, and ringed while the keyboard is
/// on it (`.entry`, `button:hover`, `button:focus-visible`). The ring takes `RING_PX` of the
/// padding so the content does not move.
#[expect(
    clippy::too_many_arguments,
    reason = "one row's look and wiring, called for each kind of row"
)]
fn row_shell<T: 'static>(
    index: usize,
    ax_id: String,
    label: String,
    highlighted: bool,
    palette: &Palette,
    actions: &PickerActions<T>,
    cx: &mut Context<'_, T>,
    content: gpui_kit::Div,
) -> impl gpui_kit::IntoElement {
    let choose = actions.choose;
    let hover = palette.hover;
    div()
        .id(SharedString::from(format!("browser-vault-inline-{index}")))
        .test_support()
        .a11y(gpui_kit::Role::MenuItem, ax_id, label)
        .aria_selected(highlighted)
        .w_full()
        .flex()
        .items_center()
        .p(px(ROW_PAD_PX - RING_PX))
        .border(px(RING_PX))
        .border_color(if highlighted {
            palette.ring
        } else {
            gpui_kit::transparent_black()
        })
        .rounded(px(ROW_RADIUS_PX))
        .cursor_pointer()
        .hover(move |row| row.bg(hover))
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
                PickerRow::Login {
                    title, username, ..
                } => match username {
                    Some(username) => format!("{title}, {username}"),
                    None => title,
                },
                PickerRow::Note { text, .. } => text,
                PickerRow::Unlock { retry: true } => "Try again".to_owned(),
                PickerRow::Unlock { retry: false } => "Unlock Vault".to_owned(),
            })
            .collect()
    }
}

/// Canned Vault answers for tests, by host. Tests never reach the real Vault. A host named
/// `hang.example` never answers, and `broken.example` answers with an error.
#[cfg(test)]
pub(super) async fn stub_lookup(url: String, allow_unlock: bool) -> VaultLoginsResponse {
    if url.contains("hang.example") {
        return std::future::pending().await;
    }
    stub_logins(&url, allow_unlock)
}

/// Canned Vault answers for tests, by host.
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
    if url.contains("broken.example") {
        return VaultLoginsResponse {
            status: VaultLoginsStatus::Error,
            items: Vec::new(),
            error: Some("Vault could not answer. Open or update Vault and try again.".to_owned()),
        };
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

    /// A picker on a locked Vault: the lookup came back `Locked`.
    fn open_picker_locked() -> InlineLogins {
        let mut state = InlineLogins::default();
        assert!(state.apply_event(&event("focus", "username")));
        let generation = state.begin_lookup(false).expect("a lookup starts");
        assert!(state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[])));
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
        // Too tall for either side: sits as low as it fits, 8 px from the view's bottom, and
        // never closer than 8 px to its top (`inline.js` `position()`).
        assert_eq!(picker_origin(field, (280.0, 260.0), view()), (150.0, 58.0));
        // Above the field when that fits: 240 - 150 - 6.
        assert_eq!(picker_origin(field, (280.0, 150.0), view()), (150.0, 84.0));
    }

    #[test]
    fn the_picker_stays_inside_the_view_sideways() {
        let near_right = WebRect {
            x: 560.0,
            y: 70.0,
            width: 30.0,
            height: 20.0,
        };
        // 8 px from the view's right edge: 100 + 500 - 280 - 8.
        assert_eq!(picker_origin(near_right, (280.0, 80.0), view()).0, 312.0);
        let left_of_view = WebRect {
            x: 20.0,
            ..near_right
        };
        assert_eq!(picker_origin(left_of_view, (280.0, 80.0), view()).0, 108.0);
        // A view narrower than the picker pins the picker 8 px from its left edge.
        let narrow = WebRect {
            width: 200.0,
            ..view()
        };
        assert_eq!(picker_origin(near_right, (280.0, 80.0), narrow).0, 108.0);
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
        assert_eq!(state.labels(), ["me@example.com", "Bare"]);
    }

    #[test]
    fn a_locked_vault_offers_unlock_and_a_failed_one_offers_retry() {
        let mut state = InlineLogins::default();
        let generation = state.begin_lookup(false).expect("starts");
        assert_eq!(state.labels(), ["Loading…"]);
        state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[]));
        assert_eq!(state.labels(), ["Unlock Vault"]);
        assert_eq!(state.action(0), Some(RowAction::Unlock));

        let generation = state.begin_lookup(true).expect("starts");
        assert_eq!(
            state.labels(),
            ["Unlocking Vault…"],
            "while Vault's own prompt is up there is nothing to click"
        );
        assert_eq!(state.action(0), None);
        let mut failed = response(VaultLoginsStatus::Error, &[]);
        failed.error = Some("Vault could not answer.".to_owned());
        state.finish_lookup(generation, failed);
        assert_eq!(state.labels(), ["Vault could not answer.", "Try again"]);
        assert_eq!(state.action(0), None, "the message is not a choice");
        assert_eq!(state.action(1), Some(RowAction::Unlock));
    }

    #[test]
    fn a_locked_answer_never_leaves_the_picker_loading() {
        let mut state = open_picker_locked();
        assert!(!state.loading);
        assert_eq!(state.labels(), ["Unlock Vault"]);
        // Asking again to unlock and being cancelled comes back as locked again.
        let generation = state.begin_lookup(true).expect("an unlock starts");
        assert!(state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[])));
        assert_eq!(state.labels(), ["Unlock Vault"]);
    }

    #[test]
    fn a_stale_answer_is_ignored_and_the_current_lookup_still_finishes() {
        let mut state = InlineLogins::default();
        state.apply_event(&event("focus", "username"));
        let first = state.begin_lookup(false).expect("starts");
        let unlock = state.begin_lookup(true).expect("an unlock goes ahead");
        // The first answer is for a lookup the picker has moved on from.
        assert!(!state.finish_lookup(first, response(VaultLoginsStatus::Locked, &[])));
        assert_eq!(state.labels(), ["Unlocking Vault…"]);
        // The one it waits for settles it, whatever came before.
        assert!(state.finish_lookup(unlock, response(VaultLoginsStatus::Ok, &[])));
        assert!(!state.loading);
        assert_eq!(state.labels(), ["No matching login."]);
    }

    #[test]
    fn a_lookup_that_never_answers_ends_in_an_error_to_retry() {
        let mut state = InlineLogins::default();
        state.apply_event(&event("focus", "username"));
        let lost = state.begin_lookup(false).expect("starts");
        assert_eq!(state.begin_lookup(false), None, "one is running");
        assert!(
            !state.expire_lookup(lost + 1),
            "not the lookup it waits for"
        );
        assert!(state.expire_lookup(lost));
        assert!(!state.loading);
        assert_eq!(
            state.labels(),
            ["Vault did not answer in time.", "Try again"]
        );
        assert!(!state.expire_lookup(lost), "once only");
        // Retry runs a new lookup, and the old one's late answer changes nothing.
        let retry = state.begin_lookup(true).expect("a retry starts");
        assert!(!state.finish_lookup(lost, response(VaultLoginsStatus::Ok, &[])));
        assert!(state.finish_lookup(
            retry,
            response(VaultLoginsStatus::Ok, &[("a", "Example", None)])
        ));
        assert_eq!(state.labels()[0], "Example");
    }

    #[test]
    fn an_answer_that_came_in_time_is_not_replaced_by_the_timer() {
        let mut state = InlineLogins::default();
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[]));
        assert!(!state.expire_lookup(generation));
        assert_eq!(state.labels(), ["Unlock Vault"]);
    }

    #[test]
    fn a_long_error_line_gets_room_to_wrap() {
        let short = PickerRow::error("No answer.");
        let long = PickerRow::error("Vault could not answer. Open or update Vault and try again.");
        assert!(long.height(280.0) > short.height(280.0));
        let status = PickerRow::status("Vault is not installed, and this line is far too long.");
        assert!(status.height(280.0) > PickerRow::status("Short.").height(280.0));
        assert!(
            status.height(420.0) <= status.height(280.0),
            "a wider picker never needs more lines"
        );
    }

    #[tokio::test]
    async fn a_lookup_past_its_deadline_reads_as_a_vault_error() {
        let late = bounded_lookup(false, std::future::pending()).await;
        assert_eq!(late.status, VaultLoginsStatus::Error);
        assert_eq!(late.error.as_deref(), Some("Vault did not answer in time."));
        let prompt = bounded_lookup(true, async { response(VaultLoginsStatus::Locked, &[]) }).await;
        assert_eq!(
            prompt.status,
            VaultLoginsStatus::Locked,
            "an answer in time passes"
        );
        assert!(lookup_deadline(true) > lookup_deadline(false));
        assert!(watchdog_delay(false) > lookup_deadline(false));
    }

    #[test]
    fn empty_and_missing_vaults_say_so_and_offer_nothing_to_pick() {
        let mut state = InlineLogins::default();
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Ok, &[]));
        assert_eq!(state.labels(), ["No matching login."]);
        assert_eq!(state.action(0), None);
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Unavailable, &[]));
        assert_eq!(state.labels(), ["Vault is not installed"]);
        assert_eq!(state.action(0), None);
    }

    #[test]
    fn a_failed_fill_shows_why_and_reopens_the_picker() {
        let mut state = open_picker();
        state.close();
        state.fail("Vault unlock cancelled.");
        assert!(state.shown());
        assert_eq!(state.labels()[0], "Vault unlock cancelled.");
        assert_eq!(
            state.rows()[0],
            PickerRow::error("Vault unlock cancelled."),
            "a failed fill is an error line"
        );
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
        let field = WebRect {
            x: 150.0,
            y: 70.0,
            width: 300.0,
            height: 30.0,
        };
        let tall_view = WebRect {
            height: 900.0,
            ..view()
        };
        // Two logins with a username: 53 px each (29 px tile or 17 + 2 + 16 px of text, plus 9 px
        // padding on both sides), and 6 px of panel padding on both sides.
        assert_eq!(state.size(field, tall_view), (300.0, 2.0 * 53.0 + 12.0));
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
        assert_eq!(many.size(field, tall_view).1, 292.0, "capped at 292");
        // A short view leaves 8 px above and below.
        let short_view = WebRect {
            height: 100.0,
            ..view()
        };
        assert_eq!(many.size(field, short_view).1, 84.0);
        // A lone status line is never less than 40 px tall.
        let mut lone = InlineLogins::default();
        let generation = lone.begin_lookup(false).expect("starts");
        lone.finish_lookup(generation, response(VaultLoginsStatus::Locked, &[]));
        assert_eq!(lone.size(field, tall_view).1, 47.0 + 12.0);
    }

    #[test]
    fn row_heights_are_the_extensions_css() {
        let login = |username: Option<&str>| PickerRow::Login {
            id: "a".to_owned(),
            title: "Name".to_owned(),
            username: username.map(str::to_owned),
        };
        // A 29 px tile or the two text lines, whichever is taller, and 9 px padding on each side.
        assert_eq!(login(Some("me")).height(300.0), 35.0 + 18.0);
        assert_eq!(login(None).height(300.0), 29.0 + 18.0);
        assert_eq!(
            PickerRow::Unlock { retry: false }.height(300.0),
            29.0 + 18.0
        );
        assert_eq!(PickerRow::Unlock { retry: true }.height(300.0), 17.0 + 18.0);
        // One line of status text with 6 px above and below; an error line in its tinted box.
        let one_line = PickerRow::status("Loading…").height(300.0);
        assert!((one_line - (19.6 + 12.0)).abs() < 0.01, "{one_line}");
        let error = PickerRow::error("Oops").height(300.0);
        assert!((error - (18.2 + 18.0 + 3.0 + 6.0)).abs() < 0.01, "{error}");
    }

    #[test]
    fn the_picker_is_as_wide_as_the_field_within_280_and_420() {
        let field = |width| WebRect {
            x: 120.0,
            y: 70.0,
            width,
            height: 30.0,
        };
        let wide_view = WebRect {
            width: 1_000.0,
            ..view()
        };
        assert_eq!(picker_width(field(350.0), wide_view), 350.0, "the field's");
        assert_eq!(picker_width(field(120.0), wide_view), 280.0, "at least 280");
        assert_eq!(picker_width(field(900.0), wide_view), 420.0, "at most 420");
        let narrow_view = WebRect {
            width: 300.0,
            ..view()
        };
        assert_eq!(
            picker_width(field(350.0), narrow_view),
            284.0,
            "never past the view less 8 px a side"
        );
        let state = open_picker();
        assert_eq!(state.size(field(350.0), view()).0, 350.0);
    }

    #[test]
    fn the_palette_is_the_extensions_dark_and_light_pairs() {
        let hex = |color: Hsla| {
            let rgba = color.to_rgb();
            (
                (rgba.r * 255.0).round() as u8,
                (rgba.g * 255.0).round() as u8,
                (rgba.b * 255.0).round() as u8,
            )
        };
        let dark = Palette::of(Appearance::Dark);
        assert_eq!(hex(dark.surface), (0x24, 0x24, 0x26));
        assert_eq!(hex(dark.text), (0xee, 0xee, 0xee));
        assert_eq!(hex(dark.muted), (0xbb, 0xbb, 0xbb));
        assert_eq!(hex(dark.hover), (0x37, 0x37, 0x3c));
        assert_eq!(hex(dark.tile), (0x3f, 0x3f, 0x44));
        assert_eq!(hex(dark.error_text), (0xff, 0x6b, 0x61));
        let light = Palette::of(Appearance::Light);
        assert_eq!(hex(light.surface), (0xfa, 0xfa, 0xfa));
        assert_eq!(hex(light.text), (0x20, 0x20, 0x24));
        assert_eq!(hex(light.muted), (0x66, 0x66, 0x66));
        assert_eq!(hex(light.hover), (0xea, 0xea, 0xf0));
        assert_eq!(hex(light.tile), (0xe7, 0xe7, 0xec));
        assert_eq!(hex(light.error_text), (0xc4, 0x27, 0x1c));
        assert!((dark.error_fill.a - 0x26 as f32 / 255.0).abs() < 0.002);
        assert!((light.error_fill.a - 0x14 as f32 / 255.0).abs() < 0.002);
    }

    #[test]
    fn the_page_icon_shows_for_its_own_site_only() {
        let mut state = InlineLogins::default();
        let png = vec![0x89, b'P', b'N', b'G'];
        assert!(state.set_icon("https://Login.Example/sign-in?x=1", png.clone()));
        assert!(state.icon_for("https://login.example/other").is_some());
        assert!(
            state.icon_for("https://other.example/").is_none(),
            "another site gets none"
        );
        assert!(state.icon_for("http://login.example/").is_none());
        assert!(
            !state.set_icon("http://login.example/", png.clone()),
            "HTTPS only"
        );
        assert!(!state.set_icon("about:blank", png));
        assert!(
            !state.set_icon("https://login.example/", Vec::new()),
            "no empty icon"
        );
        state.reset();
        assert!(
            state.icon_for("https://login.example/").is_some(),
            "a new document keeps the icon until the site changes"
        );
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
        assert_eq!(state.cursor, Some(0));
        assert_eq!(state.handle_key("down"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(1));
        assert_eq!(state.handle_key("down"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(0), "wraps past the last login");
        assert_eq!(state.handle_key("up"), KeyOutcome::Handled);
        assert_eq!(state.cursor, Some(1), "wraps back");
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
        assert_eq!(state.cursor, Some(1));
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
    fn a_new_answer_drops_a_highlight_that_no_longer_points_at_a_login() {
        let mut state = open_picker();
        state.step(true);
        state.step(true);
        assert_eq!(state.cursor, Some(1));
        let generation = state.begin_lookup(false).expect("starts");
        state.finish_lookup(generation, response(VaultLoginsStatus::Ok, &[]));
        assert_eq!(state.cursor, None);
    }

    // ── Headless GPUI: the card as drawn ────────────────────────────────────────────

    /// The picker's width in the harness: a field 300 px wide.
    const HARNESS_WIDTH_PX: f32 = 300.0;

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
                dismiss: |this, _, _| this.outside_presses.set(this.outside_presses.get() + 1),
            };
            div()
                .size_full()
                .relative()
                .child(page)
                .child(render_picker(
                    &self.state,
                    (40.0, 40.0),
                    (HARNESS_WIDTH_PX, 200.0),
                    &self.tokens,
                    None,
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
            window.click("browser-vault-inline-1", cx);
        });
        assert!(clicked.is_ok());
        assert_eq!(*mounted.chosen.borrow(), vec![1]);
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
                window.try_find("browser-vault-inline-0").is_some(),
                window.try_find("browser-vault-inline-1").is_some(),
            )
        });
        assert_eq!(found.ok(), Some((true, false)), "Unlock is the only row");
        let clicked = cx.update_window(mounted.window, |_, window, cx| {
            window.click("browser-vault-inline-0", cx);
        });
        assert!(clicked.is_ok());
        assert_eq!(*mounted.chosen.borrow(), vec![0]);
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
        move_to(cx, &|w| w.find("browser-vault-inline-0").bounds().center());
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
            window.click("browser-vault-inline-0", cx);
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

    #[gpui_kit::test]
    fn the_card_is_laid_out_as_the_extensions_css(cx: &mut TestAppContext) {
        let mounted = mount(cx, open_picker());
        let bounds = cx.update_window(mounted.window, |_, window, cx| {
            window.render_frame(cx);
            let card = window.find("browser-vault-inline").bounds();
            let first = window.find("browser-vault-inline-0").bounds();
            let second = window.find("browser-vault-inline-1").bounds();
            (card, first, second)
        });
        let (card, first, second) = bounds.expect("the window is open");
        let (left, top) = (f32::from(card.left()), f32::from(card.top()));
        assert_eq!((left, top), (40.0, 40.0), "at the origin it was given");
        assert_eq!(
            f32::from(card.size.width),
            HARNESS_WIDTH_PX,
            "the field's width"
        );
        // 6 px of panel padding, then rows 53 px high with no gap between them.
        assert_eq!(f32::from(first.top()) - top, 6.0);
        assert_eq!(f32::from(first.left()) - left, 6.0);
        assert_eq!(f32::from(first.size.width), HARNESS_WIDTH_PX - 12.0);
        assert_eq!(f32::from(first.size.height), 53.0);
        assert_eq!(f32::from(second.top()), f32::from(first.bottom()));
        assert_eq!(f32::from(card.size.height), 2.0 * 53.0 + 12.0);
    }

    // ── Offscreen renders (`#[ignore]`d; they write PNGs) ───────────────────────────

    /// A stand-in for a site's own icon, 84 px square: a blue disc with a lighter wing. (The
    /// browser hands the real one over as PNG; the colours here are not any site's.)
    fn sample_icon() -> Arc<Image> {
        use image::ImageEncoder as _;
        let size = 84_u32;
        let mut rgba = vec![0_u8; (size * size * 4) as usize];
        for y in 0..size {
            for x in 0..size {
                let (dx, dy) = (x as f32 - 41.5, y as f32 - 41.5);
                let at = ((y * size + x) * 4) as usize;
                if dx * dx + dy * dy <= 38.0 * 38.0 {
                    let wing = (dx + 8.0).powi(2) / 400.0 + (dy - 6.0).powi(2) / 130.0 <= 1.0;
                    let color: [u8; 4] = if wing {
                        [0xa9, 0xd0, 0xff, 0xff]
                    } else {
                        [0x1c, 0x6c, 0xe6, 0xff]
                    };
                    rgba[at..at + 4].copy_from_slice(&color);
                }
            }
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&rgba, size, size, image::ExtendedColorType::Rgba8)
            .expect("an encoded icon");
        Arc::new(Image::from_bytes(ImageFormat::Png, png))
    }

    /// A page with one sign-in field and the picker under it, as the Browser panel draws them.
    struct ShotView {
        state: InlineLogins,
        tokens: Tokens,
        icon: Option<Arc<Image>>,
    }

    const SHOT_VIEW: WebRect = WebRect {
        x: 0.0,
        y: 0.0,
        width: 560.0,
        height: 380.0,
    };
    const SHOT_FIELD: WebRect = WebRect {
        x: 70.0,
        y: 70.0,
        width: 360.0,
        height: 40.0,
    };

    impl Render for ShotView {
        fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
            let dark = self.tokens.appearance == Appearance::Dark;
            let (page, ink, field, edge) = if dark {
                (rgb(0x16161a), rgb(0xe8e8ec), rgb(0x1f1f24), rgb(0x3a3a42))
            } else {
                (rgb(0xffffff), rgb(0x1b1b1f), rgb(0xffffff), rgb(0xcfcfd6))
            };
            let actions = PickerActions::<Self> {
                choose: |_, _, _, _| {},
                dismiss: |_, _, _| {},
            };
            let size = self.state.size(SHOT_FIELD, SHOT_VIEW);
            let origin = picker_origin(SHOT_FIELD, size, SHOT_VIEW);
            div()
                .size_full()
                .relative()
                .bg(page)
                .text_color(ink)
                .child(
                    div()
                        .absolute()
                        .left(px(SHOT_FIELD.x))
                        .top(px(SHOT_FIELD.y - 30.0))
                        .text_size(px(13.0))
                        .child("Email"),
                )
                .child(
                    div()
                        .absolute()
                        .left(px(SHOT_FIELD.x))
                        .top(px(SHOT_FIELD.y))
                        .w(px(SHOT_FIELD.width))
                        .h(px(SHOT_FIELD.height))
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(edge)
                        .bg(field),
                )
                .child(render_picker(
                    &self.state,
                    origin,
                    size,
                    &self.tokens,
                    self.icon.as_ref(),
                    &actions,
                    cx,
                ))
        }
    }

    fn shot_state(
        status: VaultLoginsStatus,
        items: &[(&str, &str, Option<&str>)],
        error: Option<&str>,
        loading: bool,
        keyboard_on: Option<usize>,
    ) -> InlineLogins {
        let mut state = InlineLogins::default();
        state.apply_event(&event("focus", "username"));
        let generation = state.begin_lookup(false).expect("a lookup starts");
        if !loading {
            let mut answer = response(status, items);
            answer.error = error.map(str::to_owned);
            state.finish_lookup(generation, answer);
        }
        for _ in 0..keyboard_on.map_or(0, |row| row + 1) {
            state.step(true);
        }
        state
    }

    /// Renders the picker offscreen to PNG: dark and light, one login, several logins (with the
    /// keyboard on the second), no site icon (the key), locked, loading, empty, and an error. It
    /// opens no window on screen and takes no focus: GPUI's headless renderer draws into a texture.
    ///
    /// `CONN_PICKER_SHOTS_DIR=<dir> cargo test -p conn-app render_picker_screenshots -- --ignored`
    #[test]
    #[ignore = "writes PNGs; set CONN_PICKER_SHOTS_DIR"]
    fn render_picker_screenshots() {
        let Some(dir) = std::env::var_os("CONN_PICKER_SHOTS_DIR") else {
            return;
        };
        let dir = std::path::Path::new(&dir);
        std::fs::create_dir_all(dir).expect("an output folder");
        // `current_platform(true)` needs the main thread, which libtest does not give a test.
        let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
            Arc::new(gpui_apple::AppleTextSystem::new()),
            Arc::new(crate::superhero::AppAssets),
            gpui_kit::platform::current_headless_renderer,
        );
        let one = [("a", "Moneybird", Some("nick@example.com"))];
        let several = [
            ("a", "Moneybird", Some("nick@example.com")),
            ("b", "Moneybird (work)", Some("accounting@example.com")),
            ("c", "Old login", None),
        ];
        let long = "Vault could not answer. Open or update Vault and try again.";
        for (theme_id, look) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
            let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
            let tokens = Tokens::derive(&theme);
            let ok = VaultLoginsStatus::Ok;
            let cases: Vec<(&str, InlineLogins, bool)> = vec![
                ("one-login", shot_state(ok, &one, None, false, None), true),
                (
                    "several-logins",
                    shot_state(ok, &several, None, false, Some(1)),
                    true,
                ),
                (
                    "no-site-icon",
                    shot_state(ok, &several, None, false, None),
                    false,
                ),
                (
                    "locked",
                    shot_state(VaultLoginsStatus::Locked, &[], None, false, None),
                    false,
                ),
                ("loading", shot_state(ok, &[], None, true, None), false),
                ("empty", shot_state(ok, &[], None, false, None), false),
                (
                    "error",
                    shot_state(VaultLoginsStatus::Error, &[], Some(long), false, Some(0)),
                    false,
                ),
            ];
            for (name, state, with_icon) in cases {
                let (window, _view) = ctx.update(|cx| {
                    gpui_kit::init(cx);
                    crate::fonts::register(cx);
                    crate::theme::apply_kit_theme(&tokens, cx);
                    let mut state = Some(state);
                    let tokens = tokens.clone();
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Point::default(),
                                size(px(SHOT_VIEW.width), px(SHOT_VIEW.height)),
                            ))),
                            focus: false,
                            show: false,
                            ..Default::default()
                        },
                        cx,
                        move |_, cx| {
                            cx.new(|_| ShotView {
                                state: state.take().unwrap_or_default(),
                                tokens,
                                icon: with_icon.then(sample_icon),
                            })
                        },
                    )
                    .expect("a window")
                });
                for _ in 0..4 {
                    ctx.update_window(window, |_, w, c| w.render_frame(c))
                        .expect("a frame");
                    ctx.run_until_parked();
                }
                let image = ctx.capture_screenshot(window).expect("a screenshot");
                image
                    .save(dir.join(format!("{look}-{name}.png")))
                    .expect("a saved PNG");
            }
        }
    }
}
