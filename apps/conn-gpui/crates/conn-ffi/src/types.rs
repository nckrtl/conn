//! UniFFI-exported records, enums, error types, and pure conversions from `conn-state` / `conn-client`.

use std::fmt;

use conn_client::{ClientError, ConnectionStatus, Credential, commands::format_client_error};
use conn_state::{ItemStatus, ShellState, ThreadActivity, ThreadShell, ThreadState, TimelineEntry};

/// Credential presented to `conn-server` when opening a session.
#[derive(Clone, PartialEq, Eq, uniffi::Enum)]
pub enum FfiCredential {
    /// Single-use pairing code from a server's `pairingUrl` (`#token=<code>`).
    PairingCode { code: String },
    /// Bearer access token previously issued by `on_bearer_issued`.
    Bearer { token: String },
}

impl fmt::Debug for FfiCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PairingCode { .. } => f.write_str("FfiCredential::PairingCode(<redacted>)"),
            Self::Bearer { .. } => f.write_str("FfiCredential::Bearer(<redacted>)"),
        }
    }
}

impl From<FfiCredential> for Credential {
    fn from(value: FfiCredential) -> Self {
        match value {
            FfiCredential::PairingCode { code } => Self::PairingCode(code),
            FfiCredential::Bearer { token } => Self::Bearer(token),
        }
    }
}

/// Connection lifecycle reported to [`crate::CoreListener::on_status`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiConnectionStatus {
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
    Failed { message: String },
}

impl From<ConnectionStatus> for FfiConnectionStatus {
    fn from(status: ConnectionStatus) -> Self {
        match status {
            ConnectionStatus::Connecting => Self::Connecting,
            ConnectionStatus::Connected => Self::Connected,
            ConnectionStatus::Reconnecting { attempt } => Self::Reconnecting { attempt },
            ConnectionStatus::Failed(message) => Self::Failed { message },
        }
    }
}

/// Coarse run state of a thread for list indicators.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiThreadActivity {
    Idle,
    Working,
    NeedsAttention,
    Failed,
}

impl From<ThreadActivity> for FfiThreadActivity {
    fn from(activity: ThreadActivity) -> Self {
        match activity {
            ThreadActivity::Idle => Self::Idle,
            ThreadActivity::Working => Self::Working,
            ThreadActivity::NeedsAttention => Self::NeedsAttention,
            ThreadActivity::Failed => Self::Failed,
        }
    }
}

/// One registered project from `orchestration.subscribeShell`.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiProject {
    pub id: String,
    pub title: String,
    pub workspace_root: String,
}

/// Summary row for one thread in [`FfiShellSnapshot`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub branch: Option<String>,
    pub activity: FfiThreadActivity,
    pub updated_at: Option<String>,
    pub settled: bool,
    pub is_subagent: bool,
}

/// Point-in-time shell snapshot emitted to [`crate::CoreListener::on_shell`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiShellSnapshot {
    pub projects: Vec<FfiProject>,
    pub threads: Vec<FfiThreadSummary>,
    pub synchronized: bool,
}

/// Status of a tool call or work item row (mirrors [`conn_state::ItemStatus`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, uniffi::Enum)]
pub enum FfiItemStatus {
    Running,
    Completed,
    Failed,
}

impl From<ItemStatus> for FfiItemStatus {
    fn from(status: ItemStatus) -> Self {
        match status {
            ItemStatus::Running => Self::Running,
            ItemStatus::Completed => Self::Completed,
            ItemStatus::Failed => Self::Failed,
        }
    }
}

/// One flattened timeline row emitted in [`FfiThreadSnapshot`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiTimelineEntry {
    User {
        id: String,
        text: String,
        created_at: Option<String>,
        created_by_agent: bool,
    },
    Assistant {
        id: String,
        markdown: String,
        streaming: bool,
        created_at: Option<String>,
    },
    Thinking {
        id: String,
        text: String,
        streaming: bool,
    },
    Tool {
        id: String,
        kind: String,
        title: String,
        detail: Option<String>,
        status: FfiItemStatus,
    },
    Approval {
        id: String,
        title: String,
        detail: Option<String>,
    },
    /// Every other [`conn_state::TimelineEntry`] variant, collapsed to a concise label for now.
    Other { id: String, label: String },
}

