//! Commit preparation uses a scratch index; only the final commit changes the real index.
use crate::{
    VcsError, VcsResult,
    process::{GitCommand, OnLimit},
    repo,
};
use std::{path::Path, time::Duration};

#[derive(Debug)]
pub struct Context {
    pub summary: String,
    pub patch: String,
}

struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let path = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(path);
        });
    }
}

fn command(
    cwd: &Path,
    args: impl IntoIterator<Item = impl Into<std::ffi::OsString>>,
) -> GitCommand {
    GitCommand::new("GitVcsDriver.commit", cwd, args).timeout(Duration::from_secs(300))
}

fn indexed(command: GitCommand, index: &Path, alternates: &str) -> GitCommand {
    let objects = index.with_file_name("objects");
    command
        .env("GIT_INDEX_FILE", index)
        .env("GIT_OBJECT_DIRECTORY", &objects)
        .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternates)
}

fn paths(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| format!(":(top,literal){p}")).collect()
}

/// `git diff` over the whole repository: a project's `diff.relative` would limit it to the cwd.
fn diff<'a>(args: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    ["-c", "diff.relative=false", "diff"]
        .into_iter()
        .chain(args)
        .map(Into::into)
        .collect()
}

async fn operation_in_progress(cwd: &Path) -> VcsResult<Option<&'static str>> {
    for (name, operation) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        if repo::ref_exists(cwd, name).await? {
            return Ok(Some(operation));
        }
    }
    let path = command(cwd, ["rev-parse", "--git-path", "sequencer"])
        .text()
        .await?;
    let path = cwd.join(path.trim());
    if tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(false)
    {
        return Ok(Some("cherry-pick or revert"));
    }
    Ok(None)
}

/// What the marker inspection needs to know about one unmerged path.
struct Unmerged {
    /// Git's `conflict-marker-size`: 7 unless the attribute holds a positive number, as
    /// `ll_merge_marker_size` reads it.
    marker_size: usize,
    /// The index holds our side of the conflict (stage 2).
    ours: bool,
}

async fn unmerged_details(
    cwd: &Path,
    files: &[String],
    index: Option<(&Path, &str)>,
) -> VcsResult<Vec<Unmerged>> {
    const DEFAULT_MARKER_SIZE: usize = 7;
    // Both commands take root-relative paths, and `ls-files` lists only the cwd's subtree.
    let top = command(cwd, ["rev-parse", "--show-cdup"]).text().await?;
    let top = cwd.join(top.trim_end_matches('\n'));
    let run = |args: &[&str]| {
        let c = command(&top, args.iter().copied());
        match index {
            Some((index, alternates)) => indexed(c, index, alternates),
            None => c,
        }
    };
    let mut input = Vec::new();
    for file in files {
        input.extend_from_slice(file.as_bytes());
        input.push(0);
    }
    let attributes = run(&["check-attr", "-z", "--stdin", "conflict-marker-size"])
        .stdin(input)
        .text()
        .await?;
    // `<mode> <oid> <stage> TAB <path> NUL` per stage entry.
    let stages = run(&["ls-files", "--unmerged", "-z"]).text().await?;
    let ours = stages
        .split('\0')
        .filter_map(|entry| entry.split_once('\t'))
        .filter(|(meta, _)| meta.ends_with(" 2"))
        .map(|(_, path)| path)
        .collect::<std::collections::HashSet<_>>();
    // `-z` prints `<path> NUL <attribute> NUL <value> NUL` per path.
    let mut sizes = attributes.split('\0').skip(2).step_by(3);
    Ok(files
        .iter()
        .map(|file| Unmerged {
            marker_size: sizes
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|&size| size > 0)
                .unwrap_or(DEFAULT_MARKER_SIZE),
            ours: ours.contains(file.as_str()),
        })
        .collect())
}

