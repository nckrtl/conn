//! What a thread's details panel lists, for desktop's details card and the iPhone sheet: the
//! working folder, the linked pull requests, and the child agents (`ThreadDetailsPanel.tsx`,
//! `ThreadRelationshipsControl.tsx`).

use std::collections::HashSet;

use conn_contract::{
    OrchestrationV2AppThread as AppThread, OrchestrationV2AppThreadLineage as Lineage,
    OrchestrationV2AppThreadLineageRelationshipToParent as Relationship,
    OrchestrationV2PendingRuntimeRequestSummaryKind as RequestKind,
    OrchestrationV2ShellThreadStatus as ShellStatus, OrchestrationV2TurnItemForkSource,
    PullRequestState, ThreadLinkedPullRequest, ThreadPullRequestLink,
};

use crate::{
    RunStatus, ShellState, SubagentModel, ThreadShell, ThreadState, TimelineEntry, TurnItemStatus,
    format_duration, parse_iso8601_epoch_ms, providers::ModelCatalog, sidebar_rows::parks_at_idle,
    subagent_settled,
};

/// The `conn://thread/<environmentId>/<threadId>` link "Copy thread link" writes. The ids go in
/// as written, as the Conn Server writes them in its own links.
#[must_use]
pub fn format_thread_link(environment_id: &str, thread_id: &str) -> String {
    format!("conn://thread/{environment_id}/{thread_id}")
}

/// The thread a details panel describes: its shell row, else the open thread's own record. A
/// thread can be open without a shell row: an older settled thread the shell leaves out, one
/// opened from search or a link, or any thread while a new connection's shell has not arrived.
#[derive(Clone, Copy, Debug)]
pub enum ThreadRecord<'a> {
    Listed(&'a ThreadShell),
    Open(&'a AppThread),
}

impl<'a> From<&'a ThreadShell> for ThreadRecord<'a> {
    fn from(thread: &'a ThreadShell) -> Self {
        Self::Listed(thread)
    }
}

impl<'a> From<&'a AppThread> for ThreadRecord<'a> {
    fn from(thread: &'a AppThread) -> Self {
        Self::Open(thread)
    }
}

/// Reads one field that the shell row and the thread record share.
macro_rules! record_field {
    ($record:expr, $field:ident) => {
        match $record {
            ThreadRecord::Listed(thread) => &thread.$field,
            ThreadRecord::Open(thread) => &thread.$field,
        }
    };
}

impl<'a> ThreadRecord<'a> {
    /// `thread_id`'s shell row, else the record of `timeline` when it is that thread's.
    #[must_use]
    pub fn resolve(
        shell: &'a ShellState,
        timeline: Option<&'a ThreadState>,
        thread_id: &str,
    ) -> Option<Self> {
        shell.find_thread(thread_id).map(Self::Listed).or_else(|| {
            timeline
                .filter(|t| t.thread_id == thread_id && !t.deleted)
                .and_then(ThreadState::thread)
                .filter(|t| t.id == thread_id)
                .map(Self::Open)
        })
    }

    #[must_use]
    pub fn id(self) -> &'a str {
        record_field!(self, id)
    }

    #[must_use]
    pub fn project_id(self) -> &'a str {
        record_field!(self, project_id)
    }

    #[must_use]
    pub fn provider_instance_id(self) -> &'a str {
        record_field!(self, provider_instance_id)
    }

    /// The thread's branch, `None` when unset or empty.
    #[must_use]
    pub fn branch(self) -> Option<&'a str> {
        record_field!(self, branch)
            .as_deref()
            .filter(|b| !b.is_empty())
    }

    /// The thread's worktree, `None` when unset or empty.
    #[must_use]
    pub fn worktree_path(self) -> Option<&'a str> {
        record_field!(self, worktree_path)
            .as_deref()
            .filter(|p| !p.is_empty())
    }

    /// The shell row, for what only the shell carries (run status, background tasks).
    #[must_use]
    pub fn listed(self) -> Option<&'a ThreadShell> {
        match self {
            Self::Listed(thread) => Some(thread),
            Self::Open(_) => None,
        }
    }

    fn lineage(self) -> &'a Lineage {
        record_field!(self, lineage)
    }

    fn forked_from(self) -> Option<&'a OrchestrationV2TurnItemForkSource> {
        record_field!(self, forked_from).as_ref()
    }

    fn pull_requests(self) -> &'a [ThreadPullRequestLink] {
        record_field!(self, pull_requests)
            .as_deref()
            .unwrap_or_default()
    }

    fn branch_pull_request(self) -> Option<&'a ThreadLinkedPullRequest> {
        record_field!(self, branch_pull_request)
            .as_ref()
            .and_then(Option::as_ref)
            .or_else(|| {
                record_field!(self, linked_pull_request)
                    .as_ref()
                    .and_then(Option::as_ref)
            })
    }
}

