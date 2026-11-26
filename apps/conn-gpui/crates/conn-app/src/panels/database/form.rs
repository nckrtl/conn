//! Add/Edit connection form (`ConnectionForm` in Conn's `DatabasePanel.tsx`) and Conn's
//! `outline` / `ghost` `size="sm"` buttons shared with the Database empty state.

use crate::a11y::ConnA11yExt as _;
use conn_desktop::database::DatabaseDriver;
use conn_desktop::database::api::PanelConnection;
use conn_theme::{Appearance, Tokens};
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, ClickEvent, Context, Div, ElementId, Entity, FocusHandle,
    Focusable as _, FontWeight, IntoElement, MouseButton, ParentElement, SharedString, Stateful,
    Styled, Subscription, Window, deferred, div, point, px,
};

use super::super::chrome::{self, FloatingSurfaceExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX};
use super::super::color::to_hsla;
use super::super::header::{CONTROL_RADIUS_PX, superhero_icon};
use super::DatabasePanel;
use super::store::{default_port_placeholder, name_placeholder, parse_port_input};

/// Conn's `Button size="sm"` (`sm:h-7`, 28px; `text-sm`, 14px / 20px; `gap-1.5`, 6px;
/// `px-[calc(--spacing(2.5)-1px)]`, 9px; `rounded-(--control-radius)`, 6px).
const SM_BUTTON_HEIGHT_PX: f32 = 30.0;
const SM_BUTTON_PAD_X_PX: f32 = 12.0;
const SM_TEXT_PX: f32 = 14.0;
const SM_LINE_HEIGHT_PX: f32 = 20.0;

/// State for the open connection editor form (`editing` in `DatabasePanel.tsx`).
pub(crate) struct ConnectionFormState {
    pub(crate) draft: PanelConnection,
    name_input: Entity<InputState>,
    host_input: Entity<InputState>,
    port_input: Entity<InputState>,
    database_input: Entity<InputState>,
    username_input: Entity<InputState>,
    password_input: Entity<InputState>,
    /// Whether the Driver menu is open (the lab's `popover-open`).
    pub(super) driver_menu_open: bool,
    driver_focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ConnectionFormState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionFormState")
            .field("draft", &self.draft)
            .finish_non_exhaustive()
    }
}

