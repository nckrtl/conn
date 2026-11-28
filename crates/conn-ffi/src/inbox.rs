//! The inbox's cross-environment roll-up. Each environment's core computes its own statuses, so a
//! task delegated to another machine cannot flag the thread that delegated it there.

use std::sync::Arc;

use conn_state::ShellState;
use conn_state::environments::LinkedShells;

use crate::session::ConnSession;

/// One thread of one environment.
#[derive(Clone, Debug, PartialEq, Eq, Hash, uniffi::Record)]
pub struct FfiThreadKey {
    pub environment_id: String,
    pub thread_id: String,
}

/// The threads a child's request needs the user on, with the inbox's environments merged as the
/// desktop sidebar merges them: a task on one machine flags the thread on another that delegated
/// it. Pass every session the inbox lists, the primary first, whatever the inbox filter shows.
#[uniffi::export]
pub fn inbox_attention(sessions: Vec<Arc<ConnSession>>) -> Vec<FfiThreadKey> {
    let shells: Vec<(String, Arc<ShellState>)> = sessions
        .iter()
        .filter_map(|session| {
            let environment_id = session.state().environment_id?;
            Some((environment_id, session.core()?.roll_up_shell()?))
        })
        .collect();
    let borrowed: Vec<(&str, &ShellState)> = shells
        .iter()
        .map(|(id, shell)| (id.as_str(), shell.as_ref()))
        .collect();
    rolled_up_attention(&borrowed)
}

fn rolled_up_attention(shells: &[(&str, &ShellState)]) -> Vec<FfiThreadKey> {
    // Only a delegated task reaches across environments; each core flags everything else.
    let mut targets: Vec<&str> = shells
        .iter()
        .flat_map(|(_, shell)| shell.threads.iter().chain(&shell.archived_threads))
        .filter_map(|thread| thread.delegated_from.as_ref())
        .map(|from| from.environment_id.as_str())
        .filter(|target| shells.iter().any(|(id, _)| id == target))
        .collect();
    targets.sort_unstable();
    targets.dedup();
    // A merge keeps one copy of a thread id that two environments share. Merging with each
    // delegating environment first keeps all of its threads, so its roll-ups survive.
    let mut keys = Vec::new();
    for target in targets {
        let Some(primary) = shells.iter().find(|(id, _)| *id == target).map(|(_, s)| *s) else {
            continue;
        };
        let mut environments = LinkedShells::default();
        for (id, shell) in shells.iter().filter(|(id, _)| *id != target) {
            environments.ensure(id, id);
            environments.restore(id, (*shell).clone());
        }
        let merged = environments.merged(target, target, primary);
        keys.extend(
            merged
                .shell
                .threads
                .iter()
                .chain(&merged.shell.archived_threads)
                .filter(|thread| !merged.origins.is_linked_thread(&thread.id))
                .filter(|thread| merged.shell.subagent_request(&thread.id).is_some())
                .map(|thread| FfiThreadKey {
                    environment_id: target.to_owned(),
                    thread_id: thread.id.clone(),
                }),
        );
    }
    keys
}

#[cfg(test)]
mod tests {
    use conn_contract::{OrchestrationV2ShellStreamItem, from_json};
    use serde_json::{Value, json};

    use super::*;

    fn thread(id: &str, edit: impl FnOnce(&mut Value)) -> Value {
        let mut value = json!({
            "createdBy": "user",
            "creationSource": "web",
            "id": id,
            "projectId": "p",
            "title": id,
            "providerInstanceId": "claudeAgent",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "branch": null,
            "worktreePath": null,
            "lineage": { "rootThreadId": id, "parentThreadId": null, "relationshipToParent": null },
            "forkedFrom": null,
            "activeProviderThreadId": null,
            "latestRunId": null,
            "activeRunId": null,
            "status": "idle",
            "pendingRuntimeRequest": null,
            "latestVisibleMessage": null,
            "latestUserMessageAt": null,
            "hasActionableProposedPlan": false,
            "itemCount": 0,
            "visibleItemCount": 0,
            "createdAt": "2026-11-13T09:00:00.000Z",
            "updatedAt": "2026-11-13T09:00:00.000Z",
            "archivedAt": null,
            "settledOverride": null,
            "settledAt": null,
            "deletedAt": null
        });
        edit(&mut value);
        value
    }

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
        let mut shell = ShellState::default();
        shell.apply(item);
        shell
    }

    fn task(id: &str, from: (&str, &str), approval: bool) -> Value {
        thread(id, |t| {
            t["delegatedFrom"] = json!({"environmentId": from.0, "threadId": from.1, "title": "P"});
            t["status"] = json!("running");
            if approval {
                t["pendingRuntimeRequest"] =
                    json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
            }
        })
    }

    fn key(environment_id: &str, thread_id: &str) -> FfiThreadKey {
        FfiThreadKey {
            environment_id: environment_id.into(),
            thread_id: thread_id.into(),
        }
    }

    #[test]
    fn a_task_on_another_machine_flags_the_thread_that_delegated_it() {
        let x = shell(vec![thread("parent", |_| {})]);
        let y = shell(vec![task("task", ("x", "parent"), true)]);
        // Each core alone sees nothing to flag on `parent`.
        assert_eq!(x.subagent_request("parent"), None);

        let flagged = rolled_up_attention(&[("x", &x), ("y", &y)]);
        assert!(flagged.contains(&key("x", "parent")), "{flagged:?}");
        // The order of the inbox's environments does not matter.
        let flagged = rolled_up_attention(&[("y", &y), ("x", &x)]);
        assert!(flagged.contains(&key("x", "parent")), "{flagged:?}");
    }

    #[test]
    fn a_subagent_of_a_delegated_task_flags_the_delegating_thread() {
        let x = shell(vec![thread("parent", |_| {})]);
        let y = shell(vec![
            task("task", ("x", "parent"), false),
            thread("sub", |t| {
                t["lineage"]["rootThreadId"] = json!("task");
                t["lineage"]["parentThreadId"] = json!("task");
                t["lineage"]["relationshipToParent"] = json!("subagent");
                t["status"] = json!("running");
                t["pendingRuntimeRequest"] =
                    json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
            }),
        ]);
        let flagged = rolled_up_attention(&[("x", &x), ("y", &y)]);
        assert!(flagged.contains(&key("x", "parent")), "{flagged:?}");
    }

    #[test]
    fn an_answered_or_misaddressed_task_flags_nothing() {
        let x = shell(vec![thread("parent", |_| {})]);
        let answered = shell(vec![task("task", ("x", "parent"), false)]);
        assert!(rolled_up_attention(&[("x", &x), ("y", &answered)]).is_empty());
        // Delegated from another machine's `parent`, not x's.
        let elsewhere = shell(vec![task("task", ("z", "parent"), true)]);
        let flagged = rolled_up_attention(&[("x", &x), ("y", &elsewhere)]);
        assert!(!flagged.contains(&key("x", "parent")), "{flagged:?}");
    }

    #[test]
    fn a_thread_id_two_environments_share_keeps_each_ones_roll_up() {
        // A and B both hold `t`; only B's copy delegated the task on C.
        let a = shell(vec![thread("t", |_| {})]);
        let b = shell(vec![thread("t", |_| {})]);
        let c = shell(vec![task("task", ("b", "t"), true)]);
        let flagged = rolled_up_attention(&[("a", &a), ("b", &b), ("c", &c)]);
        assert!(flagged.contains(&key("b", "t")), "{flagged:?}");
        assert!(!flagged.contains(&key("a", "t")), "{flagged:?}");
    }
}
