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

/// The one setting: which threads stay on the device follows the thread list, not a setting.
#[derive(Clone, Copy, Debug)]
pub struct Settings {
    /// Threads kept in memory after they close; `None` keeps every kept thread.
    pub threads_in_memory: Option<usize>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            threads_in_memory: Some(3),
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
    /// The thread list to save, as `LinkedShellSnapshot` JSON.
    Shell(Vec<u8>),
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
    /// Where its first rows came from, for the `sync.open_drawn` line.
    source: &'static str,
    /// Changes when a fresh window replaces the rows, so an older page asked for before is
    /// not put on top of the new window.
    generation: u64,
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
    /// Threads whose rows a rollback hid: they wait for a fresh window.
    resetting: HashSet<String>,
    /// Threads (re)subscribed whose `synchronized` has not come yet.
    catching_up: HashSet<String>,
    /// Older pages on their way, by thread, with the window generation they were asked for.
    older_in_flight: HashMap<String, u64>,
    /// The thread list saved on the device, until the app takes it to draw before the server
    /// answers.
    saved_shell: Option<ShellState>,
    shell_saved_at: Option<std::time::Instant>,
    next_generation: u64,
    runtime: tokio::runtime::Handle,
    perf: Perf,
}

/// Bookkeeping for the `sync.open_current` and `sync.kept_current` lines (`conn_client::perf`).
#[derive(Default)]
struct Perf {
    /// Open threads whose `synchronized` waits for their window.
    current_on_load: HashSet<String>,
    synchronized: HashSet<String>,
    kept_ranked: bool,
    kept_logged: bool,
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
        let saved_shell = db::read_shell(&pool, env)
            .await?
            .and_then(|bytes| conn_state::environments::LinkedShellSnapshot::from_json(&bytes))
            .filter(|saved| saved.environment_id == env)
            .map(|saved| {
                // Drawn at once, current only when the server's shell arrives.
                let mut shell = saved.into_shell();
                shell.synchronized = false;
                shell
            });
        let (jobs, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(pool.clone(), env.to_owned(), connection.clone(), rx));
        Ok(Self {
            env: env.to_owned(),
            connection,
            jobs,
            pool,
            settings,
            index,
            saved_shell,
            shell_saved_at: None,
            held: HashMap::new(),
            loading: HashMap::new(),
            open: vec![],
            recent: VecDeque::new(),
            subscribed: HashMap::new(),
            stale: HashSet::new(),
            resetting: HashSet::new(),
            catching_up: HashSet::new(),
            older_in_flight: HashMap::new(),
            next_generation: 1,
            runtime: tokio::runtime::Handle::current(),
            perf: Perf::default(),
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

    /// Where a thread in memory got its first rows: `device` or `server`.
    #[must_use]
    pub fn source(&self, id: &str) -> Option<&'static str> {
        self.held.get(id).map(|held| held.source)
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
                    Change::Row(row) => {
                        if row.kind == "runs" && row.body["status"] == "rolled_back" {
                            self.reset(thread);
                        }
                        let floor = self.index.get(thread).and_then(|ix| ix.floor);
                        let below = row.kind == OWN
                            && floor.is_some_and(|floor| row.ord.is_some_and(|ord| ord < floor));
                        if !below {
                            write.put(row);
                        }
                    }
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
        if let Item::Snapshot(_) = &item {
            // A fresh window replaces everything: nothing hidden or unread is left.
            self.resetting.remove(thread);
            self.stale.remove(thread);
        }
        if forget {
            self.forget(thread, true);
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
                entry.floor = snapshot_floor;
            } else if entry.floor.is_none() {
                entry.floor = write
                    .rows
                    .values()
                    .flatten()
                    .filter_map(|row| row.ord)
                    .reduce(f64::min);
            }
            self.write(thread, write);
        }
        let synchronized = matches!(item, Item::Synchronized(_));
        let caught_up = synchronized && self.catching_up.remove(thread);
        if synchronized && conn_client::perf::enabled() {
            self.note_synchronized(thread, caught_up);
        }
        if let Some(buffer) = self.loading.get_mut(thread) {
            buffer.push(item);
            return false;
        }
        let Some(held) = self.held.get_mut(thread) else {
            return false;
        };
        if let Item::Snapshot(snapshot) = &item {
            held.generation = self.next_generation;
            self.next_generation += 1;
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
        let changed = held.state.apply(item);
        if self.perf.current_on_load.remove(thread) {
            conn_client::perf::open_current(thread);
        }
        changed
    }

    /// Notes a thread's `synchronized` for the `sync.*` lines. An open thread whose catch-up it
    /// ends is current once the item is applied: now, or when its window arrives.
    fn note_synchronized(&mut self, thread: &str, ended_catch_up: bool) {
        if !self.subscribed.contains_key(thread) {
            return;
        }
        self.perf.synchronized.insert(thread.to_owned());
        if ended_catch_up && self.open.iter().any(|open| open == thread) {
            self.perf.current_on_load.insert(thread.to_owned());
        }
        self.check_kept_current();
    }

    fn check_kept_current(&mut self) {
        let perf = &mut self.perf;
        if perf.kept_ranked
            && !perf.kept_logged
            && !self.subscribed.is_empty()
            && self
                .subscribed
                .keys()
                .all(|id| perf.synchronized.contains(id))
        {
            perf.kept_logged = true;
            conn_client::perf::kept_current(self.subscribed.len());
        }
    }

    /// A run of the thread was rolled back: the server now hides rows the device holds. Keep
    /// the cursor where it is and ask for a fresh window, which replaces them.
    fn reset(&mut self, thread: &str) {
        self.stale.insert(thread.to_owned());
        if !self.resetting.insert(thread.to_owned()) {
            return;
        }
        let rank = self.subscribed.get(thread).copied().unwrap_or(0);
        self.connection.unsubscribe_thread(thread);
        self.connection.subscribe_thread_from(thread, None, rank);
        self.subscribed.insert(thread.to_owned(), rank);
        self.catching_up.insert(thread.to_owned());
    }

    /// Subscribes a kept thread again after its stream ended, at its rank and committed cursor.
    /// False when the engine does not keep the thread.
    pub fn resubscribe(&mut self, id: &str) -> bool {
        let Some(rank) = self.subscribed.get(id) else {
            return false;
        };
        let after = self.index.get(id).and_then(|ix| ix.cursor);
        self.connection.subscribe_thread_from(id, after, *rank);
        self.catching_up.insert(id.to_owned());
        true
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
        if self.subscribed.get(id) != Some(&0) {
            if !self.subscribed.contains_key(id) {
                self.catching_up.insert(id.to_owned());
            }
            self.connection.subscribe_thread_from(id, after, 0);
            self.subscribed.insert(id.to_owned(), 0);
        }
        // A thread already current opens current: the line goes out once it is in memory.
        let current = conn_client::perf::enabled()
            && self.perf.synchronized.contains(id)
            && !self.catching_up.contains(id);
        if self.held.contains_key(id) && !self.loading.contains_key(id) {
            if current {
                conn_client::perf::open_current(id);
            }
            return None;
        }
        if current {
            self.perf.current_on_load.insert(id.to_owned());
        }
        if self.loading.contains_key(id) {
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
                source: "server",
                generation: 0,
            },
        };
        held.generation = self.next_generation;
        self.next_generation += 1;
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
        if self.perf.current_on_load.remove(id) {
            conn_client::perf::open_current(id);
        }
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

    /// Asks for older rows of an open thread: from the device while it holds them, else one
    /// server page, fetched outside the database task and shown without being stored. `None`
    /// when nothing older exists or a read is on its way.
    pub fn older(&mut self, id: &str) -> Option<Pending> {
        let held = self.held.get_mut(id)?;
        if !(held.more_local || held.older.is_some()) || self.older_in_flight.contains_key(id) {
            return None;
        }
        self.older_in_flight.insert(id.to_owned(), held.generation);
        held.state.loading_earlier = true;
        let (floor, local, cursor) = (held.floor, held.more_local, held.older.clone());
        let device = local.then(|| self.read(id, Some(floor.unwrap_or(f64::MAX))));
        let (reply, rx) = oneshot::channel();
        let (connection, thread) = (self.connection.clone(), id.to_owned());
        self.runtime.spawn(async move {
            if let Some(device) = device
                && let Ok(Some(window)) = device.await
                && !window.timeline.is_empty()
            {
                let _ = reply.send(Some(window));
                return;
            }
            let window = match cursor {
                Some(cursor) => server_page(&connection, &thread, &cursor, floor).await,
                None => None,
            };
            let _ = reply.send(window);
        });
        Some(rx)
    }

    /// The window [`Self::older`] asked for. Returns how many rows were added on top. A page
    /// asked for before a fresh window replaced the rows is dropped.
    pub fn finish_older(&mut self, id: &str, window: Option<Window>) -> usize {
        let asked = self.older_in_flight.remove(id);
        let Some(held) = self.held.get_mut(id) else {
            return 0;
        };
        held.state.loading_earlier = false;
        let Some(window) = window.filter(|_| asked == Some(held.generation)) else {
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

    /// The thread list saved on the device at the last launch, to draw at once (not
    /// synchronized). `None` after the first call or when none is saved.
    pub fn take_saved_shell(&mut self) -> Option<ShellState> {
        self.saved_shell.take()
    }

    /// Saves the thread list for the next launch: at most every few seconds, unless `now` (for
    /// going to the background or quitting). Call it with a synchronized shell.
    pub fn save_shell(&mut self, shell: &ShellState, now: bool) {
        const EVERY: std::time::Duration = std::time::Duration::from_secs(5);
        if !now && self.shell_saved_at.is_some_and(|at| at.elapsed() < EVERY) {
            return;
        }
        self.shell_saved_at = Some(std::time::Instant::now());
        let snapshot =
            conn_state::environments::LinkedShellSnapshot::capture_inventory(&self.env, shell);
        if let Ok(bytes) = snapshot.to_json() {
            let _ = self.jobs.send(Job::Shell(bytes));
        }
    }

    /// Resolves once everything queued before this call is written, for a quit that must not
    /// lose the last save.
    pub fn flush(&self) -> impl std::future::Future<Output = ()> + Send + 'static + use<> {
        let pending = self.read("", None);
        async move {
            let _ = pending.await;
        }
    }

    /// Keeps the device in step with the shell: the open threads and every unsettled thread
    /// stay subscribed and stored, the open thread first, then those that need the user,
    /// working threads, then the newest. A thread that leaves the set is deleted from the
    /// device; a settled thread loads again when it is opened. Call it with a synchronized
    /// shell only: a thread missing from a shell is judged by its stored record, never by its
    /// absence.
    pub fn update_kept(&mut self, shell: &ShellState) {
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
            if unsettled_record {
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
            // Rank 0 never waits for an opening slot: only a thread on screen gets it.
            let rank = if self.open.contains(&id) {
                0
            } else {
                u32::try_from(rank + 1).unwrap_or(u32::MAX)
            };
            if self.subscribed.get(&id) != Some(&rank) {
                let after = self.index.get(&id).and_then(|ix| ix.cursor);
                if !self.subscribed.contains_key(&id) {
                    self.catching_up.insert(id.clone());
                }
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
            self.forget(&id, false);
        }
        if conn_client::perf::enabled() {
            self.perf.kept_ranked = true;
            self.check_kept_current();
        }
    }

    /// Drops a thread from the device. A deleted thread also leaves memory; a settled one may
    /// stay among the recently closed until the memory limit drops it.
    fn forget(&mut self, id: &str, deleted: bool) {
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
        if deleted && !self.open.iter().any(|open| open == id) {
            self.held.remove(id);
            self.recent.retain(|recent| recent != id);
        }
    }
}

fn held_from(id: &str, window: Window) -> Held {
    let source = if window.timeline.is_empty() {
        "server"
    } else {
        "device"
    };
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
            // Ready to draw, not caught up: `synchronized` waits for the stream's own marker,
            // so the syncing bar shows until the thread is current.
            state.apply(item);
        }
        Err(e) => eprintln!("conn-cache: stored window of {id} does not decode: {e}"),
    }
    Held {
        state,
        floor,
        more_local: window.more_local,
        older: window.older,
        source,
        generation: 0,
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
    // Threads whose rows a failed write lost: their cursor stays until a fresh window, so a
    // later write cannot move it past the lost change.
    let mut frozen: HashSet<String> = HashSet::new();
    let mut shell: Option<Vec<u8>> = None;
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
                Job::Shell(bytes) => shell = Some(bytes),
            }
        }
        if let Some(bytes) = shell.take()
            && let Err(e) = db::write_shell(&pool, &env, &bytes).await
        {
            eprintln!("conn-cache: shell save failed: {e}");
        }
        if !batch.is_empty() {
            let mut writes = std::mem::take(&mut batch);
            for (thread, write) in &mut writes {
                if write.reset || write.forget {
                    frozen.remove(thread);
                } else if frozen.contains(thread) {
                    write.seq = None;
                }
            }
            let threads: Vec<String> = writes.keys().cloned().collect();
            match db::commit(&pool, &env, writes).await {
                Ok(committed) => {
                    for (thread, seq) in committed {
                        connection.set_thread_cursor(&thread, seq);
                    }
                }
                // The cursors stay; the next catch-up sends these changes again.
                Err(e) => {
                    eprintln!("conn-cache: write failed: {e}");
                    frozen.extend(threads);
                }
            }
        }
        for (thread, before, reply) in reads.drain(..) {
            let window = db::read_window(&pool, &env, &thread, before)
                .await
                .ok()
                .flatten();
            let _ = reply.send(window);
        }
    }
}

