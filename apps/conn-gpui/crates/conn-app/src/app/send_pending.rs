//! Messages on their way to the server.
//!
//! A send that the server has not taken yet shows as a row in the tray above the composer:
//! "Waiting for connection" while the thread's server is away, else "Sending…" once it takes
//! longer than a moment. conn-client sends it again after a reconnect (the server dedupes it by
//! `commandId`). After [`SEND_TIMEOUT`] the app stops waiting: the row goes, an error shows, and
//! the message goes back to the composer.
//!
//! A send that failed without an answer from the server may still have landed. Its ids stay with
//! the returned draft, so sending it again unchanged reuses its `commandId`: the server answers
//! that from the first send's receipt instead of posting the message twice. An edited draft is a
//! new message with new ids.

use std::collections::HashMap;
use std::time::Duration;

use conn_client::commands::MessageIds;
use conn_client::{ClientError, Connection};
use conn_contract::ChatAttachment;
use futures::future::Either;
use gpui_kit::Context;

use super::ConnApp;
use crate::chat::PendingSendRow;

/// How long a send waits for the server before it fails and its draft comes back.
pub(crate) const SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// A send on a live connection shows its row only after this long, so a normal send does not
/// flash one.
pub(crate) const SLOW_SEND_AFTER: Duration = Duration::from_millis(500);

/// One message the server has not taken yet.
#[derive(Clone, Debug)]
struct PendingSend {
    id: u64,
    thread_id: String,
    text: String,
    attachment_count: usize,
    /// The send outlasted [`SLOW_SEND_AFTER`].
    slow: bool,
}

/// A message that came back to the composer after a send with no answer, and the ids it went
/// with.
#[derive(Clone, Debug)]
struct Unsent {
    text: String,
    attachments: Vec<ChatAttachment>,
    ids: MessageIds,
}

/// How a send ended.
#[derive(Debug)]
pub(crate) enum SendOutcome {
    /// The server took the message.
    Sent,
    /// The server answered with a refusal, so the message did not land.
    Refused(String),
    /// No answer: the connection went away or [`SEND_TIMEOUT`] passed. The message may have
    /// landed.
    NoAnswer(String),
}

impl SendOutcome {
    fn of(result: Result<serde_json::Value, ClientError>) -> Self {
        match result {
            Ok(_) => Self::Sent,
            Err(err @ (ClientError::Connection(_) | ClientError::Closed)) => {
                Self::NoAnswer(format!(
                    "Send failed: {}",
                    crate::commands::format_client_error(&err)
                ))
            }
            Err(err) => Self::Refused(format!(
                "Send failed: {}",
                crate::commands::format_client_error(&err)
            )),
        }
    }

    fn timed_out() -> Self {
        Self::NoAnswer(format!(
            "No answer from the server in {}s. Send again to retry.",
            SEND_TIMEOUT.as_secs()
        ))
    }
}

/// The app's sends in flight, and the returned drafts whose ids a resend reuses.
#[derive(Debug, Default)]
pub(crate) struct PendingSends {
    next_id: u64,
    sends: Vec<PendingSend>,
    /// By thread id.
    unsent: HashMap<String, Unsent>,
}

impl PendingSends {
    /// The ids for sending `text` and `attachments` to `thread_id`: the returned draft's when
    /// they are its message unchanged, else new ones. Either way the returned draft is used up.
    pub(crate) fn ids_for(
        &mut self,
        thread_id: &str,
        text: &str,
        attachments: &[ChatAttachment],
    ) -> MessageIds {
        match self.unsent.remove(thread_id) {
            Some(unsent) if unsent.text == text && unsent.attachments == attachments => unsent.ids,
            _ => MessageIds::new(),
        }
    }

    /// Records a send that is on its way and returns its id.
    pub(crate) fn start(&mut self, thread_id: &str, text: &str, attachment_count: usize) -> u64 {
        self.next_id = self.next_id.wrapping_add(1);
        self.sends.push(PendingSend {
            id: self.next_id,
            thread_id: thread_id.to_owned(),
            text: text.to_owned(),
            attachment_count,
            slow: false,
        });
        self.next_id
    }

