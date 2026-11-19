//! The pull request link sweep, as T3's `PullRequestSyncReactor` and
//! `ThreadPullRequestService` run it. Every minute, and at once on a new link, it reads each
//! due linked pull request from GitHub through the panel's client (`gh`'s login) and writes its
//! snapshot and stack with `thread.pull-request-link.sync`. It also looks up each active
//! thread's branch on GitHub and writes the branch's pull request with
//! `thread.pull-request.sync`: the pull request the sidebar chip shows. The decisions live in
//! `conn_source_control::pull_requests::link_sync`; this file does the reads and dispatches.
//!
//! It runs in the watch loop's task (`watches::run`), so one GitHub read runs at a time.

use super::{Failure, Panel, Project};
use conn_source_control::{
    hosts::github_graphql::generated,
    pull_requests::{
        Lookup,
        link_sync::{
            self, BranchGroup, BranchProject, BranchSync, Group, LinkSync, ReadFailure, Scope,
            StackNeed, StackRead,
        },
        normalize::{array, text},
    },
    registry,
};
use conn_support::time::{iso_from_ms, now_ms};
use serde_json::{Map, Value, json};
use std::{path::Path, sync::Arc};

/// What the shell listener asks the sweep for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Request {
    /// A link without a snapshot appeared (`requestUnsyncedLinks`).
    Unsynced { project_id: String, link: Value },
    /// A thread settled: read its open and closed links once (`refreshUnmergedLinks`).
    Settled(Vec<String>),
    /// A thread's own event: look its branch up at once.
    Branch(String),
}

pub(super) struct Links {
    panel: Arc<Panel>,
    links: LinkSync,
    branches: BranchSync,
    started: bool,
}

/// `PullRequestUnavailableError` (no CLI, signed out, not GitHub) and not-found wait for the
/// slow cadence; anything else backs off.
fn read_failure(failure: &Failure) -> ReadFailure {
    match failure {
        Failure::Fail(value)
            if value["_tag"] == "PullRequestUnavailableError" || value["reason"] == "not-found" =>
        {
            ReadFailure::Missing
        }
        _ => ReadFailure::Failed,
    }
}

fn rate_limited(failure: &Failure) -> bool {
    matches!(failure, Failure::Fail(value) if value["cause"]["reason"] == "rate-limited")
}

impl Links {
    pub(super) fn new(panel: Arc<Panel>) -> Self {
        Self {
            panel,
            links: LinkSync::default(),
            branches: BranchSync::default(),
            started: false,
        }
    }

    pub(super) async fn handle(&mut self, request: Request) {
        match request {
            Request::Unsynced { project_id, link } => {
                self.links.request_unsynced(&project_id, &link);
                self.sweep(Scope::Requested).await;
            }
            Request::Settled(keys) => {
                for key in keys {
                    self.links.request(key);
                }
                self.sweep(Scope::Requested).await;
            }
            Request::Branch(thread_id) => self.branches(Some(&thread_id)).await,
        }
    }

    /// The minute sweep: due links, then branches.
    pub(super) async fn tick(&mut self) {
        self.sweep(Scope::All).await;
        self.branches(None).await;
    }

