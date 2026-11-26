//! Thread content prefetch for the sidebar hover card.
//!
//! Resting on a real thread row starts the normal bounded `subscribeThread` on the thread's own
//! environment, so a click finds its timeline warm or already on the way. The subscription is
//! speculative: it changes no selection, read state, composer or panel. One thread at a time is
//! prefetched, and an entry nobody hovers again expires.
//!
//! - A click (`subscribe_open_thread`) promotes the entry. The client already holds the stream, so
//!   the open sends nothing twice.
//! - When the open thread, a child approval or the offline cache holds the thread, the entry gives
//!   way and never tears down a stream it does not own.
//! - Dropping an entry that created its thread's reducer also drops the reducer and the client's
//!   sequence for it (`Connection::forget_thread`). Keeping only the sequence would make the next
//!   subscribe ask for a replay with no reducer to apply it to. Late items of the dropped stream
//!   find no reducer and are ignored (`thread_item_is_orphaned`). A thread that was cached before
//!   keeps its cache and its sequence, as a regular close does.
//! - What the prefetch wrote to the offline cache stays: it is the same bounded preview an open
//!   writes, and the cache's own retention decides how long it lives.

use std::time::{Duration, Instant};

use conn_client::Connection;
use conn_state::ThreadState;
use gpui_kit::Context;

use super::ConnApp;
use crate::sidebar::hover_card_state::OPEN_DELAY;

/// How long the entry lives without a new hover.
const SPECULATIVE_TTL: Duration = Duration::from_secs(30);

/// One speculative subscription. `C` is the connection it runs on.
pub(super) struct Speculative<C> {
    thread_id: String,
    /// The environment the thread lives on (its offline-cache environment), so the same thread id
    /// on another environment is not this entry's.
    environment: Option<String>,
    /// The entry created the thread's reducer, so dropping it drops the reducer too.
    owns_cache: bool,
    connection: C,
    touched_at: Instant,
}

/// The one speculative subscription there can be.
pub(super) struct SpeculativeThreads<C> {
    live: Option<Speculative<C>>,
    timer_armed: bool,
}

impl<C> Default for SpeculativeThreads<C> {
    fn default() -> Self {
        Self {
            live: None,
            timer_armed: false,
        }
    }
}

impl<C> SpeculativeThreads<C> {
    pub(super) fn holds(&self, thread_id: &str) -> bool {
        self.live
            .as_ref()
            .is_some_and(|entry| entry.thread_id == thread_id)
    }

    /// Whether the live entry is `thread_id` on `environment`. Without an environment (a stream
    /// of no known environment) the thread id alone decides.
    fn holds_on(&self, environment: Option<&str>, thread_id: &str) -> bool {
        self.live.as_ref().is_some_and(|entry| {
            entry.thread_id == thread_id
                && environment.is_none_or(|environment| {
                    entry
                        .environment
                        .as_deref()
                        .is_none_or(|own| own == environment)
                })
        })
    }

    /// A new hover on the live entry keeps it. Returns whether it was the live one.
    fn touch(&mut self, thread_id: &str, now: Instant) -> bool {
        match self.live.as_mut() {
            Some(entry) if entry.thread_id == thread_id => {
                entry.touched_at = now;
                true
            }
            _ => false,
        }
    }

    /// Makes `thread_id` the live entry. Returns the entry it pushed out.
    fn begin(
        &mut self,
        thread_id: &str,
        environment: Option<&str>,
        owns_cache: bool,
        connection: C,
        now: Instant,
    ) -> Option<Speculative<C>> {
        self.live.replace(Speculative {
            thread_id: thread_id.to_owned(),
            environment: environment.map(str::to_owned),
            owns_cache,
            connection,
            touched_at: now,
        })
    }

    /// Takes the entry out without tearing anything down: the open thread owns the stream now.
    pub(super) fn promote(&mut self, thread_id: &str) {
        if self.holds(thread_id) {
            self.live = None;
        }
    }

    /// Removes the entry when nobody hovered it for [`SPECULATIVE_TTL`]. An entry whose row is
    /// still hovered (`hovered`) stays: the pointer may rest there longer before the click.
    fn expire(&mut self, now: Instant, hovered: Option<&str>) -> Option<Speculative<C>> {
        self.timer_armed = false;
        let entry = self.live.as_mut()?;
        if now.saturating_duration_since(entry.touched_at) < SPECULATIVE_TTL {
            return None;
        }
        if hovered == Some(entry.thread_id.as_str()) {
            entry.touched_at = now;
            return None;
        }
        self.live.take()
    }

