//! Thread links in the app: "Copy thread link", chip titles from the merged shell, and a click on
//! a chip opening its thread.

use gpui_kit::{AppContext as _, TestAppContext};

use super::thread_links::LinkEnvironment;
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

/// The config a server that calls itself `environment_id` reports (a recorded `snapshot`).
fn config_of(environment_id: &str) -> std::sync::Arc<conn_state::providers::ServerConfigState> {
    let mut snapshot: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
    ))
    .expect("the server config fixture is JSON");
    snapshot["config"]["environment"]["environmentId"] = serde_json::json!(environment_id);
    let event: conn_contract::ServerConfigStreamEvent =
        conn_contract::from_json(snapshot).expect("the server config fixture decodes");
    let mut state = conn_state::providers::ServerConfigState::new();
    state.apply(event);
    std::sync::Arc::new(state)
}

fn copied_link(
    cx: &mut TestAppContext,
    window: gpui_kit::AnyWindowHandle,
    app: &gpui_kit::Entity<super::ConnApp>,
    thread_id: &str,
) -> Option<String> {
    cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.run_thread_menu_action(
                thread_id.to_owned(),
                ThreadMenuAction::CopyThreadLink,
                window,
                cx,
            );
        });
    })
    .expect("the window is open");
    cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()))
}

#[gpui_kit::test]
fn copy_thread_link_on_a_linked_thread_names_its_servers_own_id(cx: &mut TestAppContext) {
    let (window, app) = mount_with_threads(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                crate::ui_tests::linked_mini_shell("/work/mini", "Mini thread"),
                cx,
            );
        });
    });

    // Until the linked server reports its config, the Orbit target id stands in.
    assert_eq!(
        copied_link(cx, window, &app, "thread-mini").as_deref(),
        Some("conn://thread/mini/thread-mini")
    );

    // The server's own id wins once known, as in the links that server writes. The Orbit target
    // id (`mini`) differs from it.
    cx.update(|cx| {
        app.update(cx, |app, _| {
            app.set_linked_config_for_test("mini", config_of("desc-mini"));
        });
    });
    let copied = copied_link(cx, window, &app, "thread-mini");
    assert_eq!(
        copied.as_deref(),
        Some("conn://thread/desc-mini/thread-mini")
    );

    // That link still opens the thread, though the shell lists it under the target id.
    let parsed = parse_thread_link(copied.as_deref().unwrap_or_default()).expect("a thread link");
    let chat = cx.update(|cx| app.read(cx).chat_for_test());
    cx.update(|cx| {
        chat.update(cx, |_, cx| cx.emit(ChatEvent::OpenThreadLink(parsed)));
    });
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-mini"));

    // A primary thread still names the primary server.
    assert_eq!(
        copied_link(cx, window, &app, "thread-pinned").as_deref(),
        Some("conn://thread/env-main/thread-pinned")
    );
}

/// Mounts the app with a linked `mini` environment whose server reports the id `desc-mini`.
fn mount_with_linked_mini(
    cx: &mut TestAppContext,
) -> (gpui_kit::AnyWindowHandle, gpui_kit::Entity<super::ConnApp>) {
    let (window, app) = mount_with_threads(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                crate::ui_tests::linked_mini_shell("/work/mini", "Mini thread"),
                cx,
            );
            app.set_linked_config_for_test("mini", config_of("desc-mini"));
        });
    });
    (window, app)
}

fn open_link(
    cx: &mut TestAppContext,
    app: &gpui_kit::Entity<super::ConnApp>,
    environment: &str,
    thread: &str,
) -> bool {
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.open_thread_link(&link(environment, thread), cx)
        })
    })
}

#[gpui_kit::test]
fn a_link_environment_id_names_a_target_by_either_id(cx: &mut TestAppContext) {
    let (_, app) = mount_with_linked_mini(cx);
    let name =
        |cx: &mut TestAppContext, id: &str| cx.update(|cx| app.read(cx).link_environment(id));
    let mini = LinkEnvironment::Target("mini".to_owned());
    // The Orbit target id and the id the server reports for itself.
    assert_eq!(name(cx, "mini"), mini);
    assert_eq!(name(cx, "desc-mini"), mini);
    // The primary server, by the id its config names.
    assert_eq!(name(cx, "env-main"), LinkEnvironment::Primary);
    // Nothing goes by this id.
    assert_eq!(name(cx, "env-gone"), LinkEnvironment::Unknown);
}

/// The primary server is usually an Orbit target too. Its ids still name the primary, so a
/// message the primary's thread sent to another environment keeps `Open thread`, and opening it
/// selects the primary's thread rather than connecting to the target.
#[gpui_kit::test]
fn the_primary_listed_in_orbit_still_names_the_primary(cx: &mut TestAppContext) {
    use conn_desktop::orbit::{OrbitFleet, OrbitServerTarget, OrbitTargetKind, OrbitTargetStatus};

    let (_, app) = mount_with_linked_mini(cx);
    let target = |id: &str| OrbitServerTarget {
        server_id: id.to_owned(),
        label: id.to_owned(),
        url: format!("https://{id}.example.test"),
        server_version: None,
        registered_by: None,
        status: OrbitTargetStatus::Registered,
        cleanup_pending: false,
        kind: OrbitTargetKind::Node {
            node_name: id.to_owned(),
            roles: Vec::new(),
            is_primary_agent: false,
        },
    };
    cx.update(|cx| {
        app.update(cx, |app, _| {
            app.set_fleet_for_test(OrbitFleet::from_targets(
                vec![target("env-main"), target("mini")],
                None,
            ));
        });
    });
    assert_eq!(
        cx.update(|cx| app.read(cx).link_environment("env-main")),
        LinkEnvironment::Primary
    );

    let sender = conn_state::AgentMessageSender::Linked {
        environment_id: "env-main".to_owned(),
        thread_id: "thread-pinned".to_owned(),
        title: "Delivered title".to_owned(),
    };
    let view = cx.update(|cx| app.read(cx).agent_sender_view(&sender, Some("thread-mini")));
    assert!(view.can_open, "the primary's thread can open");
    assert_eq!(view.title, "Pinned active thread");
    cx.update(|cx| app.update(cx, |app, cx| app.open_agent_sender(&sender, cx)));
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-pinned"));
}

#[gpui_kit::test]
fn a_link_opens_by_server_id_target_id_or_primary_and_unknown_fails_cleanly(
    cx: &mut TestAppContext,
) {
    let (_, app) = mount_with_linked_mini(cx);

    // The linked server's own id (what "Copy thread link" writes).
    assert!(open_link(cx, &app, "desc-mini", "thread-mini"));
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-mini"));

    // Back to the primary, then the Orbit target id.
    assert!(open_link(cx, &app, "env-main", "thread-pinned"));
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-pinned"));
    assert!(open_link(cx, &app, "mini", "thread-mini"));
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-mini"));

    // An id nothing goes by, and a thread nobody has: no open, no change.
    assert!(!open_link(cx, &app, "env-gone", "thread-gone"));
    assert!(!open_link(cx, &app, "desc-mini", "thread-gone"));
    assert_eq!(selected(cx, &app).as_deref(), Some("thread-mini"));
}
