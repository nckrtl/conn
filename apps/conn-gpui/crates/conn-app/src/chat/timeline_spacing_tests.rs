//! The visible space between every pair of timeline blocks, measured on rendered pixels.
//!
//! Each scenario renders a short thread offscreen. For every two neighbouring blocks, the gap
//! runs from the last painted pixel of the first to the first painted pixel of the second (text
//! ink, a row icon, a divider hairline, a card or bubble edge). A hover actions row is invisible
//! at rest, so the space it reserves is part of the gap, as on screen. Paragraph and label text
//! is in capitals, so the ink runs from cap height to baseline.
//!
//! Every gap must equal the rule for its pair (see [`super::timeline_spacing`]), within 1px, in
//! dark and light. So must the space on each side of every "Worked for" and "Working for"
//! divider.

use std::collections::BTreeMap;
use std::path::Path;

use conn_state::{
    BackgroundCommandOutcome, BackgroundWorkItem, BackgroundWorkKind, EntryTiming, ItemStatus,
    NoticeLevel, ThreadState, TimelineEntry, TurnItemStatus,
};
use conn_theme::Tokens;
use gpui_kit::test::TestQueryExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, Pixels, Point,
    WindowBounds, WindowOptions, px, size,
};

use super::cache::VirtualItem;
use super::card_shots::settle;
use super::timeline_spacing::{
    BLOCK_GAP_PX, BODY_INK_BOTTOM_PX, DIVIDER_GAP_PX, GROUPED_USER_GAP_PX,
    PLAIN_LIGHT_CARD_INK_TOP_PX, ROW_GAP_PX, USER_GAP_PX,
};
use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 1100.0;
const LIGHT: &str = "t3-code-light";
const THEMES: [&str; 2] = ["dark-ocean", LIGHT];

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
        run_id: None,
    }
}

fn assistant(id: &str, run: &str) -> TimelineEntry {
    TimelineEntry::Assistant {
        id: id.to_owned(),
        markdown: "THE HEIGHT OF THIS LINE".to_owned(),
        streaming: false,
        created_at: None,
        run_id: Some(run.to_owned()),
        status: ItemStatus::Completed,
    }
}

fn tool(id: &str, status: ItemStatus) -> TimelineEntry {
    TimelineEntry::Tool {
        id: id.to_owned(),
        kind: "command".to_owned(),
        title: "BUILD THE APP".to_owned(),
        detail: None,
        status,
        output_omitted: false,
    }
}

fn notice(id: &str, level: NoticeLevel) -> TimelineEntry {
    TimelineEntry::Notice {
        id: id.to_owned(),
        text: "CONTEXT COMPACTED".to_owned(),
        level,
    }
}

/// A block a scenario puts in the timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Spec {
    /// A paragraph with more of its turn after it: no actions row.
    Paragraph,
    /// The last paragraph of its turn, with its hover actions row reserved under it.
    LastParagraph,
    User,
    /// A message another agent sent, drawn as a card.
    AgentCard,
    Fold,
    OpenFold,
    Divider,
    Warning,
    Error,
    Plan,
    Delegate,
    BackgroundCommand,
    /// Several background commands that ended together, as one card.
    BackgroundWork,
    /// The "Working for" row and its "Thinking" row. Always last.
    Working,
    /// The "Working for" row and the live group under it. Always last.
    Live,
}

impl Spec {
    const ALL: [Self; 15] = [
        Self::Paragraph,
        Self::LastParagraph,
        Self::User,
        Self::AgentCard,
        Self::Fold,
        Self::OpenFold,
        Self::Divider,
        Self::Warning,
        Self::Error,
        Self::Plan,
        Self::Delegate,
        Self::BackgroundCommand,
        Self::BackgroundWork,
        Self::Working,
        Self::Live,
    ];

    fn last_only(self) -> bool {
        matches!(self, Self::Working | Self::Live)
    }

    fn is_group(self) -> bool {
        matches!(self, Self::Fold | Self::OpenFold | Self::Live)
    }
}

/// A thread for the timeline, with the groups to open.
struct Scene {
    thread: ThreadState,
    expand: Vec<String>,
}

impl Scene {
    fn new() -> Self {
        let mut thread = ThreadState::new("thread-selected");
        thread.synchronized = true;
        Self {
            thread,
            expand: Vec::new(),
        }
    }

