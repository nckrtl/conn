//! Pure state behind the sidebar thread hover flyout: the open/close timing and the rows to
//! show. No gpui types, so it can move to `conn-state::sidebar` unchanged.
//!
//! Not shown, because the client has no data for it: running terminal count, the
//! branch-mismatch warning (needs the live checkout branch), the model's display name (the
//! catalog lives in the composer, so the slug shows) and PR stack chains.

use std::time::{Duration, Instant};

use conn_contract::{
    OrchestrationV2ProviderFailureClass, PullRequestState, ThreadPullRequestLinkSource,
};
use conn_state::{ProjectShell, ThreadShell};

/// `TooltipProvider delay={150}`.
pub(crate) const OPEN_DELAY: Duration = Duration::from_millis(150);
/// `TooltipProvider timeout={400}`: a row entered this soon after a close opens at once.
const INSTANT_WINDOW: Duration = Duration::from_millis(400);

/// What the pointer asked of the card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entered {
    /// The card is open for the row now.
    Shown,
    /// Open the card if `elapse` still accepts this generation after [`OPEN_DELAY`].
    Wait(u64),
    /// Nothing changes.
    Unchanged,
}

/// Which row's card is open or waiting to open.
#[derive(Debug, Default)]
pub(crate) struct ThreadHoverState {
    open_for: Option<String>,
    pending_for: Option<String>,
    generation: u64,
    closed_at: Option<Instant>,
}

impl ThreadHoverState {
    /// Thread whose card is visible.
    #[must_use]
    pub(crate) fn open_for(&self) -> Option<&str> {
        self.open_for.as_deref()
    }

    /// The pointer entered `thread_id`'s row.
    pub(crate) fn enter(&mut self, thread_id: &str, now: Instant) -> Entered {
        if self.open_for.as_deref() == Some(thread_id) {
            return Entered::Unchanged;
        }
        self.generation = self.generation.wrapping_add(1);
        self.pending_for = None;
        let recently_closed = self
            .closed_at
            .is_some_and(|closed| now.saturating_duration_since(closed) <= INSTANT_WINDOW);
        if recently_closed || self.open_for.is_some() {
            self.open_for = Some(thread_id.to_owned());
            self.closed_at = None;
            Entered::Shown
        } else {
            self.pending_for = Some(thread_id.to_owned());
            Entered::Wait(self.generation)
        }
    }

    /// The pointer left `thread_id`'s row. Returns whether the visible card changed.
    pub(crate) fn leave(&mut self, thread_id: &str, now: Instant) -> bool {
        if self.pending_for.as_deref() == Some(thread_id) {
            self.pending_for = None;
            self.generation = self.generation.wrapping_add(1);
        }
        if self.open_for.as_deref() == Some(thread_id) {
            self.open_for = None;
            self.closed_at = Some(now);
            self.generation = self.generation.wrapping_add(1);
            return true;
        }
        false
    }

    /// The open delay for `generation` ran out. Returns whether the card opened.
    pub(crate) fn elapse(&mut self, generation: u64) -> bool {
        if self.generation != generation {
            return false;
        }
        match self.pending_for.take() {
            Some(thread_id) => {
                self.open_for = Some(thread_id);
                true
            }
            None => false,
        }
    }

    /// Closes the card and cancels a pending open (press, menu, rename, scroll). Returns whether
    /// the visible card changed. Unlike [`Self::leave`] it does not start the instant window.
    pub(crate) fn dismiss(&mut self) -> bool {
        self.pending_for = None;
        self.generation = self.generation.wrapping_add(1);
        self.closed_at = None;
        self.open_for.take().is_some()
    }
}

/// One linked pull request line of the footer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HoverPullRequest {
    pub(crate) number: i64,
    pub(crate) title: String,
    pub(crate) state: Option<(PullRequestState, bool)>,
}

/// What the card shows for a thread, in Conn's row order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HoverCardModel {
    pub(crate) title: String,
    pub(crate) project: Option<String>,
    pub(crate) environment: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) subagents: Option<i64>,
    pub(crate) handed_off_from: Option<String>,
    pub(crate) error: Option<HoverError>,
    pub(crate) pull_requests: Vec<HoverPullRequest>,
}

/// `lastError` row: `Usage limit reached` in warning, else `Error occurred` in error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HoverError {
    UsageLimit,
    Failed,
}

impl HoverError {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::UsageLimit => "Usage limit reached",
            Self::Failed => "Error occurred",
        }
    }
}