/// Point-in-time snapshot of one subscribed thread emitted to [`crate::CoreListener::on_thread`].
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadSnapshot {
    pub thread_id: String,
    pub entries: Vec<FfiTimelineEntry>,
    pub working: bool,
}

/// Errors returned across the UniFFI boundary.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum FfiError {
    #[error("invalid server url: {message}")]
    InvalidUrl { message: String },
    #[error("connection error: {message}")]
    Connection { message: String },
    #[error("authentication error: {message}")]
    Auth { message: String },
    #[error("rpc error: {message}")]
    Rpc { message: String },
    #[error("connection closed")]
    Closed,
}

impl From<ClientError> for FfiError {
    fn from(err: ClientError) -> Self {
        match err {
            ClientError::InvalidUrl(e) => Self::InvalidUrl {
                message: e.to_string(),
            },
            ClientError::Connection(message) => Self::Connection { message },
            ClientError::Codec(e) => Self::Rpc {
                message: e.to_string(),
            },
            ClientError::Auth(message) => Self::Auth { message },
            ClientError::Rpc(_) => Self::Rpc {
                message: format_client_error(&err),
            },
            ClientError::Closed => Self::Closed,
        }
    }
}

/// Projects [`ShellState`] into [`FfiShellSnapshot`].
///
/// Includes non-archived projects and top-level active threads (newest first) followed by
/// top-level settled threads flagged `settled: true` (newest first).
#[must_use]
pub(crate) fn build_shell_snapshot(shell: &ShellState) -> FfiShellSnapshot {
    let projects = shell
        .projects
        .iter()
        .filter(|project| {
            project
                .archived_at
                .as_ref()
                .and_then(Option::as_deref)
                .is_none_or(|s| s.trim().is_empty())
        })
        .map(|project| FfiProject {
            id: project.id.clone(),
            title: project.title.clone(),
            workspace_root: project.workspace_root.clone(),
        })
        .collect();

    let active = shell
        .top_level_active_threads()
        .map(|thread| map_thread_summary(shell, thread, false));
    let settled = shell
        .top_level_settled_threads()
        .into_iter()
        .map(|thread| map_thread_summary(shell, thread, true));
    let threads = active.chain(settled).collect();

    FfiShellSnapshot {
        projects,
        threads,
        synchronized: shell.synchronized,
    }
}

fn map_thread_summary(shell: &ShellState, thread: &ThreadShell, settled: bool) -> FfiThreadSummary {
    let updated_at = if !thread.updated_at.is_empty() {
        Some(thread.updated_at.clone())
    } else if !thread.created_at.is_empty() {
        Some(thread.created_at.clone())
    } else {
        None
    };

    FfiThreadSummary {
        id: thread.id.clone(),
        project_id: thread.project_id.clone(),
        title: thread.title.clone(),
        branch: thread.branch.clone(),
        activity: shell.activity(&thread.id).into(),
        updated_at,
        settled,
        is_subagent: ShellState::is_subagent(thread),
    }
}

/// Projects one [`ThreadState`] into [`FfiThreadSnapshot`].
#[must_use]
pub(crate) fn build_thread_snapshot(thread: &ThreadState) -> FfiThreadSnapshot {
    FfiThreadSnapshot {
        thread_id: thread.thread_id.clone(),
        entries: thread.entries.iter().map(map_timeline_entry).collect(),
        working: thread.working,
    }
}

