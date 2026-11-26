//! Thread links: the `conn://thread/<environmentId>/<threadId>` link "Copy thread link" writes, the
//! titles thread link chips show, and what a click on a chip opens.
//!
//! The parser for both schemes (`conn://thread/…` and the older `t3-thread://v2/…`) is
//! `conn_desktop::control::parse_thread_link`; the chip label rules are in `chat::thread_links`.

use gpui_kit::Context;

use super::ConnApp;
use crate::chat::thread_links::{ThreadDirectory, ThreadLink, fingerprint, format_thread_link};

/// What a thread link's environment id names on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LinkEnvironment {
    /// The primary server.
    Primary,
    /// A linked environment or Orbit target, by its Orbit target id.
    Target(String),
    /// Nothing here goes by that id.
    Unknown,
}

impl ConnApp {
    /// The ids the primary server goes by in a thread link: the environment id its config names
    /// (the one the Conn Server writes into its own links), and the id the app knows it by.
    fn primary_link_environments(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for id in [
            self.primary_environment.clone(),
            Some(self.primary_environment_id()),
        ]
        .into_iter()
        .flatten()
        {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    }

    /// Every thread of the merged shell with the linked environment it lives on (`None` for the
    /// primary server's).
    fn link_directory_threads(&self) -> impl Iterator<Item = (&str, Option<&str>, &str)> {
        self.shell.threads.iter().map(|thread| {
            (
                thread.id.as_str(),
                self.linked_environment_of_thread(&thread.id),
                thread.title.as_str(),
            )
        })
    }

    /// The directory chips look titles up in: the primary server's threads and every linked
    /// environment's, from the merged shell.
    pub(super) fn thread_link_directory(&self) -> ThreadDirectory {
        ThreadDirectory::new(
            self.primary_link_environments(),
            self.link_directory_threads(),
        )
    }

    /// Hands the chat the thread titles its chips show, when they changed.
    pub(super) fn sync_thread_directory(&self, cx: &mut Context<'_, Self>) {
        let primary = self.primary_link_environments();
        let print = fingerprint(&primary, self.link_directory_threads());
        self.chat.update(cx, |chat, cx| {
            chat.set_thread_directory(print, || self.thread_link_directory(), cx);
        });
    }

    /// The link "Copy thread link" writes for `thread_id`: `conn://thread/<environmentId>/<threadId>`,
    /// with the environment the thread lives on, so the link opens it on any machine.
    ///
    /// A linked thread names its environment by the id its own server reports, as the links that
    /// server writes do. An Orbit target id can differ from it, so the target id stands in only
    /// until that environment's config has loaded.
    pub(crate) fn thread_link_for(&self, thread_id: &str) -> String {
        let environment = match self.linked_environment_of_thread(thread_id) {
            Some(linked) => self
                .linked_server_environment_id(linked)
                .unwrap_or(linked)
                .to_owned(),
            None => self
                .primary_environment
                .clone()
                .unwrap_or_else(|| self.primary_environment_id()),
        };
        format_thread_link(&environment, thread_id)
    }

    /// What the environment id of a thread link names on this machine. A link carries the id its
    /// server reports for itself (`ServerConfigState::environment_id`), while Orbit targets are
    /// looked up by their target id, so either one matches: a linked environment by its Orbit
    /// target id or by the id its server reports, and the primary server by any id it goes by.
    pub(super) fn link_environment(&self, id: &str) -> LinkEnvironment {
        let targets = self.linked_target_ids();
        if targets.iter().any(|target| target == id)
            || self.orbit.fleet.find_by_server_id(id).is_some()
        {
            return LinkEnvironment::Target(id.to_owned());
        }
        if self.primary_link_environments().iter().any(|own| own == id) {
            return LinkEnvironment::Primary;
        }
        targets
            .into_iter()
            .find(|target| self.linked_server_environment_id(target) == Some(id))
            .map_or(LinkEnvironment::Unknown, LinkEnvironment::Target)
    }

    /// Opens the thread a link names, as a click on its chip does. A thread of the merged shell
    /// opens where it lives; one of another Orbit server connects to that server first (the
    /// thread opens once it is up). `false` when nothing matches.
    pub(crate) fn open_thread_link(
        &mut self,
        link: &ThreadLink,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        // Name the environment by its Orbit target id, whichever id the link carries.
        let link = &ThreadLink {
            environment_id: link.environment_id.as_ref().map(|id| {
                match self.link_environment(id) {
                    LinkEnvironment::Target(target) => target,
                    LinkEnvironment::Primary | LinkEnvironment::Unknown => id.clone(),
                }
            }),
            thread_id: link.thread_id.clone(),
        };
        if let Some(found) = self.thread_link_directory().resolve(link) {
            // The merged shell holds linked environments' threads too: selecting is enough.
            self.pending_open_thread = None;
            self.select_thread(found.thread_id, cx);
            return true;
        }
        if let Some(environment) = link.environment_id.as_deref()
            && self.linked_connection(environment).is_some()
        {
            self.open_remote_child(environment, &link.thread_id, cx);
            return true;
        }
        self.activate_thread(&link.thread_id, link.environment_id.as_deref(), cx)
    }
}
