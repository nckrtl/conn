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

use std::collections::{HashMap, VecDeque};

use conn_contract::{
    OrchestrationV2PendingBackgroundTask as PendingTask,
    OrchestrationV2TurnItemDynamicTool as DynamicToolItem, OrchestrationV2TurnItemStatus as Status,
};
use serde_json::Value;

use crate::thread::{RunTiming, ThreadState, parse_iso8601_epoch_ms};

/// The task id of Claude's one pending `ScheduleWakeup` in `pendingBackgroundTasks`
/// (`CLAUDE_SCHEDULED_WAKEUP_TASK_ID`).
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
/// The last instant a time may have, in Unix ms (`9999-12-31T23:59:59Z`). A reported or computed
/// time past it is not a time, and adding to it could overflow.
const MAX_EPOCH_MS: i64 = 253_402_300_799_000;
const MAX_EPOCH_MS_F64: f64 = 253_402_300_799_000.0;
/// The longest `sleep` that counts as a timer: one year. A longer one (`sleep 1e300`) is a wait
/// with no end in view, not a wakeup.
const MAX_SLEEP_SECS: f64 = 366.0 * 86_400.0;
/// How many dropped call ids the ledger remembers, so a late update of one is not read as a new
/// call.
const RETIRED_CAP: usize = 32;
/// How many `CronDelete` calls the ledger keeps for a job in history not loaded yet.
const DELETE_CAP: usize = 128;
/// How many cron jobs the ledger holds. The oldest go first.
const CRON_CAP: usize = 64;

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

/// One scheduling tool call, as the timeline's turn item carried it. The [`ScheduleLedger`] reads
/// it once and keeps only what it needs.
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

    fn completed(&self) -> bool {
        self.status == Status::Completed
    }

    /// Whether a `ScheduleWakeup` call schedules nothing: it failed, it asked to `stop`, or the
    /// tool reported a due time of `0`.
    fn ends_wakeup(&self) -> bool {
        self.failed()
            || self.input["stop"] == true
            || self
                .output
                .as_ref()
                .and_then(scheduled_for_ms)
                .is_some_and(|ms| ms <= 0)
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
    /// The driver (provider kind) of that instance, when the catalog lists it (`claudeAgent`).
    pub driver: Option<&'a str>,
}

impl WakeupContext<'_> {
    /// Whether the shell's roster says if Claude holds a wakeup, so a wakeup that the roster
    /// does not list is cancelled. The driver decides; an instance the catalog does not list
    /// falls back to its id.
    fn roster_is_authority(&self) -> bool {
        match self.driver {
            Some(driver) => driver == "claudeAgent",
            None => self.provider.to_ascii_lowercase().contains("claude"),
        }
    }

    fn roster_lists_wakeup(&self) -> bool {
        self.pending.iter().any(|task| match task {
            PendingTask::BackgroundTask(task) => task.task_id == CLAUDE_WAKEUP_TASK_ID,
            _ => false,
        })
    }
}

/// `a + b` ms as a time, or `None` when the sum is not a time.
fn add_ms(a: i64, b: i64) -> Option<i64> {
    a.checked_add(b)
        .filter(|sum| (0..=MAX_EPOCH_MS).contains(sum))
}

/// Whether a run other than `own_run` started at or after `after_ms`.
fn run_started_since(
    runs: &HashMap<String, RunTiming>,
    after_ms: i64,
    own_run: Option<&str>,
) -> bool {
    runs.iter().any(|(id, timing)| {
        own_run != Some(id.as_str()) && timing.started_at_ms.is_some_and(|s| s >= after_ms)
    })
}

/// The wakeup that a `ScheduleWakeup` call left pending.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingWakeup {
    due_ms: Option<i64>,
    estimated: bool,
    title: String,
    looping: bool,
    at_ms: Option<i64>,
    run_id: Option<String>,
}

impl PendingWakeup {
    /// `None` when the call schedules nothing.
    fn from_call(call: &ScheduleCall) -> Option<Self> {
        if call.ends_wakeup() {
            return None;
        }
        let reported = call.output.as_ref().and_then(scheduled_for_ms);
        let (due_ms, estimated) = match reported {
            Some(ms) => (Some(ms), false),
            None => {
                let due = call
                    .at_ms
                    .zip(delay_secs(&call.input))
                    .and_then(|(at, delay)| add_ms(at, delay.saturating_mul(1_000)));
                (due, true)
            }
        };
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
        Some(Self {
            due_ms,
            estimated,
            title,
            looping,
            at_ms: call.at_ms,
            run_id: call.run_id.clone(),
        })
    }

    /// Whether a run that is not the caller's started at the due time: the wakeup fired.
    fn fired(&self, runs: &HashMap<String, RunTiming>) -> bool {
        self.due_ms.is_some_and(|due| {
            let early = due.saturating_sub(EARLY_FIRE_MARGIN_MS);
            let from = self
                .at_ms
                .map_or(early, |at| at.saturating_add(1).max(early));
            run_started_since(runs, from, self.run_id.as_deref())
        })
    }
}