impl ConnectionFormState {
    pub(crate) fn new(
        initial: PanelConnection,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) -> Self {
        let initial_name_placeholder = name_placeholder(&initial);
        let initial_port_placeholder = default_port_placeholder(initial.connection.driver);

        let name_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(initial_name_placeholder);
            state.set_value(initial.name.clone(), window, cx);
            state
        });
        let host_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("127.0.0.1");
            state.set_value(initial.connection.host.clone(), window, cx);
            state
        });
        let port_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(initial_port_placeholder);
            let value = initial
                .connection
                .port
                .map_or_else(String::new, |port| port.to_string());
            state.set_value(value, window, cx);
            state
        });
        let database_input = cx.new(|cx| {
            let placeholder = if initial.connection.driver == DatabaseDriver::Sqlite {
                "/Users/me/app/database/database.sqlite"
            } else {
                ""
            };
            let mut state = InputState::new(window, cx).placeholder(placeholder);
            state.set_value(initial.connection.database.clone(), window, cx);
            state
        });
        let username_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(initial.connection.username.clone(), window, cx);
            state
        });
        let password_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).masked(true);
            state.set_value(initial.connection.password.clone(), window, cx);
            state
        });

        let subscriptions = vec![
            subscribe_field(&name_input, FormField::Name, window, cx),
            subscribe_field(&host_input, FormField::Host, window, cx),
            subscribe_field(&port_input, FormField::Port, window, cx),
            subscribe_field(&database_input, FormField::Database, window, cx),
            subscribe_field(&username_input, FormField::Username, window, cx),
            subscribe_field(&password_input, FormField::Password, window, cx),
        ];

        Self {
            draft: initial,
            name_input,
            host_input,
            port_input,
            database_input,
            username_input,
            password_input,
            driver_menu_open: false,
            driver_focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    pub(crate) fn set_driver(
        &mut self,
        driver: DatabaseDriver,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) {
        if self.draft.connection.driver == driver {
            return;
        }
        self.draft.connection.driver = driver;
        // The lab clears the port with the driver (`port: null`): 3306 is wrong for Postgres.
        self.draft.connection.port = None;
        self.port_input
            .update(cx, |s, cx| s.set_value(String::new(), window, cx));
        let port_placeholder = default_port_placeholder(driver);
        self.port_input
            .update(cx, |s, cx| s.set_placeholder(port_placeholder, window, cx));
        let db_placeholder = if driver == DatabaseDriver::Sqlite {
            "/Users/me/app/database/database.sqlite"
        } else {
            ""
        };
        self.database_input
            .update(cx, |s, cx| s.set_placeholder(db_placeholder, window, cx));
        self.refresh_name_placeholder(window, cx);
        cx.notify();
    }

    pub(crate) fn refresh_name_placeholder(
        &self,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) {
        let placeholder = name_placeholder(&self.draft);
        self.name_input
            .update(cx, |s, cx| s.set_placeholder(placeholder, window, cx));
    }

    /// Puts the keyboard focus in the Name field, as a click on it would.
    #[cfg(test)]
    pub(super) fn focus_field_for_test(
        &self,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) {
        let handle = self.name_input.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
    }

    pub(crate) fn can_save(&self) -> bool {
        !self.draft.connection.database.trim().is_empty()
    }

    pub(crate) fn render(
        &self,
        tokens: &Tokens,
        window: &Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) -> AnyElement {
        let entity = cx.entity();
        let driver = self.draft.connection.driver;
        let sqlite = driver == DatabaseDriver::Sqlite;
        let can_save = self.can_save();

        let mut fields = v_flex()
            .id("db-connection-form")
            .test_support()
            .a11y_group("panel.database.connection-form", "Connection form")
            .w_full()
            .max_w(px(FORM_MAX_WIDTH_PX))
            .mx_auto()
            .p(px(FORM_PAD_PX))
            .gap(px(FIELD_GAP_PX))
            .child(labeled_field(
                "db-form-row-name",
                "Name",
                tokens,
                soft_text_input(&self.name_input, tokens, window, cx),
            ))
            .child(labeled_field(
                "db-form-row-driver",
                "Driver",
                tokens,
                self.driver_select(tokens, cx),
            ));

        if sqlite {
            fields = fields.child(labeled_field(
                "db-form-row-file",
                "File on this Mac",
                tokens,
                soft_text_input(&self.database_input, tokens, window, cx),
            ));
        } else {
            fields =
                fields
                    .child(
                        h_flex()
                            .w_full()
                            .gap(px(FIELD_GAP_PX))
                            .child(div().flex_1().min_w_0().child(labeled_field(
                                "db-form-row-host",
                                "Host",
                                tokens,
                                soft_text_input(&self.host_input, tokens, window, cx),
                            )))
                            .child(div().w(px(PORT_WIDTH_PX)).flex_shrink_0().child(
                                labeled_field(
                                    "db-form-row-port",
                                    "Port",
                                    tokens,
                                    soft_text_input(&self.port_input, tokens, window, cx),
                                ),
                            )),
                    )
                    .child(labeled_field(
                        "db-form-row-database",
                        "Database",
                        tokens,
                        soft_text_input(&self.database_input, tokens, window, cx),
                    ))
                    .child(labeled_field(
                        "db-form-row-username",
                        "Username",
                        tokens,
                        soft_text_input(&self.username_input, tokens, window, cx),
                    ))
                    .child(labeled_field(
                        "db-form-row-password",
                        "Password",
                        tokens,
                        soft_text_input(&self.password_input, tokens, window, cx),
                    ));
        }

        let entity_cancel = entity.clone();
        let entity_save = entity;
        // The 12px field gap plus the actions' 12px top margin (`.lab-db-form-actions`) is the
        // 24px between the last field and the buttons.
        fields = fields.child(
            h_flex()
                .w_full()
                .justify_end()
                .gap(px(8.0))
                .mt(px(ACTIONS_MARGIN_TOP_PX))
                .child(
                    ghost_sm_button("db-form-cancel", "Cancel", tokens, move |_, _, cx| {
                        entity_cancel.update(cx, |panel, cx| panel.cancel_editing(cx));
                    })
                    .test_support(),
                )
                .child(
                    outline_sm_button(
                        "db-form-save",
                        None,
                        "Save connection",
                        tokens,
                        !can_save,
                        move |_, window, cx| {
                            entity_save.update(cx, |panel, cx| panel.save_editing(window, cx));
                        },
                    )
                    .test_support(),
                ),
        );

        div()
            .id("db-connection-form-scroll")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .child(fields)
            .into_any_element()
    }

    /// The Driver dropdown (`.lab-db-select` and `.lab-db-driver-menu`): a full-width field with
    /// a chevron, and a menu as wide as the field with a check beside the current driver.
    fn driver_select(&self, tokens: &Tokens, cx: &mut Context<'_, DatabasePanel>) -> AnyElement {
        let entity = cx.entity();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let hover = to_hsla(tokens.shell_highlight);
        let driver = self.draft.connection.driver;
        let open = self.driver_menu_open;
        let hover_field = mix(tokens.shell_control, tokens.foreground, 0.06);

        let select = h_flex()
            .id("db-driver-select")
            .test_support()
            .a11y_button("panel.database.driver", driver.label())
            .aria_expanded(open)
            .track_focus(&self.driver_focus)
            .tab_stop(true)
            .w_full()
            .h(px(chrome::CONTROL_HEIGHT_PX))
            .px(px(FIELD_PAD_X_PX))
            .items_center()
            .justify_between()
            .rounded(px(FIELD_RADIUS_PX))
            .bg(to_hsla(tokens.shell_control))
            .border_1()
            .border_color(if open {
                focus_border(tokens)
            } else {
                to_hsla(tokens.shell_divider_header)
            })
            .when(open, |el| el.shadow(vec![focus_ring(tokens)]))
            .focus_visible(|s| {
                s.border_color(focus_border(tokens))
                    .shadow(vec![focus_ring(tokens)])
            })
            .cursor_pointer()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(fg)
            .hover(move |s| s.bg(hover_field))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |panel, cx| {
                        if let Some(form) = panel.editing.as_mut() {
                            form.driver_menu_open = !form.driver_menu_open;
                        }
                        cx.notify();
                    });
                }
            })
            .child(div().min_w_0().truncate().child(driver.label()))
            .child(superhero_icon("superhero/chevron-down.svg", 14.0, muted));

        let mut anchor = div().relative().w_full().child(select);
        if open {
            let mut menu = v_flex()
                .id("db-driver-menu")
                .test_support()
                .a11y_group("panel.database.driver-menu", "Driver")
                .w_full()
                .max_h(px(MENU_MAX_HEIGHT_PX))
                .overflow_y_scroll()
                .p(px(5.0))
                .rounded(px(FIELD_RADIUS_PX))
                .bg(to_hsla(tokens.popover))
                .border_1()
                .border_color(to_hsla(tokens.shell_divider_header))
                .shadow(vec![BoxShadow {
                    color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.22),
                    offset: point(px(0.0), px(8.0)),
                    blur_radius: px(22.0),
                    spread_radius: px(0.0),
                    inset: false,
                }])
                .text_color(fg)
                .floating_surface();
            for candidate in DatabaseDriver::ALL {
                let selected = candidate == driver;
                let entity = entity.clone();
                menu = menu.child(
                    h_flex()
                        .id(SharedString::from(format!(
                            "db-driver-{}",
                            candidate.label()
                        )))
                        .test_support()
                        .a11y_button(
                            format!(
                                "panel.database.driver.{}",
                                candidate.label().to_ascii_lowercase().replace(' ', "-")
                            ),
                            candidate.label(),
                        )
                        .aria_selected(selected)
                        .w_full()
                        .px(px(9.0))
                        .py(px(5.0))
                        .gap(px(6.0))
                        .items_center()
                        .rounded(px(4.0))
                        .cursor_pointer()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .hover(move |s| s.bg(hover))
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            cx.stop_propagation();
                            entity.update(cx, |panel, cx| {
                                if let Some(form) = panel.editing.as_mut() {
                                    form.driver_menu_open = false;
                                    form.set_driver(candidate, window, cx);
                                }
                                cx.notify();
                            });
                        })
                        .child(div().min_w_0().truncate().child(candidate.label()))
                        .when(selected, |row| {
                            row.child(
                                div()
                                    .id(SharedString::from(format!(
                                        "db-driver-check-{}",
                                        candidate.label()
                                    )))
                                    .test_support()
                                    .ml_auto()
                                    .child(superhero_icon("superhero/check.svg", 14.0, fg)),
                            )
                        }),
                );
            }
            anchor = anchor.child(
                deferred(
                    div()
                        .absolute()
                        .top(px(chrome::CONTROL_HEIGHT_PX + MENU_GAP_PX))
                        .left(px(0.0))
                        .w_full()
                        .child(menu),
                )
                .with_priority(2),
            );
        }
        anchor.into_any_element()
    }
}

