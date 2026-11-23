//! Worktrees: create from a ref, list, remove. Used by `vcs.createWorktree` /
//! `vcs.removeWorktree` and by thread launch with a worktree strategy (see [`crate::setup`]).
//!
//! Paths follow `GitVcsDriverCore.createWorktree`: `<worktrees dir>/<repo>/<branch>-<hash16>`,
//! where the hash is `sha256(<git common dir> NUL <branch>)`.

use std::{
    ffi::OsString,
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    time::Duration,
};

use sha2::{Digest, Sha256};

use crate::{
    error::{VcsError, VcsResult},
    process::{OnLimit, ProcessError},
    refs::parse_worktree_branches,
    repo::{self, git},
};

const OPERATION: &str = "GitVcsDriver.createWorktree";
/// Branch name prefix kept in a worktree folder name, in UTF-8 bytes.
const PREFIX_MAX_BYTES: usize = 23;
pub const REMOVE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateWorktree {
    /// A folder inside the repository the worktree belongs to.
    pub cwd: PathBuf,
    /// The ref to check out, or the start point when `new_ref_name` is set.
    pub ref_name: String,
    /// A branch to create at `ref_name` and check out.
    pub new_ref_name: Option<String>,
    /// Recorded as the new branch's base (`branch.<new>.t3-merge-base`), for Changes totals.
    pub base_ref_name: Option<String>,
    /// Where managed worktrees live: `<state dir>/worktrees`.
    pub worktrees_dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    /// The branch checked out there; `None` when detached.
    pub ref_name: Option<String>,
}

fn invalid(cwd: &Path, detail: impl Into<String>) -> VcsError {
    VcsError::invalid(OPERATION, &cwd.to_string_lossy(), detail)
}

fn refuse_option_like(cwd: &Path, name: &str) -> VcsResult<()> {
    if name.starts_with('-') && name != "-" {
        return Err(invalid(cwd, "Ref names cannot start with '-'."));
    }
    Ok(())
}

/// The folder name for `branch`: slashes become dashes, at most 23 bytes, then a hash.
pub fn worktree_folder_name(common_dir: &str, branch: &str) -> String {
    let mut prefix = String::new();
    for c in branch.replace('/', "-").chars() {
        if prefix.len() + c.len_utf8() > PREFIX_MAX_BYTES {
            break;
        }
        prefix.push(c);
    }
    let digest = Sha256::digest(format!("{common_dir}\0{branch}").as_bytes());
    let hash = conn_support::hex::hex(digest.get(..8).unwrap_or_default());
    format!("{prefix}-{hash}")
}

async fn common_dir(cwd: &Path) -> VcsResult<PathBuf> {
    let raw = git(OPERATION, cwd, ["rev-parse", "--git-common-dir"])
        .timeout(repo::PROBE_TIMEOUT)
        .text()
        .await?;
    let path = cwd.join(raw.trim());
    tokio::task::spawn_blocking(move || std::fs::canonicalize(&path).unwrap_or(path))
        .await
        .map_err(|e| invalid(cwd, e.to_string()))
}

/// The managed path for a new worktree of `branch`, `-2`, `-3`, ... when taken.
pub async fn managed_path(cwd: &Path, branch: &str, worktrees_dir: &Path) -> VcsResult<PathBuf> {
    if !worktrees_dir.is_absolute() || worktrees_dir.parent().is_none() {
        return Err(invalid(
            cwd,
            format!(
                "The worktree location \"{}\" must be an absolute folder on this machine, not a drive root.",
                worktrees_dir.display()
            ),
        ));
    }
    let common = common_dir(cwd).await?;
    let cwd_for_error = cwd;
    let cwd = cwd.to_owned();
    let worktrees_dir = worktrees_dir.to_owned();
    let branch = branch.to_owned();
    tokio::task::spawn_blocking(move || {
        let repo_name = std::path::absolute(&cwd)
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_owned()))
            .unwrap_or_else(|| "repo".into());
        let base = worktrees_dir
            .join(repo_name)
            .join(worktree_folder_name(&common.to_string_lossy(), &branch));
        let mut path = base.clone();
        let mut n = 2_u64;
        while path.exists() {
            path = PathBuf::from(format!("{}-{n}", base.display()));
            n += 1;
        }
        Ok(path)
    })
    .await
    .map_err(|e| invalid(cwd_for_error, e.to_string()))?
}

