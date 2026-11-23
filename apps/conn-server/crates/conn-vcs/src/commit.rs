//! Commit preparation uses a scratch index; only the final commit changes the real index.
use crate::{
    VcsError, VcsResult,
    process::{GitCommand, OnLimit},
    repo,
};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    os::unix::ffi::OsStrExt,
    path::Path,
    time::Duration,
};

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

fn literal(path: impl AsRef<OsStr>) -> OsString {
    let mut spec = OsString::from(":(top,literal)");
    spec.push(path);
    spec
}

fn paths(paths: &[String]) -> Vec<OsString> {
    paths.iter().map(literal).collect()
}

/// `git diff` over the whole repository: a project's `diff.relative` would limit it to the cwd.
fn diff<'a>(args: impl IntoIterator<Item = &'a str>) -> Vec<OsString> {
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

/// Git's `DEFAULT_CONFLICT_MARKER_SIZE`.
const DEFAULT_MARKER_SIZE: usize = 7;

/// Runs `command` and hands each non-empty NUL-terminated record of its output to `each`,
/// holding one record at a time, so a long listing has no output limit.
async fn each_record(command: GitCommand, mut each: impl FnMut(&[u8]) + Send) -> VcsResult<()> {
    let mut partial = Vec::new();
    let mut emit = |record: &mut Vec<u8>| {
        if !record.is_empty() {
            each(record);
            record.clear();
        }
    };
    command
        .scan(&mut |chunk: &[u8]| {
            let mut pieces = chunk.split(|&byte| byte == 0);
            let mut piece = pieces.next().unwrap_or_default();
            for next in pieces {
                partial.extend_from_slice(piece);
                emit(&mut partial);
                piece = next;
            }
            partial.extend_from_slice(piece);
        })
        .await?;
    emit(&mut partial);
    Ok(())
}

/// Git's `conflict-marker-size`: 7 unless the attribute holds a positive `int`, as
/// `ll_merge_marker_size` reads it.
fn marker_size(value: &[u8]) -> usize {
    std::str::from_utf8(value)
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .and_then(|size| usize::try_from(size).ok())
        .filter(|&size| size > 0)
        .unwrap_or(DEFAULT_MARKER_SIZE)
}

/// What the marker inspection needs to know about one unmerged path.
struct Unmerged {
    /// See [`marker_size`].
    marker_size: usize,
    /// The index holds our side of the conflict (stage 2), and Git did not write the merged
    /// file there. A rename/rename conflict writes the merged file, markers and all, as one
    /// path's stage 2 and the other's stage 3.
    ours: bool,
}

async fn unmerged_details(
    cwd: &Path,
    files: &[OsString],
    index: Option<(&Path, &str)>,
) -> VcsResult<Vec<Unmerged>> {
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
    // `-z` prints `<path> NUL <attribute> NUL <value> NUL` per path, in input order.
    let mut sizes = Vec::with_capacity(files.len());
    let mut field = 0_usize;
    each_record(
        run(&["check-attr", "-z", "--stdin", "conflict-marker-size"]).stdin(input),
        |record| {
            if field % 3 == 2 {
                sizes.push(marker_size(record));
            }
            field = field.wrapping_add(1);
        },
    )
    .await?;
    // `<mode> SP <oid> SP <stage> TAB <path> NUL` per stage entry.
    let mut ours = files
        .iter()
        .map(|file| (file.as_bytes(), None))
        .collect::<HashMap<&[u8], Option<Vec<u8>>>>();
    let mut theirs = HashSet::new();
    each_record(run(&["ls-files", "--unmerged", "-z"]), |record| {
        let mut parts = record.splitn(2, |&byte| byte == b'\t');
        let (Some(meta), Some(path)) = (parts.next(), parts.next()) else {
            return;
        };
        let mut meta = meta.split(|&byte| byte == b' ').skip(1);
        let (Some(oid), Some(stage)) = (meta.next(), meta.next()) else {
            return;
        };
        match (stage, ours.get_mut(path)) {
            (b"2", Some(entry)) => *entry = Some(oid.to_vec()),
            (b"3", Some(_)) => {
                theirs.insert(oid.to_vec());
            }
            _ => {}
        }
    })
    .await?;
    Ok(files
        .iter()
        .enumerate()
        .map(|(n, file)| Unmerged {
            marker_size: sizes.get(n).copied().unwrap_or(DEFAULT_MARKER_SIZE),
            ours: ours
                .get(file.as_bytes())
                .and_then(Option::as_ref)
                .is_some_and(|oid| !theirs.contains(oid)),
        })
        .collect())
}

/// Reads a file's diff one chunk at a time and notes whether its added lines hold an opening
/// and a closing conflict marker of one width. A marker is a run of `<` or `>` followed by
/// whitespace or the line end, as Git's `is_conflict_marker` reads it. Every conflict style
/// opens and closes this way. A lone `=======` is valid content, such as a Markdown heading
/// underline, so it does not count.
///
/// The widths are the file's `conflict-marker-size` and Git's default 7, since an incoming
/// `.gitattributes` can change the attribute after Git wrote the markers, each also one wider,
/// as Git writes them for a rename/rename conflict.
struct Markers {
    widths: Vec<Width>,
    in_hunk: bool,
    /// Bytes of the current diff line read so far, counting Git's one-byte line prefix.
    column: usize,
    first: u8,
    /// The marker character this added line starts with, and its count so far, while every
    /// byte matches it.
    run: Option<(u8, usize)>,
}

struct Width {
    size: usize,
    opening: bool,
    closing: bool,
}

impl Markers {
    fn new(size: usize) -> Self {
        let mut widths = Vec::<Width>::new();
        for size in [size, DEFAULT_MARKER_SIZE] {
            for size in [size, size.saturating_add(1)] {
                if !widths.iter().any(|width| width.size == size) {
                    widths.push(Width {
                        size,
                        opening: false,
                        closing: false,
                    });
                }
            }
        }
        Self {
            widths,
            in_hunk: false,
            column: 0,
            first: 0,
            run: None,
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
                    self.run = None;
                }
                // The file's lines start after the first hunk header.
                1 if !self.in_hunk => self.in_hunk = self.first == b'@' && byte == b'@',
                _ if !self.in_hunk || self.first != b'+' => {}
                1 => self.run = matches!(byte, b'<' | b'>').then_some((byte, 1)),
                _ => match self.run {
                    Some((marker, count)) if marker == byte => {
                        self.run = Some((marker, count.saturating_add(1)));
                    }
                    Some(_) if matches!(byte, b' ' | b'\t' | b'\r') => self.end_marker(),
                    _ => self.run = None,
                },
            }
            self.column = self.column.saturating_add(1);
        }
    }

    /// Records the line's marker run, which whitespace or the line end just closed.
    fn end_marker(&mut self) {
        if let Some((marker, count)) = self.run.take() {
            for width in self.widths.iter_mut().filter(|width| width.size == count) {
                if marker == b'<' {
                    width.opening = true;
                } else {
                    width.closing = true;
                }
            }
        }
    }

    fn unresolved(&self) -> bool {
        self.widths
            .iter()
            .any(|width| width.opening && width.closing)
    }
}