/// `.lab-db-form`: at most 420px wide, centred, 16px padding, 12px between fields.
const FORM_MAX_WIDTH_PX: f32 = 420.0;
const FORM_PAD_PX: f32 = 16.0;
const FIELD_GAP_PX: f32 = 12.0;
const ACTIONS_MARGIN_TOP_PX: f32 = 12.0;
/// `.lab-db-address`: `minmax(0, 1fr) 72px`.
const PORT_WIDTH_PX: f32 = 72.0;
/// Fields and the dropdown: `border-radius: 8px`, `padding: 4px 8px`.
const FIELD_RADIUS_PX: f32 = 8.0;
const FIELD_PAD_X_PX: f32 = 8.0;
/// `.lab-db-driver-menu`: `margin-top: 4px`, and the menu's `max-height`.
const MENU_GAP_PX: f32 = 4.0;
const MENU_MAX_HEIGHT_PX: f32 = 320.0;

/// `color-mix(in srgb, <base> <1-ratio>, <over> <ratio>)` on opaque colours.
fn mix(base: conn_theme::Rgba, over: conn_theme::Rgba, ratio: f32) -> gpui_kit::Hsla {
    to_hsla(conn_theme::Rgba {
        r: base.r + (over.r - base.r) * ratio,
        g: base.g + (over.g - base.g) * ratio,
        b: base.b + (over.b - base.b) * ratio,
        a: 1.0,
    })
}

