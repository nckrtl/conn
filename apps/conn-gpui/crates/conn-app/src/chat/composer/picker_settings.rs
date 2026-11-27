//! Settings column of the docked model picker (the lab's `.picker-options` and `PickerSelect`).
//!
//! The column lists, top to bottom: the selected model's effort, speed and other select options,
//! `Follow-up messages`, `Permissions`, then the model's switches (Claude's Ultracode). The model
//! options come from the catalog descriptors, so every provider shows what it offers; a select
//! with fewer than two choices is not a setting and is left out (Codex's `cyberAccessProgram`).
//!
//! A select opens an anchored menu under its field. The menu is a deferred popup that snaps into
//! the window, so a short window or a scrolled column never clips it. Keyboard: `Tab` in the
//! search field enters the column and moves between controls. Arrows, `Enter` and `Space`
//! open a select or flip a switch, `Escape` closes the menu and keeps the focus on its field.

use conn_state::providers::{ModelOption, ModelOptionDescriptor, OptionMap};
use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Anchor, AnyElement, App, Context, FocusHandle, InteractiveElement as _, IntoElement as _,
    KeyDownEvent, MouseButton, ParentElement as _, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, anchored, deferred, div, point, px,
};

use super::super::color::{hsla, hsla_alpha};
use super::super::icons;
use super::Composer;
use super::actions::FollowUpBehavior;
use super::footer::{RuntimeModeOption, runtime_mode_option};
use super::model_picker::{ModelPickerView, picker_colors, traits_model};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// `padding: 12px` of `.picker-options`; 8px at the lab's `max-width: 600px` breakpoint.
const PAD_PX: f32 = 12.0;
const PAD_COMPACT_PX: f32 = 8.0;
/// `gap: 10px` between controls.
const GAP_PX: f32 = 10.0;
/// `.picker-select`: a 16px label, a 4px gap and a 30px field (6px padding, 1px border, 16px line).
const LABEL_PX: f32 = 16.0;
const LABEL_GAP_PX: f32 = 4.0;
const FIELD_PX: f32 = 30.0;
const SELECT_PX: f32 = LABEL_PX + LABEL_GAP_PX + FIELD_PX;
/// `.model-trait`: `min-height: 32px`.
const SWITCH_PX: f32 = 32.0;
/// `.picker-select-menu`: `max-height: min(200px, 40vh)`, 26px rows.
const MENU_MAX_PX: f32 = 200.0;
const MENU_ROW_PX: f32 = 26.0;
const MENU_MARGIN_PX: f32 = 3.0;
const WINDOW_MARGIN_PX: f32 = 8.0;
const CHEVRON_DOWN: &str = "superhero/chevron-down.svg";
const CHECK: &str = "superhero/check.svg";
const FOLLOW_UP_HINT: &str = "While a turn runs: steer it, or queue after it";

/// Which control: a model option by descriptor id, or one of the two composer settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ControlKey {
    Option(String),
    FollowUp,
    Permissions,
}

impl ControlKey {
    /// Stable suffix of the control's element and AX ids.
    fn slug(&self) -> String {
        match self {
            Self::Option(id) => format!("option.{id}"),
            Self::FollowUp => "follow-up".to_owned(),
            Self::Permissions => "permissions".to_owned(),
        }
    }
}

