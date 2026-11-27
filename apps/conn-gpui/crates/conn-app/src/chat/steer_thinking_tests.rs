//! One live "Thinking" row per thread. A steer or a new message ends the earlier group's live
//! row, even while the server still reports that group's reasoning as streaming.

use conn_state::{ItemStatus, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::TestQueryExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, Point, WindowBounds,
    WindowOptions, px, size,
};

use super::card_shots::settle;
use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;

fn user(id: &str, text: &str, run: &str, is_steer: bool) -> TimelineEntry {
    TimelineEntry::User {
        id: id.to_owned(),
        text: text.to_owned(),
        created_by_agent: false,
        sender: None,
        created_at: None,
        attachments: Vec::new(),
        is_steer,
        review_comments: Vec::new(),
        run_id: Some(run.to_owned()),
    }
}

fn assistant(id: &str, text: &str, run: &str) -> TimelineEntry {
    TimelineEntry::Assistant {
        id: id.to_owned(),
        markdown: text.to_owned(),
        streaming: false,
        created_at: None,
        run_id: Some(run.to_owned()),
        status: ItemStatus::Completed,
    }
}

fn thinking(id: &str, text: &str, streaming: bool) -> TimelineEntry {
    TimelineEntry::Thinking {
        id: id.to_owned(),
        text: text.to_owned(),
        streaming,
    }
}

const CROP: &str =
    "The crop is 1:1 in pixels, about 1185 px wide, so I'm assuming roughly a 3x screen scale.";

/// The turn so far: a message, a paragraph, then reasoning the server still streams.
fn reasoning_in_progress() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.working = true;
    thread.entries = vec![
        user("u-1", "Why does the VM not start?", "run-1", false),
        assistant(
            "a-1",
            "The VM can't start: it reached its disk limit. I'll keep working out the cause.",
            "run-1",
        ),
        thinking("think-1", CROP, true),
    ];
    thread
}

/// The steer lands before the server closes the old reasoning.
fn steered() -> ThreadState {
    let mut thread = reasoning_in_progress();
    thread
        .entries
        .push(user("u-steer", "Just build on this device.", "run-1", true));
    thread
}

/// The steered part of the turn starts its own reasoning.
fn steered_new_reasoning() -> ThreadState {
    let mut thread = steered();
    thread.entries.push(thinking("think-2", "", true));
    thread
}

/// The server closes the old reasoning at last.
fn steered_old_closed() -> ThreadState {
    let mut thread = steered_new_reasoning();
    thread.entries[2] = thinking("think-1", CROP, false);
    thread
}

/// Interrupted: the turn ends, and the old reasoning has not been closed yet.
fn interrupted() -> ThreadState {
    let mut thread = reasoning_in_progress();
    thread.working = false;
    thread
}

/// A new message after the interrupt starts a new turn.
fn interrupted_new_message() -> ThreadState {
    let mut thread = interrupted();
    thread.working = true;
    thread
        .entries
        .push(user("u-2", "Try again on this device.", "run-2", false));
    thread
}

fn interrupted_new_reasoning() -> ThreadState {
    let mut thread = interrupted_new_message();
    thread.entries.push(thinking("think-2", "", true));
    thread
}

fn headless() -> HeadlessAppContext {
    HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    )
}

fn open(ctx: &mut HeadlessAppContext, thread: ThreadState) -> (AnyWindowHandle, Entity<ConnApp>) {
    let theme = conn_theme::theme_by_id("dark-ocean")
        .unwrap_or_else(|| panic!("dark-ocean is not a built-in theme"));
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
            {
                let tokens = tokens.clone();
                move |window, cx| cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
            },
        )
        .unwrap_or_else(|error| panic!("no window: {error}"))
    });
    ctx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
        });
    });
    set_thread(ctx, window, &app, thread);
    (window, app)
}

fn set_thread(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    thread: ThreadState,
) {
    ctx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        });
    });
    settle(ctx, window);
}

/// Every live "Thinking" row on screen, by element id, top to bottom: the "Working for" row's
/// own `timeline-thinking`, and a live group's `live-status-<id>`.
fn thinking_rows(ctx: &mut HeadlessAppContext, window: AnyWindowHandle) -> Vec<(String, f32)> {
    ctx.update_window(window, |_, w, _| {
        let mut rows: Vec<(String, f32)> = w
            .elements()
            .iter()
            .filter_map(|e| {
                let id = e.path().last()?.to_string();
                let live = id == "timeline-thinking"
                    || (id.starts_with("live-status-") && !id.starts_with("live-status-icon-"));
                live.then(|| (id, f32::from(e.bounds().top())))
            })
            .collect();
        rows.sort_by(|a, b| a.1.total_cmp(&b.1));
        rows.dedup_by(|a, b| a.0 == b.0);
        rows
    })
    .unwrap_or_else(|error| panic!("no window: {error}"))
}

