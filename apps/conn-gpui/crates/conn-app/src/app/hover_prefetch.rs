//! Thread content prefetch for the sidebar hover card.
//!
//! Resting on a thread row the engine does not hold opens it in its environment's engine, as a
//! click would, so a click finds its timeline warm or already on the way. A thread the engine
//! holds or stores is current already and needs nothing. One thread at a time is prefetched, and
//! an entry nobody hovers again closes.
//!
//! - A click promotes the entry: the thread is open already, so the open sends nothing twice.
//! - The entry changes no selection, composer or panel. Like any open it counts as opened for the
//!   engine's keep window.

use std::time::{Duration, Instant};

use gpui_kit::Context;

use super::ConnApp;
use crate::sidebar::hover_card_state::OPEN_DELAY;

/// How long the entry lives without a new hover.
const SPECULATIVE_TTL: Duration = Duration::from_secs(30);

struct Speculative {
    thread_id: String,
    touched_at: Instant,
}

/// The one prefetched thread there can be.
#[derive(Default)]
pub(super) struct SpeculativeThreads {
    live: Option<Speculative>,
    timer_armed: bool,
}

impl SpeculativeThreads {
    /// The prefetched thread, if any.
    pub(super) fn thread(&self) -> Option<&str> {
        self.live.as_ref().map(|entry| entry.thread_id.as_str())
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

    /// Makes `thread_id` the live entry, pushing out the previous one.
    fn begin(&mut self, thread_id: &str, now: Instant) {
        self.live = Some(Speculative {
            thread_id: thread_id.to_owned(),
            touched_at: now,
        });
    }

    /// Takes the entry out: the selected thread keeps it open now.
    pub(super) fn promote(&mut self, thread_id: &str) {
        if self.thread() == Some(thread_id) {
            self.live = None;
        }
    }

    /// Removes the entry when nobody hovered it for [`SPECULATIVE_TTL`]. An entry whose row is
    /// still hovered (`hovered`) stays: the pointer may rest there longer before the click.
    /// Returns whether it went.
    fn expire(&mut self, now: Instant, hovered: Option<&str>) -> bool {
        self.timer_armed = false;
        let Some(entry) = self.live.as_mut() else {
            return false;
        };
        if now.saturating_duration_since(entry.touched_at) < SPECULATIVE_TTL {
            return false;
        }
        if hovered == Some(entry.thread_id.as_str()) {
            entry.touched_at = now;
            return false;
        }
        self.live = None;
        true
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
    /// Closes the entry if it timed out, and keeps it while its row is hovered.
    fn expire_speculative(&mut self, now: Instant, cx: &mut Context<'_, Self>) {
        let hovered = self.thread_hover.open_for().map(str::to_owned);
        if self.speculative.expire(now, hovered.as_deref()) {
            self.sync_open_threads(cx);
        }
    }

    /// Opens the hovered thread when it is not current. Runs once the pointer has rested.
    pub(crate) fn prefetch_hovered_thread(&mut self, thread_id: &str, cx: &mut Context<'_, Self>) {
        // No card means no prefetch: a menu, a rename or a drag took the pointer.
        if self.thread_hover_suppressed() {
            return;
        }
        let now = Instant::now();
        if !self.speculative.touch(thread_id, now) {
            if self.shell.find_thread(thread_id).is_none()
                || self.thread_current(thread_id)
                || !self.thread_connected(thread_id)
            {
                return;
            }
            self.speculative.begin(thread_id, now);
            self.sync_open_threads(cx);
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

    fn arm_speculative_timer(&mut self, now: Instant, cx: &mut Context<'_, Self>) {
        let Some(delay) = self.speculative.arm_timer(now) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |app, cx| {
                let now = Instant::now();
                app.expire_speculative(now, cx);
                app.arm_speculative_timer(now, cx);
            });
        })
        .detach();
    }

    /// Forgets the entry of a connection that is gone.
    pub(super) fn reset_speculative(&mut self) {
        self.speculative = SpeculativeThreads::default();
    }

    #[cfg(test)]
    pub(crate) fn speculative_threads_for_test(&self) -> Vec<String> {
        self.speculative
            .thread()
            .map(str::to_owned)
            .into_iter()
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn thread_connected_for_test(&self, thread_id: &str) -> bool {
        self.thread_connected(thread_id)
    }

    #[cfg(test)]
    pub(crate) fn expire_speculative_for_test(
        &mut self,
        after: Duration,
        cx: &mut Context<'_, Self>,
    ) {
        self.expire_speculative(Instant::now() + after, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rapid_hover_keeps_one_entry() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::default();
        set.begin("a", now);
        set.begin("b", now);
        assert_eq!(set.thread(), Some("b"));
        for i in 0..20 {
            set.begin(&format!("row-{i}"), now);
            assert_eq!(set.thread(), Some(format!("row-{i}").as_str()));
        }
    }

    #[test]
    fn hovering_the_live_entry_again_refreshes_it() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::default();
        set.begin("a", now);
        let later = now + Duration::from_secs(20);
        assert!(set.touch("a", later));
        assert!(!set.touch("zzz", later));
        assert!(!set.expire(now + SPECULATIVE_TTL, None), "refreshed");
        assert_eq!(set.thread(), Some("a"));
    }

    #[test]
    fn an_entry_whose_row_is_still_hovered_outlives_the_ttl() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::default();
        set.begin("a", now);
        let late = now + SPECULATIVE_TTL * 2;
        assert!(set.expire(late, Some("b")), "another row: gone");

        set.begin("a", now);
        assert!(!set.expire(late, Some("a")), "hovered: kept");
        assert_eq!(set.thread(), Some("a"));
        // The pointer stays for another full TTL, then leaves.
        assert!(!set.expire(late + SPECULATIVE_TTL, Some("a")));
        assert!(set.expire(late + SPECULATIVE_TTL * 2, None));
    }

    #[test]
    fn a_click_takes_the_entry() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::default();
        set.begin("a", now);
        set.promote("other");
        assert_eq!(set.thread(), Some("a"));
        set.promote("a");
        assert_eq!(set.thread(), None);
        assert!(!set.expire(now + SPECULATIVE_TTL * 2, None));
    }

    #[test]
    fn an_abandoned_entry_expires_and_one_timer_aims_at_it() {
        let now = Instant::now();
        let mut set = SpeculativeThreads::default();
        assert_eq!(set.arm_timer(now), None, "nothing to wait for");
        set.begin("a", now);
        assert_eq!(set.arm_timer(now), Some(SPECULATIVE_TTL));
        assert_eq!(set.arm_timer(now), None, "one timer at a time");

        assert!(!set.expire(now + Duration::from_secs(10), None));
        assert!(set.expire(now + SPECULATIVE_TTL, None));
        assert_eq!(set.thread(), None);
    }
}
