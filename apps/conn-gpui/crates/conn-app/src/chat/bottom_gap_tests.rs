//! The gap between the last timeline row and the composer card.

use conn_state::{EntryTiming, ItemStatus, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, Point, WindowBounds,
    WindowOptions, px, size,
};

use super::card_shots::{hover, settle};
use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;

fn user(id: &str, text: &str, run: &str) -> TimelineEntry {
    TimelineEntry::User {
        id: id.to_owned(),
        text: text.to_owned(),
        created_by_agent: false,
        sender: None,
        created_at: None,
        attachments: Vec::new(),
        is_steer: false,
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

fn tool(id: &str, title: &str, status: ItemStatus) -> TimelineEntry {
    TimelineEntry::Tool {
        id: id.to_owned(),
        kind: "command".to_owned(),
        title: title.to_owned(),
        detail: None,
        status,
        output_omitted: false,
    }
}

fn timing(thread: &mut ThreadState, id: &str, start: i64, done: bool) {
    thread.entry_timings.insert(
        id.to_owned(),
        EntryTiming {
            run_id: Some("run-1".to_owned()),
            started_at_ms: Some(start),
            completed_at_ms: done.then_some(start + 3_000),
        },
    );
}

const LONG: &str = "Fix A, the rendering fix, is ready as a PR. I have sent it to the PR manager and merged it into your dev app. The merge had no conflicts, and it is rebuilding now.\n\nWith a working thread open, the app now draws 30 frames a second instead of 120.";

/// Earlier turns, enough to fill the window so the timeline scrolls.
fn history() -> Vec<TimelineEntry> {
    (0..6)
        .flat_map(|n| {
            [
                user(
                    &format!("hu-{n}"),
                    "An earlier question.",
                    &format!("h-{n}"),
                ),
                assistant(&format!("ha-{n}"), LONG, &format!("h-{n}")),
            ]
        })
        .collect()
}

/// A finished turn: a message, some work, then the final paragraph.
fn idle_thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = history();
    thread.entries.extend([
        user("u-1", "Run the tests and tell me what happened.", "run-1"),
        tool("tool-1", "cargo test -p conn-app", ItemStatus::Completed),
        assistant("answer-1", LONG, "run-1"),
    ]);
    timing(&mut thread, "tool-1", 0, true);
    thread
}

/// A live turn that has only started thinking: the "Working" row and "Thinking" show last.
fn running_thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.working = true;
    thread.entries = history();
    thread.entries.extend([
        user("u-1", "Run the tests and tell me what happened.", "run-1"),
        assistant("answer-1", LONG, "run-1"),
        user("u-2", "Now check the idle gap too.", "run-2"),
    ]);
    thread
}

/// A hidden offscreen window showing `thread`, with the app so a test can change the thread later.
fn open(
    ctx: &mut HeadlessAppContext,
    theme_id: &str,
    thread: ThreadState,
) -> (AnyWindowHandle, Entity<ConnApp>) {
    let theme = conn_theme::theme_by_id(theme_id)
        .unwrap_or_else(|| panic!("{theme_id} is not a built-in theme"));
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
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        });
    });
    settle(ctx, window);
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

/// The bounds of the element with the id `id`.
fn bounds_by_id(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    id: &str,
) -> Bounds<gpui_kit::Pixels> {
    ctx.update_window(window, |_, w, _| {
        w.elements()
            .iter()
            .find(|e| e.path().last().is_some_and(|last| last.to_string() == id))
            .unwrap_or_else(|| panic!("no element with the id `{id}`"))
            .bounds()
    })
    .unwrap_or_else(|error| panic!("no window: {error}"))
}

/// Distance from the bottom of the element `content` to the top of the composer card.
fn gap_below(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, content: &str) -> f32 {
    let content = bounds_by_id(ctx, window, content);
    let card = bounds_by_id(ctx, window, "chat-composer-card");
    f32::from(card.top()) - f32::from(content.bottom())
}

