//! Sidebar hover prefetch: resting on a thread row opens it, a click reuses its stream, and one
//! that goes unused closes (`app/hover_prefetch.rs`).

use std::time::Duration;

use conn_client::{Credential, ServerConfig};
use futures::StreamExt as _;
use gpui_kit::{Entity, TestAppContext, point, px};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{kitchen_sink_shell, mount_app_with_server};
use crate::app::ConnApp;
use crate::live::RT;
use crate::sidebar::hover_card_state::OPEN_DELAY;

/// A loopback server that reports the thread id of every `subscribeThread` request it hears.
fn thread_subscribe_server() -> (
    crate::live::StartupServer,
    std::sync::mpsc::Receiver<String>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let addr = RT.block_on(async {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(err) => panic!("failed to bind loopback listener: {err}"),
        };
        let addr = match listener.local_addr() {
            Ok(a) => a,
            Err(err) => panic!("failed to read listener addr: {err}"),
        };
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            if let conn_wire::FromClient::Request(req) = frame
                                && req.tag == "orchestration.subscribeThread"
                                && let Some(id) =
                                    req.payload.get("threadId").and_then(|id| id.as_str())
                            {
                                let _ = tx.send(id.to_owned());
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    let http_base_url = match url::Url::parse(&format!("http://{addr}")) {
        Ok(url) => url,
        Err(err) => panic!("invalid loopback URL: {err}"),
    };
    let server = crate::live::StartupServer {
        config: ServerConfig {
            http_base_url,
            credential: Credential::Bearer("test-token".to_owned()),
        },
        label: None,
        orbit_server_id: None,
    };
    (server, rx)
}

/// Collects `subscribeThread` requests into `seen` until one names `thread_id`.
fn wait_for_thread_subscribe(
    requests: &std::sync::mpsc::Receiver<String>,
    seen: &mut Vec<String>,
    thread_id: &str,
) {
    while !seen.iter().any(|id| id == thread_id) {
        match requests.recv_timeout(Duration::from_secs(5)) {
            Ok(id) => seen.push(id),
            Err(err) => panic!("no subscribeThread for {thread_id} ({err}); saw {seen:?}"),
        }
    }
}

/// Runs the app until its connection to the loopback server is up: a prefetch needs a live
/// connection, as a click does.
fn wait_until_connected(cx: &mut TestAppContext, app: &Entity<ConnApp>) {
    for _ in 0..250 {
        cx.run_until_parked();
        if cx.read(|cx| app.read(cx).thread_connected_for_test("thread-pinned")) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the app never connected to the loopback server");
}

/// What the app's hover would do after the pointer rested on `thread_id`'s row for `dwell`.
fn hover_and_wait(
    cx: &mut TestAppContext,
    app: &Entity<ConnApp>,
    thread_id: &str,
    dwell: Duration,
) {
    cx.update(|cx| {
        app.update(cx, |app, cx| app.thread_hover_changed(thread_id, true, cx));
    });
    cx.executor().advance_clock(dwell);
    cx.run_until_parked();
}

/// Resting on a row starts its thread stream once. A click on that row reuses the stream and
/// sends no second request, and it takes the entry out of the speculative set.
#[gpui_kit::test]
fn hovering_a_thread_prefetches_it_once_and_a_click_reuses_the_stream(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (server, requests) = thread_subscribe_server();
    let (_window, app) = mount_app_with_server(cx, Some(server));
    let mut seen = Vec::new();
    wait_until_connected(cx, &app);

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.prefetch_hovered_thread("thread-pinned", cx);
            // The pointer resting on the row again must not fetch again.
            app.prefetch_hovered_thread("thread-pinned", cx);
        });
    });
    wait_for_thread_subscribe(&requests, &mut seen, "thread-pinned");
    assert_eq!(
        cx.read(|cx| app.read(cx).speculative_threads_for_test()),
        ["thread-pinned"]
    );

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-pinned", cx);
        });
    });
    assert!(
        cx.read(|cx| app.read(cx).speculative_threads_for_test())
            .is_empty(),
        "the open thread owns the stream now"
    );

    // Requests are sent in order, so once this row's request is here, a second request for the
    // clicked row would be too.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.prefetch_hovered_thread("thread-failed", cx)
        });
    });
    wait_for_thread_subscribe(&requests, &mut seen, "thread-failed");
    assert_eq!(
        seen.iter().filter(|id| *id == "thread-pinned").count(),
        1,
        "a click on a prefetched thread must reuse its stream: {seen:?}"
    );
}