/// The folder the thread works in: its worktree, else its project's root.
#[must_use]
pub fn thread_cwd<'a>(shell: &ShellState, thread: impl Into<ThreadRecord<'a>>) -> Option<String> {
    let thread = thread.into();
    thread.worktree_path().map(str::to_owned).or_else(|| {
        shell
            .project(thread.project_id())
            .map(|p| p.workspace_root.clone())
            .filter(|p| !p.is_empty())
    })
}

/// `path` with the home folder written as `~`: `/Users/nick/apps/conn` reads `~/apps/conn`.
#[must_use]
pub fn home_relative_path(path: &str) -> String {
    let rest = ["/Users/", "/home/"]
        .iter()
        .find_map(|prefix| path.strip_prefix(prefix))
        .and_then(|after| after.find('/').map(|slash| &after[slash..]).or(Some("")))
        .or_else(|| {
            path.strip_prefix("/root")
                .filter(|r| r.is_empty() || r.starts_with('/'))
        });
    match rest {
        Some(rest) => format!("~{rest}"),
        None => path.to_owned(),
    }
}

/// Where a child agent is in its run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadAgentState {
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
    Idle,
}

impl ThreadAgentState {
    #[must_use]
    pub fn is_live(self) -> bool {
        matches!(self, Self::Running | Self::Waiting)
    }

    #[must_use]
    pub fn text(self) -> &'static str {
        match self {
            Self::Running => "Running",
            Self::Waiting => "Waiting",
            Self::Done => "Done",
            Self::Failed => "Failed",
            Self::Stopped => "Stopped",
            Self::Idle => "Idle",
        }
    }

    #[must_use]
    pub fn from_shell(status: ShellStatus) -> Self {
        match status {
            ShellStatus::Preparing
            | ShellStatus::Queued
            | ShellStatus::Starting
            | ShellStatus::Running => Self::Running,
            ShellStatus::Waiting => Self::Waiting,
            ShellStatus::Completed => Self::Done,
            ShellStatus::Failed => Self::Failed,
            ShellStatus::Interrupted | ShellStatus::Cancelled | ShellStatus::RolledBack => {
                Self::Stopped
            }
            ShellStatus::Idle => Self::Idle,
        }
    }

    #[must_use]
    pub fn from_item(status: TurnItemStatus) -> Self {
        match status {
            TurnItemStatus::Pending | TurnItemStatus::Running => Self::Running,
            TurnItemStatus::Waiting => Self::Waiting,
            TurnItemStatus::Completed => Self::Done,
            TurnItemStatus::Failed => Self::Failed,
            TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => Self::Stopped,
            TurnItemStatus::Idle => Self::Idle,
        }
    }
}

