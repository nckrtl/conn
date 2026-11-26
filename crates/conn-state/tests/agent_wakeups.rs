//! The wakeups an agent set for itself, worked out from the thread's scheduling tool calls and the
//! shell's background roster.

use conn_contract::{OrchestrationV2PendingBackgroundTask as PendingTask, from_json};
use conn_state::{
    AgentWakeup, ThreadState, ThreadStreamItem, WakeupContext, WakeupKind, parse_iso8601_epoch_ms,
};
use serde_json::{Value, json};

const T0: &str = "2026-11-26T12:00:00.000Z";
const THREAD: &str = "thread-cards";

fn ms(iso: &str) -> i64 {
    parse_iso8601_epoch_ms(iso).unwrap_or_else(|| panic!("not an ISO time: {iso}"))
}

/// `T0` plus `secs`, in ms.
fn t0_plus(secs: i64) -> i64 {
    ms(T0) + secs * 1_000
}

fn iso_at(secs: i64) -> String {
    let total = ms(T0) / 1_000 + secs;
    let (hour, minute, second) = (total % 86_400 / 3_600, total % 3_600 / 60, total % 60);
    format!("2026-11-26T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn decode(value: Value) -> ThreadStreamItem {
    from_json(value).unwrap_or_else(|err| panic!("failed to decode a stream item: {err}"))
}

/// A `turn-item.updated` event for a dynamic tool call made `at` seconds after `T0`.
fn call(
    seq: i64,
    id: &str,
    name: &str,
    run: &str,
    at: i64,
    input: Value,
    output: Value,
) -> ThreadStreamItem {
    item_event(
        seq,
        json!({
            "id": id, "type": "dynamic_tool", "toolName": name, "status": "completed",
            "runId": run, "startedAt": iso_at(at), "updatedAt": iso_at(at),
            "input": input, "output": output
        }),
    )
}

fn item_event(seq: i64, fields: Value) -> ThreadStreamItem {
    let mut payload = json!({
        "threadId": THREAD, "runId": "run-1", "nodeId": null, "providerThreadId": null,
        "providerTurnId": null, "nativeItemRef": null, "parentItemId": null, "ordinal": seq,
        "title": null, "startedAt": T0, "completedAt": null, "updatedAt": T0
    });
    if let (Some(base), Value::Object(extra)) = (payload.as_object_mut(), fields) {
        base.extend(extra);
    }
    decode(json!({
        "kind": "event", "sequence": seq,
        "event": {
            "id": format!("ev-{seq}"), "threadId": THREAD, "occurredAt": T0,
            "type": "turn-item.updated", "payload": payload
        }
    }))
}

/// A run that started `at` seconds after `T0`.
fn run_started(seq: i64, run: &str, at: i64) -> ThreadStreamItem {
    decode(json!({
        "kind": "event", "sequence": seq,
        "event": {
            "id": format!("ev-run-{seq}"), "threadId": THREAD, "occurredAt": iso_at(at),
            "type": "run.created",
            "payload": {
                "id": run, "threadId": THREAD, "ordinal": seq,
                "providerInstanceId": "claudeAgent",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-opus-5-5"},
                "providerThreadId": null, "userMessageId": format!("msg-{run}"),
                "rootNodeId": null, "activeAttemptId": null, "status": "running",
                "requestedAt": iso_at(at), "startedAt": iso_at(at), "completedAt": null,
                "checkpointId": null, "contextHandoffId": null
            }
        }
    }))
}

fn timeline(items: Vec<ThreadStreamItem>) -> ThreadState {
    let mut state = ThreadState::new(THREAD);
    for item in items {
        state.apply(item);
    }
    state
}

fn pending(tasks: Value) -> Vec<PendingTask> {
    from_json(tasks).unwrap_or_else(|err| panic!("bad pending background tasks: {err}"))
}

fn roster_with_wakeup() -> Vec<PendingTask> {
    pending(json!([{
        "taskId": "claude-scheduled-wakeup", "kind": "background_task",
        "description": "Scheduled wakeup"
    }]))
}

fn wakeups(
    state: &ThreadState,
    now_secs: i64,
    pending: &[PendingTask],
    provider: &str,
) -> Vec<AgentWakeup> {
    state.agent_wakeups(&WakeupContext {
        now_ms: t0_plus(now_secs),
        pending,
        provider,
    })
}

fn wake(seq: i64, at: i64, run: &str, input: Value, output: Value) -> ThreadStreamItem {
    call(
        seq,
        &format!("wake-{seq}"),
        "ScheduleWakeup",
        run,
        at,
        input,
        output,
    )
}

#[test]
fn a_pending_wakeup_shows_with_its_estimated_next_time() {
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 270, "reason": "Check the CI run", "prompt": "check ci"}),
        json!("Scheduled."),
    )]);
    let rows = wakeups(&state, 60, &roster_with_wakeup(), "claudeAgent");
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.kind, WakeupKind::Wakeup);
    assert!(!row.recurring);
    assert_eq!(row.title, "Check the CI run");
    assert_eq!(row.due_ms, Some(t0_plus(270)));
    assert!(row.estimated, "a delay gives an estimate");
}

