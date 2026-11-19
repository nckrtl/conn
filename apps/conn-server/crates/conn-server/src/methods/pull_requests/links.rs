//! The pull request link sweep, as T3's `PullRequestSyncReactor` and
//! `ThreadPullRequestService` run it. Every minute, and at once on a new link, it reads each
//! due linked pull request from GitHub through the panel's client (`gh`'s login) and writes its
//! snapshot and stack with `thread.pull-request-link.sync`. It also looks up each active
//! thread's branch on GitHub and writes the branch's pull request with
//! `thread.pull-request.sync`: the pull request the sidebar chip shows. The decisions live in
//! `conn_source_control::pull_requests::link_sync`; this file does the reads and dispatches.
//!
//! It runs in its own task beside the watch loop (`watches::run`), one GitHub read at a time,
//! so a slow lookup never holds back a new watch's first read.

use super::{Failure, Panel, Project};
use conn_source_control::{
    pull_requests::{
        link_sync::{
            self, BranchGroup, BranchHead, BranchProject, BranchSync, Group, LinkSync, ReadFailure,
            Scope, StackNeed, StackRead,
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
    /// The minute sweep after the first runs only while a client is in the foreground
    /// (`backgroundPolicy.shouldRunOpportunisticWork`); a thread's own events always look up.
    async fn branches(&mut self, thread: Option<&str>) {
        if thread.is_none() && self.started && !self.panel.opportunistic() {
            return;
        }
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
        // Git reads first, then one GitHub document per 25 heads of a host (T3 batches its
        // background head lookups by host and credential), then the writes.
        let mut prepared = Vec::new();
        for group in groups {
            let Some(project) = array(shell.get("projects"))
                .iter()
                .find(|p| text(p, "id") == group.project_id())
                .cloned()
            else {
                self.branches.finish(&group, &[]);
                continue;
            };
            let Ok(github) = self
                .panel
                .projects(&json!({"projectId": group.project_id()}))
                .await
            else {
                continue;
            };
            let Some(github) = github.into_iter().next() else {
                self.branches.finish(&group, &[]);
                continue;
            };
            let root = text(&project, "workspaceRoot").to_owned();
            // A worktree folder can outlive its `.git`; then the project's checkout answers.
            let cwd = match group.worktree_path() {
                Some(path) if exists(Path::new(path).join(".git")).await => path.to_owned(),
                _ => root.clone(),
            };
            let head = match group.branch() {
                Some(branch) => Some(head_of(&github, Path::new(&cwd), branch).await),
                None => None,
            };
            prepared.push(Prepared {
                group,
                root,
                cwd,
                github,
                head,
                found: None,
            });
        }
        self.look_up(&mut prepared).await;
        for item in prepared {
            self.write_branch(item, sequence, now).await;
        }
    }

    /// Fills `found` for every prepared group with a branch: `Some(Ok(..))` when GitHub
    /// answered.
    async fn look_up(&self, prepared: &mut [Prepared]) {
        let mut hosts: Vec<String> = prepared
            .iter()
            .filter(|p| p.head.is_some())
            .map(|p| p.github.host.clone())
            .collect();
        hosts.sort();
        hosts.dedup();
        for host in hosts {
            let members: Vec<usize> = (0..prepared.len())
                .filter(|&i| {
                    prepared
                        .get(i)
                        .is_some_and(|p| p.head.is_some() && p.github.host == host)
                })
                .collect();
            let Some(first) = members.first().and_then(|&i| prepared.get(i)) else {
                continue;
            };
            let Ok(client) = self.panel.client(&first.github, "listChangeRequests").await else {
                continue;
            };
            let heads: Vec<(String, String, String)> = members
                .iter()
                .filter_map(|&i| prepared.get(i))
                .map(|p| {
                    let (owner, name) = p.github.repository.split_once('/').unwrap_or_default();
                    let head = p.head.as_ref().map_or("", |h| h.head.name.as_str());
                    (owner.to_owned(), name.to_owned(), head.to_owned())
                })
                .collect();
            let Ok(answers) = client.pull_requests_by_heads(&heads).await else {
                continue;
            };
            for (&i, nodes) in members.iter().zip(answers) {
                if let Some(item) = prepared.get_mut(i) {
                    item.found = nodes.map(|nodes| {
                        let default = item.head.as_ref().and_then(|h| h.default_branch.clone());
                        item.head.as_ref().and_then(|h| {
                            link_sync::branch_pull_request(&nodes, &h.head, default.as_deref())
                        })
                    });
                }
            }
        }
    }

    async fn write_branch(&mut self, item: Prepared, sequence: u64, now: f64) {
        let Prepared {
            group,
            root,
            cwd,
            github,
            head,
            found,
        } = item;
        let detected = match (&head, found) {
            (None, _) => None,
            (Some(_), Some(found)) => found,
            (Some(_), None) => {
                let ids: Vec<&str> = group.threads.iter().map(|t| text(t, "id")).collect();
                self.branches.fail(&ids);
                return;
            }
        };
        if group.branch().is_some() {
            self.branches.record(&group.key, now, detected.is_some());
        }
        let target = BranchProject {
            id: group.project_id(),
            workspace_root: &root,
            repository: &github.repository,
        };
        let checked_out = match (&detected, group.branch()) {
            (Some(found), Some(branch))
                if link_sync::needs_checkout_check(&group, &target, Some(found)) =>
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
        for saved in link_sync::previous_to_check(&group, &target, detected.as_ref(), checked_out) {
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
        let plan = link_sync::plan_branch(
            &group,
            &target,
            detected.as_ref(),
            checked_out,
            &previous,
            sequence,
            &mut conn_support::uuid_v4,
        );
        self.branches.finish(&group, &plan.failed);
        for command in plan.commands {
            if self.dispatch(command.clone()).await.is_err() {
                self.branches.fail(&[text(&command, "threadId")]);
            }
        }
    }
}

/// A branch group ready for its GitHub lookup.
struct Prepared {
    group: BranchGroup,
    root: String,
    cwd: String,
    github: Project,
    head: Option<HeadQuery>,
    /// `None`: not looked up, or GitHub failed. `Some(found)`: GitHub answered.
    found: Option<Option<Value>>,
}

struct HeadQuery {
    head: BranchHead,
    default_branch: Option<String>,
}

/// `resolveBranchHeadContext`: a branch with an upstream pushes to that remote's branch
/// (`branch.<b>.remote`, `branch.<b>.merge`), as Conn's checkout of someone's pull request
/// sets it up; otherwise its own name in the project's repository. The default branch is
/// `origin`'s, else the first remote's.
async fn head_of(project: &Project, cwd: &Path, branch: &str) -> HeadQuery {
    let config = |key: String| async move {
        conn_vcs::repo::config_get(cwd, &key)
            .await
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    };
    let remote = config(format!("branch.{branch}.remote"))
        .await
        .filter(|r| r != ".");
    let merge = config(format!("branch.{branch}.merge")).await;
    let mut head = BranchHead {
        branch: branch.to_owned(),
        name: branch.to_owned(),
        repository: project.repository.clone(),
    };
    if let (Some(remote), Some(merge)) = (remote, merge) {
        head.name = merge
            .strip_prefix("refs/heads/")
            .unwrap_or(&merge)
            .to_owned();
        if let Some(url) = config(format!("remote.{remote}.url")).await
            && let Some((_, repository)) = registry::git_remote_repository(&url)
        {
            head.repository = repository;
        }
    }
    let default_branch = conn_vcs::repo::Remotes::load(cwd)
        .await
        .ok()
        .and_then(|remotes| remotes.primary_default);
    HeadQuery {
        head,
        default_branch,
    }
}

async fn exists(path: std::path::PathBuf) -> bool {
    tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(true)
}
