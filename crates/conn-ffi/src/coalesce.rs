//! Time-window coalescing for high-frequency shell and thread snapshots.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

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
    /// The shell changed since its last publication; the pump builds the snapshot when due.
    shell_dirty: bool,
    last_thread_emit: HashMap<String, Instant>,
    dirty_threads: HashSet<String>,
}

impl SnapshotCoalescer {
    /// A new subscription starts its own publication window.
    pub(crate) fn reset_shell(&mut self) {
        self.shell_dirty = false;
        self.last_shell_emit = None;
    }

    /// Marks the shell changed. True when the caller may publish it now; otherwise it is due at
    /// the end of the current window.
    pub(crate) fn push_shell(&mut self, now: Instant) -> bool {
        let ready = self
            .last_shell_emit
            .is_none_or(|last| now.saturating_duration_since(last) >= COALESCE_WINDOW);
        if ready {
            self.last_shell_emit = Some(now);
        }
        self.shell_dirty = !ready;
        ready
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
        let shell = self.shell_dirty.then(|| {
            self.last_shell_emit
                .map_or(now, |last| last + COALESCE_WINDOW)
        });
        let threads = self
            .dirty_threads
            .iter()
            .map(|id| self.thread_due_at(id).unwrap_or(now));
        shell.into_iter().chain(threads).min()
    }

    /// Whether the changed shell is due by `now`; starts its next window when it is.
    pub(crate) fn drain_due_shell(&mut self, now: Instant) -> bool {
        let due = self.shell_dirty
            && self
                .last_shell_emit
                .is_none_or(|last| now.saturating_duration_since(last) >= COALESCE_WINDOW);
        if due {
            self.last_shell_emit = Some(now);
            self.shell_dirty = false;
        }
        due
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

    pub(crate) fn thread_snap(thread_id: &str, text: &str, working: bool) -> FfiThreadSnapshot {
        FfiThreadSnapshot {
            has_earlier: false,
            loading_earlier: false,
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
    fn coalesces_rapid_shell_updates_and_flushes_once() {
        let mut coalescer = SnapshotCoalescer::default();
        let t0 = Instant::now();
        assert!(
            coalescer.push_shell(t0),
            "first shell update must emit immediately"
        );
        assert!(
            !coalescer.push_shell(t0 + Duration::from_millis(10)),
            "update inside 50 ms window must be coalesced"
        );
        assert!(!coalescer.push_shell(t0 + Duration::from_millis(25)));
        assert_eq!(
            coalescer.next_deadline(),
            Some(t0 + COALESCE_WINDOW),
            "deadline must be 50 ms after the previous emission"
        );
        assert!(
            !coalescer.drain_due_shell(t0 + Duration::from_millis(49)),
            "must not flush before 50 ms elapses"
        );
        assert!(coalescer.drain_due_shell(t0 + COALESCE_WINDOW));
        assert!(
            coalescer.next_deadline().is_none(),
            "no pending work should remain after flush"
        );
    }

    #[test]
    fn a_retry_discards_the_previous_sockets_buffer_and_publishes_its_marker_immediately() {
        let mut buffer = SnapshotCoalescer::default();
        let now = Instant::now();
        assert!(buffer.push_shell(now));
        assert!(!buffer.push_shell(now));
        buffer.reset_shell();
        assert!(!buffer.drain_due_shell(now + COALESCE_WINDOW));
        assert!(buffer.push_shell(now));
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
