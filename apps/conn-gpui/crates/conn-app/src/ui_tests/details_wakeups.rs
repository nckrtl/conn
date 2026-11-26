//! The Thread Details card lists the wakeups the agent set for itself (`ScheduleWakeup`, a dynamic
//! loop, `CronCreate`, a `sleep` timer it waits on), for a thread of this environment and for one
//! of a linked environment. Conn scheduled tasks stay in `Automations`.

use super::details_agents::{iso, now_secs};
use super::*;
use crate::header::details_card::wakeup_line;
use conn_state::{AgentWakeup, ThreadStreamItem, WakeupKind};

const THREAD: &str = "thread-selected";
const LINKED_THREAD: &str = "thread-mini";

fn decode(value: serde_json::Value) -> ThreadStreamItem {
    from_json(value).unwrap_or_else(|err| panic!("a stream item failed to decode: {err}"))
}

/// A completed tool call of `thread` made `ago` seconds ago.
fn call(
    thread: &str,
    seq: i64,
    name: &str,
    ago: i64,
    input: serde_json::Value,
    output: serde_json::Value,
) -> ThreadStreamItem {
    let at = iso(now_secs() - ago);
    decode(json!({
        "kind": "event", "sequence": seq,
        "event": {
            "id": format!("ev-{seq}"), "threadId": thread, "occurredAt": at,
            "type": "turn-item.updated",
            "payload": {
                "id": format!("tool-{seq}"), "type": "dynamic_tool", "toolName": name,
                "status": "completed", "threadId": thread, "runId": "run-1", "nodeId": null,
                "providerThreadId": null, "providerTurnId": null, "nativeItemRef": null,
                "parentItemId": null, "ordinal": seq, "title": null,
                "startedAt": at, "completedAt": at, "updatedAt": at,
                "input": input, "output": output
            }
        }
    }))
}

fn timeline(thread: &str, items: Vec<ThreadStreamItem>) -> ThreadState {
    let mut state = ThreadState::new(thread);
    state.synchronized = true;
    for item in items {
        state.apply(item);
    }
    state
}

/// A wakeup 30 s ago that wakes in 240 s, and a recurring cron job.
fn wakeup_and_cron(thread: &str) -> ThreadState {
    timeline(
        thread,
        vec![
            call(
                thread,
                1,
                "ScheduleWakeup",
                30,
                json!({"delaySeconds": 270, "reason": "Check the CI run", "prompt": "check ci"}),
                json!("Scheduled."),
            ),
            call(
                thread,
                2,
                "CronCreate",
                20,
                json!({"cron": "*/5 * * * *", "prompt": "Check the deploy"}),
                json!({"id": "job-1", "humanSchedule": "Every 5 minutes", "recurring": true}),
            ),
        ],
    )
}

/// `shell`'s thread `id` as a Claude thread whose roster lists Claude's pending wakeup.
fn with_claude_roster(shell: &mut ShellState, id: &str, listed: bool) {
    for thread in &mut shell.threads {
        if thread.id == id {
            thread.provider_instance_id = "claudeAgent".to_owned();
            let tasks = if listed {
                json!([{"taskId": "claude-scheduled-wakeup", "kind": "background_task",
                        "description": "Scheduled wakeup"}])
            } else {
                json!([])
            };
            thread.pending_background_tasks = Some(Some(from_json(tasks).expect("tasks")));
        }
    }
}

fn mount_local(
    cx: &mut TestAppContext,
    timeline: ThreadState,
    roster: bool,
) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let mut shell = kitchen_sink_shell();
            with_claude_roster(&mut shell, THREAD, roster);
            app.set_shell(shell, cx);
            app.set_thread_for_test(THREAD.to_owned(), timeline, cx);
        });
    });
    (window, app)
}

fn labels(cx: &mut TestAppContext, window: AnyWindowHandle) -> Vec<String> {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window
            .elements()
            .into_iter()
            .filter_map(|e| e.label().map(str::to_owned))
            .collect()
    })
    .expect("a frame")
}

fn open_card(cx: &mut TestAppContext, window: AnyWindowHandle) -> Vec<String> {
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    labels(cx, window)
}

#[gpui_kit::test]
fn a_pending_wakeup_and_a_cron_job_show_in_the_card(cx: &mut TestAppContext) {
    let (window, _app) = mount_local(cx, wakeup_and_cron(THREAD), true);
    let all = open_card(cx, window);
    assert!(all.iter().any(|l| l == "Agent wakeups"), "{all:?}");
    // The wakeup says what, that it is one-off, and when it wakes (an estimate from the delay).
    assert!(
        all.contains(
            &"Agent wakeup Check the CI run, Wakeup · one-off · next in 4m (est.)".to_owned()
        ),
        "{all:?}"
    );
    // The cron job recurs and shows its schedule.
    assert!(
        all.contains(
            &"Agent wakeup Check the deploy, Cron · recurring · Every 5 minutes".to_owned()
        ),
        "{all:?}"
    );
    // The rows are read-only: the server cannot cancel them.
    assert!(
        !all.iter()
            .any(|l| l.contains("Cancel") && l.contains("wakeup")),
        "{all:?}"
    );
}

#[gpui_kit::test]
fn stop_takes_the_wakeup_off_the_card(cx: &mut TestAppContext) {
    let mut thread = wakeup_and_cron(THREAD);
    // The agent ended its loop and deleted the job.
    thread.apply(call(
        THREAD,
        3,
        "ScheduleWakeup",
        10,
        json!({"stop": true}),
        json!({"scheduledFor": 0}),
    ));
    thread.apply(call(
        THREAD,
        4,
        "CronDelete",
        5,
        json!({"id": "job-1"}),
        json!("Deleted."),
    ));
    let (window, _app) = mount_local(cx, thread, true);
    let all = open_card(cx, window);
    assert!(all.iter().any(|l| l == "Thread details"), "card is open");
    assert!(
        !all.iter().any(|l| l.starts_with("Agent wakeup")),
        "nothing is pending: {all:?}"
    );
}