/// The middle of the element `id`, where a pointer hovers it.
fn center_of(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    id: &str,
) -> Point<gpui_kit::Pixels> {
    bounds_by_id(ctx, window, id).center()
}

/// Scrolls the timeline by `dy` pixels, as a trackpad does; a negative `dy` scrolls toward the end.
fn scroll_timeline(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, dy: f32) {
    let at = Point::new(px(WIDTH_PX / 2.0 + 120.0), px(HEIGHT_PX / 3.0));
    ctx.update_window(window, |_, w, c| {
        w.render_frame(c);
        w.dispatch_event(
            gpui_kit::InputEvent::to_platform_input(gpui_kit::ScrollEvent {
                position: at,
                delta: gpui_kit::ScrollDelta::Pixels(Point::new(px(0.0), px(dy))),
                modifiers: w.modifiers(),
                touch_phase: gpui_kit::TouchPhase::Moved,
                ..Default::default()
            }),
            c,
        );
    })
    .unwrap_or_else(|error| panic!("no scroll: {error}"));
    settle(ctx, window);
}

fn headless() -> HeadlessAppContext {
    HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    )
}

fn assert_gap(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() <= 1.0,
        "{what}: {actual}px is not the running gap, {expected}px"
    );
}

/// The running thread's gap, from the "Thinking" row to the composer. Nick likes it: it is the
/// one gap for every state.
fn running_gap(ctx: &mut HeadlessAppContext, theme: &str) -> f32 {
    let (window, _app) = open(ctx, theme, running_thread());
    let gap = gap_below(ctx, window, "timeline-thinking");
    assert_gap(gap, 28.0, "running gap in the window");
    gap
}

/// A thread whose last row is the final paragraph sits as far above the composer as the
/// "Thinking" row does, in dark and light.
#[test]
fn idle_message_gap_matches_the_running_gap() {
    let mut ctx = headless();
    for theme in ["dark-ocean", "t3-code-light"] {
        let running = running_gap(&mut ctx, theme);
        let (window, _app) = open(&mut ctx, theme, idle_thread());
        let idle = gap_below(&mut ctx, window, "assistant-actions-answer-1");
        assert_gap(idle, running, &format!("{theme}: idle message actions"));
    }
}

/// The turn ends while the window shows it: the gap before and after is the same, and the last
/// paragraph stays at the end of the scroll.
#[test]
fn gap_holds_when_a_running_turn_ends() {
    let mut ctx = headless();
    let mut live = idle_thread();
    live.working = true;
    let (window, app) = open(&mut ctx, "dark-ocean", live);
    let running = gap_below(&mut ctx, window, "timeline-thinking");
    assert_gap(running, 28.0, "live gap");
    set_thread(&mut ctx, window, &app, idle_thread());
    let idle = gap_below(&mut ctx, window, "assistant-actions-answer-1");
    assert_gap(idle, running, "gap after the turn ends");
    // And back: a new turn starts under the same thread.
    let mut next = idle_thread();
    next.working = true;
    next.entries.push(user("u-2", "Go again.", "run-2"));
    set_thread(&mut ctx, window, &app, next);
    let again = gap_below(&mut ctx, window, "timeline-thinking");
    assert_gap(again, running, "gap when the next turn starts");
}

/// Whatever the last row is, the gap is the same.
#[test]
fn every_last_row_sits_at_the_running_gap() {
    let mut ctx = headless();
    let running = running_gap(&mut ctx, "dark-ocean");

    // A user message is last.
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = history();
    thread
        .entries
        .push(user("u-9", "Is anyone there?", "run-9"));
    let (window, _app) = open(&mut ctx, "dark-ocean", thread);
    let gap = gap_below(&mut ctx, window, "user-actions-u-9");
    assert_gap(gap, running, "last user message");

    // A settled "Worked for" fold is last.
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = history();
    thread.entries.extend([
        user("u-1", "Run it.", "run-1"),
        tool("tool-1", "cargo test -p conn-app", ItemStatus::Completed),
    ]);
    timing(&mut thread, "tool-1", 0, true);
    let (window, _app) = open(&mut ctx, "dark-ocean", thread);
    let gap = gap_below(&mut ctx, window, "work-header-work-group-tool-1");
    assert_gap(gap, running, "last work fold");
}

