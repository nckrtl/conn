//! Env-gated offscreen renders of the composer's model picker with its settings column
//! (`render_model_picker_settings_screenshots`).

use std::path::Path;
use std::sync::Arc;

use conn_state::ThreadState;
use conn_state::providers::ServerConfigState;
use conn_theme::Tokens;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};

use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;

fn config() -> Arc<ServerConfigState> {
    let snapshot: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
    ))
    .expect("fixture is JSON");
    let mut state = ServerConfigState::new();
    state.apply(serde_json::from_value(snapshot).expect("snapshot event"));
    Arc::new(state)
}

/// Renders the picker open on `(instance, driver, model)` to `<prefix>-dark.png` and
/// `<prefix>-light.png` in `dir`.
fn render_pngs(dir: &Path, prefix: &str, instance: &str, driver: &str, model: &str) {
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        Arc::new(gpui_apple::AppleTextSystem::new()),
        Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
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
                let mut thread = ThreadState::new("thread-selected");
                thread.synchronized = true;
                app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
                let composer = app.chat_for_test().read(cx).composer_for_test();
                composer.update(cx, |composer, cx| {
                    composer.set_server_config(config(), cx);
                    composer.set_model_selection(
                        Some(instance.to_owned()),
                        Some(driver.to_owned()),
                        model.to_owned(),
                        None,
                        cx,
                    );
                });
            });
        });
        let composer = ctx.update(|cx| app.read(cx).chat_for_test().read(cx).composer_for_test());
        ctx.update_window(window, |_, w, cx| {
            composer.update(cx, |composer, cx| composer.toggle_model_picker(w, cx));
        })
        .expect("the picker opens");
        for _ in 0..4 {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
        }
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("{prefix}-{label}.png")))
            .expect("a saved PNG");
    }
}

/// `CONN_PICKER_SHOTS_DIR=<dir> cargo test -p conn-app
/// render_model_picker_settings_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_PICKER_SHOTS_DIR"]
fn render_model_picker_settings_screenshots() {
    let Some(dir) = std::env::var_os("CONN_PICKER_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    render_pngs(
        dir,
        "claude",
        "claudeAgent",
        "claudeAgent",
        "claude-opus-5-5",
    );
    render_pngs(dir, "codex", "codex", "codex", "gpt-6.1-sol");
}
