//! The thread details sheet (desktop's details card): project and folder, linked pull requests,
//! Git status and child agents, from `conn_state::thread_details`.

use conn_state::thread_details::{
    ThreadAgent, ThreadAgentState, ThreadPullRequest, ThreadPullRequestState, ThreadRecord,
    home_relative_path, thread_cwd, thread_lineage, thread_pull_requests,
};
use conn_state::{ShellState, ThreadState, providers::ModelCatalog};

/// Where a child agent is in its run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiThreadAgentState {
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
    Idle,
}

impl From<ThreadAgentState> for FfiThreadAgentState {
    fn from(state: ThreadAgentState) -> Self {
        match state {
            ThreadAgentState::Running => Self::Running,
            ThreadAgentState::Waiting => Self::Waiting,
            ThreadAgentState::Done => Self::Done,
            ThreadAgentState::Failed => Self::Failed,
            ThreadAgentState::Stopped => Self::Stopped,
            ThreadAgentState::Idle => Self::Idle,
        }
    }
}

/// One child agent of the thread.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadDetailsAgent {
    pub key: String,
    /// The thread to open; `None` while the child has none.
    pub thread_id: Option<String>,
    /// The linked environment it runs on; `None` is the thread's own.
    pub environment_id: Option<String>,
    pub title: String,
    /// The provider's driver where the catalog knows it (`ThreadAgent::provider_driver`), else
    /// the role or instance id, for the provider mark.
    pub provider: String,
    /// `Opus 5.5 · high` (`SubagentModel::label`).
    pub model: Option<String>,
    pub state: FfiThreadAgentState,
    pub live: bool,
    /// `on nick · Opus 5.5 · high · Done · 1m 8s`: where, model, the state once settled, and how
    /// long it ran.
    pub meta: String,
}

impl FfiThreadDetailsAgent {
    fn new(agent: ThreadAgent, catalog: &ModelCatalog) -> Self {
        let provider = agent.provider_driver(catalog).to_owned();
        let model = agent
            .model
            .as_ref()
            .and_then(|model| model.label(catalog))
            .map(|label| match label.effort {
                Some(effort) if !effort.is_empty() => format!("{} · {effort}", label.model),
                _ => label.model,
            });
        let live = agent.state.is_live();
        let meta = [
            agent.environment_label.as_ref().map(|l| format!("on {l}")),
            model.clone(),
            (!live).then(|| agent.state.text().to_owned()),
            agent.elapsed.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        Self {
            key: agent.key,
            thread_id: Some(agent.thread_id).filter(|id| !id.is_empty()),
            environment_id: agent.environment_id,
            title: agent.title,
            provider,
            model,
            state: agent.state.into(),
            live,
            meta,
        }
    }
}

/// A pull request's state as the sheet shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiThreadPullRequestState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl From<ThreadPullRequestState> for FfiThreadPullRequestState {
    fn from(state: ThreadPullRequestState) -> Self {
        match state {
            ThreadPullRequestState::Open => Self::Open,
            ThreadPullRequestState::Draft => Self::Draft,
            ThreadPullRequestState::Merged => Self::Merged,
            ThreadPullRequestState::Closed => Self::Closed,
        }
    }
}

/// A pull request linked to the thread, with what opening its record needs.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadPullRequest {
    pub project_id: String,
    /// `None` for a branch PR the server has not linked yet: it opens in the browser.
    pub host: Option<String>,
    pub repository: String,
    pub number: i64,
    pub url: String,
    /// The title, else `#number` until it has synced.
    pub title: String,
    pub state: Option<FfiThreadPullRequestState>,
    /// `#1931 · Open`.
    pub meta: String,
    pub head_branch: String,
    pub base_branch: String,
    pub author: Option<String>,
    pub updated_at: Option<String>,
}