#[gpui_kit::test]
fn a_wakeup_claude_no_longer_holds_is_hidden(cx: &mut TestAppContext) {
    // The roster does not list the wakeup (a Stop cleared it); the cron job stays, as the
    // roster does not track cron jobs.
    let (window, _app) = mount_local(cx, wakeup_and_cron(THREAD), false);
    let all = open_card(cx, window);
    assert!(
        !all.iter().any(|l| l.contains("Check the CI run")),
        "{all:?}"
    );
    assert!(
        all.iter().any(|l| l.contains("Check the deploy")),
        "{all:?}"
    );
}

#[gpui_kit::test]
fn a_thread_with_no_wakeups_has_no_section(cx: &mut TestAppContext) {
    let (window, _app) = mount_local(cx, ThreadState::new(THREAD), true);
    let all = open_card(cx, window);
    assert!(all.iter().any(|l| l == "Thread details"), "card is open");
    assert!(!all.iter().any(|l| l == "Agent wakeups"), "{all:?}");
}

#[gpui_kit::test]
fn a_linked_threads_wakeups_come_from_its_own_environment(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            let mut mini = linked_mini_shell("/work/mini", "Mini diagnostics");
            with_claude_roster(&mut mini, LINKED_THREAD, true);
            app.add_linked_shell_for_test("mini", "nick", mini, cx);
            app.set_thread_for_test(LINKED_THREAD.to_owned(), wakeup_and_cron(LINKED_THREAD), cx);
        });
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test(LINKED_THREAD)),
        Some("mini".to_owned()),
        "the thread belongs to the linked environment"
    );
    let all = open_card(cx, window);
    assert!(all.iter().any(|l| l == "Agent wakeups"), "{all:?}");
    assert!(
        all.contains(
            &"Agent wakeup Check the CI run, Wakeup · one-off · next in 4m (est.)".to_owned()
        ),
        "{all:?}"
    );
}

fn wakeup(kind: WakeupKind, recurring: bool, due_in: Option<i64>, estimated: bool) -> AgentWakeup {
    AgentWakeup {
        key: "k".to_owned(),
        kind,
        recurring,
        title: "t".to_owned(),
        schedule: (kind == WakeupKind::Cron).then(|| "Every 5 minutes".to_owned()),
        due_ms: due_in.map(|s| (now_secs() + s) * 1_000),
        estimated,
    }
}

#[test]
fn the_row_line_says_what_recurs_and_when_it_wakes() {
    let line = |w: AgentWakeup| wakeup_line(&w, now_secs());
    assert_eq!(
        line(wakeup(WakeupKind::Wakeup, false, Some(720), true)),
        "Wakeup · one-off · next in 12m (est.)"
    );
    assert_eq!(
        line(wakeup(WakeupKind::Wakeup, false, Some(3 * 3_600), false)),
        "Wakeup · one-off · next in 3h"
    );
    assert_eq!(
        line(wakeup(WakeupKind::Loop, true, Some(1_200), false)),
        "Loop · recurring · next in 20m"
    );
    assert_eq!(
        line(wakeup(WakeupKind::Cron, true, None, false)),
        "Cron · recurring · Every 5 minutes"
    );
    assert_eq!(
        line(wakeup(WakeupKind::Cron, false, None, false)),
        "Cron · one-off · Every 5 minutes"
    );
    assert_eq!(
        line(wakeup(WakeupKind::Timer, false, Some(-20), true)),
        "Timer · one-off · due now (est.)"
    );
    let mut unknown = wakeup(WakeupKind::Timer, false, None, true);
    unknown.schedule = None;
    assert_eq!(line(unknown), "Timer · one-off · time unknown");
}

/// Renders the details card offscreen with a pending wakeup and a cron job, in Dark Ocean and
/// Light.
///
/// `CONN_DETAILS_WAKEUPS_SHOTS_DIR=<dir> cargo test -p conn-app render_details_wakeups_screenshots -- --ignored`
#[cfg(target_os = "macos")]
#[test]
#[ignore = "writes PNGs; set CONN_DETAILS_WAKEUPS_SHOTS_DIR"]
fn render_details_wakeups_screenshots() {
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};
    let Some(dir) = std::env::var_os("CONN_DETAILS_WAKEUPS_SHOTS_DIR") else {
        return;
    };
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = headless_shot_context();
    for (theme_id, theme_label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        let tokens = conn_theme::Tokens::derive(&theme);
        let (window, app) = ctx.update(|cx| {
            gpui_kit::init(cx);
            crate::fonts::register(cx);
            crate::theme::apply_kit_theme(&tokens, cx);
            crate::app::register_keybindings(cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::default(),
                        size(px(1100.0), px(640.0)),
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
                let mut shell = kitchen_sink_shell();
                with_claude_roster(&mut shell, THREAD, true);
                app.set_shell(shell, cx);
                app.set_thread_for_test(THREAD.to_owned(), wakeup_and_cron(THREAD), cx);
            });
        });
        ctx.update_window(window, |_, w, cx| {
            app.update(cx, |app, cx| app.toggle_thread_details(w, cx));
        })
        .expect("a window");
        for _ in 0..4 {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
        }
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("details-wakeups-{theme_label}.png")))
            .expect("a saved PNG");
    }
}
