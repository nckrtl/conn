//! The space above and below a settled "Worked for" fold's divider, measured on rendered pixels.
//!
//! Above: from the bottom of the "Worked for" glyphs to the divider. Below: from the divider to
//! the first painted pixel of what follows it (text ink, a row icon, a card's edge). The two are
//! equal (Nick, 2026-11-27), except before a user message, which keeps its own gap.

use std::path::Path;

use conn_state::{EntryTiming, ItemStatus, NoticeLevel, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::TestQueryExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, HeadlessAppContext, Pixels, Point, WindowBounds,
    WindowOptions, px, size,
};

use super::card_shots::settle;
use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 900.0;
const FOLD_LABEL: &str = "Worked for 3s";
const PARAGRAPH: &str = "Engine tests pass. Checking the server checks log.";

fn headless() -> HeadlessAppContext {
    HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    )
}

fn user(id: &str, text: &str, by_agent: bool) -> TimelineEntry {
    TimelineEntry::User {
        id: id.to_owned(),
        text: text.to_owned(),
        created_by_agent: by_agent,
        sender: None,
        created_at: None,
        attachments: Vec::new(),
        is_steer: false,
        review_comments: Vec::new(),
        run_id: Some("run-1".to_owned()),
    }
}

fn assistant(id: &str) -> TimelineEntry {
    TimelineEntry::Assistant {
        id: id.to_owned(),
        markdown: PARAGRAPH.to_owned(),
        streaming: false,
        created_at: None,
        run_id: Some("run-1".to_owned()),
        status: ItemStatus::Completed,
    }
}

fn tool(id: &str) -> TimelineEntry {
    TimelineEntry::Tool {
        id: id.to_owned(),
        kind: "command".to_owned(),
        title: "cargo test -p conn-app".to_owned(),
        detail: None,
        status: ItemStatus::Completed,
        output_omitted: false,
    }
}

fn notice(id: &str, level: NoticeLevel) -> TimelineEntry {
    TimelineEntry::Notice {
        id: id.to_owned(),
        text: "Context compacted 120k to 40k tokens".to_owned(),
        level,
    }
}

/// What follows the fold's divider.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    /// An agent paragraph.
    AgentText,
    /// The fold is open: its tool rows.
    ToolRows,
    /// An agent-sent message, which shows as a card.
    Card,
    Divider,
    Warning,
    Error,
    /// A user message, which keeps its own gap.
    User,
}

impl Kind {
    // No "Working" row: while the run goes on, the trailing group is live, with no divider.
    const ALL: [Self; 7] = [
        Self::AgentText,
        Self::ToolRows,
        Self::Card,
        Self::Divider,
        Self::Warning,
        Self::Error,
        Self::User,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::AgentText => "agent paragraph",
            Self::ToolRows => "tool row (open fold)",
            Self::Card => "card",
            Self::Divider => "divider pill",
            Self::Warning => "warning notice",
            Self::Error => "error notice",
            Self::User => "user message",
        }
    }

    fn next(self) -> Option<TimelineEntry> {
        match self {
            Self::AgentText => Some(assistant("next")),
            Self::ToolRows => None,
            Self::Card => Some(user("next", "Please check the fold divider gap.", true)),
            Self::Divider => Some(notice("next", NoticeLevel::Info)),
            Self::Warning => Some(notice("next", NoticeLevel::Warning)),
            Self::Error => Some(notice("next", NoticeLevel::Error)),
            Self::User => Some(user("next", "A message after the fold", false)),
        }
    }
}

fn thread(kind: Kind) -> (ThreadState, Vec<String>) {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![user("ask", "Run the tests", false), tool("t1"), tool("t2")];
    thread.entries.extend(kind.next());
    // A paragraph closes the turn, so the fold is never the last row.
    if matches!(kind, Kind::ToolRows) {
        thread.entries.push(assistant("after"));
    }
    for id in ["t1", "t2"] {
        thread.entry_timings.insert(
            id.to_owned(),
            EntryTiming {
                run_id: Some("run-1".to_owned()),
                started_at_ms: Some(0),
                completed_at_ms: Some(3_000),
            },
        );
    }
    let expand = if kind == Kind::ToolRows {
        vec!["work-group-t1".to_owned()]
    } else {
        Vec::new()
    };
    (thread, expand)
}

fn open(
    ctx: &mut HeadlessAppContext,
    theme_id: &str,
    thread: ThreadState,
    expand: &[String],
) -> AnyWindowHandle {
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
            {
                let tokens = tokens.clone();
                move |window, cx| cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
            },
        )
        .expect("a window")
    });
    ctx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
            let chat = app.chat_for_test();
            chat.update(cx, |chat, cx| {
                for id in expand {
                    chat.toggle_expanded(id, cx);
                }
            });
        });
    });
    settle(ctx, window);
    window
}

fn differs(a: [u8; 4], b: [u8; 4]) -> bool {
    let sum: i32 = (0..3)
        .map(|i| (i32::from(a[i]) - i32::from(b[i])).abs())
        .sum();
    sum >= 9
}

