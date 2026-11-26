//! Headless tests of the right-click menu of message text: a real `ConnApp` window, real pointer
//! and key events, and the real clipboard of the test platform.

use conn_state::{ItemStatus, ThreadState, TimelineEntry};
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, MouseButton, Pixels, Point, Role,
    TestAppContext, Window, point, px,
};

use crate::app::ConnApp;
use crate::ui_tests::{kitchen_sink_shell, mount_app};

const USER_TEXT: &str = "Please review the plan carefully before we ship it";
const ANSWER: &str = "The plan looks good and is ready to ship.";

fn thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![
        TimelineEntry::User {
            id: "u-1".to_owned(),
            text: USER_TEXT.to_owned(),
            created_by_agent: false,
            sender: None,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: Some("run-1".to_owned()),
        },
        TimelineEntry::Assistant {
            id: "answer-1".to_owned(),
            markdown: ANSWER.to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
    ];
    thread
}

fn open(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), thread(), cx);
        });
    });
    frames(cx, window);
    (window, app)
}

fn frames(cx: &mut TestAppContext, window: AnyWindowHandle) {
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, window, cx| window.render_frame(cx));
        cx.run_until_parked();
    }
}

/// Runs `act` on the window, then draws.
fn act(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    act: impl FnOnce(&mut Window, &mut gpui_kit::App),
) {
    let _ = cx.update_window(window, |_, window, cx| act(window, cx));
    frames(cx, window);
}

fn bounds_of(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> Bounds<Pixels> {
    cx.update_window(window, |_, window, _| window.find_by_label(label).bounds())
        .expect("the window is open")
}

/// The bounds of the text of the user's message and of the assistant's answer.
fn user_bounds(cx: &mut TestAppContext, window: AnyWindowHandle) -> Bounds<Pixels> {
    bounds_of(cx, window, USER_TEXT)
}

fn answer_bounds(cx: &mut TestAppContext, window: AnyWindowHandle) -> Bounds<Pixels> {
    bounds_of(cx, window, "Assistant message")
}

/// A point on the first line of `bounds`, `fraction` of the way across.
fn on_line(bounds: Bounds<Pixels>, fraction: f32) -> Point<Pixels> {
    point(
        bounds.origin.x + bounds.size.width * fraction,
        bounds.origin.y + px(10.0),
    )
}

fn select(cx: &mut TestAppContext, window: AnyWindowHandle, bounds: Bounds<Pixels>) {
    let from = on_line(bounds, 0.02);
    let to = on_line(bounds, 0.4);
    act(cx, window, |window, cx| window.drag(from, to, cx));
}

fn right_click(cx: &mut TestAppContext, window: AnyWindowHandle, at: Point<Pixels>) {
    act(cx, window, |window, cx| {
        window.pointer_down(at, MouseButton::Right, cx);
        window.pointer_up(at, MouseButton::Right, cx);
    });
}

fn selected(cx: &mut TestAppContext, window: AnyWindowHandle) -> String {
    cx.update_window(window, |_, window, cx| {
        gpui_kit::base::TextSelection::selected_text(window, cx)
    })
    .unwrap_or_default()
}

fn menu_open(cx: &mut TestAppContext, window: AnyWindowHandle) -> bool {
    cx.update_window(window, |_, window, _| {
        window.try_find_by_label("Message menu").is_some()
    })
    .unwrap_or(false)
}

fn menu_rows(cx: &mut TestAppContext, window: AnyWindowHandle) -> Vec<String> {
    cx.update_window(window, |_, window, _| {
        window
            .find_all_by_role(Role::MenuItem)
            .iter()
            .filter_map(|row| row.label().map(str::to_owned))
            .collect()
    })
    .unwrap_or_default()
}

fn click_row(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) {
    let center = cx
        .update_window(window, |_, window, _| {
            window
                .find_all_by_role(Role::MenuItem)
                .iter()
                .find(|row| row.label() == Some(label))
                .map(|row| row.bounds().center())
        })
        .ok()
        .flatten();
    let Some(center) = center else {
        panic!("no `{label}` row in the menu");
    };
    act(cx, window, |window, cx| {
        window.pointer_down(center, MouseButton::Left, cx);
        window.pointer_up(center, MouseButton::Left, cx);
    });
}

fn clipboard(cx: &mut TestAppContext) -> Option<String> {
    cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()))
}

fn clear_clipboard(cx: &mut TestAppContext) {
    cx.update(|cx| cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(String::new())));
}

#[gpui_kit::test]
fn right_click_on_a_selection_opens_a_menu_with_copy_and_its_shortcut(cx: &mut TestAppContext) {
    for assistant in [false, true] {
        let (window, _) = open(cx);
        let bounds = if assistant {
            answer_bounds(cx, window)
        } else {
            user_bounds(cx, window)
        };
        select(cx, window, bounds);
        let text = selected(cx, window);
        assert!(!text.is_empty(), "the drag selected something");
        assert!(!menu_open(cx, window));
        right_click(cx, window, on_line(bounds, 0.2));
        assert!(menu_open(cx, window), "assistant: {assistant}");
        assert_eq!(menu_rows(cx, window), ["Copy"], "assistant: {assistant}");
        assert_eq!(
            super::link_menu::LinkMenuAction::CopySelection.label(),
            "Copy"
        );
    }
}