/// The latest `ScheduleWakeup` call. `pending` is `None` once it ended or fired.
#[derive(Clone, Debug)]
struct WakeupSlot {
    order: i64,
    id: String,
    /// When the held call started (Unix ms), else when it was last updated. A call of another id
    /// that is older than this never takes the slot, whatever `order` or the retired ids say.
    at_ms: Option<i64>,
    pending: Option<PendingWakeup>,
}

/// A `CronCreate` call that made a job, or may still.
#[derive(Clone, Debug)]
struct CronJob {
    order: i64,
    item_id: String,
    /// The job id the result names.
    job_id: Option<String>,
    completed: bool,
    recurring: bool,
    title: String,
    schedule: Option<String>,
    at_ms: Option<i64>,
    run_id: Option<String>,
}

/// A `CronDelete` call, kept for a `CronCreate` in history not loaded yet.
#[derive(Clone, Debug)]
struct CronDelete {
    order: i64,
    item_id: String,
    job_id: String,
    at_ms: Option<i64>,
}

/// What the thread keeps of the agent's scheduling tool calls, to work out the wakeups that are
/// still pending. The timeline drops a tool call's input, so the calls are read as they arrive.
///
/// It holds the latest `ScheduleWakeup` (an earlier one is replaced), the cron jobs not deleted,
/// expired or fired, and the `CronDelete` calls that a history page not loaded yet may need. A
/// stopped, deleted, passed or replaced call is dropped, so it does not grow with the thread.
/// Calls have an `order`: the position in the timeline, with history before it counted down.
///
/// Only a completed `CronDelete` removes a job. When the ledger drops a delete it keeps a
/// watermark (the highest order and time of what it dropped): a `CronCreate` older than that is
/// ignored, since the dropped delete may have removed it.
#[derive(Clone, Debug, Default)]
pub(crate) struct ScheduleLedger {
    /// The next order of a call that arrives.
    next_order: i64,
    /// The lowest order handed out; history pages count down from it.
    floor_order: i64,
    /// The newest time a call or run showed (Unix ms): a lower bound of now.
    newest_ms: Option<i64>,
    wakeup: Option<WakeupSlot>,
    crons: Vec<CronJob>,
    deletes: Vec<CronDelete>,
    /// The highest order of a `CronDelete` the ledger dropped.
    dropped_delete_order: Option<i64>,
    /// The newest time (Unix ms) of a `CronDelete` the ledger dropped.
    dropped_delete_ms: Option<i64>,
    /// Ids that were dropped, so a late update of one is ignored.
    retired: VecDeque<String>,
}

