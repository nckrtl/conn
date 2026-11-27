//! The tasks Orbit tracks, as Conn reads them (Orbit's Conn Tasks read contract v1).
//!
//! Port of `packages/client-runtime/src/orbitGateway/tasks.ts` and `tasksWire.ts`. Field names
//! match the Gateway's snake_case JSON. Orbit owns tasks; Conn Server owns conversations.
//!
//! Decoding is forgiving the way Conn's is: a list row off the contract hides that task, not the
//! page; an unknown subtask or agent literal degrades that item to `Unknown`; an insights number
//! Orbit leaves out or changes becomes `None` (a dash), never zero.
//!
//! A task detail read is forgiving the same way. An optional object, list or number that is null,
//! missing or of an unknown literal falls back to a neutral value (see [`lenient_enum`] and
//! [`null_default`]); only a field the page cannot do without fails the read, and the error names
//! it by path (`execution.implementer_mode`).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// A task's status. A list row with any other status is skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    Todo,
    Reserved,
    Running,
    Reviewing,
    Settling,
    WaitingForReview,
    Completed,
    Failed,
    Cancelled,
}

impl TaskStatus {
    /// The wire name, such as `waiting_for_review`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Todo => "todo",
            Self::Reserved => "reserved",
            Self::Running => "running",
            Self::Reviewing => "reviewing",
            Self::Settling => "settling",
            Self::WaitingForReview => "waiting_for_review",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A subtask's status; `Unknown` is a status this contract version does not name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubtaskStatus {
    Todo,
    Reserved,
    Running,
    Reviewing,
    Completed,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}

/// `Question`: an agent waits for an answer. The others come from Orbit's assistance fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Question,
    Failure,
    Direction,
    Observation,
    RemovalFailure,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskAttention {
    pub kind: AttentionKind,
    pub question: Option<String>,
    pub reason: Option<String>,
}

