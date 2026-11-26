//! The app's side of hosting browser tabs for agents (see [`crate::preview_host`]): which tabs
//! and connections the host serves, and the pages it asks the window to make.

use conn_client::ConnectionStatus;
use conn_state::BrowserTabId;
use gpui_kit::Context;
use tokio::sync::mpsc;

use super::ConnApp;
use crate::preview_host::{DesiredTab, EnvConnection, UiRequest};

impl ConnApp {
    /// Brings the preview host in line with the tabs of every thread and the connections of
    /// every environment. Cheap when nothing changed.
    pub(super) fn sync_preview_host(&mut self, cx: &mut Context<'_, Self>) {
        let envs = self.preview_envs();
        let panel = self.right_panel.read(cx);
        let tabs: Vec<DesiredTab> = self
            .thread_panels
            .all_browser_tabs(&self.right_panel_tabs)
            .into_iter()
            // A draft has no thread on the server yet.
            .filter(|(owner, _)| self.shell.find_thread(&owner.thread).is_some())
            .map(|(owner, id)| {
                let (url, title) = panel.browser_tab_facts(id, cx);
                DesiredTab {
                    owner,
                    id,
                    url,
                    title,
                }
            })
            .collect();
        let device = self.device_name();
        self.preview_host.set_device_name(device);
        self.preview_host.sync(envs, tabs);
    }

    /// The connections the host registers tabs through: the primary server's and each linked
    /// environment's. An environment stays listed while it reconnects; it is not `connected`
    /// until it is (and, for the primary, until its config snapshot confirmed who it is).
    fn preview_envs(&self) -> Vec<EnvConnection> {
        #[cfg(test)]
        if let Some(envs) = &self.preview_test_envs {
            return envs.clone();
        }
        let mut envs = Vec::new();
        if let (Some(connection), Some(_)) = (&self.connection, &self.primary_environment) {
            let connected =
                self.primary_confirmed && matches!(self.status, Some(ConnectionStatus::Connected));
            envs.push(EnvConnection::of(
                self.primary_panel_environment(),
                connection,
                connected,
            ));
        }
        for (id, connection, connected) in self.linked_links() {
            envs.push(EnvConnection::of(id, &connection, connected));
        }
        envs
    }

    /// Answers the host's requests for pages, which only the window can make.
    pub(super) fn pump_preview_requests(
        mut requests: mpsc::UnboundedReceiver<UiRequest>,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Some(request) = requests.recv().await {
                let UiRequest::Materialize(id) = request;
                let Ok(window) = this.read_with(cx, |app, _| app.preview_window) else {
                    break;
                };
                let Some(window) = window else {
                    continue;
                };
                let _ = window.update(cx, |_, window, cx| {
                    this.update(cx, |app, cx| app.materialize_preview_tab(id, window, cx))
                });
            }
        })
        .detach();
    }

    /// Makes browser tab `id`'s page while it is hidden, if a thread still holds the tab.
    fn materialize_preview_tab(
        &mut self,
        id: BrowserTabId,
        window: &mut gpui_kit::Window,
        cx: &mut Context<'_, Self>,
    ) {
        let held = self
            .thread_panels
            .all_browser_tabs(&self.right_panel_tabs)
            .iter()
            .any(|(_, tab)| *tab == id);
        if held {
            self.right_panel.update(cx, |panel, cx| {
                panel.host_browser(id, window, cx);
            });
        }
    }

    /// Gives the preview host these environments instead of the app's own connections.
    #[cfg(test)]
    pub(crate) fn set_preview_envs_for_test(
        &mut self,
        envs: Vec<EnvConnection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.preview_test_envs = Some(envs);
        self.sync_preview_host(cx);
    }

    /// The tabs the preview host serves, and the server tab of each that has a record.
    #[cfg(test)]
    pub(crate) fn preview_hosted_for_test(&self) -> Vec<(BrowserTabId, Option<String>)> {
        self.preview_host.hosted_for_test()
    }
}