/// What picking a choice or flipping a switch does.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Change {
    Option {
        id: String,
        value: serde_json::Value,
    },
    FollowUp(FollowUpBehavior),
    Permissions(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Choice {
    /// Stable id of the value, for the AX id.
    value: String,
    label: String,
    description: Option<String>,
    selected: bool,
    change: Change,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Kind {
    Select {
        current: String,
        description: Option<String>,
        choices: Vec<Choice>,
    },
    Switch {
        checked: bool,
        toggle: Change,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Control {
    key: ControlKey,
    label: String,
    kind: Kind,
}

impl Control {
    fn height(&self) -> f32 {
        match self.kind {
            Kind::Select { .. } => SELECT_PX,
            Kind::Switch { .. } => SWITCH_PX,
        }
    }
}

/// Everything the column reads, borrowed from the picker view or from the composer.
pub(super) struct Inputs<'a> {
    /// The model whose options show (see [`traits_model`]).
    pub(super) traits: Option<&'a ModelOption>,
    pub(super) selected_options: Option<&'a OptionMap>,
    pub(super) runtime_mode: &'a str,
    pub(super) runtime_options: &'a [RuntimeModeOption],
    pub(super) follow_up: FollowUpBehavior,
}

impl<'a> Inputs<'a> {
    fn from_view(view: &ModelPickerView<'a>) -> Self {
        Self {
            traits: traits_model(view.selected, view.selected_provider, view.query),
            selected_options: view.selected_options,
            runtime_mode: view.runtime_mode,
            runtime_options: view.runtime_options,
            follow_up: view.follow_up,
        }
    }
}

fn choice(
    value: &str,
    label: String,
    description: Option<String>,
    selected: bool,
    change: Change,
) -> Choice {
    Choice {
        value: value.to_owned(),
        label,
        description,
        selected,
        change,
    }
}

/// A select over a `Select` descriptor. `mark_default` adds the lab's ` (default)` to the level
/// the provider defaults to.
fn descriptor_select(
    descriptor: &ModelOptionDescriptor,
    label: Option<&str>,
    mark_default: bool,
    options: Option<&OptionMap>,
) -> Control {
    let id = descriptor.id().to_owned();
    let current_id = descriptor.select_value(options);
    let choices: Vec<Choice> = descriptor
        .selectable_choices()
        .into_iter()
        .map(|c| {
            choice(
                &c.id,
                if mark_default && c.is_default {
                    format!("{} (default)", c.label)
                } else {
                    c.label.clone()
                },
                c.description.clone(),
                current_id == Some(c.id.as_str()),
                Change::Option {
                    id: id.clone(),
                    value: serde_json::Value::String(c.id.clone()),
                },
            )
        })
        .collect();
    select_control(
        ControlKey::Option(id),
        label.unwrap_or_else(|| descriptor.label()).to_owned(),
        choices,
        None,
    )
}

/// A select over a `Boolean` descriptor, such as effort `On`/`Off` or `Standard`/`Fast`.
fn boolean_select(
    descriptor: &ModelOptionDescriptor,
    label: Option<&str>,
    labels: [&str; 2],
    options: Option<&OptionMap>,
) -> Control {
    let id = descriptor.id().to_owned();
    let on = descriptor.bool_value(options);
    let choices = [false, true]
        .into_iter()
        .zip(labels)
        .map(|(value, text)| {
            choice(
                if value { "on" } else { "off" },
                text.to_owned(),
                None,
                on == value,
                Change::Option {
                    id: id.clone(),
                    value: serde_json::Value::Bool(value),
                },
            )
        })
        .collect();
    select_control(
        ControlKey::Option(id),
        label.unwrap_or_else(|| descriptor.label()).to_owned(),
        choices,
        None,
    )
}

fn select_control(
    key: ControlKey,
    label: String,
    choices: Vec<Choice>,
    description: Option<String>,
) -> Control {
    let current = choices
        .iter()
        .find(|c| c.selected)
        .map(|c| c.label.clone())
        .unwrap_or_default();
    Control {
        key,
        label,
        kind: Kind::Select {
            current,
            description,
            choices,
        },
    }
}

fn switch_control(descriptor: &ModelOptionDescriptor, options: Option<&OptionMap>) -> Control {
    let checked = descriptor.bool_value(options);
    Control {
        key: ControlKey::Option(descriptor.id().to_owned()),
        label: descriptor.label().to_owned(),
        kind: Kind::Switch {
            checked,
            toggle: Change::Option {
                id: descriptor.id().to_owned(),
                value: serde_json::Value::Bool(!checked),
            },
        },
    }
}

/// The column's controls, in display order.
pub(super) fn controls(inputs: &Inputs<'_>) -> Vec<Control> {
    let mut out = Vec::new();
    let mut switches = Vec::new();
    if let Some(model) = inputs.traits {
        let options = inputs.selected_options;
        let column = model.column_controls();
        if let Some(effort) = column.effort {
            // Always `Effort`, as in the lab, whatever the provider calls it (Claude's
            // `Reasoning`).
            out.push(match effort {
                ModelOptionDescriptor::Select { .. } => {
                    descriptor_select(effort, Some("Effort"), true, options)
                }
                ModelOptionDescriptor::Boolean { .. } => {
                    boolean_select(effort, Some("Effort"), ["Off", "On"], options)
                }
            });
        }
        if let Some(speed) = column.speed_select {
            out.push(descriptor_select(speed, Some("Speed"), false, options));
        } else if let Some(fast) = column.fast_toggle {
            out.push(boolean_select(
                fast,
                Some("Speed"),
                ["Standard", "Fast"],
                options,
            ));
        }
        for extra in column.others {
            match extra {
                // One choice is a fixed value, not a setting.
                ModelOptionDescriptor::Select { .. } => {
                    if extra.selectable_choices().len() > 1 {
                        out.push(descriptor_select(extra, None, false, options));
                    }
                }
                ModelOptionDescriptor::Boolean { .. } => {
                    switches.push(switch_control(extra, options));
                }
            }
        }
    }
    out.push(follow_up_control(inputs.follow_up));
    out.push(permissions_control(
        inputs.runtime_mode,
        inputs.runtime_options,
    ));
    out.extend(switches);
    out
}

fn follow_up_control(current: FollowUpBehavior) -> Control {
    let choices = [FollowUpBehavior::Steer, FollowUpBehavior::Queue]
        .into_iter()
        .map(|behavior| {
            choice(
                behavior.verb(),
                behavior.label().to_owned(),
                None,
                behavior == current,
                Change::FollowUp(behavior),
            )
        })
        .collect();
    select_control(
        ControlKey::FollowUp,
        "Follow-up messages".to_owned(),
        choices,
        Some(FOLLOW_UP_HINT.to_owned()),
    )
}

/// Permissions: the provider's supported modes, as the footer chip lists them.
fn permissions_control(runtime_mode: &str, options: &[RuntimeModeOption]) -> Control {
    let current = runtime_mode_option(runtime_mode);
    let mut choices: Vec<Choice> = options
        .iter()
        .map(|option| {
            choice(
                option.mode,
                option.label.to_owned(),
                Some(option.description.to_owned()),
                option.mode == runtime_mode,
                Change::Permissions(option.mode),
            )
        })
        .collect();
    // A mode the provider does not list still shows as the current one.
    if !choices.iter().any(|c| c.selected) {
        choices.insert(
            0,
            choice(
                current.mode,
                current.label.to_owned(),
                Some(current.description.to_owned()),
                true,
                Change::Permissions(current.mode),
            ),
        );
    }
    let mut control = select_control(
        ControlKey::Permissions,
        "Permissions".to_owned(),
        choices,
        Some(current.description.to_owned()),
    );
    if let Kind::Select { current: label, .. } = &mut control.kind {
        *label = current.label.to_owned();
    }
    control
}

fn padding(compact: bool) -> f32 {
    if compact { PAD_COMPACT_PX } else { PAD_PX }
}

/// Top and bottom of each control inside the column content, padding counted.
fn spans(controls: &[Control], compact: bool) -> Vec<(f32, f32)> {
    let mut top = padding(compact);
    controls
        .iter()
        .map(|control| {
            let span = (top, top + control.height());
            top = span.1 + GAP_PX;
            span
        })
        .collect()
}

/// The scroll offset (`<= 0`) that shows `span` with the least movement (`block: "nearest"`).
fn reveal(span: (f32, f32), viewport: f32, offset: f32) -> f32 {
    if viewport <= 0.0 {
        return offset;
    }
    let visible_top = -offset;
    if span.0 < visible_top {
        -span.0
    } else if span.1 > visible_top + viewport {
        -(span.1 - viewport).max(0.0)
    } else {
        offset
    }
}

/// Which side of its field a menu opens on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Side {
    Below,
    Above,
}

/// Below the field unless the menu does not fit there and there is more room above (the lab's
/// `position-try-fallbacks: flip-block`). Unknown geometry stays below.
fn menu_side(field_top: f32, field_bottom: f32, menu_h: f32, viewport_h: f32) -> Side {
    if viewport_h <= 0.0 {
        return Side::Below;
    }
    let below = viewport_h - field_bottom - MENU_MARGIN_PX - WINDOW_MARGIN_PX;
    let above = field_top - MENU_MARGIN_PX - WINDOW_MARGIN_PX;
    if menu_h > below && above > below {
        Side::Above
    } else {
        Side::Below
    }
}

/// `max-height: min(200px, 40vh)`.
fn menu_max_height(viewport_h: f32) -> f32 {
    if viewport_h > 0.0 {
        MENU_MAX_PX.min(0.4 * viewport_h)
    } else {
        MENU_MAX_PX
    }
}

/// A menu of `rows` rows: its padding and border around the rows, up to the cap.
fn menu_height(rows: usize, viewport_h: f32) -> f32 {
    let rows = f32::from(u16::try_from(rows).unwrap_or(u16::MAX));
    (rows * MENU_ROW_PX + 10.0).min(menu_max_height(viewport_h))
}

/// Keys the column reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Key {
    Up,
    Down,
    Home,
    End,
    Enter,
    Space,
    Right,
    Tab,
    ShiftTab,
    Escape,
}

impl Key {
    fn parse(key: &str, shift: bool) -> Option<Self> {
        Some(match (key, shift) {
            ("up", _) => Self::Up,
            ("down", _) => Self::Down,
            ("home", _) => Self::Home,
            ("end", _) => Self::End,
            ("enter", _) => Self::Enter,
            ("space", _) => Self::Space,
            ("right", _) => Self::Right,
            ("tab", false) => Self::Tab,
            ("tab", true) => Self::ShiftTab,
            ("escape", _) => Self::Escape,
            _ => return None,
        })
    }
}

/// Menu and cursor state, apart from focus, so the key rules test without a window.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Nav {
    pub(super) open: Option<ControlKey>,
    pub(super) highlighted: usize,
    pub(super) cursor: Option<ControlKey>,
}

