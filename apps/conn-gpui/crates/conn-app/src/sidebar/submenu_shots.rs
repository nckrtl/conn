//! Env-gated offscreen renders of the thread menu's `Copy` submenu near the window edges
//! (`render_thread_menu_submenu_screenshots`).

use std::path::Path;

use conn_theme::Tokens;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, point, px, size};

use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;

/// Where the menu opens, for each shot: the window's right and bottom edges, and the bottom edge
/// alone.
const CASES: [(&str, f32, f32); 2] = [
    ("bottom-right", WIDTH_PX - 40.0, HEIGHT_PX - 150.0),
    ("bottom", 260.0, HEIGHT_PX - 150.0),
];

fn render_pngs(dir: &Path) {
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        for (case, x, y) in CASES {
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
                    app.open_thread_menu("thread-pinned".to_owned(), point(px(x), px(y)), cx);
                    app.open_thread_menu_copy_submenu(cx);
                });
            });
            for _ in 0..4 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("submenu-{case}-{label}.png")))
                .expect("a saved PNG");
        }
    }
}

/// `CONN_THREAD_SHOTS_DIR=<dir> cargo test -p conn-app render_thread_menu_submenu_screenshots --
/// --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_THREAD_SHOTS_DIR"]
fn render_thread_menu_submenu_screenshots() {
    let Some(dir) = std::env::var_os("CONN_THREAD_SHOTS_DIR") else {
        return;
    };
    render_pngs(Path::new(&dir));
}