/// One child of the thread: a native subagent, a `delegate_task` child, or a child that runs on
/// another linked environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadAgent {
    /// Stable id: the child thread, else the timeline entry.
    pub key: String,
    /// The thread a click opens; empty when the child has none yet.
    pub thread_id: String,
    /// The linked environment the child runs on; `None` is the thread's own environment.
    pub environment_id: Option<String>,
    /// `on <label>` for a child on another environment.
    pub environment_label: Option<String>,
    /// The parent's `subagent` timeline entry for this child, when its timeline has one.
    pub entry_id: Option<String>,
    pub title: String,
    /// The subagent's role (a driver, or `remote` for a child on another machine), else the
    /// child thread's instance id.
    pub provider: String,
    /// The model it runs: the child's own selection first, then the parent's subagent record.
    /// Each client names it from its catalog.
    pub model: Option<SubagentModel>,
    pub state: ThreadAgentState,
    /// `13s`, `2m 4s`: how long it ran, or has run so far.
    pub elapsed: Option<String>,
}

impl ThreadAgent {
    /// The driver behind the agent's provider mark, as far as the parent's `catalog` knows:
    /// the driver of [`Self::provider`] as an instance id, then of the instance or slug of
    /// [`Self::model`]. Else [`Self::provider`] as it is: a role names a driver itself, and
    /// `remote` or an unknown instance stays unbranded.
    #[must_use]
    pub fn provider_driver<'a>(&'a self, catalog: &'a ModelCatalog) -> &'a str {
        let model = self.model.as_ref();
        let instance = model.and_then(|model| model.instance_id.as_deref());
        [
            catalog.driver_for_instance(&self.provider),
            instance.and_then(|instance| catalog.driver_for_instance(instance)),
            model
                .and_then(|model| model.model.as_deref())
                .and_then(|slug| catalog.find_model(instance, slug))
                .map(|found| found.driver.as_str()),
        ]
        .into_iter()
        .flatten()
        .find(|driver| !driver.is_empty())
        .unwrap_or(&self.provider)
    }
}

/// The thread's parent (or fork source) and its children, live ones first.
#[derive(Debug, Default)]
pub struct ThreadLineage<'a> {
    pub parent: Option<&'a ThreadShell>,
    pub is_fork: bool,
    pub running: Vec<ThreadAgent>,
    pub previous: Vec<ThreadAgent>,
}

impl ThreadLineage<'_> {
    #[must_use]
    pub fn failed_count(&self) -> usize {
        self.previous
            .iter()
            .filter(|t| t.state == ThreadAgentState::Failed)
            .count()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.parent.is_none() && self.running.is_empty() && self.previous.is_empty()
    }

    /// `Subagents · N running` when children run, else `Subagents`.
    #[must_use]
    pub fn title(&self) -> String {
        if self.running.is_empty() {
            "Subagents".to_owned()
        } else {
            format!("Subagents · {} running", self.running.len())
        }
    }
}

/// Whether the sidebar shows `thread` as working or waiting (not as asking for approval or
/// input): `resolveSidebarThreadStatus` without the subagent request.
#[must_use]
pub fn shell_thread_live(thread: &ThreadShell) -> bool {
    let request = thread.pending_runtime_request.as_ref().map(|r| r.kind);
    if request.is_some_and(|kind| kind != RequestKind::AuthRefresh) {
        return false;
    }
    parks_at_idle(thread)
        || matches!(
            thread.status,
            ShellStatus::Preparing
                | ShellStatus::Queued
                | ShellStatus::Starting
                | ShellStatus::Running
                | ShellStatus::Waiting
        )
        || matches!(thread.activity_run_status, Some(Some(_)))
}

/// The model of the subagent behind timeline entry `entry_id`.
fn entry_model(timeline: Option<&ThreadState>, entry_id: &str) -> Option<SubagentModel> {
    let timeline = timeline?;
    timeline
        .subagent_of_entry
        .get(entry_id)
        .and_then(|subagent| timeline.subagent_models.get(subagent))
        .or_else(|| timeline.subagent_models.get(entry_id))
        .cloned()
}

/// How long a child ran, or has run, from its ISO-8601 start and end.
fn agent_elapsed(
    live: bool,
    started_at: Option<&str>,
    completed_at: Option<&str>,
    now_secs: i64,
) -> Option<String> {
    let start = started_at.and_then(parse_iso8601_epoch_ms)?;
    let end = if live {
        now_secs.saturating_mul(1000)
    } else {
        parse_iso8601_epoch_ms(completed_at?)?
    };
    u64::try_from(end - start).ok().map(format_duration)
}