fn element_bounds(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    id: &str,
) -> Bounds<Pixels> {
    ctx.update_window(window, |_, w, _| {
        w.elements()
            .iter()
            .find(|e| e.path().last().is_some_and(|last| last.to_string() == id))
            .map(|e| e.bounds())
    })
    .expect("a window")
    .unwrap_or_else(|| {
        let ids = ctx
            .update_window(window, |_, w, _| {
                w.elements()
                    .iter()
                    .filter_map(|e| e.path().last().map(ToString::to_string))
                    .collect::<Vec<_>>()
            })
            .expect("a window");
        panic!("no element {id} in {ids:?}")
    })
}

/// The visible space above and below the fold's divider, in logical pixels.
fn gaps(ctx: &mut HeadlessAppContext, window: AnyWindowHandle) -> (f32, f32) {
    let header = element_bounds(ctx, window, "work-header-work-group-t1");
    let label = ctx
        .update_window(window, |_, w, _| w.find_by_label(FOLD_LABEL).bounds())
        .expect("a window");
    let lane = element_bounds(ctx, window, "chat-composer-card");
    let image = ctx.capture_screenshot(window).expect("a screenshot");
    let scale = image.width() as f32 / WIDTH_PX;
    let at = |x: f32, y: u32| image.get_pixel((x * scale) as u32, y).0;
    // The page is flat in the margin left of the lane.
    let bg = image
        .get_pixel(
            ((f32::from(lane.left()) - 8.0) * scale) as u32,
            (f32::from(header.top()) * scale) as u32,
        )
        .0;
    let ink = |y: u32, x0: f32, x1: f32| {
        let mut x = x0;
        while x < x1 {
            if differs(at(x, y), bg) {
                return true;
            }
            x += 1.0 / scale;
        }
        false
    };
    // The divider is the header's 1px bottom border.
    let divider_top = f32::from(header.bottom()) - 1.0;
    let divider_bottom = f32::from(header.bottom());
    // Above: the label's glyphs only, not its 14px chevron and 4px gap.
    let text_x1 = f32::from(label.right()) - 18.0;
    let above_from = (divider_top * scale).floor() as u32;
    let glyph_bottom = (0..above_from)
        .rev()
        .find(|y| ink(*y, f32::from(lane.left()), text_x1))
        .expect("the label above the divider");
    let above = divider_top - (glyph_bottom + 1) as f32 / scale;
    let below_from = (divider_bottom * scale).ceil() as u32;
    let next_top = (below_from..image.height())
        .find(|y| ink(*y, f32::from(lane.left()), f32::from(lane.right())))
        .expect("something below the divider");
    let below = next_top as f32 / scale - divider_bottom;
    (above, below)
}

/// The space under the divider equals the space above it, for everything that can follow a
/// fold. A user message keeps its own gap (#449).
#[test]
fn the_fold_divider_has_the_same_gap_above_and_below() {
    let mut ctx = headless();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for kind in Kind::ALL {
        let (thread, expand) = thread(kind);
        let window = open(&mut ctx, "dark-ocean", thread, &expand);
        let (above, below) = gaps(&mut ctx, window);
        rows.push(format!("| {} | {above:.1} | {below:.1} |", kind.name()));
        let want = if kind == Kind::User {
            super::USER_MESSAGE_GAP_PX
        } else {
            above
        };
        if (below - want).abs() > 1.0 {
            failures.push(format!(
                "{}: {above:.1} above, {below:.1} below, want {want:.1}",
                kind.name()
            ));
        }
    }
    let table = format!(
        "| after the fold | above (px) | below (px) |\n|---|---:|---:|\n{}\n",
        rows.join("\n")
    );
    eprintln!("{table}");
    if let Some(path) = std::env::var_os("CONN_FOLD_GAP_TABLE") {
        std::fs::write(path, &table).expect("a written table");
    }
    assert!(
        failures.is_empty(),
        "uneven fold gaps:\n{}\n{table}",
        failures.join("\n")
    );
}

/// Renders a fold before a paragraph and an open fold before its tool rows, dark and light.
///
/// `CONN_FOLD_GAP_SHOTS_DIR=<dir> CONN_FOLD_GAP_SHOTS_PREFIX=after cargo test -p conn-app
/// render_fold_gap_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_FOLD_GAP_SHOTS_DIR"]
fn render_fold_gap_screenshots() {
    let Some(dir) = std::env::var_os("CONN_FOLD_GAP_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_FOLD_GAP_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = headless();
    for theme in ["dark-ocean", "t3-code-light"] {
        let shade = if theme == "t3-code-light" {
            "light"
        } else {
            "dark"
        };
        for (kind, scene) in [
            (Kind::AgentText, "paragraph"),
            (Kind::ToolRows, "tool-rows"),
        ] {
            let (thread, expand) = thread(kind);
            let window = open(&mut ctx, theme, thread, &expand);
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("{prefix}-{scene}-{shade}.png")))
                .expect("a saved PNG");
        }
    }
}