#[test]
fn a_reported_scheduled_for_is_the_exact_time() {
    let due = t0_plus(301);
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 270, "reason": "r", "prompt": "p"}),
        json!({"scheduledFor": due}),
    )]);
    let rows = wakeups(&state, 10, &roster_with_wakeup(), "claudeAgent");
    assert_eq!(rows[0].due_ms, Some(due));
    assert!(!rows[0].estimated);
}

#[test]
fn the_delay_is_clamped_to_the_range_the_tool_allows() {
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 5, "reason": "r", "prompt": "p"}),
        json!("ok"),
    )]);
    let rows = wakeups(&state, 1, &roster_with_wakeup(), "claudeAgent");
    assert_eq!(rows[0].due_ms, Some(t0_plus(60)));
}

#[test]
fn stop_ends_the_wakeup() {
    let state = timeline(vec![
        wake(
            1,
            0,
            "run-1",
            json!({"delaySeconds": 600, "reason": "r", "prompt": "p"}),
            json!("ok"),
        ),
        wake(
            2,
            30,
            "run-1",
            json!({"stop": true}),
            json!({"scheduledFor": 0}),
        ),
    ]);
    assert!(wakeups(&state, 60, &roster_with_wakeup(), "claudeAgent").is_empty());
    // A result that reports `scheduledFor: 0` ends it too, without the `stop` input.
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 600, "reason": "r", "prompt": "p"}),
        json!("{\"scheduledFor\":0}"),
    )]);
    assert!(wakeups(&state, 60, &roster_with_wakeup(), "claudeAgent").is_empty());
}

#[test]
fn the_latest_call_replaces_an_earlier_one() {
    let state = timeline(vec![
        wake(
            1,
            0,
            "run-1",
            json!({"delaySeconds": 600, "reason": "first", "prompt": "p"}),
            json!("ok"),
        ),
        wake(
            2,
            30,
            "run-1",
            json!({"delaySeconds": 120, "reason": "second", "prompt": "p"}),
            json!("ok"),
        ),
    ]);
    let rows = wakeups(&state, 60, &roster_with_wakeup(), "claudeAgent");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "second");
    assert_eq!(rows[0].due_ms, Some(t0_plus(150)));
}

#[test]
fn a_failed_call_schedules_nothing() {
    let state = timeline(vec![item_event(
        1,
        json!({
            "id": "wake-failed", "type": "dynamic_tool", "toolName": "ScheduleWakeup",
            "status": "failed", "startedAt": T0, "updatedAt": T0,
            "input": {"delaySeconds": 300, "reason": "r", "prompt": "p"}, "output": "error"
        }),
    )]);
    assert!(wakeups(&state, 10, &roster_with_wakeup(), "claudeAgent").is_empty());
}

#[test]
fn a_claude_wakeup_the_roster_does_not_list_was_cancelled() {
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 600, "reason": "r", "prompt": "p"}),
        json!("ok"),
    )]);
    // Stop, a failed turn or a new process clear Claude's wakeup; the roster no longer lists it.
    assert!(wakeups(&state, 30, &[], "claudeAgent").is_empty());
    // A provider with no such roster entry keeps the timeline's word.
    assert_eq!(wakeups(&state, 30, &[], "codex").len(), 1);
}

#[test]
fn a_wakeup_is_gone_once_its_time_passed_and_a_new_run_started() {
    let input = json!({"delaySeconds": 300, "reason": "r", "prompt": "p"});
    let calls = || wake(1, 0, "run-1", input.clone(), json!("ok"));
    // The wake fired: a run other than the caller's started at the due time.
    let fired = timeline(vec![calls(), run_started(2, "run-2", 301)]);
    assert!(wakeups(&fired, 305, &roster_with_wakeup(), "claudeAgent").is_empty());
    // A user turn well before the due time does not cancel it.
    let user_turn = timeline(vec![calls(), run_started(2, "run-2", 60)]);
    assert_eq!(
        wakeups(&user_turn, 90, &roster_with_wakeup(), "claudeAgent").len(),
        1
    );
    // Past due with no new run it still shows, as due now, until it is stale.
    let overdue = timeline(vec![calls()]);
    assert_eq!(
        wakeups(&overdue, 320, &roster_with_wakeup(), "claudeAgent").len(),
        1
    );
    assert!(wakeups(&overdue, 300 + 601, &roster_with_wakeup(), "claudeAgent").is_empty());
}

