//! SQL handed to a thread's Database panel before it can take it (`pendingByThreadKey` and
//! `takePending` in Conn's `databaseStore.ts` / `DatabasePanel.tsx`). A query waits, keyed by
//! its thread, until that thread shows, its project's connections have loaded and one is chosen.

/// Threads with a query waiting. Each is dropped on delivery or an explicit release; past this,
/// the oldest waiting query goes.
const MAX_PENDING: usize = 32;

#[derive(Debug, Default)]
pub(super) struct PendingQueries {
    /// `(thread, sql)`, oldest first; one per thread, the latest wins.
    queries: Vec<(String, String)>,
    /// Bumped by every Vault load, so only the newest one's answer counts.
    vault_load: u64,
    vault_loading: bool,
}

impl PendingQueries {
    /// Queues `sql` for `thread`, replacing what waited there.
    pub(super) fn queue(&mut self, thread: &str, sql: String) {
        self.queries.retain(|(waiting, _)| waiting != thread);
        self.queries.push((thread.to_owned(), sql));
        if self.queries.len() > MAX_PENDING {
            self.queries.remove(0);
        }
    }

    /// A Vault load starts; returns its token.
    pub(super) fn begin_vault_load(&mut self) -> u64 {
        self.vault_load = self.vault_load.wrapping_add(1);
        self.vault_loading = true;
        self.vault_load
    }

    /// No Vault load is coming (none installed): every earlier one is stale.
    pub(super) fn end_vault_loads(&mut self) {
        self.vault_load = self.vault_load.wrapping_add(1);
        self.vault_loading = false;
    }

    /// The load `token` answered. `false` when a newer load started since: drop its answer.
    pub(super) fn finish_vault_load(&mut self, token: u64) -> bool {
        if token != self.vault_load {
            return false;
        }
        self.vault_loading = false;
        true
    }

    /// Takes `thread`'s query once the connections have loaded and one is chosen.
    pub(super) fn take(&mut self, thread: Option<&str>, has_connection: bool) -> Option<String> {
        if self.vault_loading || !has_connection {
            return None;
        }
        let thread = thread?;
        let index = self.queries.iter().position(|(t, _)| t == thread)?;
        Some(self.queries.remove(index).1)
    }

    /// Drops a deleted thread's query.
    pub(super) fn forget(&mut self, thread: &str) {
        self.queries.retain(|(waiting, _)| waiting != thread);
    }

    #[cfg(test)]
    pub(super) fn waiting(&self, thread: &str) -> Option<&str> {
        self.queries
            .iter()
            .find(|(t, _)| t == thread)
            .map(|(_, sql)| sql.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_waits_for_its_thread_and_a_connection() {
        let mut pending = PendingQueries::default();
        pending.queue("a", "select 1".into());
        assert_eq!(pending.take(Some("b"), true), None, "another thread shows");
        assert_eq!(pending.take(Some("a"), false), None, "no connection yet");
        assert_eq!(pending.take(None, true), None);
        assert_eq!(pending.take(Some("a"), true).as_deref(), Some("select 1"));
        assert_eq!(pending.take(Some("a"), true), None, "delivered once");
    }

    #[test]
    fn only_the_newest_vault_load_releases_a_query() {
        let mut pending = PendingQueries::default();
        pending.queue("a", "select 2".into());
        let first = pending.begin_vault_load();
        // Refresh while the first load still runs.
        let second = pending.begin_vault_load();
        assert!(
            !pending.finish_vault_load(first),
            "the older answer is dropped"
        );
        assert_eq!(pending.take(Some("a"), true), None, "still loading");
        assert!(pending.finish_vault_load(second));
        assert_eq!(pending.take(Some("a"), true).as_deref(), Some("select 2"));
        // No Vault: an answer from before is stale and nothing waits on it.
        pending.queue("a", "select 3".into());
        let stale = pending.begin_vault_load();
        pending.end_vault_loads();
        assert!(!pending.finish_vault_load(stale));
        assert_eq!(pending.take(Some("a"), true).as_deref(), Some("select 3"));
    }

    #[test]
    fn one_query_per_thread_and_a_cap() {
        let mut pending = PendingQueries::default();
        pending.queue("a", "old".into());
        pending.queue("a", "new".into());
        assert_eq!(pending.waiting("a"), Some("new"));
        for index in 0..MAX_PENDING {
            pending.queue(&format!("t{index}"), "x".into());
        }
        assert_eq!(pending.waiting("a"), None, "the oldest goes past the cap");
        pending.forget("t1");
        assert_eq!(pending.waiting("t1"), None);
        assert_eq!(pending.waiting("t2"), Some("x"));
    }
}