impl ScheduleLedger {
    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    /// What the ledger holds: a pending wakeup, cron jobs and kept deletes.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        usize::from(
            self.wakeup
                .as_ref()
                .is_some_and(|slot| slot.pending.is_some()),
        ) + self.crons.len()
            + self.deletes.len()
    }

    #[cfg(test)]
    pub(crate) fn cron_len(&self) -> usize {
        self.crons.len()
    }

    #[cfg(test)]
    pub(crate) fn delete_len(&self) -> usize {
        self.deletes.len()
    }

    /// A call that arrived live or with a snapshot, in timeline order. `None` means the item is
    /// not a scheduling call (any more).
    pub(crate) fn observe(&mut self, id: &str, call: Option<ScheduleCall>) {
        let Some(call) = call else {
            self.forget(id);
            return;
        };
        let order = match self.order_of(id) {
            Some(order) => order,
            None if self.is_retired(id) => return,
            None => {
                let order = self.next_order;
                self.next_order = self.next_order.saturating_add(1);
                order
            }
        };
        self.place(id, &call, order);
    }

    /// The calls of a history page, oldest first. They come before every call held. A call the
    /// ledger knows is kept as it is.
    pub(crate) fn observe_older(&mut self, calls: Vec<(String, ScheduleCall)>) {
        let count = i64::try_from(calls.len()).unwrap_or(i64::MAX);
        let base = self.floor_order;
        self.floor_order = self.floor_order.saturating_sub(count);
        for (index, (id, call)) in calls.into_iter().enumerate() {
            if self.order_of(&id).is_some() || self.is_retired(&id) {
                continue;
            }
            let behind = count.saturating_sub(i64::try_from(index).unwrap_or(i64::MAX));
            self.place(&id, &call, base.saturating_sub(behind));
        }
    }

    /// The item behind `id` is gone from the timeline.
    pub(crate) fn forget(&mut self, id: &str) {
        if self.wakeup.as_ref().is_some_and(|slot| slot.id == id) {
            self.wakeup = None;
        }
        self.crons.retain(|job| job.item_id != id);
        self.deletes.retain(|delete| delete.item_id != id);
    }

    /// Drops what the runs and the clock settled: a wakeup that fired, a cron job that expired
    /// or fired, and (with `keep_deletes` off) the `CronDelete` calls no older page needs.
    pub(crate) fn prune(&mut self, runs: &HashMap<String, RunTiming>, keep_deletes: bool) {
        let now = self
            .newest_ms
            .into_iter()
            .chain(runs.values().filter_map(|timing| timing.started_at_ms))
            .max();
        let expired = |at: Option<i64>| {
            now.zip(at)
                .is_some_and(|(now, at)| now >= at.saturating_add(CRON_EXPIRY_MS))
        };
        if let Some(slot) = &mut self.wakeup
            && slot.pending.as_ref().is_some_and(|p| p.fired(runs))
        {
            slot.pending = None;
        }
        let mut gone = Vec::new();
        self.crons.retain(|job| {
            let fired = job.completed
                && !job.recurring
                && job.at_ms.is_some_and(|at| {
                    run_started_since(runs, at.saturating_add(1), job.run_id.as_deref())
                });
            let keep = !(fired || expired(job.at_ms));
            if !keep {
                gone.push(job.item_id.clone());
            }
            keep
        });
        for id in gone {
            self.retire(id);
        }
        self.enforce_cron_cap();
        let mut dropped = Vec::new();
        if keep_deletes {
            self.deletes.retain(|delete| {
                let keep = !expired(delete.at_ms);
                if !keep {
                    dropped.push((delete.order, delete.at_ms));
                }
                keep
            });
            if self.deletes.len() > DELETE_CAP {
                self.deletes.sort_by_key(|delete| delete.order);
                let extra = self.deletes.len() - DELETE_CAP;
                dropped.extend(
                    self.deletes
                        .drain(..extra)
                        .map(|delete| (delete.order, delete.at_ms)),
                );
            }
        } else {
            dropped.extend(
                self.deletes
                    .drain(..)
                    .map(|delete| (delete.order, delete.at_ms)),
            );
        }
        for (order, at_ms) in dropped {
            self.dropped_delete_order =
                Some(self.dropped_delete_order.map_or(order, |o| o.max(order)));
            if let Some(at) = at_ms {
                self.dropped_delete_ms = Some(self.dropped_delete_ms.map_or(at, |m| m.max(at)));
            }
        }
    }

    /// Keeps the newest [`CRON_CAP`] cron jobs by order. An evicted job is retired.
    fn enforce_cron_cap(&mut self) {
        if self.crons.len() <= CRON_CAP {
            return;
        }
        self.crons.sort_by_key(|job| job.order);
        let extra = self.crons.len() - CRON_CAP;
        let evicted: Vec<String> = self.crons.drain(..extra).map(|job| job.item_id).collect();
        for id in evicted {
            self.retire(id);
        }
    }

    /// Whether a `CronCreate` at `order` and `at_ms` is older than a `CronDelete` the ledger
    /// dropped, so that delete may have removed it.
    fn older_than_dropped_delete(&self, order: i64, at_ms: Option<i64>) -> bool {
        self.dropped_delete_order
            .is_some_and(|dropped| order < dropped)
            || self
                .dropped_delete_ms
                .zip(at_ms)
                .is_some_and(|(dropped, at)| at < dropped)
    }

    fn is_retired(&self, id: &str) -> bool {
        self.retired.iter().any(|retired| retired == id)
    }

    fn retire(&mut self, id: String) {
        if !self.is_retired(&id) {
            if self.retired.len() >= RETIRED_CAP {
                self.retired.pop_front();
            }
            self.retired.push_back(id);
        }
    }

    /// The order of the call behind `id`, when the ledger holds it.
    fn order_of(&self, id: &str) -> Option<i64> {
        if let Some(slot) = &self.wakeup
            && slot.id == id
        {
            return Some(slot.order);
        }
        self.crons
            .iter()
            .find(|job| job.item_id == id)
            .map(|job| job.order)
            .or_else(|| {
                self.deletes
                    .iter()
                    .find(|delete| delete.item_id == id)
                    .map(|delete| delete.order)
            })
    }

    fn place(&mut self, id: &str, call: &ScheduleCall, order: i64) {
        if let Some(at) = call.at_ms.filter(|at| (0..=MAX_EPOCH_MS).contains(at)) {
            self.newest_ms = Some(self.newest_ms.map_or(at, |newest| newest.max(at)));
        }
        match call.tool {
            ScheduleTool::Wakeup => self.place_wakeup(id, call, order),
            ScheduleTool::CronCreate => self.place_cron_create(id, call, order),
            ScheduleTool::CronDelete => self.place_cron_delete(id, call, order),
        }
    }

    fn place_wakeup(&mut self, id: &str, call: &ScheduleCall, order: i64) {
        if let Some(slot) = &self.wakeup {
            if slot.order > order {
                // An older call than the one held: only the latest matters.
                return;
            }
            if slot.id != id
                && slot
                    .at_ms
                    .zip(call.at_ms)
                    .is_some_and(|(held, at)| at < held)
            {
                // A late update of a call that started before the held one. Its id may have
                // left the retired list, so the order alone cannot tell.
                return;
            }
            if slot.id != id {
                let replaced = slot.id.clone();
                self.retire(replaced);
            }
        }
        self.wakeup = Some(WakeupSlot {
            order,
            id: id.to_owned(),
            at_ms: call.at_ms,
            pending: PendingWakeup::from_call(call),
        });
    }

    fn place_cron_create(&mut self, id: &str, call: &ScheduleCall, order: i64) {
        let held = self.crons.iter().any(|job| job.item_id == id);
        self.crons.retain(|job| job.item_id != id);
        if call.failed() {
            return;
        }
        let job_id = call.output.as_ref().and_then(cron_id);
        let deleted = job_id.as_deref().is_some_and(|job| {
            self.deletes.iter().any(|delete| {
                delete.job_id == job
                    && (delete.order > order
                        || delete.at_ms.zip(call.at_ms).is_some_and(|(d, at)| d > at))
            })
        });
        if deleted || (!held && self.older_than_dropped_delete(order, call.at_ms)) {
            self.retire(id.to_owned());
            return;
        }
        self.crons.push(CronJob {
            order,
            item_id: id.to_owned(),
            job_id,
            completed: call.status == Status::Completed,
            recurring: call.input["recurring"].as_bool().unwrap_or(true),
            title: first_line(call.input["prompt"].as_str().unwrap_or(""))
                .unwrap_or_else(|| "Scheduled prompt".to_owned()),
            schedule: call
                .output
                .as_ref()
                .and_then(human_schedule)
                .or_else(|| text(&call.input["cron"])),
            at_ms: call.at_ms,
            run_id: call.run_id.clone(),
        });
        self.enforce_cron_cap();
    }

    /// Only a completed `CronDelete` removes a job. One still pending leaves the job listed, and
    /// one that failed or was interrupted never removed it.
    fn place_cron_delete(&mut self, id: &str, call: &ScheduleCall, order: i64) {
        self.deletes.retain(|delete| delete.item_id != id);
        let Some(job) = call.input["id"].as_str().filter(|_| call.completed()) else {
            return;
        };
        let mut removed = Vec::new();
        self.crons.retain(|cron| {
            let hit = cron.job_id.as_deref() == Some(job) && cron.order < order;
            if hit {
                removed.push(cron.item_id.clone());
            }
            !hit
        });
        for item in removed {
            self.retire(item);
        }
        self.deletes.push(CronDelete {
            order,
            item_id: id.to_owned(),
            job_id: job.to_owned(),
            at_ms: call.at_ms,
        });
    }
}

