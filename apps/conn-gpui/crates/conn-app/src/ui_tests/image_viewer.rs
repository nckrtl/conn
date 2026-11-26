//! The sent-message image viewer: opened from a thumbnail, stepped, zoomed and closed.

use std::time::Duration;

use conn_client::{Credential, ServerConfig};
use conn_state::{ThreadState, TimelineEntry};
use futures::{SinkExt as _, StreamExt as _};
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{AppContext as _, Entity, MouseButton, Pixels, Point, TestAppContext, Window, px};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{
    center_by_label, kitchen_sink_shell, kitchen_sink_thread, linked_mini_shell, mount_app,
    mount_app_with_server, press,
};
use crate::app::ConnApp;
use crate::chat::image_viewer::{TestLoad, ViewerItem, png_for_test};

/// A thread whose first message carries `count` images.
fn image_thread(count: usize) -> ThreadState {
    let mut thread = kitchen_sink_thread();
    thread.entries.truncate(1);
    let TimelineEntry::User { attachments, .. } = &mut thread.entries[0] else {
        panic!("expected the first user message");
    };
    attachments.clear();
    for index in 0..count {
        attachments.push(conn_contract::ChatAttachment::Image(
            conn_contract::ChatImageAttachment {
                r#type: conn_contract::lit::Image,
                id: format!("image-{index}"),
                name: format!("image-{index}.png"),
                mime_type: "image/png".into(),
                size_bytes: 100,
                source: None,
            },
        ));
    }
    thread
}

fn click(window: &mut Window, cx: &mut gpui_kit::App, at: Point<Pixels>) {
    window.pointer_down(at, MouseButton::Left, cx);
    window.pointer_up(at, MouseButton::Left, cx);
    window.render_frame(cx);
}

fn viewer_open(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> bool {
    cx.read(|cx| app.read(cx).image_viewer_for_test().is_some())
}

fn size_of(window: &Window, label: &str) -> (f32, f32) {
    let size = window.find_by_label(label).bounds().size;
    (f32::from(size.width), f32::from(size.height))
}

/// Opens the viewer on `items[0]` through the app, as a thumbnail click does.
fn open(
    cx: &mut TestAppContext,
    window: gpui_kit::AnyWindowHandle,
    app: &Entity<ConnApp>,
    items: Vec<ViewerItem>,
) {
    let _ = cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.open_image_viewer_for_test(items, 0, window, cx);
        });
        window.render_frame(cx);
        window.render_frame(cx);
    });
}

fn resolve(
    cx: &mut TestAppContext,
    window: gpui_kit::AnyWindowHandle,
    app: &Entity<ConnApp>,
    index: usize,
    load: TestLoad,
) {
    let _ = cx.update_window(window, |_, window, cx| {
        let viewer = app.read(cx).image_viewer_for_test().expect("open");
        viewer.update(cx, |viewer, cx| viewer.resolve_for_test(index, load, cx));
        window.render_frame(cx);
    });
}

fn items(count: usize) -> Vec<ViewerItem> {
    (0..count)
        .map(|index| {
            ViewerItem::new(
                &format!("image-{index}"),
                &format!("image-{index}.png"),
                "image/png",
            )
        })
        .collect()
}

#[gpui_kit::test]
fn a_sent_thumbnail_opens_the_viewer_which_steps_wraps_and_returns_focus(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), image_thread(3), cx);
        })
    });
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        let tile = center_by_label(window, cx, "Preview image-1.png");
        click(window, cx, tile);
    })
    .expect("mounted window");
    cx.run_until_parked();
    assert!(viewer_open(cx, &app));
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.find_by_label("Expanded image preview");
        // The viewer opens on the clicked image; with no connection it is unavailable.
        window.find_by_label("image-1.png (2/3)");
        window.find_by_label("Image unavailable");
        let viewer = app.read(cx).image_viewer_for_test().expect("open");
        assert!(viewer.read(cx).has_focus_for_test(window, cx));
    });
    for (key, caption) in [
        ("right", "image-2.png (3/3)"),
        ("right", "image-0.png (1/3)"),
        ("left", "image-2.png (3/3)"),
        ("tab", "image-2.png (3/3)"),
    ] {
        press(cx, window, key);
        let _ = cx.update_window(window, |_, window, _| {
            window.find_by_label(caption);
        });
    }
    let _ = cx.update_window(window, |_, window, cx| {
        let viewer = app.read(cx).image_viewer_for_test().expect("still open");
        assert!(viewer.read(cx).has_focus_for_test(window, cx), "Tab stays");
    });
    press(cx, window, "escape");
    assert!(!viewer_open(cx, &app));
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find_by_label("Expanded image preview").is_none());
        // The thumbnail that opened the viewer takes focus again.
        window.press("enter", cx);
    });
    cx.run_until_parked();
    assert!(
        viewer_open(cx, &app),
        "Enter reopens from the original thumbnail"
    );
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.find_by_label("image-1.png (2/3)");
    });
}