/// Instance id as shown when the client has no provider entry (`displayName ?? instanceId`).
fn provider_label(instance_id: &str) -> String {
    match instance_id {
        "claudeAgent" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        other => other.to_owned(),
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// Builds the rows to show; `None` fields hide their row.
#[must_use]
pub(crate) fn hover_card_model(
    thread: &ThreadShell,
    project: Option<&ProjectShell>,
    environment_label: Option<&str>,
) -> HoverCardModel {
    let previous: Vec<String> = thread
        .provider_instance_history
        .as_ref()
        .and_then(Option::as_ref)
        .into_iter()
        .flatten()
        .filter(|id| **id != thread.provider_instance_id)
        .map(|id| provider_label(id))
        .collect();
    let has_error = thread
        .last_error
        .as_ref()
        .and_then(Option::as_deref)
        .is_some_and(|e| !e.trim().is_empty());
    let error =
        has_error.then(
            || match thread.last_error_class.as_ref().and_then(Option::as_ref) {
                Some(OrchestrationV2ProviderFailureClass::UsageLimit) => HoverError::UsageLimit,
                _ => HoverError::Failed,
            },
        );

    let mut links: Vec<_> = thread
        .pull_requests
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|link| link.source != ThreadPullRequestLinkSource::StackDismissed)
        .collect();
    // Newest update first, as `pullRequestListLines` orders its chains.
    links.sort_by(|a, b| {
        let stamp = |l: &&conn_contract::ThreadPullRequestLink| {
            l.snapshot
                .as_ref()
                .and_then(|s| s.updated_at.clone())
                .unwrap_or_else(|| l.linked_at.clone())
        };
        stamp(b).cmp(&stamp(a))
    });
    let pull_requests = links
        .into_iter()
        .map(|link| HoverPullRequest {
            number: link.number,
            title: link
                .snapshot
                .as_ref()
                .map_or_else(|| link.repository.clone(), |s| s.title.clone()),
            state: link.snapshot.as_ref().map(|s| (s.state, s.is_draft)),
        })
        .collect();

    HoverCardModel {
        title: thread.title.clone(),
        project: project.and_then(|p| non_empty(Some(&p.title))),
        environment: non_empty(environment_label),
        branch: non_empty(thread.branch.as_deref()),
        provider: provider_label(&thread.provider_instance_id),
        model: thread
            .model_selection
            .model
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        subagents: thread.subagent_count.filter(|n| *n > 0),
        handed_off_from: (!previous.is_empty()).then(|| previous.join(", ")),
        error,
        pull_requests,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(ms: u64, base: Instant) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn first_hover_waits_then_opens_only_for_the_current_generation() {
        let base = Instant::now();
        let mut state = ThreadHoverState::default();
        let Entered::Wait(generation) = state.enter("a", base) else {
            panic!("first hover must wait for the open delay");
        };
        assert_eq!(state.open_for(), None);
        assert!(state.elapse(generation));
        assert_eq!(state.open_for(), Some("a"));
    }

    #[test]
    fn leaving_before_the_delay_cancels_the_open() {
        let base = Instant::now();
        let mut state = ThreadHoverState::default();
        let Entered::Wait(generation) = state.enter("a", base) else {
            panic!("expected wait");
        };
        assert!(!state.leave("a", t(50, base)));
        assert!(!state.elapse(generation));
        assert_eq!(state.open_for(), None);
    }

    #[test]
    fn entering_another_row_within_the_timeout_opens_at_once() {
        let base = Instant::now();
        let mut state = ThreadHoverState::default();
        let Entered::Wait(generation) = state.enter("a", base) else {
            panic!("expected wait");
        };
        assert!(state.elapse(generation));
        assert!(state.leave("a", t(1000, base)));
        assert_eq!(state.enter("b", t(1300, base)), Entered::Shown);
        assert_eq!(state.open_for(), Some("b"));
        assert!(state.leave("b", t(1400, base)));
        assert!(matches!(state.enter("c", t(1900, base)), Entered::Wait(_)));
    }

    #[test]
    fn dismiss_closes_without_starting_the_instant_window() {
        let base = Instant::now();
        let mut state = ThreadHoverState::default();
        let Entered::Wait(generation) = state.enter("a", base) else {
            panic!("expected wait");
        };
        assert!(state.elapse(generation));
        assert!(state.dismiss());
        assert!(matches!(state.enter("b", t(10, base)), Entered::Wait(_)));
    }

    #[test]
    fn dismiss_cancels_a_pending_open() {
        let base = Instant::now();
        let mut state = ThreadHoverState::default();
        let Entered::Wait(generation) = state.enter("a", base) else {
            panic!("expected wait");
        };
        assert!(!state.dismiss());
        assert!(!state.elapse(generation));
    }
}
