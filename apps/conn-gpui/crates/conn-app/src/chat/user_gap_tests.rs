//! The space above and below a user message, measured on rendered pixels.
//!
//! From the bubble's outer edge to the first painted pixel of its neighbour (text ink, a divider
//! hairline, another bubble's surface). Hover bars are invisible at rest, so the space they
//! reserve counts, as it does on screen.

use std::path::Path;

use conn_state::{EntryTiming, ItemStatus, NoticeLevel, ThreadState, TimelineEntry};
use conn_theme::Tokens;
use gpui_kit::test::TestQueryExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, HeadlessAppContext, Point, WindowBounds,
    WindowOptions, px, size,
};

use super::card_shots::{bounds_of, settle};
use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 1300.0;
const TARGET: &str = "Gap target";
/// The user message's own gap on both sides, in logical pixels.
const GAP_PX: f32 = super::USER_MESSAGE_GAP_PX;

fn headless() -> HeadlessAppContext {
    HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    )
}

fn user(id: &str, text: &str) -> TimelineEntry {
    TimelineEntry::User {
        id: id.to_owned(),
        text: text.to_owned(),
        created_by_agent: false,
        sender: None,
        created_at: None,
        attachments: Vec::new(),
        is_steer: false,
        review_comments: Vec::new(),
        run_id: Some("run-1".to_owned()),
    }
}

/// Caps only, so the ink runs from cap height to baseline, with no descender.
fn assistant(id: &str, run: Option<&str>) -> TimelineEntry {
    TimelineEntry::Assistant {
        id: id.to_owned(),
        markdown: "HEIGHT OF THIS LINE".to_owned(),
        streaming: false,
        created_at: None,
        run_id: run.map(str::to_owned),
        status: ItemStatus::Completed,
    }
}