fn top_of(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, id: &str) -> f32 {
    ctx.update_window(window, |_, w, _| {
        w.elements()
            .iter()
            .find(|e| e.path().last().is_some_and(|last| last.to_string() == id))
            .map(|e| f32::from(e.bounds().top()))
            .unwrap_or_else(|| panic!("no element with the id `{id}`"))
    })
    .unwrap_or_else(|error| panic!("no window: {error}"))
}

/// Exactly one "Thinking" row, with the id `expected`, under the message `below` when given.
fn assert_one_thinking(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    step: &str,
    expected: &str,
    below: Option<&str>,
) {
    let rows = thinking_rows(ctx, window);
    assert_eq!(
        rows.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
        vec![expected],
        "{step}: one Thinking row, `{expected}`"
    );
    if let Some(message) = below {
        let message_top = top_of(ctx, window, &format!("user-actions-{message}"));
        assert!(
            rows[0].1 > message_top,
            "{step}: the Thinking row ({}px) is under `{message}` ({message_top}px)",
            rows[0].1
        );
    }
}

#[test]
fn a_steer_keeps_one_thinking_row_on_the_newest_group() {
    let mut ctx = headless();
    let (window, app) = open(&mut ctx, reasoning_in_progress());
    assert_one_thinking(
        &mut ctx,
        window,
        "reasoning in progress",
        "live-status-think-1",
        Some("u-1"),
    );

    set_thread(&mut ctx, window, &app, steered());
    assert_one_thinking(
        &mut ctx,
        window,
        "steer sent",
        "timeline-thinking",
        Some("u-steer"),
    );

    set_thread(&mut ctx, window, &app, steered_new_reasoning());
    assert_one_thinking(
        &mut ctx,
        window,
        "new reasoning",
        "live-status-think-2",
        Some("u-steer"),
    );

    set_thread(&mut ctx, window, &app, steered_old_closed());
    assert_one_thinking(
        &mut ctx,
        window,
        "old reasoning closed",
        "live-status-think-2",
        Some("u-steer"),
    );
}

#[test]
fn an_interrupt_and_a_new_message_keep_one_thinking_row() {
    let mut ctx = headless();
    let (window, app) = open(&mut ctx, reasoning_in_progress());
    assert_one_thinking(
        &mut ctx,
        window,
        "reasoning in progress",
        "live-status-think-1",
        Some("u-1"),
    );

    set_thread(&mut ctx, window, &app, interrupted());
    assert!(
        thinking_rows(&mut ctx, window).len() <= 1,
        "interrupted: at most one Thinking row"
    );

    set_thread(&mut ctx, window, &app, interrupted_new_message());
    assert_one_thinking(
        &mut ctx,
        window,
        "new message",
        "timeline-thinking",
        Some("u-2"),
    );

    set_thread(&mut ctx, window, &app, interrupted_new_reasoning());
    assert_one_thinking(
        &mut ctx,
        window,
        "new reasoning",
        "live-status-think-2",
        Some("u-2"),
    );
}

/// Renders the steer moment offscreen to PNG in dark.
///
/// `CONN_STEER_THINKING_SHOTS_DIR=<dir> CONN_STEER_THINKING_SHOTS_PREFIX=after cargo test -p
/// conn-app render_steer_thinking_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_STEER_THINKING_SHOTS_DIR"]
fn render_steer_thinking_screenshots() {
    let Some(dir) = std::env::var_os("CONN_STEER_THINKING_SHOTS_DIR") else {
        return;
    };
    let prefix =
        std::env::var("CONN_STEER_THINKING_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap_or_else(|error| panic!("no output folder: {error}"));
    let mut ctx = headless();
    for (state, thread) in [
        ("steer", steered()),
        ("steer-new-reasoning", steered_new_reasoning()),
        ("interrupt-new-message", interrupted_new_message()),
    ] {
        let (window, _app) = open(&mut ctx, thread);
        let image = ctx
            .capture_screenshot(window)
            .unwrap_or_else(|error| panic!("no screenshot: {error}"));
        image
            .save(dir.join(format!("{prefix}-{state}-dark.png")))
            .unwrap_or_else(|error| panic!("no PNG saved: {error}"));
    }
}
