//! Env-gated offscreen renders of the full-image viewer (`render_image_viewer_screenshots`).

use std::path::Path;

use conn_state::{ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};

use super::image_viewer::{TestLoad, ViewerItem};
use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;

/// A thread whose first message carries `count` images.
fn thread(count: usize) -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    let attachments = (0..count)
        .map(|index| {
            conn_contract::ChatAttachment::Image(conn_contract::ChatImageAttachment {
                r#type: conn_contract::lit::Image,
                id: format!("image-{index}"),
                name: format!("screenshot-{}.png", index + 1),
                mime_type: "image/png".into(),
                size_bytes: 100,
                source: None,
            })
        })
        .collect();
    thread.entries = vec![TimelineEntry::User {
        id: "u-1".to_owned(),
        text: "Here is how the three states look.".to_owned(),
        created_by_agent: false,
        sender: None,
        created_at: None,
        attachments,
        is_steer: false,
        review_comments: Vec::new(),
        run_id: Some("run-1".to_owned()),
    }];
    thread
}

/// A landscape picture with a gradient and a disc, so the whole picture is plain to see.
fn picture(index: u32) -> Vec<u8> {
    let (width, height) = (1600_u32, 1000_u32);
    let hue = [
        (240.0, 110.0, 60.0),
        (40.0, 150.0, 230.0),
        (70.0, 190.0, 110.0),
    ];
    let (r, g, b) = hue[index as usize % hue.len()];
    let mut image = image::RgbaImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let t = x as f32 / width as f32;
        let u = y as f32 / height as f32;
        let (dx, dy) = (x as f32 - 800.0, y as f32 - 500.0);
        let disc = (dx * dx + dy * dy).sqrt() < 260.0;
        let mix = |c: f32| (c * (0.45 + 0.55 * t) * (1.0 - 0.3 * u)) as u8;
        *pixel = if disc {
            image::Rgba([250, 250, 245, 255])
        } else {
            image::Rgba([mix(r), mix(g), mix(b), 255])
        };
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("a picture encodes as PNG");
    bytes
}

/// Renders the viewer open on one image, and on the middle one of three, in Dark Ocean and
/// Light.
///
/// `CONN_VIEWER_SHOTS_DIR=<dir> cargo test -p conn-app render_image_viewer_screenshots --
/// --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_VIEWER_SHOTS_DIR"]
fn render_image_viewer_screenshots() {
    let Some(dir) = std::env::var_os("CONN_VIEWER_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (count, opened, name) in [(1_usize, 0_usize, "single"), (3, 1, "gallery")] {
        for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
            let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
            let tokens = Tokens::derive(&theme);
            let (window, app) = ctx.update(|cx| {
                gpui_kit::init(cx);
                crate::fonts::register(cx);
                crate::theme::apply_kit_theme(&tokens, cx);
                register_keybindings(cx);
                gpui_kit::open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                            Point::default(),
                            size(px(WIDTH_PX), px(HEIGHT_PX)),
                        ))),
                        focus: false,
                        show: false,
                        ..Default::default()
                    },
                    cx,
                    |window, cx| {
                        let tokens = tokens.clone();
                        cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
                    },
                )
                .expect("a window")
            });
            ctx.update(|cx| {
                app.update(cx, |app, cx| {
                    app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
                    app.set_thread_for_test("thread-selected".to_owned(), thread(count), cx);
                });
            });
            for _ in 0..3 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            let items: Vec<ViewerItem> = (0..count)
                .map(|index| {
                    ViewerItem::new(
                        &format!("image-{index}"),
                        &format!("screenshot-{}.png", index + 1),
                        "image/png",
                    )
                })
                .collect();
            ctx.update_window(window, |_, w, c| {
                app.update(c, |app, cx| {
                    app.open_image_viewer_for_test(items, opened, w, cx);
                    let viewer = app.image_viewer_for_test().expect("open");
                    viewer.update(cx, |viewer, cx| {
                        for index in 0..count {
                            viewer.resolve_for_test(
                                index,
                                TestLoad::Png(picture(index as u32)),
                                cx,
                            );
                        }
                    });
                });
            })
            .expect("the viewer opens");
            for _ in 0..4 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("viewer-{name}-{label}.png")))
                .expect("a saved PNG");
        }
    }
}