/// `None` is unknown, never zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct TaskMetrics {
    /// Wall clock across every attempt and wait, up to now while it runs.
    #[serde(default, deserialize_with = "lenient_number")]
    pub duration_ms: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens: Option<f64>,
    /// Task: the branch's diff against the default branch at the last report. Subtask: always `None`.
    #[serde(default, deserialize_with = "lenient_number")]
    pub lines_added: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub lines_deleted: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskProject {
    pub id: i64,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskWorkspace {
    pub instance_id: i64,
    pub name: String,
    /// The Instance status; `removing` and `removed` mean the copy is disposed.
    pub status: String,
    #[serde(default)]
    pub power_state: Option<PowerState>,
    pub node: Option<TaskNode>,
    #[serde(default)]
    pub branch: Option<String>,
    /// `None` when the copy has no registered server, or the caller has no access to its Node.
    #[serde(default)]
    pub conn_environment_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPullRequest {
    pub number: i64,
    pub url: String,
    #[serde(default)]
    pub state: Option<PullRequestState>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SubtaskCounts {
    pub total: i64,
    pub todo: i64,
    pub running: i64,
    pub completed: i64,
    pub failed: i64,
    pub cancelled: i64,
}

/// One row of `GET /conn/tasks`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskSummary {
    pub id: i64,
    pub title: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub attention: Option<TaskAttention>,
    pub project: TaskProject,
    /// `None` before the task starts, or after its copy was removed.
    #[serde(default)]
    pub workspace: Option<TaskWorkspace>,
    #[serde(default)]
    pub pull_request: Option<TaskPullRequest>,
    #[serde(default, deserialize_with = "null_default")]
    pub subtask_counts: SubtaskCounts,
    #[serde(default, deserialize_with = "null_default")]
    pub created_at: String,
    #[serde(default, deserialize_with = "null_default")]
    pub updated_at: String,
    #[serde(default)]
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deliverable {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: String,
}

/// One subtask. Its metrics never carry lines: Orbit records no per-subtask line delta.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "RawSubtask")]
pub struct Subtask {
    pub id: i64,
    pub position: i64,
    pub title: String,
    pub brief: String,
    pub deliverables: Vec<Deliverable>,
    pub status: SubtaskStatus,
    pub attention: Option<TaskAttention>,
    /// Orbit's agent record id, matching a [`TaskAgent::id`].
    pub current_implementer_agent_id: Option<i64>,
    pub metrics: TaskMetrics,
}

#[derive(Deserialize)]
struct RawSubtask {
    id: i64,
    position: i64,
    title: String,
    #[serde(default, deserialize_with = "null_default")]
    brief: String,
    #[serde(default, deserialize_with = "null_default")]
    deliverables: Vec<Deliverable>,
    status: SubtaskStatus,
    #[serde(default)]
    attention: Value,
    #[serde(default)]
    current_implementer_agent_id: Option<i64>,
    #[serde(default, deserialize_with = "null_default")]
    metrics: TaskMetrics,
}

impl From<RawSubtask> for Subtask {
    fn from(raw: RawSubtask) -> Self {
        // Unknown attention leaves the brief readable, with an unknown subtask state.
        let attention = serde_json::from_value::<Option<TaskAttention>>(raw.attention);
        let status = if attention.is_ok() {
            raw.status
        } else {
            SubtaskStatus::Unknown
        };
        Self {
            id: raw.id,
            position: raw.position,
            title: raw.title,
            brief: raw.brief,
            deliverables: raw.deliverables,
            status,
            attention: attention.ok().flatten(),
            current_implementer_agent_id: raw.current_implementer_agent_id,
            metrics: TaskMetrics {
                lines_added: None,
                lines_deleted: None,
                ..raw.metrics
            },
        }
    }
}

/// A Conn conversation, by its canonical server and thread.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ConversationRef {
    pub environment_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Implementer,
    Reviewer,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Idle,
    Working,
    AskingForInput,
    Done,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskAgent {
    /// Orbit's agent-thread record id. Never a Conn thread id.
    pub id: i64,
    pub role: AgentRole,
    #[serde(default, deserialize_with = "null_default")]
    pub subtask_ids: Vec<i64>,
    /// False for earlier attempts.
    #[serde(default, deserialize_with = "null_default")]
    pub current: bool,
    /// Counts per role and subtask, from 1.
    #[serde(default = "first_attempt", deserialize_with = "attempt")]
    pub attempt: i64,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// `None` before Orbit's first observation.
    #[serde(default)]
    pub state: Option<AgentState>,
    #[serde(default, deserialize_with = "null_default")]
    pub needs_input: bool,
    #[serde(default, deserialize_with = "null_default")]
    pub created_at: String,
    #[serde(default)]
    pub observed_at: Option<String>,
    /// The only link to a Conn thread. `None` when the workspace is gone or not reachable.
    #[serde(default)]
    pub conn: Option<ConversationRef>,
}

fn first_attempt() -> i64 {
    1
}

fn attempt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    Ok(Option::<i64>::deserialize(deserializer)?.unwrap_or(1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImplementerMode {
    PerSubtask,
    Shared,
    Task,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskExecution {
    /// A missing, null or unknown mode reads as `Task`: one agent for the whole task.
    #[serde(default = "default_mode", deserialize_with = "implementer_mode")]
    pub implementer_mode: ImplementerMode,
}

impl Default for TaskExecution {
    fn default() -> Self {
        Self {
            implementer_mode: default_mode(),
        }
    }
}

fn default_mode() -> ImplementerMode {
    ImplementerMode::Task
}

fn implementer_mode<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<ImplementerMode, D::Error> {
    Ok(lenient_enum(deserializer)?.unwrap_or_else(default_mode))
}

/// `GET /conn/tasks/{task}`: the row plus brief, subtasks (in position order) and agents.
///
/// Serialized flat; read through [`DetailBody`] and [`TaskSummary`] one after the other, so a
/// failure keeps its field path (`#[serde(flatten)]` would lose it).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskDetail {
    #[serde(flatten)]
    pub summary: TaskSummary,
    pub brief: String,
    pub execution: TaskExecution,
    pub metrics: TaskMetrics,
    pub subtasks: Vec<Subtask>,
    /// Implementers and reviewers, oldest first, current and earlier attempts.
    pub agents: Vec<TaskAgent>,
}

/// The fields of a task detail beyond its list row.
#[derive(Deserialize)]
struct DetailBody {
    #[serde(default, deserialize_with = "null_default")]
    brief: String,
    #[serde(default, deserialize_with = "null_default")]
    execution: TaskExecution,
    #[serde(default, deserialize_with = "null_default")]
    metrics: TaskMetrics,
    #[serde(default, deserialize_with = "null_default")]
    subtasks: Vec<Subtask>,
    /// An agent row off the contract is left out, not the page.
    #[serde(default, deserialize_with = "lenient_rows")]
    agents: Vec<TaskAgent>,
}

impl<'de> Deserialize<'de> for TaskDetail {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        decode_detail(&value).map_err(serde::de::Error::custom)
    }
}

/// The task row of a detail read, with the literals this version does not name set aside: an
/// unknown attention, pull request state or power state reads as absent. A list row with one of
/// them is left out instead; the page it opens still shows the task.
fn normalise_detail(value: &Value) -> Value {
    let mut value = value.clone();
    let unknown = |value: &Value, key: &str, check: fn(Value) -> bool| {
        value
            .get(key)
            .is_some_and(|field| !field.is_null() && !check(field.clone()))
    };
    if unknown(&value, "attention", |v| {
        serde_json::from_value::<TaskAttention>(v).is_ok()
    }) {
        value["attention"] = Value::Null;
    }
    if let Some(pull_request) = value.get_mut("pull_request")
        && unknown(pull_request, "state", |v| {
            serde_json::from_value::<PullRequestState>(v).is_ok()
        })
    {
        pull_request["state"] = Value::Null;
    }
    if let Some(workspace) = value.get_mut("workspace")
        && unknown(workspace, "power_state", |v| {
            serde_json::from_value::<PowerState>(v).is_ok()
        })
    {
        workspace["power_state"] = Value::Null;
    }
    value
}

/// Decodes a task object, and names the failing field by its path from the object.
fn decode_detail(value: &Value) -> Result<TaskDetail, String> {
    let value = &normalise_detail(value);
    let failure = |error: serde_path_to_error::Error<serde_json::Error>| {
        let path = error.path().to_string();
        if path == "." {
            error.inner().to_string()
        } else {
            format!("{path}: {}", error.inner())
        }
    };
    let summary: TaskSummary = serde_path_to_error::deserialize(value).map_err(failure)?;
    let body: DetailBody = serde_path_to_error::deserialize(value).map_err(failure)?;
    Ok(TaskDetail {
        summary,
        brief: body.brief,
        execution: body.execution,
        metrics: body.metrics,
        subtasks: body.subtasks,
        agents: body.agents,
    })
}

impl TaskDetail {
    pub fn implementer_mode(&self) -> ImplementerMode {
        self.execution.implementer_mode
    }
}

/// One page of the task list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TasksPage {
    pub tasks: Vec<TaskSummary>,
    /// Rows left out because they did not match the contract, such as an unknown status.
    pub skipped: usize,
    pub next_cursor: Option<String>,
}

/// The filters of `GET /conn/tasks`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TasksListQuery {
    /// Orbit Project id. Without it the list is every task this Node may read.
    pub project: Option<i64>,
    pub instance: Option<i64>,
    pub status: Option<TaskStatus>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InsightsPeriod {
    #[serde(rename = "24h")]
    Day,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
}

impl InsightsPeriod {
    /// The board's periods, in menu order.
    pub const ALL: [Self; 3] = [Self::Day, Self::Week, Self::Month];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "30d",
        }
    }
}

fn lenient_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value
        .as_ref()
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite()))
}

