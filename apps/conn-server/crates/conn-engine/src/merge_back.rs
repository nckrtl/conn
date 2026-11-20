//! `thread.merge_back`, as the T3 server merges a fork's work back into its parent
//! (`Orchestrator.ts` `dispatchThreadMergeBack` and the merge-back part of `dispatchMessage`).
//!
//! The command records a pending `merge_back` context transfer on the parent. The parent's
//! next message consumes it: the fork's delta becomes a `fork_delta_summary` context handoff
//! (`handoff::prepare_fork_delta`), the transfer is `consumed` with a `fork_delta_context`
//! resolution, and a "Merge-back context" item shows in the parent's timeline. The turn start
//! delivers the handoff to the provider (`runner.rs`, `handoff::plan_delivery`).

use conn_support::ids::join_id;
use serde_json::{Value, json};

use crate::commands::{CommandError, Outcome, is_active, reject};
use crate::fork::{run_for_source_point, source_point};
use crate::handoff;
use crate::store::{Draft, StoreResult, Tx};

/// The target's pending merge-backs (`pendingMergeBackTransfersForThread`).
pub(crate) fn pending(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Vec<Value>> {
    Ok(tx
        .entities(thread_id, "contextTransfers")?
        .into_iter()
        .filter(|t| {
            t["type"] == "merge_back"
                && t["targetThreadId"] == thread_id
                && t["status"] == "pending"
        })
        .collect())
}

/// `providerThreadForRun`.
fn provider_thread_for_run(
    tx: &Tx<'_>,
    thread_id: &str,
    run: &Value,
) -> StoreResult<Option<Value>> {
    match run["providerThreadId"].as_str() {
        Some(id) => tx.entity(thread_id, "providerThreads", id),
        None => Ok(None),
    }
}

/// The admission of `thread.merge_back` (`dispatchThreadMergeBack`).
pub(crate) fn thread_merge_back(tx: &mut Tx<'_>, command: Value) -> Outcome {
    let text = |key: &str| command[key].as_str().unwrap_or_default().to_owned();
    let (source_id, target_id, command_id) = (
        text("sourceThreadId"),
        text("targetThreadId"),
        text("commandId"),
    );
    let Some(source) = tx.thread(&source_id)? else {
        return reject(format!("Thread {source_id} does not exist."));
    };
    let Some(target) = tx.thread(&target_id)? else {
        return reject(format!("Thread {target_id} does not exist."));
    };
    if source["lineage"]["relationshipToParent"] != "fork"
        || source["lineage"]["parentThreadId"] != target_id.as_str()
    {
        return reject(format!("Thread {source_id} is not a fork of {target_id}."));
    }
    // Queued runs cannot consume merge-back context.
    if tx
        .entities(&target_id, "runs")?
        .iter()
        .any(|r| is_active(r) || r["status"] == "queued")
    {
        return reject(
            "Finish or stop the target thread's active work and clear its queue before merging back.",
        );
    }
    let transfers = tx.entities(&target_id, "contextTransfers")?;
    // Pending merge-backs into the target: from `source`, or from any other fork.
    let pending_for = |from_source: bool| -> Vec<Value> {
        transfers
            .iter()
            .filter(|t| {
                t["type"] == "merge_back"
                    && t["status"] == "pending"
                    && t["targetThreadId"] == target_id.as_str()
                    && (t["sourceThreadId"] == source_id.as_str()) == from_source
            })
            .cloned()
            .collect()
    };
    if !pending_for(false).is_empty() {
        return reject(format!(
            "Thread {target_id} already has pending context from another side chat or fork. Send a message there first."
        ));
    }
    let point = &command["sourcePoint"];
    let Some(run) = run_for_source_point(tx, &source_id, point)? else {
        return reject(format!(
            "No stable source run was found for merge-back source {}.",
            point["type"].as_str().unwrap_or_default()
        ));
    };
    let status = run["status"].as_str().unwrap_or_default();
    if !matches!(status, "completed" | "waiting") {
        return reject(format!(
            "Merge-back source run {} is {status}; only provider-finished runs are supported.",
            run["id"].as_str().unwrap_or_default()
        ));
    }
    let Some(fork_transfer) = tx
        .entities(&source_id, "contextTransfers")?
        .into_iter()
        .rfind(|t| {
            t["type"] == "fork"
                && t["sourceThreadId"] == target_id.as_str()
                && t["targetThreadId"] == source_id.as_str()
        })
    else {
        return reject(format!(
            "No fork transfer exists between {target_id} and {source_id}."
        ));
    };
    let has_provider_thread = provider_thread_for_run(tx, &source_id, &run)?.is_some();
    let now = match command["createdAt"].as_str() {
        Some(at) => at.to_owned(),
        None => tx.now().to_owned(),
    };
    let transfer_id = join_id(
        "context-transfer",
        &[
            "type",
            "merge_back",
            "source-thread",
            &source_id,
            "target-thread",
            &target_id,
            &conn_support::uuid_v4(),
        ],
    );
    let transfer = json!({
        "id": transfer_id,
        "type": "merge_back",
        "sourceThreadId": source_id,
        "targetThreadId": target_id,
        "sourcePoint": source_point(tx, &source_id, &run)?,
        "basePoint": fork_transfer["sourcePoint"],
        "sourceProviderInstanceId": run["providerInstanceId"],
        "targetProviderInstanceId": target["modelSelection"]["instanceId"],
        "targetRunId": null,
        "status": "pending",
        "resolution": null,
        "createdBy": command["createdBy"],
        "error": if has_provider_thread { Value::Null } else {
            json!("Source merge-back run has no provider thread.")
        },
        "createdAt": now,
        "updatedAt": now,
        "consumedAt": null,
    });
    let superseded = pending_for(true);
    for mut old in superseded {
        old["status"] = json!("superseded");
        old["error"] = json!(format!("Superseded by merge-back transfer {transfer_id}."));
        old["updatedAt"] = json!(now);
        tx.append(
            Draft::new(&target_id, "context-transfer.updated", old).command(Some(&command_id)),
        )?;
    }
    tx.append(
        Draft::new(&target_id, "context-transfer.created", transfer).command(Some(&command_id)),
    )?;
    Ok(vec![])
}

/// What a message that consumes a merge-back adds to its run.
pub(crate) struct Consumption {
    pub(crate) handoff: Value,
    /// Updates to the pending transfers: the consumed one, and any it supersedes.
    pub(crate) transfers: Vec<Value>,
    pub(crate) turn_item: Value,
}

/// Where the message's run goes.
pub(crate) struct RunPlace<'a> {
    pub(crate) thread_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) root_node_id: &'a str,
    pub(crate) ordinal: u64,
    pub(crate) provider_thread_id: &'a Value,
    pub(crate) model_selection: &'a Value,
    pub(crate) queued: bool,
    pub(crate) fresh: bool,
    pub(crate) now: &'a str,
}