/// Creates a worktree at the managed path and returns it. With `new_ref_name`, creates that
/// branch at `ref_name` first (tracking it when it is a remote branch) and removes it again if
/// the checkout fails.
pub async fn create_worktree(input: &CreateWorktree) -> VcsResult<Worktree> {
    let cwd = input.cwd.as_path();
    refuse_option_like(cwd, &input.ref_name)?;
    if let Some(new) = &input.new_ref_name {
        refuse_option_like(cwd, new)?;
    }
    let target = input
        .new_ref_name
        .clone()
        .unwrap_or_else(|| input.ref_name.clone());
    let path = managed_path(cwd, &target, &input.worktrees_dir).await?;
    let start = if input.ref_name == "-" {
        "@{-1}".to_owned()
    } else {
        input.ref_name.clone()
    };

    if let Some(new) = &input.new_ref_name {
        git(
            OPERATION,
            cwd,
            ["branch", "--no-track", "--", new.as_str(), start.as_str()],
        )
        .run()
        .await?;
        if let Ok(Some(full)) = repo::optional_text(git(
            OPERATION,
            cwd,
            ["rev-parse", "--symbolic-full-name", start.as_str()],
        ))
        .await
            && full.starts_with("refs/remotes/")
        {
            let upstream = format!("--set-upstream-to={full}");
            let _ = git(
                OPERATION,
                cwd,
                ["branch", upstream.as_str(), "--", new.as_str()],
            )
            .run()
            .await;
        }
    }

    let workers = repo::config_get(cwd, "checkout.workers")
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "0".into());
    let added = git(
        OPERATION,
        cwd,
        [
            "-c".to_owned(),
            format!("checkout.workers={workers}"),
            "worktree".into(),
            "add".into(),
            "--".into(),
            path.to_string_lossy().into_owned(),
            target.clone(),
        ],
    )
    .timeout(Duration::from_secs(3600))
    .max_stdout(1_000_000, OnLimit::Truncate)
    .run()
    .await;
    if let Err(error) = added {
        if let Some(new) = &input.new_ref_name {
            let _ = git(OPERATION, cwd, ["branch", "-D", "--", new.as_str()])
                .run()
                .await;
        }
        return Err(error.into());
    }

    if let (Some(new), Some(base)) = (&input.new_ref_name, &input.base_ref_name)
        && let Some((branch_name, full)) = resolve_branch_base(cwd, base).await
    {
        let _ = git(
            OPERATION,
            cwd,
            [
                "config".to_owned(),
                format!("branch.{new}.t3-merge-base"),
                branch_name,
            ],
        )
        .run()
        .await;
        if full.starts_with("refs/remotes/") {
            let _ = git(
                OPERATION,
                cwd,
                [
                    "config".to_owned(),
                    format!("branch.{new}.t3-merge-base-ref"),
                    full,
                ],
            )
            .run()
            .await;
        }
    }
    Ok(Worktree {
        path,
        ref_name: Some(target),
    })
}

/// `(branch name, full ref)` of a base given as a local or remote branch.
async fn resolve_branch_base(cwd: &Path, base: &str) -> Option<(String, String)> {
    let full = match repo::optional_text(git(
        OPERATION,
        cwd,
        [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            base,
        ],
    ))
    .await
    .ok()
    .flatten()
    .filter(|f| !f.is_empty())
    {
        Some(full) => full,
        None => {
            let remote = repo::primary_remote(cwd).await.ok().flatten()?;
            let candidate = format!("refs/remotes/{remote}/{base}");
            repo::ref_exists(cwd, &candidate)
                .await
                .ok()?
                .then_some(candidate)?
        }
    };
    if let Some(branch) = full.strip_prefix("refs/heads/") {
        return Some((branch.to_owned(), full.clone()));
    }
    let rest = full.strip_prefix("refs/remotes/")?;
    let mut remotes = repo::remote_names(cwd).await.ok()?;
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    let branch = remotes
        .iter()
        .find_map(|r| rest.strip_prefix(&format!("{r}/")))
        .unwrap_or(rest)
        .to_owned();
    Some((branch, full))
}