/// Focused border: the foreground at 40% (`color-mix(in srgb, var(--ink) 40%, transparent)`).
fn focus_border(tokens: &Tokens) -> gpui_kit::Hsla {
    chrome::alpha(tokens.foreground, 0.4)
}

/// Focus ring: 2px outside the border, the foreground at 14% (`0 0 0 2px`, Tailwind `ring-2`).
fn focus_ring(tokens: &Tokens) -> BoxShadow {
    BoxShadow {
        color: chrome::alpha(tokens.foreground, 0.14),
        offset: point(px(0.0), px(0.0)),
        blur_radius: px(0.0),
        spread_radius: px(2.0),
        inset: false,
    }
}

#[derive(Clone, Copy)]
enum FormField {
    Name,
    Host,
    Port,
    Database,
    Username,
    Password,
}

fn subscribe_field(
    input: &Entity<InputState>,
    field: FormField,
    window: &Window,
    cx: &mut Context<'_, DatabasePanel>,
) -> Subscription {
    cx.subscribe_in(
        input,
        window,
        move |panel, input: &Entity<InputState>, event: &InputEvent, window, cx| match event {
            InputEvent::Change => {
                let value = input.read(cx).value().to_string();
                let Some(form) = &mut panel.editing else {
                    return;
                };
                let mut target_changed = false;
                match field {
                    FormField::Name => form.draft.name = value,
                    FormField::Host => {
                        form.draft.connection.host = value;
                        target_changed = true;
                    }
                    FormField::Port => {
                        form.draft.connection.port = parse_port_input(&value);
                        target_changed = true;
                    }
                    FormField::Database => {
                        form.draft.connection.database = value;
                        target_changed = true;
                    }
                    FormField::Username => form.draft.connection.username = value,
                    FormField::Password => form.draft.connection.password = value,
                }
                if target_changed {
                    form.refresh_name_placeholder(window, cx);
                }
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {
                if panel
                    .editing
                    .as_ref()
                    .is_some_and(ConnectionFormState::can_save)
                {
                    panel.save_editing(window, cx);
                }
            }
            InputEvent::Focus | InputEvent::Blur => {}
        },
    )
}

fn labeled_field(
    id: &'static str,
    label: &'static str,
    tokens: &Tokens,
    control: impl IntoElement,
) -> impl IntoElement {
    v_flex()
        .id(id)
        .test_support()
        .w_full()
        .gap(px(4.0))
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(label),
        )
        .child(control)
}

