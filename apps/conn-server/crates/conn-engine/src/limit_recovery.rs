//! Resume a limited account once its reported window resets. Stable command IDs and
//! guarded writes make the worker safe to restart at either side of the deadline.
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

use crate::engine::Inner;

fn millis(row: &Value, field: &str) -> Option<i64> {
    crate::time::millis_from_iso(row[field].as_str()?)
}

pub(crate) fn command(row: &Value, now: i64, auto: bool, snooze: bool) -> Option<Value> {
    if row["status"] != "failed"
        || row["lastErrorClass"] != "usage_limit"
        || row["settledOverride"] == "settled"
        || !row["archivedAt"].is_null()
        || !row["deletedAt"].is_null()
        || !row["pendingRuntimeRequest"].is_null()
    {
        return None;
    }
    let (id, run) = (row["id"].as_str()?, row["latestRunId"].as_str()?);
    let reset = millis(row, "usageLimitResetAt")?;
    if reset <= millis(row, "latestRunCompletedAt").or_else(|| millis(row, "updatedAt"))? {
        return None;
    }
    let recovery = &row["limitRecovery"];
    let identity = format!("{id}:{run}:{reset}");
    if recovery["runId"] != run || recovery["resetAt"] != row["usageLimitResetAt"] {
        if now.saturating_sub(reset) > 86_400_000 || (!auto && (!snooze || reset <= now)) {
            return None;
        }
        return Some(
            json!({"type":"thread.metadata.update","commandId":format!("limit-arm:{identity}"),"threadId":id,"connAutomaticLimitArm":true,
            "limitRecovery":{"runId":run,"resetAt":row["usageLimitResetAt"],"autoResume":auto,"snooze":snooze && reset>now}}),
        );
    }
    if recovery["autoResume"] != true
        || reset > now
        || millis(row, "snoozedUntil").is_some_and(|t| t > now)
    {
        return None;
    }
    let delivery = format!(
        "limit-resume:{identity}:{}",
        recovery["requestId"].as_str().unwrap_or("legacy")
    );
    let mut message = json!({"type":"message.dispatch","commandId":delivery,"messageId":delivery,"threadId":id,"usageLimitContinuationOfRunId":run,
        "text":"Continue where you left off.","attachments":[],"dispatchMode":{"type":"start_immediately"},"createdBy":"agent","creationSource":"server"});
    if let Some(request) = recovery.get("requestId") {
        message["usageLimitRecoveryRequestId"] = request.clone();
    }
    Some(message)
}

/// Record an explicit Stop or settlement even if the sweep has not armed this failure yet.
pub(crate) fn disarmed(
    tx: &crate::store::Tx<'_>,
    thread: &Value,
    request: &Value,
    settle: bool,
) -> crate::store::StoreResult<Option<Value>> {
    let id = thread["id"].as_str().unwrap_or_default();
    let previous = &thread["limitRecovery"];
    let mut next = previous.clone();
    let latest = crate::commands::latest_executed_run(tx, id)?;
    if let Some(ref run) = latest
        && let Some(failure) = crate::shell::latest_root_failure(tx, id, Some(run))?
        && failure["class"] == "usage_limit"
        && millis(&failure, "resetAt").is_some()
        && (previous["runId"] != run["id"] || previous["resetAt"] != failure["resetAt"])
    {
        next = json!({"runId":run["id"],"resetAt":failure["resetAt"],"autoResume":false,"snooze":false});
    }
    if !next.is_object()
        || (&next == previous && next["autoResume"] != true && (!settle || next["snooze"] != true))
    {
        return Ok(None);
    }
    next["autoResume"] = false.into();
    if settle {
        next["snooze"] = false.into();
    }
    next["requestId"] = request.clone();
    Ok(Some(next))
}

pub(crate) fn start(inner: &Arc<Inner>, wake: Arc<tokio::sync::Notify>) {
    if inner.host.is_none() || tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let weak = Arc::downgrade(inner);
    tokio::spawn(async move {
        loop {
            let Some(inner) = weak.upgrade() else { return };
            let mut preferences = None;
            let now = i64::try_from(inner.clock.now_millis()).unwrap_or(i64::MAX);
            let mut delay = Duration::from_secs(60);
            let mut cursor = String::new();
            loop {
                let page = inner
                    .db(move |store| store.limit_recovery_page(&cursor))
                    .await;
                let Ok(page) = page else { break };
                let Some(last) = page.last().and_then(|r| r["id"].as_str()) else {
                    break;
                };
                cursor = last.to_owned();
                let (auto, snooze) = *preferences.get_or_insert_with(|| {
                    inner
                        .host
                        .as_ref()
                        .map_or((false, false), |h| h.usage_limit_preferences())
                });
                for row in &page {
                    if let Some(cmd) = command(row, now, auto, snooze) {
                        let _ = inner.dispatch_value(cmd).await;
                    }
                    let due = millis(row, "usageLimitResetAt").max(millis(row, "snoozedUntil"));
                    if let Some(at) = due.filter(|t| *t > now) {
                        delay = delay.min(Duration::from_millis(at.abs_diff(now)));
                    }
                }
                if page.len() < 32 {
                    break;
                }
            }
            drop(inner);
            tokio::select! {
                ()=tokio::time::sleep(delay)=>{},
                ()=wake.notified()=>{}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_known_future_window_arms_then_resumes_once() {
        let mut row = json!({"id":"t","latestRunId":"r","status":"failed","lastErrorClass":"usage_limit","latestRunCompletedAt":"2025-01-01T00:00:00Z","usageLimitResetAt":"2025-01-01T01:00:00Z"});
        let reset = millis(&row, "usageLimitResetAt").unwrap();
        assert!(command(&row, reset - 1, false, false).is_none());
        let arm = command(&row, reset - 1, true, false).unwrap();
        row["limitRecovery"] = arm["limitRecovery"].clone();
        row["limitRecovery"]["requestId"] = arm["commandId"].clone();
        assert!(command(&row, reset - 1, true, false).is_none());
        let resume = command(&row, reset, true, false).unwrap();
        assert_eq!(resume["usageLimitContinuationOfRunId"], "r");
        assert_eq!(command(&row, reset + 500, true, false), Some(resume));
        row["latestRunCompletedAt"] = row["usageLimitResetAt"].clone();
        assert!(command(&row, reset + 500, true, false).is_none());
    }
}