/// Whether git may discard local changes (and, for a branch, unmerged commits).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// Refuse when something would be lost.
    Safe,
    /// Remove anyway (`--force`, `branch -D`).
    Force,
}

/// Removes a worktree. Never removes a locked one. A worktree git no longer knows and whose
/// folder is gone counts as removed (after `git worktree prune`). The branch is kept.
pub async fn remove_worktree(cwd: &Path, path: &Path, removal: Removal) -> VcsResult<()> {
    let target = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    let mut args = vec![
        "-c".to_owned(),
        "status.showUntrackedFiles=normal".into(),
        "worktree".into(),
        "remove".into(),
    ];
    if removal == Removal::Force {
        args.push("--force".into());
    }
    args.push("--".into());
    args.push(target.to_string_lossy().into_owned());
    let common = common_dir(cwd).await?;
    let annexed = blocking(cwd, {
        let target = target.clone();
        move || AnnexLink::replace(&target, &common)
    })
    .await??;
    let removed = git("GitVcsDriver.removeWorktree", cwd, args)
        .timeout(REMOVE_TIMEOUT)
        .run()
        .await;
    if let Some(link) = annexed {
        blocking(cwd, move || link.restore_if_kept()).await?;
    }
    match removed {
        Ok(_) => Ok(()),
        Err(ProcessError::Exit { stderr, .. })
            if !path_exists(&target).await? && {
                let s = stderr.to_ascii_lowercase();
                s.contains("is not a working tree") || s.contains("cannot remove working tree")
            } =>
        {
            git("GitVcsDriver.removeWorktree", cwd, ["worktree", "prune"])
                .timeout(Duration::from_secs(15))
                .run()
                .await?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

async fn path_exists(path: &Path) -> VcsResult<bool> {
    let target = path.to_owned();
    blocking(path, move || target.exists()).await
}

async fn blocking<T: Send + 'static>(
    cwd: &Path,
    work: impl FnOnce() -> T + Send + 'static,
) -> VcsResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| invalid(cwd, e.to_string()))
}

/// The original `.git` link, kept in the admin folder while `.git` is a gitfile, so the next
/// removal attempt can restore it after an interruption.
const ANNEX_LINK_RECORD: &str = "conn-annex-link";
/// `.git`'s replacement is written here, then renamed over it.
const DOT_GIT_SWAP: &str = ".git.conn-swap";

/// git-annex replaces a linked worktree's `.git` file with a symlink to its admin folder, so its
/// links into `.git/annex` resolve. Git refuses to remove such a worktree, so the removal puts
/// the standard `gitdir:` file back for git and restores the link if the checkout survives.
struct AnnexLink {
    dot_git: PathBuf,
    /// The link's own text, restored as it was.
    link: PathBuf,
    admin: PathBuf,
}

