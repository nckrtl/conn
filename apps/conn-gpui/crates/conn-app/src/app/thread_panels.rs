//! Every thread's right panel saved to disk (`persist` of Conn's `rightPanelStore`), so tabs,
//! open state, maximize, the terminal drawer and the width come back after a restart. What
//! the panels hold is `conn_state::ThreadPanels`; this file reads and writes it.

use std::path::PathBuf;

use conn_state::SavedThreadPanels;
use gpui_kit::{App, Context};

use super::ConnApp;

/// Where the panels are saved: beside the drafts, so `CONN_GPUI_CONFIG_DIR` and tests (no
/// file at all) cover both.
pub(super) fn thread_panels_file_path() -> Option<PathBuf> {
    crate::drafts::drafts_file_path().map(|path| path.with_file_name("thread-panels.json"))
}

impl ConnApp {
    /// Reads the saved panels of threads this session has not touched yet. Restored browser
    /// tabs load their address when they first show.
    pub(super) fn restore_thread_panels(&mut self, cx: &mut Context<'_, Self>) {
        let Some(json) = self
            .thread_panels_path
            .as_deref()
            .and_then(|path| std::fs::read_to_string(path).ok())
        else {
            return;
        };
        let saved = SavedThreadPanels::from_json(&json);
        for (id, url) in self.thread_panels.restore(saved) {
            self.right_panel
                .update(cx, |panel, cx| panel.navigate_browser(id, url, cx));
        }
        self.saved_thread_panels_json = Some(json);
    }

    /// Writes every thread's panel when it changed since the last write.
    pub(super) fn save_thread_panels(&mut self, cx: &App) {
        let Some(path) = self.thread_panels_path.clone() else {
            return;
        };
        let shown = self.shown_thread_panel();
        let panel = self.right_panel.read(cx);
        let json = self
            .thread_panels
            .save(&shown, |id| panel.browser_address(id, cx))
            .to_json();
        if self.saved_thread_panels_json.as_deref() == Some(json.as_str()) {
            return;
        }
        if let Err(error) = crate::drafts::write_drafts_file(&path, &json) {
            eprintln!("could not save thread panels: {error}");
            return;
        }
        self.saved_thread_panels_json = Some(json);
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

    #[cfg(test)]
    pub(crate) fn set_thread_panels_path_for_test(
        &mut self,
        path: PathBuf,
        cx: &mut Context<'_, Self>,
    ) {
        self.thread_panels_path = Some(path);
        self.restore_thread_panels(cx);
    }

    #[cfg(test)]
    pub(crate) fn save_thread_panels_for_test(&mut self, cx: &mut Context<'_, Self>) {
        self.save_thread_panels(cx);
    }
}
