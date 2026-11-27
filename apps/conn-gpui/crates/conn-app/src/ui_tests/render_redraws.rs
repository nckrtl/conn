//! What a working thread costs while it sits on screen: how many frames a second the window
//! draws, which views each frame rebuilds, and how long that takes, with the real text system.
//!
//! The headless platform has no display link, so [`run_display`] plays one: each 120 Hz vsync it
//! moves the clock on (timers fire), runs the next-frame callbacks (as the display link does),
//! and the test platform draws whatever is dirty. A vsync counts as a frame when the root view
//! rendered in it. The vsyncs keep to the wall clock too, because some animations do: the
//! scrollbars fade on `Instant::now`, and asking for a frame each vsync while they run.

use std::time::{Duration, Instant};

use conn_state::{ShellState, ThreadState};
use conn_theme::Tokens;
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, HeadlessAppContext, Point, WindowBounds,
    WindowOptions, px, size,
};

use super::{ThreadSeedSpec, kitchen_sink_shell, kitchen_sink_thread, make_thread_shell};
use crate::app::{ConnApp, register_keybindings};
use crate::render_stats::{self, RenderCounts};

/// One vsync of a 120 Hz (ProMotion) display.
const VSYNC: Duration = Duration::from_nanos(8_333_333);
const VSYNCS_PER_SECOND: u32 = 120;
/// The thread on screen, working.
const WORKING: &str = "thread-working-bg";

/// The kitchen-sink shell plus `extra` active threads, so the sidebar has real work to do.
fn busy_shell(extra: usize) -> ShellState {
    let base = kitchen_sink_shell();
    let ids: Vec<(String, String)> = (0..extra)
        .map(|n| {
            (
                format!("thread-extra-{n}"),
                format!("Background thread number {n}"),
            )
        })
        .collect();
    let mut threads = base.threads.clone();
    threads.extend(ids.iter().map(|(id, title)| {
        make_thread_shell(ThreadSeedSpec {
            id,
            project_id: "proj-parity",
            title,
            status: "completed",
            activity_run_status: None,
            pinned_at: None,
            settled_at: None,
            pending_kind: None,
        })
    }));
    ShellState::from_parts(base.projects, threads, Vec::new(), Some(100))
}

/// The kitchen-sink timeline, on [`WORKING`] and with a turn running: the Working row shimmers.
fn working_thread() -> ThreadState {
    let mut thread = kitchen_sink_thread();
    thread.thread_id = WORKING.to_owned();
    thread.working = true;
    thread
}

/// A 1440×900 `ConnApp` window on the headless platform with Core Text shaping, showing a
/// working thread next to a sidebar of `extra` + 6 threads.
fn mount_working(extra: usize) -> (HeadlessAppContext, AnyWindowHandle, Entity<ConnApp>) {
    mount_working_in("dark-ocean", extra)
}

/// [`mount_working`] in the theme `theme_id`.
fn mount_working_in(
    theme_id: &str,
    extra: usize,
) -> (HeadlessAppContext, AnyWindowHandle, Entity<ConnApp>) {
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
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
            app.set_shell(busy_shell(extra), cx);
            app.set_thread_for_test(WORKING.to_owned(), working_thread(), cx);
        });
    });
    ctx.run_until_parked();
    // Let the first frames settle: images, layout passes, and the scrollbars shown at mount,
    // which ask for a frame every vsync until they have faded (about 2.5 s).
    run_display(&mut ctx, window, 4 * VSYNCS_PER_SECOND);
    (ctx, window, app)
}

/// What `vsyncs` vsyncs of a 120 Hz display drew.
#[derive(Debug)]
struct Drawn {
    vsyncs: u32,
    /// Vsyncs in which the window drew a frame.
    frames: u32,
    renders: RenderCounts,
    /// Wall time spent in the vsyncs: drawing, plus the timers and tasks they ran.
    busy: Duration,
}

impl Drawn {
    fn per_second(&self, count: u64) -> f64 {
        count as f64 * f64::from(VSYNCS_PER_SECOND) / f64::from(self.vsyncs)
    }
}

