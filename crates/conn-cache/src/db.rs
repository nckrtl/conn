//! The device database: the server's rows for the kept threads, one line per thread with the
//! sequence its rows are current to, and the image cache. One connection per environment;
//! every read and write of an environment goes through its one task ([`crate::engine`]).

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Executor as _, Row as _, SqlitePool};

use crate::rows::{self, Row};

/// Bumped when the tables change; an older file is dropped and refetched (`open`).
const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS rows (
  env TEXT NOT NULL, thread TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  ord REAL, run TEXT, live INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  PRIMARY KEY (env, thread, kind, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rows_timeline ON rows(env, thread, ord) WHERE ord IS NOT NULL;
CREATE INDEX IF NOT EXISTS rows_by_run ON rows(env, thread, kind, run);
CREATE TABLE IF NOT EXISTS threads (
  env TEXT NOT NULL, thread TEXT NOT NULL,
  cursor INTEGER, older TEXT, record TEXT,
  opened_at INTEGER NOT NULL DEFAULT 0, active_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (env, thread)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS shells (
  env TEXT PRIMARY KEY, body BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attachment_images (
  position INTEGER PRIMARY KEY, environment TEXT NOT NULL, thread TEXT NOT NULL,
  version TEXT NOT NULL, bytes BLOB NOT NULL, UNIQUE(environment,thread,version));
";

/// Window bounds: whole turns, until 5 user turns or 40 rows, never past 75 rows or 1 MiB.
const MIN_ROWS: usize = 40;
const MIN_TURNS: usize = 5;
const MAX_ROWS: usize = 75;
const MAX_BYTES: usize = 1024 * 1024;

/// What the device holds for one thread.
#[derive(Clone, Debug, Default)]
pub struct ThreadIndex {
    /// The server sequence the stored rows are current to; `None` before the first window.
    pub cursor: Option<i64>,
    /// The server's cursor for rows older than the oldest stored one.
    pub older: Option<String>,
    pub record: Option<Value>,
    pub opened_at: i64,
    pub active_at: i64,
    /// The lowest timeline place stored: rows below it are not on the device, so an update
    /// of one is not written (it would sit above a gap).
    pub floor: Option<f64>,
}

/// A window of stored rows, oldest first.
#[derive(Debug, Default)]
pub struct Window {
    pub(crate) record: Value,
    pub(crate) timeline: Vec<Row>,
    pub(crate) control: Vec<Row>,
    /// The device holds older timeline rows than these.
    pub(crate) more_local: bool,
    pub(crate) older: Option<String>,
    pub(crate) cursor: Option<i64>,
}

/// One thread's pending write. Later changes of the same row replace earlier ones.
#[derive(Debug, Default)]
pub(crate) struct ThreadWrite {
    /// Drop the thread's rows first: a fresh window.
    pub reset: bool,
    /// Drop the thread from the device.
    pub forget: bool,
    pub rows: HashMap<(String, String), Option<Row>>,
    pub record: Option<Value>,
    pub record_fields: Option<Value>,
    /// The sequence these rows are current to, once committed.
    pub seq: Option<i64>,
    pub older: Option<Option<String>>,
    pub opened_at: Option<i64>,
}

impl ThreadWrite {
    pub(crate) fn put(&mut self, row: Row) {
        self.rows
            .insert((row.kind.clone(), row.id.clone()), Some(row));
    }

    /// Folds a later write of the same thread into this one.
    pub(crate) fn merge(&mut self, later: Self) {
        if later.reset || later.forget {
            *self = Self {
                opened_at: later.opened_at.or(self.opened_at),
                ..later
            };
            return;
        }
        self.rows.extend(later.rows);
        if later.record.is_some() {
            self.record = later.record;
            self.record_fields = None;
        }
        if let Some(fields) = later.record_fields {
            match &mut self.record {
                Some(record) => json_merge(record, fields),
                None => match &mut self.record_fields {
                    Some(earlier) => json_merge(earlier, fields),
                    None => self.record_fields = Some(fields),
                },
            }
        }
        self.seq = self.seq.max(later.seq);
        if later.older.is_some() {
            self.older = later.older;
        }
        if later.opened_at.is_some() {
            self.opened_at = later.opened_at;
        }
    }
}

fn json_merge(into: &mut Value, fields: Value) {
    if let (Value::Object(into), Value::Object(fields)) = (into, fields) {
        into.extend(fields);
    }
}

fn ms_of(record: &Value) -> i64 {
    record["updatedAt"]
        .as_str()
        .and_then(conn_state::parse_iso8601_epoch_ms)
        .unwrap_or(0)
}

/// Opens (or creates) the device database. A file from another schema version is emptied:
/// the first catch-up downloads the kept windows again.
/// The path [`open`] reads as "a database in memory".
pub(crate) const IN_MEMORY: &str = ":memory:";

pub(crate) async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    if path == Path::new(IN_MEMORY) {
        // One connection, so every query sees the same in-memory database.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .connect_with(SqliteConnectOptions::new().in_memory(true))
            .await?;
        pool.execute(SCHEMA).await?;
        return Ok(pool);
    }
    let mut file = std::fs::OpenOptions::new();
    file.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        file.mode(0o600);
    }
    file.open(path)?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .journal_mode(SqliteJournalMode::Wal)
                // A lost last batch is replayed by the next catch-up.
                .synchronous(SqliteSynchronous::Normal)
                .busy_timeout(std::time::Duration::from_secs(5)),
        )
        .await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await?;
    if version != SCHEMA_VERSION {
        pool.execute(
            "DROP TABLE IF EXISTS rows; DROP TABLE IF EXISTS threads;
             DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS thread_views;
             DROP TABLE IF EXISTS thread_task_links; DROP TABLE IF EXISTS thread_outlines;",
        )
        .await?;
    }
    pool.execute(SCHEMA).await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {SCHEMA_VERSION}"
    )))
    .execute(&pool)
    .await?;
    Ok(pool)
}

