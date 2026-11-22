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

#[cfg(test)]
mod tests {
    use super::{
        ComposerDraft, ComposerDraftStore, NEW_THREAD_DRAFT_KEY, ProjectPickerItem,
        ProjectPickerRow, project_picker_rows, thread_draft_key,
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
}