/// Reads a file's diff one chunk at a time and notes whether its added lines hold an opening
/// and a closing conflict marker. A marker is `size` copies of `<` or `>` followed by
/// whitespace or the line end, as Git's `is_conflict_marker` reads it. Every conflict style
/// opens and closes this way. A lone `=======` is valid content, such as a Markdown heading
/// underline, so it does not count.
struct Markers {
    size: usize,
    in_hunk: bool,
    /// Bytes of the current diff line read so far, counting Git's one-byte line prefix.
    column: usize,
    first: u8,
    /// The marker character this added line may still be, while every byte matches it.
    marker: Option<u8>,
    opening: bool,
    closing: bool,
}

impl Markers {
    fn new(size: usize) -> Self {
        Self {
            size,
            in_hunk: false,
            column: 0,
            first: 0,
            marker: None,
            opening: false,
            closing: false,
        }
    }

    fn feed(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            if byte == b'\n' {
                self.end_marker();
                self.column = 0;
                continue;
            }
            match self.column {
                0 => {
                    self.first = byte;
                    self.marker = None;
                }
                // The file's lines start after the first hunk header.
                1 if !self.in_hunk => self.in_hunk = self.first == b'@' && byte == b'@',
                _ if !self.in_hunk || self.first != b'+' => {}
                1 => self.marker = matches!(byte, b'<' | b'>').then_some(byte),
                column if column <= self.size => {
                    if self.marker != Some(byte) {
                        self.marker = None;
                    }
                }
                column if column == self.size.saturating_add(1) => {
                    if matches!(byte, b' ' | b'\t' | b'\r') {
                        self.end_marker();
                    }
                    self.marker = None;
                }
                _ => {}
            }
            self.column = self.column.saturating_add(1);
        }
    }

    /// Records the line's marker when exactly `size` marker characters came before this byte.
    fn end_marker(&mut self) {
        if self.column == self.size.saturating_add(1) {
            match self.marker.take() {
                Some(b'<') => self.opening = true,
                Some(b'>') => self.closing = true,
                _ => {}
            }
        }
    }

    fn unresolved(&self) -> bool {
        self.opening && self.closing
    }
}

