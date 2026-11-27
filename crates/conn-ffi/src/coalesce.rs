//! Time-window coalescing for high-frequency shell and thread snapshots.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::types::FfiShellSnapshot;

/// Minimum interval between consecutive `on_shell` or per-thread `on_thread` callbacks.
///
/// Streaming token deltas arrive much faster than mobile UI frame budgets; coalescing to
/// 50 ms (~20 Hz) keeps SwiftUI smooth while always flushing the latest state.
pub(crate) const COALESCE_WINDOW: Duration = Duration::from_millis(50);

/// Coalesces shell snapshots and thread changes so each channel publishes at most once every
/// [`COALESCE_WINDOW`], always with the latest state.
///
/// A thread is only marked changed here; the pump builds its snapshot when it is due, so a burst
/// of events costs one projection per window instead of one per event.
#[derive(Debug, Default)]
pub(crate) struct SnapshotCoalescer {
    last_shell_emit: Option<Instant>,
    pending_shell: Option<FfiShellSnapshot>,
    last_thread_emit: HashMap<String, Instant>,
    dirty_threads: HashSet<String>,
}

impl SnapshotCoalescer {
    /// A new subscription starts its own publication window.
    pub(crate) fn reset_shell(&mut self) {
        self.pending_shell = None;
        self.last_shell_emit = None;
    }

    pub(crate) fn has_pending_shell(&self) -> bool {
        self.pending_shell.is_some()
    }

    /// Records a new shell snapshot. Returns `Some(snapshot)` when it can be emitted immediately,
    /// or `None` when it has been buffered to flush at the end of the current 50 ms window.
    pub(crate) fn push_shell(
        &mut self,
        snapshot: FfiShellSnapshot,
        now: Instant,
    ) -> Option<FfiShellSnapshot> {
        let ready = self
            .last_shell_emit
            .is_none_or(|last| now.saturating_duration_since(last) >= COALESCE_WINDOW);
        if ready {
            self.last_shell_emit = Some(now);
            self.pending_shell = None;
            Some(snapshot)
        } else {
            self.pending_shell = Some(snapshot);
            None
        }
    }

    /// Marks `thread_id` changed; it publishes once its window allows.
    pub(crate) fn mark_thread(&mut self, thread_id: &str) {
        if !self.dirty_threads.contains(thread_id) {
            self.dirty_threads.insert(thread_id.to_owned());
        }
    }

    /// Marks `thread_id` changed and due now, whatever its window (an open, a send).
    pub(crate) fn force_thread(&mut self, thread_id: &str) {
        self.last_thread_emit.remove(thread_id);
        self.mark_thread(thread_id);
    }

    /// Drops any pending change and timing history for `thread_id` (called on `close_thread`).
    pub(crate) fn cancel_thread(&mut self, thread_id: &str) {
        self.dirty_threads.remove(thread_id);
        self.last_thread_emit.remove(thread_id);
    }

    fn thread_due_at(&self, thread_id: &str) -> Option<Instant> {
        self.last_thread_emit
            .get(thread_id)
            .map(|last| *last + COALESCE_WINDOW)
    }

