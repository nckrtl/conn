//! Headless tests of the Tasks panel's empty states and empty lanes, and the offscreen renders of
//! each (`render_notice_screenshots`).

use std::path::Path;

use conn_desktop::orbit::TasksErrorReason;
use conn_desktop::orbit::board::tasks_board_lanes;
use conn_desktop::orbit::client::TasksError;
use conn_desktop::orbit::fixtures::fixture_tasks;
use conn_desktop::orbit::panel::TasksBoardSettings;
use conn_desktop::orbit::tasks::{TaskSummary, TasksPage};
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, Pixels, TestAppContext, px, size,
};

use super::{ListLoadState, TasksPanel};
use crate::panels::empty_state::shots;

const WIDTH_PX: f32 = 520.0;
const HEIGHT_PX: f32 = 700.0;
/// The board needs room for four lanes.
const BOARD_WIDTH_PX: f32 = 900.0;
const BOARD_HEIGHT_PX: f32 = 560.0;

/// How the panel's list stands.
#[derive(Clone)]
enum State {
    None,
    Failed(TasksErrorReason, &'static str),
    NoClient(&'static str),
    /// Only the tasks of the first lane that has any, so the other lanes are empty.
    OneLane(&'static str),
}

fn one_lane_tasks() -> Vec<TaskSummary> {
    let all = fixture_tasks();
    tasks_board_lanes(&all, "", &[])
        .into_iter()
        .find(|lane| !lane.tasks.is_empty())
        .map(|lane| lane.tasks.into_iter().cloned().collect())
        .expect("a lane with tasks")
}

fn set(panel: &mut TasksPanel, state: &State) {
    // Never read the user's saved board settings into a test.
    panel.board_settings = TasksBoardSettings::default();
    panel.unavailable_reason = None;
    panel.query.clear();
    panel.list_state = match state {
        State::None => ListLoadState::Ready(TasksPage {
            tasks: Vec::new(),
            skipped: 0,
            next_cursor: None,
        }),
        State::Failed(reason, message) => ListLoadState::Error(TasksError {
            reason: *reason,
            message: (*message).to_owned(),
        }),
        State::NoClient(reason) => {
            panel.unavailable_reason = Some((*reason).to_owned());
            ListLoadState::Loading
        }
        State::OneLane(query) => {
            panel.query = (*query).to_owned();
            ListLoadState::Ready(TasksPage {
                tasks: one_lane_tasks(),
                skipped: 0,
                next_cursor: None,
            })
        }
    };
}

fn open_panel(
    cx: &mut TestAppContext,
    state: &State,
    (width, height): (f32, f32),
) -> (AnyWindowHandle, Entity<TasksPanel>) {
    let tokens = shots::tokens_for("dark-ocean");
    let (window, panel) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            gpui_kit::WindowOptions {
                window_bounds: Some(gpui_kit::WindowBounds::Windowed(Bounds::new(
                    gpui_kit::Point::default(),
                    size(px(width), px(height)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| TasksPanel::new(tokens, window, cx)),
        )
        .expect("a window")
    });
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            set(panel, state);
            cx.notify();
        })
    });
    frames(cx, window);
    (window, panel)
}

fn frames(cx: &mut TestAppContext, window: AnyWindowHandle) {
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
}

fn bounds(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) -> Bounds<Pixels> {
    cx.update_window(window, |_, w, _| w.find(id).bounds())
        .expect("a window")
}

fn shown(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) -> bool {
    cx.update_window(window, |_, w, _| w.try_find(id).is_some())
        .expect("a window")
}

fn labelled(cx: &mut TestAppContext, window: AnyWindowHandle, label: &'static str) -> bool {
    cx.update_window(window, |_, w, _| w.try_find_by_label(label).is_some())
        .expect("a window")
}

#[gpui_kit::test]
fn each_notice_is_the_shared_block_near_the_top(cx: &mut TestAppContext) {
    for (state, title, retry) in [
        (State::None, "No tasks", false),
        (
            State::Failed(TasksErrorReason::AccessRequired, "No access."),
            "No access to Orbit",
            true,
        ),
        (
            State::Failed(TasksErrorReason::ExtensionDisabled, "Tasks are off."),
            "Tasks are turned off in Orbit",
            true,
        ),
        (
            State::Failed(TasksErrorReason::Unreachable, "Orbit did not answer."),
            "Tasks are unavailable",
            true,
        ),
        (
            State::NoClient("No Orbit login."),
            "Tasks are unavailable",
            false,
        ),
    ] {
        let (window, _panel) = open_panel(cx, &state, (WIDTH_PX, HEIGHT_PX));
        let block = bounds(cx, window, "tasks-notice");
        let mark = bounds(cx, window, "tasks-notice-mark");
        assert_eq!(mark.size, size(px(40.0), px(40.0)), "{title}");
        assert_eq!(
            mark.top() - block.top(),
            px(32.0_f32.max(HEIGHT_PX * 0.08)),
            "{title}: near the top, not centred"
        );
        assert!(
            (mark.center().x - px(WIDTH_PX / 2.0)).abs() < px(0.5),
            "{title}"
        );
        assert!(labelled(cx, window, title), "{title}");
        assert!(bounds(cx, window, "tasks-notice-description").size.width <= px(380.0));
        assert_eq!(shown(cx, window, "tasks-notice-retry"), retry, "{title}");
        if retry {
            assert_eq!(
                bounds(cx, window, "tasks-notice-retry").size.height,
                px(32.0)
            );
            assert!(labelled(cx, window, "Try again"), "{title}");
        }
    }
}

