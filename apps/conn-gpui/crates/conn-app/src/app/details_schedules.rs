//! The scheduled tasks of the thread in the Thread Details card.
//!
//! The card lists the tasks bound to the open thread. They come from a live
//! `scheduledTasks.subscribe` stream on the thread's own connection, so a thread of a linked
//! environment shows the tasks of that environment. Row actions go through the same connection.
use conn_client::{Connection, StreamId};
use gpui_kit::{Context, Task};

use super::ConnApp;

/// What a subscription is for: a new thread, environment or connection starts a new one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScheduleRequest {
    thread: String,
    environment: Option<String>,
    generation: u64,
}

/// A running `scheduledTasks.subscribe` stream; dropping it cancels the stream.
#[derive(Debug)]
pub(crate) struct ScheduleSubscription {
    request: ScheduleRequest,
    connection: Connection,
    stream: StreamId,
    _reader: Task<()>,
}

impl ScheduleSubscription {
    /// The connection the tasks come from; row actions use it too.
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }
}

impl Drop for ScheduleSubscription {
    fn drop(&mut self) {
        self.connection.cancel_stream(self.stream);
    }
}

impl ConnApp {
    /// The subscription the open card needs now: none while it is closed or no thread is open.
    fn details_schedule_request(&self) -> Option<ScheduleRequest> {
        if !self.thread_details.open || self.draft.is_some() {
            return None;
        }
        let thread = self.layout.selected_thread_id.as_deref()?;
        Some(ScheduleRequest {
            thread: thread.to_owned(),
            environment: self.linked_environment_of_thread(thread).map(str::to_owned),
            generation: self.connection_gen,
        })
    }

    /// Keeps the subscription in step with the card: opened for the open thread on that
    /// thread's connection, replaced when the thread or its environment changes, dropped when
    /// the card closes. Another thread's tasks never show while the new list loads.
    pub(super) fn sync_details_schedules(&mut self, cx: &mut Context<'_, Self>) {
        let wanted = self.details_schedule_request();
        let current = self
            .thread_details
            .schedules
            .as_ref()
            .map(|subscription| &subscription.request);
        if current == wanted.as_ref() {
            return;
        }
        self.thread_details.schedules = None;
        self.thread_details.tasks.clear();
        self.thread_details.tasks_error = None;
        self.thread_details.busy_task_id = None;
        let Some(request) = wanted else {
            return;
        };
        let Some(connection) = self.connection_for_thread(&request.thread) else {
            return;
        };
        let (stream, mut rx) =
            connection.stream_json("scheduledTasks.subscribe", serde_json::json!({}));
        let target = request.clone();
        let reader = cx.spawn(async move |this, cx| {
            while let Some(raw) = rx.recv().await {
                let applied = this.update(cx, |app, cx| {
                    app.apply_details_schedules(&target, raw, cx);
                });
                if applied.is_err() {
                    break;
                }
            }
        });
        self.thread_details.schedules = Some(ScheduleSubscription {
            request,
            connection,
            stream,
            _reader: reader,
        });
    }

    /// Applies one snapshot of the task list, if it is for the subscription that is current.
    fn apply_details_schedules(
        &mut self,
        target: &ScheduleRequest,
        raw: serde_json::Value,
        cx: &mut Context<'_, Self>,
    ) {
        let current = self
            .thread_details
            .schedules
            .as_ref()
            .is_some_and(|subscription| &subscription.request == target);
        if !current {
            return;
        }
        match serde_json::from_value::<conn_state::ScheduledTaskListResult>(raw) {
            Ok(list) => {
                self.thread_details.tasks = list.tasks.into_iter().flatten().collect();
                self.thread_details.tasks_error = None;
            }
            Err(error) => {
                self.thread_details.tasks_error =
                    Some(format!("Failed to load scheduled tasks: {error}"));
            }
        }
        cx.notify();
    }

    /// Test helper: how many tasks the open card has listed, whichever thread they belong to.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn details_tasks_for_test(&self) -> usize {
        self.thread_details.tasks.len()
    }

    /// Test helper: whether the card holds a scheduled-tasks stream.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn details_schedules_open_for_test(&self) -> bool {
        self.thread_details.schedules.is_some()
    }

    /// The connection of the open card's tasks: the one that listed them.
    pub(super) fn details_schedule_connection(&self) -> Option<Connection> {
        self.thread_details
            .schedules
            .as_ref()
            .map(|subscription| subscription.connection().clone())
    }
}