async fn stage(
    cwd: &Path,
    selected: Option<&[String]>,
    index: Option<(&Path, &str)>,
) -> VcsResult<()> {
    let run = |args: Vec<String>| {
        let c = command(cwd, args);
        if let Some((index, alternates)) = index {
            indexed(c, index, alternates)
        } else {
            c
        }
    };
    let selected = selected.filter(|paths| !paths.is_empty());
    if let Some(selected) = selected {
        if index.is_none()
            && let Some(operation) = operation_in_progress(cwd).await?
        {
            return Err(VcsError::invalid(
                "GitVcsDriver.commit",
                &cwd.to_string_lossy(),
                format!(
                    "Cannot commit selected files during a {operation}. Commit all files to finish the {operation}."
                ),
            ));
        }
        if index.is_some() {
            let head = repo::has_head_commit(cwd).await?;
            run(vec![
                "read-tree".into(),
                if head { "HEAD" } else { "--empty" }.into(),
            ])
            .run()
            .await?;
        } else {
            let unmerged = run(diff(["--cached", "--name-only", "--diff-filter=U", "-z"]))
                .text()
                .await?;
            // Reset drops every conflict stage, so keep the index while an unselected file is
            // conflicted.
            if !unmerged
                .split('\0')
                .any(|p| !p.is_empty() && !selected.iter().any(|s| s == p))
            {
                run(vec!["reset".into(), "--quiet".into()]).run().await?;
            }
        }
    } else {
        let unmerged = run(diff(["--name-only", "--diff-filter=U", "-z"]))
            .text()
            .await?;
        let unmerged = unmerged
            .split('\0')
            .filter(|file| !file.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !unmerged.is_empty() {
            let details = unmerged_details(cwd, &unmerged, index).await?;
            let fallback = if details.iter().all(|detail| detail.ours) {
                String::new()
            } else if repo::has_head_commit(cwd).await? {
                "HEAD".to_owned()
            } else {
                run(vec![
                    "hash-object".into(),
                    "-t".into(),
                    "tree".into(),
                    "--stdin".into(),
                ])
                .stdin(Vec::new())
                .text()
                .await?
                .trim()
                .to_owned()
            };
            let mut conflicted = Vec::new();
            for (file, detail) in unmerged.iter().zip(details) {
                // The lines added since our side, in Git's cleaned text, even where a diff driver
                // calls the file binary. As with T3's `--check`, markers the file already had
                // are content.
                let side = if detail.ours { "--ours" } else { &fallback };
                let mut args = diff([
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--text",
                    side,
                    "--",
                ]);
                args.push(format!(":(top,literal){file}"));
                let mut markers = Markers::new(detail.marker_size);
                run(args)
                    .scan(&mut |chunk: &[u8]| markers.feed(chunk))
                    .await?;
                if markers.unresolved() {
                    conflicted.push(file.as_str());
                }
            }
            if !conflicted.is_empty() {
                let files = conflicted.join(", ");
                return Err(VcsError::invalid(
                    "GitVcsDriver.commit",
                    &cwd.to_string_lossy(),
                    format!(
                        "Cannot commit with unresolved merge conflicts in {files}. Resolve them, then commit."
                    ),
                ));
            }
        }
    }
    let mut args = vec!["add".into(), "-A".into()];
    if index.is_some() {
        args.splice(0..0, ["-c".into(), "core.splitIndex=false".into()]);
    }
    if let Some(selected) = selected {
        args.push("--".into());
        args.extend(paths(selected));
    }
    run(args).run().await?;
    Ok(())
}

pub async fn prepare_context(
    cwd: &Path,
    selected: Option<&[String]>,
    include_patch: bool,
) -> VcsResult<Option<Context>> {
    let index = command(
        cwd,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    )
    .text()
    .await?;
    let objects = command(
        cwd,
        [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
    )
    .text()
    .await?;
    let counts = command(cwd, ["count-objects", "-v"]).text().await?;
    let alternates = std::iter::once(objects.trim())
        .chain(
            counts
                .lines()
                .filter_map(|line| line.strip_prefix("alternate: ")),
        )
        .map(|path| {
            if path.starts_with('"') {
                path.to_owned()
            } else {
                format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
            }
        })
        .collect::<Vec<_>>()
        .join(":");
    let temporary =
        std::env::temp_dir().join(format!("t3code-commit-index-{}", conn_support::uuid_v4()));
    let _cleanup = Scratch(temporary.clone());
    let original = std::path::PathBuf::from(index.trim());
    let scratch = temporary.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir(&scratch)?;
        std::fs::create_dir(scratch.join("objects"))?;
        match std::fs::copy(original, scratch.join("index")) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result.map_err(|e| e.to_string()))
    .map_err(|detail| VcsError::invalid("prepareCommitContext", &cwd.to_string_lossy(), detail))?;
    let index = temporary.join("index");
    async {
        indexed(
            command(
                cwd,
                [
                    "-c",
                    "core.splitIndex=false",
                    "update-index",
                    "--no-split-index",
                ],
            ),
            &index,
            &alternates,
        )
        .run()
        .await?;
        stage(cwd, selected, Some((&index, &alternates))).await?;
        let summary = indexed(
            command(
                cwd,
                [
                    "-c",
                    "diff.relative=false",
                    "diff",
                    "--cached",
                    "--name-status",
                ],
            ),
            &index,
            &alternates,
        )
        .text()
        .await?;
        if summary.trim().is_empty() && operation_in_progress(cwd).await? != Some("merge") {
            return Ok(None);
        }
        let patch = if include_patch {
            let output = indexed(
                command(
                    cwd,
                    [
                        "-c",
                        "diff.relative=false",
                        "diff",
                        "--cached",
                        "--no-ext-diff",
                        "--no-color",
                        "--no-textconv",
                        "--patch",
                        "--minimal",
                    ],
                ),
                &index,
                &alternates,
            )
            .max_stdout(
                crate::generated::PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
                OnLimit::Truncate,
            )
            .run()
            .await?;
            let mut patch = output.stdout_text();
            if output.stdout_truncated {
                patch.push_str("\n\n[truncated]");
            }
            patch
        } else {
            String::new()
        };
        Ok(Some(Context {
            summary: summary.trim().into(),
            patch,
        }))
    }
    .await
}

pub async fn create(
    cwd: &Path,
    subject: &str,
    body: &str,
    selected: Option<&[String]>,
) -> VcsResult<String> {
    stage(cwd, selected, None).await?;
    let mut args = vec!["commit".into(), "-m".into(), subject.into()];
    if !body.trim().is_empty() {
        args.extend(["-m".into(), body.trim().into()]);
    }
    // T3 uses --only only when unselected conflict stages have to survive.
    let unmerged = command(
        cwd,
        diff(["--cached", "--name-only", "--diff-filter=U", "-z"]),
    )
    .text()
    .await?;
    let only = selected.filter(|_| !unmerged.is_empty());
    if let Some(selected) = only {
        args.extend(["--only".into(), "--".into()]);
        args.extend(paths(selected));
    }
    command(cwd, args).run().await?;
    if let Some(selected) = only {
        let mut args = vec!["reset".into(), "--quiet".into(), "HEAD".into(), "--".into()];
        args.extend(paths(selected));
        command(cwd, args).run().await?;
    }
    Ok(command(cwd, ["rev-parse", "HEAD"])
        .text()
        .await?
        .trim()
        .into())
}

#[cfg(test)]
mod tests {
    use super::Markers;

    const PATCH: &[u8] = b"diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n\
@@ -0,0 +1,6 @@\n+Heading\n+=======\n+<<<<<<< HEAD\n+ours\n+>>>>>>>\n+tail\n";

    fn scan(size: usize, chunks: &[&[u8]]) -> (bool, bool) {
        let mut markers = Markers::new(size);
        for chunk in chunks {
            markers.feed(chunk);
        }
        (markers.opening, markers.closing)
    }

    #[test]
    fn markers_survive_every_chunk_boundary() {
        for split in 0..=PATCH.len() {
            let (head, tail) = PATCH.split_at(split);
            assert_eq!(scan(7, &[head, tail]), (true, true), "{split}");
            // Markers of another width are content.
            assert_eq!(scan(6, &[head, tail]), (false, false), "{split}");
            assert_eq!(scan(8, &[head, tail]), (false, false), "{split}");
        }
        let bytes = PATCH.iter().map(std::slice::from_ref).collect::<Vec<_>>();
        assert_eq!(scan(7, &bytes), (true, true));
    }

    #[test]
    fn only_a_full_marker_line_counts() {
        let patch = |line: &str| format!("@@ -0,0 +1 @@\n+{line}\n");
        for (line, found) in [
            ("<<<<<<< HEAD", (true, false)),
            ("<<<<<<<\tHEAD", (true, false)),
            ("<<<<<<<\r", (true, false)),
            (">>>>>>>", (false, true)),
            ("<<<<<<<<", (false, false)),
            ("<<<<<<x", (false, false)),
            ("<<<<<<>", (false, false)),
            (" <<<<<<<", (false, false)),
            ("=======", (false, false)),
        ] {
            assert_eq!(scan(7, &[patch(line).as_bytes()]), found, "{line:?}");
        }
    }

    #[test]
    fn only_added_lines_count() {
        let patch = b"@@ -1,3 +1,4 @@\n <<<<<<< a\n->>>>>>> b\n+keep\n@@ -9 +10 @@\n >>>>>>> c\n";
        assert_eq!(scan(7, &[patch]), (false, false));
        let patch = b"@@ -1,3 +1,4 @@\n <<<<<<< a\n+<<<<<<< b\n@@ -9 +10 @@\n+>>>>>>> c\n";
        assert_eq!(scan(7, &[patch]), (true, true));
    }

    #[test]
    fn header_lines_before_the_first_hunk_are_not_content() {
        let patch = b"* Unmerged path f\n+<<<<<<< a\n+++ >>>>>>> b\n@@ -0,0 +1 @@\n+tail\n";
        assert_eq!(scan(7, &[patch]), (false, false));
    }
}