impl ThreadState {
    /// The wakeups the agent set for itself, soonest first, those with no known time last.
    ///
    /// It reads the thread's [`ScheduleLedger`], not the timeline, so its cost does not grow with
    /// the thread.
    #[must_use]
    pub fn agent_wakeups(&self, context: &WakeupContext<'_>) -> Vec<AgentWakeup> {
        let mut rows: Vec<AgentWakeup> = Vec::new();
        rows.extend(self.scheduled_wakeup(context));
        rows.extend(self.cron_jobs(context));
        rows.extend(self.sleep_timers(context));
        rows.sort_by_key(|row| row.due_ms.unwrap_or(i64::MAX));
        rows
    }

    fn scheduled_wakeup(&self, context: &WakeupContext<'_>) -> Option<AgentWakeup> {
        let slot = self.schedule_calls.wakeup.as_ref()?;
        let pending = slot.pending.as_ref()?;
        if context.roster_is_authority() && !context.roster_lists_wakeup() {
            return None;
        }
        if let Some(due) = pending.due_ms
            && (pending.fired(&self.run_timings)
                || context.now_ms >= due.saturating_add(STALE_AFTER_MS))
        {
            return None;
        }
        Some(AgentWakeup {
            key: slot.id.clone(),
            kind: if pending.looping {
                WakeupKind::Loop
            } else {
                WakeupKind::Wakeup
            },
            recurring: pending.looping,
            title: pending.title.clone(),
            schedule: None,
            due_ms: pending.due_ms,
            estimated: pending.estimated,
        })
    }

