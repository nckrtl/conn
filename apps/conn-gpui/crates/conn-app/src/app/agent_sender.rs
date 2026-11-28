//! The sender of an agent's message: the title its card shows and opening its thread
//! (web `TimelineUserMessageRow.tsx` sender title and `useThreadLifecycle.tsx`
//! `onOpenRelatedThread`).

use conn_state::AgentMessageSender;
use gpui_kit::Context;

use super::ConnApp;
use super::thread_links::LinkEnvironment;
use crate::chat::SenderView;

const SENDER_GONE: &str = "This thread is no longer available.";

/// Where a sender's thread lives: the linked environment by its Orbit target id (`None` is the
/// primary server), and the thread id.
type SenderThread = (Option<String>, String);

impl ConnApp {
    /// The sender's thread, when this app can reach its environment. A local sender shares the
    /// environment of `viewed`, the thread its message arrived in.
    fn sender_thread(
        &self,
        sender: &AgentMessageSender,
        viewed: Option<&str>,
    ) -> Option<SenderThread> {
        match sender {
            AgentMessageSender::LocalThread(thread_id) => Some((
                viewed
                    .and_then(|id| self.linked_environment_of_thread(id))
                    .map(str::to_owned),
                thread_id.clone(),
            )),
            AgentMessageSender::Linked {
                environment_id,
                thread_id,
                ..
            } => match self.link_environment(environment_id) {
                LinkEnvironment::Primary => Some((None, thread_id.clone())),
                LinkEnvironment::Target(target) if self.linked_connection(&target).is_some() => {
                    Some((Some(target), thread_id.clone()))
                }
                LinkEnvironment::Target(_) | LinkEnvironment::Unknown => None,
            },
            AgentMessageSender::LinkedTitle(_) => None,
        }
    }

    /// The shell row of `thread_id` on exactly `environment`, never a same-id thread elsewhere.
    fn shell_thread_on(
        &self,
        environment: Option<&str>,
        thread_id: &str,
    ) -> Option<&conn_state::ThreadShell> {
        self.shell
            .find_thread(thread_id)
            .filter(|_| self.linked_environment_of_thread(thread_id) == environment)
    }

    /// The card's sender title and whether it can open the sender. A linked sender's current title
    /// wins over the one delivered with the message; an unreachable environment keeps the title
    /// and has no action.
    pub(super) fn agent_sender_view(
        &self,
        sender: &AgentMessageSender,
        viewed: Option<&str>,
    ) -> SenderView {
        let delivered = match sender {
            AgentMessageSender::Linked { title, .. } | AgentMessageSender::LinkedTitle(title) => {
                title.trim()
            }
            AgentMessageSender::LocalThread(_) => "",
        };
        let Some((environment, thread_id)) = self.sender_thread(sender, viewed) else {
            return SenderView {
                title: delivered.to_owned(),
                can_open: false,
            };
        };
        let current = self
            .shell_thread_on(environment.as_deref(), &thread_id)
            .map(|thread| thread.title.trim())
            .filter(|title| !title.is_empty());
        SenderView {
            title: current.unwrap_or(delivered).to_owned(),
            can_open: true,
        }
    }

    /// Opens the sender's thread. The shell leaves idle children and unloaded settled pages out,
    /// so a thread it does not list is asked of its own server first; a deleted or missing thread
    /// says so and keeps the open thread.
    pub(super) fn open_agent_sender(
        &mut self,
        sender: &AgentMessageSender,
        cx: &mut Context<'_, Self>,
    ) {
        self.sender_open_generation += 1;
        let generation = self.sender_open_generation;
        let viewed = self.layout.selected_thread_id.clone();
        let Some((environment, thread_id)) = self.sender_thread(sender, viewed.as_deref()) else {
            return;
        };
        if let Some(thread) = self.shell_thread_on(environment.as_deref(), &thread_id) {
            if thread.deleted_at.is_some() {
                self.show_chat_error(SENDER_GONE.to_owned(), cx);
            } else {
                self.open_sender_thread(environment, thread_id, cx);
            }
            return;
        }
        let connection = match environment.as_deref() {
            None => self.connection.clone(),
            Some(target) => self.linked_connection(target),
        };
        let Some(connection) = connection else {
            self.show_chat_error("Connect to open this thread.".to_owned(), cx);
            return;
        };
        cx.spawn(async move |this, cx| {
            let live = connection.thread_is_live(&thread_id).await;
            let _ = this.update(cx, |app, cx| {
                // Only the latest click acts, and only while its thread is still open.
                if app.sender_open_generation != generation
                    || app.layout.selected_thread_id != viewed
                {
                    return;
                }
                match live {
                    Ok(true) => app.open_sender_thread(environment, thread_id, cx),
                    Ok(false) => app.show_chat_error(SENDER_GONE.to_owned(), cx),
                    Err(err) => app.show_chat_error(format!("Couldn’t open the thread: {err}"), cx),
                }
            });
        })
        .detach();
    }

    fn open_sender_thread(
        &mut self,
        environment: Option<String>,
        thread_id: String,
        cx: &mut Context<'_, Self>,
    ) {
        match environment {
            Some(target) => self.open_remote_child(&target, &thread_id, cx),
            None if self.shell.find_thread(&thread_id).is_some()
                && self.linked_environment_of_thread(&thread_id).is_some() =>
            {
                self.show_chat_error(
                    "This thread ID is also in another environment.".to_owned(),
                    cx,
                );
            }
            None => self.select_thread(thread_id, cx),
        }
    }

    fn show_chat_error(&self, message: String, cx: &mut Context<'_, Self>) {
        self.chat
            .update(cx, |chat, cx| chat.set_error(Some(message), cx));
    }
}
