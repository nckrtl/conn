//! Pure composer logic shared by the GPUI views (and, later, the iOS client via
//! `conn-state::composer`): plain data in and out, no GPUI types.

/// One project offered by the new-thread draft project combobox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProjectPickerItem<'a> {
    pub(crate) id: &'a str,
    pub(crate) title: &'a str,
    pub(crate) pinned: bool,
    /// The server's scratch ("no project") project; never listed.
    pub(crate) is_scratch: bool,
}

/// One row in the draft project combobox (`DraftHeroHeadline.tsx` `pickerItems`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProjectPickerRow {
    Project(String),
    AddProject,
}

/// Combobox rows for `query`: non-scratch projects (pinned first, otherwise in shell order),
/// then `Add project` while the search is empty (`filteredPickerItems` hides it while searching).
#[must_use]
pub(crate) fn project_picker_rows<'a>(
    items: impl IntoIterator<Item = ProjectPickerItem<'a>>,
    query: &str,
) -> Vec<ProjectPickerRow> {
    let needle = query.trim().to_lowercase();
    let mut matching: Vec<ProjectPickerItem<'a>> = items
        .into_iter()
        .filter(|p| !p.is_scratch)
        .filter(|p| needle.is_empty() || p.title.to_lowercase().contains(&needle))
        .collect();
    matching.sort_by_key(|p| !p.pinned);
    let mut rows: Vec<ProjectPickerRow> = matching
        .into_iter()
        .map(|p| ProjectPickerRow::Project(p.id.to_owned()))
        .collect();
    if needle.is_empty() {
        rows.push(ProjectPickerRow::AddProject);
    }
    rows
}

/// Unsent composer content for one thread or draft (`composerDraftStore` `ComposerThreadDraftState`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComposerDraft<A> {
    pub(crate) text: String,
    pub(crate) attachments: Vec<A>,
}

impl<A> Default for ComposerDraft<A> {
    fn default() -> Self {
        Self {
            text: String::new(),
            attachments: Vec::new(),
        }
    }
}

impl<A> ComposerDraft<A> {
    /// Conn drops drafts with no prompt text and no attachments (`composerDraftHasUserContent`).
    #[must_use]
    pub(crate) fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.attachments.is_empty()
    }
}

/// Store key for a started thread.
#[must_use]
pub(crate) fn thread_draft_key(thread_id: &str) -> String {
    format!("thread:{thread_id}")
}

/// Store key for the new-thread draft (one at a time; its content follows project retargets).
pub(crate) const NEW_THREAD_DRAFT_KEY: &str = "draft:new";

/// Per-thread / per-draft unsent composer content, so switching threads never loses a prompt.
#[derive(Clone, Debug)]
pub(crate) struct ComposerDraftStore<A> {
    active_key: Option<String>,
    parked: std::collections::HashMap<String, ComposerDraft<A>>,
}

impl<A> Default for ComposerDraftStore<A> {
    fn default() -> Self {
        Self {
            active_key: None,
            parked: std::collections::HashMap::new(),
        }
    }
}

impl<A> ComposerDraftStore<A> {
    #[must_use]
    pub(crate) fn active_key(&self) -> Option<&str> {
        self.active_key.as_deref()
    }

    /// Parks `current` under the active key and returns the draft to show for `next_key`.
    /// Returns `None` when `next_key` is already active (nothing to swap).
    pub(crate) fn switch(
        &mut self,
        next_key: Option<&str>,
        current: ComposerDraft<A>,
    ) -> Option<ComposerDraft<A>> {
        if self.active_key.as_deref() == next_key {
            return None;
        }
        if let Some(key) = self.active_key.take()
            && !current.is_empty()
        {
            self.parked.insert(key, current);
        }
        self.active_key = next_key.map(str::to_owned);
        Some(
            next_key
                .and_then(|key| self.parked.remove(key))
                .unwrap_or_default(),
        )
    }

    /// Mutable access to parked attachments, so uploads that finish after a switch still land.
    pub(crate) fn parked_attachments_mut(&mut self) -> impl Iterator<Item = &mut A> {
        self.parked
            .values_mut()
            .flat_map(|d| d.attachments.iter_mut())
    }
}

/// Replaces Git-rejected ASCII whitespace with `-` (`sanitizeNewRefName`).
#[must_use]
pub(crate) fn sanitize_new_ref_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_space = false;
    for ch in raw.trim().chars() {
        if matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0c' | '\x0b') {
            if !in_space {
                out.push('-');
            }
            in_space = true;
        } else {
            out.push(ch);
            in_space = false;
        }
    }
    out
}

/// `origin/feature` -> `feature` (`deriveLocalBranchNameFromRemoteRef`).
#[must_use]
pub(crate) fn local_branch_name_from_remote_ref(name: &str) -> &str {
    match name.find('/') {
        Some(idx) if idx > 0 && idx < name.len() - 1 => &name[idx + 1..],
        _ => name,
    }
}