/// What a key did.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Outcome {
    /// Not the column's key: let it through.
    Ignored,
    /// Consumed; the state changed or stays.
    Handled,
    /// Apply this change (the menu is closed).
    Apply(Change),
    /// Close the picker and return focus to the composer.
    Dismiss,
    /// Focus leaves the column for the search field.
    Leave,
}

fn position(controls: &[Control], key: Option<&ControlKey>) -> Option<usize> {
    controls.iter().position(|c| Some(&c.key) == key)
}

fn select_choices(control: &Control) -> &[Choice] {
    match &control.kind {
        Kind::Select { choices, .. } => choices,
        Kind::Switch { .. } => &[],
    }
}

fn open_menu(nav: &mut Nav, control: &Control) {
    nav.highlighted = select_choices(control)
        .iter()
        .position(|c| c.selected)
        .unwrap_or(0);
    nav.open = Some(control.key.clone());
    nav.cursor = Some(control.key.clone());
}

/// One key in the column. `controls` is the current list; stale state is dropped first.
pub(super) fn navigate(nav: &mut Nav, controls: &[Control], key: Key) -> Outcome {
    if controls.is_empty() {
        return Outcome::Ignored;
    }
    if position(controls, nav.open.as_ref()).is_none() {
        nav.open = None;
    }
    if position(controls, nav.cursor.as_ref()).is_none() {
        nav.cursor = None;
    }
    let last = controls.len() - 1;
    if let Some(index) = position(controls, nav.open.as_ref()) {
        let choices = select_choices(&controls[index]);
        let (current, len) = (nav.highlighted, choices.len());
        let step = |delta: isize| super::step_index(current, delta, len);
        return match key {
            Key::Up => {
                nav.highlighted = step(-1);
                Outcome::Handled
            }
            Key::Down => {
                nav.highlighted = step(1);
                Outcome::Handled
            }
            Key::Home => {
                nav.highlighted = 0;
                Outcome::Handled
            }
            Key::End => {
                nav.highlighted = choices.len().saturating_sub(1);
                Outcome::Handled
            }
            Key::Enter | Key::Space => {
                nav.open = None;
                choices
                    .get(nav.highlighted)
                    .map_or(Outcome::Handled, |c| Outcome::Apply(c.change.clone()))
            }
            Key::Escape | Key::Tab | Key::ShiftTab => {
                nav.open = None;
                Outcome::Handled
            }
            Key::Right => Outcome::Handled,
        };
    }
    let at = position(controls, nav.cursor.as_ref());
    let go = |nav: &mut Nav, index: usize| {
        nav.cursor = Some(controls[index].key.clone());
        Outcome::Handled
    };
    match key {
        Key::Home | Key::End => Outcome::Ignored,
        Key::Tab => match at {
            Some(i) if i < last => go(nav, i + 1),
            Some(_) => {
                nav.cursor = None;
                Outcome::Leave
            }
            None => go(nav, 0),
        },
        Key::ShiftTab => match at {
            Some(i) if i > 0 => go(nav, i - 1),
            _ => {
                nav.cursor = None;
                Outcome::Leave
            }
        },
        // A focused closed select opens on its selected choice, like the lab's trigger; a switch
        // flips on `Enter` and `Space` only.
        Key::Up | Key::Down | Key::Enter | Key::Space | Key::Right => {
            let index = at.unwrap_or(0);
            nav.cursor = Some(controls[index].key.clone());
            match &controls[index].kind {
                Kind::Select { .. } => {
                    open_menu(nav, &controls[index]);
                    Outcome::Handled
                }
                Kind::Switch { toggle, .. } if matches!(key, Key::Enter | Key::Space) => {
                    Outcome::Apply(toggle.clone())
                }
                Kind::Switch { .. } => Outcome::Handled,
            }
        }
        // `Escape` closes the whole picker, as everywhere else in the composer.
        Key::Escape => Outcome::Dismiss,
    }
}