    fn timed_tool(&mut self, id: &str, live: bool) {
        self.thread.entries.push(tool(
            id,
            if live {
                ItemStatus::Running
            } else {
                ItemStatus::Completed
            },
        ));
        self.thread.entry_timings.insert(
            id.to_owned(),
            EntryTiming {
                run_id: Some("run-1".to_owned()),
                started_at_ms: Some(0),
                completed_at_ms: (!live).then_some(3_000),
            },
        );
    }

    /// Adds `spec` with ids unique to `tag`. A paragraph that must not end its turn gets a
    /// closing paragraph of the same turn at the end, from [`Self::finish`].
    fn push(&mut self, spec: Spec, tag: &str, tails: &mut Vec<String>) {
        let id = |name: &str| format!("{name}-{tag}");
        let entries = &mut self.thread.entries;
        match spec {
            Spec::Paragraph => {
                let run = id("run");
                entries.push(assistant(&id("p"), &run));
                tails.push(run);
            }
            Spec::LastParagraph => entries.push(assistant(&id("p"), &id("run"))),
            Spec::User => entries.push(user(&id("u"), "A MESSAGE", false)),
            Spec::AgentCard => entries.push(user(&id("u"), "CHECK THE GAP", true)),
            Spec::Fold => {
                self.timed_tool(&id("t1"), false);
                self.timed_tool(&id("t2"), false);
            }
            Spec::OpenFold => {
                self.timed_tool(&id("t1"), false);
                self.timed_tool(&id("t2"), false);
                self.expand.push(format!("work-group-{}", id("t1")));
            }
            Spec::Divider => entries.push(notice(&id("n"), NoticeLevel::Info)),
            Spec::Warning => entries.push(notice(&id("n"), NoticeLevel::Warning)),
            Spec::Error => entries.push(notice(&id("n"), NoticeLevel::Error)),
            Spec::Plan => entries.push(TimelineEntry::ProposedPlan {
                id: id("plan"),
                run_id: None,
                title: "PLAN".to_owned(),
                markdown: "SHIP THE SPACING".to_owned(),
                streaming: false,
                status: ItemStatus::Completed,
                created_at: None,
            }),
            Spec::Delegate => entries.push(TimelineEntry::Subagent {
                id: id("d"),
                child_thread_id: None,
                title: "CHECK THE LAB".to_owned(),
                role: "worker".to_owned(),
                status: TurnItemStatus::Completed,
                summary: None,
                remote_child: None,
                created_at: None,
                started_at: None,
                completed_at: None,
            }),
            Spec::BackgroundCommand => entries.push(TimelineEntry::BackgroundCommand {
                id: id("bg"),
                summary: "BUILD FINISHED".to_owned(),
                label: None,
                outcome: BackgroundCommandOutcome::Finished,
                exit_code: Some(0),
                detail: None,
            }),
            Spec::BackgroundWork => {
                let item = |label: &str| BackgroundWorkItem {
                    kind: BackgroundWorkKind::Command,
                    label: Some(label.to_owned()),
                    exit_code: Some(0),
                };
                let items = vec![item("BUILD"), item("CHECK")];
                entries.push(TimelineEntry::BackgroundWork {
                    id: id("bgw"),
                    summary: "BUILD AND CHECK FINISHED".to_owned(),
                    outcome: BackgroundCommandOutcome::Finished,
                    count: items.len(),
                    kind: Some(BackgroundWorkKind::Command),
                    items,
                    detail: None,
                });
            }
            Spec::Working => self.thread.working = true,
            Spec::Live => {
                self.thread.working = true;
                self.timed_tool(&id("live"), true);
            }
        }
    }

    fn finish(mut self, tails: Vec<String>) -> Self {
        if !self.thread.working {
            for (n, run) in tails.into_iter().enumerate() {
                self.thread
                    .entries
                    .push(assistant(&format!("tail-{n}"), &run));
            }
        }
        self
    }

    fn of(specs: &[Spec]) -> Self {
        let mut scene = Self::new();
        let mut tails = Vec::new();
        for (n, spec) in specs.iter().enumerate() {
            scene.push(*spec, &n.to_string(), &mut tails);
        }
        scene.finish(tails)
    }
}

