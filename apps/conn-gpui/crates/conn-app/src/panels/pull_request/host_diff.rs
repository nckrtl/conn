//! The host patch is keyed by PR and includes changes from remote and fork branches.
use std::collections::{HashMap, HashSet};

use conn_client::{ClientError, Connection};
use conn_contract::{
    PullRequestDiffInput, PullRequestDiffResult, PullRequestFileViewed, PullRequestFileViewedState,
    PullRequestRef,
};

use super::super::diff_parser::{DiffFile, parse_unified_diff};

/// Cached per-file diff state in the Code tab.
#[derive(Clone, Debug)]
pub(super) enum FileDiffState {
    Idle,
    Loading,
    Loaded(DiffFile),
    Error(String),
}

/// One changed file entry shown in the Code tab list.
#[derive(Clone, Debug)]
pub(super) struct CodeFileEntry {
    pub(super) path: String,
    pub(super) old_path: String,
    pub(super) change_type: conn_contract::ReviewDiffChangeType,
    host_counts: Option<(usize, usize)>,
}

impl CodeFileEntry {
    pub(super) fn line_counts(&self, state: Option<&FileDiffState>) -> (usize, usize) {
        self.host_counts.unwrap_or(match state {
            Some(FileDiffState::Loaded(diff)) => (diff.additions, diff.deletions),
            _ => (0, 0),
        })
    }
}

pub(super) struct HostFile {
    pub(super) entry: CodeFileEntry,
    pub(super) patch: Option<DiffFile>,
}

fn files(page: PullRequestDiffResult) -> Vec<HostFile> {
    let mut omitted: HashMap<_, _> = page
        .omitted_file_stats
        .unwrap_or_default()
        .into_iter()
        .map(|s| (s.path, (s.additions.0 as usize, s.deletions.0 as usize)))
        .collect();
    let mut rows = Vec::new();
    for parsed in parse_unified_diff(&page.patch) {
        let path = parsed
            .new_path
            .as_ref()
            .or(parsed.old_path.as_ref())
            .unwrap_or(&parsed.display_path)
            .clone();
        let old_path = parsed.old_path.clone().unwrap_or_else(|| path.clone());
        let change_type = match (&parsed.old_path, &parsed.new_path) {
            (None, Some(_)) => conn_contract::ReviewDiffChangeType::New,
            (Some(_), None) => conn_contract::ReviewDiffChangeType::Deleted,
            (Some(old), Some(new)) if old != new => {
                conn_contract::ReviewDiffChangeType::RenameChanged
            }
            _ => conn_contract::ReviewDiffChangeType::Change,
        };
        let withheld = omitted.remove(&path);
        let (adds, dels) = withheld.unwrap_or((parsed.additions, parsed.deletions));
        rows.push(HostFile {
            entry: CodeFileEntry {
                path,
                old_path,
                change_type,
                host_counts: Some((adds, dels)),
            },
            patch: withheld.is_none().then_some(parsed),
        });
    }
    for (path, (adds, dels)) in omitted {
        rows.push(HostFile {
            entry: CodeFileEntry {
                old_path: path.clone(),
                change_type: conn_contract::ReviewDiffChangeType::Change,
                path,
                host_counts: Some((adds, dels)),
            },
            patch: None,
        });
    }
    rows
}

pub(super) fn merge_files(
    viewed: Option<Vec<PullRequestFileViewed>>,
    viewed_states: &mut HashMap<String, PullRequestFileViewedState>,
    hosted: Vec<HostFile>,
    review_paths: Vec<String>,
) -> Vec<HostFile> {
    let mut paths = Vec::new();
    if let Some(viewed) = viewed {
        viewed_states.clear();
        for file in viewed {
            paths.push(file.path.clone());
            viewed_states.insert(file.path, file.state);
        }
    }
    let mut by_path = HashMap::new();
    for file in hosted {
        paths.push(file.entry.path.clone());
        by_path.insert(file.entry.path.clone(), file);
    }
    paths.extend(review_paths);
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .map(|path| {
            by_path.remove(&path).unwrap_or_else(|| HostFile {
                entry: CodeFileEntry {
                    old_path: path.clone(),
                    path,
                    change_type: conn_contract::ReviewDiffChangeType::Change,
                    host_counts: None,
                },
                patch: None,
            })
        })
        .collect()
}