/// Maps a [`TimelineEntry`] into its FFI representation.
#[must_use]
pub(crate) fn map_timeline_entry(entry: &TimelineEntry) -> FfiTimelineEntry {
    match entry {
        TimelineEntry::User {
            id,
            text,
            created_by_agent,
            created_at,
            ..
        } => FfiTimelineEntry::User {
            id: id.clone(),
            text: text.clone(),
            created_at: created_at.clone(),
            created_by_agent: *created_by_agent,
        },
        TimelineEntry::Assistant {
            id,
            markdown,
            streaming,
            created_at,
            ..
        } => FfiTimelineEntry::Assistant {
            id: id.clone(),
            markdown: markdown.clone(),
            streaming: *streaming,
            created_at: created_at.clone(),
        },
        TimelineEntry::Thinking {
            id,
            text,
            streaming,
        } => FfiTimelineEntry::Thinking {
            id: id.clone(),
            text: text.clone(),
            streaming: *streaming,
        },
        TimelineEntry::Tool {
            id,
            kind,
            title,
            detail,
            status,
            ..
        } => FfiTimelineEntry::Tool {
            id: id.clone(),
            kind: kind.clone(),
            title: title.clone(),
            detail: detail.clone(),
            status: (*status).into(),
        },
        TimelineEntry::Approval { id, title, detail } => FfiTimelineEntry::Approval {
            id: id.clone(),
            title: title.clone(),
            detail: detail.clone(),
        },
        TimelineEntry::QueuedUser { id, text, .. } => {
            let trimmed = text.trim();
            let label = if trimmed.is_empty() {
                "Queued message".to_owned()
            } else {
                format!("Queued: {trimmed}")
            };
            FfiTimelineEntry::Other {
                id: id.clone(),
                label,
            }
        }
        TimelineEntry::UserInputRequest {
            id,
            title,
            questions,
            ..
        } => {
            let summary = title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    questions.first().map(|q| {
                        let header = q.header.trim();
                        if header.is_empty() {
                            q.question.trim()
                        } else {
                            header
                        }
                    })
                })
                .filter(|s| !s.is_empty());
            let label = summary.map_or_else(|| "Question".to_owned(), |s| format!("Question: {s}"));
            FfiTimelineEntry::Other {
                id: id.clone(),
                label,
            }
        }
        TimelineEntry::SecretRequest { id, label, .. } => {
            let trimmed = label.trim();
            let display = if trimmed.is_empty() {
                "Secret request".to_owned()
            } else {
                format!("Secret: {trimmed}")
            };
            FfiTimelineEntry::Other {
                id: id.clone(),
                label: display,
            }
        }
        TimelineEntry::ProposedPlan { id, title, .. } => {
            let trimmed = title.trim();
            let label = if trimmed.is_empty() {
                "Proposed plan".to_owned()
            } else {
                format!("Plan: {trimmed}")
            };
            FfiTimelineEntry::Other {
                id: id.clone(),
                label,
            }
        }
        TimelineEntry::Subagent {
            id, title, role, ..
        } => {
            let trimmed = title.trim();
            let label = if !trimmed.is_empty() {
                format!("Subagent: {trimmed}")
            } else if !role.trim().is_empty() {
                format!("Subagent ({})", role.trim())
            } else {
                "Subagent".to_owned()
            };
            FfiTimelineEntry::Other {
                id: id.clone(),
                label,
            }
        }
        TimelineEntry::Notice { id, text, is_error } => {
            let trimmed = text.trim();
            let label = match (*is_error, trimmed.is_empty()) {
                (true, true) => "Error".to_owned(),
                (true, false) => format!("Error: {trimmed}"),
                (false, true) => "Notice".to_owned(),
                (false, false) => trimmed.to_owned(),
            };
            FfiTimelineEntry::Other {
                id: id.clone(),
                label,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::{
        OrchestrationV2ShellStreamItem, OrchestrationV2ThreadStreamItem,
        OrchestrationV2TurnItemStatus,
    };
    use conn_state::{SecretRequestStatus, UserInputQuestion};
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_every_timeline_entry_variant() {
        let user = TimelineEntry::User {
            id: "u1".to_owned(),
            text: "Hello".to_owned(),
            created_by_agent: true,
            created_at: Some("2026-11-22T10:00:00Z".to_owned()),
            attachments: Vec::new(),
            is_steer: false,
            run_id: Some("r1".to_owned()),
        };
        assert_eq!(
            map_timeline_entry(&user),
            FfiTimelineEntry::User {
                id: "u1".to_owned(),
                text: "Hello".to_owned(),
                created_at: Some("2026-11-22T10:00:00Z".to_owned()),
                created_by_agent: true,
            },
            "User entry maps cleanly"
        );

        let assistant = TimelineEntry::Assistant {
            id: "a1".to_owned(),
            markdown: "**Reply**".to_owned(),
            streaming: true,
            created_at: Some("2026-11-22T10:00:02Z".to_owned()),
            run_id: Some("r1".to_owned()),
            status: ItemStatus::Running,
        };
        assert_eq!(
            map_timeline_entry(&assistant),
            FfiTimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "**Reply**".to_owned(),
                streaming: true,
                created_at: Some("2026-11-22T10:00:02Z".to_owned()),
            },
            "Assistant entry maps cleanly"
        );

        let thinking = TimelineEntry::Thinking {
            id: "th1".to_owned(),
            text: "Considering options".to_owned(),
            streaming: false,
        };
        assert_eq!(
            map_timeline_entry(&thinking),
            FfiTimelineEntry::Thinking {
                id: "th1".to_owned(),
                text: "Considering options".to_owned(),
                streaming: false,
            },
            "Thinking entry maps cleanly"
        );

        for (state_status, ffi_status) in [
            (ItemStatus::Running, FfiItemStatus::Running),
            (ItemStatus::Completed, FfiItemStatus::Completed),
            (ItemStatus::Failed, FfiItemStatus::Failed),
        ] {
            let tool = TimelineEntry::Tool {
                id: "tool1".to_owned(),
                kind: "command".to_owned(),
                title: "cargo test".to_owned(),
                detail: Some("ok".to_owned()),
                status: state_status,
                output_omitted: false,
            };
            assert_eq!(
                map_timeline_entry(&tool),
                FfiTimelineEntry::Tool {
                    id: "tool1".to_owned(),
                    kind: "command".to_owned(),
                    title: "cargo test".to_owned(),
                    detail: Some("ok".to_owned()),
                    status: ffi_status,
                },
                "Tool entry preserves status {state_status:?}"
            );
        }

        let approval = TimelineEntry::Approval {
            id: "ap1".to_owned(),
            title: "Run rm -rf".to_owned(),
            detail: Some("outside workspace".to_owned()),
        };
        assert_eq!(
            map_timeline_entry(&approval),
            FfiTimelineEntry::Approval {
                id: "ap1".to_owned(),
                title: "Run rm -rf".to_owned(),
                detail: Some("outside workspace".to_owned()),
            },
            "Approval entry maps cleanly"
        );

        let queued = TimelineEntry::QueuedUser {
            id: "q1".to_owned(),
            run_id: "r2".to_owned(),
            message_id: "m2".to_owned(),
            text: "Next question".to_owned(),
            attachments: Vec::new(),
            created_at: "2026-11-22T10:01:00Z".to_owned(),
            created_by_agent: false,
        };
        assert_eq!(
            map_timeline_entry(&queued),
            FfiTimelineEntry::Other {
                id: "q1".to_owned(),
                label: "Queued: Next question".to_owned(),
            },
            "QueuedUser maps to Other"
        );

        let user_input = TimelineEntry::UserInputRequest {
            id: "ui1".to_owned(),
            request_id: "req-1".to_owned(),
            title: None,
            questions: vec![UserInputQuestion {
                id: "q-1".to_owned(),
                header: "Framework".to_owned(),
                question: "Which framework?".to_owned(),
                options: Vec::new(),
                multi_select: false,
                allow_custom_answer: true,
                initial_answer: None,
            }],
            status: OrchestrationV2TurnItemStatus::Running,
            pending: true,
            answers: Vec::new(),
            dismissible: false,
            created_at: None,
        };
        assert_eq!(
            map_timeline_entry(&user_input),
            FfiTimelineEntry::Other {
                id: "ui1".to_owned(),
                label: "Question: Framework".to_owned(),
            },
            "UserInputRequest maps to Other"
        );

        let secret = TimelineEntry::SecretRequest {
            id: "sec1".to_owned(),
            label: "API Key".to_owned(),
            reason: "Needed for deploy".to_owned(),
            url: None,
            placeholder: None,
            file_delivery: false,
            status: SecretRequestStatus::Pending,
            pending: true,
            created_at: None,
        };
        assert_eq!(
            map_timeline_entry(&secret),
            FfiTimelineEntry::Other {
                id: "sec1".to_owned(),
                label: "Secret: API Key".to_owned(),
            },
            "SecretRequest maps to Other"
        );

        let plan = TimelineEntry::ProposedPlan {
            id: "plan1".to_owned(),
            run_id: Some("r1".to_owned()),
            title: "Migration Plan".to_owned(),
            markdown: "# Migration Plan".to_owned(),
            streaming: false,
            status: ItemStatus::Completed,
            created_at: None,
        };
        assert_eq!(
            map_timeline_entry(&plan),
            FfiTimelineEntry::Other {
                id: "plan1".to_owned(),
                label: "Plan: Migration Plan".to_owned(),
            },
            "ProposedPlan maps to Other"
        );

        let subagent = TimelineEntry::Subagent {
            id: "sub1".to_owned(),
            child_thread_id: Some("child-1".to_owned()),
            title: "Audit crates".to_owned(),
            role: "claudeAgent".to_owned(),
            status: OrchestrationV2TurnItemStatus::Completed,
            summary: None,
            remote_label: None,
            created_at: None,
            started_at: None,
            completed_at: None,
        };
        assert_eq!(
            map_timeline_entry(&subagent),
            FfiTimelineEntry::Other {
                id: "sub1".to_owned(),
                label: "Subagent: Audit crates".to_owned(),
            },
            "Subagent maps to Other"
        );

        let error_notice = TimelineEntry::Notice {
            id: "n1".to_owned(),
            text: "Timed out".to_owned(),
            is_error: true,
        };
        assert_eq!(
            map_timeline_entry(&error_notice),
            FfiTimelineEntry::Other {
                id: "n1".to_owned(),
                label: "Error: Timed out".to_owned(),
            },
            "Error Notice maps to Other with Error prefix"
        );

        let plain_notice = TimelineEntry::Notice {
            id: "n2".to_owned(),
            text: "Context compacted".to_owned(),
            is_error: false,
        };
        assert_eq!(
            map_timeline_entry(&plain_notice),
            FfiTimelineEntry::Other {
                id: "n2".to_owned(),
                label: "Context compacted".to_owned(),
            },
            "Info Notice maps to Other"
        );
    }

    #[test]
    fn builds_thread_snapshot_from_testkit_synthetic_thread() {
        let raw = conn_state::testkit::synthetic_thread_snapshot_json(
            conn_state::testkit::SyntheticThread {
                turns: 2,
                commands_per_turn: 1,
                command_output_bytes: 32,
                assistant_bytes: 48,
            },
        );
        let item: OrchestrationV2ThreadStreamItem =
            serde_json::from_str(&raw).expect("synthetic snapshot must decode");
        let mut state = ThreadState::new("thread-1");
        assert!(state.apply(item), "snapshot must change thread state");

        let ffi = build_thread_snapshot(&state);
        assert_eq!(
            ffi.entries.len(),
            6,
            "2 turns * (user + command + assistant) = 6 entries"
        );
        assert!(
            matches!(ffi.entries[0], FfiTimelineEntry::User { .. }),
            "first entry is User"
        );
        assert!(
            matches!(ffi.entries[1], FfiTimelineEntry::Tool { .. }),
            "second entry is Tool"
        );
        assert!(
            matches!(ffi.entries[2], FfiTimelineEntry::Assistant { .. }),
            "third entry is Assistant"
        );
    }

    fn thread_shell_json(
        id: &str,
        project_id: &str,
        title: &str,
        updated_at: &str,
        status: &str,
        settled_at: Option<&str>,
        parent_thread_id: Option<&str>,
    ) -> serde_json::Value {
        let root_thread_id = parent_thread_id.unwrap_or(id);
        json!({
            "createdBy": "user",
            "creationSource": "web",
            "id": id,
            "projectId": project_id,
            "title": title,
            "providerInstanceId": "claudeAgent",
            "modelSelection": { "instanceId": "claudeAgent", "model": "haiku" },
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "branch": "main",
            "worktreePath": null,
            "lineage": {
                "rootThreadId": root_thread_id,
                "parentThreadId": parent_thread_id,
                "relationshipToParent": null
            },
            "forkedFrom": null,
            "activeProviderThreadId": null,
            "latestRunId": null,
            "activeRunId": null,
            "status": status,
            "pendingRuntimeRequest": null,
            "latestVisibleMessage": null,
            "latestUserMessageAt": updated_at,
            "hasActionableProposedPlan": false,
            "itemCount": 0,
            "visibleItemCount": 0,
            "createdAt": updated_at,
            "updatedAt": updated_at,
            "archivedAt": null,
            "settledOverride": null,
            "settledAt": settled_at,
            "deletedAt": null
        })
    }

    #[test]
    fn builds_shell_snapshot_with_newest_first_ordering_and_settled_flags() {
        let snapshot_json = json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 10,
                "projects": [
                    {
                        "id": "p-active",
                        "title": "Conn",
                        "workspaceRoot": "/tmp/conn",
                        "defaultModelSelection": null,
                        "scripts": [],
                        "createdAt": "2026-11-20T00:00:00Z",
                        "updatedAt": "2026-11-20T00:00:00Z",
                        "archivedAt": null
                    },
                    {
                        "id": "p-archived",
                        "title": "Old",
                        "workspaceRoot": "/tmp/old",
                        "defaultModelSelection": null,
                        "scripts": [],
                        "createdAt": "2026-11-19T00:00:00Z",
                        "updatedAt": "2026-11-19T00:00:00Z",
                        "archivedAt": "2026-11-20T00:00:00Z"
                    }
                ],
                "threads": [
                    thread_shell_json("t-old", "p-active", "Older active", "2026-11-22T09:00:00Z", "idle", None, None),
                    thread_shell_json("t-new", "p-active", "Newer active", "2026-11-22T11:00:00Z", "running", None, None),
                    thread_shell_json("t-sub", "p-active", "Child subagent", "2026-11-22T12:00:00Z", "running", None, Some("t-new")),
                    thread_shell_json("t-settled-old", "p-active", "Settled older", "2026-11-22T08:00:00Z", "completed", Some("2026-11-22T08:05:00Z"), None),
                    thread_shell_json("t-settled-new", "p-active", "Settled newer", "2026-11-22T10:00:00Z", "failed", Some("2026-11-22T10:05:00Z"), None)
                ],
                "archivedThreads": [
                    thread_shell_json("t-archived", "p-active", "Archived settled", "2026-11-22T10:30:00Z", "completed", None, None)
                ]
            }
        });

        let item: OrchestrationV2ShellStreamItem =
            serde_json::from_value(snapshot_json).expect("shell snapshot json must decode");
        let sync_item: OrchestrationV2ShellStreamItem =
            serde_json::from_value(json!({ "kind": "synchronized" }))
                .expect("synchronized json must decode");

        let mut shell = ShellState::default();
        shell.apply(item);
        assert!(
            !build_shell_snapshot(&shell).synchronized,
            "synchronized is false before Synchronized item"
        );
        shell.apply(sync_item);

        let ffi = build_shell_snapshot(&shell);
        assert!(ffi.synchronized, "synchronized flag reflects ShellState");
        assert_eq!(ffi.projects.len(), 1, "archived projects are filtered out");
        assert_eq!(ffi.projects[0].id, "p-active");

        let ids: Vec<&str> = ffi.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "t-new",
                "t-old",
                "t-archived",
                "t-settled-new",
                "t-settled-old"
            ],
            "active threads newest first, followed by settled threads newest first, excluding subagents"
        );
        assert!(!ffi.threads[0].settled, "t-new is active");
        assert_eq!(
            ffi.threads[0].activity,
            FfiThreadActivity::Working,
            "running thread maps to Working"
        );
        assert!(!ffi.threads[1].settled, "t-old is active");
        assert_eq!(
            ffi.threads[1].activity,
            FfiThreadActivity::Idle,
            "idle thread maps to Idle"
        );
        assert!(ffi.threads[2].settled, "archived thread is flagged settled");
        assert!(
            ffi.threads[3].settled,
            "settled_at thread is flagged settled"
        );
        assert_eq!(
            ffi.threads[3].activity,
            FfiThreadActivity::Failed,
            "failed thread maps to Failed"
        );
        assert!(
            ffi.threads.iter().all(|t| !t.is_subagent),
            "top-level list omits subagents"
        );
    }

    #[test]
    fn redacts_credential_in_debug_output() {
        let code = format!(
            "{:?}",
            FfiCredential::PairingCode {
                code: "super-secret-code".to_owned()
            }
        );
        assert!(
            !code.contains("super-secret-code"),
            "pairing code must be redacted in Debug"
        );
        let bearer = format!(
            "{:?}",
            FfiCredential::Bearer {
                token: "super-secret-token".to_owned()
            }
        );
        assert!(
            !bearer.contains("super-secret-token"),
            "bearer token must be redacted in Debug"
        );
    }
}