#[test]
fn a_dynamic_loop_is_recurring() {
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 1200, "reason": "Check the migration", "prompt": "<<autonomous-loop-dynamic>>"}),
        json!("ok"),
    )]);
    let rows = wakeups(&state, 10, &roster_with_wakeup(), "claudeAgent");
    assert_eq!(rows[0].kind, WakeupKind::Loop);
    assert!(rows[0].recurring);
    assert_eq!(rows[0].title, "Check the migration");
    // With no reason the loop says so, never the sentinel.
    let state = timeline(vec![wake(
        1,
        0,
        "run-1",
        json!({"delaySeconds": 1200, "prompt": "<<autonomous-loop-dynamic>>"}),
        json!("ok"),
    )]);
    assert_eq!(
        wakeups(&state, 10, &roster_with_wakeup(), "claudeAgent")[0].title,
        "Loop"
    );
}

fn cron(seq: i64, at: i64, run: &str, input: Value, output: Value) -> ThreadStreamItem {
    call(
        seq,
        &format!("cron-{seq}"),
        "CronCreate",
        run,
        at,
        input,
        output,
    )
}

#[test]
fn a_cron_job_is_recurring_and_shows_its_schedule() {
    let state = timeline(vec![cron(
        1,
        0,
        "run-1",
        json!({"cron": "*/5 * * * *", "prompt": "Check the deploy\nthen report"}),
        json!({"id": "job-1", "humanSchedule": "Every 5 minutes", "recurring": true}),
    )]);
    let rows = wakeups(&state, 60, &[], "claudeAgent");
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.kind, WakeupKind::Cron);
    assert!(row.recurring, "`recurring` defaults to true");
    assert_eq!(row.key, "job-1");
    assert_eq!(row.title, "Check the deploy");
    assert_eq!(row.schedule.as_deref(), Some("Every 5 minutes"));
    assert_eq!(
        row.due_ms, None,
        "no next time is guessed from a cron expression"
    );
}

#[test]
fn a_cron_without_words_shows_its_expression() {
    let state = timeline(vec![cron(
        1,
        0,
        "run-1",
        json!({"cron": "0 9 * * 1-5", "prompt": "standup"}),
        json!("Scheduled recurring job 7f3a (weekdays at 9)."),
    )]);
    let rows = wakeups(&state, 60, &[], "claudeAgent");
    assert_eq!(rows[0].key, "7f3a");
    assert_eq!(rows[0].schedule.as_deref(), Some("0 9 * * 1-5"));
}

#[test]
fn cron_delete_removes_the_job() {
    let state = timeline(vec![
        cron(
            1,
            0,
            "run-1",
            json!({"cron": "*/5 * * * *", "prompt": "one"}),
            json!({"id": "job-1"}),
        ),
        cron(
            2,
            10,
            "run-1",
            json!({"cron": "*/9 * * * *", "prompt": "two"}),
            json!({"id": "job-2"}),
        ),
        call(
            3,
            "cron-del",
            "CronDelete",
            "run-1",
            20,
            json!({"id": "job-1"}),
            json!("ok"),
        ),
    ]);
    let rows = wakeups(&state, 60, &[], "claudeAgent");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "two");
}

#[test]
fn a_one_shot_cron_ends_when_a_later_run_starts_and_a_recurring_one_expires_in_a_week() {
    let one_shot = json!({"cron": "30 15 26 11 *", "prompt": "once", "recurring": false});
    let state = timeline(vec![cron(
        1,
        0,
        "run-1",
        one_shot.clone(),
        json!({"id": "j"}),
    )]);
    let rows = wakeups(&state, 60, &[], "claudeAgent");
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].recurring);
    let fired = timeline(vec![
        cron(1, 0, "run-1", one_shot, json!({"id": "j"})),
        run_started(2, "run-2", 3_600),
    ]);
    assert!(wakeups(&fired, 3_700, &[], "claudeAgent").is_empty());

    let recurring = timeline(vec![cron(
        1,
        0,
        "run-1",
        json!({"cron": "0 * * * *", "prompt": "hourly"}),
        json!({"id": "j"}),
    )]);
    assert_eq!(wakeups(&recurring, 6 * 86_400, &[], "claudeAgent").len(), 1);
    assert!(wakeups(&recurring, 7 * 86_400 + 1, &[], "claudeAgent").is_empty());
}

