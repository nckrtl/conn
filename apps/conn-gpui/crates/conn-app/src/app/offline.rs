//! A bounded chat preview. Only the live reducer owns stream cursors and interactive items.
use crate::chat::{ThreadOutline, TocEntry};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use conn_cache::{Message, MessageCache, TailChange, TailMarks, fetch_history_prefix};
use conn_client::Connection;
use conn_state::environments::LinkedShellSnapshot;
use conn_state::{ShellState, ThreadShell, ThreadState, TimelineEntry};
use gpui_kit::Context;
use sha2::{Digest as _, Sha256};

use super::ConnApp;

static CACHE_WRITER: Mutex<()> = Mutex::new(());

const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

fn expires_at(thread: &ThreadShell) -> Option<i64> {
    if thread.deleted_at.is_some() {
        return Some(0);
    }
    thread
        .settled_at
        .as_deref()
        .or(thread.archived_at.as_deref())
        .and_then(conn_state::parse_iso8601_epoch_ms)
        .map(|t| t.saturating_add(RETENTION_MS))
}

fn expired(thread: &ThreadShell) -> bool {
    expires_at(thread).is_some_and(|at| i128::from(at) <= i128::from(super::now_ms()))
}

type ThreadKey = (String, String);

/// More changed threads than this are looked at as a sweep of every thread.
const SCOPE_LIMIT: usize = 512;

/// Which threads changed since the offline cache last looked at the shell.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) enum ShellScope {
    /// Nothing listed changed.
    Nothing,
    /// Only these thread ids changed, on whichever environment.
    Threads(HashSet<String>),
    /// Anything may have changed: a snapshot, a new merge, or the first look.
    #[default]
    All,
}

/// Whether the cache watches `thread`'s stream: an unsettled thread the user may open, or a
/// child (subagent, side chat or delegated task) that still runs or asks something. A finished
/// child's stream does not change until something starts it again, which the shell reports.
fn watch_worthy(thread: &ThreadShell) -> bool {
    thread.deleted_at.is_none()
        && !ShellState::is_settled(thread)
        && (!ShellState::is_child(thread) || ShellState::is_live(thread))
}

#[derive(Clone)]
struct Backfill {
    key: ThreadKey,
    cursor: String,
    anchor: Option<String>,
    limit: usize,
    serial: u64,
    stamp: String,
}

#[derive(Default)]
pub(super) struct Offline {
    dir: Option<PathBuf>,
    db: Option<MessageCache>,
    owners: HashMap<String, String>,
    shadow: HashMap<ThreadKey, ThreadState>,
    subscriptions: HashMap<(String, String), Connection>,
    dirty: HashSet<(String, String)>,
    task_links_dirty: HashSet<ThreadKey>,
    expired: HashSet<(String, String)>,
    deadlines: HashMap<ThreadKey, i64>,
    deadlines_dirty: bool,
    /// The earliest deadline still to pass; `None` when unknown, so the next look sweeps them all.
    next_deadline: Option<i64>,
    /// The threads whose streams the cache watches.
    desired: HashSet<ThreadKey>,
    /// Which threads changed since expiry and the watches last looked at the shell.
    scope: ShellScope,
    outlines: HashMap<(String, String), Arc<ThreadOutline>>,
    outline_writes: HashMap<(String, String), String>,
    outline_requested: HashMap<(String, String), String>,
    outline_queue: std::collections::VecDeque<(String, String)>,
    loading_outline: Option<(String, String)>,
    outline_epoch: u64,
    backfills: std::collections::VecDeque<Backfill>,
    snapshots: HashMap<ThreadKey, Arc<u64>>,
    lifetime: Arc<()>,
    snapshot_cursors: HashMap<ThreadKey, String>,
    commits: HashMap<ThreadKey, Commit>,
    /// The live tail each thread's cache rows were last written from, once a write is confirmed.
    /// The next save writes only the rows that differ.
    saved_tails: HashMap<ThreadKey, TailMarks>,
    serial: u64,
    backfilling: bool,
    shell_dirty: bool,
    /// When the shell snapshot was last captured for a write.
    shell_saved_at: Option<Instant>,
    /// A timer waits to save the dirty shell once [`SHELL_SAVE_INTERVAL`] has passed.
    shell_save_armed: bool,
    saving: bool,
}

/// How often the whole shell snapshot (thousands of threads, megabytes of JSON) may be written.
/// A running thread changes the shell every few seconds; the snapshot only seeds the next launch,
/// and quitting writes the latest one.
pub(super) const SHELL_SAVE_INTERVAL: Duration = Duration::from_secs(30);

fn key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

impl Offline {
    pub(super) fn new() -> Self {
        if cfg!(test) && std::env::var_os("CONN_GPUI_CONFIG_DIR").is_none() {
            return Self::default();
        }
        let dir = conn_desktop::orbit::OrbitSessionStore::default_path()
            .and_then(|p| p.parent().map(|d| d.join("offline-v1")));
        let db = dir.as_ref().and_then(|dir| {
            let opened = std::fs::create_dir_all(dir).and_then(|()| {
                crate::live::RT
                    .block_on(MessageCache::open(&dir.join("messages.sqlite3")))
                    .map_err(io::Error::other)
            });
            match opened {
                Ok(db) => Some(db),
                Err(err) => {
                    eprintln!("offline message database: {err}");
                    None
                }
            }
        });
        let deadlines = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join("settlement-deadlines")).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<(ThreadKey, i64)>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        Self {
            dir,
            db,
            deadlines,
            ..Self::default()
        }
    }
    fn path(&self, env: &str, id: Option<&str>) -> Option<PathBuf> {
        Some(
            self.dir
                .as_ref()?
                .join(key(env))
                .join(id.map_or_else(|| "shell".to_owned(), key)),
        )
    }
    /// `env`'s connection dropped and is reconnecting. Its watched streams stay: the client
    /// resubscribes them itself from their cursors. Forgetting them would make the next shell
    /// update refresh every watched thread from a full snapshot at once, on a server that has
    /// just restarted, ahead of the thread the user has open and any send.
    pub(super) fn disconnected(&mut self, env: &str) {
        self.snapshots.retain(|(owner, _), _| owner != env);
        self.snapshot_cursors.retain(|(owner, _), _| owner != env);
        self.commits.retain(|(owner, _), _| owner != env);
        self.backfills.retain(|job| job.key.0 != env);
        // Outlines already read stay read, and queued ones stay queued. Only the one in flight is
        // dropped, and asked for again by the next reconcile.
        if let Some(key) = self.loading_outline.take_if(|key| key.0 == env) {
            self.outline_epoch = self.outline_epoch.wrapping_add(1);
            self.outline_requested.remove(&key);
        }
    }

    /// `env`'s connection is gone for good (unlinked, signed out). Its watched streams go with it.
    pub(super) fn forget_environment(&mut self, env: &str) {
        self.disconnected(env);
        self.subscriptions.retain(|(owner, _), _| owner != env);
        self.saved_tails.retain(|(owner, _), _| owner != env);
    }

    /// Anything listed may have changed: the next look sweeps every thread.
    pub(super) fn note_all_threads(&mut self) {
        self.scope = ShellScope::All;
    }

    /// The threads `ids` changed.
    pub(super) fn note_threads(&mut self, ids: &[String]) {
        match &mut self.scope {
            ShellScope::All => {}
            ShellScope::Threads(held) => {
                held.extend(ids.iter().cloned());
                if held.len() > SCOPE_LIMIT {
                    self.scope = ShellScope::All;
                }
            }
            ShellScope::Nothing if ids.is_empty() => {}
            ShellScope::Nothing if ids.len() > SCOPE_LIMIT => self.scope = ShellScope::All,
            ShellScope::Nothing => {
                self.scope = ShellScope::Threads(ids.iter().cloned().collect());
            }
        }
    }

    /// What a shell item changed: a snapshot (its projects change) is a sweep.
    pub(super) fn note_change(&mut self, change: &conn_state::ShellChange) {
        if change.projects_changed {
            self.note_all_threads();
        } else {
            self.note_threads(&change.threads_changed);
        }
    }

    /// The threads whose streams the cache watches, sorted.
    #[cfg(test)]
    pub(super) fn desired_for_test(&self) -> Vec<ThreadKey> {
        let mut desired: Vec<ThreadKey> = self.desired.iter().cloned().collect();
        desired.sort();
        desired
    }

    /// The settlement deadlines and the expired threads, sorted.
    #[cfg(test)]
    pub(super) fn expiry_for_test(&self) -> (Vec<(ThreadKey, i64)>, Vec<ThreadKey>) {
        let mut deadlines: Vec<(ThreadKey, i64)> = self
            .deadlines
            .iter()
            .map(|(key, at)| (key.clone(), *at))
            .collect();
        deadlines.sort();
        let mut expired: Vec<ThreadKey> = self.expired.iter().cloned().collect();
        expired.sort();
        (deadlines, expired)
    }

    pub(super) fn watching(&self, env: Option<&str>, id: &str) -> bool {
        env.is_some_and(|env| {
            self.subscriptions
                .contains_key(&(env.to_owned(), id.to_owned()))
        })
    }
    /// Turns the cache on at `dir`, as the live app's config directory does.
    #[cfg(test)]
    pub(super) fn enable_for_test(&mut self, dir: PathBuf, db: MessageCache) {
        self.dir = Some(dir);
        self.db = Some(db);
    }
    #[cfg(test)]
    pub(super) fn watch_for_test(&mut self, env: &str, id: &str, connection: Connection) {
        self.subscriptions
            .insert((env.to_owned(), id.to_owned()), connection);
    }
    /// Whether a reducer for `id` on `env` waits in the shadow, because another environment owns
    /// the thread's visible reducer.
    pub(super) fn shadows(&self, env: &str, id: &str) -> bool {
        self.shadow.contains_key(&(env.to_owned(), id.to_owned()))
    }
    /// Forgets the snapshot bookkeeping of a stream that was dropped with its reducer. What was
    /// saved before stays, and the next snapshot starts the bookkeeping again.
    pub(super) fn forget_stream(&mut self, env: &str, id: &str) {
        let key = (env.to_owned(), id.to_owned());
        self.snapshots.remove(&key);
        self.snapshot_cursors.remove(&key);
        self.commits.remove(&key);
        self.backfills.retain(|job| job.key != key);
    }
    /// Whether a cache write of `id` on `env` is still to go: a dirty chat or task list, or a
    /// snapshot or backfill commit. Its reducer must stay until the write has captured it.
    pub(super) fn write_pending(&self, env: &str, id: &str) -> bool {
        let key = (env.to_owned(), id.to_owned());
        self.dirty.contains(&key)
            || self.task_links_dirty.contains(&key)
            || self.commits.contains_key(&key)
            || self.backfills.iter().any(|job| job.key == key)
    }
    /// Forgets that `env` owns `id`'s visible reducer, once that reducer is dropped.
    pub(super) fn forget_owner(&mut self, env: &str, id: &str) {
        if self.owners.get(id).is_some_and(|owner| owner == env) {
            self.owners.remove(id);
        }
    }
    /// Frees what `env` keeps in memory once it is gone for good: its shadow reducers, outlines
    /// and queued outline reads. Returns the threads whose visible reducer `env` owned, for the
    /// caller to drop. Outline writes still go to disk.
    pub(super) fn forget_environment_memory(&mut self, env: &str) -> Vec<String> {
        self.shadow.retain(|(owner, _), _| owner != env);
        self.outlines.retain(|(owner, _), _| owner != env);
        self.outline_requested.retain(|(owner, _), _| owner != env);
        self.outline_queue.retain(|(owner, _)| owner != env);
        let owned: Vec<String> = self
            .owners
            .iter()
            .filter(|(_, owner)| *owner == env)
            .map(|(id, _)| id.clone())
            .collect();
        self.owners.retain(|_, owner| owner != env);
        owned
    }
    /// Drops the shadow reducers no watch needs any more (a watch that ended for a thread whose
    /// id another environment shows). Returns how many went.
    pub(super) fn evict_unwatched_shadows(&mut self) -> usize {
        let cold: Vec<ThreadKey> = self
            .shadow
            .keys()
            .filter(|key| {
                !self.subscriptions.contains_key(*key) && !self.write_pending(&key.0, &key.1)
            })
            .cloned()
            .collect();
        for key in &cold {
            self.shadow.remove(key);
            self.forget_stream(&key.0, &key.1);
        }
        cold.len()
    }
    #[cfg(test)]
    pub(super) fn insert_outline_for_test(&mut self, env: &str, id: &str) {
        self.outlines.insert(
            (env.to_owned(), id.to_owned()),
            Arc::new(ThreadOutline::new(Vec::new())),
        );
    }
    #[cfg(test)]
    pub(super) fn memory_counts_for_test(&self, env: &str) -> (usize, usize, usize, usize) {
        (
            self.owners.values().filter(|owner| *owner == env).count(),
            self.shadow.keys().filter(|(owner, _)| owner == env).count(),
            self.outlines
                .keys()
                .filter(|(owner, _)| owner == env)
                .count(),
            self.subscriptions
                .keys()
                .filter(|(owner, _)| owner == env)
                .count(),
        )
    }
    pub(super) fn snapshot_cursor(&self, env: Option<&str>, id: &str) -> Option<String> {
        self.snapshot_cursors
            .get(&(env?.to_owned(), id.to_owned()))
            .cloned()
    }
    pub(super) fn snapshot_serial(&self, env: Option<&str>, id: &str) -> Option<u64> {
        self.snapshots
            .get(&(env?.to_owned(), id.to_owned()))
            .map(|serial| **serial)
    }
    pub(super) fn changed(&mut self, env: &str, id: &str) {
        if self.dir.is_some() {
            self.dirty.insert((env.to_owned(), id.to_owned()));
        }
    }
    pub(super) fn task_links_changed(&mut self, env: &str, id: &str) {
        if self.db.is_some() {
            self.task_links_dirty
                .insert((env.to_owned(), id.to_owned()));
        }
    }
    pub(super) fn shell_changed(&mut self) {
        self.shell_dirty = true;
    }

    /// Takes what finished writes report: only a confirmed write moves a chat's baseline. A
    /// skipped or failed one leaves the next save to write the whole tail again.
    fn saved(&mut self, stored: Vec<(ThreadKey, Option<TailMarks>)>) {
        for (key, tail) in stored {
            match tail {
                Some(tail) => self.saved_tails.insert(key, tail),
                None => self.saved_tails.remove(&key),
            };
        }
    }

    /// How long the dirty shell must still wait before it may be written; zero when it may now.
    fn shell_save_wait(&self, now: Instant) -> Duration {
        self.shell_saved_at.map_or(Duration::ZERO, |at| {
            SHELL_SAVE_INTERVAL.saturating_sub(now.saturating_duration_since(at))
        })
    }
}