#[gpui_kit::test]
fn a_tile_opens_its_own_image_when_files_and_repeats_sit_in_the_message(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let mut thread = image_thread(2);
    let TimelineEntry::User { attachments, .. } = &mut thread.entries[0] else {
        panic!("expected the first user message");
    };
    // image-0, a file, image-1, then image-0 again.
    attachments.insert(
        1,
        conn_contract::ChatAttachment::File(conn_contract::ChatFileAttachment {
            r#type: conn_contract::lit::File,
            id: "file-0".into(),
            name: "notes.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 10,
            source: None,
        }),
    );
    attachments.push(attachments[0].clone());
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        })
    });
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
        // The second tile of the first run is image-1, the second of three images.
        let tile = center_by_label(window, cx, "Preview image-1.png");
        click(window, cx, tile);
    })
    .expect("mounted window");
    cx.run_until_parked();
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.find_by_label("image-1.png (2/3)");
    });
    press(cx, window, "right");
    let _ = cx.update_window(window, |_, window, _| {
        window.find_by_label("image-0.png (3/3)");
    });
}

#[gpui_kit::test]
fn the_back_button_and_the_backdrop_close_and_a_picture_click_does_not(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    open(cx, window, &app, items(1));
    resolve(cx, window, &app, 0, TestLoad::Png(png_for_test(1200, 600)));
    let _ = cx.update_window(window, |_, window, cx| {
        // A single image has no navigation and no count.
        assert!(window.try_find_by_label("Next media").is_none());
        window.find_by_label("image-0.png");
        let picture = center_by_label(window, cx, "Image image-0.png");
        click(window, cx, picture);
    });
    assert!(
        viewer_open(cx, &app),
        "a click on the picture does not close it"
    );
    let _ = cx.update_window(window, |_, window, cx| {
        let back = center_by_label(window, cx, "Back, close image preview");
        click(window, cx, back);
    });
    assert!(!viewer_open(cx, &app), "Back closes");
    open(cx, window, &app, items(1));
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        click(window, cx, Point::new(px(5.0), px(5.0)));
    });
    assert!(!viewer_open(cx, &app), "the backdrop closes");
}

#[gpui_kit::test]
fn a_picture_fits_whole_zooms_with_click_and_keys_and_refits_on_change(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    open(cx, window, &app, items(2));
    resolve(cx, window, &app, 0, TestLoad::Png(png_for_test(1200, 600)));
    resolve(cx, window, &app, 1, TestLoad::Loading);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let fit = size_of(window, "Image image-0.png");
        assert!(
            (fit.0 / fit.1 - 2.0).abs() < 0.01,
            "uncropped 2:1, got {fit:?}"
        );
        assert!(
            fit.0 <= 1229.0 && fit.1 <= 740.0,
            "inside the stage, got {fit:?}"
        );
        // A click zooms in at the pointer, and Enter returns to fit.
        let picture = center_by_label(window, cx, "Image image-0.png");
        click(window, cx, picture);
        let zoomed = size_of(window, "Image image-0.png");
        assert!(
            zoomed.0 > fit.0 && zoomed.1 > fit.1,
            "{zoomed:?} vs {fit:?}"
        );
        window.key_down("enter", false, cx);
        window.render_frame(cx);
        assert_eq!(size_of(window, "Image image-0.png"), fit);
        // `=` zooms by steps and `0` fits.
        window.key_down("=", false, cx);
        window.render_frame(cx);
        assert!(size_of(window, "Image image-0.png").0 > fit.0);
        window.key_down("0", false, cx);
        window.render_frame(cx);
        assert_eq!(size_of(window, "Image image-0.png"), fit);
        // The navigation button works while zoomed, and the next picture is still loading.
        window.key_down("enter", false, cx);
        window.render_frame(cx);
        let next = center_by_label(window, cx, "Next media");
        click(window, cx, next);
        window.find_by_label("Loading image");
        window.key_down("left", false, cx);
        window.render_frame(cx);
        assert_eq!(
            size_of(window, "Image image-0.png"),
            fit,
            "stepping fits again"
        );
    });
    // A picture that arrives later shows at its own ratio, tall and whole.
    press(cx, window, "right");
    resolve(cx, window, &app, 1, TestLoad::Png(png_for_test(300, 900)));
    let _ = cx.update_window(window, |_, window, _| {
        let tall = size_of(window, "Image image-1.png");
        assert!((tall.0 / tall.1 - 1.0 / 3.0).abs() < 0.01, "got {tall:?}");
        assert!(tall.1 <= 740.0);
    });
}

#[gpui_kit::test]
fn a_failed_picture_says_unavailable_and_the_gallery_still_steps(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    open(cx, window, &app, items(2));
    resolve(cx, window, &app, 0, TestLoad::Failed);
    resolve(cx, window, &app, 1, TestLoad::Png(png_for_test(40, 40)));
    let _ = cx.update_window(window, |_, window, _| {
        window.find_by_label("Image unavailable");
    });
    press(cx, window, "right");
    let _ = cx.update_window(window, |_, window, _| {
        assert!(window.try_find_by_label("Image unavailable").is_none());
        window.find_by_label("Image image-1.png");
    });
}