    async fn dispatch(&self, command: Value) -> Result<(), String> {
        let command = conn_contract::from_json(command).map_err(|e| e.to_string())?;
        self.panel
            .engine
            .dispatch(command)
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    /// One link sweep (`sweep`).
    pub(super) async fn sweep(&mut self, scope: Scope) {
        if scope == Scope::Requested && !self.links.has_pending() {
            return;
        }
        let Ok(shell) = self.panel.engine.shell_snapshot().await else {
            return;
        };
        let now = now_ms();
        let groups = self
            .links
            .begin(array(shell.get("threads")), scope, now as f64);
        for group in groups {
            self.read_group(&group, now).await;
        }
    }

    async fn read_group(&mut self, group: &Group, now: u64) {
        let reference = group.reference();
        let connected = self.panel.reference_client("summary", &reference).await;
        let (project, client, lookup) = match connected {
            Ok(connected) => connected,
            Err(failure) => {
                self.links
                    .read_failed(group, read_failure(&failure), now as f64);
                return;
            }
        };
        let summary = self
            .panel
            .load_read("summary", &reference, &project, &client, &lookup)
            .await;
        let summary = match summary {
            Ok(summary) => summary,
            Err(failure) => {
                self.links
                    .read_failed(group, read_failure(&failure), now as f64);
                return;
            }
        };
        let stack = match self.links.stack_need(group, &summary) {
            StackNeed::Keep => StackRead::Kept,
            StackNeed::Unstacked => StackRead::Read(Value::Null),
            StackNeed::Read => match self
                .panel
                .load_read("stack", &reference, &project, &client, &lookup)
                .await
            {
                Ok(stack) => StackRead::Read(link_sync::native_stack(&stack)),
                Err(failure) if rate_limited(&failure) => StackRead::Limited,
                Err(_) => StackRead::Failed,
            },
        };
        let commands = self.links.finish(
            group,
            &summary,
            stack,
            now as f64,
            &iso_from_ms(now),
            &mut conn_support::uuid_v4,
        );
        for command in commands {
            if self.dispatch(command).await.is_err() {
                self.links.dispatch_failed(group);
            }
        }
    }

    /// One branch lookup pass (`synchronize`): every active thread's branch, or one thread's.
    async fn branches(&mut self, thread: Option<&str>) {
        let Ok(shell) = self.panel.engine.shell_snapshot().await else {
            return;
        };
        let sequence = shell["snapshotSequence"].as_u64().unwrap_or(0);
        let now = now_ms() as f64;
        if !self.started && thread.is_none() {
            self.started = true;
            self.branches.start_backfill(array(shell.get("threads")));
        }
        let groups = self
            .branches
            .groups(array(shell.get("threads")), thread, now);
        for group in groups {
            let Some(project) = array(shell.get("projects"))
                .iter()
                .find(|p| text(p, "id") == group.project_id())
                .cloned()
            else {
                self.branches.finish(&group);
                continue;
            };
            self.lookup_branch(&group, &project, sequence, now).await;
        }
    }

    async fn lookup_branch(
        &mut self,
        group: &BranchGroup,
        project: &Value,
        sequence: u64,
        now: f64,
    ) {
        let Ok(github) = self
            .panel
            .projects(&json!({"projectId": group.project_id()}))
            .await
        else {
            return;
        };
        let Some(github) = github.into_iter().next() else {
            self.branches.finish(group);
            return;
        };
        let root = text(project, "workspaceRoot");
        // A worktree folder can outlive its `.git`; then the project's checkout answers.
        let cwd = match group.worktree_path() {
            Some(path) if exists(Path::new(path).join(".git")).await => path.to_owned(),
            _ => root.to_owned(),
        };
        let detected = match group.branch() {
            Some(branch) => match self.find(&github, Path::new(&cwd), branch).await {
                Ok(found) => found,
                Err(()) => {
                    let ids: Vec<&str> = group.threads.iter().map(|t| text(t, "id")).collect();
                    self.branches.fail(&ids);
                    return;
                }
            },
            None => None,
        };
        if group.branch().is_some() {
            self.branches.record(&group.key, now, detected.is_some());
        }
        let target = BranchProject {
            id: group.project_id(),
            workspace_root: root,
            repository: &github.repository,
        };
        let checked_out = match (&detected, group.branch()) {
            (Some(found), Some(branch))
                if link_sync::needs_checkout_check(group, &target, Some(found)) =>
            {
                conn_vcs::repo::config_get(
                    Path::new(&cwd),
                    &format!("branch.{branch}.t3-pull-request"),
                )
                .await
                .ok()
                .flatten()
                .is_some_and(|url| url == text(found, "url"))
            }
            _ => false,
        };
        let mut previous = Map::new();
        let candidate = link_sync::detected_reference(&target, detected.as_ref());
        for saved in link_sync::previous_to_check(group, &candidate) {
            let reference = json!({"projectId": saved["projectId"], "host": github.host,
                "repository": saved["repository"], "number": saved["number"]});
            if let Ok((project, client, lookup)) =
                self.panel.reference_client("summary", &reference).await
                && let Ok(summary) = self
                    .panel
                    .load_read("summary", &reference, &project, &client, &lookup)
                    .await
            {
                previous.insert(text(&saved, "url").to_owned(), summary);
            }
        }
        let commands = link_sync::plan_branch(
            group,
            &target,
            detected.as_ref(),
            checked_out,
            &previous,
            sequence,
            &mut conn_support::uuid_v4,
        );
        self.branches.finish(group);
        for command in commands {
            if self.dispatch(command.clone()).await.is_err() {
                self.branches.fail(&[text(&command, "threadId")]);
            }
        }
    }

    /// `branchPullRequest`: the branch's pull request on the project's GitHub repository, from
    /// the head repository the branch pushes to (its upstream remote, else the project's).
    async fn find(&self, project: &Project, cwd: &Path, branch: &str) -> Result<Option<Value>, ()> {
        let remote = conn_vcs::repo::config_get(cwd, &format!("branch.{branch}.remote"))
            .await
            .ok()
            .flatten()
            .filter(|r| !r.is_empty() && r != ".");
        let mut head = project.repository.clone();
        if let Some(remote) = &remote
            && let Ok(Some(url)) =
                conn_vcs::repo::config_get(cwd, &format!("remote.{remote}.url")).await
            && let Some((_, repository)) = registry::git_remote_repository(&url)
        {
            head = repository;
        }
        // The default branch of `origin`, else of the first remote, as T3 reads it.
        let default = conn_vcs::repo::Remotes::load(cwd)
            .await
            .ok()
            .and_then(|remotes| remotes.primary_default);
        let client = self
            .panel
            .client(project, "listChangeRequests")
            .await
            .map_err(|_| ())?;
        let lookup = Lookup::new(&project.repository, 1).map_err(|_| ())?;
        let result = client
            .graphql(
                &generated::PULL_REQUESTS_BY_HEAD,
                json!({"owner": lookup.owner, "name": lookup.name, "head": branch,
                    "states": ["OPEN", "CLOSED", "MERGED"], "first": 100}),
            )
            .await
            .map_err(|_| ())?;
        if result["repository"].is_null() {
            return Err(());
        }
        Ok(link_sync::branch_pull_request(
            array(result.pointer("/repository/pullRequests/nodes")),
            branch,
            &head,
            default.as_deref(),
        ))
    }
}

async fn exists(path: std::path::PathBuf) -> bool {
    tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(true)
}