impl std::fmt::Display for Drawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let seconds = f64::from(self.vsyncs) / f64::from(VSYNCS_PER_SECOND);
        let busy_ms_per_s = self.busy.as_secs_f64() * 1000.0 / seconds;
        write!(
            f,
            "{:.1} frames/s; renders/s: root {:.1}, sidebar {:.1}, header {:.1}, chat {:.1}, \
             right panel {:.1}; {busy_ms_per_s:.0} ms busy per second ({:.1}% of one core), \
             {:.2} ms per frame",
            self.per_second(u64::from(self.frames)),
            self.per_second(self.renders.root),
            self.per_second(self.renders.sidebar),
            self.per_second(self.renders.header),
            self.per_second(self.renders.chat),
            self.per_second(self.renders.right_panel),
            busy_ms_per_s / 10.0,
            self.busy.as_secs_f64() * 1000.0 / f64::from(self.frames.max(1)),
        )
    }
}

/// Plays `vsyncs` vsyncs of a 120 Hz display to the window, at most one per [`VSYNC`] of wall
/// time.
fn run_display(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, vsyncs: u32) -> Drawn {
    let start = render_stats::snapshot();
    let mut frames = 0;
    let mut busy = Duration::ZERO;
    let wall_start = Instant::now();
    for vsync in 0..vsyncs {
        if let Some(early) = (wall_start + VSYNC * vsync).checked_duration_since(Instant::now()) {
            std::thread::sleep(early);
        }
        let before = render_stats::snapshot().root;
        let t0 = Instant::now();
        ctx.advance_clock(VSYNC);
        ctx.run_until_parked();
        ctx.update_window(window, |_, window, cx| {
            window.simulate_next_frame(cx);
        })
        .expect("the window is open");
        ctx.run_until_parked();
        busy += t0.elapsed();
        if render_stats::snapshot().root != before {
            frames += 1;
        }
    }
    Drawn {
        vsyncs,
        frames,
        renders: render_stats::snapshot() - start,
        busy,
    }
}