#[gpui_kit::test]
fn closing_the_viewer_frees_every_picture(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    open(cx, window, &app, items(2));
    resolve(cx, window, &app, 0, TestLoad::Png(png_for_test(64, 64)));
    resolve(cx, window, &app, 1, TestLoad::Png(png_for_test(64, 64)));
    let viewer = cx.read(|cx| app.read(cx).image_viewer_for_test().expect("open"));
    assert_eq!(cx.read(|cx| viewer.read(cx).ready_for_test()), [true, true]);
    press(cx, window, "escape");
    assert!(!viewer_open(cx, &app));
    assert_eq!(
        cx.read(|cx| viewer.read(cx).ready_for_test()),
        [false, false],
        "pictures are released on close"
    );
}

#[gpui_kit::test]
fn another_thread_on_screen_drops_the_viewer(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), image_thread(1), cx);
        })
    });
    open(cx, window, &app, items(1));
    assert!(viewer_open(cx, &app));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test("thread-other".to_owned(), kitchen_sink_thread(), cx);
        })
    });
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.render_frame(cx);
    });
    assert!(!viewer_open(cx, &app), "the viewer belongs to its thread");
}

/// A loopback server that answers every request with a failure and reports each request's tag
/// and payload, so a test sees which environment a download went to.
fn spawn_recording_server() -> (
    url::Url,
    std::sync::mpsc::Receiver<(String, serde_json::Value)>,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    let addr = crate::live::RT.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback listener");
        let addr = listener.local_addr().expect("a listener address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            if let conn_wire::FromClient::Request(req) = frame {
                                let _ = tx.send((req.tag.clone(), req.payload.clone()));
                                let reply = conn_wire::FromServer::Exit {
                                    request_id: req.id,
                                    exit: conn_wire::Exit::die(conn_wire::error_defect(
                                        "TestError",
                                        "no attachment here",
                                    )),
                                };
                                let _ = ws
                                    .send(Message::Text(
                                        conn_wire::encode_server_frame(&reply).into(),
                                    ))
                                    .await;
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    (
        url::Url::parse(&format!("http://{addr}")).expect("a loopback URL"),
        rx,
    )
}

/// Waits for an `assets.createUrl` for attachment `id` on the server, running the app's tasks
/// meanwhile; other requests, such as the thumbnails' own downloads, are skipped.
fn saw_attachment_request(
    cx: &mut TestAppContext,
    requests: &std::sync::mpsc::Receiver<(String, serde_json::Value)>,
    id: &str,
) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        while let Ok((tag, payload)) = requests.try_recv() {
            if tag == "assets.createUrl" && payload["resource"]["attachmentId"] == id {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// A thread of a linked environment keeps its pictures on that environment: the viewer asks
/// the linked connection for the opened picture and for each one it steps to, never the
/// primary connection.
#[gpui_kit::test]
fn a_linked_threads_viewer_downloads_from_its_own_environment(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (primary_url, primary_requests) = spawn_recording_server();
    let (mini_url, mini_requests) = spawn_recording_server();
    let (window, app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: ServerConfig {
                http_base_url: primary_url,
                credential: Credential::Bearer("primary-token".to_owned()),
            },
            label: Some("primary".to_owned()),
            orbit_server_id: Some("primary".to_owned()),
        }),
    );
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.connect_linked_for_test(
                "mini",
                ServerConfig {
                    http_base_url: mini_url,
                    credential: Credential::Bearer("mini-token".to_owned()),
                },
                cx,
            );
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/tmp/mini", "Mini"),
                cx,
            );
            app.set_thread_for_test("thread-mini".to_owned(), image_thread(2), cx);
        })
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test("thread-mini")),
        Some("mini".to_owned()),
        "the thread belongs to the linked environment"
    );
    for _ in 0..200 {
        cx.run_until_parked();
        if cx.read(|cx| app.read(cx).linked_connected_for_test("mini")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        cx.read(|cx| app.read(cx).linked_connected_for_test("mini")),
        "the linked environment connects"
    );
    // Pictures the thread's thumbnails never ask for, so a request for one is the viewer's.
    let gallery = (0..2)
        .map(|index| {
            ViewerItem::new(
                &format!("gallery-{index}"),
                &format!("gallery-{index}.png"),
                "image/png",
            )
        })
        .collect();
    open(cx, window, &app, gallery);
    assert!(
        saw_attachment_request(cx, &mini_requests, "gallery-0"),
        "the opened picture comes from the thread's own environment"
    );
    // Stepping to the next picture asks the same environment.
    press(cx, window, "right");
    assert!(
        saw_attachment_request(cx, &mini_requests, "gallery-1"),
        "the next picture comes from the thread's own environment"
    );
    while let Ok((tag, payload)) = primary_requests.try_recv() {
        assert!(
            tag != "assets.createUrl",
            "the primary was asked for a picture: {payload}"
        );
    }
}
