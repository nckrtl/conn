//! The shells of the environments a client shows beside its primary one, merged into one list.
//!
//! Conn connects to every saved environment and lists their threads together: one sidebar, each
//! row remembering the environment it lives on. [`LinkedShells`] holds one [`ShellState`] per
//! linked environment (the primary environment's shell stays with the client, with its Settled
//! shelf paging), and [`LinkedShells::merged`] builds the shell the sidebar reads plus the
//! [`Origins`] that say which environment each project and thread belongs to.
//!
//! Plain data in and out, so the iPhone app can share it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::shell::Place;
use crate::{
    OlderPageRequest, ProjectShell, ShellChange, ShellState, ShellStreamItem, ThreadShell,
};
use conn_contract::OrchestrationV2OlderSettledThreadsPage as OlderSettledPage;

/// A linked environment and what the sidebar calls it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentLabel {
    pub id: String,
    pub label: String,
}

/// What a client keeps of a linked environment's shell between launches, so its threads list
/// while the environment is asleep or offline (Conn saves each environment's last snapshot:
/// `EnvironmentCacheStore.saveShell`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedShellSnapshot {
    pub version: u32,
    pub environment_id: String,
    pub label: String,
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
    pub archived_threads: Vec<ThreadShell>,
    pub sequence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    older: Option<crate::shell::OlderSettled>,
}

impl LinkedShellSnapshot {
    /// The layout of the saved file. A file of another version is ignored, never half-read.
    pub const VERSION: u32 = 1;

    #[must_use]
    pub fn capture(environment_id: &str, label: &str, shell: &ShellState) -> Self {
        Self {
            version: Self::VERSION,
            environment_id: environment_id.to_owned(),
            label: label.to_owned(),
            projects: shell.projects.clone(),
            threads: shell.threads.clone(),
            archived_threads: shell.archived_threads.clone(),
            sequence: shell.sequence,
            older: None,
        }
    }

    /// Includes the settled pages and their cutoff so the cached phone inventory matches the screen.
    #[must_use]
    pub fn capture_inventory(environment_id: &str, shell: &ShellState) -> Self {
        let mut snapshot = Self::capture(environment_id, "", shell);
        if shell.older_settled().cut.is_some() {
            snapshot.older = Some(shell.older.clone());
        }
        snapshot
    }

    #[must_use]
    pub fn into_shell(self) -> ShellState {
        let mut shell = ShellState::from_parts(
            self.projects,
            self.threads,
            self.archived_threads,
            self.sequence,
        );
        shell.older = self.older.unwrap_or_default();
        shell
    }

    /// # Errors
    /// Returns the serializer's error.
    pub fn to_json(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(self)
    }

    /// The snapshot saved in `bytes`, or `None` when it is unreadable or of another version.
    #[must_use]
    pub fn from_json(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice::<Self>(bytes)
            .ok()
            .filter(|snapshot| snapshot.version == Self::VERSION)
    }
}

#[derive(Clone, Debug, Default)]
struct LinkedShell {
    label: String,
    shell: ShellState,
}

/// One shell per linked environment, in the order the environments were first seen.
#[derive(Clone, Debug, Default)]
pub struct LinkedShells {
    order: Vec<String>,
    shells: HashMap<String, LinkedShell>,
    /// Other ids the environments go by, to the id a merge names them by.
    aliases: HashMap<String, String>,
}

impl LinkedShells {
    /// Adds `environment_id` with an empty shell, or renames it when it is already held.
    pub fn ensure(&mut self, environment_id: &str, label: &str) {
        if let Some(existing) = self.shells.get_mut(environment_id) {
            label.clone_into(&mut existing.label);
            return;
        }
        self.order.push(environment_id.to_owned());
        self.shells.insert(
            environment_id.to_owned(),
            LinkedShell {
                label: label.to_owned(),
                shell: ShellState::default(),
            },
        );
    }

    /// Sets the other ids the environments go by, each to the id merges name it by: the
    /// environment id a server's config reports, when the app knows that server by an Orbit
    /// target id or URL. A task's `delegatedFrom` carries the configured id. Returns whether the
    /// aliases changed; the merged shell takes them at the next [`Self::merge_into`].
    pub fn set_environment_aliases(&mut self, aliases: HashMap<String, String>) -> bool {
        let aliases: HashMap<String, String> = aliases
            .into_iter()
            .filter(|(alias, id)| alias != id)
            .collect();
        if self.aliases == aliases {
            return false;
        }
        self.aliases = aliases;
        true
    }

    /// Forgets an environment and everything it listed.
    pub fn remove(&mut self, environment_id: &str) -> bool {
        self.order.retain(|id| id != environment_id);
        self.shells.remove(environment_id).is_some()
    }

    /// Applies one `subscribeShell` item of `environment_id`. `None` when no such environment is
    /// held: an item from a connection that was just dropped.
    pub fn apply(&mut self, environment_id: &str, item: ShellStreamItem) -> Option<ShellChange> {
        let linked = self.shells.get_mut(environment_id)?;
        Some(linked.shell.apply(item))
    }

    /// The snapshot to save for `environment_id`: what its connection last reported (or what was
    /// restored). `None` while it holds nothing.
    #[must_use]
    pub fn snapshot(&self, environment_id: &str) -> Option<LinkedShellSnapshot> {
        let linked = self.shells.get(environment_id)?;
        let shell = &linked.shell;
        if shell.sequence.is_none() && shell.threads.is_empty() && shell.projects.is_empty() {
            return None;
        }
        Some(LinkedShellSnapshot::capture(
            environment_id,
            &linked.label,
            shell,
        ))
    }

    /// Lists a saved environment from its last snapshot, before (or without) a connection.
    /// Ignored when the environment already holds a synced shell.
    pub fn restore_snapshot(&mut self, snapshot: LinkedShellSnapshot) {
        self.ensure(&snapshot.environment_id.clone(), &snapshot.label.clone());
        let Some(linked) = self.shells.get_mut(&snapshot.environment_id) else {
            return;
        };
        if linked.shell.sequence.is_some() {
            return;
        }
        linked.shell = snapshot.into_shell();
    }

