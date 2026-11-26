//! A floating popup must not let the elements behind it show hover.
//!
//! GPUI hands hover to every element under the pointer unless a hitbox above blocks the mouse.
//! These tests open a popup over a full-window hoverable probe, move the pointer onto a popup
//! row that overlaps the probe, and check that only the row is hovered.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use conn_state::RightPanelTab;
use conn_theme::Tokens;
use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, Point, Render, StatefulInteractiveElement as _, Styled as _,
    TestAppContext, TestSupportExt as _, Window, WindowBounds, WindowOptions, deferred, div, hsla,
    px, size,
};

use crate::panels::chrome::FloatingSurfaceExt as _;
use crate::panels::header::render_add_panel_menu;
use crate::theme::apply_kit_theme;

#[derive(Clone, Copy)]
enum Popup {
    /// A bare card with no occlusion: the control that shows the probe sees the bug.
    Plain,
    /// A card that uses [`FloatingSurfaceExt::floating_surface`].
    Floating,
    /// The Add panel (`+`) menu as `panels::header` renders it.
    AddPanelMenu,
}

#[derive(Default)]
struct Flags {
    /// The full-window element the popup covers.
    behind: Cell<bool>,
    /// The popup row under the pointer (`Plain` and `Floating` only).
    row: Cell<bool>,
    /// Tabs picked from the Add panel menu.
    picked: RefCell<Vec<RightPanelTab>>,
}

struct Harness {
    popup: Popup,
    tokens: Tokens,
    flags: Rc<Flags>,
}

impl Render for Harness {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
        let behind = self.flags.clone();
        let probe = div()
            .id("probe-behind-popup")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .on_hover(move |hovered, _, _| behind.behind.set(*hovered));

        let popup = match self.popup {
            Popup::Plain | Popup::Floating => {
                let row_flags = self.flags.clone();
                let row = div()
                    .id("popup-row")
                    .test_support()
                    .w_full()
                    .h(px(40.0))
                    .on_hover(move |hovered, _, _| row_flags.row.set(*hovered));
                let card = div()
                    .id("popup-card")
                    .w(px(200.0))
                    .h(px(120.0))
                    .bg(hsla(0.6, 0.5, 0.5, 1.0))
                    .child(row);
                let card = if matches!(self.popup, Popup::Floating) {
                    card.floating_surface().into_any_element()
                } else {
                    card.into_any_element()
                };
                div()
                    .absolute()
                    .top(px(40.0))
                    .left(px(40.0))
                    .child(deferred(card).with_priority(1))
                    .into_any_element()
            }
            Popup::AddPanelMenu => {
                let flags = self.flags.clone();
                let on_add_tab: Rc<dyn Fn(RightPanelTab, &mut Window, &mut App)> =
                    Rc::new(move |tab, _, _| flags.picked.borrow_mut().push(tab));
                // The menu positions itself under a 32px anchor, as the `+` button does.
                div()
                    .absolute()
                    .top(px(40.0))
                    .left(px(40.0))
                    .size(px(32.0))
                    .child(render_add_panel_menu(
                        &self.tokens,
                        &RightPanelTab::MENU_ORDER,
                        true,
                        on_add_tab,
                    ))
                    .into_any_element()
            }
        };

        div().size_full().relative().child(probe).child(popup)
    }
}

fn mount(cx: &mut TestAppContext, popup: Popup) -> (AnyWindowHandle, Rc<Flags>) {
    let flags = Rc::new(Flags::default());
    let harness_flags = flags.clone();
    let window = cx.update(|cx| {
        gpui_kit::init(cx);
        let Some(theme) = conn_theme::theme_by_id("dark-ocean") else {
            panic!("dark-ocean must be a built-in theme");
        };
        let tokens = Tokens::derive(&theme);
        apply_kit_theme(&tokens, cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                Point::default(),
                size(px(800.0), px(600.0)),
            ))),
            ..Default::default()
        };
        let Ok((window, _view)) = gpui_kit::open_window(options, cx, move |_, cx| {
            cx.new(|_| Harness {
                popup,
                tokens,
                flags: harness_flags,
            })
        }) else {
            panic!("failed to open headless test window");
        };
        window
    });
    (window, flags)
}

fn move_pointer_to(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    at: impl FnOnce(&mut Window) -> Point<gpui_kit::Pixels>,
) {
    let moved = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let at = at(window);
        window.pointer_move(at, None, cx);
        window.render_frame(cx);
    });
    assert!(moved.is_ok(), "the harness window is open");
}

#[gpui_kit::test]
fn a_popup_without_occlusion_lets_hover_reach_the_element_behind(cx: &mut TestAppContext) {
    // The control: this is the bug, so the probe must see it.
    let (window, flags) = mount(cx, Popup::Plain);
    move_pointer_to(cx, window, |w| w.find("popup-row").bounds().center());
    assert!(flags.row.get(), "the row under the pointer is hovered");
    assert!(
        flags.behind.get(),
        "without occlusion the element behind is hovered too"
    );
}

#[gpui_kit::test]
fn floating_surface_keeps_hover_off_the_element_behind(cx: &mut TestAppContext) {
    let (window, flags) = mount(cx, Popup::Floating);

    move_pointer_to(cx, window, |w| w.find("popup-row").bounds().center());
    assert!(flags.row.get(), "the popup row is hovered");
    assert!(
        !flags.behind.get(),
        "the element behind the popup is not hovered"
    );

    // Off the popup, the same probe is hovered again: the probe works, and the popup only
    // blocks what lies under its own bounds.
    move_pointer_to(cx, window, |_| Point {
        x: px(700.0),
        y: px(500.0),
    });
    assert!(!flags.row.get(), "the row is no longer hovered");
    assert!(flags.behind.get(), "the element behind is hovered again");
}

#[gpui_kit::test]
fn add_panel_menu_hover_does_not_reach_the_element_behind(cx: &mut TestAppContext) {
    let (window, flags) = mount(cx, Popup::AddPanelMenu);

    // Off the menu first: the probe is hovered, so the probe works.
    move_pointer_to(cx, window, |_| Point {
        x: px(700.0),
        y: px(500.0),
    });
    assert!(
        flags.behind.get(),
        "the element behind is hovered off the menu"
    );

    // Onto the `Diff` row, which overlaps the probe.
    move_pointer_to(cx, window, |w| {
        w.find("right-panel-add-Diff").bounds().center()
    });
    assert!(
        !flags.behind.get(),
        "hovering the Diff menu row must not hover the element behind the menu"
    );
    // The pointer is on the menu, not just blocked: a click lands on the Diff row.
    let clicked = cx.update_window(window, |_, window, cx| {
        window.click("right-panel-add-Diff", cx);
    });
    assert!(clicked.is_ok(), "the harness window is open");
    assert_eq!(*flags.picked.borrow(), vec![RightPanelTab::Diff]);
}