enum Commit {
    Replace,
    Prefix {
        anchor: Option<String>,
        rows: Vec<Message>,
        stamp: String,
    },
}

/// The rows of a chat's live tail that a save writes.
enum ChatRows {
    /// The whole tail, in order, each row written again and moved to the end.
    Tail(Vec<Message>),
    /// The rows of the tail that are new or changed since the last confirmed write. They keep
    /// their places in the cache, and new ones go last.
    Changed(Vec<Message>),
}

impl ChatRows {
    fn len(&self) -> usize {
        match self {
            Self::Tail(rows) | Self::Changed(rows) => rows.len(),
        }
    }
}

enum Save {
    Shell(PathBuf, LinkedShellSnapshot),
    Deadlines(Vec<(ThreadKey, i64)>),
    Chat {
        key: ThreadKey,
        rows: ChatRows,
        commit: Option<Commit>,
        snapshot: Option<Weak<u64>>,
        /// The tail these rows come from. Once written, the next save compares with it.
        tail: TailMarks,
    },
    TaskLinks(ThreadKey, conn_state::ThreadTaskLinks, Option<Weak<u64>>),
    Remove(String, String),
    Outline(String, String, String),
}

/// What a save leaves for the next one.
enum Stored {
    Nothing,
    /// A chat's cache rows now match this tail.
    Tail(TailMarks),
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(dir)?;
    // Unbuffered, serde_json makes one write(2) per token: millions for a large shell.
    let mut writer =
        io::BufWriter::with_capacity(256 * 1024, tempfile::NamedTempFile::new_in(dir)?);
    serde_json::to_writer(&mut writer, value)?;
    writer.flush()?;
    let file = writer
        .into_inner()
        .map_err(io::IntoInnerError::into_error)?;
    file.persist(path)?;
    Ok(())
}

fn merge_chat(db: &MessageCache, env: &str, id: &str, messages: &[Message]) -> io::Result<u64> {
    let rows = messages
        .iter()
        .map(|message| (message.id(), message))
        .collect::<Vec<_>>();
    crate::live::RT
        .block_on(db.merge(env, id, &rows))
        .map_err(io::Error::other)
}

/// Writes only these rows: the new ones, and the changed ones in the places they are stored.
fn upsert_chat(db: &MessageCache, env: &str, id: &str, messages: &[Message]) -> io::Result<u64> {
    let rows = messages
        .iter()
        .map(|message| (message.id(), message))
        .collect::<Vec<_>>();
    crate::live::RT
        .block_on(db.upsert(env, id, &rows))
        .map_err(io::Error::other)
}

/// What a save writes of a thread's live tail: only the rows that differ from the tail the cache
/// holds (`saved`), or the whole tail when there is none, `whole` asks for it, or the rows moved.
/// `None` when the cache is current. Copies only the rows it writes.
fn plan_chat(
    entries: &[TimelineEntry],
    saved: Option<&TailMarks>,
    whole: bool,
) -> Option<(ChatRows, TailMarks)> {
    let mut window: Vec<_> = entries
        .iter()
        .rev()
        .filter_map(|entry| Some((entry, Message::fingerprint(entry)?)))
        .take(conn_cache::MESSAGE_CAP)
        .collect();
    window.reverse();
    let tail: Vec<(&str, u64)> = window.iter().map(|&(_, mark)| mark).collect();
    let change = match saved {
        Some(saved) if !whole => saved.diff(&tail),
        _ => TailChange::Whole,
    };
    let rows = match change {
        TailChange::Nothing => return None,
        TailChange::Rows(rows) => ChatRows::Changed(
            rows.into_iter()
                .filter_map(|row| Message::capture(window[row].0))
                .collect(),
        ),
        TailChange::Whole => ChatRows::Tail(
            window
                .iter()
                .filter_map(|&(entry, _)| Message::capture(entry))
                .collect(),
        ),
    };
    Some((rows, TailMarks::new(&tail)))
}