#[gpui_kit::test]
fn the_failure_titles_are_the_labs(cx: &mut TestAppContext) {
    let (window, _) = open_panel(
        cx,
        &State::Failed(
            TasksErrorReason::AccessRequired,
            "Orbit turned this device away.",
        ),
        (WIDTH_PX, HEIGHT_PX),
    );
    assert!(labelled(cx, window, "Orbit turned this device away."));
    assert!(!labelled(cx, window, "Retry"), "the button says Try again");
}

#[gpui_kit::test]
fn an_empty_lane_says_nothing_here_and_a_search_says_no_matches(cx: &mut TestAppContext) {
    let (window, _panel) = open_panel(cx, &State::OneLane(""), (BOARD_WIDTH_PX, BOARD_HEIGHT_PX));
    let tasks = one_lane_tasks();
    let hidden = TasksBoardSettings::default().hidden_lanes;
    let lanes = tasks_board_lanes(&tasks, "", &hidden);
    let empty: Vec<_> = lanes.iter().filter(|lane| lane.tasks.is_empty()).collect();
    assert!(!empty.is_empty(), "the fixture fills one lane only");
    for lane in &empty {
        let id: &'static str =
            Box::leak(format!("tasks-lane-empty-{:?}", lane.id).into_boxed_str());
        assert!(shown(cx, window, id), "{id}");
    }
    assert!(
        !shown(cx, window, "tasks-lane-no-matches-Todo"),
        "no search, no matches message"
    );

    let (window, _panel) = open_panel(
        cx,
        &State::OneLane("zzz-no-such-task"),
        (BOARD_WIDTH_PX, BOARD_HEIGHT_PX),
    );
    // The lane that holds the tasks says "No matches"; the others, which hold none, still say
    // "Nothing here".
    let full = one_lane_tasks()[0].lane();
    let matches: &'static str =
        Box::leak(format!("tasks-lane-no-matches-{full:?}").into_boxed_str());
    assert!(shown(cx, window, matches), "{matches}");
    for lane in &empty {
        let id: &'static str =
            Box::leak(format!("tasks-lane-empty-{:?}", lane.id).into_boxed_str());
        assert!(shown(cx, window, id), "{id}");
    }
}

/// Renders every Tasks state offscreen to PNG, in Dark Ocean and Light.
///
/// `CONN_EMPTY_SHOTS_DIR=<dir> cargo test -p conn-app render_notice_screenshots -- --ignored`
#[test]
#[cfg(target_os = "macos")]
#[ignore = "writes PNGs; set CONN_EMPTY_SHOTS_DIR"]
fn render_notice_screenshots() {
    let Some(dir) = std::env::var_os("CONN_EMPTY_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir).join("tasks");
    std::fs::create_dir_all(&dir).expect("an output folder");
    let mut ctx = shots::context();
    for (theme, label) in shots::THEMES {
        let tokens = shots::tokens_for(theme);
        let states = [
            ("a-no-tasks", State::None, (WIDTH_PX, HEIGHT_PX)),
            (
                "b-no-access",
                State::Failed(
                    TasksErrorReason::AccessRequired,
                    "Orbit turned this device away. Ask an Orbit admin for access, then try again.",
                ),
                (WIDTH_PX, HEIGHT_PX),
            ),
            (
                "c-turned-off",
                State::Failed(
                    TasksErrorReason::ExtensionDisabled,
                    "Turn on Tasks for this project in Orbit to see them here.",
                ),
                (WIDTH_PX, HEIGHT_PX),
            ),
            (
                "d-unavailable",
                State::Failed(
                    TasksErrorReason::Unreachable,
                    "Orbit didn't answer. Check the connection, then try again.",
                ),
                (WIDTH_PX, HEIGHT_PX),
            ),
            (
                "e-unavailable-no-client",
                State::NoClient("Orbit Tasks needs a signed-in Orbit Node."),
                (WIDTH_PX, HEIGHT_PX),
            ),
            (
                "f-empty-lanes",
                State::OneLane(""),
                (BOARD_WIDTH_PX, BOARD_HEIGHT_PX),
            ),
            (
                "g-no-matches",
                State::OneLane("zzz-no-such-task"),
                (BOARD_WIDTH_PX, BOARD_HEIGHT_PX),
            ),
        ];
        for (name, state, dims) in states {
            let panel_tokens = tokens.clone();
            let (window, _panel) = shots::open(&mut ctx, &tokens, dims, move |window, cx| {
                let mut panel = TasksPanel::new(panel_tokens, window, cx);
                set(&mut panel, &state);
                panel
            });
            shots::shoot(&mut ctx, window, &dir, name, label);
        }
    }
}
