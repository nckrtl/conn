//! Thread state. One `conn_cache::Engine` per environment owns the device rows, the kept set,
//! catch-up and the threads in memory; the app opens and closes threads in it and draws what it
//! holds. Without an engine (tests, the demo, or a device database that would not open) the
//! open threads are subscribed plainly and held in `local`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use conn_cache::{Engine, Pending, Settings};
use conn_client::Connection;
use conn_state::{ThreadState, ThreadStreamItem};
use gpui_kit::Context;

use super::ConnApp;
use crate::chat::{ThreadOutline, TocEntry};

/// How long shell changes settle before the kept sets are brought in line.
const KEPT_DELAY: Duration = Duration::from_millis(300);
/// How often the primary thread list is saved on the device at most.
const SHELL_SAVE_EVERY: Duration = Duration::from_secs(5);

struct Slot {
    engine: Engine,
    /// Tells a reply for a replaced engine from one for this engine.
    generation: u64,
}

/// How an open thread gets its stream.
enum Opened {
    Engine(u64),
    Plain(Connection),
}

#[derive(Default)]
pub(super) struct Threads {
    /// The device database every engine shares; `None` keeps no engine.
    db: Option<PathBuf>,
    engines: HashMap<String, Slot>,
    generation: u64,
    /// Threads no engine holds.
    local: HashMap<String, ThreadState>,
    /// The threads open now (the selected one and the children asking for approval), by
    /// environment and id.
    open: HashMap<(String, String), Opened>,
    /// Linked environments whose live shell has synchronized since they connected.
    synced: HashSet<String>,
    kept_scheduled: bool,
    /// When the primary thread list was last handed to its engine to save.
    shell_saved_at: Option<Instant>,
    /// Outlines of opened threads, with the `updatedAt` each was read at.
    outlines: HashMap<String, (String, Arc<ThreadOutline>)>,
    outline_loading: Option<String>,
    /// The thread and `updatedAt` whose outline read last failed, so it is not asked again.
    outline_failed: Option<(String, String)>,
    /// A launched thread's first projection, drawn until its stream sends one.
    launched: Option<(
        String,
        conn_contract::OrchestrationV2ThreadProjection,
        Option<i64>,
    )>,
}

impl Threads {
    /// Keeps the device database under the app's support folder, and deletes the folder the
    /// previous offline layer kept there. Tests and the demo keep none.
    pub(super) fn new(enabled: bool) -> Self {
        if !enabled || (cfg!(test) && std::env::var_os("CONN_GPUI_CONFIG_DIR").is_none()) {
            return Self::default();
        }
        let dir = conn_desktop::orbit::OrbitSessionStore::default_path()
            .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
        if let Some(old) = dir.as_ref().map(|dir| dir.join("offline-v1"))
            && old.exists()
        {
            crate::live::RT.spawn_blocking(move || {
                if let Err(err) = std::fs::remove_dir_all(&old) {
                    eprintln!("old offline folder: {err}");
                }
            });
        }
        Self {
            db: dir.map(|dir| dir.join("threads.sqlite3")),
            ..Self::default()
        }
    }

    /// Ends every engine and plain subscription, keeping where the database lives.
    pub(super) fn reset(&mut self) {
        *self = Self {
            db: self.db.take(),
            generation: self.generation,
            ..Self::default()
        };
    }
}

impl ConnApp {
    /// The environment a thread's state is kept under: its linked environment, else the
    /// primary server.
    pub(super) fn thread_env(&self, thread: &str) -> Option<&str> {
        self.linked_environment_of_thread(thread)
            .or(self.server_url.as_deref())
    }

    /// The thread as the chat draws it, when it is in memory.
    pub(crate) fn thread(&self, id: &str) -> Option<&ThreadState> {
        self.thread_env(id)
            .and_then(|env| self.threads.engines.get(env))
            .and_then(|slot| slot.engine.thread(id))
            .or_else(|| self.threads.local.get(id))
    }

