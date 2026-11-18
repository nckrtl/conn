//! The task worker grant: Orbit's task-copy worker drives one admitted turn over the
//! orchestration RPC (Conn integration item 6, "Task-copy RPC (target)").
//!
//! It is a managed token (item 4's binding: Gateway introspection, caller-to-target peer
//! binding, the revocation fence). Its claims carry fixed scopes and one `task_grant` that
//! names the task, the copy, the turn and an allowlist fixed at capture. The target refuses
//! any thread, run, request or command outside it, even when the scopes match. Writes go
//! through [`conn_engine::Engine::dispatch_guarded`], so the ownership check and the accept
//! are one step. There is no second credential: no other bearer reaches these handlers.

use std::sync::Arc;

use conn_contract::{Command, SubscribeThreadInput, ThreadId, to_json};
use conn_engine::{DispatchGuard, Engine, EngineError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Claims;
use crate::table::{Failure, MethodTable};

/// The fixed scopes of a task worker token.
pub const WORKER_SCOPES: [&str; 2] = ["orchestration:operate", "orchestration:read"];
/// The only RPC methods a task worker may call.
pub const WORKER_METHODS: [&str; 3] = [
    "orchestration.dispatchCommand",
    "orchestration.getThreadProjection",
    "orchestration.subscribeThread",
];
/// The claims field that holds the grant.
pub const GRANT_FIELD: &str = "task_grant";

/// The frozen `thread.create` of a turn that creates its thread.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenCreate {
    pub command_id: String,
    /// Every field the command must carry with exactly this value: project, title,
    /// provider instance, model and options, as Orbit froze them.
    pub body: serde_json::Map<String, Value>,
}

/// The frozen `message.dispatch` of the turn.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenMessage {
    pub command_id: String,
    pub message_id: String,
    /// SHA-256 of the message text, lowercase hex.
    pub text_sha256: String,
}

/// An earlier, unsettled turn this one may settle: read its thread, stop only its run.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EarlierTurn {
    pub thread_id: String,
    pub message_id: String,
}

/// A stored question whose request the answer turn may cancel.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StoredQuestion {
    pub thread_id: String,
    pub request_id: String,
    pub owner_run_id: String,
}

/// The `task_grant` claim.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskGrant {
    pub purpose: String,
    pub task_id: Value,
    pub copy_id: Value,
    pub turn_id: Value,
    /// The copy's one admitted workspace project.
    pub project_id: String,
    /// The admitted thread.
    pub thread_id: String,
    #[serde(default)]
    pub create: Option<FrozenCreate>,
    pub message: FrozenMessage,
    #[serde(default)]
    pub earlier: Vec<EarlierTurn>,
    #[serde(default)]
    pub questions: Vec<StoredQuestion>,
}

fn non_empty(text: &str) -> bool {
    !text.trim().is_empty()
}

impl TaskGrant {
    /// Reads and checks the grant of `claims`. `None` refuses the token.
    pub fn from_claims(claims: &Claims) -> Option<Self> {
        let mut scopes: Vec<&str> = claims.scopes.iter().map(String::as_str).collect();
        scopes.sort_unstable();
        scopes.dedup();
        if scopes != WORKER_SCOPES || claims.extra.len() != 1 {
            return None;
        }
        let grant: Self = serde_json::from_value(claims.extra.get(GRANT_FIELD)?.clone()).ok()?;
        let identified = [&grant.task_id, &grant.copy_id, &grant.turn_id]
            .iter()
            .all(|id| matches!(id, Value::Number(_)) || id.as_str().is_some_and(non_empty));
        let message = &grant.message;
        let well_formed = grant.purpose == "task_worker"
            && identified
            && non_empty(&grant.project_id)
            && non_empty(&grant.thread_id)
            && non_empty(&message.command_id)
            && non_empty(&message.message_id)
            && message.text_sha256.len() == 64
            && message
                .text_sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && grant.create.as_ref().is_none_or(|create| {
                non_empty(&create.command_id)
                    && create.body.get("projectId") == Some(&json!(grant.project_id))
            });
        well_formed.then_some(grant)
    }

    fn earlier_messages_on(&self, thread_id: &str) -> Vec<String> {
        self.earlier
            .iter()
            .filter(|e| e.thread_id == thread_id)
            .map(|e| e.message_id.clone())
            .collect()
    }

    /// Threads the worker may read: its own, and each earlier turn's.
    fn may_read(&self, thread_id: &str) -> bool {
        thread_id == self.thread_id || self.earlier.iter().any(|e| e.thread_id == thread_id)
    }

