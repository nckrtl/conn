//! The host patch is keyed by PR and includes changes from remote and fork branches.
use std::collections::{HashMap, HashSet};

use conn_client::{ClientError, Connection};
use conn_contract::{PullRequestDiffInput, PullRequestDiffResult, PullRequestRef};

use super::super::diff_parser::{DiffFile, parse_unified_diff};
use super::tabs::CodeFileEntry;

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
                additions: Some(adds),
                deletions: Some(dels),
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
                additions: Some(adds),
                deletions: Some(dels),
            },
            patch: None,
        });
    }
    rows
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
        let page = conn.pull_request_diff(input.clone()).await?;
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
    use super::*;

    #[test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "only fixture decoding returns an error"
    )]
    fn withheld_file_uses_host_counts_and_can_fetch_its_full_patch() -> Result<(), serde_json::Error>
    {
        let page: PullRequestDiffResult = serde_json::from_value(serde_json::json!({
            "patch":"diff --git a/one.rs b/one.rs\n--- a/one.rs\n+++ b/one.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two.rs b/two.rs\n--- a/two.rs\n+++ b/two.rs\n",
            "omittedFileStats":[{"path":"two.rs","additions":3,"deletions":2}],
            "truncated":true, "nextCursor":null
        }))?;
        let result = files(page);
        assert_eq!(result.len(), 2);
        assert!(result[0].patch.is_some());
        assert_eq!(result[1].entry.additions, Some(3));
        assert_eq!(result[1].entry.deletions, Some(2));
        assert!(
            result[1].patch.is_none(),
            "a withheld patch can be fetched on selection"
        );
        Ok(())
    }
}
