//! A successful Codex resume can still point at encrypted history the provider rejects.
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
    if provider["driver"] != "codex" {
        return Ok(false);
    }
    let (Some(provider_id), Some(native), Some(ordinal)) = (
        provider["id"].as_str(),
        provider["nativeThreadRef"]["nativeId"].as_str(),
        run["ordinal"].as_u64(),
    ) else {
        return Ok(false);
    };
    if !rejected_on(tx.sql(), thread, provider_id, native, ordinal)? {
        return Ok(false);
    }
    let shell = crate::shell::thread_shell(tx, thread)?;
    if shell["pendingBackgroundTasks"]
        .as_array()
        .is_some_and(|tasks| !tasks.is_empty())
    {
        return Err(
            "Stop the active background work before recovering the Codex conversation.".into(),
        );
    }
    Ok(true)
}

fn rejected_on(
    db: &Connection,
    thread: &str,
    provider: &str,
    native: &str,
    ordinal: u64,
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
        if code.as_deref() == Some("invalid_encrypted_content")
            || message.as_deref().is_some_and(rejected_message)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn rejected_message(message: &str) -> bool {
    if message == "invalid_encrypted_content" {
        return true;
    }
    serde_json::from_str::<Value>(message)
        .ok()
        .is_some_and(|v| {
            let error = v.get("error").unwrap_or(&v);
            error["code"] == "invalid_encrypted_content" || error == "invalid_encrypted_content"
        })
}