    /// The guard for one command, or why it is outside the grant.
    pub fn guard_for(&self, command: &Value) -> Result<DispatchGuard, String> {
        let text = |key: &str| command[key].as_str().unwrap_or_default();
        let thread_id = text("threadId");
        let command_id = text("commandId");
        match text("type") {
            "thread.create" => {
                let Some(create) = &self.create else {
                    return Err("this turn creates no thread".into());
                };
                if thread_id != self.thread_id || command_id != create.command_id {
                    return Err("not the admitted thread or command".into());
                }
                if command.get("initialMessage").is_some_and(|m| !m.is_null()) {
                    return Err("a task thread is created without a message".into());
                }
                if create
                    .body
                    .iter()
                    .any(|(key, value)| command.get(key) != Some(value))
                {
                    return Err("the create body differs from the frozen one".into());
                }
                Ok(DispatchGuard::NewThread)
            }
            "message.dispatch" => {
                let message = &self.message;
                if thread_id != self.thread_id
                    || command_id != message.command_id
                    || text("messageId") != message.message_id
                {
                    return Err("not the admitted message".into());
                }
                let digest =
                    conn_support::hex::hex(&conn_support::hmac::sha256(text("text").as_bytes()));
                if digest != message.text_sha256 {
                    return Err("the message body differs from the frozen one".into());
                }
                if command
                    .get("attachments")
                    .and_then(Value::as_array)
                    .is_some_and(|a| !a.is_empty())
                {
                    return Err("a task message carries no attachments".into());
                }
                Ok(DispatchGuard::ExclusiveStart)
            }
            "run.interrupt" => {
                let mut messages = self.earlier_messages_on(thread_id);
                if thread_id == self.thread_id {
                    messages.push(self.message.message_id.clone());
                }
                if messages.is_empty() {
                    return Err("not an admitted thread".into());
                }
                Ok(DispatchGuard::RunFromMessages(messages))
            }
            "runtime-request.respond" => {
                let request_id = text("requestId");
                let Some(question) = self
                    .questions
                    .iter()
                    .find(|q| q.thread_id == thread_id && q.request_id == request_id)
                else {
                    return Err("not a stored question".into());
                };
                if command["decision"] != "cancel" {
                    return Err("a stored question may only be cancelled".into());
                }
                Ok(DispatchGuard::PendingQuestionOf {
                    owner_run_id: question.owner_run_id.clone(),
                })
            }
            _ => Err("the command is outside the task grant".into()),
        }
    }
}

/// Whether `claims` are a task worker token with a well-formed grant.
pub fn is_task_worker(claims: &Claims) -> bool {
    TaskGrant::from_claims(claims).is_some()
}

/// The typed refusal a client decodes for any of these methods.
fn outside(reason: &str) -> Failure {
    Failure::Fail(json!({
        "_tag": "EnvironmentAuthorizationError",
        "message": format!("Outside the task grant: {reason}."),
        "requiredScope": "orchestration",
        "requiredPermission": "orchestration:operate",
    }))
}

fn failure<E: Serialize>(error: EngineError<E>) -> Failure {
    match error {
        EngineError::Rejected(error) => Failure::fail(&error),
        EngineError::Internal(message) => Failure::die(message),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadIdInput {
    thread_id: ThreadId,
}

/// The method table of one task worker session: the allowlist, bound to its grant.
pub fn table(engine: Arc<dyn Engine>, grant: Arc<TaskGrant>) -> MethodTable {
    let mut table = MethodTable::new();
    let (e, g) = (engine.clone(), grant.clone());
    table.unary(
        "orchestration.dispatchCommand",
        move |_, command: Command| {
            let (e, g) = (e.clone(), g.clone());
            async move {
                let guard = g.guard_for(&to_json(&command)).map_err(|r| outside(&r))?;
                e.dispatch_guarded(command, guard).await.map_err(failure)
            }
        },
    );
    let (e, g) = (engine.clone(), grant.clone());
    table.unary(
        "orchestration.getThreadProjection",
        move |_, input: ThreadIdInput| {
            let (e, g) = (e.clone(), g.clone());
            async move {
                if !g.may_read(input.thread_id.as_str()) {
                    return Err(outside("not an admitted thread"));
                }
                e.get_thread_projection(input.thread_id)
                    .await
                    .map_err(failure)
            }
        },
    );
    let (e, g) = (engine, grant);
    table.stream(
        "orchestration.subscribeThread",
        move |_, input: SubscribeThreadInput| {
            let (e, g) = (e.clone(), g.clone());
            async move {
                if input.thread_id != g.thread_id {
                    return Err(outside("not the admitted thread"));
                }
                e.subscribe_thread(input)
                    .await
                    .map(crate::methods::orchestration::forward)
                    .map_err(failure)
            }
        },
    );
    table
}

#[cfg(test)]
#[path = "task_tests.rs"]
mod tests;
