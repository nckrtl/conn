//! Env-gated offscreen renders of the thread timeline (`render_thread_align_screenshots`).

use std::path::Path;

use conn_state::{EntryTiming, ItemStatus, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};

use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 520.0;
const GROUP: &str = "work-group-think-1";

fn thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![
        TimelineEntry::User {
            id: "u-1".to_owned(),
            text: "Why does the divider sit left of the text?".to_owned(),
            created_by_agent: false,
            sender: None,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: Some("run-1".to_owned()),
        },
        TimelineEntry::Thinking {
            id: "think-1".to_owned(),
            text: "Checking where the row padding comes from.".to_owned(),
            streaming: false,
        },
        TimelineEntry::Tool {
            id: "tool-1".to_owned(),
            kind: "command".to_owned(),
            title: "rg \"px(2.0)\" crates/conn-app/src/chat".to_owned(),
            detail: None,
            status: ItemStatus::Completed,
            output_omitted: false,
        },
        TimelineEntry::Tool {
            id: "tool-2".to_owned(),
            kind: "command".to_owned(),
            title: "cargo test -p conn-app".to_owned(),
            detail: None,
            status: ItemStatus::Completed,
            output_omitted: false,
        },
        TimelineEntry::Assistant {
            id: "answer-1".to_owned(),
            markdown: "`TIMELINE_INSET_PX` starts this paragraph, so its inline code chip sits on the same left edge as the divider above. The rest of the text wraps under it and ends at the divider's right end, with `WORK_ICON_PX` in the middle of a line."
                .to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
    ];
    for (id, start) in [("think-1", 0), ("tool-1", 3_000), ("tool-2", 9_000)] {
        thread.entry_timings.insert(
            id.to_owned(),
            EntryTiming {
                run_id: Some("run-1".to_owned()),
                started_at_ms: Some(start),
                completed_at_ms: Some(start + 3_000),
            },
        );
    }
    thread
}

/// Renders the timeline offscreen to PNG in Dark Ocean and Light. It opens no window on screen and
/// takes no focus: GPUI's headless renderer draws into a texture.
///
/// `CONN_THREAD_SHOTS_DIR=<dir> CONN_THREAD_SHOTS_PREFIX=after cargo test -p conn-app
/// render_thread_align_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_THREAD_SHOTS_DIR"]
fn render_thread_align_screenshots() {
    let Some(dir) = std::env::var_os("CONN_THREAD_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_THREAD_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
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
                app.set_thread_for_test("thread-selected".to_owned(), thread(), cx);
                let chat = app.chat_for_test();
                chat.update(cx, |chat, cx| chat.toggle_expanded(GROUP, cx));
            });
        });
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