    /// The delay until the entry expires, when a timer must start for it.
    fn arm_timer(&mut self, now: Instant) -> Option<Duration> {
        if self.timer_armed {
            return None;
        }
        let entry = self.live.as_ref()?;
        self.timer_armed = true;
        Some(SPECULATIVE_TTL.saturating_sub(now.saturating_duration_since(entry.touched_at)))
    }
}

impl ConnApp {
    /// Whether another owner keeps `thread_id`'s stream: the open or selected thread, a launch
    /// that subscribed it directly, a child approval, or the offline cache.
    fn thread_stream_claimed(&self, thread_id: &str) -> bool {
        self.thread_stream_claimed_on(self.cache_env(thread_id), thread_id)
    }

    /// Whether another owner keeps the stream of `thread_id` on `env`. The open or selected
    /// thread, a launch and a child approval name a thread id, so they own the stream only of the
    /// environment that thread lives on; the offline cache watches a thread of its own
    /// environment. `None` is a stream of no known environment.
    fn thread_stream_claimed_on(&self, env: Option<&str>, thread_id: &str) -> bool {
        let lives_here = env.is_none_or(|env| self.cache_env(thread_id) == Some(env));
        (lives_here
            && (self.subscribed_thread_id.as_deref() == Some(thread_id)
                || self.layout.selected_thread_id.as_deref() == Some(thread_id)
                || self.launched_threads.contains(thread_id)
                || self.child_approvals.holds(thread_id)))
            || self
                .offline
                .watching(env.or_else(|| self.cache_env(thread_id)), thread_id)
    }

    /// Whether anything wants `thread_id`'s stream now. An ended stream of any other thread was
    /// released on purpose and is not asked for again.
    pub(super) fn thread_stream_wanted(&self, thread_id: &str) -> bool {
        self.thread_stream_claimed(thread_id) || self.speculative.holds(thread_id)
    }

    /// Whether an item of `thread_id`'s stream on `env` has nobody to apply to: no reducer holds
    /// the thread on that environment and nobody wants its stream. The stream was dropped with
    /// its reducer, so the item is late and must not bring the reducer back.
    ///
    /// The same thread id can live on two environments, so every part compares the stream's own
    /// environment along with the thread id: another environment's reducer, prefetch or open
    /// thread neither keeps this item nor drops it.
    pub(super) fn thread_item_is_orphaned(&self, env: Option<&str>, thread_id: &str) -> bool {
        let reducer_here = self.threads.contains_key(thread_id)
            && env.is_none_or(|env| self.cache_env(thread_id) == Some(env));
        let shadowed = env.is_some_and(|env| self.offline.shadows(env, thread_id));
        let wanted = self.thread_stream_claimed_on(env, thread_id)
            || self.speculative.holds_on(env, thread_id);
        !reducer_here && !shadowed && !wanted
    }

    /// Records that a draft launch subscribed `thread_id` itself, so a hover prefetch never takes
    /// or ends that stream. Opening the thread hands the stream to the open subscription.
    pub(super) fn claim_launched_stream(&mut self, thread_id: &str) {
        self.speculative.promote(thread_id);
        self.launched_threads.insert(thread_id.to_owned());
    }

    /// Ends the speculative entry if it timed out, and keeps it while its row is hovered.
    fn expire_speculative(&mut self, now: Instant) {
        let hovered = self.thread_hover.open_for().map(str::to_owned);
        if let Some(entry) = self.speculative.expire(now, hovered.as_deref()) {
            self.drop_speculative(entry);
        }
    }

    /// Starts the content subscription of the hovered thread. Runs once the pointer has rested.
    pub(crate) fn prefetch_hovered_thread(&mut self, thread_id: &str, cx: &mut Context<'_, Self>) {
        // No card means no prefetch: a menu, a rename or a drag took the pointer.
        if self.thread_hover_suppressed() {
            return;
        }
        let now = Instant::now();
        if !self.speculative.touch(thread_id, now) {
            if self.shell.find_thread(thread_id).is_none()
                || self.thread_stream_claimed(thread_id)
                || !self.thread_connected(thread_id)
            {
                return;
            }
            let Some(connection) = self.connection_for_thread(thread_id) else {
                return;
            };
            let environment = self.cache_env(thread_id).map(str::to_owned);
            let owns_cache = !self.threads.contains_key(thread_id);
            self.threads
                .entry(thread_id.to_owned())
                .or_insert_with(|| ThreadState::new(thread_id.to_owned()));
            self.ended_threads.remove(thread_id);
            connection.subscribe_thread(thread_id);
            if let Some(previous) = self.speculative.begin(
                thread_id,
                environment.as_deref(),
                owns_cache,
                connection,
                now,
            ) {
                self.drop_speculative(previous);
            }
        }
        self.arm_speculative_timer(now, cx);
    }

