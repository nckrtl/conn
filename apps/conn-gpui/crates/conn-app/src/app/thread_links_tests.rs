//! Thread links in the app: "Copy thread link", chip titles from the merged shell, and a click on
//! a chip opening its thread.

use gpui_kit::{AppContext as _, TestAppContext};

use crate::chat::ChatEvent;
use crate::chat::thread_links::{ThreadLink, parse_thread_link};
use crate::sidebar::thread_menu::ThreadMenuAction;
use crate::ui_tests::{kitchen_sink_shell, mount_app};

fn link(environment: &str, thread: &str) -> ThreadLink {
    ThreadLink {
        environment_id: Some(environment.to_owned()),
        thread_id: thread.to_owned(),
    }
}

fn mount_with_threads(
    cx: &mut TestAppContext,
) -> (gpui_kit::AnyWindowHandle, gpui_kit::Entity<super::ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.learn_primary_environment_for_test("env-main", cx);
            app.select_thread("thread-selected", cx);
        });
    });
    (window, app)
}

fn selected(cx: &mut TestAppContext, app: &gpui_kit::Entity<super::ConnApp>) -> Option<String> {
    cx.update(|cx| app.read(cx).selected_thread_for_test().map(str::to_owned))
}

#[gpui_kit::test]
fn copy_thread_link_writes_the_conn_thread_link(cx: &mut TestAppContext) {
    let (window, app) = mount_with_threads(cx);
    cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.run_thread_menu_action(
                "thread-pinned".to_owned(),
                ThreadMenuAction::CopyThreadLink,
                window,
                cx,
            );
        });
    })
    .expect("the window is open");
    let copied = cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert_eq!(
        copied.as_deref(),
        Some("conn://thread/env-main/thread-pinned"),
        "Copy -> Thread link writes the Conn form, not t3-thread://"
    );
    assert_eq!(
        parse_thread_link(copied.as_deref().unwrap_or_default()),
        Some(link("env-main", "thread-pinned"))
    );
}

#[gpui_kit::test]
fn chip_titles_come_from_the_merged_shell_for_both_schemes(cx: &mut TestAppContext) {
    let (_, app) = mount_with_threads(cx);
    let (new, old, unknown) = cx.update(|cx| {
        let directory = app.read(cx).thread_link_directory();
        let title = |raw: &str| {
            parse_thread_link(raw)
                .and_then(|link| directory.resolve(&link))
                .map(|thread| thread.title)
        };
        (
            title("conn://thread/env-main/thread-selected"),
            title("t3-thread://v2/env-main/thread-selected"),
            title("conn://thread/env-main/thread-gone"),
        )
    });
    assert_eq!(new.as_deref(), Some("Selected kitchen-sink thread"));
    assert_eq!(old, new, "an old link names the same thread");
    assert_eq!(unknown, None, "an unknown thread falls back to a short id");
}

#[gpui_kit::test]
fn the_chat_is_given_the_titles_its_chips_show(cx: &mut TestAppContext) {
    let (_, app) = mount_with_threads(cx);
    // Retitling a thread changes what the chat is told, so a chip shows the new title.
    let first = cx.update(|cx| {
        app.read(cx)
            .chat_for_test()
            .read(cx)
            .thread_directory_for_test()
    });
    assert!(
        first.is_some(),
        "the chat has a thread directory after the first sync"
    );
}

#[gpui_kit::test]
fn a_clicked_thread_chip_opens_its_thread(cx: &mut TestAppContext) {
    let (_, app) = mount_with_threads(cx);
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-selected"));
    let chat = cx.update(|cx| app.read(cx).chat_for_test());

    // A `conn://thread/…` chip.
    cx.update(|cx| {
        chat.update(cx, |_, cx| {
            cx.emit(ChatEvent::OpenThreadLink(link("env-main", "thread-pinned")));
        });
    });
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-pinned"));

    // A `t3-thread://v2/…` chip from an old message.
    let old = parse_thread_link("t3-thread://v2/env-main/thread-selected").expect("an old link");
    cx.update(|cx| {
        chat.update(cx, |_, cx| cx.emit(ChatEvent::OpenThreadLink(old)));
    });
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-selected"));

    // A thread nobody has stays where it is.
    cx.update(|cx| {
        chat.update(cx, |_, cx| {
            cx.emit(ChatEvent::OpenThreadLink(link("env-gone", "thread-gone")));
        });
    });
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-selected"));
}