/// A child that has a thread in the shell.
fn shell_agent(child: &ThreadShell, timeline: Option<&ThreadState>, now_secs: i64) -> ThreadAgent {
    let entry = timeline.and_then(|t| {
        t.entries.iter().find_map(|e| match e {
            TimelineEntry::Subagent {
                id,
                child_thread_id,
                started_at,
                completed_at,
                ..
            } if child_thread_id.as_deref() == Some(child.id.as_str()) => {
                Some((id.as_str(), started_at.as_deref(), completed_at.as_deref()))
            }
            _ => None,
        })
    });
    let state = match ThreadAgentState::from_shell(child.status) {
        // A row the sidebar shows as working is running, whatever its last run says.
        s if shell_thread_live(child) && !s.is_live() => ThreadAgentState::Running,
        s => s,
    };
    let run_started = child
        .activity_run_started_at
        .as_ref()
        .and_then(Option::as_deref)
        .or_else(|| {
            child
                .latest_run_started_at
                .as_ref()
                .and_then(Option::as_deref)
        });
    let run_completed = child
        .latest_run_completed_at
        .as_ref()
        .and_then(Option::as_deref);
    let elapsed = if state.is_live() {
        agent_elapsed(true, run_started, None, now_secs)
    } else {
        agent_elapsed(false, run_started, run_completed, now_secs)
            .or_else(|| entry.and_then(|(_, s, c)| agent_elapsed(false, s, c, now_secs)))
    };
    // The child's own selection first: the parent's subagent record can lack its options.
    let model = Some(SubagentModel::from_selection(
        &child.provider_instance_id,
        &child.model_selection,
    ))
    .filter(|m| m.model.is_some())
    .or_else(|| entry.and_then(|(id, ..)| entry_model(timeline, id)));
    ThreadAgent {
        key: child.id.clone(),
        thread_id: child.id.clone(),
        environment_id: None,
        environment_label: None,
        entry_id: entry.map(|(id, ..)| id.to_owned()),
        title: child.title.clone(),
        provider: child.provider_instance_id.clone(),
        model,
        state,
        elapsed,
    }
}

/// Children the timeline lists but the shell does not: `delegate_task` children on another
/// linked environment, and native subagents whose thread is not loaded.
fn timeline_agents(
    shell: &ShellState,
    timeline: Option<&ThreadState>,
    now_secs: i64,
    seen: &mut HashSet<String>,
) -> Vec<ThreadAgent> {
    let mut rows = Vec::new();
    for entry in timeline.into_iter().flat_map(|t| &t.entries) {
        let TimelineEntry::Subagent {
            id,
            child_thread_id,
            title,
            role,
            status,
            remote_child,
            started_at,
            completed_at,
            ..
        } = entry
        else {
            continue;
        };
        let (thread_id, environment_id, environment_label, title) = match remote_child {
            Some(remote) => (
                remote.thread_id.clone(),
                Some(remote.environment_id.clone()),
                Some(remote.label.clone()),
                remote
                    .title
                    .clone()
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| title.clone()),
            ),
            None => {
                let thread_id = child_thread_id.clone().unwrap_or_default();
                // A child the shell lists is a shell row, unless the panel hides it on purpose.
                if let Some(child) = shell.find_thread(&thread_id) {
                    if child.deleted_at.is_none()
                        && child.lineage.side_chat != Some(true)
                        && seen.insert(child.id.clone())
                    {
                        rows.push(shell_agent(child, timeline, now_secs));
                    }
                    continue;
                }
                (thread_id, None, None, title.clone())
            }
        };
        let key = if thread_id.is_empty() {
            id.clone()
        } else {
            thread_id.clone()
        };
        if !seen.insert(key.clone()) {
            continue;
        }
        rows.push(ThreadAgent {
            key,
            thread_id,
            environment_id,
            environment_label,
            entry_id: Some(id.clone()),
            title,
            provider: role.clone(),
            model: entry_model(timeline, id),
            state: ThreadAgentState::from_item(*status),
            elapsed: agent_elapsed(
                !subagent_settled(*status),
                started_at.as_deref(),
                completed_at.as_deref(),
                now_secs,
            ),
        });
    }
    rows
}

