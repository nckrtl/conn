//! Fill missing task receipts without paging the visible conversation.
use std::collections::HashSet;

use conn_contract::OrchestrationV2ThreadHistoryPage;
use gpui_kit::{Context, Task};

use super::ConnApp;

#[derive(Clone, Debug, PartialEq, Eq)]
struct HistoryRequest {
    environment: String,
    thread: String,
    generation: u64,
    snapshot: String,
}

#[derive(Debug)]
pub(crate) struct TaskHistoryRead {
    request: HistoryRequest,
    _reader: Task<()>,
}

impl ConnApp {
    fn details_history_request(&self) -> Option<(HistoryRequest, &str)> {
        if !self.thread_details.open || self.draft.is_some() {
            return None;
        }
        let state = self.selected_timeline()?;
        let id = &state.thread_id;
        if state.sequence.is_none() || state.deleted || !self.thread_connected(id) {
            return None;
        }
        let (snapshot, next) = state.task_links.next_page()?;
        Some((
            HistoryRequest {
                environment: self.cache_env(id)?.to_owned(),
                thread: id.to_owned(),
                generation: self.connection_gen,
                snapshot: snapshot.to_owned(),
            },
            next,
        ))
    }

    pub(super) fn sync_details_task_history(&mut self, cx: &mut Context<'_, Self>) {
        let Some((request, next)) = self.details_history_request() else {
            self.thread_details.task_history = None;
            return;
        };
        if self
            .thread_details
            .task_history
            .as_ref()
            .is_some_and(|read| read.request == request)
        {
            return;
        }
        let Some(connection) = self.connection_for_thread(&request.thread) else {
            self.thread_details.task_history = None;
            return;
        };
        let mut cursor = next.to_owned();
        let target = request.clone();
        let reader = cx.spawn(async move |this, cx| {
            let mut visited = HashSet::new();
            while visited.insert(cursor.clone()) {
                let page = match connection
                    .fetch_thread_history_page(&target.thread, &cursor)
                    .await
                {
                    Ok(page) => page,
                    Err(error) => {
                        eprintln!("thread details: could not load older task links: {error}");
                        return;
                    }
                };
                let Ok(Some(next)) = this.update(cx, |app, cx| {
                    app.apply_details_history_page(&target, &cursor, page, cx)
                }) else {
                    return;
                };
                cursor = next;
            }
            eprintln!("thread details: repeated older history cursor");
        });
        self.thread_details.task_history = Some(TaskHistoryRead {
            request,
            _reader: reader,
        });
    }

    fn apply_details_history_page(
        &mut self,
        target: &HistoryRequest,
        cursor: &str,
        page: OrchestrationV2ThreadHistoryPage,
        cx: &mut Context<'_, Self>,
    ) -> Option<String> {
        let (current, next) = self.details_history_request()?;
        if &current != target || next != cursor {
            return None;
        }
        let state = self.threads.get_mut(&target.thread)?;
        if !state.task_links.apply_page(&target.snapshot, cursor, page) {
            return None;
        }
        let next = state
            .task_links
            .next_page()
            .map(|(_, cursor)| cursor.to_owned());
        self.offline
            .task_links_changed(&target.environment, &target.thread);
        self.schedule_offline_save(cx);
        cx.notify();
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_tests::{
        details_tasks::{THREAD, receipt, snapshot},
        mount_app,
    };
    use gpui_kit::TestAppContext;
    use serde_json::json;

    #[gpui_kit::test]
    fn delayed_task_page_only_updates_its_request(cx: &mut TestAppContext) {
        let (_, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                let mut state = conn_state::ThreadState::new(THREAD);
                state.apply(
                    conn_contract::from_json(snapshot(Some("recent"), false)).expect("snapshot"),
                );
                app.set_thread_for_test(THREAD.into(), state, cx);
                app.server_url = Some("server-a".to_owned());
                app.status = Some(conn_client::ConnectionStatus::Connected);
                app.thread_details.open = true;
                let (request, _) = app.details_history_request().expect("pending history");
                let page = conn_contract::from_json::<OrchestrationV2ThreadHistoryPage>(json!({
                "snapshotSequence":42,"items":[receipt()],"hasMoreHistory":false, "nextCursor":null
            })).expect("history page");
                for (late, cursor) in [
                    (
                        HistoryRequest {
                            environment: "server-b".into(),
                            ..request.clone()
                        },
                        "recent",
                    ),
                    (
                        HistoryRequest {
                            thread: "another-thread".into(),
                            ..request.clone()
                        },
                        "recent",
                    ),
                    (
                        HistoryRequest {
                            generation: request.generation + 1,
                            ..request.clone()
                        },
                        "recent",
                    ),
                    (
                        HistoryRequest {
                            snapshot: "older".into(),
                            ..request.clone()
                        },
                        "recent",
                    ),
                    (request.clone(), "already-applied"),
                ] {
                    app.apply_details_history_page(&late, cursor, page.clone(), cx);
                    let links = &app.selected_timeline().expect("current thread").task_links;
                    assert!(links.links.is_empty());
                    assert_eq!(links.next_page(), Some(("recent", "recent")));
                }
                app.apply_details_history_page(&request, "recent", page, cx);
                let links = &app.selected_timeline().expect("current thread").task_links;
                assert!(links.links.contains_key(&482));
                assert!(links.next_page().is_none());
            })
        });
    }
}