/// Every pair of blocks the timeline can put next to each other, one short thread each.
fn pair_scenes() -> Vec<Scene> {
    let mut scenes = Vec::new();
    for first in Spec::ALL {
        if first.last_only() {
            continue;
        }
        for second in Spec::ALL {
            // Neighbouring tool rows are one group.
            if first.is_group() && second.is_group() {
                continue;
            }
            scenes.push(Scene::of(&[first, second]));
        }
    }
    scenes
}

/// What a rendered block is, by its item and entry.
fn block_name(items: &[VirtualItem], index: usize, chat: &super::ChatView) -> String {
    let rows = chat.cache.rows();
    match &items[index] {
        VirtualItem::LoadEarlier { .. } => "load earlier".to_owned(),
        VirtualItem::User { row_idx, .. } => match &rows[*row_idx].entry {
            TimelineEntry::User {
                created_by_agent: true,
                ..
            } => "agent message card".to_owned(),
            _ => "user message".to_owned(),
        },
        VirtualItem::Assistant { show_meta, .. } => if *show_meta {
            "paragraph + actions row"
        } else {
            "paragraph"
        }
        .to_owned(),
        VirtualItem::WorkGroup { id, has_active, .. } => {
            if *has_active {
                "live group".to_owned()
            } else if chat.expanded_ids.contains(id.as_str()) {
                "fold (open)".to_owned()
            } else {
                "fold".to_owned()
            }
        }
        VirtualItem::Card { row_idx } => match &rows[*row_idx].entry {
            TimelineEntry::ProposedPlan { .. } => "plan card",
            TimelineEntry::Subagent { .. } => "delegate card",
            TimelineEntry::BackgroundCommand { .. } => "background command",
            TimelineEntry::BackgroundWork { .. } => "background commands",
            _ => "card",
        }
        .to_owned(),
        VirtualItem::Approval { .. } => "approval".to_owned(),
        VirtualItem::Notice { row_idx } => match &rows[*row_idx].entry {
            TimelineEntry::Notice {
                level: NoticeLevel::Warning,
                ..
            } => "warning".to_owned(),
            TimelineEntry::Notice { level, .. } if level.is_error() => "error".to_owned(),
            _ => "divider notice".to_owned(),
        },
        VirtualItem::ChangedFiles { .. } => "changed files card".to_owned(),
        VirtualItem::WorktreeSetup { .. } => "worktree setup card".to_owned(),
        VirtualItem::Working => {
            if matches!(
                items.get(index + 1),
                Some(VirtualItem::WorkGroup {
                    has_active: true,
                    ..
                })
            ) {
                "working".to_owned()
            } else {
                "working + thinking".to_owned()
            }
        }
    }
}

/// Whether a block ends on its divider: a closed fold, and the "Working" row over a live group.
fn ends_on_divider(name: &str) -> bool {
    matches!(name, "fold" | "working")
}

/// The visible gap the spacing system wants between two blocks.
fn rule(first: &str, second: &str, light: bool) -> (f32, &'static str) {
    match (first, second) {
        // The one pair whose insets add up to more than the block gap: the reserved hover row
        // over a plain card, whose frame is the page colour in light. A gap never shrinks the
        // hover row (Nick, 2026-11-27).
        ("paragraph + actions row", "plan card") if light => (
            BODY_INK_BOTTOM_PX + super::ASSISTANT_META_HEIGHT_PX + PLAIN_LIGHT_CARD_INK_TOP_PX,
            "hover floor",
        ),
        ("user message", "user message") => (GROUPED_USER_GAP_PX, "grouped"),
        ("user message", _) | (_, "user message") => (USER_GAP_PX, "user"),
        ("warning", "warning") => (ROW_GAP_PX, "row"),
        (first, _) if ends_on_divider(first) => (DIVIDER_GAP_PX, "divider"),
        _ => (BLOCK_GAP_PX, "block"),
    }
}

struct Window {
    handle: AnyWindowHandle,
    app: Entity<ConnApp>,
}

fn open(ctx: &mut HeadlessAppContext, theme_id: &str) -> Window {
    let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
    let tokens = Tokens::derive(&theme);
    let (handle, app) = ctx.update(|cx| {
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
        });
    });
    Window { handle, app }
}

