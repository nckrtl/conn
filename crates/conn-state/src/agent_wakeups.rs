//! What an agent set up to wake itself: its own `ScheduleWakeup` (a one-off wakeup, or one step
//! of a dynamic `/loop`), its `CronCreate` jobs, and a `sleep` timer it waits on. These are not
//! Conn scheduled tasks, so `scheduledTasks.subscribe` does not list them.
//!
//! The thread's timeline drops a tool call's input, and the contract has no field for a due time,
//! so the client keeps the calls it needs ([`ScheduleCall`]) and works the state out from them:
//!
//! - **`ScheduleWakeup`**: the latest call is the pending wakeup. `stop: true`, a failed call, or a
//!   reported `scheduledFor` of `0` ends it. The due time is `scheduledFor` when the tool result
//!   carries it, else the call's time plus `delaySeconds` (clamped like the tool does): an
//!   estimate. A wakeup is gone once a run that is not the caller's starts at its due time. For a
//!   Claude thread the shell's `claude-scheduled-wakeup` task confirms it: Stop, a failed turn or
//!   a new process cancel the wakeup without a timeline row.
//! - **`CronCreate` / `CronDelete`**: the jobs created and not deleted. The cron expression is
//!   in the thread's local time on the agent's machine, so no next time is computed: the row
//!   shows the schedule. A job expires after seven days, as Claude does. A one-shot job is gone
//!   once a later run starts.
//! - **`sleep` timer**: a background `sleep` the agent waits on (an awaited `command` task). It
//!   ends at the command row's start plus the sleep time: an estimate.
//!
//! Conn Server cannot cancel any of these, so the rows are read-only.

use conn_contract::{
    OrchestrationV2PendingBackgroundTask as PendingTask,
    OrchestrationV2TurnItemDynamicTool as DynamicToolItem, OrchestrationV2TurnItemStatus as Status,
};
use serde_json::Value;

use crate::thread::{ThreadState, TimelineEntry, parse_iso8601_epoch_ms};

/// The task id of Claude's one pending `ScheduleWakeup` in `pendingBackgroundTasks`
/// (`CLAUDE_SCHEDULED_WAKEUP_TASK`).
pub const CLAUDE_WAKEUP_TASK_ID: &str = "claude-scheduled-wakeup";

/// `ScheduleWakeup` clamps `delaySeconds` to this range.
const MIN_DELAY_SECS: i64 = 60;
const MAX_DELAY_SECS: i64 = 3_600;
/// Claude can fire a wakeup this early (`CLAUDE_SCHEDULED_WAKEUP_EARLY_FIRE_MARGIN_MS`).
const EARLY_FIRE_MARGIN_MS: i64 = 120_000;
/// A wakeup this far past due with no run started is stale: the process that held it is gone.
const STALE_AFTER_MS: i64 = 600_000;
/// Claude expires a recurring cron job after seven days.
const CRON_EXPIRY_MS: i64 = 7 * 86_400_000;
/// Longest title, in characters.
const TITLE_CHARS: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScheduleTool {
    Wakeup,
    CronCreate,
    CronDelete,
}

impl ScheduleTool {
    fn from_name(name: &str) -> Option<Self> {
        match name.trim() {
            "ScheduleWakeup" => Some(Self::Wakeup),
            "CronCreate" => Some(Self::CronCreate),
            "CronDelete" => Some(Self::CronDelete),
            _ => None,
        }
    }
}

/// One scheduling tool call, as the timeline's turn item carried it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScheduleCall {
    tool: ScheduleTool,
    input: Value,
    output: Option<Value>,
    status: Status,
    run_id: Option<String>,
    /// When the call started (Unix ms), else when it was last updated.
    at_ms: Option<i64>,
}

impl ScheduleCall {
    /// The call behind `item`, when it is a scheduling tool.
    pub(crate) fn from_item(item: &DynamicToolItem) -> Option<Self> {
        let tool = ScheduleTool::from_name(item.tool_name.as_deref()?)?;
        let at = item.started_at.as_deref().unwrap_or(&item.updated_at);
        Some(Self {
            tool,
            input: item.input.clone(),
            output: item.output.clone().flatten(),
            status: item.status,
            run_id: item.run_id.clone(),
            at_ms: parse_iso8601_epoch_ms(at),
        })
    }

    fn failed(&self) -> bool {
        matches!(
            self.status,
            Status::Failed | Status::Cancelled | Status::Interrupted
        )
    }
}

/// What kind of self-set wakeup a row is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeupKind {
    /// A one-off `ScheduleWakeup`.
    Wakeup,
    /// A `ScheduleWakeup` that carries a dynamic `/loop`: the agent schedules the next step each
    /// time.
    Loop,
    /// A `CronCreate` job.
    Cron,
    /// A background `sleep` the agent waits on.
    Timer,
}