// The previous local spike wrote one JSON array per thread. Import it before the
// first read or live merge so a short server snapshot cannot replace the older history.
fn import_legacy(db: &MessageCache, env: &str, id: &str, path: &Path) -> io::Result<()> {
    let array = match std::fs::read_to_string(path) {
        Ok(array) => array,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    crate::live::RT
        .block_on(db.import_legacy(env, id, &array))
        .map_err(io::Error::other)?;
    remove_legacy(path)
}

fn remove_legacy(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn read_chat(db: &MessageCache, env: &str, id: &str) -> io::Result<ThreadState> {
    let rows = crate::live::RT
        .block_on(db.recent(env, id))
        .map_err(io::Error::other)?;
    let mut state = ThreadState::new(id);
    state.replace_cached_prefix(decode_messages(rows)?);
    state.has_more_history = state.entries.len() == 100;
    restore_task_links(&mut state, db, env);
    Ok(state)
}

fn restore_task_links(state: &mut ThreadState, db: &MessageCache, env: &str) {
    match crate::live::RT.block_on(db.task_links(env, &state.thread_id)) {
        Ok(links) => state.task_links = links,
        Err(err) => eprintln!("offline task links: {err}"),
    }
}

fn decode_messages(rows: Vec<String>) -> serde_json::Result<Vec<TimelineEntry>> {
    rows.into_iter()
        .map(|body| serde_json::from_str::<Message>(&body).map(Message::entry))
        .collect()
}

fn replace_messages(db: &MessageCache, env: &str, id: &str, rows: &[Message]) -> io::Result<()> {
    crate::live::RT
        .block_on(db.replace(env, id, &[], rows))
        .map_err(io::Error::other)
}

fn save(dir: &Path, db: Option<&MessageCache>, write: Save) -> io::Result<Stored> {
    match write {
        Save::Shell(path, snapshot) => write_json(&path, &snapshot).map(|()| Stored::Nothing),
        Save::Deadlines(records) => {
            write_json(&dir.join("settlement-deadlines"), &records).map(|()| Stored::Nothing)
        }
        Save::Chat {
            key: (env, id),
            rows: messages,
            commit,
            snapshot,
            tail,
        } => {
            if snapshot.is_some_and(|snapshot| snapshot.strong_count() == 0) {
                return Ok(Stored::Nothing);
            }
            let Some(db) = db else {
                return Ok(Stored::Nothing);
            };
            import_legacy(db, &env, &id, &dir.join(key(&env)).join(key(&id)))?;
            let receipt = dir.join(key(&env)).join(key(&id)).with_extension("prefix");
            let written = messages.len();
            let messages = match messages {
                ChatRows::Changed(messages) => {
                    debug_assert!(commit.is_none(), "a commit rewrites the whole tail");
                    upsert_chat(db, &env, &id, &messages)?;
                    conn_client::perf_log!(
                        "offline.chat-save thread={id} rows={written} whole=false"
                    );
                    return Ok(Stored::Tail(tail));
                }
                ChatRows::Tail(messages) => messages,
            };
            match commit {
                Some(Commit::Replace) => {
                    remove_legacy(&receipt)?;
                    replace_messages(db, &env, &id, &messages)?;
                }
                Some(Commit::Prefix {
                    anchor,
                    mut rows,
                    stamp,
                }) => {
                    if let Some(anchor) = anchor {
                        if !crate::live::RT
                            .block_on(db.merge_prefix(&env, &id, &anchor, &rows, &messages))
                            .map_err(io::Error::other)?
                        {
                            return Ok(Stored::Nothing);
                        }
                    } else {
                        rows.extend(messages);
                        replace_messages(db, &env, &id, &rows)?;
                    }
                    if let Some(parent) = receipt.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(receipt, stamp)?;
                }
                None => {
                    merge_chat(db, &env, &id, &messages)?;
                }
            }
            conn_client::perf_log!("offline.chat-save thread={id} rows={written} whole=true");
            Ok(Stored::Tail(tail))
        }
        Save::TaskLinks((env, id), links, snapshot) => {
            if let Some(db) = db
                && !snapshot.is_some_and(|snapshot| snapshot.strong_count() == 0)
            {
                crate::live::RT
                    .block_on(db.save_task_links(&env, &id, &links))
                    .map_err(io::Error::other)?;
            }
            Ok(Stored::Nothing)
        }
        Save::Outline(env, id, markers) => {
            if let Some(db) = db {
                crate::live::RT
                    .block_on(db.save_outline(&env, &id, &markers))
                    .map_err(io::Error::other)?;
            }
            Ok(Stored::Nothing)
        }
        Save::Remove(env, id) => {
            if let Some(db) = db {
                let path = dir.join(key(&env)).join(key(&id));
                remove_legacy(&path.with_extension("prefix"))?;
                remove_legacy(&path)?;
                crate::live::RT
                    .block_on(db.remove(&env, &id))
                    .map_err(io::Error::other)?;
            }
            Ok(Stored::Nothing)
        }
    }
}

/// Runs the writes in order, reporting each chat's outcome: the tail its rows now match, or
/// `None` when its write failed or was skipped as stale.
fn run_saves(
    dir: &Path,
    db: Option<&MessageCache>,
    writes: Vec<Save>,
) -> Vec<(ThreadKey, Option<TailMarks>)> {
    let mut stored = Vec::new();
    for value in writes {
        let chat = match &value {
            Save::Chat { key, .. } => Some(key.clone()),
            _ => None,
        };
        let outcome = save(dir, db, value);
        if let Err(e) = &outcome {
            eprintln!("offline thread cache: {e}");
        }
        if let Some(chat) = chat {
            stored.push((
                chat,
                match outcome {
                    Ok(Stored::Tail(tail)) => Some(tail),
                    _ => None,
                },
            ));
        }
    }
    stored
}

fn capture_chat(entries: &[TimelineEntry]) -> Vec<Message> {
    let mut messages: Vec<_> = entries
        .iter()
        .rev()
        .filter_map(Message::capture)
        .take(1000)
        .collect();
    messages.reverse();
    messages
}

impl ConnApp {
    pub(super) fn cache_env(&self, thread: &str) -> Option<&str> {
        self.linked_environment_of_thread(thread)
            .or(self.server_url.as_deref())
    }
    fn cache_shell(&self, env: &str, id: &str) -> Option<&ThreadShell> {
        if self.server_url.as_deref() == Some(env) {
            self.shell
                .find_thread(id)
                .filter(|_| self.cache_env(id) == Some(env))
        } else {
            self.linked.shell_for_cache(env)?.find_thread(id)
        }
    }

    fn cache_state(&self, key: &ThreadKey) -> Option<&ThreadState> {
        if self.offline.owners.get(&key.1) == Some(&key.0) {
            self.threads.get(&key.1)
        } else {
            self.offline.shadow.get(key)
        }
    }

    fn route_cached_thread(&mut self, env: &str, id: &str) {
        if let Some(old) = self.offline.owners.insert(id.to_owned(), env.to_owned())
            && old != env
        {
            if let Some(state) = self.threads.remove(id) {
                self.offline.shadow.insert((old, id.to_owned()), state);
            }
            if let Some(state) = self.offline.shadow.remove(&(env.to_owned(), id.to_owned())) {
                self.threads.insert(id.to_owned(), state);
            }
        }
    }

    pub(super) fn apply_cache_stream(
        &mut self,
        env: &str,
        id: &str,
        item: conn_state::ThreadStreamItem,
    ) {
        let rollback = matches!(&item,conn_state::ThreadStreamItem::Event(ev)
            if matches!(&ev.event,conn_contract::OrchestrationV2DomainEvent::RunUpdated(run)
                if run.payload.status == conn_contract::OrchestrationV2RunStatus::RolledBack));
        if rollback {
            let key = (env.to_owned(), id.to_owned());
            if self.offline.snapshots.remove(&key).is_some() {
                self.offline.saved_tails.remove(&key);
                self.offline.commits.remove(&key);
                self.offline.backfills.retain(|job| job.key != key);
                if let Some(connection) = self.offline.subscriptions.get(&key) {
                    connection.refresh_thread(id);
                }
            }
        }
        let snapshot = matches!(item, conn_state::ThreadStreamItem::Snapshot(_));
        let state = if self.cache_env(id) == Some(env) {
            self.route_cached_thread(env, id);
            self.threads
                .entry(id.to_owned())
                .or_insert_with(|| ThreadState::new(id))
        } else {
            self.offline
                .shadow
                .entry((env.to_owned(), id.to_owned()))
                .or_insert_with(|| ThreadState::new(id))
        };
        // Open-thread and approval subscriptions can install an empty state before the first snapshot.
        if state.sequence.is_none()
            && state.task_links == Default::default()
            && !matches!(&item, conn_state::ThreadStreamItem::Synchronized(_))
            && !matches!(&item, conn_state::ThreadStreamItem::Snapshot(s) if s.history_cursor.as_ref().is_none_or(Option::is_none))
            && let Some(db) = &self.offline.db
        {
            restore_task_links(state, db, env);
        }
        let changed = state.apply(item);
        if changed || snapshot {
            self.offline.changed(env, id);
        }
        if snapshot {
            self.offline_snapshot(env.to_owned(), id);
        }
    }

    pub(super) fn restore_offline_shell(&mut self) {
        let Some(env) = self.server_url.as_deref() else {
            return;
        };
        if let Some(snapshot) = self
            .offline
            .path(env, None)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| LinkedShellSnapshot::from_json(&b))
            .filter(|s| s.environment_id == env)
        {
            self.shell = snapshot.into_shell();
        }
        self.remerge_linked_shells();
        let initial = self
            .shell
            .top_level_active_threads()
            .next()
            .or_else(|| self.shell.threads.first())
            .map(|t| (t.project_id.clone(), t.id.clone()));
        if let Some((project, id)) = initial {
            self.layout.selected_project_id = Some(project);
            self.open_thread(id);
        }
    }
    pub(super) fn cached_outline(&self, id: &str) -> Option<Arc<ThreadOutline>> {
        self.offline
            .outlines
            .get(&(self.cache_env(id)?.to_owned(), id.to_owned()))
            .cloned()
    }

    fn restore_outline(&mut self, id: &str) {
        let Some(env) = self.cache_env(id).map(str::to_owned) else {
            return;
        };
        let key = (env.clone(), id.to_owned());
        if self.offline.outlines.contains_key(&key)
            || self.shell.find_thread(id).is_none_or(expired)
        {
            return;
        }
        let Some(db) = self.offline.db.as_ref() else {
            return;
        };
        if let Ok(Some(raw)) = crate::live::RT.block_on(db.outline(&env, id))
            && let Ok(markers) = serde_json::from_str::<Vec<TocEntry>>(&raw)
        {
            self.offline
                .outlines
                .insert(key, Arc::new(ThreadOutline::new(markers)));
        }
    }

    pub(super) fn resolve_prompt(&mut self, prompt: &str, cx: &mut Context<'_, Self>) {
        let Some(id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        let Some(env) = self.cache_env(&id).map(str::to_owned) else {
            return;
        };
        if self.shell.find_thread(&id).is_some_and(|t| !expired(t))
            && let Some(db) = &self.offline.db
            && let Ok(rows) = crate::live::RT.block_on(db.around(&env, &id, prompt))
            && !rows.is_empty()
            && let Ok(entries) = decode_messages(rows)
        {
            self.chat
                .update(cx, |chat, cx| chat.show_prompt_window(prompt, &entries, cx));
            return;
        }
        if !self.thread_connected(&id) {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(Some(crate::chat::OFFLINE_PROMPT_NOTICE.to_owned()), cx)
            });
            return;
        }
        self.fetch_prompt_window(env, id, prompt.to_owned(), cx);
    }

    pub(super) fn restore_offline_chat(&mut self, id: &str) {
        if let Some(env) = self.cache_env(id).map(str::to_owned) {
            self.route_cached_thread(&env, id);
        }
        self.restore_outline(id);
        if self.shell.find_thread(id).is_none_or(expired) {
            return;
        }
        if self.threads.get(id).is_some_and(|state| {
            state.sequence.is_some()
                || !state.entries.is_empty()
                || !state.task_links.links.is_empty()
        }) {
            self.fill_warm_preview(id);
            return;
        }
        let (Some(env), Some(db)) = (self.cache_env(id), &self.offline.db) else {
            return;
        };
        let Some(path) = self.offline.path(env, Some(id)) else {
            return;
        };
        match import_legacy(db, env, id, &path).and_then(|()| read_chat(db, env, id)) {
            Ok(state) if !state.entries.is_empty() || !state.task_links.links.is_empty() => {
                self.threads.insert(id.to_owned(), state);
            }
            Ok(_) => (),
            Err(e) => eprintln!("offline message read: {e}"),
        }
    }
    fn offline_snapshot(&mut self, env: String, id: &str) {
        if self.offline.db.is_none() {
            return;
        }
        let key = (env, id.to_owned());
        self.offline.serial = self.offline.serial.wrapping_add(1);
        let serial = self.offline.serial;
        self.offline.snapshots.insert(key.clone(), Arc::new(serial));
        // The snapshot is the server's thread now: its next write starts from the whole tail.
        self.offline.saved_tails.remove(&key);
        self.offline.commits.remove(&key);
        self.offline.backfills.retain(|job| job.key != key);
        let Some(state) = self.cache_state(&key) else {
            return;
        };
        let cursor = state.history_cursor.clone();
        let messages = capture_chat(&state.entries);
        self.offline.snapshot_cursors.remove(&key);
        if let Some(cursor) = &cursor {
            self.offline
                .snapshot_cursors
                .insert(key.clone(), cursor.clone());
        }
        let limit = conn_cache::MESSAGE_CAP - messages.len();
        conn_client::perf_log!(
            "offline.snapshot thread={id} messages={} bounded={}",
            messages.len(),
            cursor.is_some()
        );
        if limit > 0
            && let Some(cursor) = cursor
        {
            let anchor = messages.first().map(|m| m.id().to_owned());
            let stamp =
                serde_json::json!([cursor, anchor, messages.last().map(Message::id), limit])
                    .to_string();
            let warm = self
                .offline
                .path(&key.0, Some(id))
                .and_then(|p| std::fs::read_to_string(p.with_extension("prefix")).ok())
                .as_ref()
                == Some(&stamp);
            if !warm {
                self.offline.backfills.push_back(Backfill {
                    key,
                    cursor,
                    anchor,
                    limit,
                    serial,
                    stamp,
                });
            }
        } else {
            self.offline.commits.insert(key, Commit::Replace);
            return;
        }
        if self.layout.selected_thread_id.as_deref() == Some(id) {
            self.fill_warm_preview(id);
        }
    }

    fn start_backfill(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.backfilling {
            return;
        }
        while let Some(job) = self.offline.backfills.pop_front() {
            let (env, id) = &job.key;
            if self.cache_shell(env, id).is_none_or(ShellState::is_settled) {
                continue;
            }
            let Some(connection) = self.offline.subscriptions.get(&job.key).cloned() else {
                continue;
            };
            let generation = self.connection_gen;
            self.offline.backfilling = true;
            conn_client::perf_log!("offline.backfill thread={id} limit={}", job.limit);
            cx.spawn(async move |this, cx| {
                let request = job.clone();
                let result = crate::live::RT
                    .spawn(async move {
                        fetch_history_prefix(
                            &connection,
                            &request.key.1,
                            &request.cursor,
                            request.limit,
                        )
                        .await
                    })
                    .await
                    .map_err(io::Error::other)
                    .and_then(|r| r.map_err(io::Error::other));
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.offline.backfilling = false;
                    let (env, id) = &job.key;
                    if app.offline.snapshots.get(&job.key).map(Arc::as_ref) == Some(&job.serial)
                        && app
                            .cache_shell(env, id)
                            .is_some_and(|t| !ShellState::is_settled(t) && !expired(t))
                    {
                        match result {
                            Ok(rows) => {
                                app.offline.commits.insert(
                                    job.key.clone(),
                                    Commit::Prefix {
                                        anchor: job.anchor,
                                        rows,
                                        stamp: job.stamp,
                                    },
                                );
                                app.offline.dirty.insert(job.key);
                                app.schedule_offline_save(cx);
                            }
                            Err(err) => {
                                eprintln!("offline history fetch: {err}");
                                cx.spawn(async move |this, cx| {
                                    cx.background_executor().timer(Duration::from_secs(5)).await;
                                    let _ = this.update(cx, |app, cx| {
                                        if app.connection_gen == generation
                                            && app.offline.snapshots.get(&job.key).map(Arc::as_ref)
                                                == Some(&job.serial)
                                        {
                                            app.offline.backfills.push_back(job);
                                            app.start_backfill(cx);
                                        }
                                    });
                                })
                                .detach();
                            }
                        }
                    }
                    app.start_backfill(cx);
                });
            })
            .detach();
            break;
        }
    }

    fn cached_before(&self, id: &str, anchor: &str) -> Option<Vec<TimelineEntry>> {
        let db = self.offline.db.as_ref()?;
        let rows = crate::live::RT
            .block_on(db.before(self.cache_env(id)?, id, anchor))
            .ok()?;
        decode_messages(rows).ok()
    }

    fn fill_warm_preview(&mut self, id: &str) {
        let Some(state) = self.threads.get(id) else {
            return;
        };
        let Some(env) = self.cache_env(id) else {
            return;
        };
        let key = (env.to_owned(), id.to_owned());
        if state.sequence.is_none() || !self.offline.snapshot_cursors.contains_key(&key) {
            return;
        }
        let prefix_count = state.history_prefix_len();
        if prefix_count > 100 {
            return;
        }
        let mut messages = state.entries[prefix_count..].iter().filter(|e| {
            matches!(
                e,
                TimelineEntry::User { .. } | TimelineEntry::Assistant { .. }
            )
        });
        let (missing, rows) = if let Some(first) = messages.next() {
            let missing = 99usize.saturating_sub(messages.count());
            if missing == 0 {
                return;
            }
            (missing, self.cached_before(id, first.id()))
        } else {
            if !state.has_more_history {
                return;
            }
            let Some(db) = self.offline.db.as_ref() else {
                return;
            };
            (
                100,
                crate::live::RT
                    .block_on(db.recent(env, id))
                    .ok()
                    .and_then(|rows| decode_messages(rows).ok()),
            )
        };
        if let Some(mut rows) = rows {
            let has_more = rows.len() >= missing;
            rows.drain(..rows.len().saturating_sub(missing));
            if let Some(state) = self.threads.get_mut(id)
                && (!rows.is_empty() || prefix_count > 0)
            {
                state.replace_cached_prefix(rows);
                state.history_cursor = None;
                state.has_more_history |= has_more;
            }
        }
    }

    pub(super) fn load_cached_page(&mut self, id: &str) -> bool {
        let Some(state) = self.threads.get(id) else {
            return false;
        };
        if !state.has_more_history || state.loading_earlier {
            return false;
        }
        let Some(first) = state.entries.iter().find(|e| {
            matches!(
                e,
                TimelineEntry::User { .. } | TimelineEntry::Assistant { .. }
            )
        }) else {
            return false;
        };
        let Some(rows) = self
            .cached_before(id, first.id())
            .filter(|rows| !rows.is_empty())
        else {
            return false;
        };
        let more = rows.len() == 100 || self.thread_connected(id);
        let Some(state) = self.threads.get_mut(id) else {
            return false;
        };
        state.prepend_cached_messages(rows);
        state.history_cursor = None;
        state.has_more_history = more;
        true
    }

    /// Catches the offline cache up with the shell changes noted since the last call. Expiry and
    /// the watched streams look only at the threads that changed, unless a sweep is due: a
    /// snapshot, a new merge, or a deadline passing.
    pub(super) fn offline_follow_shell(&mut self, cx: &mut Context<'_, Self>) {
        let scope = std::mem::replace(&mut self.offline.scope, ShellScope::Nothing);
        if self.offline.dir.is_none() {
            return;
        }
        self.expire_offline_in(&scope, cx);
        self.reconcile_offline_in(&scope, cx);
    }

    /// Expires every cached thread whose 24 hours have passed, over every thread (at launch and
    /// on the clock's minute tick).
    pub(super) fn expire_offline(&mut self, cx: &mut Context<'_, Self>) {
        self.expire_offline_in(&ShellScope::All, cx);
    }

    fn expire_offline_in(&mut self, scope: &ShellScope, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() {
            return;
        }
        let now = i64::try_from(super::now_ms()).unwrap_or(i64::MAX);
        let due = self.offline.next_deadline.is_none_or(|at| at <= now);
        match scope {
            ShellScope::Threads(ids) if !due => self.expire_threads(ids, now, cx),
            ShellScope::Nothing if !due => {}
            _ => self.expire_all(now, cx),
        }
    }

    /// The environments the cache keeps threads of: the primary one, then each linked one.
    fn cache_environments(&self) -> Vec<String> {
        self.server_url
            .iter()
            .cloned()
            .chain(
                self.linked
                    .cache_shells()
                    .into_iter()
                    .map(|(env, _)| env)
                    .filter(|env| self.server_url.as_deref() != Some(*env))
                    .map(str::to_owned),
            )
            .collect()
    }

    /// The copy of `id` on `env` that the active or archived list holds, as a full sweep reads it.
    fn cache_listed(&self, env: &str, id: &str) -> Option<&ThreadShell> {
        let find = |shell: &'_ ShellState| {
            shell
                .threads
                .iter()
                .chain(&shell.archived_threads)
                .position(|t| t.id == id)
        };
        if self.server_url.as_deref() == Some(env) {
            if self.cache_env(id) != Some(env) {
                return None;
            }
            let at = find(&self.shell)?;
            self.shell
                .threads
                .iter()
                .chain(&self.shell.archived_threads)
                .nth(at)
        } else {
            let shell = self.linked.shell_for_cache(env)?;
            let at = find(shell)?;
            shell.threads.iter().chain(&shell.archived_threads).nth(at)
        }
    }

    /// Every `(environment, thread)` pair [`Self::cache_shell`] finds, for a sweep.
    fn cache_index(&self) -> HashSet<(&str, &str)> {
        let mut held = HashSet::new();
        if let Some(env) = self.server_url.as_deref() {
            for thread in self.shell.every_thread() {
                if self.cache_env(&thread.id) == Some(env) {
                    held.insert((env, thread.id.as_str()));
                }
            }
        }
        for (env, shell) in self.linked.cache_shells() {
            if self.server_url.as_deref() == Some(env) {
                continue;
            }
            for thread in shell.every_thread() {
                held.insert((env, thread.id.as_str()));
            }
        }
        held
    }

    /// Forgets what the cache holds in memory of an expired thread. A thread that only now
    /// expired is also deleted from disk by the next save.
    fn forget_expired(&mut self, key: &ThreadKey, newly: bool) {
        if newly {
            self.offline.dirty.insert(key.clone());
            self.offline.shadow.remove(key);
            if self.offline.owners.get(&key.1) == Some(&key.0) {
                self.threads.remove(&key.1);
            }
        }
        if self.offline.loading_outline.as_ref() == Some(key) {
            self.offline.loading_outline = None;
            self.offline.outline_epoch = self.offline.outline_epoch.wrapping_add(1);
        }
        self.offline.snapshots.remove(key);
        self.offline.commits.remove(key);
        self.offline.outlines.remove(key);
        self.offline.outline_writes.remove(key);
        self.offline.outline_requested.remove(key);
    }

    fn selected_cache_key(&self) -> Option<ThreadKey> {
        let id = self.layout.selected_thread_id.as_deref()?;
        Some((self.cache_env(id)?.to_owned(), id.to_owned()))
    }

    /// The full sweep: the deadline of every settled thread of every environment, and which
    /// have passed.
    fn expire_all(&mut self, now: i64, cx: &mut Context<'_, Self>) {
        let mut deadlines = std::mem::take(&mut self.offline.deadlines);
        let previous = deadlines.clone();
        let settled = |t: &ThreadShell| t.deleted_at.is_some() || ShellState::is_settled(t);
        let expired_keys: HashSet<ThreadKey> = {
            let held = self.cache_index();
            deadlines.retain(|(env, id), _| !held.contains(&(env.as_str(), id.as_str())));
            for thread in self
                .shell
                .threads
                .iter()
                .chain(&self.shell.archived_threads)
                .filter(|t| settled(t))
            {
                if let (Some(env), Some(at)) = (self.cache_env(&thread.id), expires_at(thread)) {
                    deadlines.insert((env.to_owned(), thread.id.clone()), at);
                }
            }
            for (env, shell) in self.linked.cache_shells() {
                for thread in shell
                    .threads
                    .iter()
                    .chain(&shell.archived_threads)
                    .filter(|t| settled(t))
                {
                    if let Some(at) = expires_at(thread) {
                        deadlines.insert((env.to_owned(), thread.id.clone()), at);
                    }
                }
            }
            deadlines
                .iter()
                .filter(|(_, at)| **at <= now)
                .map(|(key, _)| key.clone())
                .chain(
                    self.offline
                        .expired
                        .iter()
                        .filter(|key| {
                            self.offline.dirty.contains(*key)
                                && !held.contains(&(key.0.as_str(), key.1.as_str()))
                        })
                        .cloned(),
                )
                .collect()
        };
        deadlines.retain(|_, at| *at > now);
        self.offline.next_deadline = Some(deadlines.values().copied().min().unwrap_or(i64::MAX));
        self.offline.deadlines_dirty |= previous != deadlines;
        self.offline.deadlines = deadlines;
        let selection_expired = self
            .selected_cache_key()
            .is_some_and(|key| expired_keys.contains(&key) && !self.offline.expired.contains(&key));
        let previous_expired = std::mem::take(&mut self.offline.expired);
        for key in &expired_keys {
            self.forget_expired(key, !previous_expired.contains(key));
        }
        self.offline.expired = expired_keys;
        if selection_expired {
            self.sync_chat(cx);
        }
        self.schedule_offline_save(cx);
    }

    /// [`Self::expire_all`] for the threads `ids` alone, on every environment: what the sweep
    /// would decide for them, with every other deadline left as it is.
    fn expire_threads(&mut self, ids: &HashSet<String>, now: i64, cx: &mut Context<'_, Self>) {
        let environments = self.cache_environments();
        let selected = self.selected_cache_key();
        let mut selection_expired = false;
        for id in ids {
            for env in &environments {
                let key = (env.clone(), id.clone());
                let held = self.cache_shell(env, id).is_some();
                let listed_at = self
                    .cache_listed(env, id)
                    .filter(|t| t.deleted_at.is_some() || ShellState::is_settled(t))
                    .and_then(expires_at);
                let before = self.offline.deadlines.get(&key).copied();
                if held {
                    self.offline.deadlines.remove(&key);
                }
                if let Some(at) = listed_at {
                    self.offline.deadlines.insert(key.clone(), at);
                }
                let expired_now = self
                    .offline
                    .deadlines
                    .get(&key)
                    .is_some_and(|at| *at <= now);
                if expired_now {
                    self.offline.deadlines.remove(&key);
                } else if let Some(at) = self.offline.deadlines.get(&key) {
                    self.offline.next_deadline =
                        Some(self.offline.next_deadline.map_or(*at, |next| next.min(*at)));
                }
                self.offline.deadlines_dirty |= before != self.offline.deadlines.get(&key).copied();
                let stays = !held
                    && self.offline.expired.contains(&key)
                    && self.offline.dirty.contains(&key);
                if expired_now || stays {
                    let newly = !self.offline.expired.contains(&key);
                    selection_expired |= newly && selected.as_ref() == Some(&key);
                    self.forget_expired(&key, newly);
                    self.offline.expired.insert(key);
                } else {
                    self.offline.expired.remove(&key);
                }
            }
        }
        if selection_expired {
            self.sync_chat(cx);
        }
        self.schedule_offline_save(cx);
    }

    /// Whether the cache watches `id`'s stream on `env` ([`watch_worthy`]), as a full sweep of
    /// the watches decides it.
    fn should_watch(&self, env: &str, id: &str) -> bool {
        if self.server_url.as_deref() == Some(env) {
            self.cache_env(id) == Some(env) && self.shell.thread(id).is_some_and(watch_worthy)
        } else {
            self.linked.shell_for_cache(env).is_some_and(|shell| {
                shell
                    .threads
                    .iter()
                    .chain(&shell.archived_threads)
                    .find(|t| t.id == id)
                    .is_some_and(watch_worthy)
            })
        }
    }

    /// Brings the watched streams in line with the shell: subscribes the threads worth watching
    /// that changed (all of them on a sweep), and drops the rest. A watch survives reconnects of
    /// its connection (the client resubscribes it from its cursor); only a new connection for the
    /// environment needs a new subscription.
    fn reconcile_offline_in(&mut self, scope: &ShellScope, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() {
            return;
        }
        let check: Vec<ThreadKey> = match scope {
            ShellScope::All => {
                let mut desired = HashSet::new();
                let mut order = Vec::new();
                let primary = self
                    .shell
                    .threads
                    .iter()
                    .filter(|t| watch_worthy(t))
                    .filter_map(|t| Some((self.cache_env(&t.id)?.to_owned(), t.id.clone())));
                let linked = self.linked.cache_threads(watch_worthy);
                for pair in primary.chain(linked) {
                    if desired.insert(pair.clone()) {
                        order.push(pair);
                    }
                }
                self.offline.desired = desired;
                order
            }
            ShellScope::Threads(ids) => {
                let environments = self.cache_environments();
                let mut check = Vec::new();
                for id in ids {
                    for env in &environments {
                        let pair = (env.clone(), id.clone());
                        if self.should_watch(env, id) {
                            self.offline.desired.insert(pair.clone());
                            check.push(pair);
                        } else {
                            self.offline.desired.remove(&pair);
                        }
                    }
                }
                check
            }
            ShellScope::Nothing => Vec::new(),
        };
        for pair in check {
            self.queue_outline(&pair);
            let Some(connection) = self.cache_connection(&pair.0) else {
                continue;
            };
            if !self
                .offline
                .subscriptions
                .get(&pair)
                .is_some_and(|held| held.same_connection(&connection))
            {
                connection.refresh_thread(&pair.1);
                self.offline.subscriptions.insert(pair, connection);
            }
        }
        self.load_next_outline(cx);
        let desired = std::mem::take(&mut self.offline.desired);
        self.offline.commits.retain(|key, commit| {
            !matches!(commit, Commit::Prefix { .. }) || desired.contains(key)
        });
        self.offline
            .snapshots
            .retain(|key, _| desired.contains(key));
        self.offline
            .backfills
            .retain(|job| desired.contains(&job.key));
        let opened_env = self
            .subscribed_thread_id
            .as_deref()
            .and_then(|id| self.cache_env(id))
            .map(str::to_owned);
        let watched = self.offline.subscriptions.len();
        self.offline.subscriptions.retain(|pair, conn| {
            if desired.contains(pair) {
                return true;
            }
            if self.subscribed_thread_id.as_ref() != Some(&pair.1)
                || opened_env.as_ref() != Some(&pair.0)
            {
                conn.unsubscribe_thread(&pair.1);
            }
            false
        });
        self.offline.desired = desired;
        // A thread the cache stopped watching (settled, a finished subagent) keeps its timeline
        // only while it is open or recent (`app/residency.rs`).
        if self.offline.subscriptions.len() < watched {
            self.evict_cold_threads();
        }
    }
    pub(super) fn refresh_selected_outline(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(id) = self.layout.selected_thread_id.clone()
            && let Some(env) = self.cache_env(&id).map(str::to_owned)
        {
            self.queue_outline(&(env, id));
            self.load_next_outline(cx);
        }
    }

    fn cache_connection(&self, env: &str) -> Option<Connection> {
        if self.server_url.as_deref() == Some(env) {
            self.connection.clone()
        } else {
            self.linked_connection(env)
        }
    }

    fn queue_outline(&mut self, key: &ThreadKey) {
        if self.offline.dir.is_none() || !self.cache_environment_connected(&key.0) {
            return;
        }
        let Some(stamp) = self
            .cache_shell(&key.0, &key.1)
            .filter(|t| !expired(t))
            .map(|t| t.updated_at.clone())
        else {
            return;
        };
        if self.offline.outline_requested.get(key) != Some(&stamp) {
            self.offline.outline_requested.insert(key.clone(), stamp);
            if !self.offline.outline_queue.contains(key) {
                self.offline.outline_queue.push_back(key.clone());
            }
        }
    }

    fn load_next_outline(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.loading_outline.is_some() {
            return;
        }
        while let Some(key) = self.offline.outline_queue.pop_front() {
            let Some(stamp) = self.offline.outline_requested.get(&key).cloned() else {
                continue;
            };
            let Some(connection) = self.cache_connection(&key.0) else {
                continue;
            };
            self.offline.loading_outline = Some(key.clone());
            let epoch = self.offline.outline_epoch;
            let generation = self.connection_gen;
            cx.spawn(async move |this, cx| {
                let result = connection.fetch_thread_outline(&key.1).await;
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation || app.offline.outline_epoch != epoch {
                        return;
                    }
                    app.offline.loading_outline = None;
                    if app.offline.outline_requested.get(&key) == Some(&stamp)
                        && app.cache_shell(&key.0, &key.1).is_some_and(|t| !expired(t))
                    {
                        match result {
                            Ok(outline) => {
                                let markers: Vec<_> = outline
                                    .markers
                                    .into_iter()
                                    .enumerate()
                                    .map(|(index, m)| TocEntry {
                                        turn_number: index + 1,
                                        item_index: 0,
                                        entry_id: m.entry_id,
                                        preview: m.preview,
                                        assistant_preview: m.assistant_preview,
                                        is_agent_prompt: m.is_agent_prompt,
                                        has_checkpoint: m.has_checkpoint,
                                        has_error: m.has_error,
                                    })
                                    .collect();
                                if let Ok(raw) = serde_json::to_string(&markers) {
                                    app.offline.outline_writes.insert(key.clone(), raw);
                                }
                                app.offline
                                    .outlines
                                    .insert(key.clone(), Arc::new(ThreadOutline::new(markers)));
                                app.schedule_offline_save(cx);
                                if app.layout.selected_thread_id.as_ref() == Some(&key.1) {
                                    app.sync_chat(cx);
                                }
                            }
                            Err(err) => {
                                eprintln!("thread outline: {err}");
                                if app.offline.outline_requested.get(&key) == Some(&stamp) {
                                    app.offline.outline_requested.remove(&key);
                                }
                            }
                        }
                    }
                    app.load_next_outline(cx);
                });
            })
            .detach();
            break;
        }
    }

    fn fetch_prompt_window(
        &mut self,
        env: String,
        id: String,
        prompt: String,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection_for_thread(&id) else {
            return;
        };
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let result = connection.fetch_thread_window(&id, &prompt).await;
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation
                    || app.cache_env(&id) != Some(&env)
                    || app.layout.selected_thread_id.as_ref() != Some(&id)
                    || app.shell.find_thread(&id).is_none_or(expired)
                    || !app.chat.read(cx).awaiting_prompt(&prompt)
                {
                    return;
                }
                match result {
                    Ok(page) => {
                        let mut state = ThreadState::new(&id);
                        state.prepend_history_page(page);
                        app.chat.update(cx, |chat, cx| {
                            chat.show_prompt_window(&prompt, &state.entries, cx)
                        });
                    }
                    Err(err) => {
                        let message = if app.thread_connected(&id) {
                            format!("Could not load this message: {err}")
                        } else {
                            crate::chat::OFFLINE_PROMPT_NOTICE.to_owned()
                        };
                        app.chat
                            .update(cx, |chat, cx| chat.set_error(Some(message), cx));
                    }
                }
            });
        })
        .detach();
    }
    /// The writes due now. The shell snapshot is due at most every [`SHELL_SAVE_INTERVAL`], or
    /// right away with `flush`.
    fn pending_saves(&mut self, flush: bool) -> Vec<Save> {
        let mut writes: Vec<_> = self
            .offline
            .outline_writes
            .drain()
            .map(|((env, id), raw)| Save::Outline(env, id, raw))
            .collect();
        let now = Instant::now();
        let shell_due =
            self.offline.shell_dirty && (flush || self.offline.shell_save_wait(now).is_zero());
        // A shell that has not synced yet is not saved. The change waits for it.
        if shell_due && self.shell.synchronized {
            self.offline.shell_dirty = false;
        }
        if shell_due
            && self.shell.synchronized
            && let Some(env) = &self.server_url
            && let Some(path) = self.offline.path(env, None)
        {
            self.offline.shell_saved_at = Some(now);
            let mut primary = LinkedShellSnapshot::capture(env, env, &self.shell);
            let origins = self.linked.origins();
            primary
                .projects
                .retain(|p| !origins.is_linked_project(&p.id));
            primary.threads.retain(|t| !origins.is_linked_thread(&t.id));
            primary
                .archived_threads
                .retain(|t| !origins.is_linked_thread(&t.id));
            writes.push(Save::Shell(path, primary));
        }
        let chats = std::mem::take(&mut self.offline.dirty);
        let mut keys = std::mem::take(&mut self.offline.task_links_dirty);
        keys.extend(chats.iter().cloned());
        for (env, id) in keys {
            let key = (env.clone(), id.clone());
            if self.offline.expired.contains(&key)
                || self.cache_shell(&env, &id).is_some_and(expired)
            {
                self.offline.saved_tails.remove(&key);
                writes.push(Save::Remove(env, id));
            } else if let Some(state) = self.cache_state(&key)
                && state.sequence.is_some()
            {
                let key = (env, id);
                let snapshot = self.offline.snapshots.get(&key).map(Arc::downgrade);
                writes.push(Save::TaskLinks(
                    key.clone(),
                    state.task_links.clone(),
                    snapshot.clone(),
                ));
                if chats.contains(&key) {
                    let start = state.history_prefix_len();
                    // A snapshot or backfill replaces what is stored: write the whole tail.
                    let whole = self.offline.commits.contains_key(&key);
                    let plan = plan_chat(
                        &state.entries[start..],
                        self.offline.saved_tails.get(&key),
                        whole,
                    );
                    let commit = self.offline.commits.remove(&key);
                    if let Some((rows, tail)) = plan {
                        writes.push(Save::Chat {
                            key,
                            rows,
                            commit,
                            snapshot,
                            tail,
                        });
                    }
                }
            }
        }
        if std::mem::take(&mut self.offline.deadlines_dirty) {
            writes.push(Save::Deadlines(
                self.offline
                    .deadlines
                    .iter()
                    .map(|(key, at)| (key.clone(), *at))
                    .collect(),
            ));
        }
        writes
    }
    /// Test helper: no cache write is pending or running.
    #[cfg(test)]
    pub(super) fn offline_writes_idle_for_test(&self) -> bool {
        !self.offline.saving && self.offline.dirty.is_empty() && self.offline.commits.is_empty()
    }
    /// Test helper: takes every pending cache write, as a flush would, without writing it.
    #[cfg(test)]
    pub(super) fn pending_saves_for_test(&mut self) -> usize {
        self.pending_saves(true).len()
    }
    /// Comes back to write the dirty shell once [`SHELL_SAVE_INTERVAL`] has passed.
    fn arm_shell_save(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() || !self.offline.shell_dirty || self.offline.shell_save_armed
        {
            return;
        }
        let wait = self.offline.shell_save_wait(Instant::now());
        if wait.is_zero() {
            return;
        }
        self.offline.shell_save_armed = true;
        let lifetime = Arc::downgrade(&self.offline.lifetime);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            let _ = this.update(cx, |app, cx| {
                // A server switch replaced the cache: its own timer, if any, is armed.
                if lifetime.strong_count() == 0 {
                    return;
                }
                app.offline.shell_save_armed = false;
                app.schedule_offline_save(cx);
            });
        })
        .detach();
    }

    /// The writes a quit runs: the offline cache's, then the panel layout's (the write in flight
    /// finishes, and the latest layout follows if it differs).
    ///
    /// GPUI gives every quit hook 200 ms in total. The two run side by side, so a slow panel
    /// write cannot keep the shell from being written: the offline writes have no await point
    /// and finish on the first poll.
    pub(super) fn quit_saves(
        &mut self,
        cx: &mut Context<'_, Self>,
    ) -> impl std::future::Future<Output = ()> + use<> {
        let offline = self.offline_on_quit();
        let linked = self.linked_on_quit();
        let panels = self.thread_panels_on_quit(cx);
        async move {
            futures::future::join3(offline, linked, panels).await;
        }
    }

    /// Writes what the quit would otherwise lose: every pending write, the shell included.
    pub(super) fn offline_on_quit(&mut self) -> impl std::future::Future<Output = ()> + use<> {
        let dir = self.offline.dir.clone();
        let db = self.offline.db.clone();
        let writes = if dir.is_some() {
            self.pending_saves(true)
        } else {
            Vec::new()
        };
        async move {
            let Some(dir) = dir else {
                return;
            };
            // Waits for a save in flight, so this one lands last.
            let _guard = CACHE_WRITER
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for value in writes {
                if let Err(e) = save(&dir, db.as_ref(), value) {
                    eprintln!("offline thread cache: {e}");
                }
            }
        }
    }

    pub(super) fn schedule_offline_save(&mut self, cx: &mut Context<'_, Self>) {
        self.arm_shell_save(cx);
        let shell_due =
            self.offline.shell_dirty && self.offline.shell_save_wait(Instant::now()).is_zero();
        if self.offline.dir.is_none()
            || self.offline.saving
            || (!shell_due
                && !self.offline.deadlines_dirty
                && self.offline.dirty.is_empty()
                && self.offline.task_links_dirty.is_empty()
                && self.offline.outline_writes.is_empty())
        {
            return;
        }
        self.offline.saving = true;
        let lifetime = Arc::downgrade(&self.offline.lifetime);
        let generation = self.connection_gen;
        let Some(dir) = self.offline.dir.clone() else {
            return;
        };
        let db = self.offline.db.clone();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(300))
                    .await;
                let Ok(writes) = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return Vec::new();
                    }
                    let writes = app.pending_saves(false);
                    if writes.is_empty() {
                        app.offline.saving = false;
                        app.arm_shell_save(cx);
                    }
                    writes
                }) else {
                    break;
                };
                if writes.is_empty() {
                    break;
                }
                let dir = dir.clone();
                let db = db.clone();
                let refresh = writes
                    .iter()
                    .filter_map(|value| match value {
                        Save::Chat {
                            key,
                            commit: Some(Commit::Prefix { .. }),
                            ..
                        } => Some(key.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let lifetime = lifetime.clone();
                // Which tail each chat's rows now match, or none when its write did not land.
                let stored = cx
                    .background_executor()
                    .spawn(async move {
                        // A previous connection generation may still be draining its last write.
                        let _guard = CACHE_WRITER
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if lifetime.strong_count() == 0 {
                            return Vec::new();
                        }
                        run_saves(&dir, db.as_ref(), writes)
                    })
                    .await;
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen == generation {
                        // Only a confirmed write moves the baseline: a skipped or failed one
                        // leaves the next save to write the whole tail again.
                        app.offline.saved(stored);
                        for (env, id) in refresh {
                            if app.cache_env(&id) == Some(&env)
                                && app.layout.selected_thread_id.as_ref() == Some(&id)
                            {
                                app.fill_warm_preview(&id);
                                app.sync_chat(cx);
                            }
                        }
                        app.start_backfill(cx);
                    }
                });
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell_writes(writes: &[Save]) -> usize {
        writes
            .iter()
            .filter(|write| matches!(write, Save::Shell(..)))
            .count()
    }

    /// A busy shell is written at most every 30 seconds, and the quit writes the latest one.
    #[gpui_kit::test]
    fn the_shell_snapshot_is_written_at_most_every_thirty_seconds(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use crate::ui_tests::{kitchen_sink_shell, mount_app};

        let dir = tempfile::tempdir().expect("cache directory");
        let (_, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.offline.dir = Some(dir.path().to_owned());
                app.server_url = Some("http://test.local".into());
                let mut shell = kitchen_sink_shell();
                shell.synchronized = true;
                app.set_shell(shell, cx);

                app.offline.shell_changed();
                assert_eq!(shell_writes(&app.pending_saves(false)), 1, "first change");
                app.offline.shell_changed();
                assert_eq!(
                    shell_writes(&app.pending_saves(false)),
                    0,
                    "a change seconds later waits"
                );
                assert!(app.offline.shell_dirty, "the change is kept for later");
                app.offline.shell_saved_at =
                    Instant::now().checked_sub(SHELL_SAVE_INTERVAL + Duration::from_secs(1));
                assert_eq!(
                    shell_writes(&app.pending_saves(false)),
                    1,
                    "written once the interval passed"
                );
                app.offline.shell_changed();
                let writes = app.pending_saves(true);
                assert_eq!(shell_writes(&writes), 1, "the quit writes it at once");
                for write in writes {
                    save(dir.path(), None, write).expect("write the shell");
                }
            });
        });
        let written = std::fs::read(dir.path().join(key("http://test.local")).join("shell"))
            .expect("shell file");
        let snapshot = LinkedShellSnapshot::from_json(&written).expect("valid snapshot JSON");
        assert_eq!(
            snapshot.threads.len(),
            kitchen_sink_shell().threads.len(),
            "the buffered write holds the whole shell"
        );
    }

    /// An item that only moves the sequence leaves the saved shell as it is, and a shell that
    /// has not synced waits for it instead of losing the change.
    #[gpui_kit::test]
    fn the_shell_is_saved_again_only_when_a_thread_or_project_changed(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use crate::ui_tests::{kitchen_sink_shell, mount_app};

        let dir = tempfile::tempdir().expect("cache directory");
        let (_, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.offline.dir = Some(dir.path().to_owned());
                app.server_url = Some("http://test.local".into());
                let mut shell = kitchen_sink_shell();
                shell.synchronized = true;
                let thread = shell.threads[0].clone();
                app.set_shell(shell, cx);
                app.offline.shell_dirty = false;

                let item = |value: serde_json::Value| {
                    conn_client::ClientEvent::Shell(
                        conn_contract::from_json(value).expect("shell item"),
                    )
                };
                app.apply_event_for_test(
                    item(serde_json::json!({
                        "kind": "project.removed", "sequence": 90_001, "projectId": "nobody-has-it"
                    })),
                    cx,
                );
                app.apply_event_for_test(
                    item(serde_json::json!({ "kind": "synchronized", "sequence": 90_002 })),
                    cx,
                );
                assert!(
                    !app.offline.shell_dirty,
                    "only the sequence moved: nothing to write"
                );
                app.apply_event_for_test(
                    item(serde_json::json!({
                        "kind": "thread.updated", "sequence": 90_003, "location": "active",
                        "thread": serde_json::to_value(&thread).expect("thread JSON")
                    })),
                    cx,
                );
                assert!(app.offline.shell_dirty, "a thread changed");

                app.shell.synchronized = false;
                assert_eq!(shell_writes(&app.pending_saves(false)), 0, "not synced yet");
                assert!(app.offline.shell_dirty, "the change waits for the sync");
                app.shell.synchronized = true;
                assert_eq!(shell_writes(&app.pending_saves(false)), 1);
                assert!(!app.offline.shell_dirty);
            });
        });
    }

    fn messages(range: std::ops::Range<usize>) -> Vec<TimelineEntry> {
        range
            .flat_map(|n| {
                [
                    TimelineEntry::User {
                        id: format!("u{n}"),
                        text: format!("question {n}"),
                        created_by_agent: false,
                        sender: None,
                        created_at: None,
                        attachments: Vec::new(),
                        is_steer: false,
                        review_comments: Vec::new(),
                        run_id: None,
                    },
                    TimelineEntry::Assistant {
                        id: format!("a{n}"),
                        markdown: format!("answer {n}"),
                        streaming: false,
                        created_at: None,
                        run_id: None,
                        status: conn_state::ItemStatus::Completed,
                    },
                ]
            })
            .collect()
    }

    fn chat_rows(writes: &[Save]) -> Vec<(bool, usize)> {
        writes
            .iter()
            .filter_map(|write| match write {
                Save::Chat { rows, .. } => Some((matches!(rows, ChatRows::Tail(_)), rows.len())),
                _ => None,
            })
            .collect()
    }

    /// A thread that streams writes the rows that changed, and the cache reopens as it would
    /// had every flush written the whole tail.
    #[gpui_kit::test]
    fn a_streaming_thread_writes_only_its_changed_rows_and_reopens_the_same(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        use crate::ui_tests::mount_app;

        let dir = tempfile::tempdir().expect("cache directory");
        let db = crate::live::RT
            .block_on(MessageCache::open(&dir.path().join("messages.sqlite3")))
            .expect("cache");
        let whole = crate::live::RT
            .block_on(MessageCache::open(&dir.path().join("whole.sqlite3")))
            .expect("a cache that is written whole");
        let env = "http://test.local";
        let (_, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.offline.dir = Some(dir.path().to_owned());
                app.offline.db = Some(db.clone());
                app.server_url = Some(env.into());
                app.offline.owners.insert("t".into(), env.into());
                let mut state = ThreadState::new("t");
                state.sequence = Some(1);
                state.entries = messages(0..150);
                app.threads.insert("t".into(), state);
                let flush = |app: &mut ConnApp, expect: &[(bool, usize)]| {
                    app.offline.changed(env, "t");
                    let writes = app.pending_saves(false);
                    assert_eq!(chat_rows(&writes), expect);
                    let stored = run_saves(dir.path(), Some(&db), writes);
                    app.offline.saved(stored);
                    let tail = capture_chat(&app.threads["t"].entries);
                    merge_chat(&whole, env, "t", &tail).expect("the whole tail");
                    let one = crate::live::RT.block_on(db.recent(env, "t")).expect("rows");
                    let all = crate::live::RT
                        .block_on(whole.recent(env, "t"))
                        .expect("rows");
                    assert_eq!(
                        one, all,
                        "the cache reopens as a whole-tail write leaves it"
                    );
                };
                // The first write has nothing to compare with.
                flush(app, &[(true, 300)]);
                // A flush with nothing changed writes no row.
                flush(app, &[]);
                // Tokens arrive: one row changes.
                let entries = &mut app.threads.get_mut("t").expect("thread").entries;
                if let Some(TimelineEntry::Assistant { markdown, .. }) = entries.last_mut() {
                    markdown.push_str(" and more");
                }
                flush(app, &[(false, 1)]);
                // A new prompt and the start of its answer: two rows are new.
                app.threads
                    .get_mut("t")
                    .expect("thread")
                    .entries
                    .extend(messages(150..151));
                flush(app, &[(false, 2)]);
                // A row goes back to an older state: the rows moved, so the tail is written whole.
                app.threads.get_mut("t").expect("thread").entries.remove(10);
                flush(app, &[(true, 301)]);
                // A snapshot starts over from the whole tail.
                app.offline_snapshot(env.to_owned(), "t");
                flush(app, &[(true, 301)]);
                cx.notify();
            });
        });
    }

    /// A write that did not land leaves the baseline alone, so the next save writes the whole
    /// tail again instead of trusting rows that are not stored.
    #[test]
    fn a_failed_or_stale_chat_write_moves_no_baseline() {
        let dir = tempfile::tempdir().expect("cache directory");
        let db = crate::live::RT
            .block_on(MessageCache::open(&dir.path().join("messages.sqlite3")))
            .expect("cache");
        let entries = messages(0..3);
        let (rows, tail) = plan_chat(&entries, None, false).expect("a first write");
        let key = ("env".to_owned(), "t".to_owned());
        let current = Arc::new(1);
        let write = |snapshot: Weak<u64>, rows, tail| Save::Chat {
            key: key.clone(),
            rows,
            commit: None,
            snapshot: Some(snapshot),
            tail,
        };
        let stale = Arc::new(2);
        let weak = Arc::downgrade(&stale);
        drop(stale);
        let outcome = run_saves(dir.path(), Some(&db), vec![write(weak, rows, tail)]);
        assert!(
            matches!(outcome.as_slice(), [(_, None)]),
            "skipped as stale"
        );
        let (rows, tail) = plan_chat(&entries, None, false).expect("a first write");
        let outcome = run_saves(
            dir.path(),
            Some(&db),
            vec![write(Arc::downgrade(&current), rows, tail)],
        );
        assert!(matches!(outcome.as_slice(), [(_, Some(_))]), "written");
        let Some((_, Some(marks))) = outcome.into_iter().next() else {
            unreachable!("matched above")
        };
        assert!(
            plan_chat(&entries, Some(&marks), false).is_none(),
            "stored rows are current"
        );
    }

    /// A panel write still running at quit cannot keep the shell from being written: GPUI stops
    /// polling the quit hooks after 200 ms.
    #[gpui_kit::test]
    fn a_slow_panel_write_does_not_hold_up_the_shell_on_quit(cx: &mut gpui_kit::TestAppContext) {
        use futures::FutureExt as _;

        use crate::ui_tests::{kitchen_sink_shell, mount_app};

        let dir = tempfile::tempdir().expect("cache directory");
        let (_, app) = mount_app(cx);
        let quit = cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.offline.dir = Some(dir.path().to_owned());
                app.server_url = Some("http://test.local".into());
                let mut shell = kitchen_sink_shell();
                shell.synchronized = true;
                app.set_shell(shell, cx);
                app.offline.shell_changed();
                app.stall_panel_write_for_test(dir.path().join("thread-panels.json"), cx);
                app.quit_saves(cx)
            })
        });
        // The one poll GPUI may get to before its deadline.
        assert!(
            quit.now_or_never().is_none(),
            "the panel write is still running"
        );
        let written = std::fs::read(dir.path().join(key("http://test.local")).join("shell"))
            .expect("the shell was written");
        let snapshot = LinkedShellSnapshot::from_json(&written).expect("valid snapshot JSON");
        assert_eq!(snapshot.threads.len(), kitchen_sink_shell().threads.len());
    }

    /// Items of a background cache stream do not redraw the window; the open thread's do.
    #[gpui_kit::test]
    fn only_items_of_a_thread_on_screen_redraw(cx: &mut gpui_kit::TestAppContext) {
        use crate::ui_tests::{kitchen_sink_shell, mount_app};

        let (_, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.set_shell(kitchen_sink_shell(), cx);
                app.select_thread("thread-selected", cx);
                let item = |thread_id: &str| conn_client::ClientEvent::Thread {
                    thread_id: thread_id.to_owned(),
                    item: conn_contract::from_json(serde_json::json!({ "kind": "synchronized" }))
                        .expect("synchronized item"),
                };
                assert!(app.event_shows(&item("thread-selected")));
                assert!(!app.event_shows(&item("thread-in-the-background")));
                assert!(app.event_shows(&conn_client::ClientEvent::Status(
                    conn_client::ConnectionStatus::Connected
                )));
            });
        });
    }

    #[gpui_kit::test]
    fn cached_task_opens_from_details_before_reconnect(cx: &mut gpui_kit::TestAppContext) {
        use crate::ui_tests::{
            click_row,
            details_tasks::{LINK, THREAD, snapshot},
            kitchen_sink_shell, mount_app,
        };
        use gpui_kit::MouseButton;

        let dir = tempfile::tempdir().expect("cache directory");
        let path = dir.path().join("messages.sqlite3");
        let db = crate::live::RT
            .block_on(MessageCache::open(&path))
            .expect("cache");
        let env = "http://test.local";
        let (_, online) = mount_app(cx);
        cx.update(|cx| {
            online.update(cx, |app, cx| {
                app.offline.dir = Some(dir.path().to_owned());
                app.offline.db = Some(db.clone());
                app.server_url = Some(env.into());
                app.set_shell(kitchen_sink_shell(), cx);
                for view in [snapshot(None, true), snapshot(Some("recent"), false)] {
                    app.apply_cache_stream(
                        env,
                        THREAD,
                        conn_contract::from_json(view).expect("snapshot"),
                    );
                }
                for write in app.pending_saves(true) {
                    save(dir.path(), Some(&db), write).expect("save observed links");
                }
            })
        });

        let (window, offline) = mount_app(cx);
        cx.update(|cx| {
            offline.update(cx, |app, cx| {
                app.offline.dir = Some(dir.path().to_owned());
                app.offline.db = Some(
                    crate::live::RT
                        .block_on(MessageCache::open(&path))
                        .expect("reopen cache"),
                );
                app.server_url = Some(env.into());
                app.set_shell(kitchen_sink_shell(), cx);
                app.select_thread(THREAD, cx);
                let state = app.selected_timeline().expect("cached conversation");
                assert!(state.sequence.is_none());
                assert!(
                    !state
                        .entries
                        .iter()
                        .any(|e| matches!(e, TimelineEntry::OrbitTask { .. }))
                );
                assert_eq!(state.task_links.next_page(), Some(("recent", "recent")));
            })
        });
        click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
        click_row(cx, window, LINK, MouseButton::Left);
        cx.read(|cx| {
            let app = offline.read(cx);
            assert!(app.layout().right_panel_open);
            assert_eq!(
                app.layout().right_panel_tab,
                conn_state::RightPanelTab::Tasks
            );
            assert_eq!(
                app.right_panel_for_test()
                    .read(cx)
                    .selected_task_for_test(cx),
                Some(482)
            );
        });
    }

    #[test]
    fn cache_retains_latest_thousand_messages_and_opens_latest_hundred_in_order() {
        let dir = tempfile::tempdir().expect("test directory");
        let path = dir.path().join("thread");
        let mut state = ThreadState::new("t");
        for index in 0..1050 {
            state.entries.push(TimelineEntry::Assistant {
                id: index.to_string(),
                markdown: format!("reply {index}"),
                streaming: false,
                created_at: None,
                run_id: None,
                status: conn_state::ItemStatus::Completed,
            });
            state.entries.push(TimelineEntry::Notice {
                id: format!("notice-{index}"),
                text: "tool status".to_owned(),
                level: conn_state::NoticeLevel::Info,
            });
        }
        let messages = capture_chat(&state.entries);
        assert_eq!(messages.len(), 1000);
        assert_eq!(messages[0].id(), "50");
        let db = crate::live::RT
            .block_on(MessageCache::open(&path))
            .expect("open SQLite");
        let legacy = dir.path().join("legacy");
        std::fs::write(
            &legacy,
            serde_json::to_vec(&messages).expect("encode legacy messages"),
        )
        .expect("legacy file");
        import_legacy(&db, "env", "t", &legacy).expect("import old cache into SQLite");
        assert!(!legacy.exists());
        merge_chat(&db, "env", "t", &messages[998..]).expect("bounded update");
        let reopened = read_chat(&db, "env", "t").expect("offline chat");
        assert_eq!(reopened.entries.len(), 100);
        assert_eq!(reopened.entries[0].id(), "950");
        assert_eq!(reopened.entries[99].id(), "1049");
        assert_eq!(reopened.sequence, None);
        let generation = Arc::new(1);
        let stale = Save::Chat {
            key: ("env".to_owned(), "t".to_owned()),
            rows: ChatRows::Tail(Vec::new()),
            commit: Some(Commit::Replace),
            snapshot: Some(Arc::downgrade(&generation)),
            tail: TailMarks::default(),
        };
        drop(generation);
        save(dir.path(), Some(&db), stale).expect("discard stale write");
        assert_eq!(
            read_chat(&db, "env", "t")
                .expect("preserved after reset")
                .entries
                .len(),
            100
        );
        crate::live::RT
            .block_on(db.remove("env", "t"))
            .expect("expire chat");
        assert!(
            read_chat(&db, "env", "t")
                .expect("read expired chat")
                .entries
                .is_empty()
        );
    }
}