    /// Prefetches when the card is still on `thread_id` after [`OPEN_DELAY`]. A card that slides
    /// from row to row opens at once on each, which must not fetch every row it passes.
    /// `generation` is the hover generation of the open. Leaving and entering the row again, and
    /// scrolling the list, start a new one, so an earlier dwell does not count for a later hover
    /// and a list that is scrolling prefetches nothing.
    pub(crate) fn prefetch_after_dwell(
        &mut self,
        thread_id: &str,
        generation: u64,
        cx: &mut Context<'_, Self>,
    ) {
        let thread_id = thread_id.to_owned();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(OPEN_DELAY).await;
            let _ = this.update(cx, |app, cx| {
                if app.thread_hover.open_for() == Some(thread_id.as_str())
                    && app.thread_hover.generation() == generation
                {
                    app.prefetch_hovered_thread(&thread_id, cx);
                }
            });
        })
        .detach();
    }

    /// Ends the speculative subscription, unless another owner holds it.
    fn drop_speculative(&mut self, entry: Speculative<Connection>) {
        // The entry's own environment decides, not the thread id alone: the same thread id on
        // another environment is not this stream's.
        let environment = entry.environment.as_deref();
        if self.thread_stream_claimed_on(environment, &entry.thread_id) {
            return;
        }
        if entry.owns_cache {
            entry.connection.forget_thread(&entry.thread_id);
            if environment.is_none_or(|env| self.cache_env(&entry.thread_id) == Some(env)) {
                self.threads.remove(&entry.thread_id);
                self.ended_threads.remove(&entry.thread_id);
            }
            if let Some(env) = environment {
                self.offline.forget_stream(env, &entry.thread_id);
            }
        } else {
            entry.connection.unsubscribe_thread(&entry.thread_id);
        }
    }

    fn arm_speculative_timer(&mut self, now: Instant, cx: &mut Context<'_, Self>) {
        let Some(delay) = self.speculative.arm_timer(now) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |app, cx| {
                let now = Instant::now();
                app.expire_speculative(now);
                app.arm_speculative_timer(now, cx);
            });
        })
        .detach();
    }

    /// Forgets the entry and the launches of a connection that is gone.
    pub(super) fn reset_speculative(&mut self) {
        self.speculative = SpeculativeThreads::default();
        self.launched_threads.clear();
    }

    #[cfg(test)]
    pub(crate) fn speculative_threads_for_test(&self) -> Vec<String> {
        self.speculative
            .live
            .iter()
            .map(|entry| entry.thread_id.clone())
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn thread_item_is_orphaned_for_test(
        &self,
        env: Option<&str>,
        thread_id: &str,
    ) -> bool {
        self.thread_item_is_orphaned(env, thread_id)
    }

    /// Test helper: the environment `thread_id`'s items are cached under.
    #[cfg(test)]
    pub(crate) fn cache_env_for_test(&self, thread_id: &str) -> Option<String> {
        self.cache_env(thread_id).map(str::to_owned)
    }

    /// Test helper: the offline cache watches `thread_id` on `env`, as it does for every thread it
    /// keeps.
    #[cfg(test)]
    pub(crate) fn watch_cache_stream_for_test(&mut self, env: &str, thread_id: &str) {
        if let Some(connection) = self.connection.clone() {
            self.offline.watch_for_test(env, thread_id, connection);
        }
    }

    #[cfg(test)]
    pub(crate) fn thread_cached_for_test(&self, thread_id: &str) -> bool {
        self.threads.contains_key(thread_id)
    }

    #[cfg(test)]
    pub(crate) fn thread_connected_for_test(&self, thread_id: &str) -> bool {
        self.thread_connected(thread_id)
    }

    #[cfg(test)]
    pub(crate) fn apply_thread_item_for_test(
        &mut self,
        thread_id: &str,
        item: conn_contract::OrchestrationV2ThreadStreamItem,
        cx: &mut Context<'_, Self>,
    ) {
        let event = conn_client::ClientEvent::Thread {
            thread_id: thread_id.to_owned(),
            item,
        };
        self.apply_event(event, None, cx);
    }

    #[cfg(test)]
    pub(crate) fn end_thread_stream_for_test(
        &mut self,
        thread_id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let event = conn_client::ClientEvent::StreamEnded {
            tag: "orchestration.subscribeThread".to_owned(),
            key: thread_id.to_owned(),
            error: None,
        };
        self.apply_event(event, None, cx);
    }

    #[cfg(test)]
    pub(crate) fn ended_thread_for_test(&self, thread_id: &str) -> bool {
        self.ended_threads.contains(thread_id)
    }

    #[cfg(test)]
    pub(crate) fn expire_speculative_for_test(&mut self, after: Duration) {
        self.expire_speculative(Instant::now() + after);
    }

    #[cfg(test)]
    pub(crate) fn claim_launched_stream_for_test(&mut self, thread_id: &str) {
        self.claim_launched_stream(thread_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(set: &SpeculativeThreads<()>) -> Option<&str> {
        set.live.as_ref().map(|e| e.thread_id.as_str())
    }

    #[test]
    fn rapid_hover_keeps_one_entry_and_pushes_out_the_previous() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::<()>::default();
        assert!(set.begin("a", None, true, (), now).is_none());
        let pushed = set.begin("b", None, true, (), now);
        assert_eq!(pushed.map(|e| e.thread_id), Some("a".to_owned()));
        for i in 0..20 {
            set.begin(&format!("row-{i}"), None, true, (), now);
            assert_eq!(live(&set), Some(format!("row-{i}").as_str()));
        }
    }

    #[test]
    fn an_entry_belongs_to_its_environment_not_to_the_thread_id_alone() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::<()>::default();
        set.begin("a", Some("env-1"), true, (), now);
        assert!(set.holds_on(Some("env-1"), "a"));
        assert!(
            !set.holds_on(Some("env-2"), "a"),
            "same id, other environment"
        );
        assert!(!set.holds_on(Some("env-1"), "b"));
        assert!(set.holds_on(None, "a"), "no environment: the id decides");
    }

    #[test]
    fn hovering_the_live_entry_again_refreshes_it() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::<()>::default();
        set.begin("a", None, true, (), now);
        let later = now + Duration::from_secs(20);
        assert!(set.touch("a", later));
        assert!(!set.touch("zzz", later));
        assert!(
            set.expire(now + SPECULATIVE_TTL, None).is_none(),
            "refreshed"
        );
        assert_eq!(live(&set), Some("a"));
    }

    #[test]
    fn an_entry_whose_row_is_still_hovered_outlives_the_ttl() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::<()>::default();
        set.begin("a", None, true, (), now);
        let late = now + SPECULATIVE_TTL * 2;
        assert!(set.expire(late, Some("b")).is_some(), "another row: gone");

        set.begin("a", None, true, (), now);
        assert!(set.expire(late, Some("a")).is_none(), "hovered: kept");
        assert_eq!(live(&set), Some("a"));
        // The pointer stays for another full TTL, then leaves.
        assert!(set.expire(late + SPECULATIVE_TTL, Some("a")).is_none());
        assert!(set.expire(late + SPECULATIVE_TTL * 2, None).is_some());
    }

    #[test]
    fn a_click_takes_the_entry_without_tearing_down_its_stream() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::<()>::default();
        set.begin("a", None, true, (), now);
        set.promote("other");
        assert!(set.holds("a"));
        set.promote("a");
        assert!(!set.holds("a"));
        assert!(set.expire(now + SPECULATIVE_TTL * 2, None).is_none());
    }

    #[test]
    fn an_abandoned_entry_expires_and_one_timer_aims_at_it() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::<()>::default();
        assert_eq!(set.arm_timer(now), None, "nothing to wait for");
        set.begin("a", None, true, (), now);
        assert_eq!(set.arm_timer(now), Some(SPECULATIVE_TTL));
        assert_eq!(set.arm_timer(now), None, "one timer at a time");

        assert!(set.expire(now + Duration::from_secs(10), None).is_none());
        let expired = set.expire(now + SPECULATIVE_TTL, None);
        assert_eq!(expired.map(|e| e.thread_id), Some("a".to_owned()));
        assert_eq!(live(&set), None);
    }
}