/// Settings column state kept by the composer.
pub(super) struct SettingsState {
    focus: FocusHandle,
    menu_scroll: ScrollHandle,
    /// The shell's scrolling settings column; the shell tracks it with [`Self::column_scroll`].
    column_scroll: ScrollHandle,
    /// Window height and compact flag of the last render, for menu and scroll placement.
    viewport_h: f32,
    compact: bool,
    nav: Nav,
    /// The cursor shows a ring only while the keyboard drives the column.
    keyboard: bool,
    hovered_field: Option<ControlKey>,
    menu_hovered: bool,
}

impl SettingsState {
    pub(super) fn new(cx: &mut Context<'_, Composer>) -> Self {
        Self {
            focus: cx.focus_handle(),
            menu_scroll: ScrollHandle::new(),
            column_scroll: ScrollHandle::new(),
            viewport_h: 0.0,
            compact: false,
            nav: Nav::default(),
            keyboard: false,
            hovered_field: None,
            menu_hovered: false,
        }
    }

    /// The handle the shell puts on its scrolling settings column.
    pub(super) fn column_scroll(&self) -> &ScrollHandle {
        &self.column_scroll
    }

    /// Records the window height and the compact flag the picker renders with.
    pub(super) fn set_layout(&mut self, viewport_h: f32, compact: bool) {
        self.viewport_h = viewport_h;
        self.compact = compact;
    }

    /// Back to the closed, unfocused state (the picker opens or closes).
    pub(super) fn reset(&mut self) {
        self.nav = Nav::default();
        self.keyboard = false;
        self.hovered_field = None;
        self.menu_hovered = false;
    }

    fn close_menu(&mut self) {
        self.nav.open = None;
        self.menu_hovered = false;
    }
}

/// Renders the scrollable settings content.
pub(super) fn render(view: &ModelPickerView<'_>, cx: &mut Context<'_, Composer>) -> AnyElement {
    let tokens = view.tokens;
    let compact = view.geometry.compact;
    let pad = padding(compact);
    let controls = controls(&Inputs::from_view(view));
    let state = view.settings;
    let width = (view.geometry.settings_width() - 1.0 - 2.0 * pad).max(0.0);
    // The column's top edge in the window, from its last paint and scroll offset.
    let column_top = f32::from(state.column_scroll.bounds().origin.y)
        + f32::from(state.column_scroll.offset().y);
    let spans = spans(&controls, compact);

    let mut column = div()
        .id("model-picker-settings-body")
        .track_focus(&state.focus)
        .flex()
        .flex_col()
        .gap(px(GAP_PX))
        .p(px(pad))
        .w_full();
    for (control, span) in controls.iter().zip(spans) {
        let open = state.nav.open.as_ref() == Some(&control.key);
        let ring = state.keyboard && state.nav.cursor.as_ref() == Some(&control.key);
        let field_top = column_top + span.0 + LABEL_PX + LABEL_GAP_PX;
        let side = menu_side(
            field_top,
            field_top + FIELD_PX,
            menu_height(select_choices(control).len(), state.viewport_h),
            state.viewport_h,
        );
        let menu = MenuSpec {
            width,
            side,
            max_height: menu_max_height(state.viewport_h),
        };
        column = column.child(match &control.kind {
            Kind::Select { .. } => render_select(control, open, ring, state, menu, tokens, cx),
            Kind::Switch { checked, toggle } => {
                render_switch(control, *checked, toggle.clone(), ring, tokens, cx)
            }
        });
    }
    column.into_any_element()
}

/// Where and how big a select's menu is.
#[derive(Clone, Copy)]
struct MenuSpec {
    width: f32,
    side: Side,
    max_height: f32,
}