    /// Where a thread in memory got its first rows: `device` or `server`.
    pub(super) fn thread_source(&self, id: &str) -> Option<&'static str> {
        self.thread_env(id)
            .and_then(|env| self.threads.engines.get(env))
            .and_then(|slot| slot.engine.source(id))
    }

    pub(super) fn thread_mut(&mut self, id: &str) -> Option<&mut ThreadState> {
        let env = self.thread_env(id).map(str::to_owned);
        match env.and_then(|env| self.threads.engines.get_mut(&env)) {
            Some(slot) if slot.engine.thread(id).is_some() => slot.engine.thread_mut(id),
            _ => self.threads.local.get_mut(id),
        }
    }

    /// Holds a thread no engine owns (the automation fixture, tests).
    #[cfg(any(test, feature = "automation"))]
    pub(super) fn insert_local_thread(&mut self, id: String, state: ThreadState) {
        self.threads.local.insert(id, state);
    }

    /// Starts the engine of `env` on its connection, replacing an earlier one.
    pub(super) fn start_engine(
        &mut self,
        env: &str,
        connection: Connection,
        cx: &mut Context<'_, Self>,
    ) {
        self.stop_engine(env);
        let Some(path) = self.threads.db.clone() else {
            return;
        };
        if let Some(dir) = path.parent()
            && let Err(err) = std::fs::create_dir_all(dir)
        {
            eprintln!("thread database folder: {err}");
            return;
        }
        let opened =
            crate::live::RT.block_on(Engine::open(&path, env, connection, Settings::default()));
        match opened {
            Ok(engine) => {
                self.threads.generation = self.threads.generation.wrapping_add(1);
                let generation = self.threads.generation;
                self.threads
                    .engines
                    .insert(env.to_owned(), Slot { engine, generation });
                if self.server_url.as_deref() == Some(env) {
                    self.draw_saved_shell(env, cx);
                }
                self.schedule_kept(cx);
            }
            Err(err) => eprintln!("thread database: {err}"),
        }
    }

    /// Draws the primary thread list saved on the device (not synchronized) until the server's
    /// shell replaces it.
    fn draw_saved_shell(&mut self, env: &str, cx: &mut Context<'_, Self>) {
        if self.shell.synchronized || self.shell.sequence.is_some() {
            return;
        }
        let Some(saved) = self
            .threads
            .engines
            .get_mut(env)
            .and_then(|slot| slot.engine.take_saved_shell())
        else {
            return;
        };
        let threads_changed = saved
            .threads
            .iter()
            .chain(&saved.archived_threads)
            .map(|t| t.id.clone())
            .collect();
        self.shell = saved;
        self.pending_shell = Some(conn_state::ShellChange {
            projects_changed: true,
            threads_changed,
            snapshot_required: false,
        });
        conn_client::perf::shell_cached();
        self.settle_shell(cx);
    }

    /// Saves the primary environment's own thread list on the device for the next launch, at
    /// most every [`SHELL_SAVE_EVERY`] unless `now`. Only a synchronized list is saved. The
    /// future resolves once it is written (for quitting).
    pub(super) fn save_primary_shell(
        &mut self,
        now: bool,
    ) -> Option<impl std::future::Future<Output = ()> + Send + 'static + use<>> {
        if !self.shell.synchronized
            || (!now
                && self
                    .threads
                    .shell_saved_at
                    .is_some_and(|at| at.elapsed() < SHELL_SAVE_EVERY))
        {
            return None;
        }
        let slot = self
            .server_url
            .as_deref()
            .and_then(|env| self.threads.engines.get_mut(env))?;
        self.threads.shell_saved_at = Some(Instant::now());
        // Throttled here so the merged list is copied only when a save is due.
        let origins = self.linked.origins();
        if *origins == conn_state::environments::Origins::default() {
            slot.engine.save_shell(&self.shell, true);
        } else {
            let mut own = self.shell.clone();
            origins.strip_from(&mut own);
            slot.engine.save_shell(&own, true);
        }
        Some(slot.engine.flush())
    }

    /// Drops the engine of an environment whose connection went away. Its rows stay on the
    /// device for the next connection.
    pub(super) fn stop_engine(&mut self, env: &str) {
        self.threads.engines.remove(env);
        self.threads.synced.remove(env);
        self.threads
            .open
            .retain(|(owner, _), opened| owner != env || matches!(opened, Opened::Plain(_)));
    }

    /// The one event path for every environment's thread streams.
    pub(super) fn apply_thread_item(
        &mut self,
        env: Option<&str>,
        id: &str,
        item: ThreadStreamItem,
    ) {
        if let Some(slot) = env.and_then(|env| self.threads.engines.get_mut(env)) {
            slot.engine.handle(id, item);
            return;
        }
        self.threads
            .local
            .entry(id.to_owned())
            .or_insert_with(|| ThreadState::new(id))
            .apply(item);
    }

    pub(super) fn thread_stale(&mut self, env: Option<&str>, id: &str) {
        if let Some(slot) = env.and_then(|env| self.threads.engines.get_mut(env)) {
            slot.engine.mark_stale(id);
        }
    }

    /// Whether the thread is current without opening it: open, or in memory or stored on the
    /// device by its engine, which keeps its stream.
    pub(super) fn thread_current(&self, id: &str) -> bool {
        self.threads.open.keys().any(|(_, open)| open == id)
            || self
                .thread_env(id)
                .and_then(|env| self.threads.engines.get(env))
                .is_some_and(|slot| slot.engine.thread(id).is_some() || slot.engine.stored(id))
    }

    /// Keeps threads in an engine on `db` for the primary connection, as the live app does.
    #[cfg(test)]
    pub(super) fn use_engine_for_test(&mut self, db: &std::path::Path, cx: &mut Context<'_, Self>) {
        self.threads.db = Some(db.to_owned());
        if let (Some(env), Some(connection)) = (self.server_url.clone(), self.connection.clone()) {
            self.start_engine(&env, connection, cx);
        }
    }

    #[cfg(test)]
    pub(crate) fn thread_open_for_test(&self, id: &str) -> bool {
        self.threads.open.keys().any(|(_, open)| open == id)
    }

    /// Whether the app keeps the stream the server ended, so it asks again once the shell
    /// lists the thread.
    pub(super) fn keeps_stream(&self, id: &str) -> bool {
        self.threads.open.keys().any(|(_, open)| open == id) || self.thread(id).is_some()
    }

    /// Asks again for a stream the server ended.
    pub(super) fn resubscribe_thread(&mut self, id: &str) {
        let env = self.thread_env(id).map(str::to_owned);
        if let Some(slot) = env
            .as_ref()
            .and_then(|env| self.threads.engines.get_mut(env))
        {
            slot.engine.resubscribe(id);
            return;
        }
        if let Some(connection) = self.connection_for_thread(id) {
            connection.subscribe_thread(id);
        }
    }

    /// Opens what the screen shows (the selected thread, the children asking for approval) and
    /// the hovered thread being prefetched, and closes the rest.
    pub(super) fn sync_open_threads(&mut self, cx: &mut Context<'_, Self>) {
        let mut want: HashSet<(String, String)> = HashSet::new();
        let selected = self
            .layout
            .selected_thread_id
            .as_deref()
            .filter(|_| self.draft.is_none());
        for id in selected
            .into_iter()
            .chain(self.child_approvals.open_children())
            .chain(self.speculative.thread())
        {
            if let Some(env) = self.thread_env(id) {
                want.insert((env.to_owned(), id.to_owned()));
            }
        }
        let current = |slot: Option<&Slot>, opened: &Opened| match opened {
            Opened::Engine(generation) => slot.is_some_and(|s| s.generation == *generation),
            Opened::Plain(_) => slot.is_none(),
        };
        let closing: Vec<(String, String)> = self
            .threads
            .open
            .iter()
            .filter(|(key, opened)| {
                !want.contains(*key) || !current(self.threads.engines.get(&key.0), opened)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in closing {
            match self.threads.open.remove(&key) {
                Some(Opened::Engine(generation)) => {
                    if let Some(slot) = self
                        .threads
                        .engines
                        .get_mut(&key.0)
                        .filter(|slot| slot.generation == generation)
                    {
                        slot.engine.close_thread(&key.1);
                    }
                }
                Some(Opened::Plain(connection)) => {
                    connection.unsubscribe_thread(&key.1);
                }
                None => {}
            }
        }
        for key in want {
            if self.threads.open.contains_key(&key) {
                continue;
            }
            if let Some(slot) = self.threads.engines.get_mut(&key.0) {
                let generation = slot.generation;
                if let Some(pending) = slot.engine.open_thread(&key.1) {
                    self.finish_open_later(key.clone(), generation, pending, cx);
                }
                self.threads.open.insert(key, Opened::Engine(generation));
            } else if let Some(connection) = self.connection_for_thread(&key.1) {
                self.threads
                    .local
                    .entry(key.1.clone())
                    .or_insert_with(|| ThreadState::new(key.1.clone()));
                connection.subscribe_thread(&key.1);
                self.threads.open.insert(key, Opened::Plain(connection));
            }
        }
    }

    fn finish_open_later(
        &mut self,
        (env, id): (String, String),
        generation: u64,
        pending: Pending,
        cx: &mut Context<'_, Self>,
    ) {
        let started = Instant::now();
        cx.spawn(async move |this, cx| {
            let window = pending.await.ok().flatten();
            let _ = this.update(cx, |app, cx| {
                let Some(slot) = app
                    .threads
                    .engines
                    .get_mut(&env)
                    .filter(|slot| slot.generation == generation)
                else {
                    return;
                };
                if !slot.engine.is_loading(&id) {
                    return;
                }
                slot.engine.finish_open(&id, window);
                if let Some(state) = slot.engine.thread_mut(&id)
                    && state.sequence.is_none()
                    && let Some((_, projection, sequence)) = app
                        .threads
                        .launched
                        .take_if(|(launched, _, _)| *launched == id)
                {
                    state.apply_projection(projection, sequence);
                }
                if let Some((_, opened_at)) = app.perf_open.as_ref().filter(|(open, _)| *open == id)
                {
                    conn_client::perf_log!(
                        "app.applied thread={id} kind=device entries={} apply_ms={:.1} +{:.1}ms",
                        app.thread(&id).map_or(0, |t| t.entries.len()),
                        conn_client::perf::ms_since(started),
                        conn_client::perf::ms_since(*opened_at),
                    );
                }
                app.sync_chat(cx);
                cx.notify();
            });
        })
        .detach();
    }

    /// Keeps a launched thread's first projection until its window opens.
    pub(super) fn remember_launch(
        &mut self,
        id: String,
        projection: conn_contract::OrchestrationV2ThreadProjection,
        sequence: Option<i64>,
    ) {
        let env = self.thread_env(&id).map(str::to_owned);
        if env.is_some_and(|env| self.threads.engines.contains_key(&env)) {
            self.threads.launched = Some((id, projection, sequence));
        } else {
            let mut state = ThreadState::new(id.clone());
            state.apply_projection(projection, sequence);
            self.threads.local.insert(id, state);
        }
    }

    /// Asks for the selected thread's older rows: the engine reads the device, then the
    /// server; a thread without an engine pages the server.
    pub(super) fn load_earlier_history(&mut self, cx: &mut Context<'_, Self>) {
        let Some(id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        let env = self.thread_env(&id).map(str::to_owned);
        if let Some((env, slot)) = env
            .and_then(|env| self.threads.engines.get_mut(&env).map(|slot| (env, slot)))
            .filter(|(_, slot)| slot.engine.thread(&id).is_some())
        {
            let Some(pending) = slot.engine.older(&id) else {
                return;
            };
            let generation = slot.generation;
            self.sync_chat(cx);
            cx.spawn(async move |this, cx| {
                let window = pending.await.ok().flatten();
                let _ = this.update(cx, |app, cx| {
                    if let Some(slot) = app
                        .threads
                        .engines
                        .get_mut(&env)
                        .filter(|slot| slot.generation == generation)
                    {
                        slot.engine.finish_older(&id, window);
                    }
                    if app.layout.selected_thread_id.as_deref() == Some(id.as_str()) {
                        app.sync_chat(cx);
                    }
                });
            })
            .detach();
            return;
        }
        self.load_earlier_from_server(id, cx);
    }

    fn load_earlier_from_server(&mut self, id: String, cx: &mut Context<'_, Self>) {
        let connection = self
            .connection_for_thread(&id)
            .filter(|_| self.thread_connected(&id));
        let Some(thread) = self.threads.local.get_mut(&id) else {
            return;
        };
        let (Some(connection), Some(cursor)) = (connection, thread.history_cursor.clone()) else {
            thread.has_more_history = false;
            self.sync_chat(cx);
            return;
        };
        if !thread.has_more_history || thread.loading_earlier {
            return;
        }
        thread.loading_earlier = true;
        self.sync_chat(cx);
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let request = cursor.clone();
            let thread_id = id.clone();
            let result = crate::live::RT
                .spawn(async move {
                    connection
                        .fetch_thread_history_page(&thread_id, &request)
                        .await
                })
                .await;
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation {
                    return;
                }
                if let Some(thread) = app.threads.local.get_mut(&id) {
                    thread.loading_earlier = false;
                    match result {
                        Ok(Ok(page)) if thread.history_cursor.as_ref() == Some(&cursor) => {
                            thread.prepend_history_page(page);
                        }
                        Ok(Ok(_)) => {}
                        Ok(Err(err)) => {
                            eprintln!("conn-app: failed to load earlier history ({id}): {err}");
                        }
                        Err(err) => eprintln!("conn-app: history task failed ({id}): {err}"),
                    }
                }
                if app.layout.selected_thread_id.as_deref() == Some(id.as_str()) {
                    app.sync_chat(cx);
                }
            });
        })
        .detach();
    }

    /// Notes that a linked environment's live shell synchronized, or stopped being live.
    pub(super) fn linked_shell_synced(&mut self, env: &str, synced: bool) {
        if synced {
            self.threads.synced.insert(env.to_owned());
        } else {
            self.threads.synced.remove(env);
        }
    }

    /// Brings every engine's kept set in line with its environment's shell, a moment after the
    /// last shell change.
    pub(super) fn schedule_kept(&mut self, cx: &mut Context<'_, Self>) {
        if self.threads.kept_scheduled || self.threads.engines.is_empty() {
            return;
        }
        self.threads.kept_scheduled = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(KEPT_DELAY).await;
            let _ = this.update(cx, |app, _| {
                app.threads.kept_scheduled = false;
                app.update_kept();
            });
        })
        .detach();
    }

    fn update_kept(&mut self) {
        let primary = self.server_url.clone();
        let origins = self.linked.origins();
        for (env, slot) in &mut self.threads.engines {
            if Some(env) == primary.as_ref() {
                if !self.shell.synchronized {
                    continue;
                }
                if *origins == conn_state::environments::Origins::default() {
                    slot.engine.update_kept(&self.shell);
                } else {
                    let mut own = self.shell.clone();
                    origins.strip_from(&mut own);
                    slot.engine.update_kept(&own);
                }
            } else if self.threads.synced.contains(env)
                && let Some(shell) = self.linked.shell_for_cache(env)
            {
                slot.engine.update_kept(shell);
            }
        }
    }

    /// The selected thread's outline, read from its server when it opens and again whenever
    /// the thread changed since.
    pub(super) fn cached_outline(&self, id: &str) -> Option<Arc<ThreadOutline>> {
        self.threads
            .outlines
            .get(id)
            .map(|(_, outline)| Arc::clone(outline))
    }

    pub(super) fn refresh_selected_outline(&mut self, cx: &mut Context<'_, Self>) {
        if self.threads.outline_loading.is_some() {
            return;
        }
        let Some(id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        let Some(stamp) = self.shell.find_thread(&id).map(|t| t.updated_at.clone()) else {
            return;
        };
        if self
            .threads
            .outlines
            .get(&id)
            .is_some_and(|(read, _)| *read == stamp)
            || self.threads.outline_failed.as_ref() == Some(&(id.clone(), stamp.clone()))
            || !self.thread_connected(&id)
        {
            return;
        }
        let Some(connection) = self.connection_for_thread(&id) else {
            return;
        };
        self.threads.outline_loading = Some(id.clone());
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let result = connection.fetch_thread_outline(&id).await;
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation {
                    return;
                }
                app.threads.outline_loading = None;
                match result {
                    Ok(outline) => {
                        let markers = outline
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
                        // Only threads still in memory keep theirs.
                        let held: Vec<String> = app
                            .threads
                            .outlines
                            .keys()
                            .filter(|kept| app.thread(kept).is_some())
                            .cloned()
                            .collect();
                        app.threads.outlines.retain(|kept, _| held.contains(kept));
                        app.threads
                            .outlines
                            .insert(id.clone(), (stamp, Arc::new(ThreadOutline::new(markers))));
                        if app.layout.selected_thread_id.as_ref() == Some(&id) {
                            app.sync_chat(cx);
                        }
                    }
                    Err(err) => {
                        eprintln!("thread outline: {err}");
                        // Not asked again until the thread changes.
                        app.threads.outline_failed = Some((id, stamp));
                    }
                }
            });
        })
        .detach();
    }

    /// `Jump to` a prompt the window does not hold: the server reads the rows around it.
    pub(super) fn resolve_prompt(&mut self, prompt: &str, cx: &mut Context<'_, Self>) {
        let Some(id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        if !self.thread_connected(&id) {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(Some(crate::chat::OFFLINE_PROMPT_NOTICE.to_owned()), cx)
            });
            return;
        }
        let Some(connection) = self.connection_for_thread(&id) else {
            return;
        };
        let env = self.thread_env(&id).map(str::to_owned);
        let generation = self.connection_gen;
        let prompt = prompt.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.fetch_thread_window(&id, &prompt).await;
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation
                    || app.thread_env(&id).map(str::to_owned) != env
                    || app.layout.selected_thread_id.as_ref() != Some(&id)
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_tests::{
        details_tasks::{THREAD, snapshot},
        kitchen_sink_shell, mount_app,
    };
    use conn_client::{ClientEvent, Credential, ServerConfig};
    use gpui_kit::{Entity, TestAppContext};

    const ENV: &str = "http://127.0.0.1:9/";
    const OTHER: &str = "thread-failed";

    /// An app whose primary environment keeps its threads in `db`, on a server that never answers.
    fn app_on(cx: &mut TestAppContext, db: &std::path::Path) -> Entity<ConnApp> {
        let app = launch_on(cx, db);
        cx.update(|cx| app.update(cx, |app, cx| app.set_shell(kitchen_sink_shell(), cx)));
        app
    }

    /// [`app_on`] before the server sent any shell item.
    fn launch_on(cx: &mut TestAppContext, db: &std::path::Path) -> Entity<ConnApp> {
        let (_, app) = mount_app(cx);
        let config = ServerConfig {
            http_base_url: url::Url::parse(ENV).expect("server URL"),
            credential: Credential::Bearer("test".into()),
        };
        let (connection, _events) = Connection::start(config, crate::live::RT.handle());
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.threads = Threads {
                    db: Some(db.to_owned()),
                    ..Threads::default()
                };
                app.server_url = Some(ENV.to_owned());
                // A launch with a server starts with an empty list, not the demo.
                app.shell = conn_state::ShellState::default();
                app.start_engine(ENV, connection, cx);
            })
        });
        app
    }

    fn entry_ids(app: &ConnApp, id: &str) -> Vec<String> {
        app.thread(id)
            .map(|t| t.entries.iter().map(|e| e.id().to_owned()).collect())
            .unwrap_or_default()
    }

    /// A thread opens through its engine, stays in memory when the user switches away, and a
    /// fresh app on the same device draws it before any stream item arrives.
    #[gpui_kit::test]
    async fn an_opened_thread_reopens_from_the_device(cx: &mut TestAppContext) {
        // The engine answers from its database task on the runtime thread.
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().expect("database folder");
        let db = dir.path().join("threads.sqlite3");
        let first = app_on(cx, &db);
        cx.update(|cx| {
            first.update(cx, |app, cx| {
                app.select_thread(THREAD, cx);
                let item = conn_contract::from_json(snapshot(None, false)).expect("snapshot");
                app.apply_event_for_test(
                    ClientEvent::Thread {
                        thread_id: THREAD.to_owned(),
                        item,
                    },
                    cx,
                );
            })
        });
        cx.condition(&first, |app, _| !entry_ids(app, THREAD).is_empty())
            .await;
        let drawn = cx.read(|cx| entry_ids(first.read(cx), THREAD));

        // The other thread's window is read after the first one's rows were written.
        cx.update(|cx| first.update(cx, |app, cx| app.select_thread(OTHER, cx)));
        cx.condition(&first, |app, _| app.thread(OTHER).is_some())
            .await;
        cx.read(|cx| assert_eq!(entry_ids(first.read(cx), THREAD), drawn, "kept in memory"));

        let second = app_on(cx, &db);
        cx.update(|cx| second.update(cx, |app, cx| app.select_thread(THREAD, cx)));
        cx.condition(&second, |app, _| !entry_ids(app, THREAD).is_empty())
            .await;
        cx.read(|cx| {
            let app = second.read(cx);
            assert_eq!(entry_ids(app, THREAD), drawn, "drawn from the device");
            assert!(
                app.selected_timeline().is_some_and(|t| !t.synchronized),
                "ready to draw, not caught up"
            );
            assert!(
                app.chat.read(cx).timeline_rows_for_test() > 0,
                "rows, no loader"
            );
        });
    }

    /// The thread list saved on one launch draws on the next before the server sends any
    /// shell item, and is not taken as current.
    #[gpui_kit::test]
    async fn the_saved_thread_list_draws_before_the_server_answers(cx: &mut TestAppContext) {
        // The engine answers from its database task on the runtime thread.
        cx.executor().allow_parking();
        let dir = tempfile::tempdir().expect("database folder");
        let db = dir.path().join("threads.sqlite3");
        let first = app_on(cx, &db);
        cx.update(|cx| {
            first.update(cx, |app, cx| {
                app.shell.synchronized = true;
                app.save_primary_shell(true);
                // The database task answers this read after the save.
                app.select_thread(OTHER, cx);
            })
        });
        cx.condition(&first, |app, _| app.thread(OTHER).is_some())
            .await;
        let ids = |shell: &conn_state::ShellState| -> Vec<String> {
            shell.threads.iter().map(|t| t.id.clone()).collect()
        };
        let saved = cx.read(|cx| ids(&first.read(cx).shell));
        assert!(!saved.is_empty());

        let second = launch_on(cx, &db);
        cx.read(|cx| {
            let app = second.read(cx);
            assert_eq!(ids(&app.shell), saved, "drawn from the device");
            assert!(!app.shell.synchronized, "not current yet");
        });
    }
}
