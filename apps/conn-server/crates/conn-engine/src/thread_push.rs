//! The outbox of threads the Orbit Gateway should hear of. When a host thread starts its first
//! run, or its title changes after that, the commit that changed its shell row writes one row
//! to `thread_push_outbox`, in the same transaction. The server's sender drains the table to
//! the Gateway (`conn:thread:record`) and retries until the Gateway answers. Off unless
//! [`crate::EngineConfig::thread_push`] is set: with it off, nothing is written.
//!
//! - One row per thread. A newer title replaces the row and resets its retries, so the
//!   Gateway ends with the latest title. The Gateway takes a repeat call as an update.
//! - Only listed top-level threads: not a subagent, a delegated task or a side chat; not
//!   archived (the rule attention events use). A thread with no title is not sent.
//! - A thread that has not run yet is not sent; its first run sends its title then.
//!
//! The title is the only thread content that leaves the server.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::store::StoreResult;

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS thread_push_outbox (
  thread_id       TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  next_attempt_ms INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_push_outbox_due ON thread_push_outbox(next_attempt_ms);
";

/// A thread the Gateway has not yet taken, with the title to send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadPushRow {
    pub thread_id: String,
    pub title: String,
    /// Failed sends so far.
    pub attempts: u32,
}

fn err(e: rusqlite::Error) -> String {
    format!("store: {e}")
}

fn shell_title(shell: &Value) -> Option<&str> {
    let title = shell["title"].as_str()?.trim();
    (!title.is_empty()).then_some(title)
}

fn has_run(shell: &Value) -> bool {
    shell["latestRunId"].as_str().is_some()
}

/// Writes the row one shell change calls for, inside the commit's transaction. `previous` is
/// the thread's stored shell row before this write, `next` the new one. True when it wrote.
pub(crate) fn record(
    conn: &Connection,
    thread_id: &str,
    previous: Option<&Value>,
    next: &Value,
    now_ms: u64,
) -> StoreResult<bool> {
    if !crate::attention::eligible(next) || !has_run(next) {
        return Ok(false);
    }
    let Some(title) = shell_title(next) else {
        return Ok(false);
    };
    let first_run = !previous.is_some_and(has_run);
    let renamed = previous.and_then(shell_title) != Some(title);
    if !first_run && !renamed {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO thread_push_outbox (thread_id, title, next_attempt_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT(thread_id) DO UPDATE SET
           title = excluded.title, next_attempt_ms = excluded.next_attempt_ms, attempts = 0",
        params![thread_id, title, now_ms as i64],
    )
    .map_err(err)?;
    Ok(true)
}

/// Up to `limit` rows due at `now_ms`, oldest due first.
pub(crate) fn due(conn: &Connection, now_ms: u64, limit: usize) -> StoreResult<Vec<ThreadPushRow>> {
    let mut statement = conn
        .prepare(
            "SELECT thread_id, title, attempts FROM thread_push_outbox
             WHERE next_attempt_ms <= ?1 ORDER BY next_attempt_ms, thread_id LIMIT ?2",
        )
        .map_err(err)?;
    statement
        .query_map(
            params![now_ms as i64, i64::try_from(limit).unwrap_or(i64::MAX)],
            |row| {
                Ok(ThreadPushRow {
                    thread_id: row.get(0)?,
                    title: row.get(1)?,
                    attempts: u32::try_from(row.get::<_, i64>(2)?).unwrap_or(u32::MAX),
                })
            },
        )
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)
}

/// When the next row is due, if one waits.
pub(crate) fn next_due(conn: &Connection) -> StoreResult<Option<u64>> {
    conn.query_row(
        "SELECT MIN(next_attempt_ms) FROM thread_push_outbox",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|at| at.flatten().map(|at| u64::try_from(at.max(0)).unwrap_or(0)))
    .map_err(err)
}

/// Removes the row, unless a newer title replaced it while the call was out.
pub(crate) fn delivered(conn: &Connection, thread_id: &str, title: &str) -> StoreResult<()> {
    conn.execute(
        "DELETE FROM thread_push_outbox WHERE thread_id = ?1 AND title = ?2",
        params![thread_id, title],
    )
    .map(drop)
    .map_err(err)
}

/// Holds the row until `at_ms`, after `attempts` failed sends, unless a newer title replaced it.
pub(crate) fn retry(
    conn: &Connection,
    thread_id: &str,
    title: &str,
    attempts: u32,
    at_ms: u64,
) -> StoreResult<()> {
    conn.execute(
        "UPDATE thread_push_outbox SET attempts = ?3, next_attempt_ms = ?4
         WHERE thread_id = ?1 AND title = ?2",
        params![thread_id, title, i64::from(attempts), at_ms as i64],
    )
    .map(drop)
    .map_err(err)
}

#[cfg(test)]
#[path = "thread_push_tests.rs"]
mod tests;