    /// Marks send `id` as slow. Returns whether it is still on its way.
    pub(crate) fn mark_slow(&mut self, id: u64) -> bool {
        self.sends
            .iter_mut()
            .find(|send| send.id == id)
            .is_some_and(|send| {
                send.slow = true;
                true
            })
    }

    /// Drops send `id` once it ended. Returns whether it was there.
    pub(crate) fn finish(&mut self, id: u64) -> bool {
        let before = self.sends.len();
        self.sends.retain(|send| send.id != id);
        self.sends.len() != before
    }

    /// Keeps the ids of a message that went back to the composer after a send with no answer.
    pub(crate) fn remember_unsent(
        &mut self,
        thread_id: &str,
        text: String,
        attachments: Vec<ChatAttachment>,
        ids: MessageIds,
    ) {
        self.unsent.insert(
            thread_id.to_owned(),
            Unsent {
                text,
                attachments,
                ids,
            },
        );
    }

    /// The rows the tray shows for `thread_id`, oldest first. A send shows at once while the
    /// thread's server is away (`connected` false), else once it is slow.
    pub(crate) fn rows(&self, thread_id: &str, connected: bool) -> Vec<PendingSendRow> {
        self.sends
            .iter()
            .filter(|send| send.thread_id == thread_id && (send.slow || !connected))
            .map(|send| PendingSendRow::new(send.id, &send.text, send.attachment_count, !connected))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn in_flight_for_test(&self) -> usize {
        self.sends.len()
    }
}

/// One message send: what it carries, where it goes and with which ids.
pub(super) struct Outgoing {
    pub(super) connection: Connection,
    pub(super) thread_id: String,
    pub(super) text: String,
    pub(super) attachments: Vec<ChatAttachment>,
    pub(super) ids: MessageIds,
    pub(super) command: conn_contract::OrchestrationV2Command,
    pub(super) window: Option<gpui_kit::AnyWindowHandle>,
}

impl ConnApp {
    /// Shows the selected thread's sends that are still on their way.
    pub(super) fn sync_pending_sends(&mut self, cx: &mut Context<'_, Self>) {
        let rows = match self.layout.selected_thread_id.as_deref() {
            Some(thread_id) if self.draft.is_none() => {
                self.sends.rows(thread_id, self.thread_connected(thread_id))
            }
            _ => Vec::new(),
        };
        self.chat
            .update(cx, |chat, cx| chat.set_pending_sends(rows, cx));
    }