/// Opens an existing database of this schema to read, without creating or migrating it.
pub(crate) async fn open_existing(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false)
                .busy_timeout(std::time::Duration::from_secs(1)),
        )
        .await?;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await?;
    if version != SCHEMA_VERSION {
        pool.close().await;
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(pool)
}

pub(crate) async fn read_index(
    pool: &SqlitePool,
    env: &str,
) -> Result<HashMap<String, ThreadIndex>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT thread, cursor, older, record, opened_at, active_at,
           (SELECT MIN(ord) FROM rows r WHERE r.env = t.env AND r.thread = t.thread AND r.ord IS NOT NULL)
         FROM threads t WHERE env = ?",
    )
    .bind(env)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let record: Option<String> = row.get(3);
            (
                row.get(0),
                ThreadIndex {
                    cursor: row.get(1),
                    older: row.get(2),
                    record: record.and_then(|text| serde_json::from_str(&text).ok()),
                    opened_at: row.get(4),
                    active_at: row.get(5),
                    floor: row.get(6),
                },
            )
        })
        .collect())
}

/// Commits a batch in one transaction. Returns each thread's committed sequence.
pub(crate) async fn commit(
    pool: &SqlitePool,
    env: &str,
    batch: HashMap<String, ThreadWrite>,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut committed = vec![];
    for (thread, write) in batch {
        if write.forget || write.reset {
            sqlx::query("DELETE FROM rows WHERE env = ? AND thread = ?")
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
        }
        if write.forget {
            sqlx::query("DELETE FROM threads WHERE env = ? AND thread = ?")
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM attachment_images WHERE environment = ? AND thread = ?")
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
            continue;
        }
        let seq = write.seq.unwrap_or(0);
        for ((kind, id), row) in &write.rows {
            match row {
                Some(row) => {
                    sqlx::query(
                        "INSERT OR REPLACE INTO rows (env, thread, kind, id, ord, run, live, seq, body)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(env)
                    .bind(&thread)
                    .bind(kind)
                    .bind(id)
                    .bind(row.ord)
                    .bind(&row.run)
                    .bind(row.live)
                    .bind(seq)
                    .bind(row.body.to_string())
                    .execute(&mut *tx)
                    .await?;
                }
                None => {
                    sqlx::query(
                        "DELETE FROM rows WHERE env = ? AND thread = ? AND kind = ? AND id = ?",
                    )
                    .bind(env)
                    .bind(&thread)
                    .bind(kind)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
            }
        }
        sqlx::query("INSERT INTO threads (env, thread) VALUES (?, ?) ON CONFLICT DO NOTHING")
            .bind(env)
            .bind(&thread)
            .execute(&mut *tx)
            .await?;
        if let Some(record) = &write.record {
            sqlx::query("UPDATE threads SET record = ?, active_at = MAX(active_at, ?) WHERE env = ? AND thread = ?")
                .bind(record.to_string())
                .bind(ms_of(record))
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(fields) = &write.record_fields {
            sqlx::query("UPDATE threads SET record = json_patch(record, ?) WHERE env = ? AND thread = ? AND record IS NOT NULL")
                .bind(fields.to_string())
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(older) = &write.older {
            sqlx::query("UPDATE threads SET older = ? WHERE env = ? AND thread = ?")
                .bind(older)
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(at) = write.opened_at {
            sqlx::query("UPDATE threads SET opened_at = ? WHERE env = ? AND thread = ?")
                .bind(at)
                .bind(env)
                .bind(&thread)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(seq) = write.seq {
            // A fresh window sets the sequence; changes only move it forward.
            sqlx::query(
                "UPDATE threads SET cursor = CASE WHEN ? THEN ? ELSE MAX(COALESCE(cursor, 0), ?) END
                 WHERE env = ? AND thread = ?",
            )
            .bind(write.reset)
            .bind(seq)
            .bind(seq)
            .bind(env)
            .bind(&thread)
            .execute(&mut *tx)
            .await?;
            committed.push((thread, seq));
        }
    }
    tx.commit().await?;
    Ok(committed)
}

/// The newest window of a thread's stored rows older than `before` (all when `None`), and the
/// control rows it needs: runs, requests and sessions whole; the rest of its runs, or live.
pub(crate) async fn read_window(
    pool: &SqlitePool,
    env: &str,
    thread: &str,
    before: Option<f64>,
) -> Result<Option<Window>, sqlx::Error> {
    let head =
        sqlx::query("SELECT record, older, cursor FROM threads WHERE env = ? AND thread = ?")
            .bind(env)
            .bind(thread)
            .fetch_optional(pool)
            .await?;
    let Some(head) = head else {
        return Ok(None);
    };
    let record: Option<String> = head.get(0);
    let Some(record) = record.and_then(|text| serde_json::from_str::<Value>(&text).ok()) else {
        return Ok(None);
    };
    let newest = sqlx::query(
        "SELECT kind, id, ord, run, live, body FROM rows
         WHERE env = ? AND thread = ? AND ord IS NOT NULL AND ord < ?
         ORDER BY ord DESC LIMIT ?",
    )
    .bind(env)
    .bind(thread)
    .bind(before.unwrap_or(f64::MAX))
    .bind((MAX_ROWS + 1) as i64)
    .fetch_all(pool)
    .await?;
    let newest: Vec<(Row, usize)> = newest.iter().filter_map(stored_row).collect();
    let take = rows::window_len(&newest, MIN_ROWS, MIN_TURNS, MAX_ROWS, MAX_BYTES);
    let more_local = newest.len() > take;
    let mut timeline: Vec<Row> = newest.into_iter().take(take).map(|(row, _)| row).collect();
    timeline.reverse();

    let mut runs: Vec<String> = timeline.iter().filter_map(|row| row.run.clone()).collect();
    runs.sort();
    runs.dedup();
    let message_ids: Vec<&str> = timeline
        .iter()
        .filter_map(|row| row.body["messageId"].as_str())
        .collect();
    let cohort = serde_json::to_string(&runs).unwrap_or_default();
    let control = if before.is_none() {
        let attempts: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM rows WHERE env = ? AND thread = ? AND kind = 'attempts'
             AND run IN (SELECT value FROM json_each(?))",
        )
        .bind(env)
        .bind(thread)
        .bind(&cohort)
        .fetch_all(pool)
        .await?;
        let mut scope = runs.clone();
        scope.extend(attempts);
        let always = serde_json::to_string(&rows::ALWAYS).unwrap_or_default();
        sqlx::query(
            "SELECT kind, id, ord, run, live, body FROM rows
             WHERE env = ? AND thread = ? AND ord IS NULL AND (
               kind IN (SELECT value FROM json_each(?)) OR live = 1
               OR run IN (SELECT value FROM json_each(?))
               OR (kind = 'messages' AND id IN (SELECT value FROM json_each(?)))
               -- A queued run has no row yet: its prompt and files live in its message.
               OR (kind = 'messages' AND id IN (SELECT json_extract(body, '$.userMessageId')
                   FROM rows WHERE env = ? AND thread = ? AND kind = 'runs' AND live = 1)))",
        )
        .bind(env)
        .bind(thread)
        .bind(always)
        .bind(serde_json::to_string(&scope).unwrap_or_default())
        .bind(serde_json::to_string(&message_ids).unwrap_or_default())
        .bind(env)
        .bind(thread)
        .fetch_all(pool)
        .await?
    } else {
        // An older page needs only its subagent records, as a server history page.
        sqlx::query(
            "SELECT kind, id, ord, run, live, body FROM rows
             WHERE env = ? AND thread = ? AND kind = 'subagents' AND run IN (SELECT value FROM json_each(?))",
        )
        .bind(env)
        .bind(thread)
        .bind(&cohort)
        .fetch_all(pool)
        .await?
    };
    Ok(Some(Window {
        record,
        timeline,
        control: control
            .iter()
            .filter_map(stored_row)
            .map(|(row, _)| row)
            .collect(),
        more_local,
        older: head.get(1),
        cursor: head.get(2),
    }))
}

fn stored_row(row: &sqlx::sqlite::SqliteRow) -> Option<(Row, usize)> {
    let body: String = row.get(5);
    let size = body.len();
    Some((
        Row {
            kind: row.get(0),
            id: row.get(1),
            ord: row.get(2),
            run: row.get(3),
            live: row.get(4),
            body: serde_json::from_str(&body).ok()?,
        },
        size,
    ))
}

/// The thread list saved for `env`, as `LinkedShellSnapshot` JSON.
pub(crate) async fn read_shell(
    pool: &SqlitePool,
    env: &str,
) -> Result<Option<Vec<u8>>, sqlx::Error> {
    sqlx::query_scalar("SELECT body FROM shells WHERE env = ?")
        .bind(env)
        .fetch_optional(pool)
        .await
}

pub(crate) async fn write_shell(
    pool: &SqlitePool,
    env: &str,
    body: &[u8],
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT OR REPLACE INTO shells (env, body) VALUES (?, ?)")
        .bind(env)
        .bind(body)
        .execute(pool)
        .await
        .map(|_| ())
}

pub(crate) async fn image(
    pool: &SqlitePool,
    env: &str,
    thread: &str,
    version: &str,
) -> Result<Option<Vec<u8>>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT bytes FROM attachment_images WHERE environment=? AND thread=? AND version=?",
    )
    .bind(env)
    .bind(thread)
    .bind(version)
    .fetch_optional(pool)
    .await
}

pub(crate) async fn save_image(
    pool: &SqlitePool,
    env: &str,
    thread: &str,
    version: &str,
    bytes: &[u8],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT OR REPLACE INTO attachment_images(environment,thread,version,bytes) VALUES(?,?,?,?)")
        .bind(env).bind(thread).bind(version).bind(bytes).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM attachment_images WHERE position IN (SELECT position FROM (
        SELECT position, SUM(length(bytes)) OVER (ORDER BY position DESC) AS total FROM attachment_images
        ) WHERE total > 134217728)").execute(&mut *tx).await?;
    tx.commit().await
}

pub(crate) async fn forget_image(
    pool: &SqlitePool,
    env: &str,
    thread: &str,
    version: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM attachment_images WHERE environment=? AND thread=? AND version=?")
        .bind(env)
        .bind(thread)
        .bind(version)
        .execute(pool)
        .await?;
    Ok(())
}