fn tool(id: &str, status: ItemStatus) -> TimelineEntry {
    TimelineEntry::Tool {
        id: id.to_owned(),
        kind: "command".to_owned(),
        title: "cargo test -p conn-app".to_owned(),
        detail: None,
        status,
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

/// What sits next to the user message.
#[derive(Clone, Copy, Debug)]
enum Kind {
    /// The run's last paragraph: its hover bar is reserved under it.
    AgentText,
    /// A paragraph with more of the run after it, so no hover bar.
    AgentTextMidRun,
    /// A settled, collapsed "Worked for" header with its divider.
    FoldHeader,
    /// A settled, expanded group: header, divider and tool rows.
    ToolRows,
    /// The info divider pill.
    Divider,
    Warning,
    Error,
    /// Another message from the user, which groups with it.
    User,
    /// The live group: thought preview and the running tool.
    LiveWork,
    /// The "Working for" row.
    Working,
}

impl Kind {
    const ALL: [Self; 10] = [
        Self::AgentText,
        Self::AgentTextMidRun,
        Self::FoldHeader,
        Self::ToolRows,
        Self::Divider,
        Self::Warning,
        Self::Error,
        Self::User,
        Self::LiveWork,
        Self::Working,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::AgentText => "agent text",
            Self::AgentTextMidRun => "agent text (mid-run)",
            Self::FoldHeader => "fold header (\"Worked for\")",
            Self::ToolRows => "tool rows (expanded group)",
            Self::Divider => "divider pill",
            Self::Warning => "warning notice",
            Self::Error => "error notice",
            Self::User => "user message",
            Self::LiveWork => "live tool row",
            Self::Working => "working row",
        }
    }

    /// The entries that make this neighbour, with ids unique to `tag`. `above` is whether it
    /// sits above the message. `None` where the timeline never puts it on that side.
    fn entries(self, tag: &str, above: bool) -> Option<Vec<TimelineEntry>> {
        let id = |name: &str| format!("{name}-{tag}");
        Some(match self {
            Self::AgentText => vec![assistant(&id("a"), None)],
            Self::AgentTextMidRun => {
                if above {
                    vec![assistant(&id("a"), Some("run-mid"))]
                } else {
                    vec![
                        assistant(&id("a"), Some("run-mid")),
                        assistant(&id("b"), Some("run-mid")),
                    ]
                }
            }
            Self::FoldHeader | Self::ToolRows => vec![
                tool(&id("t1"), ItemStatus::Completed),
                tool(&id("t2"), ItemStatus::Completed),
            ],
            Self::Divider => vec![notice(&id("n"), NoticeLevel::Info)],
            Self::Warning => vec![notice(&id("n"), NoticeLevel::Warning)],
            Self::Error => vec![notice(&id("n"), NoticeLevel::Error)],
            Self::User => vec![user(&id("u"), "A neighbouring message")],
            // A live group and the working row are always last.
            Self::LiveWork => {
                if above {
                    return None;
                }
                vec![tool(&id("t1"), ItemStatus::Running)]
            }
            Self::Working => {
                if above {
                    return None;
                }
                Vec::new()
            }
        })
    }

    fn live(self) -> bool {
        matches!(self, Self::LiveWork | Self::Working)
    }

    /// Group ids to open.
    fn expand(self, tag: &str) -> Vec<String> {
        if matches!(self, Self::ToolRows) {
            vec![format!("work-group-t1-{tag}")]
        } else {
            Vec::new()
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Side {
    Above,
    Below,
}

fn thread(kind: Kind, side: Side) -> (ThreadState, Vec<String>) {
    let tag = if side == Side::Above { "up" } else { "down" };
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.working = kind.live();
    let neighbour = kind
        .entries(tag, side == Side::Above)
        .unwrap_or_else(|| panic!("{kind:?} has no {tag} side"));
    let target = user("target", TARGET);
    thread.entries = if side == Side::Above {
        neighbour.into_iter().chain([target]).collect()
    } else {
        std::iter::once(target).chain(neighbour).collect()
    };
    for entry in &thread.entries {
        if matches!(entry, TimelineEntry::Tool { .. }) {
            thread.entry_timings.insert(
                entry.id().to_owned(),
                EntryTiming {
                    run_id: Some("run-1".to_owned()),
                    started_at_ms: Some(0),
                    completed_at_ms: (!kind.live()).then_some(3_000),
                },
            );
        }
    }
    (thread, kind.expand(tag))
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

/// The space between the bubble's outer edge and the first painted pixel on `side`, in
/// logical pixels.
fn gap(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, side: Side) -> f32 {
    let bubble = bounds_of(ctx, window, TARGET);
    // The composer card spans the content lane.
    let lane = ctx
        .update_window(window, |_, w, _| {
            w.elements()
                .iter()
                .find(|e| {
                    e.path()
                        .last()
                        .is_some_and(|id| id.to_string() == "chat-composer-card")
                })
                .map(|e| e.bounds())
        })
        .expect("a window")
        .expect("a composer card");
    let image = ctx.capture_screenshot(window).expect("a screenshot");
    let scale = image.width() as f32 / WIDTH_PX;
    let at = |x: f32, y: u32| image.get_pixel((x * scale) as u32, y).0;
    // The page is flat beside the lane, right of the bubble.
    let bg = image
        .get_pixel(
            ((f32::from(bubble.right()) + 10.0) * scale) as u32,
            (f32::from(bubble.center().y) * scale) as u32,
        )
        .0;
    let x0 = f32::from(lane.left());
    let x1 = f32::from(bubble.right()) - 2.0;
    let ink = |y: u32| {
        let mut x = x0;
        while x < x1 {
            if differs(at(x, y), bg) {
                return true;
            }
            x += 1.0 / scale;
        }
        false
    };
    match side {
        Side::Below => {
            let start = (f32::from(bubble.bottom()) * scale).ceil() as u32;
            let y = (start..image.height())
                .find(|y| ink(*y))
                .expect("something below the message");
            y as f32 / scale - f32::from(bubble.bottom())
        }
        Side::Above => {
            let start = (f32::from(bubble.top()) * scale).floor() as u32;
            let y = (0..start)
                .rev()
                .find(|y| ink(*y))
                .expect("something above the message");
            f32::from(bubble.top()) - (y + 1) as f32 / scale
        }
    }
}

fn measure(ctx: &mut HeadlessAppContext, kind: Kind) -> (Option<f32>, Option<f32>) {
    let mut one = |side: Side| {
        kind.entries("probe", side == Side::Above)?;
        let (thread, expand) = thread(kind, side);
        let window = open(ctx, "dark-ocean", thread, &expand);
        Some(gap(ctx, window, side))
    };
    (one(Side::Above), one(Side::Below))
}

/// Above equals below, for every neighbour a user message can have, and both are the one gap.
#[test]
fn a_user_message_has_the_same_gap_above_and_below_every_neighbour() {
    let mut ctx = headless();
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for kind in Kind::ALL {
        let (above, below) = measure(&mut ctx, kind);
        let show = |gap: Option<f32>| gap.map_or("n/a".to_owned(), |g| format!("{g:.1}"));
        rows.push(format!(
            "| {} | {} | {} |",
            kind.name(),
            show(above),
            show(below)
        ));
        if let (Some(above), Some(below)) = (above, below)
            && (above - below).abs() > 1.0
        {
            failures.push(format!(
                "{}: {above:.1} above, {below:.1} below",
                kind.name()
            ));
        }
        for (name, value) in [("above", above), ("below", below)] {
            // Consecutive messages of one sender are a group: they stay close.
            if matches!(kind, Kind::User) {
                continue;
            }
            if let Some(value) = value
                && (value - GAP_PX).abs() > 1.0
            {
                failures.push(format!("{} {name}: {value:.1}, not {GAP_PX}", kind.name()));
            }
        }
    }
    let table = format!(
        "| neighbour | above (px) | below (px) |\n|---|---:|---:|\n{}\n",
        rows.join("\n")
    );
    eprintln!("{table}");
    if let Some(path) = std::env::var_os("CONN_USER_GAP_TABLE") {
        std::fs::write(path, &table).expect("a written table");
    }
    assert!(
        failures.is_empty(),
        "uneven gaps:\n{}\n{table}",
        failures.join("\n")
    );
}

/// A thread with every kind of row next to a user message.
fn mixed_thread() -> (ThreadState, Vec<String>) {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![
        assistant("a-1", None),
        user("u-1", "First message, after a paragraph"),
        tool("t-1", ItemStatus::Completed),
        tool("t-2", ItemStatus::Completed),
        user("u-2", "Second message, after a fold header"),
        notice("n-1", NoticeLevel::Info),
        user("u-3", "Third message, after a divider"),
        assistant("a-2", None),
        user("u-4", "Fourth message"),
        user("u-5", "Fifth message, grouped with the fourth"),
        tool("t-3", ItemStatus::Completed),
        assistant("a-3", None),
    ];
    for id in ["t-1", "t-2", "t-3"] {
        thread.entry_timings.insert(
            id.to_owned(),
            EntryTiming {
                run_id: Some("run-1".to_owned()),
                started_at_ms: Some(0),
                completed_at_ms: Some(3_000),
            },
        );
    }
    (thread, Vec::new())
}

/// Renders a thread of mixed rows offscreen, dark.
///
/// `CONN_USER_GAP_SHOTS_DIR=<dir> CONN_USER_GAP_SHOTS_PREFIX=after cargo test -p conn-app
/// render_user_message_gap_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_USER_GAP_SHOTS_DIR"]
fn render_user_message_gap_screenshots() {
    let Some(dir) = std::env::var_os("CONN_USER_GAP_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_USER_GAP_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = headless();
    let (thread, expand) = mixed_thread();
    let window = open(&mut ctx, "dark-ocean", thread, &expand);
    let image = ctx.capture_screenshot(window).expect("a screenshot");
    image
        .save(dir.join(format!("{prefix}-dark.png")))
        .expect("a saved PNG");
}
