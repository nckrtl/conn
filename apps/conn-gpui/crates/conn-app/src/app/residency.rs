//! How many thread timelines stay in memory.
//!
//! Every thread the user opens gets a reducer in `ConnApp::threads`. Without a limit each one kept
//! its whole loaded history for the rest of the session. Now a reducer stays only while something
//! needs it:
//!
//! - the open (selected or subscribed) thread;
//! - a thread another owner streams: the offline cache's watches, a child approval, a launch or
//!   the hover prefetch ([`ConnApp::thread_stream_wanted`]);
//! - one of the [`RECENT_THREADS`] threads opened last, so switching back is instant;
//! - a thread with an offline-cache write still to go, so nothing waits to be saved from a
//!   reducer that is gone. It goes on a later sweep.
//!
//! Dropping a reducer also drops the client's kept sequence (`Connection::forget_thread`), so the
//! next open asks for a snapshot instead of a replay with no reducer to apply it to. The thread
//! reopens from the offline cache at once, and from the server once its snapshot arrives.

use std::collections::VecDeque;

use super::ConnApp;

/// How many recently opened threads keep their timeline after the user leaves them.
pub(super) const RECENT_THREADS: usize = 8;

/// The threads opened last, oldest first. Holds at most [`RECENT_THREADS`] ids.
#[derive(Debug, Default)]
pub(super) struct RecentThreads {
    order: VecDeque<String>,
}

impl RecentThreads {
    /// Records that `thread_id` was opened now.
    pub(super) fn touch(&mut self, thread_id: &str) {
        if let Some(index) = self.order.iter().position(|id| id == thread_id) {
            self.order.remove(index);
        }
        self.order.push_back(thread_id.to_owned());
        while self.order.len() > RECENT_THREADS {
            self.order.pop_front();
        }
    }

    pub(super) fn contains(&self, thread_id: &str) -> bool {
        self.order.iter().any(|id| id == thread_id)
    }

    /// Forgets `thread_id`, as for a deleted thread.
    pub(super) fn remove(&mut self, thread_id: &str) {
        self.order.retain(|id| id != thread_id);
    }
}

impl ConnApp {
    /// Whether `thread_id`'s reducer must stay in memory now.
    fn thread_resident(&self, thread_id: &str) -> bool {
        self.layout.selected_thread_id.as_deref() == Some(thread_id)
            || self.subscribed_thread_id.as_deref() == Some(thread_id)
            || self.recent_threads.contains(thread_id)
            || self.thread_stream_wanted(thread_id)
            || self
                .cache_env(thread_id)
                .is_some_and(|env| self.offline.write_pending(env, thread_id))
    }

    /// Drops the reducers nothing needs any more (see the module docs). Returns how many went.
    pub(super) fn evict_cold_threads(&mut self) -> usize {
        let cold: Vec<String> = self
            .threads
            .keys()
            .filter(|id| !self.thread_resident(id))
            .cloned()
            .collect();
        for thread_id in &cold {
            self.drop_thread_reducer(thread_id);
        }
        cold.len() + self.offline.evict_unwatched_shadows()
    }

    /// Drops `thread_id`'s visible reducer and the client's sequence for it. What the offline
    /// cache saved stays on disk.
    fn drop_thread_reducer(&mut self, thread_id: &str) {
        if let Some(connection) = self.connection_for_thread(thread_id) {
            connection.forget_thread(thread_id);
        }
        let env = self.cache_env(thread_id).map(str::to_owned);
        self.threads.remove(thread_id);
        self.ended_threads.remove(thread_id);
        if let Some(env) = env {
            self.offline.forget_stream(&env, thread_id);
            self.offline.forget_owner(&env, thread_id);
        }
    }

    /// Frees what a linked environment that is gone for good (unlinked, switched off, signed out)
    /// still holds in memory: its watches, the reducers it owns, its shadow reducers and its
    /// outlines. The open thread and reducers with a cache write still to go stay, as everywhere.
    pub(super) fn forget_linked_environment(&mut self, environment_id: &str) {
        self.offline.forget_environment(environment_id);
        let owned = self.offline.forget_environment_memory(environment_id);
        for thread_id in owned {
            let open = self.layout.selected_thread_id.as_deref() == Some(thread_id.as_str())
                || self.subscribed_thread_id.as_deref() == Some(thread_id.as_str());
            if open || self.offline.write_pending(environment_id, &thread_id) {
                continue;
            }
            self.recent_threads.remove(&thread_id);
            self.threads.remove(&thread_id);
            self.ended_threads.remove(&thread_id);
            self.offline.forget_stream(environment_id, &thread_id);
        }
    }

    #[cfg(test)]
    pub(crate) fn resident_threads_for_test(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.threads.keys().cloned().collect();
        ids.sort();
        ids
    }

    #[cfg(test)]
    pub(crate) fn evict_cold_threads_for_test(&mut self) -> usize {
        self.evict_cold_threads()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_threads_keep_the_last_opened_and_drop_the_oldest() {
        let mut recent = RecentThreads::default();
        for i in 0..RECENT_THREADS + 3 {
            recent.touch(&format!("t{i}"));
        }
        assert!(!recent.contains("t0"));
        assert!(!recent.contains("t2"));
        assert!(recent.contains("t3"));
        assert!(recent.contains(&format!("t{}", RECENT_THREADS + 2)));
        assert_eq!(recent.order.len(), RECENT_THREADS);
    }

    #[test]
    fn opening_a_recent_thread_again_makes_it_the_newest() {
        let mut recent = RecentThreads::default();
        for i in 0..RECENT_THREADS {
            recent.touch(&format!("t{i}"));
        }
        recent.touch("t0");
        recent.touch("new");
        assert!(recent.contains("t0"), "touched again, so not the oldest");
        assert!(!recent.contains("t1"), "the oldest went");
        recent.remove("t0");
        assert!(!recent.contains("t0"));
    }
}