fn show(ctx: &mut HeadlessAppContext, window: &Window, scene: &Scene) {
    let thread = scene.thread.clone();
    let expand = scene.expand.clone();
    ctx.update(|cx| {
        window.app.update(cx, |app, cx| {
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
            let chat = app.chat_for_test();
            chat.update(cx, |chat, cx| {
                for id in &expand {
                    if !chat.expanded_ids.contains(id.as_str()) {
                        chat.toggle_expanded(id, cx);
                    }
                }
            });
        });
    });
    settle(ctx, window.handle);
}

fn differs(a: [u8; 4], b: [u8; 4]) -> bool {
    let sum: i32 = (0..3)
        .map(|i| (i32::from(a[i]) - i32::from(b[i])).abs())
        .sum();
    sum >= 3
}

fn element_bounds(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    id: &str,
) -> Option<Bounds<Pixels>> {
    ctx.update_window(window, |_, w, _| {
        w.elements()
            .iter()
            .find(|e| e.path().last().is_some_and(|last| last.to_string() == id))
            .map(|e| e.bounds())
    })
    .expect("a window")
}

/// One screenshot's ink, row by row, across the content lane.
struct Ink {
    scale: f32,
    /// The share of the lane's width that differs from the page, per physical row.
    coverage: Vec<f32>,
    /// Whether the lane's first 10px hold ink, per physical row: the first glyph of a label.
    lead: Vec<bool>,
}

impl Ink {
    fn capture(ctx: &mut HeadlessAppContext, window: AnyWindowHandle) -> Self {
        let lane = element_bounds(ctx, window, "chat-composer-card").expect("a composer card");
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        let scale = image.width() as f32 / WIDTH_PX;
        let x0 = (f32::from(lane.left()) * scale).round() as u32;
        let x1 = (f32::from(lane.right()) * scale).round() as u32;
        let lead_x1 = x0 + (10.0 * scale) as u32;
        let bg = image
            .get_pixel(x0 - (8.0 * scale) as u32, (60.0 * scale) as u32)
            .0;
        let width = image.width() as usize;
        let raw = image.as_raw();
        let mut coverage = Vec::with_capacity(image.height() as usize);
        let mut lead = Vec::with_capacity(image.height() as usize);
        for y in 0..image.height() as usize {
            let row = &raw[(y * width + x0 as usize) * 4..(y * width + x1 as usize) * 4];
            let mut inked = 0usize;
            let mut lead_ink = false;
            for (x, pixel) in row.as_chunks::<4>().0.iter().enumerate() {
                if differs([pixel[0], pixel[1], pixel[2], pixel[3]], bg) {
                    inked += 1;
                    if x < (lead_x1 - x0) as usize {
                        lead_ink = true;
                    }
                }
            }
            coverage.push(inked as f32 / (x1 - x0) as f32);
            lead.push(lead_ink);
        }
        Self {
            scale,
            coverage,
            lead,
        }
    }

    fn row(&self, y: f32) -> usize {
        ((y * self.scale).round() as usize).min(self.coverage.len())
    }

    fn y(&self, row: usize) -> f32 {
        row as f32 / self.scale
    }

    /// The first inked physical row in `[from, to)`.
    fn first(&self, from: usize, to: usize) -> Option<usize> {
        (from..to.min(self.coverage.len())).find(|y| self.coverage[*y] > 0.0)
    }

    /// The last inked physical row in `[from, to)`.
    fn last(&self, from: usize, to: usize) -> Option<usize> {
        (from..to.min(self.coverage.len()))
            .rev()
            .find(|y| self.coverage[*y] > 0.0)
    }

    /// Full-width hairlines in `[from, to)`: a run of rows inked across the lane, with no ink
    /// next to it on either side.
    fn hairlines(&self, from: usize, to: usize) -> Vec<(usize, usize)> {
        let to = to.min(self.coverage.len());
        let mut lines = Vec::new();
        let mut y = from;
        while y < to {
            if self.coverage[y] >= 0.97 {
                let start = y;
                while y < to && self.coverage[y] >= 0.5 {
                    y += 1;
                }
                let thin = y - start <= (2.0 * self.scale) as usize;
                let clear_above = start == 0 || self.coverage[start - 1] < 0.5;
                if thin && clear_above {
                    lines.push((start, y));
                }
            } else {
                y += 1;
            }
        }
        lines
    }
}

/// One measured gap.
struct Gap {
    first: String,
    second: String,
    gap: f32,
}