/// The subagents the open thread's projection lists without a timeline row (a bounded snapshot
/// leaves older rows out), so a running child shows from the first projection, as the turn's
/// agents do (`ThreadState::turn_agents`).
fn record_agents(
    shell: &ShellState,
    timeline: Option<&ThreadState>,
    now_secs: i64,
    seen: &mut HashSet<String>,
) -> Vec<ThreadAgent> {
    let Some(timeline) = timeline else {
        return Vec::new();
    };
    let listed: HashSet<&str> = timeline
        .entries
        .iter()
        .filter_map(|entry| match entry {
            TimelineEntry::Subagent { id, .. } => Some(
                timeline
                    .subagent_of_entry
                    .get(id)
                    .map_or(id.as_str(), String::as_str),
            ),
            _ => None,
        })
        .collect();
    let mut records: Vec<_> = timeline
        .subagents
        .values()
        .filter(|record| !listed.contains(record.id.as_str()))
        .filter(|record| {
            record
                .run_id
                .as_deref()
                .and_then(|run| timeline.run_status(run))
                != Some(RunStatus::RolledBack)
        })
        .collect();
    records.sort_by(|a, b| (&a.started_at, &a.id).cmp(&(&b.started_at, &b.id)));
    let mut rows = Vec::new();
    for record in records {
        let (thread_id, environment_id) = match &record.remote_child {
            Some((environment, thread)) => (thread.clone(), Some(environment.clone())),
            None => (record.child_thread_id.clone().unwrap_or_default(), None),
        };
        if environment_id.is_none()
            && let Some(child) = shell.find_thread(&thread_id)
        {
            if child.deleted_at.is_none()
                && child.lineage.side_chat != Some(true)
                && seen.insert(child.id.clone())
            {
                rows.push(shell_agent(child, Some(timeline), now_secs));
            }
            continue;
        }
        let key = if thread_id.is_empty() {
            record.id.clone()
        } else {
            thread_id.clone()
        };
        if !seen.insert(key.clone()) {
            continue;
        }
        rows.push(ThreadAgent {
            key,
            thread_id,
            environment_id,
            environment_label: None,
            entry_id: None,
            title: record.title.clone(),
            provider: record.provider_instance_id.clone(),
            model: timeline.subagent_models.get(&record.id).cloned(),
            state: ThreadAgentState::from_item(record.status),
            elapsed: agent_elapsed(
                record.live(),
                record.started_at.as_deref(),
                record.completed_at.as_deref(),
                now_secs,
            ),
        });
    }
    rows
}

/// The parent (or fork source) and child agents of `thread`: the shell's children, then the
/// children only its timeline lists (the ones on another environment), then the subagents only
/// its projection lists.
#[must_use]
pub fn thread_lineage<'a, 'b>(
    shell: &'a ShellState,
    thread: impl Into<ThreadRecord<'b>>,
    timeline: Option<&ThreadState>,
    now_secs: i64,
) -> ThreadLineage<'a> {
    let thread = thread.into();
    let fork_source = match thread.forked_from() {
        Some(OrchestrationV2TurnItemForkSource::Run(run)) => Some(run.thread_id.as_str()),
        _ => None,
    };
    let lineage = thread.lineage();
    let parent_id = lineage.parent_thread_id.as_deref().or(fork_source);
    let is_fork =
        fork_source.is_some() || matches!(lineage.relationship_to_parent, Some(Relationship::Fork));
    let mut lineage = ThreadLineage {
        parent: parent_id.and_then(|id| shell.find_thread(id)),
        is_fork,
        ..ThreadLineage::default()
    };
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for child in shell.threads.iter().chain(shell.archived_threads.iter()) {
        if child.deleted_at.is_some()
            || child.lineage.parent_thread_id.as_deref() != Some(thread.id())
            || child.lineage.side_chat == Some(true)
            || !seen.insert(child.id.clone())
        {
            continue;
        }
        rows.push(shell_agent(child, timeline, now_secs));
    }
    rows.extend(timeline_agents(shell, timeline, now_secs, &mut seen));
    rows.extend(record_agents(shell, timeline, now_secs, &mut seen));
    for row in rows {
        if row.state.is_live() {
            lineage.running.push(row);
        } else {
            lineage.previous.push(row);
        }
    }
    lineage
}