/// One git ref listed by `vcs.listRefs`, reduced to what the picker needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RefEntry {
    pub(crate) name: String,
    pub(crate) is_remote: bool,
    pub(crate) current: bool,
    pub(crate) is_default: bool,
    pub(crate) worktree_path: Option<String>,
}

/// One row in the branch picker (`BranchToolbarBranchSelector` `branchPickerItems`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BranchPickerRow {
    /// Index into the listed refs.
    Ref(usize),
    /// `Create new ref "<name>"` with the sanitized name.
    Create(String),
}

/// Picker rows for `query`: matching refs, then `Create new ref` when the query names no
/// listed ref and creating is allowed (never while picking a new worktree's base).
#[must_use]
pub(crate) fn branch_picker_rows(
    refs: &[RefEntry],
    query: &str,
    can_create: bool,
) -> Vec<BranchPickerRow> {
    let trimmed = query.trim();
    let normalized = trimmed.to_lowercase();
    let sanitized = sanitize_new_ref_name(&normalized);
    let mut rows: Vec<BranchPickerRow> = refs
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            if normalized.is_empty() {
                return true;
            }
            let name = r.name.to_lowercase();
            name.contains(&normalized)
                || (!sanitized.is_empty() && sanitized != normalized && name.contains(&sanitized))
        })
        .map(|(idx, _)| BranchPickerRow::Ref(idx))
        .collect();
    let new_ref = sanitize_new_ref_name(trimmed);
    if can_create && !new_ref.is_empty() && !refs.iter().any(|r| r.name == new_ref) {
        rows.push(BranchPickerRow::Create(new_ref));
    }
    rows
}

/// Trailing badge on a ref row (`BranchPickerRefItem`).
#[must_use]
pub(crate) fn ref_badge(entry: &RefEntry, project_cwd: Option<&str>) -> Option<&'static str> {
    let other_worktree = matches!(
        (entry.worktree_path.as_deref(), project_cwd),
        (Some(path), Some(cwd)) if path != cwd
    );
    if entry.current {
        Some("current")
    } else if other_worktree {
        Some("worktree")
    } else if entry.is_remote {
        Some("remote")
    } else if entry.is_default {
        Some("default")
    } else {
        None
    }
}

/// Branch trigger label (`resolveBranchTriggerLabel`).
#[must_use]
pub(crate) fn branch_trigger_label(
    branch: Option<&str>,
    selecting_worktree_base: bool,
    start_from_origin: bool,
    branch_is_remote: Option<bool>,
) -> String {
    let Some(branch) = branch.filter(|b| !b.is_empty()) else {
        return "Select ref".to_owned();
    };
    if selecting_worktree_base {
        if start_from_origin && branch_is_remote == Some(false) {
            return format!("From {branch} (remote)");
        }
        return format!("From {branch}");
    }
    branch.to_owned()
}

/// Where picking a ref leaves the thread (`resolveBranchSelectionTarget`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BranchSelectionTarget {
    pub(crate) checkout_cwd: String,
    pub(crate) next_worktree_path: Option<String>,
    pub(crate) reuse_existing_worktree: bool,
    pub(crate) stays_in_active_checkout: bool,
}

fn path_is_within(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[must_use]
pub(crate) fn branch_selection_target(
    project_cwd: &str,
    active_worktree_path: Option<&str>,
    entry: &RefEntry,
) -> BranchSelectionTarget {
    if let Some(path) = entry.worktree_path.as_deref() {
        let next = (!path_is_within(project_cwd, path)).then(|| path.to_owned());
        return BranchSelectionTarget {
            checkout_cwd: path.to_owned(),
            stays_in_active_checkout: next.as_deref() == active_worktree_path,
            next_worktree_path: next,
            reuse_existing_worktree: true,
        };
    }
    let next = if active_worktree_path.is_some() && entry.is_default {
        None
    } else {
        active_worktree_path.map(str::to_owned)
    };
    BranchSelectionTarget {
        checkout_cwd: next.clone().unwrap_or_else(|| project_cwd.to_owned()),
        stays_in_active_checkout: next.as_deref() == active_worktree_path,
        next_worktree_path: next,
        reuse_existing_worktree: false,
    }
}

/// A project thread's workspace, for `Previous worktree`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ThreadWorkspace<'a> {
    pub(crate) branch: Option<&'a str>,
    pub(crate) worktree_path: Option<&'a str>,
    /// ISO-8601 `updatedAt`; compared as text, which orders ISO timestamps correctly.
    pub(crate) updated_at: &'a str,
    pub(crate) archived: bool,
}

/// The project's most recently updated worktree thread (`resolvePreviousWorktreeSeed`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PreviousWorktree {
    pub(crate) branch: Option<String>,
    pub(crate) worktree_path: String,
}

