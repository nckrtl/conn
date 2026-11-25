//! Thread links: the `conn://thread/<environmentId>/<threadId>` link "Copy thread link" writes, the
//! titles thread link chips show, and what a click on a chip opens.
//!
//! The parser for both schemes (`conn://thread/…` and the older `t3-thread://v2/…`) is
//! `conn_desktop::control::parse_thread_link`; the chip label rules are in `chat::thread_links`.

use gpui_kit::Context;

use super::ConnApp;
use crate::chat::thread_links::{ThreadDirectory, ThreadLink, fingerprint, format_thread_link};

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
    pub(crate) fn thread_link_for(&self, thread_id: &str) -> String {
        let environment = self
            .linked_environment_of_thread(thread_id)
            .map(str::to_owned)
            .or_else(|| self.primary_environment.clone())
            .unwrap_or_else(|| self.primary_environment_id());
        format_thread_link(&environment, thread_id)
    }

    /// Opens the thread a link names, as a click on its chip does. A thread of the merged shell
    /// opens where it lives; one of another Orbit server connects to that server first (the
    /// thread opens once it is up). `false` when nothing matches.
    pub(crate) fn open_thread_link(
        &mut self,
        link: &ThreadLink,
        cx: &mut Context<'_, Self>,
    ) -> bool {
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