/// A field that may be null or missing reads as its default.
fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// An enum literal this contract version does not name reads as `None`, as does null.
fn lenient_enum<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// A list of rows decoded one by one: a row off the contract is left out, not the whole list.
fn lenient_rows<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let rows = Option::<Vec<Value>>::deserialize(deserializer)?.unwrap_or_default();
    Ok(each_row(&rows))
}

/// One period of Orbit's task insights. Every number is `None` when Orbit does not report it;
/// durations and tokens are medians.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct InsightsSummary {
    #[serde(default, deserialize_with = "lenient_number")]
    pub tasks: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub merged: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens_per_merged_pr: Option<f64>,
    /// Ready to merged.
    #[serde(default, deserialize_with = "lenient_number")]
    pub lead_time_ms: Option<f64>,
    /// Orbit 6041: ready to deployed.
    #[serde(default, deserialize_with = "lenient_number")]
    pub delivery_time_ms: Option<f64>,
    /// Orbit 6041: merged to deployed.
    #[serde(default, deserialize_with = "lenient_number")]
    pub deploy_wait_ms: Option<f64>,
    /// Orbit 6042: PR opened to merged.
    #[serde(default, deserialize_with = "lenient_number")]
    pub pr_merge_wait_ms: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub pr_first_pass: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub wasted_share: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub review_rounds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InsightsWeek {
    pub week_start: String,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens_per_merged_pr: Option<f64>,
}