#[must_use]
pub(crate) fn previous_worktree<'a>(
    threads: impl IntoIterator<Item = ThreadWorkspace<'a>>,
    current_worktree_path: Option<&str>,
) -> Option<PreviousWorktree> {
    threads
        .into_iter()
        .filter(|t| !t.archived && !t.updated_at.is_empty())
        .filter_map(|t| {
            let path = t.worktree_path?;
            (Some(path) != current_worktree_path).then_some((t, path))
        })
        .max_by(|(a, _), (b, _)| a.updated_at.cmp(b.updated_at))
        .map(|(t, path)| PreviousWorktree {
            branch: t.branch.map(str::to_owned),
            worktree_path: path.to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::{
        BranchPickerRow, ComposerDraft, ComposerDraftStore, NEW_THREAD_DRAFT_KEY, PreviousWorktree,
        ProjectPickerItem, ProjectPickerRow, RefEntry, ThreadWorkspace, branch_picker_rows,
        branch_selection_target, branch_trigger_label, local_branch_name_from_remote_ref,
        previous_worktree, project_picker_rows, ref_badge, sanitize_new_ref_name, thread_draft_key,
    };

    fn item<'a>(
        id: &'a str,
        title: &'a str,
        pinned: bool,
        is_scratch: bool,
    ) -> ProjectPickerItem<'a> {
        ProjectPickerItem {
            id,
            title,
            pinned,
            is_scratch,
        }
    }

    fn ids(rows: &[ProjectPickerRow]) -> Vec<&str> {
        rows.iter()
            .map(|row| match row {
                ProjectPickerRow::Project(id) => id.as_str(),
                ProjectPickerRow::AddProject => "+add",
            })
            .collect()
    }

    #[test]
    fn project_picker_hides_scratch_pins_first_and_adds_project_only_without_query() {
        let items = [
            item("a", "conn", false, false),
            item("s", "Scratch", false, true),
            item("b", "orbit", true, false),
            item("c", "Conn GPUI", false, false),
        ];
        assert_eq!(
            ids(&project_picker_rows(items, "")),
            ["b", "a", "c", "+add"]
        );
        assert_eq!(ids(&project_picker_rows(items, "  CONN ")), ["a", "c"]);
        assert!(project_picker_rows(items, "scratch").is_empty());
    }

    fn draft(text: &str, attachments: &[u32]) -> ComposerDraft<u32> {
        ComposerDraft {
            text: text.to_owned(),
            attachments: attachments.to_vec(),
        }
    }

    #[test]
    fn draft_store_parks_and_restores_per_key_and_drops_empty_drafts() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = thread_draft_key("a");
        let b = thread_draft_key("b");
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
        assert_eq!(store.switch(Some(&a), draft("typing", &[])), None);

        // Leaving `a` parks its prompt and attachment; `b` starts empty.
        assert_eq!(
            store.switch(Some(&b), draft("half a prompt", &[7])),
            Some(draft("", &[]))
        );
        // Whitespace-only `b` is not kept.
        assert_eq!(
            store.switch(Some(NEW_THREAD_DRAFT_KEY), draft("  ", &[])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.switch(Some(&b), draft("new thread idea", &[])),
            Some(draft("", &[]))
        );
        assert_eq!(
            store.switch(Some(&a), draft("", &[])),
            Some(draft("half a prompt", &[7]))
        );
        // Restoring removes it from the parked set; the draft is live again.
        assert_eq!(store.switch(None, draft("", &[])), Some(draft("", &[])));
        assert_eq!(store.switch(Some(&a), draft("", &[])), Some(draft("", &[])));
        assert_eq!(
            store.switch(Some(NEW_THREAD_DRAFT_KEY), draft("", &[])),
            Some(draft("new thread idea", &[]))
        );
    }

    #[test]
    fn draft_store_reaches_parked_attachments() {
        let mut store = ComposerDraftStore::<u32>::default();
        let a = thread_draft_key("a");
        store.switch(Some(&a), draft("", &[]));
        store.switch(Some(NEW_THREAD_DRAFT_KEY), draft("x", &[1, 2]));
        for att in store.parked_attachments_mut() {
            *att += 10;
        }
        assert_eq!(
            store.switch(Some(&a), draft("", &[])),
            Some(draft("x", &[11, 12]))
        );
    }

    fn git_ref(name: &str) -> RefEntry {
        RefEntry {
            name: name.to_owned(),
            is_remote: false,
            current: false,
            is_default: false,
            worktree_path: None,
        }
    }

    #[test]
    fn ref_names_sanitize_and_strip_remotes() {
        assert_eq!(sanitize_new_ref_name("  my  new\tbranch "), "my-new-branch");
        assert_eq!(sanitize_new_ref_name("a\u{a0}b"), "a\u{a0}b");
        assert_eq!(local_branch_name_from_remote_ref("origin/feat/x"), "feat/x");
        assert_eq!(local_branch_name_from_remote_ref("main"), "main");
        assert_eq!(local_branch_name_from_remote_ref("origin/"), "origin/");
    }

    #[test]
    fn branch_picker_filters_and_offers_create_only_for_new_names() {
        let refs = [
            git_ref("main"),
            git_ref("feat/new-picker"),
            git_ref("origin/main"),
        ];
        assert_eq!(
            branch_picker_rows(&refs, "", true),
            [
                BranchPickerRow::Ref(0),
                BranchPickerRow::Ref(1),
                BranchPickerRow::Ref(2)
            ]
        );
        // Spaces match the sanitized name, and creating offers the sanitized name.
        assert_eq!(
            branch_picker_rows(&refs, "New Picker", true),
            [
                BranchPickerRow::Ref(1),
                BranchPickerRow::Create("New-Picker".to_owned())
            ]
        );
        assert_eq!(
            branch_picker_rows(&refs, "main", true),
            [BranchPickerRow::Ref(0), BranchPickerRow::Ref(2)]
        );
        assert_eq!(branch_picker_rows(&refs, "zzz", false), []);
    }

    #[test]
    fn ref_badges_follow_conn_priority() {
        let mut r = git_ref("x");
        r.is_default = true;
        assert_eq!(ref_badge(&r, Some("/p")), Some("default"));
        r.is_remote = true;
        assert_eq!(ref_badge(&r, Some("/p")), Some("remote"));
        r.worktree_path = Some("/p".to_owned());
        assert_eq!(ref_badge(&r, Some("/p")), Some("remote"));
        r.worktree_path = Some("/wt".to_owned());
        assert_eq!(ref_badge(&r, Some("/p")), Some("worktree"));
        r.current = true;
        assert_eq!(ref_badge(&r, Some("/p")), Some("current"));
    }

    #[test]
    fn branch_trigger_labels() {
        assert_eq!(branch_trigger_label(None, false, false, None), "Select ref");
        assert_eq!(
            branch_trigger_label(Some("main"), false, true, Some(false)),
            "main"
        );
        assert_eq!(
            branch_trigger_label(Some("main"), true, false, Some(false)),
            "From main"
        );
        assert_eq!(
            branch_trigger_label(Some("main"), true, true, Some(false)),
            "From main (remote)"
        );
        assert_eq!(
            branch_trigger_label(Some("origin/main"), true, true, Some(true)),
            "From origin/main"
        );
    }

    #[test]
    fn branch_selection_reuses_worktrees_and_leaves_them_for_default() {
        let mut in_wt = git_ref("feat");
        in_wt.worktree_path = Some("/wt/feat".to_owned());
        let t = branch_selection_target("/p", None, &in_wt);
        assert!(t.reuse_existing_worktree && !t.stays_in_active_checkout);
        assert_eq!(t.next_worktree_path.as_deref(), Some("/wt/feat"));
        assert_eq!(t.checkout_cwd, "/wt/feat");

        let mut at_root = git_ref("main");
        at_root.worktree_path = Some("/p".to_owned());
        let t = branch_selection_target("/p", Some("/wt/a"), &at_root);
        assert_eq!(t.next_worktree_path, None);

        let mut default = git_ref("main");
        default.is_default = true;
        let t = branch_selection_target("/p", Some("/wt/a"), &default);
        assert_eq!(
            (t.checkout_cwd.as_str(), t.next_worktree_path),
            ("/p", None)
        );
        let t = branch_selection_target("/p", Some("/wt/a"), &git_ref("other"));
        assert_eq!(t.checkout_cwd, "/wt/a");
        assert!(t.stays_in_active_checkout);
    }

    #[test]
    fn previous_worktree_picks_latest_other_unarchived_worktree() {
        let ws = |branch, path, updated_at, archived| ThreadWorkspace {
            branch,
            worktree_path: path,
            updated_at,
            archived,
        };
        let threads = [
            ws(Some("a"), Some("/wt/a"), "2026-11-01T00:00:00.000Z", false),
            ws(Some("b"), Some("/wt/b"), "2026-11-03T00:00:00.000Z", true),
            ws(None, None, "2026-11-04T00:00:00.000Z", false),
            ws(Some("c"), Some("/wt/c"), "2026-11-02T00:00:00.000Z", false),
        ];
        assert_eq!(
            previous_worktree(threads, None),
            Some(PreviousWorktree {
                branch: Some("c".to_owned()),
                worktree_path: "/wt/c".to_owned()
            })
        );
        assert_eq!(
            previous_worktree(threads, Some("/wt/c")).map(|p| p.worktree_path),
            Some("/wt/a".to_owned())
        );
    }
}
