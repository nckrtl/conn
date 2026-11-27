//! A pull request watch's wake and how several become one, as T3's
//! `apps/server/src/orchestration-v2/pullRequestWatch.ts` does it
//! (`combinePullRequestWatchWakes`). The engine rebuilds a queued wake with it; what a wake
//! says is written in `conn-source-control` (`pull_requests/watch.rs`), whose
//! `tools/pr-watch-diff.mjs` runs T3's functions and these on the same cases.

use serde_json::{Value, json};

/// The closing of a wake for one pull request that is still watched. [`combine`] finds a
/// wake's closing by this exact text.
pub const WATCHING_CLOSING: &str = "Look into each item and act on it as your task requires. This PR stays linked and watched, so do not link, watch, or list it again. End your turn when you are done, and Conn wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.";
const WATCHING_CLOSING_PLURAL: &str = "Look into each item and act on it as your task requires. Each PR Conn still watches stays linked and watched, so do not link, watch, or list them again. End your turn when you are done, and Conn wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request for each first so the thread returns to their inbox.";

/// `PullRequestWatchWake`: the text and the notification (`{source, outcome, summary}`).
#[derive(Clone, Debug, PartialEq)]
pub struct Wake {
    pub text: String,
    pub outcome: &'static str,
    pub summary: String,
}

impl Wake {
    pub fn notification(&self) -> Value {
        json!({"source": {"kind": "monitor"}, "outcome": self.outcome, "summary": self.summary})
    }
}

/// `combinePullRequestWatchWakes`: one wake for several pull requests, closing said once.
pub fn combine(wakes: &[Wake]) -> Option<Wake> {
    match wakes {
        [] => None,
        [one] => Some(one.clone()),
        _ => {
            let closing = format!("\n\n{WATCHING_CLOSING}");
            let watching = wakes.iter().any(|w| w.text.ends_with(&closing));
            let mut texts: Vec<&str> = wakes
                .iter()
                .map(|w| w.text.strip_suffix(closing.as_str()).unwrap_or(&w.text))
                .collect();
            if watching {
                texts.push(WATCHING_CLOSING_PLURAL);
            }
            let outcome = if wakes.iter().any(|w| w.outcome == "failed") {
                "failed"
            } else if wakes.iter().all(|w| w.outcome == "completed") {
                "completed"
            } else {
                "updated"
            };
            Some(Wake {
                text: texts.join("\n\n"),
                outcome,
                summary: wakes
                    .iter()
                    .map(|w| w.summary.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
            })
        }
    }
}
