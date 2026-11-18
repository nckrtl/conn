//! Ownership checks that a caller attaches to one command (`Engine::dispatch_guarded`). The
//! engine runs the check in the same store transaction as the command, under the thread's
//! lock, so no other writer can change the thread between the check and the accept. A command
//! whose ID already has a receipt is refused, never replayed: a guarded caller gets exactly one
//! accept per command. An optional [`CommitGate`] decides, in the same step as the commit,
//! whether the caller may still write at all.
//!
//! Orbit's task-copy worker uses these (Conn integration item 6, "Ownership at dispatch").

use serde_json::Value;

use crate::{
    commands::{CommandError, active_run, is_active, queued_runs, reject},
    store::Tx,
};

/// A message the guarded caller owns: its ID, the SHA-256 of its frozen text (lowercase hex)
/// and, when the caller recorded it, the run it started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedMessage {
    pub message_id: String,
    pub text_sha256: String,
    pub run_id: Option<String>,
}

/// What must hold for one guarded command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardRule {
    /// `thread.create`: the thread does not exist yet.
    NewThread,
    /// `message.dispatch`: no run of the thread is active or queued, and the message is new.
    /// The message then starts its own run at once; it never queues or steers.
    ExclusiveStart,
    /// `run.interrupt`: an active run that exactly one of these messages started, the message's
    /// stored text has the frozen digest, it started no other run, and any recorded run ID
    /// is this run.
    OwnRun(Vec<OwnedMessage>),
    /// `runtime-request.respond` with decision `cancel`: the request is a pending user-input
    /// request whose node belongs to this run.
    PendingQuestionOf { owner_run_id: String },
}

/// A guard: the thread must belong to `project_id`, and `rule` must hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchGuard {
    pub project_id: String,
    pub rule: GuardRule,
}

/// Decides, atomically with the commit, whether the guarded caller may still write. The
/// managed fence implements it: a revocation either happens before the check (the command is
/// refused) or after the commit (the work was already accepted).
pub trait CommitGate: Send + Sync {
    /// Runs `commit` only while the caller's access is open, and holds the access decision
    /// for its duration. `false`: refused, `commit` did not run.
    fn commit_if_open(&self, commit: &mut dyn FnMut()) -> bool;
}

fn text<'a>(command: &'a Value, key: &str) -> &'a str {
    command[key].as_str().unwrap_or_default()
}

fn sha256_hex(text: &str) -> String {
    conn_support::hex::hex(&conn_support::hmac::sha256(text.as_bytes()))
}

/// The thread exists and belongs to `project_id`.
fn bound_thread(tx: &Tx<'_>, thread_id: &str, project_id: &str) -> Result<(), CommandError> {
    if tx.thread_ever_deleted(thread_id)? {
        return reject("The thread ID was deleted before; it is not the admitted thread.");
    }
    match tx.thread(thread_id)? {
        Some(thread) if thread["projectId"] == project_id => Ok(()),
        Some(_) => reject("The thread belongs to another project."),
        None => reject(format!("Thread {thread_id} does not exist.")),
    }
}

/// Checks `guard` against the state `tx` sees. A refusal changes nothing.
pub(crate) fn check(
    tx: &Tx<'_>,
    guard: &DispatchGuard,
    command: &Value,
) -> Result<(), CommandError> {
    let thread_id = text(command, "threadId");
    let kind = text(command, "type");
    let project_id = guard.project_id.as_str();
    match &guard.rule {
        GuardRule::NewThread => {
            if kind != "thread.create" {
                return reject("This guard covers thread.create only.");
            }
            if text(command, "projectId") != project_id {
                return reject("The thread names another project.");
            }
            // A deleted thread keeps its history under its ID: a guarded create never takes
            // over an ID that was ever used.
            if tx.thread_id_used(thread_id)? {
                return reject(format!("Thread {thread_id} already exists or existed."));
            }
            Ok(())
        }
        GuardRule::ExclusiveStart => {
            if kind != "message.dispatch" {
                return reject("This guard covers message.dispatch only.");
            }
            bound_thread(tx, thread_id, project_id)?;
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
        GuardRule::OwnRun(messages) => {
            if kind != "run.interrupt" {
                return reject("This guard covers run.interrupt only.");
            }
            bound_thread(tx, thread_id, project_id)?;
            if command["holdQueue"] == true {
                return reject("A guarded interrupt never holds the thread's queue.");
            }
            let run_id = text(command, "runId");
            let Some(run) = tx.entity(thread_id, "runs", run_id)? else {
                return reject(format!("Run {run_id} does not exist."));
            };
            // Only a run that started: a queued row is never cancelled through a stop.
            if !is_active(&run) {
                return reject("The run is not active.");
            }
            let from = run["userMessageId"].as_str().unwrap_or_default();
            let Some(owned) = messages.iter().find(|m| m.message_id == from) else {
                return reject("The run was not started from an admitted message.");
            };
            if owned
                .run_id
                .as_deref()
                .is_some_and(|recorded| recorded != run_id)
            {
                return reject("The run is not the recorded run of its message.");
            }
            let Some(message) = tx.entity(thread_id, "messages", from)? else {
                return reject("The admitted message cannot be read.");
            };
            if message["text"]
                .as_str()
                .is_none_or(|t| sha256_hex(t) != owned.text_sha256)
            {
                return reject("The message's body differs from the frozen one.");
            }
            let started = tx
                .entities_where(thread_id, "runs", "userMessageId", from)?
                .len();
            if started != 1 {
                return reject("The message did not start exactly one run.");
            }
            Ok(())
        }
        GuardRule::PendingQuestionOf { owner_run_id } => {
            if kind != "runtime-request.respond" {
                return reject("This guard covers runtime-request.respond only.");
            }
            bound_thread(tx, thread_id, project_id)?;
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