/// One older server page as a window below `floor`: own rows keep their ordinal, rows the
/// thread does not own that lead the page go just below it.
async fn server_page(
    connection: &Connection,
    thread: &str,
    cursor: &str,
    floor: Option<f64>,
) -> Option<Window> {
    let page = match fetch_page(connection, thread, cursor).await {
        Ok(page) => page,
        Err(e) => {
            eprintln!("conn-cache: older page of {thread}: {e}");
            return None;
        }
    };
    let items = page["items"].as_array().cloned().unwrap_or_default();
    let subagents = page["subagents"].as_array().cloned().unwrap_or_default();
    Some(Window {
        record: Value::Null,
        timeline: rows::timeline_rows(thread, &items, floor.unwrap_or(0.0)),
        control: subagents
            .into_iter()
            .map(|body| rows::row("subagents", body))
            .collect(),
        more_local: false,
        older: page["nextCursor"].as_str().map(str::to_owned),
        cursor: None,
    })
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

    /// A live rollback hides rows the device holds: the cursor stays until a fresh window
    /// replaces them, so a kill in between still gets the reset on the next catch-up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_live_rollback_holds_the_cursor_until_a_fresh_window() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("local.sqlite3");
        let items = stream("thread_turn_stream.json");
        let thread = items[0]["projection"]["thread"]["id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let mut engine = engine(&path, Settings::default()).await;
        engine.handle(
            &thread,
            from_json(items[0].clone()).unwrap_or_else(|e| panic!("{e}")),
        );
        let snapshot_seq = items[0]["snapshotSequence"].as_i64();
        let run = items
            .iter()
            .find(|item| item["event"]["type"] == "run.updated")
            .cloned()
            .unwrap_or_default();
        let mut rolled = run.clone();
        rolled["sequence"] = json!(9_000_000);
        rolled["event"]["payload"]["status"] = json!("rolled_back");
        engine.handle(&thread, from_json(rolled).unwrap_or_else(|e| panic!("{e}")));
        let mut later = run;
        later["sequence"] = json!(9_000_001);
        engine.handle(&thread, from_json(later).unwrap_or_else(|e| panic!("{e}")));
        settle(&engine, &thread).await;
        let cursor =
            |index: HashMap<String, ThreadIndex>| index.get(&thread).and_then(|ix| ix.cursor);
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert_eq!(cursor(index), snapshot_seq, "no move past a rollback");
        let mut fresh = items[0].clone();
        fresh["snapshotSequence"] = json!(9_000_002);
        engine.handle(&thread, from_json(fresh).unwrap_or_else(|e| panic!("{e}")));
        settle(&engine, &thread).await;
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert_eq!(cursor(index), Some(9_000_002), "the fresh window moves it");
        assert!(engine.stale.is_empty() && engine.resetting.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_failed_write_holds_the_cursor_until_a_fresh_window() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("local.sqlite3");
        let items = stream("thread_turn_stream.json");
        let thread = items[0]["projection"]["thread"]["id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let mut engine = engine(&path, Settings::default()).await;
        engine.handle(
            &thread,
            from_json(items[0].clone()).unwrap_or_else(|e| panic!("{e}")),
        );
        settle(&engine, &thread).await;
        sqlx::query(
            "CREATE TRIGGER boom BEFORE INSERT ON rows WHEN NEW.id = 'boom'
             BEGIN SELECT RAISE(ABORT, 'disk full'); END",
        )
        .execute(&engine.pool)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
        let item = items
            .iter()
            .find(|item| item["event"]["type"] == "turn-item.updated")
            .cloned()
            .unwrap_or_default();
        let change = |id: &str, seq: i64| {
            let mut change = item.clone();
            change["sequence"] = json!(seq);
            change["event"]["payload"]["id"] = json!(id);
            from_json::<Item>(change).unwrap_or_else(|e| panic!("{e}"))
        };
        engine.handle(&thread, change("boom", 9_000_000));
        settle(&engine, &thread).await;
        engine.handle(&thread, change("fine", 9_000_001));
        settle(&engine, &thread).await;
        let cursor =
            |index: HashMap<String, ThreadIndex>| index.get(&thread).and_then(|ix| ix.cursor);
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert_eq!(
            cursor(index),
            items[0]["snapshotSequence"].as_i64(),
            "frozen"
        );
        let mut fresh = items[0].clone();
        fresh["snapshotSequence"] = json!(9_000_002);
        engine.handle(&thread, from_json(fresh).unwrap_or_else(|e| panic!("{e}")));
        settle(&engine, &thread).await;
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert_eq!(cursor(index), Some(9_000_002), "a fresh window moves it");
    }

    /// An older page asked for before a fresh window replaced the rows is not put on top of
    /// the new window.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn an_older_page_from_before_a_reset_is_dropped() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("local.sqlite3");
        let items = stream("thread_turn_stream.json");
        let thread = items[0]["projection"]["thread"]["id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let mut engine = engine(&path, Settings::default()).await;
        engine.handle(
            &thread,
            from_json(items[0].clone()).unwrap_or_else(|e| panic!("{e}")),
        );
        let item = items
            .iter()
            .find(|item| item["event"]["type"] == "turn-item.updated")
            .cloned()
            .unwrap_or_default();
        for n in 0..400 {
            let mut change = item.clone();
            change["sequence"] = json!(9_000_000 + n);
            change["event"]["payload"]["id"] = json!(format!("row-{n}"));
            change["event"]["payload"]["ordinal"] = json!(2_000_000 + n);
            engine.handle(&thread, from_json(change).unwrap_or_else(|e| panic!("{e}")));
        }
        open(&mut engine, &thread).await;
        let pending = engine
            .older(&thread)
            .unwrap_or_else(|| panic!("older rows on the device"));
        let mut fresh = items[0].clone();
        fresh["snapshotSequence"] = json!(9_100_000);
        engine.handle(&thread, from_json(fresh).unwrap_or_else(|e| panic!("{e}")));
        let before = engine.thread(&thread).map_or(0, |s| s.entries.len());
        let window = pending.await.ok().flatten();
        assert!(
            window.is_some_and(|w| !w.timeline.is_empty()),
            "the page itself arrived"
        );
        let window = engine.read(&thread, Some(2_000_100.0)).await.ok().flatten();
        assert_eq!(engine.finish_older(&thread, window), 0, "dropped");
        assert_eq!(
            engine.thread(&thread).map_or(0, |s| s.entries.len()),
            before
        );
    }

    /// An update of a row below the stored window is not written: on the device it would
    /// sit directly above the window, as if the rows between were there.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn an_update_below_the_window_is_not_stored() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("local.sqlite3");
        let items = stream("thread_turn_stream.json");
        let thread = items[0]["projection"]["thread"]["id"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let mut engine = engine(&path, Settings::default()).await;
        engine.handle(
            &thread,
            from_json(items[0].clone()).unwrap_or_else(|e| panic!("{e}")),
        );
        let mut old = items
            .iter()
            .find(|item| item["event"]["type"] == "turn-item.updated")
            .cloned()
            .unwrap_or_default();
        old["sequence"] = json!(9_000_000);
        old["event"]["payload"]["id"] = json!("old-card");
        old["event"]["payload"]["ordinal"] = json!(5);
        engine.handle(&thread, from_json(old).unwrap_or_else(|e| panic!("{e}")));
        settle(&engine, &thread).await;
        let stored: Option<String> =
            sqlx::query_scalar("SELECT id FROM rows WHERE id = 'old-card'")
                .fetch_optional(&engine.pool)
                .await
                .unwrap_or_else(|e| panic!("{e}"));
        assert!(stored.is_none(), "not on the device");
        let index = db::read_index(&engine.pool, "env")
            .await
            .unwrap_or_default();
        assert_eq!(
            index.get(&thread).and_then(|ix| ix.cursor),
            Some(9_000_000),
            "cursor moves"
        );
    }

    /// The thread list saved on one launch draws on the next, before the server answers.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_saved_thread_list_opens_with_the_next_launch() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = dir.path().join("local.sqlite3");
        let mut shell = ShellState::default();
        shell.sequence = Some(42);
        let mut first = engine(&path, Settings::default()).await;
        assert!(first.take_saved_shell().is_none());
        first.save_shell(&shell, true);
        settle(&first, "any").await;
        drop(first);
        let mut second = engine(&path, Settings::default()).await;
        let saved = second.take_saved_shell().unwrap_or_else(|| panic!("saved"));
        assert_eq!(saved.sequence, Some(42));
        assert!(!saved.synchronized, "drawn, not current");
        assert!(second.take_saved_shell().is_none(), "taken once");
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
