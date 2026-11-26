//! Env-gated offscreen renders of the thread timeline (`render_thread_align_screenshots`).

use std::path::Path;

use conn_state::{EntryTiming, ItemStatus, NoticeLevel, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};

use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;
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

/// Renders `thread` offscreen to `<prefix>-dark.png` and `<prefix>-light.png` in `dir`, after
/// calling `setup` on the chat view. It opens no window on screen and takes no focus: GPUI's
/// headless renderer draws into a texture.
fn render_pngs(
    dir: &Path,
    prefix: &str,
    thread: &dyn Fn() -> ThreadState,
    setup: &dyn Fn(&mut crate::chat::ChatView, &mut gpui_kit::Context<'_, crate::chat::ChatView>),
) {
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
                chat.update(cx, |chat, cx| setup(chat, cx));
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

/// A turn with three MCP warnings, then a work log with a Conn MCP tool row that the provider
/// reported as a `command`.
fn warnings_thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    let warning = |id: &str, text: &str| TimelineEntry::Notice {
        id: id.to_owned(),
        text: text.to_owned(),
        level: NoticeLevel::Warning,
    };
    thread.entries = vec![
        TimelineEntry::User {
            id: "u-1".to_owned(),
            text: "Read the Conn thread and summarise it.".to_owned(),
            created_by_agent: false,
            sender: None,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: Some("run-1".to_owned()),
        },
        warning(
            "warn-1",
            "MCP client for `computer-use` failed to start: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response",
        ),
        warning(
            "warn-2",
            "The linear MCP server requires OAuth reauthentication. Run `codex mcp login linear`.",
        ),
        warning(
            "warn-3",
            "MCP client for `solo` failed to start: MCP startup failed: the server process exited",
        ),
        TimelineEntry::Notice {
            id: "info-1".to_owned(),
            text: "Context compacted 120k → 40k tokens".to_owned(),
            level: NoticeLevel::Info,
        },
        TimelineEntry::Tool {
            id: "tool-1".to_owned(),
            kind: "command".to_owned(),
            title: "mcp_conn_conn_thread_read".to_owned(),
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
            markdown: "The thread is about the timeline warnings.".to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
    ];
    for (id, start) in [("tool-1", 0), ("tool-2", 6_000)] {
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

/// Renders the thread timeline offscreen to PNG in Dark Ocean and Light.
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
    render_pngs(Path::new(&dir), &prefix, &thread, &|chat, cx| {
        chat.toggle_expanded(GROUP, cx);
    });
}

/// Renders a timeline with three warnings (the first one expanded), an info pill and a Conn tool
/// row.
///
/// `CONN_THREAD_SHOTS_DIR=<dir> CONN_THREAD_SHOTS_PREFIX=warnings cargo test -p conn-app
/// render_timeline_warning_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_THREAD_SHOTS_DIR"]
fn render_timeline_warning_screenshots() {
    let Some(dir) = std::env::var_os("CONN_THREAD_SHOTS_DIR") else {
        return;
    };
    let prefix =
        std::env::var("CONN_THREAD_SHOTS_PREFIX").unwrap_or_else(|_| "warnings".to_owned());
    render_pngs(Path::new(&dir), &prefix, &warnings_thread, &|chat, cx| {
        chat.toggle_expanded("warn-1", cx);
        chat.toggle_expanded("work-group-tool-1", cx);
    });
}

/// A live turn (a settled thought and tool, then a running tool) with two messages queued behind
/// it.
fn queued_thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.working = true;
    let user = |id: &str, text: &str| TimelineEntry::User {
        id: id.to_owned(),
        text: text.to_owned(),
        created_by_agent: false,
        sender: None,
        created_at: None,
        attachments: Vec::new(),
        is_steer: false,
        review_comments: Vec::new(),
        run_id: Some("run-1".to_owned()),
    };
    let tool = |id: &str, title: &str, status: ItemStatus| TimelineEntry::Tool {
        id: id.to_owned(),
        kind: "command".to_owned(),
        title: title.to_owned(),
        detail: None,
        status,
        output_omitted: false,
    };
    let queued = |n: u32, text: &str| TimelineEntry::QueuedUser {
        id: format!("queued-{n}"),
        run_id: format!("run-q-{n}"),
        message_id: format!("msg-q-{n}"),
        text: text.to_owned(),
        attachments: Vec::new(),
        created_at: "2026-11-26T08:08:00.000Z".to_owned(),
        created_by_agent: false,
    };
    thread.entries = vec![
        user("u-1", "Run the whole test suite and fix what breaks."),
        TimelineEntry::Thinking {
            id: "think-1".to_owned(),
            text: "Starting with the crate that changed.".to_owned(),
            streaming: false,
        },
        tool("tool-1", "cargo test -p conn-state", ItemStatus::Completed),
        tool("tool-2", "cargo test -p conn-app", ItemStatus::Running),
        queued(1, "After that, also run clippy with warnings denied."),
        queued(2, "Then open a PR with screenshots."),
    ];
    for (id, start) in [("think-1", 0), ("tool-1", 3_000), ("tool-2", 9_000)] {
        thread.entry_timings.insert(
            id.to_owned(),
            EntryTiming {
                run_id: Some("run-1".to_owned()),
                started_at_ms: Some(start),
                completed_at_ms: (id != "tool-2").then_some(start + 3_000),
            },
        );
    }
    thread
}

/// Renders a live work group followed by two queued messages.
///
/// `CONN_THREAD_SHOTS_DIR=<dir> CONN_THREAD_SHOTS_PREFIX=queued cargo test -p conn-app
/// render_queued_label_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_THREAD_SHOTS_DIR"]
fn render_queued_label_screenshots() {
    let Some(dir) = std::env::var_os("CONN_THREAD_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_THREAD_SHOTS_PREFIX").unwrap_or_else(|_| "queued".to_owned());
    render_pngs(Path::new(&dir), &prefix, &queued_thread, &|_, _| {});
}