/// Renders the running and idle states offscreen to PNG in dark.
///
/// `CONN_BOTTOM_GAP_SHOTS_DIR=<dir> CONN_BOTTOM_GAP_SHOTS_PREFIX=after cargo test -p conn-app
/// render_bottom_gap_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_BOTTOM_GAP_SHOTS_DIR"]
fn render_bottom_gap_screenshots() {
    let Some(dir) = std::env::var_os("CONN_BOTTOM_GAP_SHOTS_DIR") else {
        return;
    };
    let prefix =
        std::env::var("CONN_BOTTOM_GAP_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap_or_else(|error| panic!("no output folder: {error}"));
    let mut ctx = headless();
    for (state, thread) in [("running", running_thread()), ("idle", idle_thread())] {
        let (window, _app) = open(&mut ctx, "dark-ocean", thread);
        let content = if state == "running" {
            "timeline-thinking"
        } else {
            // Hover the last message, as Nick's pointer does, so its actions row shows.
            let at = center_of(&mut ctx, window, "assistant-body-answer-1");
            hover(&mut ctx, window, at);
            "assistant-actions-answer-1"
        };
        eprintln!(
            "{prefix} {state}: gap {}px",
            gap_below(&mut ctx, window, content)
        );
        let image = ctx
            .capture_screenshot(window)
            .unwrap_or_else(|error| panic!("no screenshot: {error}"));
        image
            .save(dir.join(format!("{prefix}-{state}-dark.png")))
            .unwrap_or_else(|error| panic!("no PNG saved: {error}"));
    }
}

/// The last message's actions row (copy, fork, time) is content: hovered or not, it ends the
/// running gap above the composer, and it never overlaps the message or the composer.
#[test]
fn last_message_actions_row_sits_at_the_running_gap() {
    let mut ctx = headless();
    let running = running_gap(&mut ctx, "dark-ocean");
    let (window, _app) = open(&mut ctx, "dark-ocean", idle_thread());
    let before = gap_below(&mut ctx, window, "assistant-actions-answer-1");
    assert_gap(before, running, "actions row, not hovered");

    let at = center_of(&mut ctx, window, "assistant-body-answer-1");
    hover(&mut ctx, window, at);
    let body = bounds_by_id(&mut ctx, window, "assistant-body-answer-1");
    let actions = bounds_by_id(&mut ctx, window, "assistant-actions-answer-1");
    let card = bounds_by_id(&mut ctx, window, "chat-composer-card");
    assert!(
        actions.top() >= body.bottom(),
        "the actions row overlaps the message: {actions:?} vs {body:?}"
    );
    assert!(
        actions.bottom() < card.top(),
        "the actions row reaches the composer: {actions:?} vs {card:?}"
    );
    let hovered = gap_below(&mut ctx, window, "assistant-actions-answer-1");
    assert_gap(hovered, running, "actions row, hovered");
    assert!(
        (hovered - before).abs() <= 0.5,
        "hovering moved the row: {before}px, then {hovered}px"
    );
}

/// Scrolled away and back to the end, the whole last row shows, actions row included.
#[test]
fn scrolled_to_the_end_shows_the_whole_last_row() {
    let mut ctx = headless();
    let running = running_gap(&mut ctx, "dark-ocean");
    let (window, _app) = open(&mut ctx, "dark-ocean", idle_thread());
    scroll_timeline(&mut ctx, window, 200.0);
    let away = gap_below(&mut ctx, window, "assistant-actions-answer-1");
    assert!(
        away < -100.0,
        "the timeline did not scroll up: gap {away}px"
    );
    for _ in 0..4 {
        scroll_timeline(&mut ctx, window, -2_000.0);
    }
    let gap = gap_below(&mut ctx, window, "assistant-actions-answer-1");
    assert_gap(gap, running, "actions row at the scroll end");
}
