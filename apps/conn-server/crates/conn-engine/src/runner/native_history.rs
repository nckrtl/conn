//! A successful native resume can still point at saved content the provider cannot replay.
//! Only the last accepted attempt on this native thread can trigger a fresh conversation.
use crate::store::{StoreResult, Tx};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

pub(super) fn rejected(
    tx: &Tx<'_>,
    thread: &str,
    run: &Value,
    provider: &Value,
) -> StoreResult<bool> {
    let (code, name) = match provider["driver"].as_str() {
        Some("codex") => ("invalid_encrypted_content", "Codex"),
        Some("antigravity") => ("INVALID_THINKING_SIGNATURE", "Antigravity"),
        _ => return Ok(false),
    };
    let (Some(provider_id), Some(native), Some(ordinal)) = (
        provider["id"].as_str(),
        provider["nativeThreadRef"]["nativeId"].as_str(),
        run["ordinal"].as_u64(),
    ) else {
        return Ok(false);
    };
    if !rejected_on(tx.sql(), thread, provider_id, native, ordinal, code)? {
        return Ok(false);
    }
    if crate::shell::has_native_background_work(tx, thread, provider)? {
        return Err(format!(
            "Stop the active background work before recovering the {name} conversation."
        ));
    }
    Ok(true)
}