#[test]
fn a_cron_that_failed_to_create_is_not_a_job() {
    let state = timeline(vec![item_event(
        1,
        json!({
            "id": "cron-bad", "type": "dynamic_tool", "toolName": "CronCreate",
            "status": "failed", "startedAt": T0, "updatedAt": T0,
            "input": {"cron": "bad", "prompt": "x"}, "output": "invalid cron"
        }),
    )]);
    assert!(wakeups(&state, 10, &[], "claudeAgent").is_empty());
}

#[test]
fn a_sleep_timer_the_agent_waits_on_shows_when_it_ends() {
    // The thread's own sleep: `sleep 1700; echo done`, run in the background and awaited.
    let command_id = "turn-item:provider:claudeAgent:native-item:toolu_sleep";
    let state = timeline(vec![item_event(
        1,
        json!({
            "id": command_id, "type": "command_execution", "status": "running",
            "input": "sleep 1700; echo done", "output": "", "startedAt": T0, "updatedAt": T0,
            "title": "Wait about 28 minutes before next status check"
        }),
    )]);
    let tasks = pending(json!([{
        "taskId": "boi94rl3p", "kind": "command", "awaited": true,
        "command": "sleep 1700; echo done", "itemId": command_id,
        "description": "Wait about 28 minutes before next status check"
    }]));
    let rows = wakeups(&state, 60, &tasks, "claudeAgent");
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].kind, WakeupKind::Timer);
    assert_eq!(
        rows[0].title,
        "Wait about 28 minutes before next status check"
    );
    assert_eq!(rows[0].due_ms, Some(t0_plus(1700)));
    assert!(rows[0].estimated);

    // A command the agent does not wait on, and one that is no sleep, are not wakeups.
    let others = pending(json!([
        {"taskId": "a", "kind": "command", "command": "sleep 60", "itemId": command_id},
        {"taskId": "b", "kind": "command", "awaited": true, "command": "npm run dev"},
        {"taskId": "c", "kind": "monitor", "awaited": true, "command": "sleep 60"}
    ]));
    assert!(wakeups(&state, 60, &others, "claudeAgent").is_empty());
}

#[test]
fn rows_come_soonest_first_with_unknown_times_last() {
    let state = timeline(vec![
        cron(
            1,
            0,
            "run-1",
            json!({"cron": "*/5 * * * *", "prompt": "cron"}),
            json!({"id": "j"}),
        ),
        wake(
            2,
            5,
            "run-1",
            json!({"delaySeconds": 900, "reason": "wake", "prompt": "p"}),
            json!("ok"),
        ),
    ]);
    let rows = wakeups(&state, 30, &roster_with_wakeup(), "claudeAgent");
    let titles: Vec<&str> = rows.iter().map(|r| r.title.as_str()).collect();
    assert_eq!(titles, ["wake", "cron"]);
}

#[test]
fn other_tool_calls_make_no_wakeup() {
    let state = timeline(vec![call(
        1,
        "other",
        "Read",
        "run-1",
        0,
        json!({"delaySeconds": 300, "reason": "r"}),
        json!("ok"),
    )]);
    assert!(wakeups(&state, 10, &roster_with_wakeup(), "claudeAgent").is_empty());
}

/// The same wakeup read back from a snapshot, and from an older history page.
#[test]
fn a_snapshot_and_a_history_page_carry_the_calls_too() {
    let item = {
        let event = wake(
            1,
            0,
            "run-1",
            json!({"delaySeconds": 600, "reason": "From history", "prompt": "p"}),
            json!("ok"),
        );
        serde_json::to_value(event).expect("an event")["event"]["payload"].clone()
    };
    let row = json!({
        "position": 1, "visibility": "local", "sourceThreadId": THREAD,
        "sourceItemId": "wake-1", "item": item
    });

    let frames: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/thread_permission_stream.json"))
            .expect("fixture frames");
    let mut snapshot = frames[0].clone();
    snapshot["projection"]["visibleTurnItems"] = json!([row]);
    let mut reopened = ThreadState::default();
    reopened.apply(decode(snapshot));

    let mut paged = ThreadState::default();
    assert_eq!(
        paged.prepend_history_page(
            from_json(json!({
                "snapshotSequence": 1, "items": [row], "hasMoreHistory": false, "nextCursor": null
            }))
            .expect("a history page")
        ),
        1
    );

    for state in [reopened, paged] {
        let rows = wakeups(&state, 30, &roster_with_wakeup(), "claudeAgent");
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].title, "From history");
    }
}