/// One day (`date`, `YYYY-MM-DD`) or hour (ISO start of the hour) of the period.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InsightsBucket {
    pub date: String,
    pub merged: f64,
    /// The bucket's own numbers, by the same rules as `current`.
    pub values: InsightsSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InsightsBreakdownRow {
    pub key: String,
    pub label: String,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tasks: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub merged: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub tokens_per_merged_pr: Option<f64>,
    #[serde(default, deserialize_with = "lenient_number")]
    pub lead_time_ms: Option<f64>,
}

/// `GET /api/v1/task-insights`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskInsights {
    pub period: InsightsPeriod,
    pub current: InsightsSummary,
    pub previous: InsightsSummary,
    /// The last 12 weeks, oldest first, whatever the period.
    pub weekly: Vec<InsightsWeek>,
    /// Each day of the period, oldest first; empty for the 24-hour period.
    pub daily: Vec<InsightsBucket>,
    /// Each hour of the 24-hour period, oldest first; empty otherwise.
    pub hourly: Vec<InsightsBucket>,
    /// The wire's `breakdowns.model`.
    pub by_model: Vec<InsightsBreakdownRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskInsightsQuery {
    pub period: InsightsPeriod,
    /// Orbit Project id. Without it the numbers cover every task this Node may read.
    pub project: Option<i64>,
}

// ---------------------------------------------------------------------------------------------
// Environments (`GET /conn/environments`)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentStatus {
    Registered,
    SessionExpired,
}

/// A registered Conn server, as Orbit lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrbitEnvironment {
    pub environment_id: String,
    pub label: String,
    pub url: String,
    pub server_version: Option<String>,
    pub registered_by: Option<String>,
    /// When the server last registered. A refused pairing waits for the next registration.
    pub registered_at: Option<String>,
    pub status: EnvironmentStatus,
    /// The container Instance whose server this is, or `None` for a self-registered server.
    pub instance_id: Option<i64>,
    /// `Stopped` means the Instance is asleep.
    pub power_state: Option<PowerState>,
    pub project_id: Option<i64>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub instance_name: Option<String>,
    pub node_name: Option<String>,
    pub instance_url: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

/// Decodes rows one by one: a row off the contract is left out, not the whole answer.
fn each_row<T: DeserializeOwned>(rows: &[Value]) -> Vec<T> {
    rows.iter()
        .filter_map(|row| serde_json::from_value(row.clone()).ok())
        .collect()
}