    /// A restored copy of an environment's last shell, shown until its connection syncs
    /// (Conn keeps each environment's last snapshot, so an asleep Instance still lists its threads).
    pub fn restore(&mut self, environment_id: &str, shell: ShellState) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell = shell;
        }
    }

    /// The Settled shelf pages each environment on its own cut (`olderOf(environmentId)`): the
    /// projects of `environment_id` the shelf pages for (`None`: all of them).
    pub fn set_older_scope(&mut self, environment_id: &str, scope: Option<Vec<String>>) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.set_older_scope(scope);
        }
    }

    /// Whether the pages read so far were read for another scope than `scope` would be.
    #[must_use]
    pub fn older_scope_differs(&self, environment_id: &str, scope: &Option<Vec<String>>) -> bool {
        let Some(linked) = self.shells.get(environment_id) else {
            return false;
        };
        let wanted = scope.as_ref().map(|ids| {
            let mut ids = ids.clone();
            ids.sort();
            ids
        });
        linked.shell.older_scope() != wanted.as_ref()
    }

    /// The next page to read from `environment_id`, when the shelf lists fewer rows than it
    /// shows. Mark it with [`Self::older_page_started`].
    #[must_use]
    pub fn next_older_page(
        &self,
        environment_id: &str,
        listed: usize,
        visible: usize,
    ) -> Option<OlderPageRequest> {
        self.shells
            .get(environment_id)?
            .shell
            .next_older_page(listed, visible)
    }

    pub fn older_page_started(&mut self, environment_id: &str, request: &OlderPageRequest) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.older_page_started(request);
        }
    }

    pub fn apply_older_page(
        &mut self,
        environment_id: &str,
        request: &OlderPageRequest,
        page: OlderSettledPage,
    ) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.apply_older_page(request, page);
        }
    }

    pub fn older_page_failed(&mut self, environment_id: &str, request: &OlderPageRequest) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.older_page_failed(request);
        }
    }

    /// `retry` on a failed page of any environment.
    pub fn retry_older_pages(&mut self) {
        for linked in self.shells.values_mut() {
            linked.shell.retry_older_page();
        }
    }

    #[must_use]
    pub fn shell(&self, environment_id: &str) -> Option<&ShellState> {
        self.shells.get(environment_id).map(|linked| &linked.shell)
    }

    #[must_use]
    pub fn label(&self, environment_id: &str) -> Option<&str> {
        self.shells
            .get(environment_id)
            .map(|linked| linked.label.as_str())
    }

    #[must_use]
    pub fn contains(&self, environment_id: &str) -> bool {
        self.shells.contains_key(environment_id)
    }

    /// The held environments with their labels, in the order they were first seen.
    #[must_use]
    pub fn environments(&self) -> Vec<EnvironmentLabel> {
        self.order
            .iter()
            .filter_map(|id| {
                self.shells.get(id).map(|linked| EnvironmentLabel {
                    id: id.clone(),
                    label: linked.label.clone(),
                })
            })
            .collect()
    }

    /// The held environments' shells, in the order they were first seen.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &ShellState)> {
        self.order.iter().filter_map(|id| {
            self.shells
                .get(id)
                .map(|linked| (id.as_str(), &linked.shell))
        })
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.shells.is_empty()
    }

    /// `primary` with every linked environment's projects and threads added, and where each came
    /// from. An id more than one environment holds belongs to the first: the primary, then the
    /// linked environments in the order they were first seen. Linked environments are listed in
    /// that order, so the result does not change when an environment reconnects.
    #[must_use]
    pub fn merged(
        &self,
        primary_id: &str,
        primary_label: &str,
        primary: &ShellState,
    ) -> MergedShell {
        let mut shell = primary.clone();
        let origins = self.merge_into(primary_id, primary_label, &mut shell, &Origins::default());
        MergedShell { shell, origins }
    }

    /// [`Self::merged`] in place, for a client that keeps one live shell (its Settled shelf
    /// paging lives there): first takes out what `previous` merged in, then merges again.
    /// Returns the new [`Origins`].
    pub fn merge_into(
        &self,
        primary_id: &str,
        primary_label: &str,
        shell: &mut ShellState,
        previous: &Origins,
    ) -> Origins {
        previous.strip_from(shell);
        let mut origins = Origins {
            primary_id: primary_id.to_owned(),
            labels: HashMap::from([(primary_id.to_owned(), primary_label.to_owned())]),
            ..Origins::default()
        };
        let held: Vec<(&String, &LinkedShell)> = self
            .order
            .iter()
            .filter_map(|id| self.shells.get(id).map(|linked| (id, linked)))
            .collect();
        shell.set_environment_id(primary_id);
        shell.set_environment_aliases(&self.aliases);
        let added = shell
            .extend_with_environments(held.iter().map(|(id, linked)| (id.as_str(), &linked.shell)));
        for ((id, linked), added) in held.into_iter().zip(added) {
            origins.labels.insert(id.clone(), linked.label.clone());
            origins.linked_order.push(id.clone());
            for project in added.projects {
                origins.project_env.insert(project.to_owned(), id.clone());
            }
            for thread in added.threads {
                origins.thread_env.insert(thread.to_owned(), id.clone());
            }
        }
        origins
    }

    /// Whether a change the primary environment's shell applied to the merged `shell` in place
    /// needs [`Self::merge_into`] again: its projects changed (a snapshot), or a changed thread is
    /// one a linked environment also holds, so which copy shows may change. Any other change
    /// leaves the merged shell what merging again would build.
    #[must_use]
    pub fn primary_change_needs_merge(&self, shell: &ShellState, change: &ShellChange) -> bool {
        if self.shells.is_empty() {
            return false;
        }
        change.projects_changed
            || change.threads_changed.len() > INCREMENTAL_LIMIT
            || change.threads_changed.iter().any(|id| {
                shell.foreign_index(id).is_some()
                    || self
                        .shells
                        .values()
                        .any(|linked| linked.shell.locate(id).is_some())
            })
    }

    /// Updates the merged `shell` for the threads `changed` on `environment_id`, as
    /// [`Self::merge_into`] would list them, without merging every environment again.
    ///
    /// `origins` must be what the last merge returned, and `environment_id`'s projects must not
    /// have changed since. Returns `false` without changing anything when this cannot be done in
    /// place: the merge order or that environment's Settled paging changed, too many threads
    /// changed, or a changed thread is one another environment also holds, so which copy shows
    /// may change. Merge again then.
    pub fn update_merged(
        &self,
        environment_id: &str,
        changed: &[String],
        shell: &mut ShellState,
        origins: &mut Origins,
    ) -> bool {
        let Some(index) = origins
            .linked_order
            .iter()
            .position(|id| id == environment_id)
        else {
            return false;
        };
        let Some(linked) = self.shells.get(environment_id) else {
            return false;
        };
        let order_held = self
            .order
            .iter()
            .filter(|id| self.shells.contains_key(*id))
            .eq(origins.linked_order.iter());
        if !order_held
            || changed.len() > INCREMENTAL_LIMIT
            || shell.foreign_count() != origins.linked_order.len()
            || !shell.foreign_paging_matches(index, &linked.shell)
        {
            return false;
        }
        let others_hold = |id: &str| {
            self.shells.iter().any(|(other_id, other)| {
                other_id != environment_id && other.shell.locate(id).is_some()
            })
        };
        // Decide every thread before changing anything.
        let mut plan: Vec<&str> = Vec::with_capacity(changed.len());
        let mut seen: HashSet<&str> = HashSet::new();
        for id in changed {
            let id = id.as_str();
            if !seen.insert(id) {
                continue;
            }
            let lists_it = matches!(
                linked.shell.locate(id),
                Some((Place::Active | Place::Archived, _))
            );
            match origins.thread_env.get(id) {
                Some(owner) if owner == environment_id => {
                    // Another holder may show once this environment stops listing it.
                    if !lists_it && (others_hold(id) || shell.own_older_holds(id)) {
                        return false;
                    }
                    plan.push(id);
                }
                Some(owner) => {
                    let owner_index = origins.linked_order.iter().position(|e| e == owner);
                    if (lists_it && owner_index.is_none_or(|owner_index| index < owner_index))
                        || shell.foreign_loaded_holds(index, id)
                    {
                        return false;
                    }
                }
                // The primary environment lists it: this copy stays hidden.
                None if shell.lists(id) => {
                    if shell.foreign_loaded_holds(index, id) {
                        return false;
                    }
                }
                None => {
                    if shell.foreign_index(id).is_some_and(|at| at != index)
                        || shell.own_older_holds(id)
                        || others_hold(id)
                    {
                        return false;
                    }
                    plan.push(id);
                }
            }
        }
        let mut refresh = false;
        for id in plan {
            let old = shell.take_foreign(index, id);
            // A row that comes or goes may be the thread another row's request rolls up to.
            let held = old.is_some();
            if let Some(old) = old {
                refresh |= crate::shell::moves_others(&old);
            }
            match linked.shell.locate(id) {
                Some((place, thread)) => {
                    refresh |= crate::shell::moves_others(thread) || !held;
                    if place == Place::Loaded {
                        origins.thread_env.remove(id);
                    } else {
                        origins
                            .thread_env
                            .insert(id.to_owned(), environment_id.to_owned());
                    }
                    shell.put_foreign(index, place, thread.clone());
                }
                None => {
                    refresh |= held;
                    origins.thread_env.remove(id);
                }
            }
        }
        shell.recount_foreign_held(index, &linked.shell);
        shell.finish_foreign_update(refresh);
        true
    }
}