/// One measured divider: its label's baseline to the line, and the line to what follows.
struct DividerGap {
    block: String,
    next: String,
    above: f32,
    below: f32,
}

/// The gaps between all neighbouring blocks on screen, and around every divider.
fn measure(ctx: &mut HeadlessAppContext, window: &Window) -> (Vec<Gap>, Vec<DividerGap>) {
    let names: Vec<String> = ctx.update(|cx| {
        let chat = window.app.read(cx).chat_for_test();
        let chat = chat.read(cx);
        let items = chat.cache.items();
        (0..items.len())
            .map(|index| block_name(items, index, chat))
            .collect()
    });
    let ink = Ink::capture(ctx, window.handle);
    let mut blocks = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let Some(bounds) = element_bounds(ctx, window.handle, &format!("chat-vitem-{index}"))
        else {
            continue;
        };
        if f32::from(bounds.size.height) < 1.0 {
            continue;
        }
        blocks.push((name.clone(), bounds));
    }
    let mut gaps = Vec::new();
    let mut dividers = Vec::new();
    for (n, (name, bounds)) in blocks.iter().enumerate() {
        let top = ink.row(f32::from(bounds.top()));
        let bottom = ink.row(f32::from(bounds.bottom()));
        if let Some((next_name, next)) = blocks.get(n + 1) {
            let next_top = ink.row(f32::from(next.top()));
            let next_bottom = ink.row(f32::from(next.bottom()));
            let (Some(last), Some(first)) =
                (ink.last(top, next_top), ink.first(next_top, next_bottom))
            else {
                continue;
            };
            gaps.push(Gap {
                first: name.clone(),
                second: next_name.clone(),
                gap: ink.y(first) - ink.y(last + 1),
            });
        }
        for (line_top, line_bottom) in ink.hairlines(top, bottom) {
            // The label over the line: its first glyph, which has no descender.
            let Some(label) = (top..line_top).rev().find(|y| ink.lead[*y]) else {
                continue;
            };
            let Some(below) = ink.first(line_bottom, ink.coverage.len()) else {
                continue;
            };
            let next = blocks
                .iter()
                .find(|(_, b)| {
                    ink.row(f32::from(b.top())) <= below && below < ink.row(f32::from(b.bottom()))
                })
                .map_or_else(|| "?".to_owned(), |(name, _)| name.clone());
            dividers.push(DividerGap {
                block: name.clone(),
                next,
                above: ink.y(line_top) - ink.y(label + 1),
                below: ink.y(below) - ink.y(line_bottom),
            });
        }
    }
    (gaps, dividers)
}

/// Every pair's gap, in every theme: the table and the failures.
fn audit() -> (String, Vec<String>) {
    let mut ctx = headless();
    let mut failures = Vec::new();
    // (first, second) → per theme
    let mut pairs: BTreeMap<(String, String), Vec<f32>> = BTreeMap::new();
    let mut light_wants: BTreeMap<(String, String), f32> = BTreeMap::new();
    let mut divider_rows: BTreeMap<(String, String), Vec<(f32, f32)>> = BTreeMap::new();
    for theme in THEMES {
        let window = open(&mut ctx, theme);
        for scene in pair_scenes() {
            show(&mut ctx, &window, &scene);
            let (gaps, dividers) = measure(&mut ctx, &window);
            for gap in gaps {
                let (want, _) = rule(&gap.first, &gap.second, theme == LIGHT);
                if (gap.gap - want).abs() > 1.0 {
                    failures.push(format!(
                        "{theme}: {} → {}: {:.1}px, want {want:.1}px",
                        gap.first, gap.second, gap.gap
                    ));
                }
                if theme == LIGHT {
                    light_wants.insert((gap.first.clone(), gap.second.clone()), want);
                }
                pairs
                    .entry((gap.first, gap.second))
                    .or_default()
                    .push(gap.gap);
            }
            for divider in dividers {
                let below_want = if divider.next == "user message" {
                    USER_GAP_PX
                } else {
                    DIVIDER_GAP_PX
                };
                if (divider.above - DIVIDER_GAP_PX).abs() > 1.0
                    || (divider.below - below_want).abs() > 1.0
                {
                    failures.push(format!(
                        "{theme}: {} divider → {}: {:.1}px above, {:.1}px below, want \
                         {DIVIDER_GAP_PX:.1} and {below_want:.1}",
                        divider.block, divider.next, divider.above, divider.below
                    ));
                }
                divider_rows
                    .entry((divider.block, divider.next))
                    .or_default()
                    .push((divider.above, divider.below));
            }
        }
    }
    failures.sort();
    failures.dedup();
    let spread = |values: &[f32]| {
        let min = values.iter().copied().fold(f32::MAX, f32::min);
        let max = values.iter().copied().fold(f32::MIN, f32::max);
        if max - min < 0.5 {
            format!("{min:.1}")
        } else {
            format!("{min:.1}–{max:.1}")
        }
    };
    let mut table =
        String::from("| above | below | gap (px) | rule | want (px) |\n|---|---|---:|---|---:|\n");
    for ((first, second), values) in &pairs {
        let (want, name) = rule(first, second, false);
        let light = light_wants
            .get(&(first.clone(), second.clone()))
            .filter(|light| (**light - want).abs() > 0.5)
            .map_or(String::new(), |light| format!(" (light {light:.1})"));
        table.push_str(&format!(
            "| {first} | {second} | {} | {name} | {want:.1}{light} |\n",
            spread(values)
        ));
    }
    table.push_str(
        "\n| divider in | followed by | label → line (px) | line → next (px) |\n|---|---|---:|---:|\n",
    );
    for ((block, next), values) in &divider_rows {
        let above: Vec<f32> = values.iter().map(|v| v.0).collect();
        let below: Vec<f32> = values.iter().map(|v| v.1).collect();
        table.push_str(&format!(
            "| {block} | {next} | {} | {} |\n",
            spread(&above),
            spread(&below)
        ));
    }
    (table, failures)
}