    fn cron_jobs(&self, context: &WakeupContext<'_>) -> Vec<AgentWakeup> {
        let mut jobs: Vec<&CronJob> = self
            .schedule_calls
            .crons
            .iter()
            .filter(|job| job.completed)
            .collect();
        jobs.sort_by_key(|job| job.order);
        jobs.into_iter()
            .filter(|job| {
                let expired = job
                    .at_ms
                    .is_some_and(|at| context.now_ms >= at.saturating_add(CRON_EXPIRY_MS));
                let fired = !job.recurring
                    && job.at_ms.is_some_and(|at| {
                        run_started_since(
                            &self.run_timings,
                            at.saturating_add(1),
                            job.run_id.as_deref(),
                        )
                    });
                !(expired || fired)
            })
            .map(|job| AgentWakeup {
                key: job.job_id.clone().unwrap_or_else(|| job.item_id.clone()),
                kind: WakeupKind::Cron,
                recurring: job.recurring,
                title: job.title.clone(),
                schedule: job.schedule.clone(),
                due_ms: None,
                estimated: false,
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
                    due_ms: started.and_then(|start| add_ms(start, secs.saturating_mul(1_000))),
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

/// `scheduledFor` of a `ScheduleWakeup` result (Unix ms; `0` when `stop` ended the loop). A value
/// past the year 9999 is not a time, so it reads as none.
fn scheduled_for_ms(output: &Value) -> Option<i64> {
    #[expect(clippy::cast_possible_truncation, reason = "a Unix time in ms")]
    number_in(output, "scheduledFor")
        .filter(|n| *n <= MAX_EPOCH_MS_F64)
        .map(|n| n as i64)
}

fn delay_secs(input: &Value) -> Option<i64> {
    let delay = &input["delaySeconds"];
    let secs = delay
        .as_f64()
        .or_else(|| delay.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite())?;
    #[expect(clippy::cast_possible_truncation, reason = "clamped to an hour")]
    Some(
        (secs.clamp(MIN_DELAY_SECS as f64, MAX_DELAY_SECS as f64) as i64)
            .clamp(MIN_DELAY_SECS, MAX_DELAY_SECS),
    )
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

/// The seconds a `sleep <time>` command waits, when it starts with one finite sleep of at most a
/// year (a longer one, `inf` or a negative time has no known time).
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
    if secs > MAX_SLEEP_SECS {
        return None;
    }
    #[expect(clippy::cast_possible_truncation, reason = "at most a year")]
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

    #[test]
    fn a_reported_time_past_the_year_9999_is_no_time() {
        let reported = |v: Value| scheduled_for_ms(&serde_json::json!({ "scheduledFor": v }));
        assert_eq!(
            reported(serde_json::json!(MAX_EPOCH_MS)),
            Some(MAX_EPOCH_MS)
        );
        for huge in [
            serde_json::json!(1e300),
            serde_json::json!(u64::MAX),
            serde_json::json!(i64::MAX),
            serde_json::json!(f64::MAX),
            serde_json::json!(MAX_EPOCH_MS + 1_000_000),
        ] {
            assert_eq!(reported(huge.clone()), None, "{huge}");
        }
        // A negative time ends the wakeup like `0` does.
        assert!(reported(serde_json::json!(-1e300)).is_some_and(|ms| ms <= 0));
    }

    #[test]
    fn a_huge_or_odd_delay_is_clamped_or_dropped() {
        let delay = |v: Value| delay_secs(&serde_json::json!({ "delaySeconds": v }));
        for huge in [
            serde_json::json!(1e300),
            serde_json::json!(u64::MAX),
            serde_json::json!(i64::MAX),
            serde_json::json!(f64::MAX),
            serde_json::json!("99999999999999999999999"),
            serde_json::json!("1e300"),
        ] {
            assert_eq!(delay(huge.clone()), Some(MAX_DELAY_SECS), "{huge}");
        }
        assert_eq!(delay(serde_json::json!(-5)), Some(MIN_DELAY_SECS));
        assert_eq!(delay(serde_json::json!("-1e300")), Some(MIN_DELAY_SECS));
        assert_eq!(delay(serde_json::json!("1e400")), None);
        assert_eq!(delay(serde_json::json!("inf")), None);
        assert_eq!(delay(serde_json::json!("nan")), None);
    }

    #[test]
    fn a_sleep_that_is_no_time_or_too_long_has_no_seconds() {
        for command in [
            "sleep 1e300",
            "sleep inf",
            "sleep infinity",
            "sleep nan",
            "sleep -5",
            "sleep -0.5m",
            "sleep 18446744073709551615",
            "sleep 99999999999999999999999",
            "sleep 99999999999999999999999d",
            "sleep 367d",
        ] {
            assert_eq!(sleep_secs(command), None, "{command}");
        }
        assert_eq!(sleep_secs("sleep 366d"), Some(366 * 86_400));
        assert_eq!(sleep_secs("sleep 0"), Some(0));
    }

    #[test]
    fn time_sums_that_overflow_are_no_time() {
        assert_eq!(add_ms(i64::MAX, 1), None);
        assert_eq!(add_ms(i64::MAX, 3_600_000), None);
        assert_eq!(add_ms(MAX_EPOCH_MS, 1), None);
        assert_eq!(add_ms(-5, 1), None);
        assert_eq!(add_ms(1_000, 2_000), Some(3_000));
    }

    fn call(tool: ScheduleTool, at_ms: Option<i64>, input: Value, output: Value) -> ScheduleCall {
        ScheduleCall {
            tool,
            input,
            output: Some(output),
            status: Status::Completed,
            run_id: Some("run-1".to_owned()),
            at_ms,
        }
    }

    fn wake(at_ms: i64, reason: &str) -> ScheduleCall {
        call(
            ScheduleTool::Wakeup,
            Some(at_ms),
            serde_json::json!({"delaySeconds": 300, "reason": reason, "prompt": "p"}),
            serde_json::json!("ok"),
        )
    }

    fn cron(at_ms: i64, recurring: bool, job: &str) -> ScheduleCall {
        call(
            ScheduleTool::CronCreate,
            Some(at_ms),
            serde_json::json!({"cron": "* * * * *", "prompt": "poll", "recurring": recurring}),
            serde_json::json!({ "id": job }),
        )
    }

    fn cron_delete(at_ms: i64, job: &str) -> ScheduleCall {
        call(
            ScheduleTool::CronDelete,
            Some(at_ms),
            serde_json::json!({ "id": job }),
            serde_json::json!("ok"),
        )
    }

    fn context(now_ms: i64) -> WakeupContext<'static> {
        WakeupContext {
            now_ms,
            pending: &[],
            provider: "codex",
            driver: Some("codex"),
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    fn runs(started: &[(&str, i64)]) -> HashMap<String, RunTiming> {
        started
            .iter()
            .map(|(id, at)| {
                (
                    (*id).to_owned(),
                    RunTiming {
                        started_at_ms: Some(*at),
                        completed_at_ms: None,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn times_that_overflow_never_panic_the_rows() {
        let mut state = ThreadState::new("t");
        // A call that started at the end of time, with a delay and with a reported time.
        state
            .schedule_calls
            .observe("w", Some(wake(i64::MAX, "late")));
        state
            .schedule_calls
            .observe("c", Some(cron(i64::MAX, true, "job")));
        for now in [i64::MIN, 0, NOW, i64::MAX] {
            let rows = state.agent_wakeups(&context(now));
            assert!(rows.iter().all(|row| row.due_ms.is_none()), "{rows:?}");
        }
        state.schedule_calls.prune(&HashMap::new(), true);
        state.schedule_calls.prune(&runs(&[("r", i64::MAX)]), false);
        let _ = state.agent_wakeups(&context(i64::MAX));
    }

    #[test]
    fn a_loop_keeps_only_its_latest_call() {
        let mut ledger = ScheduleLedger::default();
        for step in 0..500 {
            ledger.observe(&format!("w{step}"), Some(wake(NOW + step, "step")));
            ledger.prune(&HashMap::new(), true);
        }
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger.wakeup.as_ref().map(|s| s.id.as_str()), Some("w499"));
        assert!(ledger.retired.len() <= RETIRED_CAP);
    }

    #[test]
    fn a_stopped_wakeup_is_dropped_and_an_older_one_does_not_come_back() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("w1", Some(wake(NOW, "one")));
        let mut stop = wake(NOW + 1_000, "stop");
        stop.input = serde_json::json!({"stop": true});
        ledger.observe("w2", Some(stop));
        assert_eq!(ledger.len(), 0);
        // A history page with an earlier wakeup does not bring one back.
        ledger.observe_older(vec![("w0".to_owned(), wake(NOW - 1_000, "zero"))]);
        assert_eq!(ledger.len(), 0);
        // A failed call schedules nothing either.
        let mut failed = wake(NOW + 2_000, "failed");
        failed.status = Status::Failed;
        ledger.observe("w3", Some(failed));
        assert_eq!(ledger.len(), 0);
    }

    #[test]
    fn a_late_update_of_a_replaced_call_is_ignored() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("w1", Some(wake(NOW, "one")));
        ledger.observe("w2", Some(wake(NOW + 1_000, "two")));
        // `w1` updates after `w2` was scheduled: it is still the older call.
        ledger.observe("w1", Some(wake(NOW, "one, done")));
        let pending = ledger.wakeup.as_ref().and_then(|s| s.pending.as_ref());
        assert_eq!(pending.map(|p| p.title.as_str()), Some("two"));
    }

    #[test]
    fn deleted_cron_jobs_are_dropped_and_the_deletes_stay_bounded() {
        let mut ledger = ScheduleLedger::default();
        for n in 0..400 {
            let job = format!("job-{n}");
            ledger.observe(&format!("create-{n}"), Some(cron(NOW + n, true, &job)));
            ledger.observe(&format!("delete-{n}"), Some(cron_delete(NOW + n, &job)));
            ledger.prune(&HashMap::new(), true);
        }
        assert_eq!(ledger.cron_len(), 0);
        assert!(ledger.delete_len() <= DELETE_CAP);
        // With no older history to load, no delete is needed.
        ledger.prune(&HashMap::new(), false);
        assert_eq!(ledger.delete_len(), 0);
        assert_eq!(ledger.len(), 0);
    }

    #[test]
    fn a_job_in_older_history_stays_deleted() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("delete", Some(cron_delete(NOW, "job-a")));
        ledger.observe_older(vec![
            ("create-a".to_owned(), cron(NOW - 2_000, true, "job-a")),
            ("create-b".to_owned(), cron(NOW - 1_000, true, "job-b")),
        ]);
        assert_eq!(ledger.cron_len(), 1);
        assert_eq!(ledger.crons[0].job_id.as_deref(), Some("job-b"));
    }

    #[test]
    fn a_job_created_again_after_its_delete_stays() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("create-1", Some(cron(NOW, true, "job")));
        ledger.observe("delete", Some(cron_delete(NOW + 1_000, "job")));
        ledger.observe("create-2", Some(cron(NOW + 2_000, true, "job")));
        assert_eq!(ledger.cron_len(), 1);
        assert_eq!(ledger.crons[0].item_id, "create-2");
    }

    #[test]
    fn fired_and_expired_calls_are_dropped() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("w", Some(wake(NOW, "wake")));
        ledger.observe("once", Some(cron(NOW + 1, false, "once")));
        ledger.observe("every", Some(cron(NOW + 2, true, "every")));
        ledger.prune(&runs(&[("run-1", NOW)]), true);
        assert_eq!(ledger.len(), 3, "the caller's own run fires nothing");
        // Another run starts after the due time: the wakeup and the one-shot job are done.
        ledger.prune(&runs(&[("run-1", NOW), ("run-2", NOW + 400_000)]), true);
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger.crons[0].item_id, "every");
        // A recurring job expires after a week.
        ledger.prune(&runs(&[("run-2", NOW + CRON_EXPIRY_MS + 10)]), true);
        assert_eq!(ledger.len(), 0);
    }

    fn with_status(mut call: ScheduleCall, status: Status) -> ScheduleCall {
        call.status = status;
        call
    }

    #[test]
    fn only_a_completed_delete_removes_a_job() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("create", Some(cron(NOW, true, "job")));
        // A delete in progress hides nothing, and one that ends badly never did.
        ledger.observe(
            "delete",
            Some(with_status(
                cron_delete(NOW + 1_000, "job"),
                Status::Running,
            )),
        );
        assert_eq!(ledger.cron_len(), 1);
        assert_eq!(ledger.delete_len(), 0);
        for status in [Status::Failed, Status::Cancelled, Status::Interrupted] {
            ledger.observe(
                "delete",
                Some(with_status(cron_delete(NOW + 1_000, "job"), status)),
            );
            assert_eq!(ledger.cron_len(), 1, "{status:?}");
            assert_eq!(ledger.delete_len(), 0, "{status:?}");
            // A late update of the create does not drop it either.
            ledger.observe("create", Some(cron(NOW, true, "job")));
            assert_eq!(ledger.cron_len(), 1, "{status:?}");
        }
        let mut state = ThreadState::new("t");
        state.schedule_calls = ledger.clone();
        assert_eq!(state.agent_wakeups(&context(NOW + 2_000)).len(), 1);
        // The same item completing is the delete that counts.
        ledger.observe("delete", Some(cron_delete(NOW + 1_000, "job")));
        assert_eq!(ledger.cron_len(), 0);
        assert_eq!(ledger.delete_len(), 1);
    }

    #[test]
    fn a_pending_delete_in_history_does_not_hide_a_job_when_its_page_loads() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe(
            "delete",
            Some(with_status(cron_delete(NOW, "job-a"), Status::Running)),
        );
        ledger.observe_older(vec![(
            "create-a".to_owned(),
            cron(NOW - 1_000, true, "job-a"),
        )]);
        assert_eq!(ledger.cron_len(), 1);
    }

    #[test]
    fn the_cron_jobs_are_capped_and_the_oldest_go_first() {
        let mut ledger = ScheduleLedger::default();
        let total = i64::try_from(CRON_CAP).unwrap() + 40;
        for n in 0..total {
            ledger.observe(
                &format!("c{n}"),
                Some(cron(NOW + n, true, &format!("j{n}"))),
            );
            assert!(ledger.cron_len() <= CRON_CAP);
        }
        assert_eq!(ledger.cron_len(), CRON_CAP);
        let oldest = ledger.crons.iter().map(|job| job.order).min();
        assert_eq!(oldest, Some(40));
        assert!(ledger.crons.iter().all(|job| job.item_id != "c0"));
        assert!(
            ledger
                .crons
                .iter()
                .any(|job| job.item_id == format!("c{}", total - 1))
        );
        // A history page cannot push the newest out: its own jobs are the oldest.
        let page: Vec<_> = (0..10)
            .map(|n| {
                (
                    format!("h{n}"),
                    cron(NOW - 10_000 + n, true, &format!("hj{n}")),
                )
            })
            .collect();
        ledger.observe_older(page);
        assert_eq!(ledger.cron_len(), CRON_CAP);
        assert!(ledger.crons.iter().all(|job| !job.item_id.starts_with('h')));
        // A job whose time never parsed does not escape the cap.
        for n in 0..(CRON_CAP * 2) {
            let mut untimed = cron(NOW, true, &format!("u{n}"));
            untimed.at_ms = None;
            ledger.observe(&format!("u{n}"), Some(untimed));
        }
        assert_eq!(ledger.cron_len(), CRON_CAP);
    }

    #[test]
    fn a_late_update_of_an_old_wakeup_never_takes_the_slot() {
        let mut ledger = ScheduleLedger::default();
        ledger.observe("old", Some(wake(NOW, "old")));
        // More replacements than the retired list holds: `old` is no longer remembered.
        let total = i64::try_from(RETIRED_CAP).unwrap() + 8;
        for step in 1..=total {
            ledger.observe(&format!("w{step}"), Some(wake(NOW + step * 1_000, "step")));
        }
        assert!(!ledger.is_retired("old"));
        let latest = format!("w{total}");
        ledger.observe("old", Some(wake(NOW, "old, done")));
        assert_eq!(
            ledger.wakeup.as_ref().map(|s| s.id.as_str()),
            Some(latest.as_str())
        );
        // The live call still updates itself.
        ledger.observe(&latest, Some(wake(NOW + total * 1_000, "still latest")));
        let pending = ledger.wakeup.as_ref().and_then(|s| s.pending.as_ref());
        assert_eq!(pending.map(|p| p.title.as_str()), Some("still latest"));
        // A newer call still replaces it.
        ledger.observe("next", Some(wake(NOW + (total + 1) * 1_000, "next")));
        assert_eq!(ledger.wakeup.as_ref().map(|s| s.id.as_str()), Some("next"));
    }

    #[test]
    fn trimming_the_deletes_does_not_bring_back_a_deleted_job() {
        let mut ledger = ScheduleLedger::default();
        let total = i64::try_from(DELETE_CAP).unwrap() + 12;
        for n in 0..total {
            ledger.observe(
                &format!("delete-{n}"),
                Some(cron_delete(NOW + n, &format!("job-{n}"))),
            );
            ledger.prune(&HashMap::new(), true);
        }
        assert_eq!(ledger.delete_len(), DELETE_CAP);
        // `job-0`'s delete was trimmed. Its create is in a page that loads now.
        ledger.observe_older(vec![
            ("create-0".to_owned(), cron(NOW - 5_000, true, "job-0")),
            ("create-1".to_owned(), cron(NOW - 4_000, true, "job-1")),
        ]);
        assert_eq!(ledger.cron_len(), 0);
        // A late update of such a create (its id was never retired) does not bring it back.
        ledger.observe("create-2", Some(cron(NOW + 2, true, "job-2")));
        assert_eq!(ledger.cron_len(), 0);
        // A job created after every dropped delete stays.
        ledger.observe("fresh", Some(cron(NOW + 10_000, true, "fresh-job")));
        assert_eq!(ledger.cron_len(), 1);
        // The same holds once the deletes are all dropped (nothing older left to load).
        ledger.prune(&HashMap::new(), false);
        assert_eq!(ledger.delete_len(), 0);
        ledger.observe("create-3", Some(cron(NOW + 3, true, "job-3")));
        assert_eq!(ledger.cron_len(), 1);
        assert_eq!(ledger.crons[0].item_id, "fresh");
    }

    #[test]
    fn rendering_reads_the_ledger_and_nothing_else_of_the_timeline() {
        let mut state = ThreadState::new("t");
        state.schedule_calls.observe("w", Some(wake(NOW, "wake")));
        state
            .schedule_calls
            .observe("c", Some(cron(NOW + 1, true, "job")));
        let first = state.agent_wakeups(&context(NOW + 1_000));
        assert_eq!(first.len(), 2, "{first:?}");
        assert!(state.entries.is_empty(), "no timeline rows to scan");
        assert_eq!(state.agent_wakeups(&context(NOW + 1_000)), first);
        // Only the clock is checked again: a wakeup far past due is stale.
        let later = state.agent_wakeups(&context(NOW + 3_600_000));
        assert_eq!(later.len(), 1, "{later:?}");
        assert_eq!(later[0].kind, WakeupKind::Cron);
    }
}