/// A pull request's state as the panel shows it: a draft is its own state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadPullRequestState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl ThreadPullRequestState {
    #[must_use]
    pub fn text(self) -> &'static str {
        match self {
            Self::Open => "Open",
            Self::Draft => "Draft",
            Self::Merged => "Merged",
            Self::Closed => "Closed",
        }
    }
}

/// A pull request linked to the thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadPullRequest {
    pub host: Option<String>,
    pub repository: String,
    pub number: i64,
    pub url: String,
    /// `None` until the server has synced the pull request.
    pub title: Option<String>,
    pub state: Option<ThreadPullRequestState>,
    pub head_branch: Option<String>,
    pub base_branch: Option<String>,
    pub author: Option<String>,
    pub updated_at: Option<String>,
}

impl ThreadPullRequest {
    /// `#number: title`, or `#number` before the title has synced.
    #[must_use]
    pub fn line(&self) -> String {
        match &self.title {
            Some(title) => format!("#{}: {title}", self.number),
            None => format!("#{}", self.number),
        }
    }
}

/// The thread's linked pull requests, latest first; without any, the PR of its branch.
#[must_use]
pub fn thread_pull_requests<'a>(thread: impl Into<ThreadRecord<'a>>) -> Vec<ThreadPullRequest> {
    let thread = thread.into();
    let mut prs: Vec<ThreadPullRequest> = thread
        .pull_requests()
        .iter()
        .rev()
        .map(|pr| {
            let snapshot = pr.snapshot.as_ref();
            ThreadPullRequest {
                host: Some(pr.host.clone()),
                repository: pr.repository.clone(),
                number: pr.number,
                url: pr.url.clone(),
                title: snapshot.map(|s| s.title.clone()),
                state: snapshot.map(|s| match s.state {
                    PullRequestState::Merged => ThreadPullRequestState::Merged,
                    PullRequestState::Closed => ThreadPullRequestState::Closed,
                    PullRequestState::Open if s.is_draft => ThreadPullRequestState::Draft,
                    PullRequestState::Open => ThreadPullRequestState::Open,
                }),
                head_branch: snapshot.map(|s| s.head_branch.clone()),
                base_branch: snapshot.map(|s| s.base_branch.clone()),
                author: snapshot
                    .and_then(|s| s.author.clone().flatten())
                    .map(|a| a.login),
                updated_at: snapshot.and_then(|s| s.updated_at.clone()),
            }
        })
        .collect();
    if prs.is_empty()
        && let Some(pr) = thread.branch_pull_request()
    {
        prs.push(ThreadPullRequest {
            host: None,
            repository: pr.repository.clone(),
            number: pr.number,
            url: pr.url.clone(),
            title: None,
            state: None,
            head_branch: None,
            base_branch: None,
            author: None,
            updated_at: None,
        });
    }
    prs
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::test_threads::thread;

    fn link(number: i64, state: &str, draft: bool) -> Value {
        json!({
            "host": "github.com",
            "repository": "nckrtl/conn",
            "number": number,
            "url": format!("https://github.com/nckrtl/conn/pull/{number}"),
            "source": "agent",
            "linkedAt": "2026-11-27T10:00:00Z",
            "snapshot": {
                "state": state,
                "title": format!("PR {number}"),
                "headBranch": "feature",
                "baseBranch": "main",
                "isDraft": draft,
                "updatedAt": null,
                "syncedAt": "2026-11-27T10:00:00Z",
            },
            "stack": null,
        })
    }

    fn agent(provider: &str, model: Option<(&str, &str)>) -> ThreadAgent {
        ThreadAgent {
            key: "child".to_owned(),
            thread_id: "child".to_owned(),
            environment_id: None,
            environment_label: None,
            entry_id: None,
            title: "Child".to_owned(),
            provider: provider.to_owned(),
            model: model.map(|(instance, slug)| SubagentModel {
                model: Some(slug.to_owned()),
                instance_id: Some(instance.to_owned()),
                options: std::collections::HashMap::new(),
            }),
            state: ThreadAgentState::Running,
            elapsed: None,
        }
    }

    #[test]
    fn the_catalog_names_a_custom_instance_or_a_remote_childs_driver() {
        let provider = |instance: &str, driver: &str, slug: &str| {
            serde_json::from_value(json!({
                "instanceId": instance, "driver": driver, "enabled": true, "installed": true,
                "status": "ready", "auth": {"status": "authenticated"},
                "checkedAt": "2026-11-28T00:00:00Z",
                "models": [{ "slug": slug, "name": slug, "isCustom": false }],
            }))
            .expect("provider decodes")
        };
        let catalog = ModelCatalog::from_providers(&[
            Some(provider("work", "codex", "sol-1")),
            Some(provider("box", "claudeAgent", "frontier-1")),
        ]);
        // A shell child on a custom instance.
        assert_eq!(agent("work", None).provider_driver(&catalog), "codex");
        // A child on another machine: the model's instance, else its slug.
        let remote = agent("remote", Some(("box", "frontier-1")));
        assert_eq!(remote.provider_driver(&catalog), "claudeAgent");
        let remote = agent("remote", Some(("elsewhere", "sol-1")));
        assert_eq!(remote.provider_driver(&catalog), "codex");
        // Nothing the catalog knows: the role or instance as it is.
        assert_eq!(agent("grok", None).provider_driver(&catalog), "grok");
        let unknown = agent("remote", Some(("mystery", "mystery-1")));
        assert_eq!(unknown.provider_driver(&catalog), "remote");
    }

    #[test]
    fn home_folders_read_as_a_tilde() {
        assert_eq!(home_relative_path("/Users/nick/apps/conn"), "~/apps/conn");
        assert_eq!(home_relative_path("/home/nick"), "~");
        assert_eq!(home_relative_path("/root/work"), "~/work");
        assert_eq!(home_relative_path("/rootless/x"), "/rootless/x");
        assert_eq!(home_relative_path("/srv/workspace"), "/srv/workspace");
    }

    #[test]
    fn linked_pull_requests_list_latest_first_with_drafts_as_their_own_state() {
        let shell = thread("t", "p", |value| {
            value["pullRequests"] = json!([
                link(1, "merged", false),
                link(2, "open", true),
                link(3, "open", false),
            ]);
        });
        let states: Vec<_> = thread_pull_requests(&shell)
            .into_iter()
            .map(|pr| (pr.number, pr.state))
            .collect();
        assert_eq!(
            states,
            [
                (3, Some(ThreadPullRequestState::Open)),
                (2, Some(ThreadPullRequestState::Draft)),
                (1, Some(ThreadPullRequestState::Merged)),
            ]
        );
    }

    #[test]
    fn without_linked_pull_requests_the_branch_pull_request_stands_in() {
        let shell = thread("t", "p", |value| {
            value["branchPullRequest"] = json!({
                "projectId": "p",
                "repository": "nckrtl/conn",
                "number": 7,
                "url": "https://github.com/nckrtl/conn/pull/7",
            });
        });
        let prs = thread_pull_requests(&shell);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].line(), "#7");
        assert_eq!(prs[0].host, None);
    }
}
