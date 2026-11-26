//! Which threads a client keeps subscribed in the background while it is open and in the
//! foreground, so opening one shows its latest state at once.

use std::cmp::Reverse;

use conn_contract::OrchestrationV2ThreadShell as ThreadShell;

use crate::shell::{ShellState, ThreadActivity};
use crate::thread::parse_iso8601_epoch_ms;

/// The most threads kept warm, besides the open one. Each costs one bounded thread stream.
pub const WARM_THREAD_CAP: usize = 10;

/// How long the warm set waits after a shell change before it picks again, so a burst of
/// shell events picks once.
pub const WARM_REPICK_DEBOUNCE_MS: u64 = 750;

/// The threads to keep warm, best first, at most `cap`: listed, unsettled and not snoozed;
/// threads that need the user, then working threads, then the most recently updated.
#[must_use]
pub fn pick_warm_threads(shell: &ShellState, now_ms: i64, cap: usize) -> Vec<String> {
    let mut picked: Vec<(u8, Reverse<i64>, &ThreadShell)> = shell
        .top_level_active_threads()
        .filter(|thread| !snoozed(thread, now_ms))
        .map(|thread| {
            let tier = match shell.activity(&thread.id) {
                ThreadActivity::NeedsAttention => 0,
                ThreadActivity::Working => 1,
                ThreadActivity::Idle | ThreadActivity::Failed => 2,
            };
            let updated = parse_iso8601_epoch_ms(&thread.updated_at).unwrap_or_default();
            (tier, Reverse(updated), thread)
        })
        .collect();
    picked.sort_by(|a, b| (a.0, a.1, &a.2.id).cmp(&(b.0, b.1, &b.2.id)));
    picked
        .into_iter()
        .take(cap)
        .map(|(_, _, thread)| thread.id.clone())
        .collect()
}

fn snoozed(thread: &ThreadShell, now_ms: i64) -> bool {
    thread
        .snoozed_until
        .as_ref()
        .and_then(Option::as_deref)
        .and_then(parse_iso8601_epoch_ms)
        .is_some_and(|until| until > now_ms)
}

#[cfg(test)]
mod tests {
    use conn_contract::{OrchestrationV2ShellStreamItem, from_json};
    use serde_json::{Value, json};

    use super::*;
    use crate::test_threads::thread_json;

    const NOW: i64 = 1_795_000_000_000;

    fn shell(threads: Vec<Value>) -> ShellState {
        let item: OrchestrationV2ShellStreamItem = from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 1,
                "projects": [],
                "threads": threads,
                "archivedThreads": []
            }
        }))
        .expect("snapshot decodes");
        let mut state = ShellState::default();
        state.apply(item);
        state
    }

    fn at(id: &str, minute: u32, edit: impl FnOnce(&mut Value)) -> Value {
        thread_json(id, "p", |t| {
            t["updatedAt"] = json!(format!("2026-11-13T09:{minute:02}:00.000Z"));
            edit(t);
        })
    }

    #[test]
    fn picks_attention_then_working_then_recent_and_skips_hidden_threads() {
        let state = shell(vec![
            at("old", 1, |_| {}),
            at("recent", 30, |_| {}),
            at("newest", 40, |_| {}),
            at("working", 2, |t| t["activityRunStatus"] = json!("running")),
            at("asks", 3, |t| {
                t["pendingRuntimeRequest"] =
                    json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
            }),
            at("settled", 50, |t| {
                t["settledAt"] = json!("2026-11-13T09:50:00.000Z");
            }),
            at("archived", 51, |t| {
                t["archivedAt"] = json!("2026-11-13T09:51:00.000Z");
            }),
            at("deleted", 52, |t| {
                t["deletedAt"] = json!("2026-11-13T09:52:00.000Z");
            }),
            at("child", 53, |t| {
                t["lineage"]["parentThreadId"] = json!("recent");
                t["lineage"]["relationshipToParent"] = json!("subagent");
            }),
            at("snoozed", 54, |t| {
                t["snoozedUntil"] = json!("2030-01-01T00:00:00.000Z")
            }),
            at("woke", 55, |t| {
                t["snoozedUntil"] = json!("2020-01-01T00:00:00.000Z")
            }),
        ]);

        assert_eq!(
            pick_warm_threads(&state, NOW, 10),
            ["asks", "working", "woke", "newest", "recent", "old"]
        );
        assert_eq!(
            pick_warm_threads(&state, NOW, 3),
            ["asks", "working", "woke"]
        );
        assert!(pick_warm_threads(&state, NOW, 0).is_empty());
    }

    #[test]
    fn the_cap_holds_for_many_unsettled_threads() {
        let threads = (0..40)
            .map(|i| at(&format!("t{i:02}"), i, |_| {}))
            .collect();
        let picked = pick_warm_threads(&shell(threads), NOW, WARM_THREAD_CAP);
        let newest: Vec<String> = (30..40).rev().map(|i| format!("t{i:02}")).collect();
        assert_eq!(picked, newest);
    }
}