/// More changed threads than this merge again rather than one by one.
const INCREMENTAL_LIMIT: usize = 256;

/// The merged shell the sidebar reads and where its rows came from.
#[derive(Clone, Debug, Default)]
pub struct MergedShell {
    pub shell: ShellState,
    pub origins: Origins,
}

/// Which environment each project and thread of a merged shell belongs to. Anything not listed
/// belongs to the primary environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Origins {
    primary_id: String,
    labels: HashMap<String, String>,
    linked_order: Vec<String>,
    thread_env: HashMap<String, String>,
    project_env: HashMap<String, String>,
}

impl Origins {
    /// Takes out of `shell` the projects and threads this merge put there.
    pub fn strip_from(&self, shell: &mut ShellState) {
        shell.clear_foreign();
        if self.thread_env.is_empty() && self.project_env.is_empty() {
            return;
        }
        shell
            .projects
            .retain(|p| !self.project_env.contains_key(&p.id));
        shell
            .threads
            .retain(|t| !self.thread_env.contains_key(&t.id));
        shell
            .archived_threads
            .retain(|t| !self.thread_env.contains_key(&t.id));
    }

    #[must_use]
    pub fn primary_id(&self) -> &str {
        &self.primary_id
    }

    /// The environment `thread_id` lives on.
    #[must_use]
    pub fn environment_of_thread(&self, thread_id: &str) -> &str {
        self.thread_env
            .get(thread_id)
            .map_or(self.primary_id.as_str(), String::as_str)
    }

    /// The environment `project_id` lives on.
    #[must_use]
    pub fn environment_of_project(&self, project_id: &str) -> &str {
        self.project_env
            .get(project_id)
            .map_or(self.primary_id.as_str(), String::as_str)
    }

    /// Whether `thread_id` lives on a linked environment rather than the primary one.
    #[must_use]
    pub fn is_linked_thread(&self, thread_id: &str) -> bool {
        self.thread_env.contains_key(thread_id)
    }

    #[must_use]
    pub fn is_linked_project(&self, project_id: &str) -> bool {
        self.project_env.contains_key(project_id)
    }

    /// The label of an environment, primary or linked.
    #[must_use]
    pub fn label(&self, environment_id: &str) -> Option<&str> {
        self.labels.get(environment_id).map(String::as_str)
    }

    /// The label of the environment `thread_id` lives on.
    #[must_use]
    pub fn thread_environment_label(&self, thread_id: &str) -> Option<&str> {
        self.label(self.environment_of_thread(thread_id))
    }

    /// The linked environments, in the order the merge listed them.
    #[must_use]
    pub fn linked_environments(&self) -> &[String] {
        &self.linked_order
    }

    /// `projectGroupsSpanEnvironments`: whether the merged projects come from more than one
    /// environment, which is when Conn labels scratch-project threads with their machine.
    #[must_use]
    pub fn spans_environments(&self) -> bool {
        !self.project_env.is_empty()
    }
}