/// `.lab-db-form input`: `h-8 w-full rounded-lg border bg-raised px-2`. Focus brightens the
/// border to the foreground at 40% and adds a 2px ring at 14%.
fn soft_text_input(
    state: &Entity<InputState>,
    tokens: &Tokens,
    window: &Window,
    cx: &App,
) -> impl IntoElement {
    let focused = state.read(cx).focus_handle(cx).contains_focused(window, cx);
    h_flex()
        .w_full()
        .h(px(chrome::CONTROL_HEIGHT_PX))
        .items_center()
        .rounded(px(FIELD_RADIUS_PX))
        .bg(to_hsla(tokens.shell_control))
        .border_1()
        .border_color(if focused {
            focus_border(tokens)
        } else {
            to_hsla(tokens.shell_divider_header)
        })
        .when(focused, |el| el.shadow(vec![focus_ring(tokens)]))
        // `Input` brings its own ~10px inset, so the text lands 8px in like the dropdown's.
        .text_size(px(UI_TEXT_PX))
        .text_color(to_hsla(tokens.foreground))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(state)
                    .appearance(false)
                    .text_size(px(UI_TEXT_PX)),
            ),
        )
}

/// The AX id of a Database control from its element id: `panel.database.<slug>`.
fn ax_id_for(id: &ElementId) -> SharedString {
    let raw = match id {
        ElementId::Name(name) => name.to_string(),
        other => format!("{other:?}"),
    };
    let mut slug = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    SharedString::from(format!("panel.database.{}", slug.trim_matches('-')))
}

/// Conn's `Button variant="ghost" size="sm"`.
pub(crate) fn ghost_sm_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let hover = to_hsla(tokens.shell_highlight);
    h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(SM_BUTTON_PAD_X_PX))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .cursor_pointer()
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground))
        .hover(move |s| s.bg(hover))
        .on_click(on_click)
        .child(label)
}

/// Conn's `Button variant="outline" size="sm"` (used by `+ Add connection` and `Save connection`).
pub(crate) fn outline_sm_button(
    id: impl Into<ElementId>,
    icon_path: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let label: SharedString = label.into();
    let ax_id = ax_id_for(&id);
    let (bg, hover_bg) = match tokens.appearance {
        Appearance::Light => (
            to_hsla(tokens.popover),
            chrome::alpha(tokens.shell_highlight, 0.5),
        ),
        Appearance::Dark => (
            chrome::alpha(tokens.input, 0.32),
            chrome::alpha(tokens.input, 0.64),
        ),
    };
    let shadow = match tokens.appearance {
        Appearance::Light => Some(BoxShadow {
            color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.05),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(2.0),
            spread_radius: px(0.0),
            inset: false,
        }),
        Appearance::Dark => None,
    };

    let mut button = h_flex()
        .id(id)
        .a11y_button(ax_id, label.clone())
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(SM_BUTTON_PAD_X_PX))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground));

    if let Some(shadow) = shadow
        && !disabled
    {
        button = button.shadow(vec![shadow]);
    }
    if let Some(path) = icon_path {
        button = button.child(superhero_icon(path, 16.0, to_hsla(tokens.muted_foreground)));
    }
    button = button.child(label);

    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(on_click)
    }
}