    /// Returns the earliest instant when any buffered snapshot or changed thread becomes due.
    #[must_use]
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        let now = Instant::now();
        let shell = self.pending_shell.as_ref().map(|_| {
            self.last_shell_emit
                .map_or(now, |last| last + COALESCE_WINDOW)
        });
        let threads = self
            .dirty_threads
            .iter()
            .map(|id| self.thread_due_at(id).unwrap_or(now));
        shell.into_iter().chain(threads).min()
    }

    /// Takes the buffered shell snapshot once its [`COALESCE_WINDOW`] has elapsed by `now`.
    pub(crate) fn drain_due_shell(&mut self, now: Instant) -> Option<FfiShellSnapshot> {
        if self.pending_shell.is_some()
            && self
                .last_shell_emit
                .is_none_or(|last| now.saturating_duration_since(last) >= COALESCE_WINDOW)
        {
            self.last_shell_emit = Some(now);
            self.pending_shell.take()
        } else {
            None
        }
    }

    /// Takes the changed threads whose window has elapsed by `now`, sorted, and starts their next
    /// window. The caller builds and publishes each.
    pub(crate) fn drain_due_threads(&mut self, now: Instant) -> Vec<String> {
        let mut due: Vec<String> = self
            .dirty_threads
            .iter()
            .filter(|id| self.thread_due_at(id).is_none_or(|at| now >= at))
            .cloned()
            .collect();
        due.sort();
        for id in &due {
            self.dirty_threads.remove(id);
            self.last_thread_emit.insert(id.clone(), now);
        }
        due
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::types::{FfiThreadSnapshot, FfiTimelineEntry};

    fn shell_snap(synchronized: bool, project_count: usize) -> FfiShellSnapshot {
        FfiShellSnapshot {
            hidden_thread_ids: vec![],
            older_settled_count: 0,
            projects: (0..project_count)
                .map(|i| crate::types::FfiProject {
                    id: format!("p-{i}"),
                    title: format!("Project {i}"),
                    workspace_root: format!("/tmp/p-{i}"),
                })
                .collect(),
            threads: Vec::new(),
            synchronized,
        }
    }

    pub(crate) fn thread_snap(thread_id: &str, text: &str, working: bool) -> FfiThreadSnapshot {
        FfiThreadSnapshot {
            history_cursor: None,
            server_page: false,
            thread_id: thread_id.to_owned(),
            project_id: None,
            title: None,
            branch: None,
            model_label: None,
            feed_details: Default::default(),
            delegated_task_ids: Default::default(),
            entries: vec![FfiTimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: text.to_owned(),
                streaming: working,
                created_at: None,
                run_id: None,
                status: if working {
                    crate::types::FfiItemStatus::Running
                } else {
                    crate::types::FfiItemStatus::Completed
                },
            }],
            work_groups: Vec::new(),
            working,
            active_run_id: None,
            queued_count: 0,
            synchronized: true,
            pending_approvals: Vec::new(),
            pending_question: None,
            active_work_started_at_ms: None,
            server_clock_offset_ms: 0,
            turn_agents: None,
        }
    }

    #[test]
    fn coalesces_rapid_shell_updates_and_flushes_latest_state() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();

        let first = coalescer.push_shell(shell_snap(false, 1), t0);
        assert_eq!(
            first.as_ref().map(|s| s.projects.len()),
            Some(1),
            "first shell update must emit immediately"
        );

        assert!(
            coalescer
                .push_shell(shell_snap(false, 2), t0 + Duration::from_millis(10))
                .is_none(),
            "update inside 50 ms window must be coalesced"
        );
        assert!(
            coalescer
                .push_shell(shell_snap(true, 3), t0 + Duration::from_millis(25))
                .is_none(),
            "subsequent update inside 50 ms window must overwrite pending snapshot"
        );
        assert_eq!(
            coalescer.next_deadline(),
            Some(t0 + COALESCE_WINDOW),
            "deadline must be 50 ms after the previous emission"
        );

        let due_early = coalescer.drain_due_shell(t0 + Duration::from_millis(49));
        assert!(due_early.is_none(), "must not flush before 50 ms elapses");

        let due = coalescer
            .drain_due_shell(t0 + COALESCE_WINDOW)
            .expect("latest shell snapshot must flush at 50 ms");
        assert!(due.synchronized, "flushed snapshot must carry latest flag");
        assert_eq!(
            due.projects.len(),
            3,
            "flushed snapshot must carry latest project list"
        );
        assert!(
            coalescer.next_deadline().is_none(),
            "no pending work should remain after flush"
        );
    }

    #[test]
    fn a_retry_discards_the_previous_sockets_buffer_and_publishes_its_marker_immediately() {
        let mut buffer = SnapshotCoalescer::default();
        let now = Instant::now();
        assert!(buffer.push_shell(shell_snap(true, 1), now).is_some());
        assert!(buffer.push_shell(shell_snap(true, 2), now).is_none());
        buffer.reset_shell();
        assert!(buffer.drain_due_shell(now + COALESCE_WINDOW).is_none());
        assert!(buffer.push_shell(shell_snap(true, 3), now).is_some());
    }

    #[test]
    fn a_burst_of_thread_changes_is_due_once_per_window_per_thread() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();

        coalescer.mark_thread("t1");
        coalescer.mark_thread("t2");
        assert_eq!(
            coalescer.drain_due_threads(t0),
            vec!["t1".to_owned(), "t2".to_owned()],
            "a first change is due at once"
        );

        for _ in 0..500 {
            coalescer.mark_thread("t1");
        }
        assert!(
            coalescer
                .drain_due_threads(t0 + Duration::from_millis(30))
                .is_empty(),
            "inside the window nothing is due"
        );
        assert_eq!(coalescer.next_deadline(), Some(t0 + COALESCE_WINDOW));
        assert_eq!(
            coalescer.drain_due_threads(t0 + COALESCE_WINDOW),
            vec!["t1".to_owned()],
            "500 changes publish once, and only the changed thread"
        );
        assert!(coalescer.next_deadline().is_none());
    }

    #[test]
    fn a_forced_thread_is_due_at_once_and_a_cancelled_one_never() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();
        coalescer.mark_thread("t1");
        assert_eq!(coalescer.drain_due_threads(t0).len(), 1);

        coalescer.force_thread("t1");
        assert_eq!(
            coalescer.drain_due_threads(t0 + Duration::from_millis(5)),
            vec!["t1".to_owned()],
            "an open or a send does not wait for the window"
        );

        coalescer.mark_thread("t1");
        coalescer.cancel_thread("t1");
        assert!(coalescer.next_deadline().is_none());
        assert!(
            coalescer
                .drain_due_threads(t0 + Duration::from_secs(1))
                .is_empty()
        );
    }
}