async fn stage(
    cwd: &Path,
    selected: Option<&[String]>,
    index: Option<(&Path, &str)>,
) -> VcsResult<()> {
    let run = |args: Vec<OsString>| {
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
        let mut unmerged = Vec::new();
        each_record(
            run(diff(["--name-only", "--diff-filter=U", "-z"])),
            |file| unmerged.push(OsStr::from_bytes(file).to_owned()),
        )
        .await?;
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
                // The lines added since our side (its stage 2, or HEAD), in Git's cleaned text, even where a diff driver
                // calls the file binary. As with T3's `--check`, markers the file already had
                // are content.
                let side = if detail.ours { "--ours" } else { &fallback };
                let mut args = diff([
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--text",
                    "--submodule=short",
                    side,
                    "--",
                ]);
                args.push(literal(file));
                let mut markers = Markers::new(detail.marker_size);
                run(args)
                    .scan(&mut |chunk: &[u8]| markers.feed(chunk))
                    .await?;
                if markers.unresolved() {
                    conflicted.push(file.to_string_lossy());
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
    use super::{Markers, marker_size};

    const PATCH: &[u8] = b"diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n\
@@ -0,0 +1,6 @@\n+Heading\n+=======\n+<<<<<<<<<<<< HEAD\n+ours\n+>>>>>>>>>>>>\n+tail\n";

    fn scan(size: usize, chunks: &[&[u8]]) -> bool {
        let mut markers = Markers::new(size);
        for chunk in chunks {
            markers.feed(chunk);
        }
        markers.unresolved()
    }

    /// The opening and closing marker of each width found on an added line.
    fn found(size: usize, line: &str) -> Vec<(usize, bool, bool)> {
        let mut markers = Markers::new(size);
        markers.feed(format!("@@ -0,0 +1 @@\n+{line}\n").as_bytes());
        markers
            .widths
            .iter()
            .filter(|width| width.opening || width.closing)
            .map(|width| (width.size, width.opening, width.closing))
            .collect()
    }

    #[test]
    fn markers_survive_every_chunk_boundary() {
        for split in 0..=PATCH.len() {
            let (head, tail) = PATCH.split_at(split);
            assert!(scan(12, &[head, tail]), "{split}");
            // Twelve-wide markers are content at widths 7 and 10, and count at 11 (one wider).
            assert!(!scan(7, &[head, tail]), "{split}");
            assert!(!scan(10, &[head, tail]), "{split}");
            assert!(scan(11, &[head, tail]), "{split}");
        }
        let bytes = PATCH.iter().map(std::slice::from_ref).collect::<Vec<_>>();
        assert!(scan(12, &bytes));
    }

    #[test]
    fn only_a_full_marker_line_counts() {
        for (line, widths) in [
            ("<<<<<<< HEAD", vec![(7, true, false)]),
            ("<<<<<<<\tHEAD", vec![(7, true, false)]),
            ("<<<<<<<\r", vec![(7, true, false)]),
            (">>>>>>>", vec![(7, false, true)]),
            // One wider, as Git writes a rename/rename conflict.
            ("<<<<<<<< HEAD:a", vec![(8, true, false)]),
            ("<<<<<<<<<", vec![]),
            ("<<<<<<x", vec![]),
            ("<<<<<<<x", vec![]),
            ("<<<<<<>", vec![]),
            (" <<<<<<<", vec![]),
            ("=======", vec![]),
        ] {
            assert_eq!(found(7, line), widths, "{line:?}");
        }
    }

    #[test]
    fn widths_are_the_attribute_and_the_default_each_one_wider() {
        let sizes = |size| {
            Markers::new(size)
                .widths
                .iter()
                .map(|width| width.size)
                .collect::<Vec<_>>()
        };
        assert_eq!(sizes(7), [7, 8]);
        assert_eq!(sizes(12), [12, 13, 7, 8]);
        assert_eq!(sizes(3), [3, 4, 7, 8]);
        assert_eq!(sizes(usize::MAX), [usize::MAX, 7, 8]);
        // A pair needs one width: an opening of 7 and a closing of 8 are content.
        let patch = b"@@ -0,0 +1,2 @@\n+<<<<<<< a\n+>>>>>>>> b\n";
        assert!(!scan(7, &[patch]));
    }

    #[test]
    fn marker_size_reads_a_positive_int() {
        for (value, size) in [
            ("12", 12),
            ("2147483647", 2_147_483_647),
            ("2147483648", 7),
            ("99999999999", 7),
            ("0", 7),
            ("-3", 7),
            ("unspecified", 7),
            ("set", 7),
        ] {
            assert_eq!(marker_size(value.as_bytes()), size, "{value}");
        }
    }

    #[test]
    fn only_added_lines_count() {
        let patch = b"@@ -1,3 +1,4 @@\n <<<<<<< a\n->>>>>>> b\n+keep\n@@ -9 +10 @@\n >>>>>>> c\n";
        assert!(!scan(7, &[patch]));
        let patch = b"@@ -1,3 +1,4 @@\n <<<<<<< a\n+<<<<<<< b\n@@ -9 +10 @@\n+>>>>>>> c\n";
        assert!(scan(7, &[patch]));
    }

    #[test]
    fn header_lines_before_the_first_hunk_are_not_content() {
        let patch = b"* Unmerged path f\n+<<<<<<< a\n+++ >>>>>>> b\n@@ -0,0 +1 @@\n+tail\n";
        assert!(!scan(7, &[patch]));
    }
}
