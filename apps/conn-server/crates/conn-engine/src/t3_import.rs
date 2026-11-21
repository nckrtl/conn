//! Carries a T3 server's threads and projects over to this engine, once, at the first start.
//!
//! A state folder the T3 server used holds `statev2.sqlite`. When the engine's own
//! `engine.sqlite` is missing there, [`import_t3_state`] builds it from T3's projection rows:
//! projects, threads (archived and deleted ones too), and each thread's runs, attempts, nodes,
//! subagents, provider sessions, threads and turns, runtime requests, messages, plans, turn
//! items, checkpoint scopes, checkpoints, context handoffs and transfers, plus MCP app model
//! context. Every row keeps its id and its JSON body, which is T3's encoded
//! `OrchestrationV2*` value, the same shape this engine stores.
//!
//! - **T3's file stays as it is.** It is attached read-only (`mode=ro`), so the T3 server can
//!   take over again (rollback) with every thread it had. Threads made here do not go back.
//! - **All or nothing.** The rows are copied in one transaction, so they are one consistent
//!   read of T3's file. The store is built as `engine.sqlite.t3-import` and renamed to
//!   `engine.sqlite` only when it is complete; a crash leaves no `engine.sqlite`, and the next
//!   start removes the partial file and imports again.
//! - **Once.** An existing `engine.sqlite` is never touched.
//! - T3's event log is not carried over (T3 compacts it; clients read projections). Sessions,
//!   pairings and command receipts do not move either.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, params};

use crate::store::Store;

/// The T3 server's state file in its `userdata` folder.
pub(crate) const T3_STATE_FILE: &str = "statev2.sqlite";
/// The engine's file in the same folder.
pub(crate) const ENGINE_FILE: &str = "engine.sqlite";
const PARTIAL_SUFFIX: &str = ".t3-import";
/// Threads whose shell rows one write recomputes.
const SHELL_BATCH: usize = 200;

/// What an import carried over.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub projects: u64,
    pub threads: u64,
    /// Rows per collection, in `OrchestrationV2ThreadProjection` field order.
    pub collections: Vec<(&'static str, u64)>,
}

impl ImportReport {
    /// One line for the server log.
    pub fn summary(&self) -> String {
        let rows = self
            .collections
            .iter()
            .map(|(kind, count)| format!("{kind} {count}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "imported the T3 server's state: {} projects, {} threads ({rows})",
            self.projects, self.threads
        )
    }
}

/// One projection table: the engine collection it fills, the T3 rows (a table in the attached
/// `t3` schema, or a query over it), the columns that give the row's id and thread, the order
/// T3's `ProjectionStore` reads it in, and the stored ordinal (turn items and runs keep theirs).
struct Collection {
    kind: &'static str,
    table: &'static str,
    id: &'static str,
    thread: &'static str,
    order: &'static str,
    ordinal: &'static str,
}

/// T3's tables in `OrchestrationV2ThreadProjection` field order. `order` is the `ORDER BY`
/// of the read in `ProjectionStore.ts` (`getThreadProjection`), so `first_seq`, by which this
/// engine lists a collection, keeps T3's order. A context transfer belongs to its target
/// thread, where this engine files the ones it makes (`fork.rs`, `merge_back.rs`). A provider
/// session shows in each thread bound to it (T3's `provider_session_bindings`; a detached
/// session has no binding, as this engine deletes its row on `provider-session.detached`).
const COLLECTIONS: [Collection; 15] = [
    Collection {
        kind: "runs",
        table: "t3.orchestration_v2_projection_runs",
        id: "run_id",
        thread: "thread_id",
        order: "ordinal, run_id",
        ordinal: "ordinal",
    },
    Collection {
        kind: "attempts",
        table: "t3.orchestration_v2_projection_run_attempts",
        id: "attempt_id",
        thread: "thread_id",
        order: "run_id, attempt_ordinal",
        ordinal: "NULL",
    },
    Collection {
        kind: "nodes",
        table: "t3.orchestration_v2_projection_nodes",
        id: "node_id",
        thread: "thread_id",
        order: "COALESCE(started_at, ''), node_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "subagents",
        table: "t3.orchestration_v2_projection_subagents",
        id: "subagent_id",
        thread: "thread_id",
        order: "COALESCE(started_at, ''), subagent_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "providerSessions",
        table: "(SELECT bindings.thread_id AS bound_thread_id, sessions.*
          FROM t3.orchestration_v2_projection_provider_session_bindings AS bindings
          JOIN t3.orchestration_v2_projection_provider_sessions AS sessions
            ON sessions.provider_session_id = bindings.provider_session_id)",
        id: "provider_session_id",
        thread: "bound_thread_id",
        order: "updated_at, provider_session_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "providerThreads",
        table: "t3.orchestration_v2_projection_provider_threads",
        id: "provider_thread_id",
        thread: "thread_id",
        order: "COALESCE(first_run_ordinal, 0), provider_thread_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "providerTurns",
        table: "t3.orchestration_v2_projection_provider_turns",
        id: "provider_turn_id",
        thread: "thread_id",
        order: "provider_thread_id, ordinal",
        ordinal: "NULL",
    },
    Collection {
        kind: "runtimeRequests",
        table: "t3.orchestration_v2_projection_runtime_requests",
        id: "runtime_request_id",
        thread: "thread_id",
        order: "created_at, runtime_request_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "messages",
        table: "t3.orchestration_v2_projection_messages",
        id: "message_id",
        thread: "thread_id",
        order: "created_at, message_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "plans",
        table: "t3.orchestration_v2_projection_plans",
        id: "plan_id",
        thread: "thread_id",
        order: "plan_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "turnItems",
        table: "t3.orchestration_v2_projection_turn_items",
        id: "turn_item_id",
        thread: "thread_id",
        order: "ordinal, turn_item_id",
        ordinal: "ordinal",
    },
    Collection {
        kind: "checkpointScopes",
        table: "t3.orchestration_v2_projection_checkpoint_scopes",
        id: "scope_id",
        thread: "thread_id",
        order: "ordinal_within_parent, scope_id",
        ordinal: "NULL",
    },
    Collection {
        kind: "checkpoints",
        table: "t3.orchestration_v2_projection_checkpoints",
        id: "checkpoint_id",
        thread: "thread_id",
        order: "scope_id, ordinal_within_scope",
        ordinal: "NULL",
    },
    Collection {
        kind: "contextHandoffs",
        table: "t3.orchestration_v2_projection_context_handoffs",
        id: "context_handoff_id",
        thread: "thread_id",
        order: "rowid",
        ordinal: "NULL",
    },
    Collection {
        kind: "contextTransfers",
        table: "t3.orchestration_v2_projection_context_transfers",
        id: "context_transfer_id",
        thread: "target_thread_id",
        order: "rowid",
        ordinal: "NULL",
    },
];