/// An optional array field: absent or null is empty; any other non-array fails the envelope.
fn optional_rows(value: Option<&Value>) -> Option<&[Value]> {
    match value {
        None | Some(Value::Null) => Some(&[]),
        Some(Value::Array(rows)) => Some(rows),
        Some(_) => None,
    }
}

/// The `{ data, meta: { next_cursor } }` list envelope.
pub fn decode_tasks_page(json: &Value) -> Option<TasksPage> {
    let rows = json.get("data")?.as_array()?;
    let next_cursor = match json.get("meta") {
        None => None,
        Some(meta) => match meta.as_object()?.get("next_cursor") {
            None | Some(Value::Null) => None,
            Some(Value::String(cursor)) => Some(cursor.clone()),
            Some(_) => return None,
        },
    };
    let tasks: Vec<TaskSummary> = each_row(rows);
    Some(TasksPage {
        skipped: rows.len() - tasks.len(),
        tasks,
        next_cursor,
    })
}

/// `{ data: <task> }` for one task, with subtasks in position order.
pub fn decode_task_detail(json: &Value) -> Option<TaskDetail> {
    try_decode_task_detail(json).ok()
}

/// Like [`decode_task_detail`], and the error names the failing field by path, such as
/// `data.execution.implementer_mode: unknown variant ...`.
pub fn try_decode_task_detail(json: &Value) -> Result<TaskDetail, String> {
    let data = json
        .get("data")
        .ok_or_else(|| "data: missing field".to_owned())?;
    let mut detail = decode_detail(data).map_err(|error| format!("data.{error}"))?;
    detail.subtasks.sort_by_key(|subtask| subtask.position);
    Ok(detail)
}

/// A task-create result, `{ data: <task> }`: its list-row fields, whatever else it carries.
pub fn decode_task_created(json: &Value) -> Option<TaskSummary> {
    serde_json::from_value(json.get("data")?.clone()).ok()
}

/// The Gateway's error envelope, loosely: only the code and message matter.
pub fn decode_error_envelope(json: &Value) -> Option<(String, String)> {
    let error = json.get("error")?;
    Some((
        error.get("code")?.as_str()?.to_owned(),
        error.get("message")?.as_str()?.to_owned(),
    ))
}

fn decode_bucket(row: &Value, key: &str) -> Option<InsightsBucket> {
    let date = row.get(key)?.as_str()?.to_owned();
    let merged = row.get("merged")?.as_f64()?;
    let values = InsightsSummary::deserialize(row).ok()?;
    Some(InsightsBucket {
        date,
        merged,
        values,
    })
}

/// `GET /api/v1/task-insights`. Every number decodes on its own.
pub fn decode_task_insights(json: &Value) -> Option<TaskInsights> {
    let data = json.get("data")?.as_object()?;
    let period: InsightsPeriod = serde_json::from_value(data.get("period")?.clone()).ok()?;
    let summary = |key: &str| -> Option<InsightsSummary> {
        let value = data.get(key)?;
        value
            .is_object()
            .then(|| InsightsSummary::deserialize(value).ok())?
    };
    let current = summary("current")?;
    let previous = summary("previous")?;
    let weekly = each_row(optional_rows(data.get("weekly"))?);
    let daily = optional_rows(data.get("daily"))?
        .iter()
        .filter_map(|row| decode_bucket(row, "date"))
        .collect();
    let hourly = optional_rows(data.get("hourly"))?
        .iter()
        .filter_map(|row| decode_bucket(row, "hour"))
        .collect();
    let by_model = match data.get("breakdowns") {
        None => Vec::new(),
        Some(breakdowns) => each_row(optional_rows(breakdowns.as_object()?.get("model"))?),
    };
    Some(TaskInsights {
        period,
        current,
        previous,
        weekly,
        daily,
        hourly,
        by_model,
    })
}

