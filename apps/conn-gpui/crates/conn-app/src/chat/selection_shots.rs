//! Env-gated offscreen renders of selected message text (`render_selection_screenshots`).

use std::path::Path;

use conn_state::{ItemStatus, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AppContext as _, Bounds, MouseButton, Pixels, Point, WindowBounds, WindowOptions, point, px,
    size,
};

use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 560.0;

fn thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![
        TimelineEntry::User {
            id: "u-1".to_owned(),
            text: "Can you make the selection highlight lighter?".to_owned(),
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
            markdown: "The highlight now comes from the theme's own focus colour, so it follows \
                       the theme you pick. The `selection_highlight` token keeps it thin enough \
                       that the text on it stays as easy to read as the rest of the message.\n\n\
                       A second paragraph shows how a drag across blocks looks, with a [link](https://example.com) \
                       in the middle of a line.\n\n```rust\nlet tint = tokens.ring.with_alpha(0.38);\n```"
                .to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
    ];
    thread
}

/// The last element labelled `label`, top to bottom.
fn last_bounds_of(window: &mut gpui_kit::Window, label: &str) -> Bounds<Pixels> {
    let elements = window.elements();
    let Some(element) = elements.iter().rev().find(|e| e.label() == Some(label)) else {
        let labels: Vec<_> = elements.iter().filter_map(|e| e.label()).collect();
        panic!("no `{label}` in {labels:?}");
    };
    element.bounds()
}

/// Selects from the user's message into the answer and renders it offscreen to PNG, in dark and
/// light themes. It opens no window on screen and takes no focus.
///
/// `CONN_SELECTION_SHOTS_DIR=<dir> CONN_SELECTION_SHOTS_PREFIX=after cargo test -p conn-app
/// render_selection_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_SELECTION_SHOTS_DIR"]
fn render_selection_screenshots() {
    let Some(dir) = std::env::var_os("CONN_SELECTION_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_SELECTION_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    // Once: a second `init` resets the kit's theme registry, and the kit then loads its own
    // colors over the theme applied below.
    ctx.update(|cx| {
        gpui_kit::init(cx);
        crate::fonts::register(cx);
        register_keybindings(cx);
    });
    for theme_id in [
        "dark-ocean",
        "t3-code-light",
        "dark-mono",
        "ember",
        "iris-dark",
    ] {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        let tokens = Tokens::derive(&theme);
        let (window, app) = ctx.update(|cx| {
            crate::theme::apply_kit_theme(&tokens, cx);
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
                app.set_thread_for_test("thread-selected".to_owned(), thread(), cx);
            });
        });
        for _ in 0..4 {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
        }
        ctx.update_window(window, |_, window, cx| {
            let user = last_bounds_of(window, "Can you make the selection highlight lighter?");
            // The answer's copy button sits under its last block (the code block).
            let copy = last_bounds_of(window, "Copy message");
            let from = point(
                user.origin.x + user.size.width * 0.45,
                user.origin.y + user.size.height * 0.5,
            );
            let to = point(copy.origin.x + px(330.0), copy.origin.y - px(112.0));
            window.pointer_down(from, MouseButton::Left, cx);
            window.pointer_move(to, Some(MouseButton::Left), cx);
            window.pointer_up(to, MouseButton::Left, cx);
            window.render_frame(cx);
        })
        .expect("a selection");
        ctx.run_until_parked();
        ctx.update_window(window, |_, w, c| w.render_frame(c))
            .expect("a frame");
        let painted = ctx.update(|cx| super::selection::selection_color(cx));
        assert_eq!(
            painted,
            crate::theme::selection_highlight(&tokens),
            "{theme_id}: the shot shows the theme's highlight"
        );
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("{prefix}-{theme_id}.png")))
            .expect("a saved PNG");
    }
}