/// The merge-back part of `dispatchMessage`: the refusals, then the handoff and the updates
/// the run carries. `None` when nothing is pending.
pub(crate) fn consume(
    tx: &Tx<'_>,
    place: &RunPlace<'_>,
) -> Result<Option<Consumption>, CommandError> {
    let pending = pending(tx, place.thread_id)?;
    if pending.is_empty() {
        return Ok(None);
    }
    if place.queued {
        return reject(format!(
            "Thread {} has a pending merge-back transfer; queued merge-back consumption is not implemented yet.",
            place.thread_id
        ));
    }
    let mut sources: Vec<&Value> = Vec::new();
    for transfer in &pending {
        if !sources.contains(&&transfer["sourceThreadId"]) {
            sources.push(&transfer["sourceThreadId"]);
        }
    }
    if sources.len() > 1 {
        return reject(format!(
            "Thread {} has pending merge-back transfers from multiple forks.",
            place.thread_id
        ));
    }
    if place.fresh {
        return reject("Send a message without /clear to apply the merged context first.");
    }
    // `latestContextTransfer`: the newest by `updatedAt`, the later one on a tie.
    let latest = pending
        .iter()
        .fold(None::<&Value>, |latest, t| match latest {
            Some(l) if t["updatedAt"].as_str() < l["updatedAt"].as_str() => Some(l),
            _ => Some(t),
        })
        .cloned()
        .unwrap_or(Value::Null);
    let transfer_id = latest["id"].as_str().unwrap_or_default().to_owned();
    let source_id = latest["sourceThreadId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let source_runs = tx.entities(&source_id, "runs")?;
    let Some(source_run) = source_runs
        .iter()
        .find(|r| r["id"] == latest["sourcePoint"]["runId"])
        .cloned()
    else {
        return reject(format!(
            "Pending merge-back transfer {transfer_id} has no resolvable source run."
        ));
    };
    let Some(source_provider_thread) = provider_thread_for_run(tx, &source_id, &source_run)? else {
        return reject(format!(
            "Pending merge-back transfer {transfer_id} has no resolvable source provider thread."
        ));
    };
    // This server names the run's provider thread when the run starts; a parent that never
    // ran has none to address the handoff to.
    if !place.provider_thread_id.is_string() {
        return reject(
            "Conn Server can merge back only into a thread whose provider conversation has started.",
        );
    }
    // The fork's own visible items through the source run, in timeline order.
    let ordinal = source_run["ordinal"].as_u64().unwrap_or(0);
    let run_ids: Vec<&Value> = source_runs
        .iter()
        .filter(|r| r["ordinal"].as_u64().unwrap_or(0) <= ordinal)
        .map(|r| &r["id"])
        .collect();
    let mut items: Vec<Value> = tx
        .entities(&source_id, "turnItems")?
        .into_iter()
        .filter(|item| run_ids.contains(&&item["runId"]))
        .collect();
    items.sort_by(|a, b| {
        (a["ordinal"].as_u64(), a["id"].as_str()).cmp(&(b["ordinal"].as_u64(), b["id"].as_str()))
    });
    let attempts = tx.entities(&source_id, "attempts")?;
    let visible: Vec<Value> = crate::visibility::visible_items(&source_runs, &attempts, &items)
        .into_iter()
        .filter_map(|at| items.get(at).cloned())
        .collect();
    let from_instance = source_run["providerInstanceId"]
        .as_str()
        .unwrap_or_default();
    let to_instance = place.model_selection["instanceId"]
        .as_str()
        .unwrap_or_default();
    let handoff_id = join_id(
        "context-handoff",
        &[
            "thread",
            place.thread_id,
            "from-provider-instance",
            from_instance,
            "to-provider-instance",
            to_instance,
            &conn_support::uuid_v4(),
        ],
    );
    let transfer_value = json!(transfer_id);
    let handoff = handoff::prepare_fork_delta(&handoff::ForkDelta {
        id: handoff_id.clone(),
        source_thread_id: &source_id,
        target_thread_id: place.thread_id,
        target_run_id: place.run_id,
        transfer_id: &transfer_value,
        from_provider_thread_ids: vec![source_provider_thread["id"].clone()],
        to_provider_thread_id: place.provider_thread_id.clone(),
        covered: handoff::delta_run_ordinals(&source_runs, &visible),
        items: &visible,
        token_cap: handoff::token_cap(
            std::env::var("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")
                .ok()
                .as_deref(),
        ),
        now: place.now,
    });
    let mut transfers = Vec::new();
    for mut other in pending
        .iter()
        .filter(|t| t["id"] != transfer_value)
        .cloned()
    {
        other["status"] = json!("superseded");
        other["error"] = json!(format!("Superseded by merge-back transfer {transfer_id}."));
        other["updatedAt"] = json!(place.now);
        transfers.push(other);
    }
    let mut consumed = latest;
    consumed["targetProviderInstanceId"] = json!(to_instance);
    consumed["targetRunId"] = json!(place.run_id);
    consumed["status"] = json!("consumed");
    consumed["resolution"] =
        json!({"strategy": "fork_delta_context", "contextHandoffId": handoff_id});
    consumed["error"] = Value::Null;
    consumed["updatedAt"] = json!(place.now);
    consumed["consumedAt"] = json!(place.now);
    transfers.push(consumed);
    let turn_item = json!({
        "id": join_id("turn-item", &["run", place.run_id, "signal", &format!("context-handoff:{handoff_id}")]),
        "threadId": place.thread_id,
        "runId": place.run_id,
        "nodeId": place.root_node_id,
        "providerThreadId": place.provider_thread_id,
        "providerTurnId": null,
        "nativeItemRef": null,
        "parentItemId": null,
        // Just ahead of the run's user message (`ordinal * 1_000_000 + 1` here).
        "ordinal": place.ordinal * 1_000_000,
        "status": "completed",
        "title": "Merge-back context",
        "startedAt": place.now,
        "completedAt": place.now,
        "updatedAt": place.now,
        "type": "handoff",
        "contextHandoffId": handoff_id,
        "fromProviderThreadIds": handoff["fromProviderThreadIds"],
        "toProviderThreadId": handoff["toProviderThreadId"],
        "fromProviderInstanceIds": [from_instance],
        "toProviderInstanceId": to_instance,
        "fromModelSelections": [source_run["modelSelection"]],
        "toModel": place.model_selection["model"],
        "strategy": "fork_delta_summary",
        "summary": handoff["summaryText"],
    });
    Ok(Some(Consumption {
        handoff,
        transfers,
        turn_item,
    }))
}

/// Appends what the run carries, in T3's order: the handoff, then the transfers.
pub(crate) fn append_records(
    tx: &mut Tx<'_>,
    consumption: &Consumption,
    run_id: &str,
    command_id: Option<&str>,
    thread_id: &str,
) -> StoreResult<()> {
    tx.append(
        Draft::new(
            thread_id,
            "context-handoff.updated",
            consumption.handoff.clone(),
        )
        .run(Some(run_id))
        .command(command_id),
    )?;
    for transfer in &consumption.transfers {
        tx.append(
            Draft::new(thread_id, "context-transfer.updated", transfer.clone())
                .run(Some(run_id))
                .command(command_id),
        )?;
    }
    Ok(())
}