/// A string the way the Gateway stores it: trimmed, and `None` when nothing is left.
fn optional_text(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn decode_environment(value: &Value) -> Option<OrbitEnvironment> {
    let data = value.as_object()?;
    let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let status = match data.get("status")?.as_str()? {
        "registered" => EnvironmentStatus::Registered,
        "session_expired" => EnvironmentStatus::SessionExpired,
        _ => return None,
    };
    let power_state = match data.get("power_state").and_then(Value::as_str) {
        Some("running") => Some(PowerState::Running),
        Some("stopped") => Some(PowerState::Stopped),
        _ => None,
    };
    Some(OrbitEnvironment {
        environment_id: text("environment_id")?,
        label: text("label")?,
        url: text("url")?,
        server_version: text("server_version"),
        registered_by: text("registered_by"),
        registered_at: text("registered_at"),
        status,
        instance_id: data.get("instance_id").and_then(Value::as_i64),
        power_state,
        project_id: data.get("project_id").and_then(Value::as_i64),
        project_name: optional_text(data.get("project_name")),
        project_slug: optional_text(data.get("project_slug")),
        instance_name: optional_text(data.get("instance_name")),
        node_name: optional_text(data.get("node_name")),
        instance_url: optional_text(data.get("instance_url")),
    })
}

/// `{ data: [environment] }`; one bad entry fails the whole list, as in Conn.
pub fn decode_environments(json: &Value) -> Option<Vec<OrbitEnvironment>> {
    json.get("data")?
        .as_array()?
        .iter()
        .map(decode_environment)
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Lanes, labels and workspace state
// ---------------------------------------------------------------------------------------------

/// Board lanes are a view over Orbit's statuses, not a lifecycle of their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskLane {
    Backlog,
    Todo,
    InProgress,
    Done,
}

impl TaskLane {
    /// Every lane in board order.
    pub const ALL: [Self; 4] = [Self::Backlog, Self::Todo, Self::InProgress, Self::Done];

    pub fn label(self) -> &'static str {
        match self {
            Self::Backlog => "Backlog",
            Self::Todo => "To do",
            Self::InProgress => "In progress",
            Self::Done => "Done",
        }
    }

    pub fn of(status: TaskStatus) -> Self {
        match status {
            TaskStatus::Backlog => Self::Backlog,
            TaskStatus::Todo | TaskStatus::Reserved => Self::Todo,
            TaskStatus::Running
            | TaskStatus::Reviewing
            | TaskStatus::Settling
            | TaskStatus::WaitingForReview => Self::InProgress,
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled => Self::Done,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskLabelTone {
    Info,
    Warning,
    Destructive,
    Muted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskLabel {
    pub label: &'static str,
    pub tone: TaskLabelTone,
}

/// The finer state a card names inside its lane, or `None` when the lane says enough.
pub fn task_label(status: TaskStatus, attention: Option<&TaskAttention>) -> Option<TaskLabel> {
    let label = |label, tone| Some(TaskLabel { label, tone });
    if attention.is_some_and(|a| a.kind == AttentionKind::Question) {
        return label("Needs answer", TaskLabelTone::Warning);
    }
    match status {
        TaskStatus::Failed => return label("Failed", TaskLabelTone::Destructive),
        TaskStatus::Cancelled => return label("Cancelled", TaskLabelTone::Muted),
        _ => {}
    }
    if attention.is_some_and(|a| a.kind != AttentionKind::Observation) {
        return label("Blocked", TaskLabelTone::Destructive);
    }
    match status {
        TaskStatus::Reviewing | TaskStatus::WaitingForReview => {
            label("In review", TaskLabelTone::Info)
        }
        TaskStatus::Running | TaskStatus::Settling => label("Working", TaskLabelTone::Info),
        _ => None,
    }
}

/// Where the task's workspace stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskEnvironment {
    NotStarted,
    Disposed,
    Stopped,
    Unreachable,
    Ready { environment_id: String },
}

impl TaskSummary {
    pub fn lane(&self) -> TaskLane {
        TaskLane::of(self.status)
    }

    pub fn label(&self) -> Option<TaskLabel> {
        task_label(self.status, self.attention.as_ref())
    }

    pub fn environment(&self) -> TaskEnvironment {
        let Some(workspace) = &self.workspace else {
            return match self.lane() {
                TaskLane::Backlog | TaskLane::Todo => TaskEnvironment::NotStarted,
                _ => TaskEnvironment::Disposed,
            };
        };
        if workspace.status == "removing" || workspace.status == "removed" {
            return TaskEnvironment::Disposed;
        }
        if workspace.power_state == Some(PowerState::Stopped) {
            return TaskEnvironment::Stopped;
        }
        match &workspace.conn_environment_id {
            None => TaskEnvironment::Unreachable,
            Some(id) => TaskEnvironment::Ready {
                environment_id: id.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// `GET /conn/tasks/6296` as the Gateway sent it: a running task with one task-wide agent, a
    /// `work` block and a `work_status` the decoder does not read. Text and ids are scrubbed.
    const LIVE_TASK: &str = include_str!("../testdata/task_detail_live_6296.json");

    fn live() -> Value {
        serde_json::from_str(LIVE_TASK).expect("fixture is JSON")
    }

    fn data_mut(json: &mut Value) -> &mut Value {
        &mut json["data"]
    }

    #[test]
    fn decodes_the_live_task_detail() {
        let task = try_decode_task_detail(&live()).expect("detail");
        assert_eq!(task.summary.id, 6296);
        assert_eq!(task.summary.status, TaskStatus::Running);
        assert_eq!(task.implementer_mode(), ImplementerMode::Task);
        assert!(task.subtasks.is_empty());
        assert_eq!(task.agents.len(), 1);
        assert_eq!(task.agents[0].role, AgentRole::Implementer);
        assert_eq!(task.agents[0].state, None);
        assert!(task.agents[0].conn.is_some());
        assert_eq!(task.metrics.tokens, None);
        let workspace = task.summary.workspace.as_ref().expect("workspace");
        assert_eq!(workspace.power_state, Some(PowerState::Running));
        assert_eq!(task.summary.pull_request, None);
    }

    #[test]
    fn unknown_literals_degrade_instead_of_failing_the_read() {
        let mut json = live();
        let data = data_mut(&mut json);
        data["execution"]["implementer_mode"] = json!("swarm");
        data["workspace"]["power_state"] = json!("hibernating");
        data["pull_request"] =
            json!({ "number": 9, "url": "https://example.test/pull/9", "state": "draft" });
        data["attention"] = json!({ "kind": "escalation", "question": null, "reason": "odd" });
        data["agents"][0]["role"] = json!("auditor");
        data["agents"][0]["state"] = json!("dreaming");
        data["work_status"] = json!("some_future_status");
        data["review"] = json!("auto_v2");
        let task = try_decode_task_detail(&json).expect("detail");
        assert_eq!(task.implementer_mode(), ImplementerMode::Task);
        let workspace = task.summary.workspace.as_ref().expect("workspace");
        assert_eq!(workspace.power_state, None);
        let pull_request = task.summary.pull_request.as_ref().expect("pull request");
        assert_eq!(pull_request.number, 9);
        assert_eq!(pull_request.state, None);
        // An attention kind this version does not name reads as no attention.
        assert_eq!(task.summary.attention, None);
        assert_eq!(task.agents[0].role, AgentRole::Unknown);
        assert_eq!(task.agents[0].state, Some(AgentState::Unknown));
    }

    #[test]
    fn null_and_missing_fields_read_as_neutral_values() {
        let mut json = live();
        let data = data_mut(&mut json);
        for key in [
            "execution",
            "metrics",
            "subtasks",
            "agents",
            "subtask_counts",
            "brief",
            "workspace",
            "pull_request",
            "attention",
            "last_activity_at",
            "created_at",
        ] {
            data[key] = Value::Null;
        }
        let task = try_decode_task_detail(&json).expect("detail with nulls");
        assert_eq!(task.implementer_mode(), ImplementerMode::Task);
        assert_eq!(task.metrics, TaskMetrics::default());
        assert!(task.subtasks.is_empty());
        assert!(task.agents.is_empty());
        assert_eq!(task.summary.subtask_counts, SubtaskCounts::default());
        assert_eq!(task.brief, "");
        assert_eq!(task.summary.workspace, None);
        let data = data_mut(&mut json).as_object_mut().expect("object");
        for key in [
            "execution",
            "metrics",
            "subtasks",
            "agents",
            "subtask_counts",
            "brief",
        ] {
            data.remove(key);
        }
        let task = try_decode_task_detail(&json).expect("detail with missing fields");
        assert!(task.agents.is_empty());
        assert_eq!(task.implementer_mode(), ImplementerMode::Task);
    }

    #[test]
    fn wrong_typed_numbers_and_nulls_inside_agents_and_metrics_are_tolerated() {
        let mut json = live();
        let data = data_mut(&mut json);
        data["metrics"] = json!({ "duration_ms": "soon", "tokens": null, "lines_added": 3 });
        data["agents"][0]["subtask_ids"] = Value::Null;
        data["agents"][0]["attempt"] = Value::Null;
        data["agents"][0]["needs_input"] = Value::Null;
        data["agents"][0]["conn"] = Value::Null;
        // An agent row without a role is off the contract: left out, not the page.
        data["agents"]
            .as_array_mut()
            .expect("agents")
            .push(json!({ "id": 99 }));
        let task = try_decode_task_detail(&json).expect("detail");
        assert_eq!(task.metrics.duration_ms, None);
        assert_eq!(task.metrics.lines_added, Some(3.0));
        assert_eq!(task.agents.len(), 1);
        assert_eq!(task.agents[0].attempt, 1);
        assert!(task.agents[0].subtask_ids.is_empty());
        assert_eq!(task.agents[0].conn, None);
    }

    #[test]
    fn a_broken_response_names_the_failing_field() {
        let mut json = live();
        data_mut(&mut json)["project"] = json!({ "slug": "x", "name": "x" });
        let error = try_decode_task_detail(&json).expect_err("project id is required");
        assert!(error.starts_with("data.project:"), "{error}");
        assert!(error.contains("missing field `id`"), "{error}");

        let mut json = live();
        data_mut(&mut json)["status"] = json!("teleporting");
        let error = try_decode_task_detail(&json).expect_err("status is required");
        assert!(error.contains("unknown variant `teleporting`"), "{error}");

        let mut json = live();
        data_mut(&mut json)["subtasks"] = json!([{ "id": 1, "position": 1, "title": 7 }]);
        let error = try_decode_task_detail(&json).expect_err("subtask title is a string");
        assert!(error.contains("subtasks[0].title"), "{error}");

        let error = try_decode_task_detail(&json!({ "nope": 1 })).expect_err("no data");
        assert!(error.contains("data"), "{error}");
        assert_eq!(decode_task_detail(&json!({ "nope": 1 })), None);
    }

    #[test]
    fn a_list_row_keeps_the_strict_contract_while_the_detail_degrades() {
        let mut json = live();
        let row = data_mut(&mut json).clone();
        let mut odd_state = row.clone();
        odd_state["pull_request"] = json!({ "number": 1, "url": "u", "state": "draft" });
        let mut odd_status = row.clone();
        odd_status["status"] = json!("teleporting");
        let mut nulls = row.clone();
        nulls["subtask_counts"] = Value::Null;
        nulls["created_at"] = Value::Null;
        let page = decode_tasks_page(
            &json!({ "data": [row, odd_state.clone(), odd_status, nulls], "meta": {} }),
        )
        .expect("page");
        assert_eq!(
            page.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![6296, 6296]
        );
        assert_eq!(page.skipped, 2);
        let detail = try_decode_task_detail(&json!({ "data": odd_state })).expect("detail");
        assert_eq!(detail.summary.pull_request.map(|p| p.number), Some(1));
    }
}
