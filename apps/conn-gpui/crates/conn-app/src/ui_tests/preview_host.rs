//! The preview host through the app: browser tabs register with their thread's server as they
//! open, stay registered when another thread shows, release on close, and register again after
//! a reconnect.

use std::sync::Arc;
use std::time::{Duration, Instant};

use conn_state::PanelSurface;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};

use super::mount_two_thread_app;
use crate::preview_host::EnvConnection;
use crate::preview_host::tests::FakeServer;

/// Polls (the host works on the app's Tokio runtime) until `condition` holds.
fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let began = Instant::now();
    while !condition() {
        assert!(
            began.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[gpui_kit::test]
fn browser_tabs_register_per_thread_and_follow_the_connection(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    let server = Arc::new(FakeServer::default());
    let environment = cx.update(|cx| {
        app.read(cx)
            .panel_owner_for_test("thread-selected")
            .environment
    });
    let link = |connected: bool| EnvConnection {
        environment: environment.clone(),
        api: server.clone(),
        connection: None,
        connected,
    };
    let browser_id = |surface: &PanelSurface| match surface {
        PanelSurface::Browser(id) => *id,
        other => panic!("{other:?} is not a browser tab"),
    };

    // A tab opens on thread A: it registers under a record the server made for that thread.
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_preview_envs_for_test(vec![link(true)], cx);
            app.open_browser_tab("https://one.example/".into(), false, cx)
        })
    });
    frames(cx);
    wait_for("thread A's registration", || {
        server.registrations().len() == 1
    });
    assert_eq!(server.registrations()[0].0, "thread-selected");
    let one = cx.update(|cx| browser_id(&app.read(cx).right_panel_tabs().tabs()[0]));
    assert_eq!(
        cx.update(|cx| app.read(cx).preview_hosted_for_test()),
        [(one, Some(server.registrations()[0].1.clone()))]
    );

    // Thread B shows with a tab of its own: A's tab stays registered, parked.
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-other", cx)));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_right_panel_tab(conn_state::RightPanelTab::Browser, cx)
        })
    });
    frames(cx);
    wait_for("thread B's registration", || {
        server.registrations().len() == 2
    });
    assert_eq!(server.registrations()[1].0, "thread-other");
    // The host registers a tab, then opens its request stream: the stream trails the registration.
    wait_for("both tabs' request streams", || server.live_streams() == 2);
    assert!(
        server.closed().is_empty(),
        "a parked thread's tab stays registered"
    );

    // Back on A, closing its tab releases the registration and the record; B's stays.
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    frames(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.close_right_panel_tab(&PanelSurface::Browser(one), cx)
        })
    });
    frames(cx);
    wait_for("the close", || server.closed().len() == 1);
    assert_eq!(server.closed()[0], server.registrations()[0].1);
    wait_for("the stream to end", || server.live_streams() == 1);

    // A reconnect: the remaining tab registers again, under the record it already has.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_preview_envs_for_test(vec![link(false)], cx)
        })
    });
    wait_for("the stream to end on disconnect", || {
        server.live_streams() == 0
    });
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_preview_envs_for_test(vec![link(true)], cx)
        })
    });
    wait_for("the registration after the reconnect", || {
        server.registrations().len() == 3
    });
    assert_eq!(server.registrations()[2], server.registrations()[1]);
    wait_for("the request stream after the reconnect", || {
        server.live_streams() == 1
    });

    // A thread deleted here takes its tabs, registrations and records with it.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let owner = app.panel_owner_for_test("thread-other");
            app.release_thread_panel(&owner, cx)
        })
    });
    frames(cx);
    wait_for("the second close", || server.closed().len() == 2);
    wait_for("the last stream to end", || server.live_streams() == 0);
}