/// One wakeup the agent set for itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentWakeup {
    /// Stable id for element ids: the timeline item, cron job or task behind the row.
    pub key: String,
    pub kind: WakeupKind,
    /// Wakes the agent again and again: a loop or a recurring cron job.
    pub recurring: bool,
    /// What wakes: the reason, else the prompt.
    pub title: String,
    /// The cron schedule, in the words Claude gave or as a cron expression.
    pub schedule: Option<String>,
    /// When the next wake is (Unix ms); `None` for a cron job, or when no time is known.
    pub due_ms: Option<i64>,
    /// `due_ms` is worked out from a delay, not reported by the agent's runtime.
    pub estimated: bool,
}

/// What [`ThreadState::agent_wakeups`] needs besides the timeline.
#[derive(Clone, Copy, Debug)]
pub struct WakeupContext<'a> {
    pub now_ms: i64,
    /// The shell's `pendingBackgroundTasks` of the thread.
    pub pending: &'a [PendingTask],
    /// The thread's provider instance id.
    pub provider: &'a str,
}

impl WakeupContext<'_> {
    /// Whether the shell's roster says if Claude holds a wakeup, so a timeline call that the
    /// roster does not list is cancelled.
    fn roster_is_authority(&self) -> bool {
        self.provider.to_ascii_lowercase().contains("claude")
    }

    fn roster_lists_wakeup(&self) -> bool {
        self.pending.iter().any(|task| match task {
            PendingTask::BackgroundTask(task) => task.task_id == CLAUDE_WAKEUP_TASK_ID,
            _ => false,
        })
    }
}

impl ThreadState {
    /// The wakeups the agent set for itself, soonest first, those with no known time last.
    #[must_use]
    pub fn agent_wakeups(&self, context: &WakeupContext<'_>) -> Vec<AgentWakeup> {
        let calls: Vec<(&str, &ScheduleCall)> = self
            .entries
            .iter()
            .filter_map(|entry| match entry {
                TimelineEntry::Tool { id, .. } => {
                    self.schedule_calls.get(id).map(|call| (id.as_str(), call))
                }
                _ => None,
            })
            .collect();
        let mut rows: Vec<AgentWakeup> = Vec::new();
        rows.extend(self.scheduled_wakeup(&calls, context));
        rows.extend(self.cron_jobs(&calls, context));
        rows.extend(self.sleep_timers(context));
        rows.sort_by_key(|row| row.due_ms.unwrap_or(i64::MAX));
        rows
    }

    /// Whether a run other than `own_run` started at or after `after_ms`.
    fn run_started_since(&self, after_ms: i64, own_run: Option<&str>) -> bool {
        self.run_timings.iter().any(|(id, timing)| {
            own_run != Some(id.as_str()) && timing.started_at_ms.is_some_and(|s| s >= after_ms)
        })
    }

    fn scheduled_wakeup(
        &self,
        calls: &[(&str, &ScheduleCall)],
        context: &WakeupContext<'_>,
    ) -> Option<AgentWakeup> {
        let (id, call) = calls
            .iter()
            .rev()
            .find(|(_, call)| call.tool == ScheduleTool::Wakeup)?;
        if call.failed() || call.input["stop"] == true {
            return None;
        }
        if context.roster_is_authority() && !context.roster_lists_wakeup() {
            return None;
        }
        let reported = call.output.as_ref().and_then(scheduled_for_ms);
        if reported.is_some_and(|ms| ms <= 0) {
            return None;
        }
        let (due_ms, estimated) = match reported {
            Some(ms) => (Some(ms), false),
            None => {
                let due = call
                    .at_ms
                    .zip(delay_secs(&call.input))
                    .map(|(at, delay)| at + delay * 1_000);
                (due, true)
            }
        };
        if let Some(due) = due_ms {
            let fired_from = call.at_ms.map_or(due - EARLY_FIRE_MARGIN_MS, |at| {
                (at + 1).max(due - EARLY_FIRE_MARGIN_MS)
            });
            if self.run_started_since(fired_from, call.run_id.as_deref())
                || context.now_ms >= due + STALE_AFTER_MS
            {
                return None;
            }
        }
        let prompt = call.input["prompt"].as_str().map(str::trim).unwrap_or("");
        let looping = prompt.starts_with("<<autonomous-loop") || prompt.starts_with("/loop");
        let title = text(&call.input["reason"])
            .or_else(|| (!looping).then(|| first_line(prompt)).flatten())
            .unwrap_or_else(|| {
                if looping {
                    "Loop".to_owned()
                } else {
                    "Scheduled wakeup".to_owned()
                }
            });
        Some(AgentWakeup {
            key: (*id).to_owned(),
            kind: if looping {
                WakeupKind::Loop
            } else {
                WakeupKind::Wakeup
            },
            recurring: looping,
            title,
            schedule: None,
            due_ms,
            estimated,
        })
    }