/// Rapid hovering keeps one thread open: the previous entry closes, a row that is still hovered
/// keeps its entry past the TTL, and an entry nobody hovers again closes.
#[gpui_kit::test]
fn rapid_hover_keeps_one_prefetched_thread_open(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (server, _requests) = thread_subscribe_server();
    let (_window, app) = mount_app_with_server(cx, Some(server));
    wait_until_connected(cx, &app);
    let speculative =
        |cx: &mut TestAppContext| cx.read(|cx| app.read(cx).speculative_threads_for_test());
    let open =
        |cx: &mut TestAppContext, id: &str| cx.read(|cx| app.read(cx).thread_open_for_test(id));
    let prefetch = |cx: &mut TestAppContext, id: &str| {
        cx.update(|cx| {
            app.update(cx, |app, cx| app.prefetch_hovered_thread(id, cx));
        });
    };

    cx.update(|cx| {
        app.update(cx, |app, cx| app.set_shell(kitchen_sink_shell(), cx));
    });
    prefetch(cx, "thread-working-bg");
    assert_eq!(speculative(cx), ["thread-working-bg"]);
    assert!(open(cx, "thread-working-bg"));
    prefetch(cx, "thread-pinned");
    assert_eq!(speculative(cx), ["thread-pinned"]);
    assert!(open(cx, "thread-pinned"));
    assert!(!open(cx, "thread-working-bg"), "the previous entry closed");

    // A row that is still hovered keeps its entry past the TTL.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.open_thread_hover_for_test("thread-pinned", cx);
            app.expire_speculative_for_test(Duration::from_secs(120), cx);
        });
    });
    assert_eq!(speculative(cx), ["thread-pinned"]);
    assert!(open(cx, "thread-pinned"));

    // An abandoned entry closes.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.dismiss_thread_hover(cx);
            app.expire_speculative_for_test(Duration::from_secs(240), cx);
        });
    });
    assert!(speculative(cx).is_empty());
    assert!(!open(cx, "thread-pinned"));
}

/// A thread that is open already is current: hovering it starts no prefetch, so the entry never
/// closes a thread the screen shows.
#[gpui_kit::test]
fn hovering_an_open_thread_starts_no_prefetch(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (server, _requests) = thread_subscribe_server();
    let (_window, app) = mount_app_with_server(cx, Some(server));
    wait_until_connected(cx, &app);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.select_thread("thread-waiting", cx);
            app.prefetch_hovered_thread("thread-waiting", cx);
        });
    });
    assert!(
        cx.read(|cx| app.read(cx).speculative_threads_for_test())
            .is_empty(),
        "the open thread needs no prefetch"
    );
    assert!(cx.read(|cx| app.read(cx).thread_open_for_test("thread-waiting")));
}

/// The pointer has to rest for the open delay: a row the pointer only passes, and a list that is
/// scrolling, prefetch nothing; a row it rests on does.
#[gpui_kit::test]
fn only_a_resting_pointer_prefetches_not_a_passing_or_scrolling_one(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (server, requests) = thread_subscribe_server();
    let (_window, app) = mount_app_with_server(cx, Some(server));
    wait_until_connected(cx, &app);
    cx.update(|cx| {
        app.update(cx, |app, cx| app.set_shell(kitchen_sink_shell(), cx));
    });
    let speculative =
        |cx: &mut TestAppContext| cx.read(|cx| app.read(cx).speculative_threads_for_test());

    // Passing over a row: in, out before the delay.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.thread_hover_changed("thread-pinned", true, cx)
        });
    });
    cx.executor().advance_clock(OPEN_DELAY / 2);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.thread_hover_changed("thread-pinned", false, cx)
        });
    });
    cx.executor().advance_clock(OPEN_DELAY * 2);
    cx.run_until_parked();
    assert!(
        speculative(cx).is_empty(),
        "a passing pointer fetches nothing"
    );

    // Scrolling the list while the pointer waits on a row ends that hover.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.thread_hover_changed("thread-failed", true, cx)
        });
    });
    cx.executor().advance_clock(OPEN_DELAY / 2);
    cx.update(|cx| {
        app.update(cx, |app, cx| app.dismiss_thread_hover(cx));
    });
    cx.executor().advance_clock(OPEN_DELAY * 2);
    cx.run_until_parked();
    assert!(
        speculative(cx).is_empty(),
        "a scrolling list fetches nothing"
    );

    // A card that slides from row to row opens at once on each; a row it only passes while
    // sliding is not fetched, the one it rests on is.
    hover_and_wait(cx, &app, "thread-pinned", OPEN_DELAY * 2);
    assert_eq!(speculative(cx), ["thread-pinned"], "the pointer rested");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.thread_hover_changed("thread-pinned", false, cx);
            app.thread_hover_changed("thread-waiting", true, cx);
        });
    });
    cx.executor().advance_clock(OPEN_DELAY / 2);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.thread_hover_changed("thread-waiting", false, cx);
            app.thread_hover_changed("thread-failed", true, cx);
        });
    });
    cx.executor().advance_clock(OPEN_DELAY * 2);
    cx.run_until_parked();
    assert_eq!(
        speculative(cx),
        ["thread-failed"],
        "the row the sliding card passed was never fetched"
    );
    let mut seen = Vec::new();
    wait_for_thread_subscribe(&requests, &mut seen, "thread-failed");
    assert!(
        !seen.iter().any(|id| id == "thread-waiting"),
        "a row the card only slid past must not be fetched: {seen:?}"
    );
}

/// Hovering while the pointer is captured elsewhere (a menu, a rename) starts nothing.
#[gpui_kit::test]
fn no_prefetch_while_a_thread_menu_is_open(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (server, _requests) = thread_subscribe_server();
    let (_window, app) = mount_app_with_server(cx, Some(server));
    wait_until_connected(cx, &app);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.open_thread_menu("thread-pinned".to_owned(), point(px(200.0), px(200.0)), cx);
            app.prefetch_hovered_thread("thread-failed", cx);
        });
    });
    assert!(
        cx.read(|cx| app.read(cx).speculative_threads_for_test())
            .is_empty()
    );
}