/// Projects as T3's `ProjectStore` reads them (`ProjectDbRow`), as the engine's project body:
/// T3's `OrchestrationProjectShell` fields plus `deletedAt`.
const PROJECTS_SQL: &str = "INSERT OR IGNORE INTO projects (id, workspace_root, body)
  SELECT project_id, workspace_root, json_object(
    'id', project_id,
    'title', title,
    'hasCustomTitle', json(CASE WHEN has_custom_title THEN 'true' ELSE 'false' END),
    'workspaceRoot', workspace_root,
    'defaultModelSelection', json(COALESCE(default_model_selection_json, 'null')),
    'defaultThreadEnvMode', default_thread_env_mode,
    'autoPull', json(CASE WHEN auto_pull THEN 'true' ELSE 'false' END),
    'faviconPath', favicon_path,
    'projectIcon', json(COALESCE(project_icon_json, 'null')),
    'scripts', json(scripts_json),
    'pinnedAt', pinned_at,
    'archivedAt', archived_at,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'deletedAt', deleted_at)
  FROM t3.projection_projects
  -- A folder has one live project; a deleted row gives way, as in `put_project`.
  WHERE deleted_at IS NULL OR NOT EXISTS (SELECT 1 FROM t3.projection_projects AS live
    WHERE live.workspace_root = projection_projects.workspace_root
      AND (live.deleted_at IS NULL OR live.rowid > projection_projects.rowid))
  ORDER BY created_at, project_id";

/// Threads: T3's payload is the `OrchestrationV2Thread` this engine stores. The projection's
/// `updatedAt` is the thread's (`ProjectionStore.ts`), which `activity_at` gives here.
const THREADS_SQL: &str = "INSERT INTO threads (id, project_id, deleted, activity_at, thread)
  SELECT thread_id, project_id, deleted_at IS NOT NULL, updated_at, payload_json
  FROM t3.orchestration_v2_projection_threads ORDER BY created_at, thread_id";

/// Imports the T3 server's state into `<state_dir>/engine.sqlite`, when that file is missing
/// and `<state_dir>/statev2.sqlite` exists. Returns `None` when there is nothing to do.
/// Blocking: run it off the async runtime.
pub fn import_t3_state(state_dir: &Path) -> Result<Option<ImportReport>, String> {
    let engine = state_dir.join(ENGINE_FILE);
    let source = state_dir.join(T3_STATE_FILE);
    if engine.exists() || !source.is_file() {
        return Ok(None);
    }
    let partial = with_suffix(&engine, PARTIAL_SUFFIX);
    remove_sqlite_files(&partial)?;
    let report = build(&partial, &source)?;
    fs::rename(&partial, &engine).map_err(|e| {
        format!(
            "t3 import: cannot move {} into place: {e}",
            partial.display()
        )
    })?;
    if let Ok(dir) = fs::File::open(state_dir) {
        let _ = dir.sync_all();
    }
    Ok(Some(report))
}