/// Every neighbouring pair of blocks sits at its rule's gap, and every divider has the same
/// space above and below, in dark and light.
#[test]
fn every_timeline_gap_follows_the_spacing_rules() {
    let (table, failures) = audit();
    eprintln!("{table}");
    if let Some(path) = std::env::var_os("CONN_TIMELINE_SPACING_TABLE") {
        std::fs::write(path, &table).expect("a written table");
    }
    assert!(
        failures.is_empty(),
        "{} gaps break the rules:\n{}\n\n{table}",
        failures.len(),
        failures.join("\n")
    );
}

/// The three scenes from Nick's screenshots and a long mixed thread, dark.
fn screenshot_scenes() -> Vec<(&'static str, Scene)> {
    let mut mixed = Scene::new();
    let mut tails = Vec::new();
    for (n, spec) in [
        Spec::User,
        Spec::Fold,
        Spec::Paragraph,
        Spec::OpenFold,
        Spec::LastParagraph,
        Spec::AgentCard,
        Spec::Fold,
        Spec::Paragraph,
        Spec::Divider,
        Spec::BackgroundCommand,
        Spec::Delegate,
        Spec::LastParagraph,
        Spec::User,
        Spec::User,
        Spec::Paragraph,
        Spec::Plan,
        Spec::Warning,
    ]
    .into_iter()
    .enumerate()
    {
        mixed.push(spec, &n.to_string(), &mut tails);
    }
    let mixed = mixed.finish(tails);
    vec![
        ("working-tool", Scene::of(&[Spec::User, Spec::Live])),
        ("working-thinking", Scene::of(&[Spec::User, Spec::Working])),
        (
            "card-fold-paragraph",
            Scene::of(&[
                Spec::LastParagraph,
                Spec::AgentCard,
                Spec::Fold,
                Spec::Paragraph,
            ]),
        ),
        ("mixed-thread", mixed),
    ]
}

/// Renders the screenshot scenes offscreen to PNG, dark.
///
/// `CONN_TIMELINE_SHOTS_DIR=<dir> CONN_TIMELINE_SHOTS_PREFIX=after cargo test -p conn-app
/// render_timeline_spacing_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_TIMELINE_SHOTS_DIR"]
fn render_timeline_spacing_screenshots() {
    let Some(dir) = std::env::var_os("CONN_TIMELINE_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_TIMELINE_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = headless();
    let window = open(&mut ctx, "dark-ocean");
    for (name, scene) in screenshot_scenes() {
        show(&mut ctx, &window, &scene);
        let image = ctx.capture_screenshot(window.handle).expect("a screenshot");
        image
            .save(dir.join(format!("{prefix}-{name}-dark.png")))
            .expect("a saved PNG");
    }
}