#[cfg(test)]
mod tests {
    /// Measures what saving a shell costs. `cargo test -p conn-state --release -- --ignored
    /// --nocapture save_costs` prints the numbers.
    #[test]
    #[ignore = "a measurement, not a check"]
    fn save_costs() {
        use std::time::Instant;
        let build = |prefix: &str, threads: usize| {
            let projects: Vec<crate::ProjectShell> = (0..8)
                .map(|n| {
                    conn_contract::from_json(serde_json::json!({
                        "id": format!("{prefix}-p{n}"), "title": "P", "workspaceRoot": "/w",
                        "defaultModelSelection": null, "scripts": [],
                        "createdAt": "2026-11-20T09:00:00.000Z",
                        "updatedAt": "2026-11-22T15:00:00.000Z"
                    }))
                    .expect("project")
                })
                .collect();
            let threads: Vec<crate::ThreadShell> = (0..threads)
                .map(|n| {
                    conn_contract::from_json(crate::test_threads::thread_json(
                        &format!("{prefix}-t{n}"),
                        &format!("{prefix}-p{}", n % 8),
                        |t| {
                            t["title"] = serde_json::json!(format!(
                                "Review the offline cache save path for thread {n}, part {}",
                                n % 17
                            ));
                        },
                    ))
                    .expect("thread")
                })
                .collect();
            ShellState::from_parts(projects, threads, Vec::new(), Some(1))
        };
        let primary = build("a", 3000);
        let linked = build("b", 1750);
        let mut merged = LinkedShells::default();
        merged.ensure("b", "b");
        merged.restore("b", linked.clone());
        let merged = merged.merged("a", "a", &primary);
        let origins = merged.origins;
        let shell = merged.shell;
        println!("merged shell: {} threads", shell.threads.len());
        let time = |label: &str, mut work: Box<dyn FnMut() -> usize>| {
            let mut samples = Vec::new();
            let mut out = 0;
            for _ in 0..30 {
                let start = Instant::now();
                out = work();
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            samples.sort_by(f64::total_cmp);
            println!("{label}: median {:.2} ms, {out}", samples[15]);
        };
        let (s, o) = (shell, origins);
        time(
            "primary capture on the main thread, one save (skipped when nothing changed)",
            Box::new(move || {
                let mut p = LinkedShellSnapshot::capture("a", "a", &s);
                p.projects.retain(|x| !o.is_linked_project(&x.id));
                p.threads.retain(|x| !o.is_linked_thread(&x.id));
                p.archived_threads.retain(|x| !o.is_linked_thread(&x.id));
                p.threads.len()
            }),
        );
        let snapshot = LinkedShellSnapshot::capture("a", "a", &primary);
        let bytes = snapshot.to_json().expect("json").len();
        println!("primary shell file: {bytes} bytes");
        let linked_bytes = LinkedShellSnapshot::capture("b", "b", &linked)
            .to_json()
            .expect("json")
            .len();
        // One minute: a thread of the linked environment changes the linked shell every second,
        // and the primary shell's sequence moves every second (its threads do not change).
        // Old: the primary writes every 30 s whatever changed; a linked shell writes 3 s after
        // its first unsaved change. New: the primary writes only for a thread or project change,
        // a linked shell at most every 30 s.
        let (mut old_bytes, mut new_bytes) = (0_usize, 0_usize);
        let (mut old_saves, mut new_saves) = (0, 0);
        let (mut linked_old_at, mut linked_new_at) = (None::<u32>, None::<u32>);
        for second in 0..60_u32 {
            if second % 30 == 0 {
                old_bytes += bytes;
                old_saves += 1;
            }
            if linked_old_at.is_none_or(|at| second >= at + 3) {
                old_bytes += linked_bytes;
                old_saves += 1;
                linked_old_at = Some(second);
            }
            if linked_new_at.is_none_or(|at| second >= at + 30) {
                new_bytes += linked_bytes;
                new_saves += 1;
                linked_new_at = Some(second);
            }
        }
        println!(
            "one minute, active linked thread: old {old_saves} shell writes, {} KiB; new {new_saves} shell writes, {} KiB",
            old_bytes / 1024,
            new_bytes / 1024
        );
        let linked_snapshot = LinkedShellSnapshot::capture("b", "b", &linked);
        println!(
            "linked shell file: {} bytes",
            linked_snapshot.to_json().expect("json").len()
        );
        let l = linked_snapshot.clone();
        time(
            "linked serialize, old (Vec<u8>, then write)",
            Box::new(move || l.to_json().expect("json").len()),
        );
        let l = linked_snapshot;
        time(
            "linked serialize, new (buffered writer)",
            Box::new(move || {
                let mut writer = std::io::BufWriter::with_capacity(256 * 1024, std::io::sink());
                serde_json::to_writer(&mut writer, &l).expect("json");
                0
            }),
        );
    }

    use conn_contract::{OrchestrationV2ShellStreamItem, from_json};
    use serde_json::{Value, json};

    use super::*;
    use crate::project_groups::{project_group_labels, project_group_labels_across_environments};
    use crate::test_threads::thread_json;

    fn project_json(id: &str, title: &str, root: &str, repository: Option<&str>) -> Value {
        let mut value = json!({
            "id": id, "title": title, "workspaceRoot": root,
            "defaultModelSelection": null, "scripts": [],
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "deletedAt": null
        });
        if let Some(key) = repository {
            value["repositoryIdentity"] = json!({
                "canonicalKey": key,
                "locator": { "source": "git-remote", "remoteName": "origin", "remoteUrl": format!("git@{key}.git") },
                "displayName": key,
                "name": key.rsplit('/').next().unwrap_or(key)
            });
        }
        value
    }

    fn snapshot(
        projects: Vec<Value>,
        threads: Vec<Value>,
        archived: Vec<Value>,
    ) -> ShellStreamItem {
        let item: OrchestrationV2ShellStreamItem = from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 3,
                "projects": projects,
                "threads": threads,
                "archivedThreads": archived
            }
        }))
        .expect("snapshot decodes");
        item
    }

    fn at(updated: &'static str) -> impl FnOnce(&mut Value) {
        move |t| t["updatedAt"] = json!(updated)
    }

    fn primary_shell() -> ShellState {
        let mut shell = ShellState::default();
        shell.apply(snapshot(
            vec![project_json(
                "p-conn",
                "Conn",
                "/Users/nick/conn",
                Some("github.com/nckrtl/conn"),
            )],
            vec![
                thread_json("t-primary-old", "p-conn", at("2026-11-20T09:00:00.000Z")),
                thread_json("t-primary-new", "p-conn", at("2026-11-23T09:00:00.000Z")),
            ],
            vec![],
        ));
        shell
    }

    fn linked() -> LinkedShells {
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.ensure("nick-vm", "nick-vm");
        linked.apply(
            "mini",
            snapshot(
                vec![project_json(
                    "p-orbit",
                    "Orbit",
                    "/Users/mini/orbit",
                    Some("github.com/nckrtl/orbit"),
                )],
                vec![thread_json(
                    "t-mini",
                    "p-orbit",
                    at("2026-11-22T09:00:00.000Z"),
                )],
                vec![thread_json("t-mini-archived", "p-orbit", |t| {
                    t["archivedAt"] = json!("2026-11-21T09:00:00.000Z");
                })],
            ),
        );
        linked.apply(
            "nick-vm",
            snapshot(
                vec![project_json(
                    "p-vm-conn",
                    "Conn",
                    "/Users/nick/conn",
                    Some("github.com/nckrtl/conn"),
                )],
                vec![thread_json(
                    "t-vm",
                    "p-vm-conn",
                    at("2026-11-23T10:00:00.000Z"),
                )],
                vec![],
            ),
        );
        linked
    }

    #[test]
    fn the_merged_shell_lists_every_environments_threads_newest_activity_first() {
        let merged = linked().merged("nick", "nick", &primary_shell());
        let ids: Vec<&str> = merged.shell.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t-vm", "t-primary-new", "t-mini", "t-primary-old"]);
        assert_eq!(merged.shell.projects.len(), 3);
        assert_eq!(
            merged
                .shell
                .archived_threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["t-mini-archived"]
        );
        assert!(merged.shell.find_thread("t-mini").is_some());
    }

    #[test]
    fn every_row_remembers_its_environment() {
        let merged = linked().merged("nick", "nick", &primary_shell());
        let origins = &merged.origins;
        assert_eq!(origins.environment_of_thread("t-primary-new"), "nick");
        assert_eq!(origins.environment_of_thread("t-mini"), "mini");
        assert_eq!(origins.environment_of_thread("t-mini-archived"), "mini");
        assert_eq!(origins.environment_of_thread("t-vm"), "nick-vm");
        assert_eq!(origins.environment_of_project("p-orbit"), "mini");
        assert_eq!(origins.environment_of_project("p-conn"), "nick");
        assert!(origins.is_linked_thread("t-mini"));
        assert!(!origins.is_linked_thread("t-primary-new"));
        assert_eq!(origins.thread_environment_label("t-vm"), Some("nick-vm"));
        assert_eq!(
            origins.thread_environment_label("t-primary-old"),
            Some("nick")
        );
        assert_eq!(origins.linked_environments(), ["mini", "nick-vm"]);
        assert!(origins.spans_environments());
    }

    #[test]
    fn a_thread_id_two_environments_hold_belongs_to_the_first() {
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            snapshot(
                vec![project_json("p-conn", "Conn on mini", "/mini/conn", None)],
                vec![thread_json("t-primary-new", "p-conn", |t| {
                    t["title"] = json!("Mini's copy")
                })],
                vec![],
            ),
        );
        let merged = linked.merged("nick", "nick", &primary_shell());
        assert_eq!(
            merged.origins.environment_of_thread("t-primary-new"),
            "nick"
        );
        assert!(!merged.origins.is_linked_thread("t-primary-new"));
        assert_eq!(
            merged
                .shell
                .threads
                .iter()
                .filter(|t| t.id == "t-primary-new")
                .count(),
            1
        );
        assert_eq!(
            merged.shell.projects.len(),
            1,
            "the primary's project keeps the id"
        );
        assert!(!merged.origins.spans_environments());
    }

    #[test]
    fn merging_in_place_again_replaces_what_the_last_merge_added() {
        let mut shell = primary_shell();
        let mut linked = linked();
        let first = linked.merge_into("nick", "nick", &mut shell, &Origins::default());
        assert!(shell.find_thread("t-mini").is_some());
        assert_eq!(shell.threads.len(), 4);

        // mini drops a thread, nick-vm leaves: neither lingers after the next merge.
        linked.apply(
            "mini",
            snapshot(
                vec![project_json("p-orbit", "Orbit", "/Users/mini/orbit", None)],
                vec![],
                vec![],
            ),
        );
        linked.remove("nick-vm");
        let second = linked.merge_into("nick", "nick", &mut shell, &first);
        assert_eq!(
            shell
                .threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["t-primary-new", "t-primary-old"]
        );
        assert!(shell.archived_threads.is_empty());
        assert_eq!(second.linked_environments(), ["mini"]);

        // No linked environment left: back to the primary shell alone.
        linked.remove("mini");
        linked.merge_into("nick", "nick", &mut shell, &second);
        assert_eq!(shell.projects.len(), 1);
        assert_eq!(shell.threads.len(), 2);
    }

    #[test]
    fn the_primary_snapshot_replacing_its_threads_does_not_lose_the_linked_ones_after_a_merge() {
        let mut shell = primary_shell();
        let linked = linked();
        let origins = linked.merge_into("nick", "nick", &mut shell, &Origins::default());
        shell.apply(snapshot(
            vec![project_json("p-conn", "Conn", "/Users/nick/conn", None)],
            vec![thread_json("t-primary-fresh", "p-conn", |_| {})],
            vec![],
        ));
        assert!(
            shell.find_thread("t-mini").is_none(),
            "a snapshot replaces the lists"
        );
        linked.merge_into("nick", "nick", &mut shell, &origins);
        assert!(shell.find_thread("t-mini").is_some());
        assert!(shell.find_thread("t-primary-fresh").is_some());
        assert!(shell.find_thread("t-primary-new").is_none());
    }

    fn older_snapshot(
        projects: Vec<Value>,
        threads: Vec<Value>,
        before: &str,
        counts: Value,
    ) -> ShellStreamItem {
        let item: OrchestrationV2ShellStreamItem = from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 5,
                "projects": projects,
                "threads": threads,
                "archivedThreads": [],
                "olderSettled": { "before": before, "asOfSequence": 5, "counts": counts }
            }
        }))
        .expect("snapshot decodes");
        item
    }

    fn settled(at: &'static str) -> impl FnOnce(&mut Value) {
        move |t| {
            t["settledOverride"] = json!("settled");
            t["settledAt"] = json!(at);
        }
    }

    #[test]
    fn a_snapshot_round_trips_and_lists_the_environment_before_it_connects() {
        let mut linked = linked();
        let saved = linked.snapshot("mini").expect("mini holds a shell");
        let bytes = saved.to_json().expect("serializes");
        let read = LinkedShellSnapshot::from_json(&bytes).expect("reads back");
        assert_eq!(read, saved);
        assert_eq!(read.label, "mini");

        // A fresh run: nothing connected, only the file.
        let mut fresh = LinkedShells::default();
        fresh.restore_snapshot(read);
        let merged = fresh.merged("nick", "nick", &primary_shell());
        assert_eq!(merged.origins.environment_of_thread("t-mini"), "mini");
        assert!(merged.shell.find_thread("t-mini-archived").is_some());
        assert_eq!(
            merged.origins.thread_environment_label("t-mini"),
            Some("mini")
        );

        // A snapshot never overwrites a shell its connection already synced.
        let current = fresh.shell("mini").map(|s| s.threads.len());
        linked.restore_snapshot(LinkedShellSnapshot {
            threads: vec![],
            ..saved
        });
        assert_eq!(linked.shell("mini").map(|s| s.threads.len()), current);
    }

    #[test]
    fn a_snapshot_of_another_version_or_with_garbage_is_ignored() {
        let mut snapshot = linked().snapshot("mini").expect("a shell");
        snapshot.version = LinkedShellSnapshot::VERSION + 1;
        let bytes = snapshot.to_json().expect("serializes");
        assert!(LinkedShellSnapshot::from_json(&bytes).is_none());
        assert!(LinkedShellSnapshot::from_json(b"{ not json").is_none());
        assert!(LinkedShells::default().snapshot("mini").is_none());
    }

    #[test]
    fn each_environment_pages_its_own_settled_threads_and_the_shelf_counts_them_all() {
        let mut primary = ShellState::default();
        primary.apply(older_snapshot(
            vec![project_json("p-conn", "Conn", "/Users/nick/conn", None)],
            vec![thread_json(
                "t-primary-settled",
                "p-conn",
                settled("2026-11-22T09:00:00.000Z"),
            )],
            "2026-11-10T00:00:00.000Z",
            json!([{ "projectId": "p-conn", "count": 3 }]),
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            older_snapshot(
                vec![project_json("p-orbit", "Orbit", "/Users/mini/orbit", None)],
                vec![thread_json(
                    "t-mini-settled",
                    "p-orbit",
                    settled("2026-11-21T09:00:00.000Z"),
                )],
                "2026-11-12T00:00:00.000Z",
                json!([{ "projectId": "p-orbit", "count": 5 }]),
            ),
        );
        let origins = linked.merge_into("nick", "nick", &mut primary, &Origins::default());
        // 3 older threads on nick and 5 on mini, none of them held.
        assert_eq!(primary.unloaded_older_settled(None), 8);
        let scope: HashSet<String> = ["p-orbit".to_owned()].into();
        assert_eq!(primary.unloaded_older_settled(Some(&scope)), 5);

        // mini reads a page below its cut: two of its five arrive.
        let request = linked
            .next_older_page("mini", 1, 5)
            .expect("mini has a page to read");
        assert_eq!(request.before.settled_at, "2026-11-12T00:00:00.000Z");
        linked.older_page_started("mini", &request);
        assert!(
            linked.next_older_page("mini", 1, 5).is_none(),
            "one page at a time per environment"
        );
        let page: OlderSettledPage = from_json(json!({
            "snapshotSequence": 5,
            "threads": [
                thread_json("t-mini-old-1", "p-orbit", settled("2026-11-09T09:00:00.000Z")),
                thread_json("t-mini-old-2", "p-orbit", settled("2026-11-08T09:00:00.000Z")),
            ],
            "counts": []
        }))
        .expect("page decodes");
        linked.apply_older_page("mini", &request, page);
        let cached = LinkedShellSnapshot::capture_inventory("mini", linked.shell("mini").unwrap());
        let restored = LinkedShellSnapshot::from_json(&cached.to_json().unwrap())
            .unwrap()
            .into_shell();
        assert_eq!(restored.older_settled().loaded, 2);
        assert!(restored.older_settled().frontier.is_none());
        assert_eq!(
            restored
                .top_level_settled_threads()
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["t-mini-settled", "t-mini-old-1", "t-mini-old-2"]
        );
        linked.merge_into("nick", "nick", &mut primary, &origins);

        assert_eq!(
            primary.unloaded_older_settled(None),
            6,
            "3 on nick and 3 on mini remain"
        );
        assert!(primary.find_thread("t-mini-old-1").is_some());
        let settled_ids: Vec<&str> = primary
            .top_level_settled_threads()
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert!(settled_ids.contains(&"t-mini-old-1"));
        assert!(settled_ids.contains(&"t-mini-settled"));
        assert!(settled_ids.contains(&"t-primary-settled"));
    }

    #[test]
    fn a_thread_is_listed_against_its_own_environments_frontier() {
        let mut primary = ShellState::default();
        primary.apply(older_snapshot(
            vec![project_json("p-conn", "Conn", "/Users/nick/conn", None)],
            vec![thread_json(
                "t-primary",
                "p-conn",
                settled("2026-11-15T09:00:00.000Z"),
            )],
            "2026-11-10T00:00:00.000Z",
            json!([]),
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            older_snapshot(
                vec![project_json("p-orbit", "Orbit", "/Users/mini/orbit", None)],
                // Newer than nick's cut, older than mini's own: mini's shelf has not read it yet.
                vec![thread_json(
                    "t-mini",
                    "p-orbit",
                    settled("2026-11-11T09:00:00.000Z"),
                )],
                "2026-11-12T00:00:00.000Z",
                json!([]),
            ),
        );
        linked.merge_into("nick", "nick", &mut primary, &Origins::default());
        let listed: Vec<&str> = primary
            .top_level_settled_threads()
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(listed, ["t-primary"]);
        assert_eq!(
            primary.all_settled_threads().len(),
            2,
            "held, but not listed yet"
        );
    }

    #[test]
    fn the_shelf_footer_shows_a_page_any_environment_is_reading_or_failed_to_read() {
        let mut primary = ShellState::default();
        primary.apply(older_snapshot(
            vec![],
            vec![],
            "2026-11-10T00:00:00.000Z",
            json!([]),
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            older_snapshot(vec![], vec![], "2026-11-12T00:00:00.000Z", json!([])),
        );
        let origins = linked.merge_into("nick", "nick", &mut primary, &Origins::default());
        assert_eq!(primary.older_settled().status, crate::PageStatus::Ready);

        let request = linked.next_older_page("mini", 0, 5).expect("a page");
        linked.older_page_started("mini", &request);
        linked.merge_into("nick", "nick", &mut primary, &origins);
        assert_eq!(primary.older_settled().status, crate::PageStatus::Pending);

        linked.older_page_failed("mini", &request);
        linked.merge_into("nick", "nick", &mut primary, &origins);
        assert_eq!(primary.older_settled().status, crate::PageStatus::Failed);

        linked.retry_older_pages();
        linked.merge_into("nick", "nick", &mut primary, &origins);
        assert_eq!(primary.older_settled().status, crate::PageStatus::Ready);
    }

    #[test]
    fn with_no_linked_environment_the_merge_is_the_primary_shell() {
        let primary = primary_shell();
        let merged = LinkedShells::default().merged("nick", "nick", &primary);
        assert_eq!(merged.shell.threads.len(), primary.threads.len());
        assert!(merged.origins.linked_environments().is_empty());
        assert!(!merged.origins.spans_environments());
    }

    #[test]
    fn removing_an_environment_takes_its_threads_out_and_keeps_the_others() {
        let mut linked = linked();
        assert!(linked.remove("mini"));
        assert!(!linked.remove("mini"));
        let merged = linked.merged("nick", "nick", &primary_shell());
        assert!(merged.shell.find_thread("t-mini").is_none());
        assert!(merged.shell.find_thread("t-vm").is_some());
        assert_eq!(linked.environments().len(), 1);
    }

    #[test]
    fn an_item_of_a_dropped_environment_is_ignored() {
        let mut linked = linked();
        linked.remove("mini");
        assert!(
            linked
                .apply("mini", snapshot(vec![], vec![], vec![]))
                .is_none()
        );
    }

    #[test]
    fn a_restored_shell_lists_its_threads_before_the_connection_syncs() {
        let mut restored = ShellState::default();
        restored.apply(snapshot(
            vec![project_json("p-studio", "studio", "/work/studio", None)],
            vec![thread_json("t-studio", "p-studio", |_| {})],
            vec![],
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("studio", "superheroicons / studio");
        linked.restore("studio", restored);
        let merged = linked.merged("nick", "nick", &primary_shell());
        assert_eq!(merged.origins.environment_of_thread("t-studio"), "studio");
        assert_eq!(
            merged.origins.thread_environment_label("t-studio"),
            Some("superheroicons / studio")
        );
    }

    #[test]
    fn the_merge_order_does_not_depend_on_which_environment_reported_last() {
        let first = linked().merged("nick", "nick", &primary_shell());
        let mut reconnected = linked();
        reconnected.apply(
            "mini",
            snapshot(
                vec![project_json(
                    "p-orbit",
                    "Orbit",
                    "/Users/mini/orbit",
                    Some("github.com/nckrtl/orbit"),
                )],
                vec![thread_json(
                    "t-mini",
                    "p-orbit",
                    at("2026-11-22T09:00:00.000Z"),
                )],
                vec![thread_json("t-mini-archived", "p-orbit", |t| {
                    t["archivedAt"] = json!("2026-11-21T09:00:00.000Z");
                })],
            ),
        );
        let second = reconnected.merged("nick", "nick", &primary_shell());
        let ids = |m: &MergedShell| -> Vec<String> {
            m.shell.threads.iter().map(|t| t.id.clone()).collect()
        };
        assert_eq!(ids(&first), ids(&second));
        assert_eq!(first.origins, second.origins);
    }

    /// A small deterministic generator, so a failing step can be replayed.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            usize::try_from(self.next() % n as u64).unwrap_or(0)
        }
    }

    /// A thread of a small shared pool of ids, so environments collide, with a random run state,
    /// lineage, request and settle time (some below the cuts).
    fn random_thread(rng: &mut Rng, project: &str) -> (Value, bool) {
        let id = format!("t-{}", rng.below(24));
        let day = 1 + rng.below(27);
        let kind = rng.below(6);
        let parent = format!("t-{}", rng.below(24));
        let thread = thread_json(&id, project, |t| {
            t["updatedAt"] = json!(format!("2026-11-{day:02}T09:00:00.000Z"));
            match kind {
                0 => {
                    t["settledOverride"] = json!("settled");
                    t["settledAt"] = json!(format!("2026-11-{day:02}T10:00:00.000Z"));
                }
                1 => {
                    t["lineage"]["parentThreadId"] = json!(parent);
                    t["lineage"]["relationshipToParent"] = json!("subagent");
                    t["status"] = json!("running");
                    t["pendingRuntimeRequest"] = json!({
                        "id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"
                    });
                }
                2 => t["status"] = json!("running"),
                _ => {}
            }
        });
        (thread, rng.below(8) == 0)
    }

    fn random_item(rng: &mut Rng, sequence: i64, project: &str) -> ShellStreamItem {
        let value = if rng.below(5) == 0 {
            json!({
                "kind": "thread.removed", "sequence": sequence,
                "location": if rng.below(4) == 0 { "archive" } else { "active" },
                "threadId": format!("t-{}", rng.below(24)),
            })
        } else {
            let (thread, archived) = random_thread(rng, project);
            json!({
                "kind": "thread.updated", "sequence": sequence,
                "location": if archived { "archive" } else { "active" },
                "thread": thread,
            })
        };
        from_json(value).expect("item decodes")
    }

    fn random_snapshot(rng: &mut Rng, project: &str, cut: &str) -> ShellStreamItem {
        let mut threads = Vec::new();
        let mut archived = Vec::new();
        for _ in 0..12 {
            let (thread, in_archive) = random_thread(rng, project);
            let id = thread["id"].clone();
            if threads
                .iter()
                .chain(&archived)
                .any(|t: &Value| t["id"] == id)
            {
                continue;
            }
            if in_archive {
                archived.push(thread);
            } else {
                threads.push(thread);
            }
        }
        from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1, "snapshotSequence": 1,
                "projects": [project_json(project, project, &format!("/{project}"), None)],
                "threads": threads, "archivedThreads": archived,
                "olderSettled": { "before": cut, "asOfSequence": 1,
                                  "counts": [{ "projectId": project, "count": 9 }] }
            }
        }))
        .expect("snapshot decodes")
    }

    /// The merge as it was before it took every environment in one pass: one environment at a
    /// time, each sorting the lists and refreshing derived state.
    fn merge_one_by_one(
        linked: &LinkedShells,
        shell: &mut ShellState,
        previous: &Origins,
    ) -> Origins {
        previous.strip_from(shell);
        let mut origins = Origins {
            primary_id: "nick".to_owned(),
            labels: HashMap::from([("nick".to_owned(), "nick".to_owned())]),
            ..Origins::default()
        };
        let mut projects: HashSet<String> = shell.projects.iter().map(|p| p.id.clone()).collect();
        let mut threads: HashSet<String> = shell
            .threads
            .iter()
            .chain(&shell.archived_threads)
            .map(|t| t.id.clone())
            .collect();
        for id in &linked.order {
            let Some(env) = linked.shells.get(id) else {
                continue;
            };
            origins.labels.insert(id.clone(), env.label.clone());
            origins.linked_order.push(id.clone());
            for project in &env.shell.projects {
                if projects.insert(project.id.clone()) {
                    origins.project_env.insert(project.id.clone(), id.clone());
                }
            }
            for thread in env.shell.threads.iter().chain(&env.shell.archived_threads) {
                if threads.insert(thread.id.clone()) {
                    origins.thread_env.insert(thread.id.clone(), id.clone());
                }
            }
            shell.extend_with_environment(id, &env.shell);
        }
        shell.set_environment_id("nick");
        shell.refresh_derived();
        origins
    }

    /// Everything a reader of the merged shell can see.
    fn view(shell: &ShellState, origins: &Origins) -> Value {
        let ids = |threads: &[ThreadShell]| -> Vec<String> {
            threads.iter().map(|t| t.id.clone()).collect()
        };
        let refs = |threads: Vec<&ThreadShell>| -> Vec<String> {
            threads.iter().map(|t| t.id.clone()).collect()
        };
        let every: Vec<Value> = (0..24)
            .map(|n| {
                let id = format!("t-{n}");
                json!([
                    shell.find_thread(&id).map(|t| t.updated_at.clone()),
                    format!("{:?}", shell.subagent_request(&id)),
                    format!("{:?}", shell.activity(&id)),
                    shell.foreign_index(&id),
                    origins.environment_of_thread(&id),
                    shell
                        .find_thread(&id)
                        .map(|thread| shell.is_listed_settled(thread)),
                ])
            })
            .collect();
        let mut pairs: Vec<(&String, &String)> = origins.thread_env.iter().collect();
        pairs.sort();
        let thread_env = format!("{pairs:?}");
        json!({
            "threads": ids(&shell.threads),
            "archived": ids(&shell.archived_threads),
            "projects": shell.projects.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
            "settled": refs(shell.all_settled_threads()),
            "listed": refs(shell.top_level_settled_threads()),
            "unloaded": shell.unloaded_older_settled(None),
            "older": format!("{:?}", shell.older_settled()),
            "every": every,
            "origins": format!("{:?}", origins.linked_order),
            "thread_env": thread_env,
        })
    }

    /// Updating the merged shell in place, for the primary environment's own changes and for one
    /// linked environment's threads, lists exactly what applying the change and merging every
    /// environment again lists.
    #[test]
    fn updating_the_merged_shell_in_place_matches_merging_again() {
        let mut in_place_steps = 0;
        let mut merged_steps = 0;
        for seed in 1..=40_u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let mut primary = ShellState::default();
            primary.apply(random_snapshot(
                &mut rng,
                "p-nick",
                "2026-11-05T00:00:00.000Z",
            ));
            let mut linked = LinkedShells::default();
            for (env, cut) in [
                ("mini", "2026-11-08T00:00:00.000Z"),
                ("vm", "2026-11-03T00:00:00.000Z"),
                ("studio", "2026-11-10T00:00:00.000Z"),
            ] {
                linked.ensure(env, env);
                linked.apply(env, random_snapshot(&mut rng, &format!("p-{env}"), cut));
            }
            // What every change did before: apply it, then merge every environment again, one by
            // one.
            let mut reference = primary.clone();
            let mut reference_origins =
                merge_one_by_one(&linked, &mut reference, &Origins::default());
            let mut merged = primary;
            let mut origins = linked.merge_into("nick", "nick", &mut merged, &Origins::default());
            assert_eq!(
                view(&merged, &origins),
                view(&reference, &reference_origins),
                "seed {seed}: one pass merges as one by one"
            );
            for step in 0..60_i64 {
                let env = ["nick", "mini", "vm", "studio"][rng.below(4)];
                if env != "nick" && rng.below(10) == 0 {
                    // A page of older settled threads arrives: both merge again.
                    if let Some(request) = linked.next_older_page(env, 0, 100) {
                        let threads: Vec<Value> = (0..3)
                            .map(|_| {
                                let mut thread = random_thread(&mut rng, &format!("p-{env}")).0;
                                thread["settledOverride"] = json!("settled");
                                thread["settledAt"] = json!("2026-11-01T10:00:00.000Z");
                                thread
                            })
                            .collect();
                        let page: OlderSettledPage = from_json(json!({
                            "snapshotSequence": 1, "threads": threads, "counts": []
                        }))
                        .expect("page decodes");
                        linked.older_page_started(env, &request);
                        linked.apply_older_page(env, &request, page);
                        origins = linked.merge_into("nick", "nick", &mut merged, &origins);
                        reference_origins =
                            merge_one_by_one(&linked, &mut reference, &reference_origins);
                        continue;
                    }
                }
                let item = random_item(&mut rng, 10 + step, &format!("p-{env}"));
                if env == "nick" {
                    reference.apply(item.clone());
                    let change = merged.apply(item);
                    if linked.primary_change_needs_merge(&merged, &change) {
                        origins = linked.merge_into("nick", "nick", &mut merged, &origins);
                        merged_steps += 1;
                    } else {
                        in_place_steps += 1;
                    }
                } else {
                    let change = linked.apply(env, item).expect("held environment");
                    if linked.update_merged(env, &change.threads_changed, &mut merged, &mut origins)
                    {
                        in_place_steps += 1;
                    } else {
                        origins = linked.merge_into("nick", "nick", &mut merged, &origins);
                        merged_steps += 1;
                    }
                }
                reference_origins = merge_one_by_one(&linked, &mut reference, &reference_origins);
                assert_eq!(
                    view(&merged, &origins),
                    view(&reference, &reference_origins),
                    "seed {seed} step {step} on {env}"
                );
            }
        }
        assert!(
            in_place_steps > merged_steps * 2,
            "most steps update in place: {in_place_steps} in place, {merged_steps} merged"
        );
    }

    #[test]
    fn a_change_to_a_thread_only_the_primary_holds_needs_no_merge() {
        let mut shell = primary_shell();
        let linked = linked();
        let origins = linked.merge_into("nick", "nick", &mut shell, &Origins::default());
        let item: ShellStreamItem = from_json(json!({
            "kind": "thread.updated", "sequence": 9, "location": "active",
            "thread": thread_json("t-primary-old", "p-conn", at("2026-11-24T09:00:00.000Z")),
        }))
        .expect("update decodes");
        let change = shell.apply(item);
        assert!(!linked.primary_change_needs_merge(&shell, &change));
        assert_eq!(shell.threads[0].id, "t-primary-old", "it moved to the top");
        assert_eq!(origins.environment_of_thread("t-mini"), "mini");
        assert!(shell.find_thread("t-vm").is_some(), "linked rows stay");

        // A thread a linked environment holds too: which copy shows is the merge's call.
        let item: ShellStreamItem = from_json(json!({
            "kind": "thread.updated", "sequence": 10, "location": "active",
            "thread": thread_json("t-mini", "p-conn", |_| {}),
        }))
        .expect("update decodes");
        let change = shell.apply(item);
        assert!(linked.primary_change_needs_merge(&shell, &change));
    }

    #[test]
    fn a_repository_on_two_machines_groups_under_one_label_but_folders_stay_per_machine() {
        let merged = linked().merged("nick", "nick", &primary_shell());
        let origins = merged.origins.clone();
        let labels = project_group_labels_across_environments(&merged.shell.projects, |id| {
            origins.environment_of_project(id).to_owned()
        });
        // `p-conn` (nick) and `p-vm-conn` (nick-vm) share /Users/nick/conn and one repository.
        assert_eq!(labels["p-conn"], labels["p-vm-conn"]);
        assert_eq!(labels["p-conn"], "Conn");
        assert_eq!(labels["p-orbit"], "Orbit");

        // The old, environment-blind grouping reads the two folders as one physical project, so
        // two machines with the same path but different repositories would merge.
        let mut other_repo = merged.shell.projects;
        other_repo.retain(|p| p.id != "p-vm-conn");
        let mut vm_other: ShellState = ShellState::default();
        vm_other.apply(snapshot(
            vec![project_json(
                "p-vm-site",
                "Site",
                "/Users/nick/conn",
                Some("github.com/nckrtl/site"),
            )],
            vec![],
            vec![],
        ));
        other_repo.extend(vm_other.projects.clone());
        let blind = project_group_labels(&other_repo);
        let aware = project_group_labels_across_environments(&other_repo, |id| {
            if id == "p-vm-site" {
                "nick-vm".to_owned()
            } else {
                "nick".to_owned()
            }
        });
        assert_eq!(aware["p-conn"], "Conn");
        assert_eq!(aware["p-vm-site"], "Site");
        assert_eq!(
            blind["p-vm-site"], blind["p-conn"],
            "the blind grouping merges the folders"
        );
    }

    #[test]
    fn a_delegated_task_takes_no_request_from_another_environments_thread_with_its_id() {
        let mut primary = ShellState::default();
        primary.apply(snapshot(
            vec![],
            vec![thread_json("parent", "p", |_| {})],
            vec![],
        ));
        let task = thread_json("task", "p", |t| {
            t["delegatedFrom"] = json!({"environmentId": "a", "threadId": "parent", "title": "P"});
            t["status"] = json!("running");
        });
        let mut linked = LinkedShells::default();
        linked.ensure("b", "b");
        linked.apply("b", snapshot(vec![], vec![task], vec![]));
        // c's `task` is another thread; its subagent's approval is not b's task's.
        linked.ensure("c", "c");
        linked.apply(
            "c",
            snapshot(
                vec![],
                vec![
                    thread_json("task", "p", |_| {}),
                    thread_json("sub", "p", |t| {
                        t["lineage"]["parentThreadId"] = json!("task");
                        t["lineage"]["relationshipToParent"] = json!("subagent");
                        t["status"] = json!("running");
                        t["pendingRuntimeRequest"] = json!(
                            {"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"}
                        );
                    }),
                ],
                vec![],
            ),
        );
        let merged = linked.merged("a", "a", &primary);
        assert_eq!(merged.origins.environment_of_thread("task"), "b");
        assert_eq!(merged.shell.subagent_request("task"), None);
        assert_eq!(merged.shell.subagent_request("parent"), None);
    }

    #[test]
    fn a_delegating_thread_that_first_appears_in_place_shows_its_tasks_approval() {
        let mut primary = ShellState::default();
        primary.apply(snapshot(vec![], vec![], vec![]));
        let task = thread_json("task", "p", |t| {
            t["delegatedFrom"] = json!({"environmentId": "b", "threadId": "parent", "title": "P"});
            t["status"] = json!("running");
            t["pendingRuntimeRequest"] =
                json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
        });
        let mut linked = LinkedShells::default();
        linked.ensure("b", "b");
        linked.apply("b", snapshot(vec![], vec![], vec![]));
        linked.ensure("c", "c");
        linked.apply("c", snapshot(vec![], vec![task], vec![]));
        let mut shell = primary.clone();
        let mut origins = linked.merge_into("a", "a", &mut shell, &Origins::default());

        let item: ShellStreamItem = from_json(json!({
            "kind": "thread.updated", "sequence": 9, "location": "active",
            "thread": thread_json("parent", "p", |_| {}),
        }))
        .expect("update decodes");
        let change = linked.apply("b", item).expect("held environment");
        assert!(linked.update_merged("b", &change.threads_changed, &mut shell, &mut origins));
        assert_eq!(origins.environment_of_thread("parent"), "b");
        assert_eq!(
            shell.subagent_request("parent"),
            Some(crate::shell::PendingSubagentRequest::Approval)
        );
    }

    #[test]
    fn a_delegated_tasks_approval_flags_only_the_environment_copy_that_delegated_it() {
        let shared = || thread_json("shared", "p", |_| {});
        let shell_of = |threads: Vec<Value>| {
            let mut shell = ShellState::default();
            shell.apply(snapshot(vec![], threads, vec![]));
            shell
        };
        let task = thread_json("task", "p", |t| {
            t["delegatedFrom"] =
                json!({"environmentId": "b", "threadId": "shared", "title": "Shared"});
            t["status"] = json!("running");
            t["pendingRuntimeRequest"] =
                json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
        });
        let mut linked = LinkedShells::default();
        linked.ensure("b", "b");
        linked.apply("b", snapshot(vec![], vec![shared()], vec![]));
        linked.ensure("c", "c");
        linked.apply("c", snapshot(vec![], vec![task.clone()], vec![]));

        // The primary's copy of `shared` shows; env b's copy delegated the task.
        let merged = linked.merged("a", "a", &shell_of(vec![shared()]));
        assert_eq!(merged.shell.subagent_request("shared"), None);

        let mut from_b = LinkedShells::default();
        from_b.ensure("c", "c");
        from_b.apply("c", snapshot(vec![], vec![task], vec![]));
        let merged = from_b.merged("b", "b", &shell_of(vec![shared()]));
        assert_eq!(
            merged.shell.subagent_request("shared"),
            Some(crate::shell::PendingSubagentRequest::Approval)
        );
    }
    #[test]
    fn a_delegated_tasks_approval_reaches_a_parent_merged_under_another_id() {
        // The app knows both servers by Orbit target ids; the task names its parent's server by
        // the id that server's config reports.
        let mut primary = ShellState::default();
        primary.apply(snapshot(
            vec![],
            vec![thread_json("parent", "p", |_| {})],
            vec![],
        ));
        let task = thread_json("task", "p", |t| {
            t["delegatedFrom"] =
                json!({"environmentId": "agent-config", "threadId": "parent", "title": "P"});
            t["status"] = json!("running");
            t["pendingRuntimeRequest"] =
                json!({"id": "r", "kind": "command", "createdAt": "2026-11-13T09:00:00.000Z"});
        });
        let mut linked = LinkedShells::default();
        linked.ensure("nick-target", "nick");
        linked.apply("nick-target", snapshot(vec![], vec![task], vec![]));
        assert!(linked.set_environment_aliases(HashMap::from([
            ("agent-config".to_owned(), "agent-target".to_owned()),
            ("nick-config".to_owned(), "nick-target".to_owned()),
        ])));
        let merged = linked.merged("agent-target", "agent", &primary);
        assert_eq!(
            merged.shell.subagent_request("parent"),
            Some(crate::shell::PendingSubagentRequest::Approval)
        );
    }
}