    fn cron_jobs(
        &self,
        calls: &[(&str, &ScheduleCall)],
        context: &WakeupContext<'_>,
    ) -> Vec<AgentWakeup> {
        let mut jobs: Vec<(Option<String>, &str, &ScheduleCall)> = Vec::new();
        for (item_id, call) in calls {
            match call.tool {
                ScheduleTool::CronCreate if call.status == Status::Completed => {
                    let id = call.output.as_ref().and_then(cron_id);
                    jobs.push((id, item_id, call));
                }
                ScheduleTool::CronDelete if !call.failed() => {
                    if let Some(id) = call.input["id"].as_str() {
                        jobs.retain(|(job, _, _)| job.as_deref() != Some(id));
                    }
                }
                _ => {}
            }
        }
        jobs.into_iter()
            .filter_map(|(id, item_id, call)| {
                let recurring = call.input["recurring"].as_bool().unwrap_or(true);
                let at = call.at_ms;
                if at.is_some_and(|at| context.now_ms >= at + CRON_EXPIRY_MS) {
                    return None;
                }
                if !recurring
                    && at.is_some_and(|at| self.run_started_since(at + 1, call.run_id.as_deref()))
                {
                    return None;
                }
                let schedule = call
                    .output
                    .as_ref()
                    .and_then(human_schedule)
                    .or_else(|| text(&call.input["cron"]));
                Some(AgentWakeup {
                    key: id.unwrap_or_else(|| item_id.to_owned()),
                    kind: WakeupKind::Cron,
                    recurring,
                    title: first_line(call.input["prompt"].as_str().unwrap_or(""))
                        .unwrap_or_else(|| "Scheduled prompt".to_owned()),
                    schedule,
                    due_ms: None,
                    estimated: false,
                })
            })
            .collect()
    }

    fn sleep_timers(&self, context: &WakeupContext<'_>) -> Vec<AgentWakeup> {
        context
            .pending
            .iter()
            .filter_map(|task| {
                let PendingTask::Command(task) = task else {
                    return None;
                };
                task.awaited?;
                let command = task.command.as_deref()?;
                let secs = sleep_secs(command)?;
                let started = task
                    .item_id
                    .as_deref()
                    .and_then(|id| self.entry_timings.get(id))
                    .and_then(|timing| timing.started_at_ms);
                Some(AgentWakeup {
                    key: task.task_id.clone(),
                    kind: WakeupKind::Timer,
                    recurring: false,
                    title: task
                        .description
                        .as_deref()
                        .and_then(first_line)
                        .or_else(|| first_line(command))
                        .unwrap_or_else(|| "Waiting on a timer".to_owned()),
                    schedule: None,
                    due_ms: started.map(|start| start + secs * 1_000),
                    estimated: true,
                })
            })
            .collect()
    }
}

/// A non-empty trimmed string value.
fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The first non-empty line of `raw`, cut to [`TITLE_CHARS`].
fn first_line(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty())?;
    if line.chars().count() <= TITLE_CHARS {
        return Some(line.to_owned());
    }
    let mut cut: String = line.chars().take(TITLE_CHARS - 1).collect();
    cut.push('…');
    Some(cut)
}

/// A tool result as an object: the value itself, or the JSON a string holds.
fn result_object(output: &Value) -> Option<Value> {
    match output {
        Value::Object(_) => Some(output.clone()),
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .filter(Value::is_object),
        _ => None,
    }
}

/// The number the tool result reports as `key` (`scheduledFor`), in the result or in the JSON text
/// it wraps.
fn number_in(output: &Value, key: &str) -> Option<f64> {
    result_object(output)?
        .get(key)?
        .as_f64()
        .filter(|n| n.is_finite())
}

/// `scheduledFor` of a `ScheduleWakeup` result (Unix ms; `0` when `stop` ended the loop).
fn scheduled_for_ms(output: &Value) -> Option<i64> {
    #[expect(clippy::cast_possible_truncation, reason = "a Unix time in ms")]
    number_in(output, "scheduledFor").map(|n| n as i64)
}

fn delay_secs(input: &Value) -> Option<i64> {
    let delay = &input["delaySeconds"];
    let secs = delay
        .as_f64()
        .or_else(|| delay.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite())?;
    #[expect(clippy::cast_possible_truncation, reason = "clamped to an hour")]
    Some((secs as i64).clamp(MIN_DELAY_SECS, MAX_DELAY_SECS))
}

