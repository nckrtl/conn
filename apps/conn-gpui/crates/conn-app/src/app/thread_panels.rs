//! Conn's right-panel workspace belongs to a scoped thread (web `rightPanelStore`).
use super::*;
use crate::panels::{RightPanel, RightPanelEvent};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct PanelOwner {
    pub(super) environment: String,
    pub(super) id: String,
}

impl PanelOwner {
    fn path(&self, directory: &Path) -> PathBuf {
        let key = format!("{}:{}{}", self.environment.len(), self.environment, self.id);
        let name = conn_desktop::control::short_state_hash(&key);
        directory.join(format!("{name}.json"))
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(super) struct PanelLayout {
    open: bool,
    tabs: Vec<PanelSurface>,
    selected: Option<PanelSurface>,
    maximized: bool,
}

impl PanelLayout {
    fn load(owner: &PanelOwner, directory: Option<&Path>) -> Self {
        directory
            .map(|dir| owner.path(dir))
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, owner: &PanelOwner, directory: Option<&Path>) {
        let Some(directory) = directory else { return };
        let path = owner.path(directory);
        if self == &Self::default() {
            let _ = std::fs::remove_file(path);
        } else if let Ok(json) = serde_json::to_string(self)
            && let Err(error) = crate::drafts::write_drafts_file(&path, &json)
        {
            eprintln!("could not save thread panel: {error}");
        }
    }

    fn open_surface(&mut self, surface: PanelSurface) {
        if !self.tabs.contains(&surface) {
            self.tabs.push(surface.clone());
        }
        self.selected = Some(surface);
        self.open = true;
    }
}

#[derive(Default)]
pub(super) struct ThreadPanels {
    directory: Option<PathBuf>,
    pub(super) owner: Option<PanelOwner>,
    layouts: HashMap<PanelOwner, PanelLayout>,
    views: HashMap<PanelOwner, Entity<RightPanel>>,
    drawers: HashSet<PanelOwner>,
    pending_sql: HashMap<PanelOwner, String>,
}

impl ThreadPanels {
    pub(super) fn new() -> Self {
        Self {
            directory: crate::drafts::drafts_file_path()
                .map(|path| path.with_file_name("thread-panels")),
            ..Self::default()
        }
    }

    pub(super) fn promote_draft(&mut self, old: &PanelOwner, id: String) {
        let next = PanelOwner {
            environment: old.environment.clone(),
            id,
        };
        if *old == next {
            return;
        }
        if self.owner.as_ref() == Some(old) {
            self.owner = Some(next.clone());
        }
        let layout = self
            .layouts
            .remove(old)
            .unwrap_or_else(|| PanelLayout::load(old, self.directory.as_deref()));
        if layout != PanelLayout::default() {
            layout.save(&next, self.directory.as_deref());
            self.layouts.insert(next.clone(), layout);
        }
        if let Some(view) = self.views.remove(old) {
            self.views.insert(next.clone(), view);
        }
        if self.drawers.remove(old) {
            self.drawers.insert(next.clone());
        }
        if let Some(sql) = self.pending_sql.remove(old) {
            self.pending_sql.insert(next, sql);
        }
        PanelLayout::default().save(old, self.directory.as_deref());
    }

    pub(super) fn parked_views(&self) -> impl Iterator<Item = &Entity<RightPanel>> {
        self.views.values()
    }

    pub(super) fn prepare(&mut self, owner: PanelOwner, tab: RightPanelTab, sql: Option<String>) {
        let layout = self
            .layouts
            .entry(owner.clone())
            .or_insert_with(|| PanelLayout::load(&owner, self.directory.as_deref()));
        let surface = layout
            .selected
            .as_ref()
            .filter(|s| s.kind() == tab)
            .or_else(|| layout.tabs.iter().find(|s| s.kind() == tab))
            .cloned()
            .unwrap_or(PanelSurface::Kind(tab));
        layout.open_surface(surface);
        layout.save(&owner, self.directory.as_deref());
        if let Some(sql) = sql {
            self.pending_sql.insert(owner, sql);
        }
    }

    pub(super) fn forget(&mut self, owner: &PanelOwner) {
        self.layouts.remove(owner);
        self.views.remove(owner);
        self.drawers.remove(owner);
        self.pending_sql.remove(owner);
        PanelLayout::default().save(owner, self.directory.as_deref());
    }
}

impl ConnApp {
    pub(super) fn remember_panel_layout(&mut self) {
        let Some(owner) = self.thread_panels.owner.clone() else {
            return;
        };
        let layout = PanelLayout {
            open: self.layout.right_panel_open,
            selected: (!self.right_panel_open_tabs.is_empty()).then(|| self.right_panel_surface()),
            tabs: self.right_panel_open_tabs.clone(),
            maximized: self.right_panel_maximized,
        };
        layout.save(&owner, self.thread_panels.directory.as_deref());
        self.thread_panels.layouts.insert(owner, layout);
    }

    pub(super) fn sync_panel_owner(&mut self, cx: &mut Context<'_, Self>) {
        let id = self
            .layout
            .selected_thread_id
            .as_ref()
            .or_else(|| self.draft.as_ref().map(|d| &d.draft_id));
        let next = id.map(|id| PanelOwner {
            environment: self
                .context_environment()
                .unwrap_or_else(|| self.primary_environment_id()),
            id: id.clone(),
        });
        if self.thread_panels.owner == next {
            return;
        }
        let old = self.thread_panels.owner.take();
        if let Some(panel) = self.right_panel.take() {
            panel.update(cx, |p, cx| p.set_surface_visible(false, cx));
            if let Some(owner) = &old
                && (!self.right_panel_open_tabs.is_empty() || self.terminal_drawer_open)
            {
                self.thread_panels.views.insert(owner.clone(), panel);
            }
        }
        if let Some(owner) = old
            && self.terminal_drawer_open
        {
            self.thread_panels.drawers.insert(owner);
        }
        let mut layout = PanelLayout::default();
        self.terminal_drawer_open = false;
        if let Some(owner) = &next {
            layout = self
                .thread_panels
                .layouts
                .get(owner)
                .cloned()
                .unwrap_or_else(|| {
                    PanelLayout::load(owner, self.thread_panels.directory.as_deref())
                });
            self.right_panel = self.thread_panels.views.remove(owner);
            if let Some(panel) = &self.right_panel {
                let config = self.active_server_config();
                panel.update(cx, |p, cx| {
                    p.reload_project_settings(cx);
                    p.set_server_config(config, cx);
                });
            }
            self.terminal_drawer_open = self.thread_panels.drawers.remove(owner);
        }
        self.layout.right_panel_open = layout.open;
        self.layout.right_panel_tab = layout
            .selected
            .as_ref()
            .map_or(RightPanelTab::Files, PanelSurface::kind);
        self.selected_panel_surface = layout
            .selected
            .unwrap_or(PanelSurface::Kind(RightPanelTab::Files));
        self.right_panel_open_tabs = layout.tabs;
        self.right_panel_maximized = layout.maximized;
        self.right_panel_add_menu_open = false;
        self.seam_drag = None;
        self.thread_panels.owner = next;
    }

    pub(super) fn ensure_right_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<RightPanel> {
        if let Some(panel) = &self.right_panel {
            return panel.clone();
        }
        let connection = self.context_connection();
        let panel = cx.new(|cx| {
            let mut panel = RightPanel::new(
                self.tokens.clone(),
                connection,
                self.tasks_runtime.clone(),
                window,
                cx,
            );
            panel.set_embedded(true, cx);
            panel.set_server_config(self.active_server_config(), cx);
            panel
        });
        cx.subscribe_in(
            &panel,
            window,
            |app, source, event: &RightPanelEvent, window, cx| {
                if app.right_panel.as_ref() != Some(source) {
                    return;
                }
                match event {
                    RightPanelEvent::DisplayedFileChanged => cx.notify(),
                    RightPanelEvent::Definition(location) => {
                        app.show_source_location(location, window, cx)
                    }
                    RightPanelEvent::AttachSource(source) => app
                        .chat
                        .update(cx, |chat, cx| chat.attach_source(source, window, cx)),
                    RightPanelEvent::OpenFile(path) => {
                        app.select_right_panel_surface(PanelSurface::File(path.clone()), cx)
                    }
                    RightPanelEvent::OpenBrowser(url) => app.browse(url.clone(), window, cx),
                    RightPanelEvent::OpenTab(tab) => app.select_right_panel_tab(*tab, cx),
                    RightPanelEvent::InsertMention(mention) => app
                        .chat
                        .update(cx, |chat, cx| chat.insert_mention(mention, window, cx)),
                    RightPanelEvent::SendPrompt(prompt) => app.send_prompt(prompt.clone(), cx),
                    RightPanelEvent::Annotation(action) => {
                        app.handle_annotation_action(action.clone(), cx)
                    }
                }
            },
        )
        .detach();
        self.right_panel = Some(panel.clone());
        self.sync_chat(cx);
        panel
    }

    pub(super) fn apply_pending_panel_sql(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(owner) = &self.thread_panels.owner
            && let Some(panel) = &self.right_panel
            && let Some(sql) = self.thread_panels.pending_sql.remove(owner)
        {
            panel.update(cx, |p, cx| p.set_database_sql(sql, cx));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;
    use gpui_kit::test::TestWindowExt as _;

    #[gpui_kit::test]
    fn right_panel_restores_tabs_and_live_views_per_thread(cx: &mut TestAppContext) {
        let (window, app) = crate::ui_tests::mount_app(cx);
        cx.update_window(window, |_, window, cx| {
            let file = PanelSurface::File("src/main.rs".to_owned());
            app.update(cx, |app, cx| {
                app.select_thread("a", cx);
                app.select_right_panel_tab(RightPanelTab::Files, cx);
                app.select_right_panel_surface(file.clone(), cx);
                app.right_panel_maximized = true;
                app.remember_panel_layout();
            });
            window.render_frame(cx);
            let a_view = app
                .read(cx)
                .right_panel
                .clone()
                .expect("A mounted its file panel");

            app.update(cx, |app, cx| app.select_thread("b", cx));
            window.render_frame(cx);
            app.update(cx, |app, cx| {
                assert!(
                    !app.layout.right_panel_open && app.right_panel_open_tabs.is_empty(),
                    "new thread starts closed and empty"
                );
                app.select_right_panel_tab(RightPanelTab::Diff, cx);
            });
            window.render_frame(cx);
            let b_view = app
                .read(cx)
                .right_panel
                .clone()
                .expect("B mounted its diff panel");
            assert_ne!(a_view, b_view, "different threads own separate live views");
            app.update(cx, |app, cx| {
                app.toggle_right_panel(cx);
                app.select_thread("a", cx);
            });
            window.render_frame(cx);
            app.update(cx, |app, cx| {
                assert!(
                    app.layout.right_panel_open && app.right_panel_maximized,
                    "A restores its open maximized panel"
                );
                assert_eq!(
                    app.right_panel_open_tabs,
                    [PanelSurface::Kind(RightPanelTab::Files), file.clone()]
                );
                assert_eq!(app.right_panel_surface(), file);
                assert_eq!(app.right_panel.as_ref(), Some(&a_view));
                app.select_thread("b", cx);
                assert!(!app.layout.right_panel_open, "B remembers being hidden");
                app.toggle_right_panel(cx);
                app.close_right_panel_tab(&PanelSurface::Kind(RightPanelTab::Diff), cx);
                app.toggle_right_panel(cx);
                assert!(
                    app.right_panel_shows_launcher(),
                    "closing the final tab clears it"
                );
            });
            window.render_frame(cx);
        })
        .expect("the mounted window should be available");
    }

    /// Emits what a changed-files row or header click emits. GPUI delivers the event to the app
    /// when the surrounding update ends, so callers assert in a later update.
    fn click_changed_file(
        app: &Entity<ConnApp>,
        turn: Option<i64>,
        file: &str,
        cx: &mut gpui_kit::App,
    ) {
        let chat = app.read(cx).chat.clone();
        let event = crate::chat::ChatEvent::OpenTurnDiff {
            run_id: "run-1".to_owned(),
            app_run_ordinal: turn,
            file_path: Some(file.to_owned()),
        };
        chat.update(cx, |_, cx| cx.emit(event));
    }

    #[gpui_kit::test]
    fn changed_files_click_opens_the_turn_diff_on_new_and_existing_panels(cx: &mut TestAppContext) {
        let (window, app) = crate::ui_tests::mount_app(cx);
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| app.select_thread("a", cx));
            window.render_frame(cx);
        })
        .expect("the mounted window should be available");

        // A file row click on a thread whose panel was never opened.
        cx.update_window(window, |_, _, cx| {
            click_changed_file(&app, Some(1), "src/a.rs", cx);
        })
        .expect("the mounted window should be available");
        cx.run_until_parked();
        // The frame binds the new panel to its thread, which must keep the requested turn.
        cx.update_window(window, |_, window, cx| window.render_frame(cx))
            .expect("the mounted window should be available");
        cx.run_until_parked();
        let panel = cx
            .update_window(window, |_, _, cx| {
                let app = app.read(cx);
                assert_eq!(
                    app.right_panel_surface().kind(),
                    RightPanelTab::Diff,
                    "the click selected the Diff tab"
                );
                app.right_panel.clone()
            })
            .expect("the mounted window should be available")
            .expect("the click mounted the right panel");
        cx.update_window(window, |_, _, cx| {
            assert_eq!(
                panel.read(cx).diff_focus_state(cx),
                ("Turn 1".to_owned(), Some("src/a.rs".to_owned())),
                "Turn 0 to 1, file still to reveal"
            );
        })
        .expect("the mounted window should be available");

        // Another file in a later turn, on the panel that now exists.
        cx.update_window(window, |_, _, cx| {
            click_changed_file(&app, Some(2), "src/b.rs", cx);
        })
        .expect("the mounted window should be available");
        cx.run_until_parked();
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            assert_eq!(
                panel.read(cx).diff_focus_state(cx),
                ("Turn 2".to_owned(), Some("src/b.rs".to_owned()))
            );
        })
        .expect("the mounted window should be available");
    }

    #[cfg(feature = "automation")]
    #[gpui_kit::test]
    fn browser_tabs_keep_their_pages_when_switched_and_closed(cx: &mut TestAppContext) {
        let (window, app) = crate::ui_tests::mount_app(cx);
        cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| {
                app.select_thread("a", cx);
                app.browse("https://one.example/".into(), window, cx);
                app.add_right_panel_tab(RightPanelTab::Browser, cx);
                app.browse("https://two.example/".into(), window, cx);
            });
            window.render_frame(cx);
            let first = PanelSurface::Kind(RightPanelTab::Browser);
            let second = PanelSurface::Browser(2);
            app.update(cx, |app, cx| {
                assert_eq!(app.right_panel_open_tabs, [first.clone(), second.clone()]);
                assert_eq!(app.browser_state(cx)["target"], "https://two.example/");
                app.select_right_panel_surface(first.clone(), cx);
                assert_eq!(app.browser_state(cx)["target"], "https://one.example/");
                app.select_thread("b", cx);
                app.select_thread("a", cx);
                app.select_right_panel_surface(second.clone(), cx);
                assert_eq!(app.browser_state(cx)["target"], "https://two.example/");
                app.close_right_panel_tab(&second, cx);
                assert_eq!(app.browser_state(cx)["target"], "https://one.example/");
                app.add_right_panel_tab(RightPanelTab::Browser, cx);
            });
            window.render_frame(cx);
            assert_ne!(
                app.read(cx).browser_state(cx)["target"],
                "https://two.example/",
                "a closed page is released"
            );
        })
        .expect("mounted test window");
    }

    #[test]
    fn right_panel_background_requests_and_serialized_layout_are_scoped_by_environment() {
        let directory = std::env::temp_dir().join(crate::commands::new_thread_id());
        let mut panels = ThreadPanels {
            directory: Some(directory.clone()),
            ..ThreadPanels::default()
        };
        let a = PanelOwner {
            environment: "A".into(),
            id: "same".into(),
        };
        let b = PanelOwner {
            environment: "B".into(),
            id: "same".into(),
        };
        panels.prepare(a.clone(), RightPanelTab::Files, None);
        panels.prepare(b.clone(), RightPanelTab::Database, Some("select 1".into()));
        assert_eq!(
            panels.layouts[&a].selected,
            Some(PanelSurface::Kind(RightPanelTab::Files))
        );
        assert!(!panels.pending_sql.contains_key(&a));
        assert_eq!(panels.pending_sql[&b], "select 1");
        for owner in [&a, &b] {
            assert_eq!(
                PanelLayout::load(owner, Some(&directory)),
                panels.layouts[owner],
                "a fresh store restores each owner"
            );
        }
        panels.forget(&b);
        assert!(
            !b.path(&directory).exists(),
            "deletion removes only B's layout"
        );
        assert!(a.path(&directory).exists());
        std::fs::remove_dir_all(directory).expect("clean up temporary layout files");
    }
}