pub(super) async fn load(
    conn: &Connection,
    reference: &PullRequestRef,
) -> Result<Vec<HostFile>, ClientError> {
    let mut input = PullRequestDiffInput {
        project_id: reference.project_id.clone(),
        repository: reference.repository.clone(),
        number: reference.number,
        host: reference.host.clone(),
        expected_account_id: reference.expected_account_id.clone(),
        allow_stale: reference.allow_stale,
        cursor: None,
        path: None,
        commit: None,
    };
    let mut result = Vec::new();
    let mut cursors = HashSet::new();
    loop {
        let page = conn.pull_request_diff_page(input.clone()).await?;
        let next = page.next_cursor.clone();
        result.extend(files(page));
        let Some(next) = next else { return Ok(result) };
        if !cursors.insert(next.clone()) {
            return Err(ClientError::Connection(
                "Repeated pull request diff cursor".into(),
            ));
        }
        input.cursor = Some(next);
    }
}

#[cfg(test)]
mod tests {
    use super::super::build_unified_diff_from_contents;
    use super::*;

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "only fixture decoding returns an error"
    )]
    fn withheld_file_uses_host_counts_and_can_fetch_its_full_patch() -> Result<(), serde_json::Error>
    {
        let page: PullRequestDiffResult = serde_json::from_value(serde_json::json!({
            "patch":"diff --git a/one.rs b/one.rs\n--- a/one.rs\n+++ b/one.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git \"a/caf\\303\\251.rs\" \"b/caf\\303\\251.rs\"\n--- \"a/caf\\303\\251.rs\"\n+++ \"b/caf\\303\\251.rs\"\n",
            "omittedFileStats":[{"path":"café.rs","additions":2,"deletions":2}],
            "truncated":true, "nextCursor":null
        }))?;
        let result = files(page);
        assert_eq!(result.len(), 2);
        assert!(result[0].patch.is_some());
        assert_eq!(result[1].entry.host_counts, Some((2, 2)));
        assert!(
            result[1].patch.is_none(),
            "a withheld patch can be fetched on selection"
        );
        let entry = &result[1].entry;
        assert_eq!(entry.path, "café.rs");
        assert_eq!(entry.line_counts(Some(&FileDiffState::Loading)), (2, 2));
        let middle = "unchanged\n".repeat(1998);
        let diff = build_unified_diff_from_contents(
            &entry.old_path,
            &entry.path,
            &format!("old first\n{middle}old last\n"),
            &format!("new first\n{middle}new last\n"),
        );
        assert_eq!((diff.additions, diff.deletions), (2000, 2000));
        let selected = FileDiffState::Loaded(diff);
        assert_eq!(entry.line_counts(Some(&selected)), (2, 2));

        let fallback = CodeFileEntry {
            host_counts: None,
            ..entry.clone()
        };
        assert_eq!(fallback.line_counts(Some(&selected)), (2000, 2000));
        assert_eq!(fallback.line_counts(None), (0, 0));
        assert_eq!(entry.line_counts(None), (2, 2));
        Ok(())
    }

    #[gpui_kit::test]
    fn opening_a_withheld_file_keeps_row_and_header_counts(cx: &mut gpui_kit::TestAppContext) {
        use super::super::{
            DetailTab, PanelState, PullRequestPanel, ResolvedPullRequestTarget, logic,
        };
        use gpui_kit::{AppContext as _, WindowOptions, test::TestWindowExt as _};

        let (window, panel) = cx.update(|cx| {
            gpui_kit::init(cx);
            let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
            let tokens = conn_theme::Tokens::derive(&theme);
            crate::theme::apply_kit_theme(&tokens, cx);
            gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
                cx.new(|cx| PullRequestPanel::new(tokens, None, window, cx))
            })
            .expect("headless PR panel")
        });
        let path = "large.txt";
        panel.update(cx, |panel, cx| {
            let detail = logic::tests::sample_detail();
            panel.state = PanelState::Ready {
                target: ResolvedPullRequestTarget {
                    reference: PullRequestRef {
                        project_id: detail.project_id.clone(),
                        repository: detail.repository.clone(),
                        number: detail.number,
                        host: None,
                        allow_stale: None,
                        expected_account_id: None,
                    },
                    url: None,
                },
                detail: Box::new(detail),
            };
            panel.active_tab = DetailTab::Code;
            panel.header_manual_override = Some(true);
            let page = serde_json::from_value(serde_json::json!({
                "patch": "", "omittedFileStats": [{"path":path,"additions":2,"deletions":2}],
                "truncated": true, "nextCursor": null
            }))
            .expect("withheld patch fixture");
            panel.code_files = files(page).into_iter().map(|file| file.entry).collect();
            panel.select_code_file(path.into(), cx);
            let middle = "unchanged\n".repeat(1998);
            panel.apply_code_file_contents(
                path,
                path.into(),
                &format!("old first\n{middle}old last\n"),
                &format!("new first\n{middle}new last\n"),
            );
        });

        for approximate in [true, false] {
            panel.update(cx, |panel, cx| {
                if !approximate {
                    panel.apply_code_file_contents(path, path.into(), "old\n", "new\n");
                }
                cx.notify();
            });
            cx.update_window(window, |_, window, cx| {
                window.render_frame(cx);
                for scope in ["pr-code-file-0", "pr-code-selected-header"] {
                    let consumer = window.within(scope);
                    assert_eq!(
                        consumer.find("pr-diff-additions").label(),
                        Some("+2"),
                        "{scope}"
                    );
                    assert_eq!(
                        consumer.find("pr-diff-deletions").label(),
                        Some("-2"),
                        "{scope}"
                    );
                }
                let header = window.within("pr-code-selected-header");
                assert_eq!(
                    header
                        .try_find("pr-approximate-diff")
                        .as_ref()
                        .and_then(|label| label.label()),
                    approximate.then_some("Approximate diff")
                );
            })
            .expect("render Code");
        }
    }

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "only fixture decoding returns an error"
    )]
    fn quoted_patch_and_viewed_record_share_one_file() -> Result<(), serde_json::Error> {
        use conn_contract::PullRequestFileViewedState::Viewed;
        for (quoted, path) in [
            (r"caf\303\251.txt", "café.txt"),
            (
                r#"a space \"quoted\"\\name\t.txt"#,
                "a space \"quoted\"\\name\t.txt",
            ),
            (r"\a\b\f\n\r\t\v\001\177", "\x07\x08\x0c\n\r\t\x0b\x01\x7f"),
        ] {
            let patch = format!(
                "diff --git \"a/{quoted}\" \"b/{quoted}\"\n--- \"a/{quoted}\"\n+++ \"b/{quoted}\"\n@@ -1 +1 @@\n-old\n+new\n"
            );
            let viewed = PullRequestFileViewed {
                path: path.into(),
                state: Viewed,
            };
            let page = serde_json::from_value(serde_json::json!({
                "patch": patch, "truncated": false, "nextCursor": null
            }))?;
            let mut viewed_states = HashMap::new();
            let result = merge_files(
                Some(vec![viewed]),
                &mut viewed_states,
                files(page),
                vec![path.into()],
            );
            assert_eq!(result.len(), 1, "{quoted}");
            assert_eq!(result[0].entry.path, path);
            assert_eq!(viewed_states.get(&result[0].entry.path), Some(&Viewed));
            assert!(
                result[0]
                    .patch
                    .as_ref()
                    .is_some_and(|patch| patch.hunks.len() == 1)
            );
        }
        Ok(())
    }
}