    /// Sends `send` and waits for the server, at most [`SEND_TIMEOUT`]. Meanwhile the tray shows
    /// it; a failed send puts the message back in the composer.
    pub(super) fn run_send(&mut self, send: Outgoing, cx: &mut Context<'_, Self>) {
        let pending = self
            .sends
            .start(&send.thread_id, &send.text, send.attachments.len());
        self.sync_pending_sends(cx);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SLOW_SEND_AFTER).await;
            let _ = this.update(cx, |app, cx| {
                if app.sends.mark_slow(pending) {
                    app.sync_pending_sends(cx);
                }
            });
        })
        .detach();

        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let Outgoing {
                connection,
                thread_id,
                text,
                attachments,
                ids,
                command,
                window,
            } = send;
            let dispatch = std::pin::pin!(connection.dispatch_command(command));
            let timeout = std::pin::pin!(cx.background_executor().timer(SEND_TIMEOUT));
            // Dropping the dispatch on a timeout closes its reply, so conn-client does not send
            // it again later.
            let outcome = match futures::future::select(dispatch, timeout).await {
                Either::Left((result, _)) => SendOutcome::of(result),
                Either::Right(_) => SendOutcome::timed_out(),
            };
            let _ = this.update(cx, |app, cx| {
                app.sends.finish(pending);
                app.sync_pending_sends(cx);
                let (message, keep_ids) = match outcome {
                    SendOutcome::Sent => return,
                    SendOutcome::Refused(message) => (message, false),
                    SendOutcome::NoAnswer(message) => (message, true),
                };
                eprintln!("send: dispatchCommand failed: {message}");
                if app.connection_gen != generation {
                    return;
                }
                if keep_ids {
                    app.sends
                        .remember_unsent(&thread_id, text.clone(), attachments.clone(), ids);
                }
                app.chat
                    .update(cx, |chat, cx| chat.set_error(Some(message), cx));
                let chat = app.chat.clone();
                let returned = window.and_then(|window| {
                    window
                        .update(cx, |_, window, cx| {
                            chat.update(cx, |chat, cx| {
                                chat.return_unsent(
                                    &thread_id,
                                    text.clone(),
                                    attachments.clone(),
                                    Some(window),
                                    cx,
                                );
                            });
                        })
                        .ok()
                });
                if returned.is_none() {
                    app.chat.update(cx, |chat, cx| {
                        chat.return_unsent(&thread_id, text, attachments, None, cx);
                    });
                }
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: &str) -> ChatAttachment {
        conn_contract::from_json(serde_json::json!({
            "type": "file", "id": id, "name": "a.txt", "mimeType": "text/plain", "sizeBytes": 1,
        }))
        .expect("a file attachment")
    }

    fn returned(sends: &mut PendingSends) -> MessageIds {
        let ids = MessageIds::new();
        sends.remember_unsent("t-1", "hello".to_owned(), vec![file("a")], ids.clone());
        ids
    }

    #[test]
    fn an_unchanged_resend_reuses_the_ids_once() {
        let mut sends = PendingSends::default();
        let ids = returned(&mut sends);
        assert_eq!(sends.ids_for("t-1", "hello", &[file("a")]), ids);
        assert_ne!(
            sends.ids_for("t-1", "hello", &[file("a")]),
            ids,
            "the returned draft is used up"
        );
    }

    #[test]
    fn an_edited_resend_gets_new_ids() {
        for (text, attachments) in [
            ("hello!", vec![file("a")]),
            ("hello", vec![]),
            ("hello", vec![file("b")]),
            ("hello", vec![file("a"), file("b")]),
        ] {
            let mut sends = PendingSends::default();
            let ids = returned(&mut sends);
            assert_ne!(
                sends.ids_for("t-1", text, &attachments),
                ids,
                "{text} {attachments:?}"
            );
        }
        let mut sends = PendingSends::default();
        let ids = returned(&mut sends);
        assert_ne!(
            sends.ids_for("t-2", "hello", &[file("a")]),
            ids,
            "another thread's draft"
        );
    }

    #[test]
    fn a_send_shows_at_once_offline_and_after_a_moment_online() {
        let mut sends = PendingSends::default();
        let id = sends.start("t-1", "hello", 0);
        assert!(sends.rows("t-1", true).is_empty());
        let offline = sends.rows("t-1", false);
        assert_eq!(offline.len(), 1);
        assert_eq!(offline[0].status(), "Waiting for connection");
        assert!(sends.rows("t-2", false).is_empty(), "only its own thread");

        assert!(sends.mark_slow(id));
        assert_eq!(sends.rows("t-1", true)[0].status(), "Sending…");
        assert!(sends.finish(id));
        assert!(!sends.mark_slow(id), "a finished send stays gone");
        assert!(sends.rows("t-1", false).is_empty());
    }

    #[test]
    fn only_a_send_without_an_answer_keeps_its_ids() {
        assert!(matches!(
            SendOutcome::of(Err(ClientError::Connection("connection closed".into()))),
            SendOutcome::NoAnswer(_)
        ));
        assert!(matches!(
            SendOutcome::of(Err(ClientError::Closed)),
            SendOutcome::NoAnswer(_)
        ));
        // A refusal is kept in the server's receipt, so the same id would be refused again.
        assert!(matches!(
            SendOutcome::of(Err(ClientError::Rpc(serde_json::json!("refused")))),
            SendOutcome::Refused(_)
        ));
        assert!(matches!(
            SendOutcome::of(Ok(serde_json::json!({}))),
            SendOutcome::Sent
        ));
    }
}