impl FfiThreadPullRequest {
    fn new(pr: ThreadPullRequest, project_id: &str) -> Self {
        let meta = match pr.state {
            Some(state) => format!("#{} · {}", pr.number, state.text()),
            None => format!("#{}", pr.number),
        };
        Self {
            project_id: project_id.to_owned(),
            host: pr.host,
            repository: pr.repository,
            number: pr.number,
            url: pr.url,
            title: pr.title.unwrap_or_else(|| format!("#{}", pr.number)),
            state: pr.state.map(Into::into),
            meta,
            head_branch: pr.head_branch.unwrap_or_default(),
            base_branch: pr.base_branch.unwrap_or_default(),
            author: pr.author,
            updated_at: pr.updated_at,
        }
    }
}

/// What the thread details sheet lists.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiThreadDetails {
    pub thread_id: String,
    pub project_title: Option<String>,
    /// The folder the thread works in: its worktree, else the project root.
    pub folder: Option<String>,
    /// `folder` with the home folder written as `~`.
    pub folder_label: Option<String>,
    pub branch: Option<String>,
    /// Latest first.
    pub pull_requests: Vec<FfiThreadPullRequest>,
    pub running: Vec<FfiThreadDetailsAgent>,
    pub previous: Vec<FfiThreadDetailsAgent>,
    /// `Subagents · 2 running`, or `Subagents`.
    pub subagents_title: String,
}

/// The details of `thread_id`: from its shell row, else from the open thread's own record. A
/// thread that is neither listed nor open gets details with only its id, so the sheet still shows
/// the rows that need no data.
pub(crate) fn thread_details(
    shell: &ShellState,
    timeline: Option<&ThreadState>,
    catalog: &ModelCatalog,
    thread_id: &str,
    now_secs: i64,
) -> FfiThreadDetails {
    let timeline = timeline.filter(|t| t.thread_id == thread_id);
    let Some(thread) = ThreadRecord::resolve(shell, timeline, thread_id) else {
        return FfiThreadDetails {
            thread_id: thread_id.to_owned(),
            project_title: None,
            folder: None,
            folder_label: None,
            branch: None,
            pull_requests: Vec::new(),
            running: Vec::new(),
            previous: Vec::new(),
            subagents_title: "Subagents".to_owned(),
        };
    };
    let lineage = thread_lineage(shell, thread, timeline, now_secs);
    let subagents_title = lineage.title();
    let folder = thread_cwd(shell, thread);
    let agents = |agents: Vec<ThreadAgent>| {
        agents
            .into_iter()
            .map(|agent| FfiThreadDetailsAgent::new(agent, catalog))
            .collect()
    };
    FfiThreadDetails {
        thread_id: thread.id().to_owned(),
        project_title: shell
            .project(thread.project_id())
            .map(|p| p.title.clone())
            .filter(|t| !t.is_empty()),
        folder_label: folder.as_deref().map(home_relative_path),
        folder,
        branch: thread.branch().map(str::to_owned),
        pull_requests: thread_pull_requests(thread)
            .into_iter()
            .map(|pr| FfiThreadPullRequest::new(pr, thread.project_id()))
            .collect(),
        running: agents(lineage.running),
        previous: agents(lineage.previous),
        subagents_title,
    }
}

/// The Git rows' facts for a folder (`vcs.refreshStatus`, local only).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiVcsSummary {
    pub is_repo: bool,
    /// The checkout's current ref.
    pub ref_name: Option<String>,
    /// Uncommitted changes.
    pub insertions: i64,
    pub deletions: i64,
}

impl From<conn_contract::VcsStatusResult> for FfiVcsSummary {
    fn from(status: conn_contract::VcsStatusResult) -> Self {
        Self {
            is_repo: status.is_repo,
            ref_name: status.ref_name,
            insertions: status.working_tree.insertions,
            deletions: status.working_tree.deletions,
        }
    }
}

/// The `conn://thread/<environmentId>/<threadId>` link "Copy thread link" writes.
#[uniffi::export]
#[must_use]
pub fn thread_link(environment_id: String, thread_id: String) -> String {
    conn_state::thread_details::format_thread_link(&environment_id, &thread_id)
}

