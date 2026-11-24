//! Every thread's right panel saved to disk (`persist` of Conn's `rightPanelStore`), so tabs,
//! open state, maximize, the terminal drawer and the width come back after a restart. What
//! the panels hold is `conn_state::ThreadPanels`; this file reads and writes it, and keys the
//! primary connection's panels by the environment id its server reports.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_state::{PanelOwner, SavedThreadPanels};
use gpui_kit::{Context, Task};

use super::ConnApp;

/// How long after the last change the panels are written (a page navigating, a seam drag).
pub(super) const THREAD_PANEL_SAVE_DELAY: Duration = Duration::from_millis(500);

/// Where the panels are saved: beside the drafts, so `CONN_GPUI_CONFIG_DIR` and tests (no
/// file at all) cover both.
pub(super) fn thread_panels_file_path() -> Option<PathBuf> {
    crate::drafts::drafts_file_path().map(|path| path.with_file_name("thread-panels.json"))
}

/// The panels' saving state.
#[derive(Default)]
pub(super) struct PanelSaves {
    pub(super) path: Option<PathBuf>,
    /// What was handed to the writer last; an unchanged layout is not written again.
    last: Option<SavedThreadPanels>,
    /// The pending debounced save; replacing it restarts the delay.
    scheduled: Option<Task<()>>,
    /// Numbers each write, so a slow older write never lands over a newer one.
    sequence: u64,
    /// The sequence number written last; the lock also keeps writes one at a time.
    written: Arc<Mutex<u64>>,
    /// The live tree's first per-thread layouts (`thread-panels/<hash>.json`), by file stem,
    /// until the thread they belong to shows.
    live_layouts: HashMap<String, String>,
    #[cfg(test)]
    pub(super) writes: Arc<std::sync::atomic::AtomicUsize>,
}

impl PanelSaves {
    pub(super) fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            ..Self::default()
        }
    }
}

impl ConnApp {
    /// Reads the saved panels of threads this session has not touched yet. Restored browser
    /// tabs load their address when they first show.
    pub(super) fn restore_thread_panels(&mut self, cx: &mut Context<'_, Self>) {
        let Some(path) = self.panel_saves.path.clone() else {
            return;
        };
        self.panel_saves.live_layouts = read_live_layouts(&path.with_file_name("thread-panels"));
        let Ok(json) = std::fs::read_to_string(&path) else {
            return;
        };
        for (id, url) in self
            .thread_panels
            .restore(SavedThreadPanels::from_json(&json))
        {
            self.right_panel
                .update(cx, |panel, cx| panel.navigate_browser(id, url, cx));
        }
    }