fn render_select(
    control: &Control,
    open: bool,
    ring: bool,
    state: &SettingsState,
    menu_spec: MenuSpec,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let Kind::Select {
        current,
        description,
        choices,
    } = &control.kind
    else {
        return div().into_any_element();
    };
    let colors = picker_colors(tokens);
    let (fg, muted, line, selected_bg) = (colors.fg, colors.muted, colors.line, colors.selected);
    let slug = control.key.slug();
    let ax = format!("composer.model-picker.settings.{slug}");

    let hover_key = control.key.clone();
    let click_key = control.key.clone();
    let field = div()
        .id(SharedString::from(format!("model-picker-settings-{slug}")))
        .a11y_button(ax, format!("{}: {current}", control.label))
        .aria_expanded(open)
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .w_full()
        .h(px(FIELD_PX))
        .px(px(8.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(if ring {
            hsla_alpha(tokens.primary, 0.7)
        } else {
            line
        })
        .bg(selected_bg)
        .cursor_pointer()
        .text_size(px(13.0))
        .line_height(px(16.0))
        .text_color(fg)
        .on_hover(cx.listener(move |composer, hovered: &bool, _, _| {
            let state = &mut composer.picker_settings;
            if *hovered {
                state.hovered_field = Some(hover_key.clone());
            } else if state.hovered_field.as_ref() == Some(&hover_key) {
                state.hovered_field = None;
            }
        }))
        .on_click(cx.listener(move |composer, _, window, cx| {
            composer.toggle_settings_menu(click_key.clone(), window, cx);
        }))
        .when(!open, |el| {
            el.when_some(description.clone(), |el, text| {
                el.conn_tooltip(text, tokens)
            })
        })
        .child(div().flex_1().min_w_0().truncate().child(current.clone()))
        .child(icons::icon(CHEVRON_DOWN, 12.0, muted));

    let mut cell = div()
        .relative()
        .flex()
        .flex_col()
        .flex_none()
        .gap(px(LABEL_GAP_PX))
        .child(
            div()
                .h(px(LABEL_PX))
                .text_size(px(12.0))
                .line_height(px(LABEL_PX))
                .text_color(muted)
                .child(control.label.clone()),
        )
        .child(field);

    if open {
        let menu = render_menu(control, choices, state, menu_spec, tokens, cx);
        // A zero-height anchor point 3px under the field, or 3px above it when the menu flips.
        // The menu hangs from the point (`TopLeft`) or stands on it (`BottomLeft`).
        let spot = div().absolute().left_0();
        let (spot, corner) = match menu_spec.side {
            Side::Below => (spot.top_full().mt(px(MENU_MARGIN_PX)), Anchor::TopLeft),
            Side::Above => (
                spot.bottom(px(FIELD_PX + MENU_MARGIN_PX)),
                Anchor::BottomLeft,
            ),
        };
        cell = cell.child(
            spot.child(
                deferred(
                    anchored()
                        .anchor(corner)
                        .snap_to_window_with_margin(px(WINDOW_MARGIN_PX))
                        .child(menu),
                )
                .with_priority(5),
            ),
        );
    }
    cell.into_any_element()
}

fn render_menu(
    control: &Control,
    choices: &[Choice],
    state: &SettingsState,
    spec: MenuSpec,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let colors = picker_colors(tokens);
    let (fg, selected_bg, hover_bg) = (colors.fg, colors.selected, colors.hover);
    let slug = control.key.slug();
    let out_key = control.key.clone();
    let mut menu = div()
        .id(SharedString::from(format!(
            "model-picker-settings-{slug}-menu"
        )))
        .a11y(
            gpui_kit::Role::Menu,
            format!("composer.model-picker.settings.{slug}.menu"),
            control.label.clone(),
        )
        .occlude()
        .flex()
        .flex_col()
        .min_w(px(spec.width))
        .max_h(px(spec.max_height))
        .overflow_y_scroll()
        .track_scroll(&state.menu_scroll)
        .p(px(4.0))
        .rounded(px(8.0))
        .bg(hsla(tokens.popover))
        .border_1()
        .border_color(colors.line)
        .shadow_md()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_hover(cx.listener(|composer, hovered: &bool, _, _| {
            composer.picker_settings.menu_hovered = *hovered;
        }))
        .on_mouse_down_out(cx.listener(move |composer, _, _, cx| {
            let state = &mut composer.picker_settings;
            // The field toggles its own menu on click; closing here would reopen it.
            if state.nav.open.as_ref() == Some(&out_key)
                && state.hovered_field.as_ref() != Some(&out_key)
            {
                state.close_menu();
                cx.notify();
            }
        }));
    for (index, item) in choices.iter().enumerate() {
        let change = item.change.clone();
        let highlighted = state.nav.highlighted == index;
        menu = menu.child(
            div()
                .id(SharedString::from(format!(
                    "model-picker-settings-{slug}-item-{index}"
                )))
                .a11y(
                    gpui_kit::Role::MenuItem,
                    format!("composer.model-picker.settings.{slug}.item.{}", item.value),
                    item.label.clone(),
                )
                .aria_selected(item.selected)
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .w_full()
                .min_h(px(MENU_ROW_PX))
                .px(px(8.0))
                .rounded(px(4.0))
                .whitespace_nowrap()
                .cursor_pointer()
                .text_size(px(13.0))
                .line_height(px(16.0))
                .text_color(fg)
                .when(highlighted, |el| el.bg(selected_bg))
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(move |composer, _, window, cx| {
                    composer.apply_settings_change(change.clone(), window, cx);
                }))
                .when_some(item.description.clone(), |el, text| {
                    el.conn_tooltip(text, tokens)
                })
                .child(item.label.clone())
                .when(item.selected, |el| el.child(icons::icon(CHECK, 12.0, fg))),
        );
    }
    menu.into_any_element()
}

fn render_switch(
    control: &Control,
    checked: bool,
    toggle: Change,
    ring: bool,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let colors = picker_colors(tokens);
    let (fg, muted, hover_bg) = (colors.fg, colors.muted, colors.selected);
    let slug = control.key.slug();
    div()
        .id(SharedString::from(format!("model-picker-settings-{slug}")))
        .a11y_switch(
            format!("composer.model-picker.settings.{slug}"),
            control.label.clone(),
            checked,
        )
        .flex()
        .flex_row()
        .flex_none()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .w_full()
        .h(px(SWITCH_PX))
        .px(px(8.0))
        .rounded(px(4.0))
        .when(ring, |el| el.bg(hover_bg))
        .cursor_pointer()
        .text_size(px(12.0))
        .line_height(px(16.0))
        .text_color(muted)
        .hover(move |s| s.bg(hover_bg))
        .on_click(cx.listener(move |composer, _, window, cx| {
            composer.apply_settings_change(toggle.clone(), window, cx);
        }))
        .child(control.label.clone())
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .w(px(28.0))
                .h(px(16.0))
                .p(px(2.0))
                .rounded_full()
                .bg(if checked {
                    fg
                } else {
                    hsla_alpha(tokens.input, 0.80)
                })
                .when(checked, |el| el.justify_end())
                .child(
                    div()
                        .size(px(12.0))
                        .rounded_full()
                        .bg(hsla(tokens.background)),
                ),
        )
        .into_any_element()
}

impl Composer {
    /// The column's controls for the composer's current model, mode and follow-up.
    fn settings_controls(&self, cx: &App) -> Vec<Control> {
        let query = self.model_search_input.read(cx).value().to_string();
        let runtime_options = self.runtime_mode_options();
        controls(&Inputs {
            traits: traits_model(
                self.selected_model_option(),
                self.picker_provider_filter.as_deref(),
                &query,
            ),
            selected_options: self.selected_options.as_ref(),
            runtime_mode: &self.runtime_mode,
            runtime_options: &runtime_options,
            follow_up: self.effective_follow_up(),
        })
    }