impl AnnexLink {
    /// Records the link and swaps it for a `gitdir:` file when `.git` links to this repository's
    /// registered admin folder for `worktree`; `common` is the repository's common Git dir. Also
    /// picks up a swap an interrupted removal left. `None` for a layout git handles itself; any
    /// other link is refused before the checkout changes.
    fn replace(worktree: &Path, common: &Path) -> VcsResult<Option<Self>> {
        let dot_git = worktree.join(".git");
        let refuse = |detail: String| {
            VcsError::invalid(
                "GitVcsDriver.removeWorktree",
                &worktree.to_string_lossy(),
                format!("fatal: {detail}"),
            )
        };
        let is_link = std::fs::symlink_metadata(&dot_git).is_ok_and(|m| m.is_symlink());
        if !is_link {
            return Ok(Self::interrupted(worktree, dot_git, common));
        }
        let not_a_worktree = || refuse(format!("'{}' is not a working tree", worktree.display()));
        let link = std::fs::read_link(&dot_git).map_err(|_| not_a_worktree())?;
        let admin =
            registered_admin(worktree, &worktree.join(&link), common).ok_or_else(not_a_worktree)?;
        let this = Self {
            dot_git,
            link,
            admin,
        };
        let record = this.admin.join(ANNEX_LINK_RECORD);
        std::fs::write(&record, this.link.as_os_str().as_bytes())
            .and_then(|()| {
                replace_dot_git(&this.dot_git, |temp| {
                    std::fs::write(temp, format!("gitdir: {}\n", this.admin.display()))
                })
            })
            .map_err(|e| {
                let _ = std::fs::remove_file(&record);
                refuse(format!(
                    "failed to replace '{}': {e}",
                    this.dot_git.display()
                ))
            })?;
        Ok(Some(this))
    }

    /// A gitfile left by a removal interrupted after the swap, with the link it replaced.
    fn interrupted(worktree: &Path, dot_git: PathBuf, common: &Path) -> Option<Self> {
        let gitfile = std::fs::read_to_string(&dot_git).ok()?;
        let target = worktree.join(gitfile.strip_prefix("gitdir: ")?.trim_end());
        let admin = registered_admin(worktree, &target, common)?;
        let record = std::fs::read(admin.join(ANNEX_LINK_RECORD)).ok()?;
        let link = PathBuf::from(OsString::from_vec(record));
        if std::fs::canonicalize(worktree.join(&link)).ok()? != admin {
            return None;
        }
        let _ = std::fs::remove_file(worktree.join(DOT_GIT_SWAP));
        Some(Self {
            dot_git,
            link,
            admin,
        })
    }

    /// A kept checkout gets its link back. If that fails, the gitfile stays usable and the
    /// record stays for the next attempt.
    fn restore_if_kept(self) {
        let kept = self.dot_git.parent().is_some_and(Path::exists);
        if kept
            && replace_dot_git(&self.dot_git, |temp| {
                std::os::unix::fs::symlink(&self.link, temp)
            })
            .is_err()
        {
            return;
        }
        let _ = std::fs::remove_file(self.admin.join(ANNEX_LINK_RECORD));
    }
}

/// The admin folder `target` resolves to, when it is the repository's
/// `<common>/worktrees/<name>` and its `gitdir` names `worktree`'s own `.git`.
fn registered_admin(worktree: &Path, target: &Path, common: &Path) -> Option<PathBuf> {
    let admin = std::fs::canonicalize(target).ok()?;
    if admin.parent()? != common.join("worktrees") {
        return None;
    }
    let gitdir = std::fs::read_to_string(admin.join("gitdir")).ok()?;
    let backlink = admin.join(gitdir.trim());
    let names_dot_git = backlink.file_name()? == ".git"
        && std::fs::canonicalize(backlink.parent()?).ok()?
            == std::fs::canonicalize(worktree).ok()?;
    names_dot_git.then_some(admin)
}

