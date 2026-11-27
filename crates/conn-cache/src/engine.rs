//! The one thread engine both native apps use. Per environment it owns the device rows (through
//! one database task), the kept set, catch-up, and the threads held in memory.
//!
//! - One event path: [`Engine::handle`] reduces a thread held in memory and always queues the
//!   change for the database task.
//! - The database task commits everything queued in one transaction, then moves each thread's
//!   resume cursor ([`Connection::set_thread_cursor`]); a cursor never runs ahead of its rows.
//! - Opening a thread reads its newest window from the device through the same task, after the
//!   writes queued before it, while later stream items wait in a buffer for the window.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use conn_client::{ClientError, Connection};
use conn_contract::{OrchestrationV2ThreadStreamItem as Item, from_json};
use conn_state::{ShellState, ThreadActivity, ThreadState, parse_iso8601_epoch_ms};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};

use crate::db::{self, ThreadIndex, ThreadWrite, Window};
use crate::rows::{self, Change, OWN};

/// The two settings.
#[derive(Clone, Copy, Debug)]
pub struct Settings {
    /// Threads kept in memory after they close; `None` keeps every kept thread.
    pub threads_in_memory: Option<usize>,
    /// Threads updated or opened this recently stay on the device.
    pub keep_window_ms: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            threads_in_memory: Some(3),
            keep_window_ms: 48 * 60 * 60 * 1000,
        }
    }
}

/// Image bytes on the device, by environment, thread and version.
#[derive(Clone, Debug)]
pub struct Images {
    pool: SqlitePool,
    env: String,
}

impl Images {
    /// # Errors
    /// Returns the database read error.
    pub async fn get(&self, thread: &str, version: &str) -> Result<Option<Vec<u8>>, sqlx::Error> {
        db::image(&self.pool, &self.env, thread, version).await
    }

    /// # Errors
    /// Returns the database write error.
    pub async fn save(&self, thread: &str, version: &str, bytes: &[u8]) -> Result<(), sqlx::Error> {
        db::save_image(&self.pool, &self.env, thread, version, bytes).await
    }

    /// # Errors
    /// Returns the database write error.
    pub async fn forget(&self, thread: &str, version: &str) -> Result<(), sqlx::Error> {
        db::forget_image(&self.pool, &self.env, thread, version).await
    }
}

enum Job {
    Write(String, ThreadWrite),
    Read {
        thread: String,
        before: Option<f64>,
        reply: oneshot::Sender<Option<Window>>,
    },
}

struct Held {
    state: ThreadState,
    /// The lowest timeline place in memory; rows below it stay on the device.
    floor: Option<f64>,
    more_local: bool,
    older: Option<String>,
}

/// A window on its way from the device, for [`Engine::finish_open`] or [`Engine::finish_older`].
pub type Pending = oneshot::Receiver<Option<Window>>;