fn build(partial: &Path, source: &Path) -> Result<ImportReport, String> {
    // The engine's schema, as a fresh store has it.
    drop(Store::open(partial)?);
    let conn = Connection::open_with_flags(
        partial,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(err)?;
    conn.execute_batch("PRAGMA cache_size=-8192; PRAGMA mmap_size=0;")
        .map_err(err)?;
    attach_t3(&conn, source)?;
    let mut report = ImportReport::default();
    let tx = conn.unchecked_transaction().map_err(err)?;
    report.projects = tx.execute(PROJECTS_SQL, []).map_err(err)? as u64;
    report.threads = tx.execute(THREADS_SQL, []).map_err(err)? as u64;
    let mut next_seq: i64 = 1;
    for c in &COLLECTIONS {
        let sql = format!(
            "INSERT OR REPLACE INTO entities (thread_id, kind, id, first_seq, seq, ordinal, body)
             SELECT {thread}, ?1, {id}, ?2 + n, ?2 + n, {ordinal}, payload_json FROM (
               SELECT *, row_number() OVER (ORDER BY {thread}, {order}) - 1 AS n FROM {table}
               WHERE {thread} IS NOT NULL)",
            thread = c.thread,
            id = c.id,
            ordinal = c.ordinal,
            order = c.order,
            table = c.table,
        );
        let rows = tx.execute(&sql, params![c.kind, next_seq]).map_err(err)? as i64;
        next_seq += rows;
        report.collections.push((c.kind, rows as u64));
    }
    // Final message texts for search, as `index_message` adds them.
    tx.execute_batch(
        "INSERT OR IGNORE INTO message_keys (thread_id, message_id)
           SELECT thread_id, id FROM entities WHERE kind = 'messages'
             AND COALESCE(json_extract(body, '$.streaming'), 0) = 0
           ORDER BY first_seq;
         INSERT INTO message_search (rowid, text)
           SELECT k.id, COALESCE(json_extract(e.body, '$.text'), '') FROM message_keys k
           JOIN entities e ON e.thread_id = k.thread_id AND e.kind = 'messages' AND e.id = k.message_id;
         INSERT OR REPLACE INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
           SELECT thread_id, item_id, server, tool, text, updated_at FROM t3.mcp_app_model_context;",
    )
    .map_err(err)?;
    // Sequences this engine takes next start above the imported rows (`Store::open`).
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_through', ?1)",
        [next_seq - 1],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    conn.execute_batch("DETACH DATABASE t3").map_err(err)?;
    drop(conn);

    // The shell rows, computed by the engine as after any write.
    let mut store = Store::open(partial)?;
    let ids = store.query_rows_text("SELECT id FROM threads WHERE deleted = 0 ORDER BY rowid")?;
    for batch in ids.chunks(SHELL_BATCH) {
        let mut tx = store.tx()?;
        for id in batch {
            tx.touch(id);
        }
        tx.commit(None)?;
    }
    store.checkpoint()?;
    drop(store);
    Ok(report)
}

/// Attaches T3's file as `t3`, read-only. A T3 server that stopped cleanly leaves no `-wal`
/// file, and a read-only open then may need to create one; where it cannot, the file is read
/// as immutable, which is exact when no `-wal` holds pages.
fn attach_t3(conn: &Connection, source: &Path) -> Result<(), String> {
    let probe = |uri: String| {
        conn.execute("ATTACH DATABASE ?1 AS t3", [uri])?;
        let probed = conn.query_row("SELECT count(*) FROM t3.sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        });
        if probed.is_err() {
            let _ = conn.execute_batch("DETACH DATABASE t3");
        }
        probed.map(|_| ())
    };
    match probe(read_only_uri(source, false)) {
        Ok(()) => Ok(()),
        Err(error) => {
            let wal = fs::metadata(with_suffix(source, "-wal")).map_or(0, |m| m.len());
            if wal > 0 {
                return Err(err(error));
            }
            probe(read_only_uri(source, true)).map_err(err)
        }
    }
}

/// `file:` URI that opens `path` read-only (and `immutable`, when asked). Characters with a
/// meaning in a URI are escaped.
fn read_only_uri(path: &Path, immutable: bool) -> String {
    let mut uri = String::from("file:");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                uri.push(byte as char);
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri.push_str(if immutable {
        "?mode=ro&immutable=1"
    } else {
        "?mode=ro"
    });
    uri
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn remove_sqlite_files(path: &Path) -> Result<(), String> {
    for file in [
        path.to_owned(),
        with_suffix(path, "-wal"),
        with_suffix(path, "-shm"),
        with_suffix(path, "-journal"),
    ] {
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("t3 import: cannot remove {}: {e}", file.display())),
        }
    }
    Ok(())
}

fn err(e: rusqlite::Error) -> String {
    format!("t3 import: {e}")
}

#[cfg(test)]
mod tests;