#[gpui_kit::test]
fn copy_writes_what_cmd_c_copies(cx: &mut TestAppContext) {
    for assistant in [false, true] {
        let (window, _) = open(cx);
        let bounds = if assistant {
            answer_bounds(cx, window)
        } else {
            user_bounds(cx, window)
        };
        select(cx, window, bounds);
        clear_clipboard(cx);
        act(cx, window, |window, cx| window.key_down("cmd-c", false, cx));
        let by_shortcut = clipboard(cx).unwrap_or_default();
        assert!(!by_shortcut.is_empty());

        clear_clipboard(cx);
        right_click(cx, window, on_line(bounds, 0.2));
        click_row(cx, window, "Copy");
        assert_eq!(
            clipboard(cx).as_deref(),
            Some(by_shortcut.as_str()),
            "assistant: {assistant}: the Copy row copies what Cmd+C copies"
        );
        assert!(!menu_open(cx, window), "a pick closes the menu");
    }
}

#[gpui_kit::test]
fn with_no_selection_copy_message_copies_the_whole_message(cx: &mut TestAppContext) {
    let (window, _) = open(cx);
    let bounds = user_bounds(cx, window);
    right_click(cx, window, on_line(bounds, 0.3));
    assert_eq!(menu_rows(cx, window), ["Copy message"]);
    clear_clipboard(cx);
    click_row(cx, window, "Copy message");
    assert_eq!(clipboard(cx).as_deref(), Some(USER_TEXT));

    let bounds = answer_bounds(cx, window);
    right_click(cx, window, on_line(bounds, 0.3));
    clear_clipboard(cx);
    click_row(cx, window, "Copy message");
    assert_eq!(clipboard(cx).as_deref(), Some(ANSWER));
}

#[gpui_kit::test]
fn escape_closes_the_menu_and_keeps_the_selection(cx: &mut TestAppContext) {
    let (window, _) = open(cx);
    let bounds = user_bounds(cx, window);
    select(cx, window, bounds);
    let text = selected(cx, window);
    right_click(cx, window, on_line(bounds, 0.2));
    assert!(menu_open(cx, window));
    act(cx, window, |window, cx| {
        window.key_down("escape", false, cx)
    });
    assert!(!menu_open(cx, window));
    assert_eq!(selected(cx, window), text, "Escape only closed the menu");
}

#[gpui_kit::test]
fn a_click_outside_closes_the_menu(cx: &mut TestAppContext) {
    let (window, _) = open(cx);
    let bounds = user_bounds(cx, window);
    right_click(cx, window, on_line(bounds, 0.3));
    assert!(menu_open(cx, window));
    let outside = point(px(700.0), px(850.0));
    act(cx, window, |window, cx| {
        window.pointer_down(outside, MouseButton::Left, cx);
        window.pointer_up(outside, MouseButton::Left, cx);
    });
    assert!(!menu_open(cx, window));
}

#[gpui_kit::test]
fn the_selection_survives_a_right_click_inside_it(cx: &mut TestAppContext) {
    let (window, _) = open(cx);
    let bounds = user_bounds(cx, window);
    select(cx, window, bounds);
    let text = selected(cx, window);
    assert!(!text.is_empty());
    right_click(cx, window, on_line(bounds, 0.2));
    assert_eq!(selected(cx, window), text);
    click_row(cx, window, "Copy");
    assert_eq!(clipboard(cx).as_deref(), Some(text.as_str()));
}

#[gpui_kit::test]
fn right_click_on_another_message_drops_the_selection_and_offers_that_message(
    cx: &mut TestAppContext,
) {
    let (window, _) = open(cx);
    let user = user_bounds(cx, window);
    select(cx, window, user);
    assert!(!selected(cx, window).is_empty());
    let answer = answer_bounds(cx, window);
    right_click(cx, window, on_line(answer, 0.3));
    assert_eq!(menu_rows(cx, window), ["Copy message"]);
    assert!(selected(cx, window).is_empty(), "the old selection is gone");
}

#[gpui_kit::test]
fn the_menu_blocks_clicks_to_what_is_behind_it(cx: &mut TestAppContext) {
    let (window, _) = open(cx);
    let bounds = user_bounds(cx, window);
    right_click(cx, window, on_line(bounds, 0.3));
    // A right-click on the menu itself opens nothing else, and keeps the menu.
    let row = cx
        .update_window(window, |_, window, _| {
            window
                .find_all_by_role(Role::MenuItem)
                .first()
                .map(|row| row.bounds().center())
        })
        .ok()
        .flatten()
        .expect("a row");
    right_click(cx, window, row);
    assert!(menu_open(cx, window));
    assert_eq!(menu_rows(cx, window).len(), 1);
}
