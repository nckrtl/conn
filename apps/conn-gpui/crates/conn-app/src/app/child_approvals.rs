//! Approvals of the open thread's children (subagents, side chats, delegated tasks).
//!
//! The shell stream only says that a child waits on an approval (`pendingRuntimeRequest`); the
//! command it asks about lives in the child's own thread stream. As Conn does
//! (`childThreadApprovalsAtom`: "only children asking for approval need a detail subscription"),
//! the app opens a child in its environment's thread engine while it asks (a child that asks is
//! unsettled, so the engine keeps its stream already), reads the approval from that thread's
//! state, and answers on the child thread.

use std::collections::{HashMap, HashSet};

use gpui_kit::Context;

use super::ConnApp;
use crate::chat::ChildApprovalCard;

/// What the app keeps between syncs.
#[derive(Default)]
pub(super) struct ChildApprovals {
    /// Children open for their approvals, and whether each one's detail has caught up.
    open: HashMap<String, bool>,
    /// Why the last answer to a request failed, by request id, until its card goes.
    errors: HashMap<String, String>,
}

/// On a new subscription, the cached detail can still describe a previous approval.
/// Once the detail has the request named by the shell, keep showing the live queue
/// while the two streams deliver later requests at different times.
fn detail_ready(
    ready: &mut bool,
    request_id: &str,
    detail: Option<&conn_state::ThreadState>,
) -> bool {
    *ready =
        *ready || detail.is_some_and(|thread| thread.pending_requests.contains_key(request_id));
    *ready
}

/// The children to subscribe to, and the subscribed ones that no longer ask.
fn plan_subscriptions(wanted: &[&str], subscribed: &[&str]) -> (Vec<String>, Vec<String>) {
    let wanted_set: HashSet<&str> = wanted.iter().copied().collect();
    let subscribed_set: HashSet<&str> = subscribed.iter().copied().collect();
    let add = wanted
        .iter()
        .filter(|id| !subscribed_set.contains(**id))
        .map(|id| (*id).to_owned())
        .collect();
    let stale = subscribed
        .iter()
        .filter(|id| !wanted_set.contains(**id))
        .map(|id| (*id).to_owned())
        .collect();
    (add, stale)
}

impl ConnApp {
    /// Opens the children of the open thread that ask for approval (and closes the ones that
    /// stopped asking), opens the selected thread, and returns the cards of the pending child
    /// approvals. Runs on every chat sync.
    pub(super) fn sync_child_approvals(
        &mut self,
        cx: &mut Context<'_, Self>,
    ) -> Vec<ChildApprovalCard> {
        let mut children = match self.layout.selected_thread_id.as_deref() {
            Some(thread_id) if self.draft.is_none() => self.shell.child_approval_threads(thread_id),
            _ => Vec::new(),
        };
        let wanted: Vec<&str> = children.iter().map(|child| child.id.as_str()).collect();
        let current: Vec<&str> = self
            .child_approvals
            .open
            .keys()
            .map(String::as_str)
            .collect();
        let (add, stale) = plan_subscriptions(&wanted, &current);
        for id in stale {
            self.child_approvals.open.remove(&id);
        }
        for id in add {
            self.child_approvals.open.insert(id, false);
        }
        let open: Vec<String> = self.child_approvals.open.keys().cloned().collect();
        self.sync_open_threads(&open, cx);

        let shown: HashSet<String> = children
            .iter()
            .filter(|child| {
                let mut ready = self
                    .child_approvals
                    .open
                    .get(&child.id)
                    .copied()
                    .unwrap_or(false);
                detail_ready(&mut ready, &child.request_id, self.thread(&child.id))
            })
            .map(|child| child.id.clone())
            .collect();
        for id in &shown {
            self.child_approvals.open.insert(id.clone(), true);
        }
        children.retain(|child| shown.contains(&child.id));
        let approvals = conn_state::child_approvals_with(&children, |id| self.thread(id));
        self.child_approvals
            .errors
            .retain(|request_id, _| approvals.iter().any(|a| &a.request_id == request_id));
        approvals
            .iter()
            .map(|approval| {
                ChildApprovalCard::new(
                    approval,
                    self.responding_approvals.contains(&approval.request_id),
                    self.child_approvals
                        .errors
                        .get(&approval.request_id)
                        .cloned(),
                )
            })
            .collect()
    }

    /// Forgets the subscriptions of a connection that is gone.
    pub(super) fn reset_child_approvals(&mut self) {
        self.child_approvals = ChildApprovals::default();
    }

    /// Answers `request_id` on the child thread `thread_id`: the same `runtime-request.respond`
    /// the thread's own approvals use (`threadEnvironment.respondToApproval`).
    pub(crate) fn respond_child_approval(
        &mut self,
        thread_id: &str,
        request_id: &str,
        decision: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection_for_thread(thread_id) else {
            return;
        };
        let command = match crate::commands::respond_approval(thread_id, request_id, decision) {
            Ok(command) => command,
            Err(e) => {
                eprintln!("child approval: could not build runtime-request.respond: {e}");
                return;
            }
        };
        if !self.responding_approvals.insert(request_id.to_owned()) {
            return;
        }
        self.child_approvals.errors.remove(request_id);
        self.sync_chat(cx);
        cx.notify();
        let request_id = request_id.to_owned();
        cx.spawn(async move |this, cx| {
            let result = connection.dispatch_command(command).await;
            let _ = this.update(cx, |app, cx| {
                app.responding_approvals.remove(&request_id);
                if let Err(err) = result {
                    app.child_approvals
                        .errors
                        .insert(request_id, crate::commands::format_client_error(&err));
                }
                app.sync_chat(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resubscribed_child_waits_for_its_new_request_before_showing_cached_cards() {
        let mut detail = conn_state::ThreadState::default();
        detail
            .pending_requests
            .insert("first".into(), Default::default());
        let mut ready = false;
        assert!(detail_ready(&mut ready, "first", Some(&detail)));

        // A new subscription starts while the thread cache still holds the previous command.
        let mut ready = false;
        assert!(!detail_ready(&mut ready, "second", Some(&detail)));
        detail.pending_requests.remove("first");
        assert!(!detail_ready(&mut ready, "second", Some(&detail)));
        detail
            .pending_requests
            .insert("second".into(), Default::default());
        assert!(detail_ready(&mut ready, "second", Some(&detail)));

        // A third request joins an active subscription. The second card stays in place.
        assert!(detail_ready(&mut ready, "third", Some(&detail)));
    }

    #[test]
    fn subscribes_new_children_and_drops_the_ones_that_stopped_asking() {
        let (add, stale) = plan_subscriptions(&["a", "b"], &[]);
        assert_eq!(add, ["a", "b"]);
        assert!(stale.is_empty());

        let (add, stale) = plan_subscriptions(&["b", "c"], &["a", "b"]);
        assert_eq!(add, ["c"]);
        assert_eq!(stale, ["a"]);

        let (add, stale) = plan_subscriptions(&[], &["a"]);
        assert!(add.is_empty());
        assert_eq!(stale, ["a"]);
    }
}