/// Prints frames, renders and busy time per second for a working thread on screen, with a short
/// and a long sidebar.
///
/// `cargo test -p conn-app render_redraws -- --ignored --nocapture`
#[test]
#[ignore = "benchmark: prints frame rates and timings"]
fn working_thread_frame_cost() {
    let seconds: u32 = std::env::var("RENDER_REDRAWS_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4);
    for extra in [0, 120] {
        // One app per thread: the spinners' frame timers are per thread, and a second app on
        // this one would reuse the first one's entity ids.
        std::thread::spawn(move || {
            let (mut ctx, window, _app) = mount_working(extra);
            let drawn = run_display(&mut ctx, window, seconds * VSYNCS_PER_SECOND);
            eprintln!(
                "render_redraws: {} sidebar threads: {drawn}",
                extra + kitchen_sink_shell().threads.len()
            );
        })
        .join()
        .expect("the benchmark thread finishes");
    }
}

/// A working thread animates its shimmer at 30 fps, not at the display's 120 Hz, and those
/// frames rebuild the chat but not the sidebar or the header.
#[test]
fn a_working_thread_draws_thirty_frames_a_second_and_rebuilds_only_the_chat() {
    let (mut ctx, window, _app) = mount_working(0);
    let drawn = run_display(&mut ctx, window, 2 * VSYNCS_PER_SECOND);
    eprintln!("render_redraws: {drawn}");
    // 30 shimmer frames a second; the sidebar clock and the "Working for" label add a frame now
    // and then when they don't land on a shimmer frame.
    assert!(
        (55..=66).contains(&drawn.frames),
        "the shimmer animates at about 30 fps over 2 s: {drawn}"
    );
    assert!(
        drawn.renders.chat >= 55,
        "the chat redraws its shimmer: {drawn}"
    );
    // The sidebar's live clock ticks once a second; nothing else in it changes.
    assert!(
        drawn.renders.sidebar <= 3,
        "shimmer frames reuse the sidebar: {drawn}"
    );
    assert!(
        drawn.renders.header <= 1,
        "shimmer frames reuse the header: {drawn}"
    );
}

/// With the cached regions, a change to the app still reaches the sidebar and the header on the
/// next frame without a forced refresh: a renamed thread shows its new title in its row, and the
/// header, which draws the open thread's title, rebuilds.
#[test]
fn a_renamed_thread_shows_its_new_title_in_the_sidebar_and_header() {
    let (mut ctx, window, app) = mount_working(0);
    let renamed = "Renamed while the shimmer runs";
    let before = render_stats::snapshot();
    ctx.update(|cx| {
        app.update(cx, |app, cx| {
            let mut shell = busy_shell(0);
            for thread in &mut shell.threads {
                if thread.id == WORKING {
                    thread.title = renamed.to_owned();
                }
            }
            app.set_shell(shell, cx);
        });
    });
    ctx.run_until_parked();
    let renders = render_stats::snapshot() - before;
    assert!(
        renders.sidebar >= 1 && renders.header >= 1,
        "a shell change rebuilds the sidebar and the header: {renders:?}"
    );
    let labels = ctx
        .update_window(window, |_, window, _| {
            window
                .elements()
                .iter()
                .filter_map(|e| e.label().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .expect("the window is open");
    assert!(
        labels.iter().any(|label| label == renamed),
        "the row shows the new title: {labels:?}"
    );
    assert!(
        !labels
            .iter()
            .any(|label| label == "Unselected background working thread"),
        "the old title is gone"
    );
}

/// Whether a row shows `label`, in the frame last drawn: no forced refresh, so a cached region
/// that missed a change still shows the old frame.
fn labelled_now(cx: &mut gpui_kit::TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
    cx.update_window(window, |_, window, _| {
        window.try_find_by_label(label).is_some()
    })
    .unwrap_or(false)
}

/// The jump numbers show and hide in the cached sidebar on the frames that follow, without a
/// forced refresh.
#[gpui_kit::test]
fn the_jump_numbers_reach_the_cached_sidebar(cx: &mut gpui_kit::TestAppContext) {
    let (window, app) = super::mount_kitchen_sink(cx);
    let _ = cx.update_window(window, |_, window, cx| {
        let root = app.read(cx).root_focus_for_test();
        window.focus(&root, cx);
    });
    cx.run_until_parked();
    assert!(
        !labelled_now(cx, window, "⌘1"),
        "no numbers before ⌘ is held"
    );

    let _ = cx.update_window(window, |_, window, cx| {
        window.change_modifiers(
            gpui_kit::Modifiers {
                platform: true,
                ..gpui_kit::Modifiers::default()
            },
            cx,
        );
    });
    cx.executor().advance_clock(Duration::from_millis(250));
    cx.run_until_parked();
    assert!(
        labelled_now(cx, window, "⌘1"),
        "the rows wear their numbers once ⌘ has been held"
    );

    let _ = cx.update_window(window, |_, window, cx| {
        window.change_modifiers(gpui_kit::Modifiers::default(), cx);
    });
    cx.run_until_parked();
    assert!(!labelled_now(cx, window, "⌘1"), "released");
}

/// Renders a working thread offscreen in Dark Ocean and Light twice: as the frame loop draws it,
/// with the cached sidebar and header, and after a forced full rebuild. Only the moving shimmer
/// band may differ between the two. It opens no window on screen and takes no focus.
///
/// `CONN_RENDER_SHOTS_DIR=<dir> cargo test -p conn-app render_working_thread_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_RENDER_SHOTS_DIR"]
fn render_working_thread_screenshots() {
    use gpui_kit::test::TestWindowExt as _;
    let Some(dir) = std::env::var_os("CONN_RENDER_SHOTS_DIR") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("an output folder");
    for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let dir = dir.clone();
        std::thread::spawn(move || {
            let (mut ctx, window, _app) = mount_working_in(theme_id, 0);
            run_display(&mut ctx, window, VSYNCS_PER_SECOND);
            let cached = ctx.capture_screenshot(window).expect("a screenshot");
            ctx.update_window(window, |_, window, cx| window.render_frame(cx))
                .expect("a frame");
            let rebuilt = ctx.capture_screenshot(window).expect("a screenshot");
            let differing: Vec<(u32, u32)> = cached
                .enumerate_pixels()
                .filter(|(x, y, pixel)| rebuilt.get_pixel(*x, *y) != *pixel)
                .map(|(x, y, _)| (x, y))
                .collect();
            let span = |pick: fn(&(u32, u32)) -> u32| {
                let values = differing.iter().map(pick);
                (values.clone().min(), values.max())
            };
            eprintln!(
                "render_redraws: {label}: {} of {} pixels differ between the cached and the \
                 rebuilt frame, x {:?}, y {:?} (device pixels)",
                differing.len(),
                cached.width() * cached.height(),
                span(|p| p.0),
                span(|p| p.1),
            );
            cached
                .save(dir.join(format!("working-{label}.png")))
                .expect("a saved PNG");
            rebuilt
                .save(dir.join(format!("working-{label}-rebuilt.png")))
                .expect("a saved PNG");
        })
        .join()
        .expect("the screenshot thread finishes");
    }
}