    /// Writes every thread's panel a little after the last change, off the UI thread.
    pub(super) fn save_thread_panels(&mut self, cx: &mut Context<'_, Self>) {
        if self.panel_saves.path.is_none() {
            return;
        }
        self.panel_saves.scheduled = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(THREAD_PANEL_SAVE_DELAY)
                .await;
            let _ = this.update(cx, |app, cx| {
                if let Some(write) = app.flush_thread_panels(cx) {
                    write.detach();
                }
            });
        }));
    }

    /// Hands the current layout to a background write now, if it changed since the last one.
    /// Quitting awaits the returned task.
    pub(super) fn flush_thread_panels(&mut self, cx: &mut Context<'_, Self>) -> Option<Task<()>> {
        self.panel_saves.scheduled = None;
        let path = self.panel_saves.path.clone()?;
        let shown = self.shown_thread_panel();
        let panel = self.right_panel.read(cx);
        let saved = self
            .thread_panels
            .save(&shown, |id| panel.browser_address(id, cx));
        if self.panel_saves.last.as_ref() == Some(&saved) {
            return None;
        }
        self.panel_saves.last = Some(saved.clone());
        self.panel_saves.sequence += 1;
        let sequence = self.panel_saves.sequence;
        let written = Arc::clone(&self.panel_saves.written);
        #[cfg(test)]
        let writes = Arc::clone(&self.panel_saves.writes);
        Some(cx.background_executor().spawn(async move {
            let json = saved.to_json();
            let Ok(mut last) = written.lock() else {
                return;
            };
            if *last >= sequence {
                return;
            }
            match crate::drafts::write_drafts_file(&path, &json) {
                Ok(()) => *last = sequence,
                Err(error) => eprintln!("could not save thread panels: {error}"),
            }
            #[cfg(test)]
            writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }))
    }

    /// The shown thread's panel as `ThreadPanels` keeps it.
    pub(super) fn shown_thread_panel(&self) -> conn_state::ThreadPanel {
        conn_state::ThreadPanel {
            tabs: self.right_panel_tabs.clone(),
            open: self.layout.right_panel_open,
            maximized: self.right_panel_maximized,
            terminal_open: self.terminal_drawer_open,
            width: Some(self.layout.right_panel_width),
        }
    }

    /// The environment part of the primary connection's panel owners: the environment id its
    /// server reported, else a key of this connection alone until it does.
    pub(super) fn primary_panel_environment(&self) -> String {
        self.primary_environment
            .clone()
            .unwrap_or_else(|| PanelOwner::provisional_environment(&self.provisional_panel_session))
    }

    /// The primary server reported its environment id (`ServerConfig.environment`). The first
    /// time on this connection, the panels made before move to it, and so do panels saved by
    /// versions that did not record an environment. A different id later is another server
    /// behind the same address: it gets its own panels, and inherits none.
    pub(super) fn learn_primary_environment(&mut self, id: String, cx: &mut Context<'_, Self>) {
        if self.primary_environment.as_deref() == Some(id.as_str()) {
            return;
        }
        let provisional = self
            .primary_environment
            .is_none()
            .then(|| self.primary_panel_environment());
        // Park the shown panel under its old key, so it moves with the rest.
        self.switch_panel_owner(None);
        self.primary_environment = Some(id.clone());
        if let Some(provisional) = provisional {
            let mut dropped = self.thread_panels.migrate_environment(&provisional, &id);
            dropped.extend(
                self.thread_panels
                    .migrate_environment(PanelOwner::LEGACY_PRIMARY, &id),
            );
            self.right_panel.update(cx, |panel, cx| {
                for tab in dropped {
                    panel.close_surface(&conn_state::PanelSurface::Browser(tab), cx);
                }
                panel.migrate_environment(&provisional, &id, cx);
            });
        }
        self.sync_chat(cx);
        self.save_thread_panels(cx);
        cx.notify();
    }

    /// The primary connection ended (a server switch): until the next server says who it is,
    /// its panels are its own.
    pub(super) fn forget_primary_environment(&mut self) {
        self.primary_environment = None;
        self.provisional_panel_session = crate::commands::new_thread_id();
    }

    /// Reads the live tree's layout for `owner`, if one waits and this session has no panel
    /// for it. That tree named each file by a hash of the environment it knew and the thread.
    pub(super) fn import_live_layout(&mut self, owner: &PanelOwner) {
        if self.panel_saves.live_layouts.is_empty() || self.thread_panels.knows(owner) {
            return;
        }
        let mut environments = Vec::new();
        if !owner.is_provisional() {
            environments.push(owner.environment.clone());
        }
        if self.linked_environment_of_thread(&owner.thread).is_none() {
            environments.push(self.primary_environment_id());
            environments.extend(self.server_url.clone());
        }
        for environment in environments {
            let key = format!("{}:{}{}", environment.len(), environment, owner.thread);
            let stem = conn_desktop::control::short_state_hash(&key);
            if let Some(json) = self.panel_saves.live_layouts.remove(&stem) {
                if let Some(saved) = conn_state::saved_panel_from_live_layout(owner.clone(), &json)
                {
                    self.thread_panels.restore(SavedThreadPanels {
                        threads: vec![saved],
                        undecoded: Vec::new(),
                    });
                }
                return;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn set_thread_panels_path_for_test(
        &mut self,
        path: PathBuf,
        cx: &mut Context<'_, Self>,
    ) {
        self.panel_saves.path = Some(path);
        self.restore_thread_panels(cx);
    }

    /// Writes now instead of after the delay; `run_until_parked` finishes the write.
    #[cfg(test)]
    pub(crate) fn save_thread_panels_for_test(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(write) = self.flush_thread_panels(cx) {
            write.detach();
        }
    }

    #[cfg(test)]
    pub(crate) fn thread_panel_writes_for_test(&self) -> usize {
        self.panel_saves
            .writes
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// What the server-config snapshot does when it names the primary's environment.
    #[cfg(test)]
    pub(crate) fn learn_primary_environment_for_test(
        &mut self,
        id: &str,
        cx: &mut Context<'_, Self>,
    ) {
        self.learn_primary_environment(id.to_owned(), cx);
    }

    #[cfg(test)]
    pub(crate) fn set_server_url_for_test(&mut self, url: Option<&str>) {
        self.server_url = url.map(str::to_owned);
    }
}

/// The live tree's per-thread layout files, by file stem. A missing folder gives none.
fn read_live_layouts(directory: &Path) -> HashMap<String, String> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return HashMap::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension()? == "json").then_some(())?;
            let stem = path.file_stem()?.to_str()?.to_owned();
            Some((stem, std::fs::read_to_string(&path).ok()?))
        })
        .collect()
}
