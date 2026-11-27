//! Recent messages scoped to the environment and thread that owns them.
use std::path::Path;

use crate::{MESSAGE_CAP, Message};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Executor as _, SqlitePool};

#[derive(Clone, Debug)]
pub struct MessageCache(SqlitePool);

impl MessageCache {
    /// Opens the local cache and creates its tables on first use.
    ///
    /// # Errors
    /// Returns the underlying filesystem or database error.
    pub async fn open(path: &Path) -> Result<Self, sqlx::Error> {
        let mut file = std::fs::OpenOptions::new();
        file.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            file.mode(0o600);
        }
        file.open(path)?;
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await?;
        pool.execute(
            "CREATE TABLE IF NOT EXISTS messages (
            position INTEGER PRIMARY KEY, environment TEXT NOT NULL, thread TEXT NOT NULL,
            id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(environment,thread,id));
            CREATE INDEX IF NOT EXISTS recent_messages ON messages(environment,thread,position);
            CREATE TABLE IF NOT EXISTS thread_task_links (
                environment TEXT NOT NULL, thread TEXT NOT NULL, metadata TEXT NOT NULL,
                PRIMARY KEY(environment, thread)) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS thread_outlines (
                environment TEXT NOT NULL, thread TEXT NOT NULL, markers TEXT NOT NULL,
                PRIMARY KEY(environment, thread)) WITHOUT ROWID",
        )
        .await?;
        Ok(Self(pool))
    }

    /// Loads only the latest 100 serialized messages, in chat order.
    ///
    /// # Errors
    /// Returns the database read error.
    pub async fn recent(&self, env: &str, thread: &str) -> Result<Vec<String>, sqlx::Error> {
        let mut rows = sqlx::query_scalar(
            "SELECT body FROM messages WHERE environment = ? AND thread = ?
             ORDER BY position DESC LIMIT 100",
        )
        .bind(env)
        .bind(thread)
        .fetch_all(&self.0)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// The preceding 100 cached bodies, oldest first. The anchor is excluded.
    ///
    /// # Errors
    /// Returns the database read error.
    pub async fn before(
        &self,
        env: &str,
        thread: &str,
        before_id: &str,
    ) -> Result<Vec<String>, sqlx::Error> {
        let mut rows = sqlx::query_scalar(
            "SELECT body FROM messages WHERE environment=?1 AND thread=?2 AND position <
                (SELECT position FROM messages WHERE environment=?1 AND thread=?2 AND id=?3)
             ORDER BY position DESC LIMIT 100",
        )
        .bind(env)
        .bind(thread)
        .bind(before_id)
        .fetch_all(&self.0)
        .await?;
        rows.reverse();
        Ok(rows)
    }

    /// Atomically replaces an authoritative conversation, including a rollback to empty.
    /// A failed write leaves the previous committed conversation readable offline.
    ///
    /// # Errors
    /// Returns the underlying SQLite error.
    pub async fn replace(
        &self,
        env: &str,
        thread: &str,
        prefix: &[Message],
        tail: &[Message],
    ) -> Result<(), sqlx::Error> {
        let rows: Vec<_> = prefix.iter().chain(tail).map(|m| (m.id(), m)).collect();
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("DELETE FROM messages WHERE environment=? AND thread=?")
            .bind(env)
            .bind(thread)
            .execute(&mut *tx)
            .await?;
        if rows.is_empty() {
            sqlx::query("DELETE FROM thread_outlines WHERE environment=? AND thread=?")
                .bind(env)
                .bind(thread)
                .execute(&mut *tx)
                .await?;
        } else {
            Self::write_tail(&mut tx, env, thread, &rows).await?;
        }
        tx.commit().await
    }

    /// Reconciles the historical prefix preceding a live snapshot. Returned server pages
    /// own the prefix. Live rows at and after the anchor win any overlap. A removed anchor
    /// means a concurrent eviction or settlement already invalidated this read.
    ///
    /// # Errors
    /// Returns the database error. Prefix replacement and the cap commit together.
    pub async fn merge_prefix(
        &self,
        env: &str,
        thread: &str,
        anchor: &str,
        prefix: &[Message],
        tail: &[Message],
    ) -> Result<bool, sqlx::Error> {
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        if !tail.is_empty() {
            let rows: Vec<_> = tail.iter().map(|m| (m.id(), m)).collect();
            Self::write_tail(&mut tx, env, thread, &rows).await?;
        }
        let position: Option<i64> = sqlx::query_scalar(
            "SELECT position FROM messages WHERE environment=? AND thread=? AND id=?",
        )
        .bind(env)
        .bind(thread)
        .bind(anchor)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(position) = position else {
            // A newer live tail may already have pushed the anchor past the cap.
            tx.commit().await?;
            return Ok(false);
        };
        sqlx::query("DELETE FROM messages WHERE environment=? AND thread=? AND position < ?")
            .bind(env)
            .bind(thread)
            .bind(position)
            .execute(&mut *tx)
            .await?;
        let prefix = &prefix[prefix.len().saturating_sub(MESSAGE_CAP)..];
        let rows: Vec<_> = prefix.iter().map(|m| (m.id(), m)).collect();
        sqlx::query(
            "WITH floor AS MATERIALIZED (SELECT min(0,coalesce(min(position),0)) AS n FROM messages)
             INSERT INTO messages(position,environment,thread,id,body)
             SELECT n - json_array_length(?3) + key, ?1, ?2, value ->> 0, value -> 1 FROM floor, json_each(?3)
             WHERE true ON CONFLICT(environment,thread,id) DO NOTHING",
        ).bind(env).bind(thread).bind(sqlx::types::Json(&rows))
            .execute(&mut *tx).await?;
        Self::trim(&mut tx, env, thread).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// A bounded chronological window containing the requested prompt, or no rows on a miss.
    ///
    /// # Errors
    /// Returns the database read error.
    pub async fn around(
        &self,
        env: &str,
        thread: &str,
        id: &str,
    ) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar(
            "WITH anchor AS (SELECT position FROM messages WHERE environment=?1 AND thread=?2 AND id=?3),
             before AS (SELECT position,body FROM messages WHERE environment=?1 AND thread=?2
                AND position<(SELECT position FROM anchor) ORDER BY position DESC LIMIT 20),
             after AS (SELECT position,body FROM messages WHERE environment=?1 AND thread=?2
                AND position>=(SELECT position FROM anchor) ORDER BY position LIMIT 80)
             SELECT body FROM (SELECT * FROM before UNION ALL SELECT * FROM after) ORDER BY position"
        ).bind(env).bind(thread).bind(id).fetch_all(&self.0).await
    }

    /// # Errors
    /// Returns the database read error.
    pub async fn outline(&self, env: &str, thread: &str) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar("SELECT markers FROM thread_outlines WHERE environment=? AND thread=?")
            .bind(env)
            .bind(thread)
            .fetch_optional(&self.0)
            .await
    }

    /// Replaces the whole marker list independently of the body retention window.
    ///
    /// # Errors
    /// Returns the database write error.
    pub async fn save_outline(
        &self,
        env: &str,
        thread: &str,
        markers: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT OR REPLACE INTO thread_outlines(environment,thread,markers) VALUES(?,?,?)",
        )
        .bind(env)
        .bind(thread)
        .bind(markers)
        .execute(&self.0)
        .await?;
        Ok(())
    }

    /// # Errors
    /// Returns the database read or decoding error.
    pub async fn task_links(
        &self,
        env: &str,
        thread: &str,
    ) -> Result<conn_state::ThreadTaskLinks, sqlx::Error> {
        let row: Option<sqlx::types::Json<conn_state::ThreadTaskLinks>> = sqlx::query_scalar(
            "SELECT metadata FROM thread_task_links WHERE environment=? AND thread=?",
        )
        .bind(env)
        .bind(thread)
        .fetch_optional(&self.0)
        .await?;
        Ok(row.map(|row| row.0).unwrap_or_default())
    }

    /// # Errors
    /// Returns the database write error.
    pub async fn save_task_links(
        &self,
        env: &str,
        thread: &str,
        links: &conn_state::ThreadTaskLinks,
    ) -> Result<(), sqlx::Error> {
        if *links == conn_state::ThreadTaskLinks::default() {
            sqlx::query("DELETE FROM thread_task_links WHERE environment=? AND thread=?")
                .bind(env)
                .bind(thread)
                .execute(&self.0)
                .await?;
        } else {
            sqlx::query(
                "INSERT INTO thread_task_links(environment,thread,metadata) VALUES(?,?,?)
                ON CONFLICT(environment,thread) DO UPDATE SET metadata=excluded.metadata
                WHERE metadata != excluded.metadata",
            )
            .bind(env)
            .bind(thread)
            .bind(sqlx::types::Json(links))
            .execute(&self.0)
            .await?;
        }
        Ok(())
    }

    /// Applies a chronological tail from the live reducer, keeping older rows up to the cap.
    /// Every row of `messages` is written again and moves to the end, in the given order.
    ///
    /// Returns the number of rows written.
    ///
    /// # Errors
    /// Returns the database write error. The merge and eviction commit together.
    pub async fn merge<T: serde::Serialize + Sync>(
        &self,
        env: &str,
        thread: &str,
        messages: &[(&str, &T)],
    ) -> Result<u64, sqlx::Error> {
        if messages.is_empty() {
            return Ok(0);
        }
        let mut tx = self.0.begin().await?;
        let written = Self::write_tail(&mut tx, env, thread, messages).await?;
        tx.commit().await?;
        Ok(written)
    }

    /// Writes only the rows of a tail that changed since it was last merged or upserted.
    ///
    /// A row already stored keeps its place and changes its body; a new row goes after every
    /// stored one, in the given order. A caller that merged the tail before, and sees its rows
    /// in the same order with new ones only at the end, gets the stored order [`Self::merge`]
    /// would have made of the whole tail.
    ///
    /// Returns the number of rows inserted or changed.
    ///
    /// # Errors
    /// Returns the database write error. The write and eviction commit together.
    pub async fn upsert<T: serde::Serialize + Sync>(
        &self,
        env: &str,
        thread: &str,
        messages: &[(&str, &T)],
    ) -> Result<u64, sqlx::Error> {
        if messages.is_empty() {
            return Ok(0);
        }
        let mut tx = self.0.begin().await?;
        let written = sqlx::query(
            "INSERT INTO messages(environment,thread,id,body)
             SELECT ?,?,value ->> 0,value -> 1 FROM json_each(?) WHERE true ORDER BY key
             ON CONFLICT(environment,thread,id) DO UPDATE SET body=excluded.body
             WHERE body != excluded.body",
        )
        .bind(env)
        .bind(thread)
        .bind(sqlx::types::Json(messages))
        .execute(&mut *tx)
        .await?
        .rows_affected();
        Self::trim(&mut tx, env, thread).await?;
        tx.commit().await?;
        Ok(written)
    }

    async fn write_tail<T: serde::Serialize + Sync>(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        env: &str,
        thread: &str,
        messages: &[(&str, &T)],
    ) -> Result<u64, sqlx::Error> {
        // Assign the incoming tail consecutive rowids. IDs absent from a bounded snapshot
        // can still be valid older history, so only the cap evicts them.
        let written = sqlx::query(
            "INSERT OR REPLACE INTO messages(environment,thread,id,body)
            SELECT ?,?,value ->> 0,value -> 1 FROM json_each(?) ORDER BY key",
        )
        .bind(env)
        .bind(thread)
        .bind(sqlx::types::Json(messages))
        .execute(&mut **tx)
        .await?
        .rows_affected();
        Self::trim(tx, env, thread).await?;
        Ok(written)
    }

    async fn trim(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        env: &str,
        thread: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM messages WHERE position IN (
                SELECT position FROM messages WHERE environment = ? AND thread = ?
                ORDER BY position DESC LIMIT -1 OFFSET 1000)",
        )
        .bind(env)
        .bind(thread)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    /// Imports this thread's former JSON preview once. A concurrent importer or live writer
    /// that already populated the database owns the newer copy.
    ///
    /// # Errors
    /// Returns an error for an invalid legacy array or a failed insert.
    pub async fn import_legacy(
        &self,
        env: &str,
        thread: &str,
        array: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO messages(environment, thread, id, body)
             SELECT ?, ?, coalesce(json_extract(value, '$.User.id'),
                                   json_extract(value, '$.Assistant.id')), value
             FROM json_each(?) WHERE NOT EXISTS (
                 SELECT 1 FROM messages WHERE environment = ? AND thread = ?
             ) ORDER BY key",
        )
        .bind(env)
        .bind(thread)
        .bind(array)
        .bind(env)
        .bind(thread)
        .execute(&self.0)
        .await?;
        Ok(())
    }

    /// Deletes the stored transcript of a settled or deleted thread.
    ///
    /// # Errors
    /// Returns the database write error.
    pub async fn remove(&self, env: &str, thread: &str) -> Result<(), sqlx::Error> {
        let mut tx = self.0.begin().await?;
        sqlx::query("DELETE FROM thread_task_links WHERE environment=? AND thread=?")
            .bind(env)
            .bind(thread)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM thread_outlines WHERE environment=? AND thread=?")
            .bind(env)
            .bind(thread)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM messages WHERE environment=? AND thread=?")
            .bind(env)
            .bind(thread)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "check the committed history after each replacement"
    )]
    async fn backfill_replaces_only_the_prefix_and_pages_the_committed_rows()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let db = MessageCache::open(&dir.path().join("messages.sqlite3")).await?;
        let message = |n: usize, text: &str| Message::Assistant {
            id: n.to_string(),
            markdown: text.to_owned(),
            created_at: None,
            run_id: None,
        };
        let first = message(1000, "live");
        let newest = message(1001, "live");
        let obsolete = message(2000, "rolled back");
        db.merge(
            "e",
            "t",
            &[
                (obsolete.id(), &obsolete),
                (first.id(), &first),
                (newest.id(), &newest),
            ],
        )
        .await?;
        let prefix: Vec<_> = (0..=1000).map(|i| message(i, "history")).collect();
        assert!(
            !db.merge_prefix("e", "other", first.id(), &prefix, &[])
                .await?
        );
        assert!(db.merge_prefix("e", "t", first.id(), &prefix, &[]).await?);
        let page = db.before("e", "t", first.id()).await?;
        let ids: Vec<_> = page
            .iter()
            .map(|row| serde_json::from_str::<Message>(row).map(|m| m.id().to_owned()))
            .collect::<Result<_, _>>()?;
        assert_eq!(ids, (900..1000).map(|i| i.to_string()).collect::<Vec<_>>());
        assert_eq!(db.before("e", "t", "3").await?.len(), 1);
        assert!(db.around("e", "t", obsolete.id()).await?.is_empty());
        let tail = db.recent("e", "t").await?;
        assert_eq!(
            &tail[98..],
            [
                serde_json::to_string(&first)?,
                serde_json::to_string(&newest)?
            ]
        );
        // Abort after the delete or tail update, before the new prefix can commit.
        db.0.execute("CREATE TRIGGER fail_history_write BEFORE INSERT ON messages WHEN NEW.id='999' BEGIN SELECT RAISE(ABORT, 'test interruption'); END").await?;
        assert!(
            db.replace("e", "t", &prefix, std::slice::from_ref(&newest))
                .await
                .is_err()
        );
        let edited = message(1001, "uncommitted");
        assert!(
            db.merge_prefix("e", "t", first.id(), &prefix, &[edited])
                .await
                .is_err()
        );
        assert_eq!(tail, db.recent("e", "t").await?);
        assert_eq!(page, db.before("e", "t", first.id()).await?);
        db.0.execute("DROP TRIGGER fail_history_write").await?;
        assert!(db.merge_prefix("e", "t", first.id(), &[], &[]).await?);
        assert!(db.before("e", "t", first.id()).await?.is_empty());
        db.remove("e", "t").await?;
        assert!(!db.merge_prefix("e", "t", first.id(), &prefix, &[]).await?);
        assert!(db.recent("e", "t").await?.is_empty());
        Ok(())
    }

    /// What a streaming thread costs the cache per flush. `cargo test -p conn-cache --release --
    /// --ignored --nocapture flush_costs` prints the rows and bytes written, and the file growth.
    #[tokio::test]
    #[ignore = "a measurement, not a check"]
    async fn flush_costs() -> Result<(), Box<dyn std::error::Error>> {
        use crate::{Message, TailChange, TailMarks};
        use std::time::Instant;

        let entries = |streamed: usize| -> Vec<conn_state::TimelineEntry> {
            (0..1000)
                .map(|n| {
                    let body = if n == 999 {
                        "streamed ".repeat(streamed)
                    } else {
                        format!("{n}: {}", "an earlier answer of the thread. ".repeat(120))
                    };
                    conn_state::TimelineEntry::Assistant {
                        id: format!("m{n}"),
                        markdown: body,
                        streaming: false,
                        created_at: None,
                        run_id: None,
                        status: conn_state::ItemStatus::Completed,
                    }
                })
                .collect()
        };
        let sizes = |label: &str, dir: &std::path::Path| {
            let total: u64 = ["messages.sqlite3", "messages.sqlite3-wal"]
                .iter()
                .filter_map(|f| std::fs::metadata(dir.join(f)).ok())
                .map(|m| m.len())
                .sum();
            println!("{label}: database + wal on disk {total} bytes");
        };
        for whole in [true, false] {
            let dir = tempfile::tempdir()?;
            let db = MessageCache::open(&dir.path().join("messages.sqlite3")).await?;
            let mut marks: Option<TailMarks> = None;
            let (mut rows_written, mut body_bytes, mut capture_ms) = (0_u64, 0_usize, 0.0);
            for flush in 0..100 {
                let tail = entries(10 + flush);
                let start = Instant::now();
                let prints: Vec<(&str, u64)> =
                    tail.iter().filter_map(Message::fingerprint).collect();
                let change = match (&marks, whole) {
                    (Some(marks), false) => marks.diff(&prints),
                    _ => TailChange::Whole,
                };
                let picked: Vec<Message> = match &change {
                    TailChange::Nothing => Vec::new(),
                    TailChange::Rows(rows) => rows
                        .iter()
                        .filter_map(|&i| Message::capture(&tail[i]))
                        .collect(),
                    TailChange::Whole => tail.iter().filter_map(Message::capture).collect(),
                };
                capture_ms += start.elapsed().as_secs_f64() * 1000.0;
                let rows: Vec<(&str, &Message)> = picked.iter().map(|m| (m.id(), m)).collect();
                body_bytes += serde_json::to_vec(&rows)?.len();
                rows_written += if matches!(change, TailChange::Whole) {
                    db.merge("e", "t", &rows).await?
                } else {
                    db.upsert("e", "t", &rows).await?
                };
                marks = Some(TailMarks::new(&prints));
            }
            let label = if whole {
                "before (whole tail)"
            } else {
                "after (changed rows)"
            };
            println!(
                "{label}: per flush {:.1} rows written, {:.0} KiB serialized, capture {:.3} ms (main thread)",
                rows_written as f64 / 100.0,
                body_bytes as f64 / 100.0 / 1024.0,
                capture_ms / 100.0,
            );
            sizes(label, dir.path());
        }
        Ok(())
    }

    async fn stored(db: &MessageCache, thread: &str) -> Vec<(String, String)> {
        sqlx::query_as("SELECT id, body FROM messages WHERE thread=? ORDER BY position")
            .bind(thread)
            .fetch_all(&db.0)
            .await
            .expect("stored rows")
    }

    /// Writing only the changed rows leaves the cache as writing the whole tail every time does,
    /// through appends, edits, a window that slides at the cap, reorders and removals.
    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "compare both caches after each step and propagate database setup failures"
    )]
    async fn changed_rows_leave_the_cache_as_whole_tail_writes_do()
    -> Result<(), Box<dyn std::error::Error>> {
        use crate::{TailChange, TailMarks};
        use std::hash::{Hash as _, Hasher as _};

        let dir = tempfile::tempdir()?;
        let whole = MessageCache::open(&dir.path().join("whole.sqlite3")).await?;
        let delta = MessageCache::open(&dir.path().join("delta.sqlite3")).await?;
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move |bound: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            usize::try_from(seed % bound as u64).expect("a small number")
        };
        let mut counter = 0_usize;
        let mut window: Vec<(String, String)> = Vec::new();
        let mut marks: Option<TailMarks> = None;
        let (mut whole_rows, mut delta_rows) = (0, 0);
        for step in 0..600 {
            match next(8) {
                0..=2 => {
                    for _ in 0..=next(3) {
                        counter += 1;
                        window.push((format!("m{counter}"), format!("body {counter}")));
                    }
                }
                3 | 4 if !window.is_empty() => {
                    let at = next(window.len());
                    window[at].1 = format!("edited at step {step}");
                }
                5 if window.len() > 1 => {
                    let drop = 1 + next(3).min(window.len() - 1);
                    window.drain(..drop);
                }
                6 if window.len() > 2 => {
                    let (a, b) = (next(window.len()), next(window.len()));
                    window.swap(a, b);
                }
                7 if !window.is_empty() => {
                    if next(2) == 0 {
                        window.pop();
                    } else {
                        counter += 1;
                        let at = next(window.len());
                        window.insert(at, (format!("m{counter}"), "inserted".to_owned()));
                    }
                }
                _ => {}
            }
            // The live window never holds more than the cap.
            let cap = 40;
            window.drain(..window.len().saturating_sub(cap));
            let rows: Vec<(&str, &String)> =
                window.iter().map(|(id, body)| (&**id, body)).collect();
            let tail: Vec<(&str, u64)> = window
                .iter()
                .map(|(id, body)| {
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    body.hash(&mut hasher);
                    (&**id, hasher.finish())
                })
                .collect();
            whole_rows += whole.merge("e", "t", &rows).await?;
            let change = marks.as_ref().map_or(TailChange::Whole, |m| m.diff(&tail));
            match change {
                TailChange::Nothing => {}
                TailChange::Rows(changed) => {
                    let rows: Vec<_> = changed.iter().map(|&i| rows[i]).collect();
                    delta_rows += delta.upsert("e", "t", &rows).await?;
                }
                TailChange::Whole => delta_rows += delta.merge("e", "t", &rows).await?,
            }
            marks = Some(TailMarks::new(&tail));
            assert_eq!(
                stored(&whole, "t").await,
                stored(&delta, "t").await,
                "step {step}"
            );
        }
        assert!(
            delta_rows * 3 < whole_rows,
            "{delta_rows} rows written, against {whole_rows} for whole tails"
        );
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assert the stored rows and propagate database setup failures"
    )]
    async fn upsert_writes_only_new_and_changed_rows_and_keeps_places()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let db = MessageCache::open(&dir.path().join("messages.sqlite3")).await?;
        let rows = |texts: &[(&'static str, &str)]| -> Vec<(&'static str, String)> {
            texts
                .iter()
                .map(|&(id, text)| (id, text.to_owned()))
                .collect()
        };
        let first = rows(&[("a", "one"), ("b", "two")]);
        let refs: Vec<(&str, &String)> = first.iter().map(|(id, text)| (*id, text)).collect();
        assert_eq!(db.merge("e", "t", &refs).await?, 2);
        let next = rows(&[("b", "two, edited"), ("c", "three"), ("a", "one")]);
        let refs: Vec<(&str, &String)> = next.iter().map(|(id, text)| (*id, text)).collect();
        // `a` is unchanged and stays first; `b` keeps its place; `c` goes last.
        assert_eq!(db.upsert("e", "t", &refs).await?, 2);
        assert_eq!(db.upsert("e", "t", &refs).await?, 0, "nothing changed");
        let ids: Vec<_> = stored(&db, "t")
            .await
            .into_iter()
            .map(|row| row.0)
            .collect();
        assert_eq!(ids, ["a", "b", "c"]);
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "assert the stored rows and propagate database setup failures"
    )]
    async fn merge_and_expiry_preserve_other_threads_and_environments()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let db = MessageCache::open(&dir.path().join("messages.sqlite3")).await?;
        let ids: Vec<_> = (0..1001).map(|i| i.to_string()).collect();
        let rows: Vec<_> = ids.iter().map(|id| (id.as_str(), id)).collect();
        db.merge("one", "a", &rows[..1000]).await?;
        db.merge("two", "a", &rows[..1]).await?;
        db.merge("one", "b", &rows[..1]).await?;
        db.merge("one", "a", &rows[999..]).await?;
        let stored: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM messages WHERE environment='one' AND thread='a' ORDER BY position",
        )
        .fetch_all(&db.0)
        .await?;
        assert_eq!(
            stored,
            ids[1..],
            "only the oldest id over the cap is evicted"
        );
        for env in ["one", "two"] {
            db.save_outline(env, "a", "whole outline").await?;
        }
        let window = db.around("one", "a", "500").await?;
        assert_eq!(window.len(), 100);
        assert_eq!(window[20], r#""500""#);
        assert!(db.around("one", "a", "0").await?.is_empty());
        assert!(db.around("two", "a", "500").await?.is_empty());
        db.remove("one", "a").await?;
        assert!(db.outline("one", "a").await?.is_none());
        assert_eq!(
            db.outline("two", "a").await?.as_deref(),
            Some("whole outline")
        );
        let others: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT environment,thread,id FROM messages ORDER BY environment,thread",
        )
        .fetch_all(&db.0)
        .await?;
        assert_eq!(
            others,
            [
                ("one".into(), "b".into(), "0".into()),
                ("two".into(), "a".into(), "0".into())
            ],
            "expiry deletes only the target rows"
        );
        Ok(())
    }
}