fn rejected_on(
    db: &Connection,
    thread: &str,
    provider: &str,
    native: &str,
    ordinal: u64,
    expected_code: &str,
) -> StoreResult<bool> {
    let previous = db.query_row(
        "SELECT json_extract(r.body,'$.id'), json_extract(r.body,'$.rootNodeId'),
                json_extract(r.body,'$.status'), json_extract(r.body,'$.ordinal'),
                json_extract(a.body,'$.nativeThreadId')
         FROM entities r
         JOIN entities a ON a.thread_id = r.thread_id AND a.kind = 'attempts'
                AND a.id = json_extract(r.body,'$.activeAttemptId')
         WHERE r.thread_id = ?1 AND r.kind = 'runs' AND json_extract(r.body,'$.providerThreadId') = ?2
           AND json_extract(r.body,'$.ordinal') < ?3
           AND EXISTS (SELECT 1 FROM entities t WHERE t.thread_id = r.thread_id AND t.kind = 'providerTurns'
                       AND json_extract(t.body,'$.runAttemptId') = a.id
                       AND json_extract(t.body,'$.promptDropped') IS NOT 1)
         ORDER BY json_extract(r.body,'$.ordinal') DESC LIMIT 1",
        params![thread,provider,ordinal], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,
            r.get::<_,String>(2)?,r.get::<_,u64>(3)?,r.get::<_,Option<String>>(4)?)),
    ).optional().map_err(|e|e.to_string())?;
    let Some((run, root, status, ordinal, accepted_native)) = previous else {
        return Ok(false);
    };
    if !matches!(status.as_str(), "failed" | "interrupted" | "cancelled")
        || accepted_native.as_deref().is_some_and(|id| id != native)
    {
        return Ok(false);
    }
    if accepted_native.is_none() {
        let covered = db.query_row("SELECT EXISTS(SELECT 1 FROM entities WHERE thread_id=?1 AND kind='contextHandoffs'
             AND json_extract(body,'$.toProviderThreadId')=?2 AND json_extract(body,'$.strategy')='full_thread_summary'
             AND json_extract(body,'$.delivery.nativeThreadId')=?3 AND json_extract(body,'$.coveredRunOrdinals.to')>=?4)",
             params![thread,provider,native,ordinal], |r| r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
        if covered {
            return Ok(false);
        }
    }
    let mut errors = db.prepare("SELECT json_extract(body,'$.failure.code'), json_extract(body,'$.failure.message')
        FROM entities WHERE thread_id=?1 AND kind='turnItems' AND json_extract(body,'$.type')='error'
          AND json_extract(body,'$.runId')=?2 AND json_extract(body,'$.nodeId')=?3").map_err(|e|e.to_string())?;
    let mut rows = errors
        .query(params![thread, run, root])
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let code: Option<String> = row.get(0).map_err(|e| e.to_string())?;
        let message: Option<String> = row.get(1).map_err(|e| e.to_string())?;
        if code.as_deref() == Some(expected_code)
            || (expected_code == "invalid_encrypted_content"
                && message.as_deref().is_some_and(rejected_message))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn rejected_message(message: &str) -> bool {
    fn code(value: &Value) -> bool {
        let error = value.get("error").unwrap_or(value);
        error["code"] == "invalid_encrypted_content" || error == "invalid_encrypted_content"
    }
    if message == "invalid_encrypted_content" {
        return true;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(message) else {
        return false;
    };
    let error = parsed.get("error").unwrap_or(&parsed);
    code(&parsed)
        || ["message", "additionalDetails"]
            .into_iter()
            .filter_map(|key| error[key].as_str())
            .any(|inner| {
                inner == "invalid_encrypted_content"
                    || serde_json::from_str::<Value>(inner)
                        .ok()
                        .is_some_and(|v| code(&v))
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_recover_when_the_latest_delivered_root_failed_on_the_current_native_thread() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE entities(thread_id TEXT, kind TEXT, id TEXT, body TEXT, PRIMARY KEY(thread_id,kind,id));").unwrap();
        let put = |kind: &str, id: &str, v: Value| {
            db.execute(
                "INSERT OR REPLACE INTO entities VALUES ('t',?1,?2,?3)",
                params![kind, id, v.to_string()],
            )
            .unwrap();
        };
        let rejected = |native: &str| {
            rejected_on(&db, "t", "pt", native, 5, "invalid_encrypted_content").unwrap()
        };
        put(
            "runs",
            "r1",
            json!({"id":"r1","rootNodeId":"root","status":"failed","ordinal":1,"providerThreadId":"pt","activeAttemptId":"a1"}),
        );
        put("attempts", "a1", json!({"nativeThreadId":"old"}));
        put("providerTurns", "p1", json!({"runAttemptId":"a1"}));
        let nested = json!({"error":{"message":json!({"error":{"code":"invalid_encrypted_content"}}).to_string()}}).to_string();
        let failure = |node: &str| json!({"type":"error","runId":"r1","nodeId":node,"failure":{"message":nested}});
        put("turnItems", "e1", failure("child"));
        assert!(
            !rejected("old"),
            "a subagent's history belongs to its own native thread"
        );
        put("turnItems", "e1", failure("root"));
        assert!(rejected("old"));
        assert!(
            !rejected("recovered"),
            "already loaded a fresh native identity"
        );
        put(
            "providerTurns",
            "p1",
            json!({"runAttemptId":"a1","promptDropped":true}),
        );
        assert!(
            !rejected("old"),
            "the native app never accepted this message"
        );
        put(
            "providerTurns",
            "p1",
            json!({"runAttemptId":"a1","promptDropped":false}),
        );
        // Legacy attempts omitted nativeThreadId. A delivered replacement handoff covers that run.
        put("attempts", "a1", json!({}));
        assert!(rejected("old"));
        put(
            "contextHandoffs",
            "h",
            json!({"strategy":"full_thread_summary","toProviderThreadId":"pt",
            "delivery":{"nativeThreadId":"recovered","status":"inline"},"coveredRunOrdinals":{"to":1}}),
        );
        assert!(!rejected("recovered"));
        put(
            "runs",
            "r2",
            json!({"id":"r2","rootNodeId":"root2","status":"completed","ordinal":2,"providerThreadId":"pt","activeAttemptId":"a2"}),
        );
        put("attempts", "a2", json!({"nativeThreadId":"old"}));
        put("providerTurns", "p2", json!({"runAttemptId":"a2"}));
        assert!(
            !rejected("old"),
            "a later accepted and successful run supersedes the failure"
        );
    }
}
