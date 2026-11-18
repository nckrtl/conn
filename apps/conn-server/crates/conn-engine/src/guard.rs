//! Ownership checks that a caller attaches to one command (`Engine::dispatch_guarded`). The
//! engine runs the check in the same store transaction as the command, under the thread's
//! lock, so no other writer can change the thread between the check and the accept. A command
//! whose ID already has a receipt is refused, never replayed: a guarded caller gets exactly one
//! accept per command.
//!
//! Orbit's task-copy worker uses these (Conn integration item 6, "Ownership at dispatch").

use serde_json::Value;

use crate::{
    commands::{CommandError, active_run, queued_runs, reject},
    store::Tx,
};

/// What must hold for one guarded command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DispatchGuard {
    /// `thread.create`: the thread does not exist yet.
    NewThread,
    /// `message.dispatch`: no run of the thread is active or queued, and the message is new.
    /// The message then starts its own run at once; it never queues or steers.
    ExclusiveStart,
    /// `run.interrupt`: the run was started from one of these messages of the thread.
    RunFromMessages(Vec<String>),
    /// `runtime-request.respond` with decision `cancel`: the request is a pending user-input
    /// request whose node belongs to this run.
    PendingQuestionOf { owner_run_id: String },
}

fn text<'a>(command: &'a Value, key: &str) -> &'a str {
    command[key].as_str().unwrap_or_default()
}

/// Checks `guard` against the state `tx` sees. A refusal changes nothing.
pub(crate) fn check(
    tx: &Tx<'_>,
    guard: &DispatchGuard,
    command: &Value,
) -> Result<(), CommandError> {
    let thread_id = text(command, "threadId");
    let kind = text(command, "type");
    match guard {
        DispatchGuard::NewThread => {
            if kind != "thread.create" {
                return reject("This guard covers thread.create only.");
            }
            if tx.thread(thread_id)?.is_some() {
                return reject(format!("Thread {thread_id} already exists."));
            }
            Ok(())
        }
        DispatchGuard::ExclusiveStart => {
            if kind != "message.dispatch" {
                return reject("This guard covers message.dispatch only.");
            }
            if tx.thread(thread_id)?.is_none() {
                return reject(format!("Thread {thread_id} does not exist."));
            }
            if command["dispatchMode"]["type"] != "start_immediately"
                || !command["deliveryIntent"].is_null()
                || !command["steerFollowUpOfRunId"].is_null()
                || !command["restartContinuationOfRunId"].is_null()
            {
                return reject("A guarded message starts its own run at once.");
            }
            let message_id = text(command, "messageId");
            if tx.entity(thread_id, "messages", message_id)?.is_some() {
                return reject(format!("Message {message_id} already exists."));
            }
            if active_run(tx, thread_id)?.is_some() {
                return reject("Another run is active on this thread.");
            }
            if !queued_runs(tx, thread_id)?.is_empty() {
                return reject("A message is queued on this thread.");
            }
            Ok(())
        }
        DispatchGuard::RunFromMessages(messages) => {
            if kind != "run.interrupt" {
                return reject("This guard covers run.interrupt only.");
            }
            if command["holdQueue"] == true {
                return reject("A guarded interrupt never holds the thread's queue.");
            }
            let run_id = text(command, "runId");
            let Some(run) = tx.entity(thread_id, "runs", run_id)? else {
                return reject(format!("Run {run_id} does not exist."));
            };
            let from = run["userMessageId"].as_str().unwrap_or_default();
            if from.is_empty() || !messages.iter().any(|m| m == from) {
                return reject("The run was not started from an admitted message.");
            }
            Ok(())
        }
        DispatchGuard::PendingQuestionOf { owner_run_id } => {
            if kind != "runtime-request.respond" {
                return reject("This guard covers runtime-request.respond only.");
            }
            if command["decision"] != "cancel"
                || !command["answers"].is_null()
                || !command["feedback"].is_null()
            {
                return reject("A guarded response may only cancel.");
            }
            let request_id = text(command, "requestId");
            let Some(request) = tx.entity(thread_id, "runtimeRequests", request_id)? else {
                return reject(format!("Request {request_id} does not exist."));
            };
            if request["status"] != "pending" || request["kind"] != "user_input" {
                return reject("The request is not a pending user-input request.");
            }
            let node_id = request["nodeId"].as_str().unwrap_or_default();
            let owner = tx
                .entity(thread_id, "nodes", node_id)?
                .map(|node| node["runId"].as_str().unwrap_or_default().to_owned());
            if owner.as_deref() != Some(owner_run_id.as_str()) {
                return reject("The request belongs to another run.");
            }
            Ok(())
        }
    }
}
