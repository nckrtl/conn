//! What a drag selection costs on a long thread: the full app window, the real text system.

use std::time::{Duration, Instant};

use conn_state::{ItemStatus, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, HeadlessAppContext, InputEvent as _, MouseButton,
    MouseMoveEvent, Pixels, Point, WindowBounds, WindowOptions, point, px, size,
};

use crate::app::{ConnApp, register_keybindings};

const MESSAGES: usize = 300;

fn long_thread() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    for n in 0..MESSAGES {
        thread.entries.push(TimelineEntry::User {
            id: format!("u-{n}"),
            text: format!("Question {n}: please look at the selection code and tell me more."),
            created_by_agent: false,
            sender: None,
            created_at: Some("2026-11-22T15:00:00.000Z".to_owned()),
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: Some(format!("run-{n}")),
        });
        thread.entries.push(TimelineEntry::Assistant {
            id: format!("a-{n}"),
            markdown: format!(
                "Answer {n}. The selection layer keeps one window-wide selection and every \
                 paragraph registers where it was laid out.\n\nA second paragraph with \
                 `inline code` and a [link](https://example.com) so that the flow has chips \
                 and links in it, as real answers do.\n\n- first item\n- second item with more \
                 words in it\n\n```rust\nfn main() {{\n    println!(\"{n}\");\n}}\n```\n\nA \
                 closing paragraph that wraps over more than one line in the chat lane, so the \
                 highlight covers several rows of text."
            ),
            streaming: false,
            created_at: Some("2026-11-22T15:01:00.000Z".to_owned()),
            run_id: Some(format!("run-{n}")),
            status: ItemStatus::Completed,
        });
    }
    thread
}

/// What `moves` pointer moves cost: the event, the frame drawn after it, and the slowest pair.
struct Timings {
    moves: u32,
    event: Duration,
    frame: Duration,
    worst: Duration,
}

impl std::fmt::Display for Timings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} moves: event avg {:?}, frame avg {:?}, worst event+frame {:?}",
            self.moves,
            self.event / self.moves,
            self.frame / self.moves,
            self.worst
        )
    }
}

/// The pointer `step` moves into the drag: back and forth over 60 steps, up and right from
/// `start`, so a long run stays on screen.
fn drag_point(start: Point<Pixels>, step: u32) -> Point<Pixels> {
    let phase = (step % 120) as f32;
    let offset = if phase < 60.0 { phase } else { 120.0 - phase };
    point(start.x + px(offset * 6.0), start.y - px(offset * 4.0))
}

/// Moves the pointer `moves` times from `start` and draws a frame after each move.
fn time_moves(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    start: Point<Pixels>,
    moves: u32,
    pressed_button: Option<MouseButton>,
) -> Timings {
    let mut timings = Timings {
        moves,
        event: Duration::ZERO,
        frame: Duration::ZERO,
        worst: Duration::ZERO,
    };
    for step in 1..=moves {
        let position = drag_point(start, step);
        ctx.update_window(window, |_, window, cx| {
            let t0 = Instant::now();
            window.dispatch_event(
                MouseMoveEvent {
                    position,
                    pressed_button,
                    modifiers: window.modifiers(),
                }
                .to_platform_input(),
                cx,
            );
            let t1 = Instant::now();
            window.render_frame(cx);
            let t2 = Instant::now();
            timings.event += t1 - t0;
            timings.frame += t2 - t1;
            timings.worst = timings.worst.max(t2 - t0);
        })
        .expect("a frame");
        ctx.run_until_parked();
    }
    timings
}

/// Presses on the last line of an answer near the end of a 300-message thread and drags up
/// through it, timing each move and the frame that shows it; plain pointer moves over the same
/// path give the frame cost without a selection. It opens no window on screen.
///
/// `SELECTION_PERF_MOVES=240 cargo test -p conn-app selection_perf -- --ignored --nocapture`
#[test]
#[ignore = "benchmark: prints timings"]
fn drag_selection_cost_on_a_long_thread() {
    let moves: u32 = std::env::var("SELECTION_PERF_MOVES")
        .ok()
        .and_then(|moves| moves.parse().ok())
        .unwrap_or(120);
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    let theme = conn_theme::theme_by_id("dark-ocean").expect("a built-in theme");
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
                    size(px(1440.0), px(900.0)),
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
            app.set_shell(super::kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), long_thread(), cx);
        });
    });
    for _ in 0..4 {
        ctx.update_window(window, |_, w, c| w.render_frame(c))
            .expect("a frame");
        ctx.run_until_parked();
    }
    // The copy button under the next-to-last answer: the drag starts on the answer's last line,
    // just above it, and runs up through its code block, list and paragraphs.
    let leaf = format!(
        "{:?}",
        gpui_kit::ElementId::from(format!("copy-assistant-a-{}", MESSAGES - 2))
    );
    let actions = ctx
        .update_window(window, |_, window, _| {
            window
                .elements()
                .into_iter()
                .find(|element| {
                    element
                        .path()
                        .last()
                        .is_some_and(|id| format!("{id:?}") == leaf)
                })
                .map(|element| element.bounds())
        })
        .ok()
        .flatten()
        .expect("the answer's copy button on screen");
    let start = point(actions.origin.x + px(8.0), actions.origin.y - px(18.0));
    eprintln!("selection_perf: copy button {actions:?}, press at {start:?}");

    let hover = time_moves(&mut ctx, window, start, moves, None);
    eprintln!("selection_perf: hover {hover}");
    ctx.update_window(window, |_, window, cx| {
        window.pointer_down(start, MouseButton::Left, cx);
    })
    .expect("a press");
    let drag = time_moves(&mut ctx, window, start, moves, Some(MouseButton::Left));
    eprintln!("selection_perf: drag  {drag}");
    let selected = ctx
        .update_window(window, |_, window, cx| {
            window.pointer_move(drag_point(start, 30), Some(MouseButton::Left), cx);
            gpui_kit::base::TextSelection::selected_text(window, cx)
        })
        .unwrap_or_default();
    eprintln!("selection_perf: selected {} bytes", selected.len());
    assert!(!selected.is_empty(), "the drag selects text");
}