#[cfg(test)]
mod tests {
    use conn_contract::{OrchestrationV2ShellStreamItem, OrchestrationV2ThreadStreamItem};
    use conn_state::testkit::{SyntheticThread, synthetic_thread_snapshot_json};
    use serde_json::{Value, json};

    use super::*;

    /// A shell with project `p` (`apps` at `/Users/nick/apps`) and no threads: the thread the
    /// tests open is one it leaves out.
    fn shell() -> ShellState {
        let snapshot = json!({
            "schemaVersion": 1,
            "snapshotSequence": 1,
            "projects": [{
                "id": "p", "title": "apps", "workspaceRoot": "/Users/nick/apps",
                "defaultModelSelection": null, "scripts": [],
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
                "deletedAt": null
            }],
            "threads": [],
            "archivedThreads": []
        });
        let item: OrchestrationV2ShellStreamItem =
            serde_json::from_value(json!({"kind": "snapshot", "snapshot": snapshot})).unwrap();
        let mut shell = ShellState::default();
        shell.apply(item);
        shell
    }

    /// The open thread `id` of project `p`, its record edited by `edit`.
    fn open_thread(id: &str, edit: impl FnOnce(&mut Value)) -> ThreadState {
        let raw = synthetic_thread_snapshot_json(SyntheticThread {
            turns: 1,
            commands_per_turn: 0,
            command_output_bytes: 0,
            assistant_bytes: 8,
        });
        let mut snapshot: Value = serde_json::from_str(&raw).unwrap();
        let thread = &mut snapshot["projection"]["thread"];
        thread["id"] = json!(id);
        thread["projectId"] = json!("p");
        edit(thread);
        let item: OrchestrationV2ThreadStreamItem = serde_json::from_value(snapshot).unwrap();
        let mut state = ThreadState::new(id);
        state.apply(item);
        state
    }

    #[test]
    fn an_open_thread_the_shell_leaves_out_reads_from_its_own_record() {
        let shell = shell();
        let timeline = open_thread("t", |thread| {
            thread["branch"] = json!("fix/details");
            thread["worktreePath"] = json!("/Users/nick/apps/conn-fix");
            thread["pullRequests"] = json!([{
                "host": "github.com", "repository": "nckrtl/conn", "number": 7,
                "url": "https://github.com/nckrtl/conn/pull/7", "source": "agent",
                "linkedAt": "2026-11-27T10:00:00Z", "snapshot": null, "stack": null
            }]);
        });
        assert!(shell.find_thread("t").is_none());

        let details = thread_details(&shell, Some(&timeline), &ModelCatalog::default(), "t", 0);
        assert_eq!(details.thread_id, "t");
        assert_eq!(details.project_title.as_deref(), Some("apps"));
        assert_eq!(details.folder.as_deref(), Some("/Users/nick/apps/conn-fix"));
        assert_eq!(details.folder_label.as_deref(), Some("~/apps/conn-fix"));
        assert_eq!(details.branch.as_deref(), Some("fix/details"));
        let prs: Vec<_> = details.pull_requests.iter().map(|pr| pr.number).collect();
        assert_eq!(prs, [7]);

        // Without a worktree the folder is the project's root.
        let timeline = open_thread("t", |_| {});
        let details = thread_details(&shell, Some(&timeline), &ModelCatalog::default(), "t", 0);
        assert_eq!(details.folder.as_deref(), Some("/Users/nick/apps"));
    }

    #[test]
    fn a_thread_neither_listed_nor_open_still_has_details() {
        let shell = shell();
        let other = open_thread("other", |thread| thread["branch"] = json!("main"));
        for timeline in [None, Some(&other)] {
            let details = thread_details(&shell, timeline, &ModelCatalog::default(), "t", 0);
            assert_eq!(details.thread_id, "t");
            assert_eq!(details.project_title, None);
            assert_eq!(details.folder, None);
            assert_eq!(details.branch, None);
            assert!(details.pull_requests.is_empty());
            assert!(details.running.is_empty() && details.previous.is_empty());
        }
    }
}
