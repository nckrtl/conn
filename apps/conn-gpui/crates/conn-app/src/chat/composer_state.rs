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

#[cfg(test)]
mod tests {
    use super::{ProjectPickerItem, ProjectPickerRow, project_picker_rows};

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
}