/// The id a `CronCreate` result names: an `id` field, or the word after `job` in its text.
fn cron_id(output: &Value) -> Option<String> {
    if let Some(object) = result_object(output) {
        for key in ["id", "jobId", "job_id"] {
            if let Some(id) = text(&object[key]) {
                return Some(id);
            }
        }
    }
    let words: Vec<&str> = output.as_str()?.split_whitespace().collect();
    let at = words.iter().position(|w| w.eq_ignore_ascii_case("job"))?;
    let id = words
        .get(at + 1)?
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
    (!id.is_empty()).then(|| id.to_owned())
}

/// The schedule in words that a `CronCreate` result carries.
fn human_schedule(output: &Value) -> Option<String> {
    let object = result_object(output)?;
    ["humanSchedule", "human_schedule"]
        .iter()
        .find_map(|key| text(&object[*key]))
}

/// The seconds a `sleep <time>` command waits, when it starts with one finite sleep.
///
/// `sleep 1700; echo done` is 1700. A suffix is `s`, `m`, `h` or `d`. A duration that needs a
/// shell to work out (`$((…))`, a variable) has no known time.
fn sleep_secs(command: &str) -> Option<i64> {
    let rest = command.trim_start().strip_prefix("sleep")?;
    let rest = rest.strip_prefix([' ', '\t'])?.trim_start();
    let word = rest
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&'))
        .next()?;
    let word = word.trim_matches(['"', '\'']);
    let (number, unit) = match word.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
        Some((at, _)) => word.split_at(at),
        None => (word, "s"),
    };
    let scale = match unit {
        "s" => 1.0,
        "m" => 60.0,
        "h" => 3_600.0,
        "d" => 86_400.0,
        _ => return None,
    };
    let secs = number
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.0)?
        * scale;
    #[expect(clippy::cast_possible_truncation, reason = "a short sleep")]
    Some(secs as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sleep_command_gives_its_seconds() {
        assert_eq!(sleep_secs("sleep 1700; echo done"), Some(1700));
        assert_eq!(sleep_secs("  sleep 90"), Some(90));
        assert_eq!(sleep_secs("sleep 5m && echo hi"), Some(300));
        assert_eq!(sleep_secs("sleep 1.5h"), Some(5400));
        assert_eq!(sleep_secs("sleep \"30\"; date"), Some(30));
        assert_eq!(sleep_secs("sleep $((60*5))"), None);
        assert_eq!(sleep_secs("sleep $DELAY"), None);
        assert_eq!(sleep_secs("sleepy 5"), None);
        assert_eq!(sleep_secs("echo sleep 5"), None);
    }

    #[test]
    fn titles_cut_at_a_line_and_a_length() {
        assert_eq!(first_line("\n  first\nsecond").as_deref(), Some("first"));
        assert_eq!(first_line("   "), None);
        let long = "x".repeat(200);
        assert_eq!(first_line(&long).map(|t| t.chars().count()), Some(80));
    }

    #[test]
    fn a_cron_id_comes_from_a_field_or_the_text() {
        assert_eq!(
            cron_id(&serde_json::json!({"id": "abc123"})).as_deref(),
            Some("abc123")
        );
        assert_eq!(
            cron_id(&serde_json::json!("{\"id\":\"j-9\",\"recurring\":true}")).as_deref(),
            Some("j-9")
        );
        assert_eq!(
            cron_id(&serde_json::json!(
                "Scheduled recurring job 7f3a (every 5 minutes)."
            ))
            .as_deref(),
            Some("7f3a")
        );
        assert_eq!(cron_id(&serde_json::json!("nothing here")), None);
    }

    #[test]
    fn the_reported_due_time_reads_from_an_object_or_json_text() {
        assert_eq!(
            scheduled_for_ms(&serde_json::json!({"scheduledFor": 1_000_000})),
            Some(1_000_000)
        );
        assert_eq!(
            scheduled_for_ms(&serde_json::json!("{\"scheduledFor\":0}")),
            Some(0)
        );
        assert_eq!(scheduled_for_ms(&serde_json::json!("Scheduled.")), None);
    }

    #[test]
    fn the_delay_is_clamped_like_the_tool_does() {
        let delay = |v: Value| delay_secs(&serde_json::json!({ "delaySeconds": v }));
        assert_eq!(delay(serde_json::json!(5)), Some(60));
        assert_eq!(delay(serde_json::json!(270)), Some(270));
        assert_eq!(delay(serde_json::json!("1200")), Some(1200));
        assert_eq!(delay(serde_json::json!(99_999)), Some(3_600));
        assert_eq!(delay(Value::Null), None);
    }
}