    /// Opens or closes `key`'s menu from a click on its field.
    pub(super) fn toggle_settings_menu(
        &mut self,
        key: ControlKey,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let controls = self.settings_controls(cx);
        let Some(control) = controls.iter().find(|c| c.key == key) else {
            return;
        };
        let state = &mut self.picker_settings;
        if state.nav.open.as_ref() == Some(&key) {
            state.close_menu();
            state.nav.cursor = Some(key);
        } else if matches!(control.kind, Kind::Select { .. }) {
            open_menu(&mut state.nav, control);
        }
        state.keyboard = false;
        window.focus(&state.focus, cx);
        cx.notify();
    }

    /// Applies a picked choice or a flipped switch. The menu closes and the focus stays on the
    /// column, on the control that changed.
    pub(super) fn apply_settings_change(
        &mut self,
        change: Change,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        match change {
            Change::Option { id, value } => self.set_model_option(id, value, cx),
            Change::FollowUp(behavior) => self.set_follow_up_behavior(behavior, cx),
            Change::Permissions(mode) => self.pick_runtime_mode(mode, cx),
        }
        self.picker_settings.close_menu();
        window.focus(&self.picker_settings.focus, cx);
        cx.notify();
    }

    /// Keys while the picker is open. Returns whether the key was consumed.
    pub(super) fn handle_settings_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let stroke = &event.keystroke;
        let modifiers = stroke.modifiers;
        if modifiers.platform || modifiers.control || modifiers.alt {
            return false;
        }
        let Some(key) = Key::parse(stroke.key.as_str(), modifiers.shift) else {
            return false;
        };
        self.navigate_settings(key, window, cx)
    }

    pub(super) fn navigate_settings(
        &mut self,
        key: Key,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let controls = self.settings_controls(cx);
        if !self.picker_settings.focus.is_focused(window) {
            // `Tab` in the search field walks into the column.
            if key != Key::Tab || controls.is_empty() {
                return false;
            }
            let state = &mut self.picker_settings;
            state.nav.cursor = Some(controls[0].key.clone());
            state.keyboard = true;
            window.focus(&state.focus, cx);
            self.reveal_settings_cursor(&controls);
            cx.notify();
            return true;
        }
        match navigate(&mut self.picker_settings.nav, &controls, key) {
            Outcome::Ignored => return false,
            Outcome::Dismiss => {
                self.close_overlays(cx);
                self.focus_input(window, cx);
                return true;
            }
            Outcome::Handled => self.picker_settings.keyboard = true,
            Outcome::Apply(change) => {
                self.picker_settings.keyboard = true;
                self.apply_settings_change(change, window, cx);
            }
            Outcome::Leave => {
                self.picker_settings.keyboard = false;
                self.model_search_input
                    .update(cx, |input, cx| input.focus(window, cx));
            }
        }
        self.reveal_settings_cursor(&controls);
        let state = &self.picker_settings;
        if state.nav.open.is_some() {
            state.menu_scroll.scroll_to_item(state.nav.highlighted);
        }
        cx.notify();
        true
    }

    /// Scrolls the settings column the least that shows the keyboard cursor's control. The first
    /// and last control reveal their padding too.
    fn reveal_settings_cursor(&self, controls: &[Control]) {
        let state = &self.picker_settings;
        let Some(index) = position(controls, state.nav.cursor.as_ref()) else {
            return;
        };
        let all = spans(controls, state.compact);
        let mut span = all[index];
        if index == 0 {
            span.0 = 0.0;
        }
        if index + 1 == all.len() {
            span.1 += padding(state.compact);
        }
        let viewport = f32::from(state.column_scroll.bounds().size.height);
        let offset = state.column_scroll.offset();
        let next = reveal(span, viewport, f32::from(offset.y));
        if (next - f32::from(offset.y)).abs() > f32::EPSILON {
            state.column_scroll.set_offset(point(offset.x, px(next)));
        }
    }

    /// A press outside the open picker closes it and gives the focus back to the draft.
    pub(super) fn dismiss_picker_outside(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        // The trigger toggles on click, and a menu item selects on click: both are inside.
        if !self.model_picker_open
            || self.model_trigger_hovered
            || self.picker_settings.menu_hovered
        {
            return;
        }
        self.model_picker_open = false;
        self.picker_settings.reset();
        self.focus_input(window, cx);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use conn_state::providers::SelectChoice;

    use super::super::footer::RUNTIME_MODES;
    use super::*;

    fn select(key: ControlKey, labels: &[(&str, bool)]) -> Control {
        let choices = labels
            .iter()
            .map(|(label, selected)| {
                choice(
                    label,
                    (*label).to_owned(),
                    None,
                    *selected,
                    Change::Option {
                        id: "x".to_owned(),
                        value: serde_json::Value::String((*label).to_owned()),
                    },
                )
            })
            .collect();
        select_control(key, "X".to_owned(), choices, None)
    }

    fn base_inputs<'a>(modes: &'a [RuntimeModeOption]) -> Inputs<'a> {
        Inputs {
            traits: None,
            selected_options: None,
            runtime_mode: "full-access",
            runtime_options: modes,
            follow_up: FollowUpBehavior::Steer,
        }
    }

    #[test]
    fn without_a_model_only_the_composer_settings_show() {
        let list = controls(&base_inputs(&RUNTIME_MODES));
        let keys: Vec<_> = list.iter().map(|c| c.key.clone()).collect();
        assert_eq!(keys, vec![ControlKey::FollowUp, ControlKey::Permissions]);
        let Kind::Select { current, .. } = &list[1].kind else {
            panic!("permissions is a select");
        };
        assert_eq!(current, "Full access");
    }

    #[test]
    fn permissions_follow_the_provider_and_keep_a_current_mode() {
        let supported = [RUNTIME_MODES[0], RUNTIME_MODES[3]];
        let Kind::Select { choices, .. } = permissions_control("full-access", &supported).kind
        else {
            panic!("select");
        };
        assert_eq!(choices.len(), 2, "unsupported modes stay out");
        // A mode the provider lacks still shows as current instead of an empty field.
        let Kind::Select {
            choices, current, ..
        } = permissions_control("auto", &supported).kind
        else {
            panic!("select");
        };
        assert_eq!(current, "Auto");
        assert!(choices[0].selected);
    }

    #[test]
    fn keyboard_scroll_spans_follow_control_spacing() {
        // Four selects: the lab's standard Codex column (254px) and its compact one (246px).
        let four: Vec<_> = (0..4)
            .map(|i| {
                select(
                    ControlKey::Option(i.to_string()),
                    &[("a", true), ("b", false)],
                )
            })
            .collect();
        assert_eq!(spans(&four, false).last(), Some(&(192.0, 242.0)));
        assert_eq!(spans(&four, true).last(), Some(&(188.0, 238.0)));
        let mut five = four;
        five.push(Control {
            key: ControlKey::Option("ultracode".to_owned()),
            label: "Ultracode".to_owned(),
            kind: Kind::Switch {
                checked: false,
                toggle: Change::FollowUp(FollowUpBehavior::Steer),
            },
        });
        assert_eq!(spans(&five, false).last(), Some(&(252.0, 284.0)));
    }

    #[test]
    fn keys_move_open_and_choose() {
        let list = vec![
            select(
                ControlKey::Option("effort".to_owned()),
                &[("low", false), ("high", true)],
            ),
            select(ControlKey::FollowUp, &[("steer", true), ("queue", false)]),
        ];
        let mut nav = Nav {
            cursor: Some(list[0].key.clone()),
            ..Nav::default()
        };
        // Tab moves between fields; it does not open anything.
        assert_eq!(navigate(&mut nav, &list, Key::Tab), Outcome::Handled);
        assert_eq!(nav.cursor, Some(ControlKey::FollowUp));
        assert_eq!(navigate(&mut nav, &list, Key::ShiftTab), Outcome::Handled);
        assert_eq!(nav.cursor, Some(list[0].key.clone()));
        assert_eq!(nav.open, None);
        // Up and Down on a focused closed field open it on the selected choice.
        assert_eq!(navigate(&mut nav, &list, Key::Down), Outcome::Handled);
        assert_eq!(nav.open, Some(list[0].key.clone()));
        assert_eq!(nav.highlighted, 1);
        // In the menu they move and wrap; Home goes to the first choice.
        assert_eq!(navigate(&mut nav, &list, Key::Down), Outcome::Handled);
        assert_eq!(nav.highlighted, 0, "wraps past the end");
        assert_eq!(navigate(&mut nav, &list, Key::Up), Outcome::Handled);
        assert_eq!(nav.highlighted, 1, "wraps before the start");
        assert_eq!(navigate(&mut nav, &list, Key::Home), Outcome::Handled);
        let Outcome::Apply(Change::Option { value, .. }) = navigate(&mut nav, &list, Key::Space)
        else {
            panic!("applies the highlighted choice");
        };
        assert_eq!(value, serde_json::Value::String("low".to_owned()));
        assert_eq!(nav.open, None);
        assert_eq!(
            nav.cursor,
            Some(list[0].key.clone()),
            "focus stays on the field"
        );
    }

    #[test]
    fn escape_closes_the_menu_first_then_the_picker() {
        let list = vec![select(
            ControlKey::FollowUp,
            &[("steer", true), ("queue", false)],
        )];
        let mut nav = Nav::default();
        navigate(&mut nav, &list, Key::Enter);
        assert!(nav.open.is_some());
        assert_eq!(navigate(&mut nav, &list, Key::Escape), Outcome::Handled);
        assert_eq!(nav.open, None);
        assert_eq!(
            navigate(&mut nav, &list, Key::Escape),
            Outcome::Dismiss,
            "the composer closes the picker"
        );
    }

    #[test]
    fn tab_walks_through_and_back_to_search() {
        let list = vec![
            select(ControlKey::FollowUp, &[("steer", true), ("queue", false)]),
            select(ControlKey::Permissions, &[("a", true), ("b", false)]),
        ];
        let mut nav = Nav {
            cursor: Some(ControlKey::Permissions),
            ..Nav::default()
        };
        assert_eq!(navigate(&mut nav, &list, Key::Tab), Outcome::Leave);
        nav.cursor = Some(ControlKey::FollowUp);
        assert_eq!(navigate(&mut nav, &list, Key::ShiftTab), Outcome::Leave);
    }

    #[test]
    fn a_switch_flips_on_enter() {
        let list = vec![Control {
            key: ControlKey::Option("ultracode".to_owned()),
            label: "Ultracode".to_owned(),
            kind: Kind::Switch {
                checked: false,
                toggle: Change::Option {
                    id: "ultracode".to_owned(),
                    value: serde_json::Value::Bool(true),
                },
            },
        }];
        let mut nav = Nav::default();
        assert!(matches!(
            navigate(&mut nav, &list, Key::Enter),
            Outcome::Apply(Change::Option { .. })
        ));
    }

    #[test]
    fn stale_state_is_dropped_when_the_controls_change() {
        let list = vec![select(
            ControlKey::FollowUp,
            &[("steer", true), ("queue", false)],
        )];
        let mut nav = Nav {
            open: Some(ControlKey::Option("gone".to_owned())),
            cursor: Some(ControlKey::Option("gone".to_owned())),
            highlighted: 5,
        };
        assert_eq!(navigate(&mut nav, &list, Key::Tab), Outcome::Handled);
        assert_eq!(nav.open, None);
        assert_eq!(nav.cursor, Some(ControlKey::FollowUp));
    }

    #[test]
    fn arrows_do_not_flip_a_focused_switch() {
        let list = vec![Control {
            key: ControlKey::Option("ultracode".to_owned()),
            label: "Ultracode".to_owned(),
            kind: Kind::Switch {
                checked: false,
                toggle: Change::FollowUp(FollowUpBehavior::Queue),
            },
        }];
        let mut nav = Nav::default();
        assert_eq!(navigate(&mut nav, &list, Key::Down), Outcome::Handled);
        assert_eq!(nav.open, None);
        assert!(matches!(
            navigate(&mut nav, &list, Key::Space),
            Outcome::Apply(_)
        ));
    }

    fn descriptor(
        id: &str,
        label: &str,
        choices: &[&str],
        reasoning: bool,
    ) -> ModelOptionDescriptor {
        ModelOptionDescriptor::Select {
            id: id.to_owned(),
            label: label.to_owned(),
            choices: choices
                .iter()
                .map(|c| SelectChoice {
                    id: (*c).to_owned(),
                    label: (*c).to_owned(),
                    description: None,
                    is_default: false,
                })
                .collect(),
            current_value: None,
            prompt_injected: Vec::new(),
            reasoning_role: reasoning,
        }
    }

    fn codex(descriptors: Vec<ModelOptionDescriptor>) -> ModelOption {
        ModelOption {
            instance_id: "codex".to_owned(),
            driver: "codex".to_owned(),
            provider_display_name: "Codex".to_owned(),
            slug: "gpt".to_owned(),
            name: "GPT".to_owned(),
            short_name: None,
            sub_provider: None,
            is_default: false,
            is_legacy: false,
            is_new: false,
            is_custom: false,
            has_capabilities: true,
            descriptors,
        }
    }

    #[test]
    fn model_options_drive_the_column() {
        let model = codex(vec![
            descriptor("reasoningEffort", "Reasoning", &["low", "high"], true),
            descriptor("serviceTier", "Service tier", &["standard", "fast"], false),
            // Fixed value in the checked-in fixture: not a setting.
            descriptor("cyberAccessProgram", "Cyber access", &["standard"], false),
            descriptor("verbosity", "Verbosity", &["low", "high"], false),
            ModelOptionDescriptor::Boolean {
                id: "ultracode".to_owned(),
                label: "Ultracode".to_owned(),
                current_value: None,
            },
        ]);
        let list = controls(&Inputs {
            traits: Some(&model),
            selected_options: None,
            runtime_mode: "full-access",
            runtime_options: &RUNTIME_MODES,
            follow_up: FollowUpBehavior::Steer,
        });
        let shown: Vec<_> = list
            .iter()
            .map(|c| (c.key.slug(), c.label.as_str()))
            .collect();
        assert_eq!(
            shown,
            vec![
                ("option.reasoningEffort".to_owned(), "Effort"),
                ("option.serviceTier".to_owned(), "Speed"),
                ("option.verbosity".to_owned(), "Verbosity"),
                ("follow-up".to_owned(), "Follow-up messages"),
                ("permissions".to_owned(), "Permissions"),
                ("option.ultracode".to_owned(), "Ultracode"),
            ],
            "Effort is always `Effort`; the single-choice extra is hidden; Ultracode is last"
        );
        // The standard Codex view is four selects; an adjustable extra and Ultracode add rows.
        let standard = codex(vec![
            descriptor("reasoningEffort", "Reasoning", &["low", "high"], true),
            descriptor("serviceTier", "Service tier", &["standard", "fast"], false),
            descriptor("cyberAccessProgram", "Cyber access", &["standard"], false),
        ]);
        let list = controls(&Inputs {
            traits: Some(&standard),
            selected_options: None,
            runtime_mode: "full-access",
            runtime_options: &RUNTIME_MODES,
            follow_up: FollowUpBehavior::Steer,
        });
        assert_eq!(list.len(), 4);
    }

    #[test]
    fn reveal_scrolls_the_least_that_shows_a_span() {
        // A 100px viewport over content scrolled 0: a span below it scrolls just enough.
        assert!((reveal((120.0, 150.0), 100.0, 0.0) - -50.0).abs() < f32::EPSILON);
        // Scrolled to 80, a span above the top scrolls back up to it.
        assert!((reveal((20.0, 50.0), 100.0, -80.0) - -20.0).abs() < f32::EPSILON);
        // Already visible, or unmeasured: no movement.
        assert!((reveal((20.0, 50.0), 100.0, 0.0)).abs() < f32::EPSILON);
        assert!((reveal((120.0, 150.0), 0.0, 0.0)).abs() < f32::EPSILON);
    }

    #[test]
    fn spans_follow_padding_gap_and_control_heights() {
        let list = vec![
            select(ControlKey::FollowUp, &[("a", true), ("b", false)]),
            Control {
                key: ControlKey::Option("ultracode".to_owned()),
                label: "Ultracode".to_owned(),
                kind: Kind::Switch {
                    checked: false,
                    toggle: Change::FollowUp(FollowUpBehavior::Steer),
                },
            },
        ];
        assert_eq!(spans(&list, false), vec![(12.0, 62.0), (72.0, 104.0)]);
        assert_eq!(spans(&list, true), vec![(8.0, 58.0), (68.0, 100.0)]);
    }

    #[test]
    fn a_menu_flips_above_when_it_does_not_fit_below() {
        let menu = menu_height(4, 800.0);
        assert_eq!(menu_side(100.0, 130.0, menu, 800.0), Side::Below);
        // Field near the window bottom with room above: flip.
        assert_eq!(menu_side(600.0, 630.0, menu, 700.0), Side::Above);
        // Little room both ways: stay below, the window snap keeps it inside.
        assert_eq!(menu_side(20.0, 50.0, 200.0, 120.0), Side::Below);
        // Unknown window: below.
        assert_eq!(menu_side(600.0, 630.0, menu, 0.0), Side::Below);
        assert!(
            (menu_max_height(300.0) - 120.0).abs() < 0.001,
            "40vh caps it"
        );
        assert!((menu_max_height(900.0) - 200.0).abs() < f32::EPSILON);
    }
}