/// Writes `.git`'s replacement beside it, then renames it over `.git`, so an interruption leaves
/// either the old or the new one.
fn replace_dot_git(
    dot_git: &Path,
    write: impl FnOnce(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let temp = dot_git.with_file_name(DOT_GIT_SWAP);
    // Left by an interrupted swap.
    let _ = std::fs::remove_file(&temp);
    let swapped = write(&temp).and_then(|()| std::fs::rename(&temp, dot_git));
    if swapped.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    swapped
}

/// Deletes a local branch (`git branch -d`, or `-D` with `force`).
pub async fn delete_branch(cwd: &Path, branch: &str, removal: Removal) -> VcsResult<()> {
    git(
        "GitVcsDriver.deleteLocalBranch",
        cwd,
        [
            "branch",
            if removal == Removal::Force {
                "-D"
            } else {
                "-d"
            },
            "--",
            branch,
        ],
    )
    .timeout(Duration::from_secs(10))
    .run()
    .await?;
    Ok(())
}

/// Every live worktree of the repository, the main checkout first.
pub async fn list_worktrees(cwd: &Path) -> VcsResult<Vec<Worktree>> {
    let out = git(
        "GitVcsDriver.listWorktrees",
        cwd,
        ["worktree", "list", "--porcelain", "-z"],
    )
    .text()
    .await?;
    let branches = parse_worktree_branches(&out);
    let mut list = Vec::new();
    for field in out.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            let path = PathBuf::from(path);
            let ref_name = branches
                .iter()
                .find(|(_, p)| **p == path)
                .map(|(b, _)| b.clone());
            list.push(Worktree { path, ref_name });
        }
    }
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_name_truncates_by_bytes_and_hashes() {
        let name = worktree_folder_name("/repo/.git", "feature/a-very-long-branch-name");
        let (prefix, hash) = name.rsplit_once('-').unwrap();
        assert_eq!(prefix, "feature-a-very-long-bra");
        assert_eq!(hash.len(), 16);
        // node -e 'console.log(require("crypto").createHash("sha256").update("/repo/.git\0t3/abc").digest("hex").slice(0,16))'
        assert_eq!(
            worktree_folder_name("/repo/.git", "t3/abc"),
            "t3-abc-23ec9f9fd335214f"
        );
        let multi = worktree_folder_name("/r", "ééééééééééééé");
        assert!(multi.split('-').next().unwrap().len() <= PREFIX_MAX_BYTES);
    }

    /// `.git` stays usable when a swap fails after writing its replacement, and when a removal
    /// stops after the swap.
    #[test]
    fn dot_git_stays_usable_through_an_interrupted_swap() {
        let root = std::env::temp_dir().join(format!("conn-vcs-annex-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(&root).unwrap();
        let (repo, checkout) = (root.join("repo"), root.join("checkout"));
        let git = |cwd: &Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        git(&root, &["init", "-q", "-b", "main", "repo"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(
            &repo,
            &["worktree", "add", "-q", "-b", "annexed", "../checkout"],
        );
        let admin = PathBuf::from(git(&checkout, &["rev-parse", "--absolute-git-dir"]));
        let dot_git = checkout.join(".git");
        std::fs::remove_file(&dot_git).unwrap();
        std::os::unix::fs::symlink(&admin, &dot_git).unwrap();
        let usable = || assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
        let injected = || Err(std::io::Error::other("injected"));

        // A failure after the temp write leaves the link.
        replace_dot_git(&dot_git, |temp| {
            std::fs::write(temp, "gitdir: /elsewhere\n")?;
            injected()
        })
        .unwrap_err();
        assert_eq!(std::fs::read_link(&dot_git).unwrap(), admin);
        usable();

        // A removal that stops after the swap leaves a working gitfile and the record.
        let common = std::fs::canonicalize(repo.join(".git")).unwrap();
        drop(AnnexLink::replace(&checkout, &common).unwrap().unwrap());
        assert!(std::fs::symlink_metadata(&dot_git).unwrap().is_file());
        assert_eq!(
            std::fs::read(admin.join(ANNEX_LINK_RECORD)).unwrap(),
            admin.as_os_str().as_bytes()
        );
        usable();

        // A failed restore keeps the gitfile, and the next attempt restores the link.
        replace_dot_git(&dot_git, |temp| {
            std::os::unix::fs::symlink(&admin, temp)?;
            injected()
        })
        .unwrap_err();
        assert!(std::fs::symlink_metadata(&dot_git).unwrap().is_file());
        usable();
        AnnexLink::replace(&checkout, &common)
            .unwrap()
            .unwrap()
            .restore_if_kept();
        assert_eq!(std::fs::read_link(&dot_git).unwrap(), admin);
        assert!(!admin.join(ANNEX_LINK_RECORD).exists());
        usable();
        let _ = std::fs::remove_dir_all(&root);
    }
}