/// One environment's threads.
pub struct Engine {
    env: String,
    connection: Connection,
    jobs: mpsc::UnboundedSender<Job>,
    pool: SqlitePool,
    settings: Settings,
    index: HashMap<String, ThreadIndex>,
    held: HashMap<String, Held>,
    /// Stream items for threads whose window is being read, applied once it arrives.
    loading: HashMap<String, Vec<Item>>,
    open: Vec<String>,
    /// Closed threads still in memory, newest first.
    recent: VecDeque<String>,
    /// Subscribed threads and their catch-up rank.
    subscribed: HashMap<String, u32>,
    /// Threads whose stream sent something this client cannot read: their cursor stays put.
    stale: HashSet<String>,
    older_in_flight: HashSet<String>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("env", &self.env)
            .field("held", &self.held.len())
            .field("subscribed", &self.subscribed.len())
            .finish_non_exhaustive()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Engine {
    /// Opens the device database at `path` for environment `env` and starts its task on the
    /// current Tokio runtime.
    ///
    /// # Errors
    /// Returns the filesystem or database error.
    pub async fn open(
        path: &Path,
        env: &str,
        connection: Connection,
        settings: Settings,
    ) -> Result<Self, sqlx::Error> {
        let pool = db::open(path).await?;
        let index = db::read_index(&pool, env).await?;
        let (jobs, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(pool.clone(), env.to_owned(), connection.clone(), rx));
        Ok(Self {
            env: env.to_owned(),
            connection,
            jobs,
            pool,
            settings,
            index,
            held: HashMap::new(),
            loading: HashMap::new(),
            open: vec![],
            recent: VecDeque::new(),
            subscribed: HashMap::new(),
            stale: HashSet::new(),
            older_in_flight: HashSet::new(),
        })
    }

    #[must_use]
    pub fn images(&self) -> Images {
        Images {
            pool: self.pool.clone(),
            env: self.env.clone(),
        }
    }

    #[must_use]
    pub fn environment(&self) -> &str {
        &self.env
    }

    pub fn set_settings(&mut self, settings: Settings) {
        self.settings = settings;
        self.evict();
    }

    /// The thread as the screen draws it, when it is in memory.
    #[must_use]
    pub fn thread(&self, id: &str) -> Option<&ThreadState> {
        self.held.get(id).map(|held| &held.state)
    }

    pub fn thread_mut(&mut self, id: &str) -> Option<&mut ThreadState> {
        self.held.get_mut(id).map(|held| &mut held.state)
    }

    /// Threads in memory.
    pub fn threads(&self) -> impl Iterator<Item = (&String, &ThreadState)> {
        self.held.iter().map(|(id, held)| (id, &held.state))
    }

    /// Whether the device holds rows for the thread.
    #[must_use]
    pub fn stored(&self, id: &str) -> bool {
        self.index.get(id).is_some_and(|ix| ix.cursor.is_some())
    }

    #[must_use]
    pub fn is_loading(&self, id: &str) -> bool {
        self.loading.contains_key(id)
    }

    fn write(&self, thread: &str, write: ThreadWrite) {
        let _ = self.jobs.send(Job::Write(thread.to_owned(), write));
    }

    /// The one event path. Returns whether the thread in memory changed.
    pub fn handle(&mut self, thread: &str, item: Item) -> bool {
        let mut write = ThreadWrite::default();
        let mut forget = false;
        let mut snapshot_floor: Option<f64> = None;
        match &item {
            Item::Synchronized(_) => {}
            Item::Snapshot(snapshot) => {
                let projection = serde_json::to_value(&snapshot.projection).unwrap_or(Value::Null);
                write.reset = true;
                for row in rows::snapshot_rows(thread, &projection) {
                    snapshot_floor = match (snapshot_floor, row.ord) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                    write.put(row);
                }
                write.record = Some(projection["thread"].clone());
                write.seq = Some(snapshot.snapshot_sequence);
                write.older = Some(snapshot.history_cursor.clone().flatten());
            }
            Item::Event(event) => {
                let value = serde_json::to_value(&event.event).unwrap_or(Value::Null);
                write.seq = Some(event.sequence);
                match rows::change_of(&value) {
                    Change::Row(row) => write.put(row),
                    Change::Delete { kind, id } => {
                        write.rows.insert((kind.to_owned(), id), None);
                    }
                    Change::Record(record) => write.record = Some(record),
                    Change::RecordFields(fields) => write.record_fields = Some(fields),
                    Change::ThreadDeleted => forget = true,
                    Change::Nothing => {}
                }
            }
            Item::Event2(event) => write.seq = Some(event.sequence),
        }
        if forget {
            self.forget(thread);
        } else if !matches!(item, Item::Synchronized(_)) {
            if self.stale.contains(thread) {
                write.seq = None;
            }
            let entry = self.index.entry(thread.to_owned()).or_default();
            if let Some(record) = &write.record {
                entry.record = Some(record.clone());
            }
            if write.reset {
                entry.cursor = write.seq;
            }
            self.write(thread, write);
        }
        if let Some(buffer) = self.loading.get_mut(thread) {
            buffer.push(item);
            return false;
        }
        let Some(held) = self.held.get_mut(thread) else {
            return false;
        };
        if let Item::Snapshot(snapshot) = &item {
            held.floor = snapshot_floor;
            held.more_local = false;
            held.older = snapshot.history_cursor.clone().flatten();
        }
        // An update of a row below the window stays on the device; drawing it at the end
        // would put an old row under the newest.
        if let Item::Event(event) = &item
            && let Some(floor) = held.floor
            && let Ok(value) = serde_json::to_value(&event.event)
            && let Change::Row(row) = rows::change_of(&value)
            && row.kind == OWN
            && row.ord.is_some_and(|ord| ord < floor)
            && !held.state.entries.iter().any(|entry| entry.id() == row.id)
        {
            return false;
        }
        held.state.apply(item)
    }

    /// The stream sent an item this client cannot read: keep the thread's cursor where it is.
    pub fn mark_stale(&mut self, thread: &str) {
        self.stale.insert(thread.to_owned());
    }

    /// Opens a thread. `None` when it is in memory already; otherwise its window is on its
    /// way from the device: pass it to [`Self::finish_open`].
    pub fn open_thread(&mut self, id: &str) -> Option<Pending> {
        if !self.open.iter().any(|open| open == id) {
            self.open.push(id.to_owned());
        }
        self.recent.retain(|recent| recent != id);
        self.write(
            id,
            ThreadWrite {
                opened_at: Some(now_ms()),
                ..ThreadWrite::default()
            },
        );
        if let Some(ix) = self.index.get_mut(id) {
            ix.opened_at = now_ms();
        }
        // The open thread catches up first.
        let after = self.index.get(id).and_then(|ix| ix.cursor);
        self.connection.subscribe_thread_from(id, after, 0);
        self.subscribed.insert(id.to_owned(), 0);
        if self.held.contains_key(id) || self.loading.contains_key(id) {
            return None;
        }
        self.loading.insert(id.to_owned(), vec![]);
        Some(self.read(id, None))
    }

    fn read(&self, id: &str, before: Option<f64>) -> Pending {
        let (reply, rx) = oneshot::channel();
        let _ = self.jobs.send(Job::Read {
            thread: id.to_owned(),
            before,
            reply,
        });
        rx
    }

    /// The window [`Self::open_thread`] asked for. A thread the device does not hold yet waits
    /// for its first snapshot. Returns whether the thread is now in memory.
    pub fn finish_open(&mut self, id: &str, window: Option<Window>) -> bool {
        let Some(buffer) = self.loading.remove(id) else {
            return self.held.contains_key(id);
        };
        let mut held = match window {
            Some(window) => held_from(id, window),
            None => Held {
                state: ThreadState::new(id),
                floor: None,
                more_local: false,
                older: None,
            },
        };
        for item in buffer {
            if let Item::Snapshot(snapshot) = &item {
                let projection = serde_json::to_value(&snapshot.projection).unwrap_or(Value::Null);
                held.floor = rows::snapshot_rows(id, &projection)
                    .iter()
                    .filter_map(|row| row.ord)
                    .reduce(f64::min);
                held.more_local = false;
                held.older = snapshot.history_cursor.clone().flatten();
            }
            held.state.apply(item);
        }
        self.held.insert(id.to_owned(), held);
        true
    }

    /// Closes a thread. It stays in memory among the last few closed, then leaves.
    pub fn close_thread(&mut self, id: &str) {
        self.open.retain(|open| open != id);
        if let Some(rank) = self.subscribed.get_mut(id) {
            *rank = rank.saturating_add(1);
        }
        if self.held.contains_key(id) {
            self.recent.retain(|recent| recent != id);
            self.recent.push_front(id.to_owned());
        }
        self.loading.remove(id);
        self.evict();
    }

    fn evict(&mut self) {
        let Some(limit) = self.settings.threads_in_memory else {
            return;
        };
        while self.recent.len() > limit {
            if let Some(id) = self.recent.pop_back() {
                self.held.remove(&id);
            }
        }
    }

    /// Asks for older rows of an open thread: from the device, else from the server through
    /// the device. `None` when nothing older exists or a read is on its way.
    pub fn older(&mut self, id: &str) -> Option<Pending> {
        let held = self.held.get_mut(id)?;
        if !(held.more_local || held.older.is_some()) || !self.older_in_flight.insert(id.to_owned())
        {
            return None;
        }
        held.state.loading_earlier = true;
        let floor = held.floor;
        Some(self.read(id, Some(floor.unwrap_or(f64::MAX))))
    }

    /// The window [`Self::older`] asked for. Returns how many rows were added on top.
    pub fn finish_older(&mut self, id: &str, window: Option<Window>) -> usize {
        self.older_in_flight.remove(id);
        let Some(held) = self.held.get_mut(id) else {
            return 0;
        };
        let Some(window) = window else {
            held.state.loading_earlier = false;
            return 0;
        };
        if let Some(first) = window.timeline.first().and_then(|row| row.ord) {
            held.floor = Some(held.floor.map_or(first, |floor| floor.min(first)));
        }
        held.more_local = window.more_local;
        held.older = window.older.clone();
        let items: Vec<Value> = window
            .timeline
            .iter()
            .enumerate()
            .map(|(position, row)| rows::visible_row(id, position, row))
            .collect();
        let page = json!({
            "snapshotSequence": window.cursor.unwrap_or(0),
            "items": items,
            "nextCursor": window.older,
            "hasMoreHistory": window.more_local || window.older.is_some(),
            "subagents": window.control.iter().map(|row| row.body.clone()).collect::<Vec<_>>(),
        });
        match from_json(page) {
            Ok(page) => held.state.prepend_history_page(page),
            Err(_) => {
                held.state.loading_earlier = false;
                0
            }
        }
    }

    /// Keeps the device in step with the shell: every unsettled thread and every thread
    /// updated or opened within the keep window stays subscribed and stored, the open thread
    /// first, then those that need the user, working threads, then the newest. A thread that
    /// leaves the set is deleted from the device. Call it with a synchronized shell only: a
    /// thread missing from a shell is judged by its stored record, never by its absence.
    pub fn update_kept(&mut self, shell: &ShellState) {
        let now = now_ms();
        let since = now - self.settings.keep_window_ms;
        let mut want: HashMap<String, (u8, i64)> = HashMap::new();
        for thread in shell.top_level_active_threads() {
            let tier = match shell.activity(&thread.id) {
                ThreadActivity::NeedsAttention => 1,
                ThreadActivity::Working => 2,
                ThreadActivity::Idle | ThreadActivity::Failed => 3,
            };
            let updated = parse_iso8601_epoch_ms(&thread.updated_at).unwrap_or(0);
            want.insert(thread.id.clone(), (tier, updated));
        }
        for thread in shell.all_settled_threads() {
            let updated = parse_iso8601_epoch_ms(&thread.updated_at).unwrap_or(0);
            if updated >= since {
                want.entry(thread.id.clone()).or_insert((3, updated));
            }
        }
        for (id, ix) in &self.index {
            let shown = shell.find_thread(id);
            if shown.is_some_and(|t| t.deleted_at.is_some()) {
                continue;
            }
            let unsettled_record = shown.is_none()
                && ix
                    .record
                    .as_ref()
                    .is_some_and(|r| r["settledAt"].is_null() && r["archivedAt"].is_null());
            if ix.opened_at >= since || ix.active_at >= since || unsettled_record {
                want.entry(id.clone())
                    .or_insert((3, ix.active_at.max(ix.opened_at)));
            }
        }
        for id in &self.open {
            want.insert(id.clone(), (0, i64::MAX));
        }
        let mut ranked: Vec<(u8, std::cmp::Reverse<i64>, String)> = want
            .into_iter()
            .map(|(id, (tier, at))| (tier, std::cmp::Reverse(at), id))
            .collect();
        ranked.sort();
        let keep: HashSet<String> = ranked.iter().map(|(_, _, id)| id.clone()).collect();
        for (rank, (_, _, id)) in ranked.into_iter().enumerate() {
            let rank = u32::try_from(rank).unwrap_or(u32::MAX);
            if self.subscribed.get(&id) != Some(&rank) {
                let after = self.index.get(&id).and_then(|ix| ix.cursor);
                self.connection.subscribe_thread_from(&id, after, rank);
                self.subscribed.insert(id, rank);
            }
        }
        let leaving: Vec<String> = self
            .subscribed
            .keys()
            .chain(self.index.keys())
            .filter(|id| !keep.contains(*id))
            .cloned()
            .collect();
        for id in leaving {
            self.forget(&id);
        }
    }

    /// Drops a thread from the device and from memory (unless the screen shows it).
    fn forget(&mut self, id: &str) {
        if self.subscribed.remove(id).is_some() && !self.open.iter().any(|open| open == id) {
            self.connection.unsubscribe_thread(id);
        }
        self.index.remove(id);
        self.write(
            id,
            ThreadWrite {
                forget: true,
                ..ThreadWrite::default()
            },
        );
        if !self.open.iter().any(|open| open == id) {
            self.held.remove(id);
            self.recent.retain(|recent| recent != id);
        }
    }
}

fn held_from(id: &str, window: Window) -> Held {
    let floor = window.timeline.first().and_then(|row| row.ord);
    let projection = rows::projection(id, &window.record, &window.timeline, &window.control);
    let more = window.more_local || window.older.is_some();
    let mut state = ThreadState::new(id);
    let snapshot = json!({
        "kind": "snapshot",
        "snapshotSequence": window.cursor.unwrap_or(0),
        "projection": projection,
        "hasMoreHistory": more,
    });
    match from_json::<Item>(snapshot) {
        Ok(item) => {
            state.apply(item);
            // The device copy is a whole window: draw it, the stream only brings it current.
            state.synchronized = true;
        }
        Err(e) => eprintln!("conn-cache: stored window of {id} does not decode: {e}"),
    }
    Held {
        state,
        floor,
        more_local: window.more_local,
        older: window.older,
    }
}

/// The database task: commits everything queued in one transaction, moves the resume cursors,
/// then answers the reads queued with it, so a read sees every write queued before it.
async fn run(
    pool: SqlitePool,
    env: String,
    connection: Connection,
    mut jobs: mpsc::UnboundedReceiver<Job>,
) {
    let mut batch: HashMap<String, ThreadWrite> = HashMap::new();
    let mut reads = vec![];
    while let Some(job) = jobs.recv().await {
        let mut next = Some(job);
        while let Some(job) = next.take().or_else(|| jobs.try_recv().ok()) {
            match job {
                Job::Write(thread, write) => match batch.get_mut(&thread) {
                    Some(earlier) => earlier.merge(write),
                    None => {
                        batch.insert(thread, write);
                    }
                },
                Job::Read {
                    thread,
                    before,
                    reply,
                } => reads.push((thread, before, reply)),
            }
        }
        if !batch.is_empty() {
            match db::commit(&pool, &env, std::mem::take(&mut batch)).await {
                Ok(committed) => {
                    for (thread, seq) in committed {
                        connection.set_thread_cursor(&thread, seq);
                    }
                }
                // The cursors stay; the next catch-up sends these changes again.
                Err(e) => eprintln!("conn-cache: write failed: {e}"),
            }
        }
        for (thread, before, reply) in reads.drain(..) {
            let window = read_or_fetch(&pool, &env, &connection, &thread, before).await;
            let _ = reply.send(window);
        }
    }
}

/// A window from the device; an older one the device does not hold comes from the server
/// first, stored below the oldest row.
async fn read_or_fetch(
    pool: &SqlitePool,
    env: &str,
    connection: &Connection,
    thread: &str,
    before: Option<f64>,
) -> Option<Window> {
    let window = db::read_window(pool, env, thread, before).await.ok()??;
    if before.is_none() || !window.timeline.is_empty() {
        return Some(window);
    }
    let cursor = window.older.clone()?;
    let page = match fetch_page(connection, thread, &cursor).await {
        Ok(page) => page,
        Err(e) => {
            eprintln!("conn-cache: older page of {thread}: {e}");
            return Some(window);
        }
    };
    // Own rows keep their ordinal, which is below every stored one; rows the thread does not
    // own and that lead the page go just below the device's lowest place.
    let floor = db::floor(pool, env, thread)
        .await
        .ok()
        .flatten()
        .unwrap_or(0.0);
    let mut write = ThreadWrite::default();
    let items = page["items"].as_array().cloned().unwrap_or_default();
    for row in rows::timeline_rows(thread, &items, floor) {
        write.put(row);
    }
    if let Some(subagents) = page["subagents"].as_array() {
        for body in subagents {
            write.put(rows::row("subagents", body.clone()));
        }
    }
    write.older = Some(page["nextCursor"].as_str().map(str::to_owned));
    let mut batch = HashMap::new();
    batch.insert(thread.to_owned(), write);
    db::commit(pool, env, batch).await.ok()?;
    db::read_window(pool, env, thread, before).await.ok()?
}

async fn fetch_page(
    connection: &Connection,
    thread: &str,
    cursor: &str,
) -> Result<Value, ClientError> {
    let page = connection.fetch_thread_history_page(thread, cursor).await?;
    serde_json::to_value(page).map_err(|e| ClientError::Connection(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(name: &str) -> Vec<Value> {
        let path = format!(
            "{}/../conn-state/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(path).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or_default()
    }

    fn connection(rt: &tokio::runtime::Handle) -> Connection {
        let config = conn_client::ServerConfig {
            http_base_url: url::Url::parse("http://127.0.0.1:9").unwrap_or_else(|_| unreachable!()),
            credential: conn_client::Credential::Bearer("test".into()),
        };
        Connection::start(config, rt).0
    }

    async fn engine(path: &Path, settings: Settings) -> Engine {
        let rt = tokio::runtime::Handle::current();
        Engine::open(path, "env", connection(&rt), settings)
            .await
            .unwrap_or_else(|e| panic!("open: {e}"))
    }

    /// Waits until the database task has committed everything queued so far.
    async fn settle(engine: &Engine, thread: &str) {
        let _ = engine.read(thread, None).await;
    }

    async fn open(engine: &mut Engine, thread: &str) {
        if let Some(window) = engine.open_thread(thread) {
            let window = window.await.ok().flatten();
            engine.finish_open(thread, window);
        }
    }

    fn entries(state: &ThreadState) -> Vec<String> {
        state.entries.iter().map(|e| format!("{e:?}")).collect()
    }

    /// The device copy reads back as what the stream built in memory: a snapshot and its
    /// events, stored, then opened by a new engine on the same file.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_reopened_thread_draws_what_the_stream_built() {
        for fixture in ["thread_turn_stream.json", "thread_permission_stream.json"] {
            let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
            let path = dir.path().join("local.sqlite3");
            let items = stream(fixture);
            assert!(!items.is_empty(), "{fixture}");
            let thread = items[0]["projection"]["thread"]["id"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let mut live = ThreadState::new(&thread);
            let mut first = engine(&path, Settings::default()).await;
            open(&mut first, &thread).await;
            for item in &items {
                let item: Item = from_json(item.clone()).unwrap_or_else(|e| panic!("{e}"));
                live.apply(item.clone());
                first.handle(&thread, item);
            }
            assert_eq!(
                entries(first.thread(&thread).unwrap_or(&live)),
                entries(&live)
            );
            settle(&first, &thread).await;
            drop(first);

            let mut second = engine(&path, Settings::default()).await;
            let last = items.iter().filter_map(|i| i["sequence"].as_i64()).max();
            assert_eq!(
                second.index.get(&thread).and_then(|ix| ix.cursor),
                last,
                "cursor moved with the rows"
            );
            open(&mut second, &thread).await;
            let reopened = second
                .thread(&thread)
                .unwrap_or_else(|| panic!("in memory"));
            assert_eq!(entries(reopened), entries(&live), "{fixture}");
            assert_eq!(reopened.working, live.working);
            assert_eq!(reopened.pending_requests.len(), live.pending_requests.len());
        }
    }

    /// A stale thread keeps its cursor; a deleted thread leaves the device; closed threads
    /// leave memory past the setting.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn stale_deleted_and_evicted_threads() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("local.sqlite3");
        let items = stream("thread_turn_stream.json");
        let thread = items[0]["projection"]["thread"]["id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let snapshot_seq = items[0]["snapshotSequence"].as_i64();
        let mut engine = engine(
            &path,
            Settings {
                threads_in_memory: Some(0),
                ..Settings::default()
            },
        )
        .await;
        engine.handle(
            &thread,
            from_json(items[0].clone()).unwrap_or_else(|e| panic!("{e}")),
        );
        engine.mark_stale(&thread);
        for item in &items[1..] {
            engine.handle(
                &thread,
                from_json(item.clone()).unwrap_or_else(|e| panic!("{e}")),
            );
        }
        settle(&engine, &thread).await;
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert_eq!(
            index.get(&thread).and_then(|ix| ix.cursor),
            snapshot_seq,
            "stale: no move"
        );

        open(&mut engine, &thread).await;
        assert!(engine.thread(&thread).is_some());
        engine.close_thread(&thread);
        assert!(
            engine.thread(&thread).is_none(),
            "no closed thread kept in memory"
        );

        let fixture = format!(
            "{}/../conn-state/tests/fixtures/thread_deleted_replay.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(fixture).unwrap_or_default())
                .unwrap_or_default();
        let mut deleted = fixture["item"].clone();
        deleted["event"]["threadId"] = json!(thread);
        deleted["event"]["payload"]["id"] = json!(thread);
        engine.handle(
            &thread,
            from_json(deleted).unwrap_or_else(|e| panic!("{e}")),
        );
        settle(&engine, &thread).await;
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert!(!index.contains_key(&thread));
        assert!(
            db::read_window(&engine.pool, "env", &thread, None)
                .await
                .ok()
                .flatten()
                .is_none()
        );
    }
}
