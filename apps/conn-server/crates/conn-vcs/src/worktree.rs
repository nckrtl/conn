//! Worktrees: create from a ref, list, remove. Used by `vcs.createWorktree` /
//! `vcs.removeWorktree` and by thread launch with a worktree strategy (see [`crate::setup`]).
//!
//! Paths follow `GitVcsDriverCore.createWorktree`: `<worktrees dir>/<repo>/<branch>-<hash16>`,
//! where the hash is `sha256(<git common dir> NUL <branch>)`.

use std::{
    ffi::{OsStr, OsString},
    fs::{File, Metadata, OpenOptions, TryLockError},
    io::{self, Read, Write},
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
    },
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
    let prepared = blocking(cwd, {
        let target = target.clone();
        move || Prepared::new(&target, &common)
    })
    .await??;
    let removed = git("GitVcsDriver.removeWorktree", cwd, args)
        .timeout(REMOVE_TIMEOUT)
        .run()
        .await;
    blocking(cwd, move || prepared.finish()).await?;
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

/// The swap entry's name, a NUL and the original `.git` link, kept in the admin folder while
/// `.git` is a gitfile, so the next removal attempt can restore the link after an interruption.
const ANNEX_LINK_RECORD: &str = "conn-annex-link";
/// Held from before the swap until after the restore, so removals of one worktree never
/// overlap.
const REMOVAL_LOCK: &str = "conn-remove.lock";
/// `.git`'s replacement is created exclusively as `<prefix><random>`, then renamed over it.
const DOT_GIT_SWAP_PREFIX: &str = ".git.conn-swap-";

fn refuse(worktree: &Path, detail: String) -> VcsError {
    VcsError::invalid(
        "GitVcsDriver.removeWorktree",
        &worktree.to_string_lossy(),
        format!("fatal: {detail}"),
    )
}

/// A removal's hold on a linked worktree: its admin folder's lock and, for git-annex, the
/// swapped `.git` link.
struct Prepared {
    _lock: Option<File>,
    annexed: Option<AnnexLink>,
}

impl Prepared {
    /// Locks the worktree's admin folder, then swaps a git-annex link for a `gitdir:` file or
    /// picks up a swap an interrupted removal left. Waits while another removal holds the lock.
    fn new(worktree: &Path, common: &Path) -> VcsResult<Self> {
        // A removal that finished while this one waited deleted the admin folder and its lock;
        // look again.
        for _ in 0..3 {
            let Some((admin, _)) = locate(worktree, common)? else {
                return Ok(Self {
                    _lock: None,
                    annexed: None,
                });
            };
            let lock = lock_admin(&admin).map_err(|e| {
                refuse(
                    worktree,
                    format!("failed to lock '{}': {e}", admin.display()),
                )
            })?;
            let Some(lock) = lock else { continue };
            let annexed = match locate(worktree, common)? {
                Some((now, _)) if now != admin => continue,
                Some((_, DotGit::Link(link))) => Some(AnnexLink::swap(worktree, link, admin)?),
                Some((_, DotGit::File)) => AnnexLink::interrupted(worktree, admin),
                None => None,
            };
            return Ok(Self {
                _lock: Some(lock),
                annexed,
            });
        }
        Err(refuse(
            worktree,
            format!("'{}' changed during removal", worktree.display()),
        ))
    }

    /// Restores a kept checkout's link, then releases the lock.
    fn finish(self) {
        if let Some(link) = self.annexed {
            link.restore_if_kept();
        }
    }
}

/// What a linked worktree's `.git` is.
enum DotGit {
    /// git-annex's symlink to the admin folder, with the link's own text.
    Link(PathBuf),
    /// git's own `gitdir:` file.
    File,
}

/// The registered admin folder `worktree`'s `.git` names, if any. A symlink to anything else is
/// refused before the checkout changes; any other layout is git's to handle.
fn locate(worktree: &Path, common: &Path) -> VcsResult<Option<(PathBuf, DotGit)>> {
    let dot_git = worktree.join(".git");
    if std::fs::symlink_metadata(&dot_git).is_ok_and(|m| m.is_symlink()) {
        let not_a_worktree = || {
            refuse(
                worktree,
                format!("'{}' is not a working tree", worktree.display()),
            )
        };
        let link = std::fs::read_link(&dot_git).map_err(|_| not_a_worktree())?;
        let admin =
            registered_admin(worktree, &worktree.join(&link), common).ok_or_else(not_a_worktree)?;
        return Ok(Some((admin, DotGit::Link(link))));
    }
    let Ok(gitfile) = std::fs::read(&dot_git) else {
        return Ok(None);
    };
    Ok(gitfile
        .strip_prefix(b"gitdir: ")
        .map(<[u8]>::trim_ascii_end)
        .and_then(|target| {
            registered_admin(worktree, &worktree.join(OsStr::from_bytes(target)), common)
        })
        .map(|admin| (admin, DotGit::File)))
}

/// Locks `admin`'s removal lock, waiting for another holder. `None` when the lock file went
/// away while this one waited, as it does when git deletes the admin folder.
fn lock_admin(admin: &Path) -> io::Result<Option<File>> {
    let path = admin.join(REMOVAL_LOCK);
    let file = match open_single(
        &path,
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false),
    ) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        file => file?,
    };
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            #[cfg(test)]
            tests::contended(&path);
            file.lock()?;
        }
        Err(TryLockError::Error(e)) => return Err(e),
    }
    let held = file.metadata()?;
    match std::fs::symlink_metadata(&path) {
        Ok(entry) => Ok(same_entry(&held, &entry).then_some(file)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Opens `path` only when it is a regular file with one link, so a symlink or hard link
/// planted in the admin folder is never followed.
fn open_single(path: &Path, options: &OpenOptions) -> io::Result<File> {
    let file = options.open(path)?;
    let opened = file.metadata()?;
    let entry = std::fs::symlink_metadata(path)?;
    if !entry.is_file() || !same_entry(&opened, &entry) || opened.nlink() != 1 {
        return Err(io::Error::other(format!(
            "'{}' is not a plain file",
            path.display()
        )));
    }
    Ok(file)
}

fn same_entry(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// git-annex replaces a linked worktree's `.git` file with a symlink to its admin folder, so its
/// links into `.git/annex` resolve. Git refuses to remove such a worktree, so the removal puts
/// the standard `gitdir:` file back for git and restores the link if the checkout survives.
struct AnnexLink {
    dot_git: PathBuf,
    /// The link's own text, restored as it was.
    link: PathBuf,
    admin: PathBuf,
    /// Where `.git`'s replacement is created; named in the record.
    swap: PathBuf,
}

impl AnnexLink {
    /// Records the link and the swap entry's name, then swaps the link for a `gitdir:` file.
    fn swap(worktree: &Path, link: PathBuf, admin: PathBuf) -> VcsResult<Self> {
        let name = OsString::from(format!("{DOT_GIT_SWAP_PREFIX}{}", conn_support::uuid_v4()));
        let this = Self {
            dot_git: worktree.join(".git"),
            swap: worktree.join(&name),
            link,
            admin,
        };
        write_record(&this.admin, &name, &this.link)
            .and_then(|()| {
                replace_dot_git(&this.dot_git, &this.swap, |temp| {
                    write_gitfile(temp, &this.admin)
                })
            })
            .map_err(|e| {
                let _ = std::fs::remove_file(this.admin.join(ANNEX_LINK_RECORD));
                refuse(
                    worktree,
                    format!("failed to replace '{}': {e}", this.dot_git.display()),
                )
            })?;
        Ok(this)
    }

    /// The gitfile a removal interrupted after the swap left, with the link it replaced. Clears
    /// the swap entry the record names, left when a swap or restore stopped before its rename.
    fn interrupted(worktree: &Path, admin: PathBuf) -> Option<Self> {
        let (name, link) = read_record(&admin)?;
        if std::fs::canonicalize(worktree.join(&link)).ok()? != admin {
            return None;
        }
        let swap = worktree.join(name);
        let _ = std::fs::remove_file(&swap);
        Some(Self {
            dot_git: worktree.join(".git"),
            link,
            admin,
            swap,
        })
    }

    /// A kept checkout gets its link back. If that fails, the gitfile stays usable and the
    /// record stays for the next attempt.
    fn restore_if_kept(self) {
        let kept = self.dot_git.parent().is_some_and(Path::exists);
        if kept
            && replace_dot_git(&self.dot_git, &self.swap, |temp| {
                std::os::unix::fs::symlink(&self.link, temp)
            })
            .is_err()
        {
            return;
        }
        let _ = std::fs::remove_file(self.admin.join(ANNEX_LINK_RECORD));
    }
}

/// Writes the record to a fresh file in `admin`, then renames it over the old one, so a link
/// at the record's path is replaced, never written through.
fn write_record(admin: &Path, swap: &OsStr, link: &Path) -> io::Result<()> {
    let temp = admin.join(format!(
        "{ANNEX_LINK_RECORD}.tmp-{}",
        conn_support::uuid_v4()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let mut bytes = swap.as_bytes().to_vec();
    bytes.push(0);
    bytes.extend_from_slice(link.as_os_str().as_bytes());
    let written = file
        .write_all(&bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&temp, admin.join(ANNEX_LINK_RECORD)));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// The swap entry's name and the link from `admin`'s record, when the record is a plain file
/// and the name is one a swap makes.
fn read_record(admin: &Path) -> Option<(OsString, PathBuf)> {
    let mut bytes = Vec::new();
    open_single(
        &admin.join(ANNEX_LINK_RECORD),
        OpenOptions::new().read(true),
    )
    .ok()?
    .read_to_end(&mut bytes)
    .ok()?;
    let mut parts = bytes.splitn(2, |b| *b == 0);
    let name = parts.next()?;
    let link = parts.next()?;
    let suffix = name.strip_prefix(DOT_GIT_SWAP_PREFIX.as_bytes())?;
    if suffix.is_empty() || suffix.contains(&b'/') || link.is_empty() {
        return None;
    }
    Some((
        OsString::from_vec(name.to_vec()),
        PathBuf::from(OsString::from_vec(link.to_vec())),
    ))
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

/// A `gitdir:` file at `temp`, which must not exist yet.
fn write_gitfile(temp: &Path, admin: &Path) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(temp)?;
    let mut bytes = b"gitdir: ".to_vec();
    bytes.extend_from_slice(admin.as_os_str().as_bytes());
    bytes.push(b'\n');
    file.write_all(&bytes).inspect_err(|_| {
        let _ = std::fs::remove_file(temp);
    })
}

/// Has `create` make `.git`'s replacement at `temp`, exclusively, then renames it over `.git`,
/// so an interruption leaves either the old or the new one. An entry already at `temp` fails
/// the creation and stays.
fn replace_dot_git(
    dot_git: &Path,
    temp: &Path,
    create: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    create(temp)?;
    std::fs::rename(temp, dot_git).inspect_err(|_| {
        let _ = std::fs::remove_file(temp);
    })
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

    type Waiter = (PathBuf, tokio::sync::oneshot::Sender<()>);
    /// Removals a test waits on, by lock path: told when they find the lock held.
    static CONTENDED: std::sync::Mutex<Vec<Waiter>> = std::sync::Mutex::new(Vec::new());

    pub(super) fn contended(lock: &Path) {
        let mut waiters = CONTENDED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(i) = waiters.iter().position(|(path, _)| path == lock) {
            let (_, waiter) = waiters.swap_remove(i);
            let _ = waiter.send(());
        }
    }

    /// While one removal is inside `git worktree remove`, a second removal of the same worktree
    /// waits on the lock; the swapped `.git` and its record stay until the first one restores
    /// them.
    #[tokio::test]
    async fn a_second_removal_waits_for_the_first() {
        let root =
            std::env::temp_dir().join(format!("conn-vcs-annex-overlap-{}", std::process::id()));
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
        std::fs::write(checkout.join("notes.txt"), "draft\n").unwrap();
        let (record, lock) = (
            admin.join("conn-annex-link"),
            admin.join("conn-remove.lock"),
        );

        // git's dirty check runs the fsmonitor hook. Its first call says it started through one
        // FIFO and waits for a line on another, which holds the first removal inside git.
        let (started, release) = (root.join("started"), root.join("release"));
        for fifo in [&started, &release] {
            let made = std::process::Command::new("mkfifo")
                .arg(fifo)
                .status()
                .unwrap();
            assert!(made.success(), "mkfifo");
        }
        let hook = root.join("fsmonitor.sh");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\nif /bin/mkdir '{}' 2>/dev/null; then\n  printf x > '{}'\n  read line < '{}'\nfi\nexit 1\n",
                root.join("held").display(),
                started.display(),
                release.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        git(&repo, &["config", "core.fsmonitor", hook.to_str().unwrap()]);

        let remove = || {
            let (repo, checkout) = (repo.clone(), checkout.clone());
            tokio::spawn(async move { remove_worktree(&repo, &checkout, Removal::Safe).await })
        };
        let first = remove();
        tokio::task::spawn_blocking(move || std::fs::read(started))
            .await
            .unwrap()
            .unwrap();

        let (waiting, contention) = tokio::sync::oneshot::channel();
        CONTENDED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((lock.clone(), waiting));
        let mut second = remove();
        // Either the second removal finds the lock held, or it returns without waiting.
        let returned = tokio::select! {
            found = contention => {
                found.unwrap();
                None
            }
            done = &mut second => Some(done.unwrap()),
        };
        let held = std::fs::File::open(&lock)
            .is_ok_and(|probe| matches!(probe.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
        let swapped = std::fs::symlink_metadata(&dot_git).unwrap().is_file();
        let recorded = record.exists();
        tokio::task::spawn_blocking(move || std::fs::write(release, "go\n"))
            .await
            .unwrap()
            .unwrap();
        assert!(
            first.await.unwrap().is_err(),
            "the dirty checkout is refused"
        );
        let waited = returned.is_none();
        let second = match returned {
            Some(done) => done,
            None => second.await.unwrap(),
        };
        assert!(second.is_err(), "the dirty checkout is refused");

        assert!(
            waited,
            "the second removal returned while the first held the worktree"
        );
        assert!(held, "the first removal holds the lock");
        assert!(
            swapped && recorded,
            "the first removal's swap and record survived"
        );
        assert_eq!(std::fs::read_link(&dot_git).unwrap(), admin);
        assert!(!record.exists(), "the record goes with the restore");
        assert_eq!(
            std::fs::read_to_string(checkout.join("notes.txt")).unwrap(),
            "draft\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

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

    /// `.git` stays usable when a swap stops before or after its rename, and when a removal
    /// stops after the swap. Only the swap entry the record names is ever cleared.
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
        // Ignored, so the checkout stays clean for `usable`.
        std::fs::write(repo.join(".git/info/exclude"), ".git.conn-swap*\n").unwrap();
        let user_file = checkout.join(".git.conn-swap");
        std::fs::write(&user_file, "mine\n").unwrap();
        let usable = || assert_eq!(git(&checkout, &["status", "--porcelain"]), "");
        let mine = || assert_eq!(std::fs::read_to_string(&user_file).unwrap(), "mine\n");

        // An entry already at the swap path fails the swap and stays.
        replace_dot_git(&dot_git, &user_file, |temp| write_gitfile(temp, &admin)).unwrap_err();
        assert_eq!(std::fs::read_link(&dot_git).unwrap(), admin);
        mine();
        usable();

        // A removal that stops after the swap leaves a working gitfile and the record.
        let common = std::fs::canonicalize(repo.join(".git")).unwrap();
        drop(Prepared::new(&checkout, &common).unwrap());
        assert!(std::fs::symlink_metadata(&dot_git).unwrap().is_file());
        let (name, link) = read_record(&admin).unwrap();
        assert_eq!(link, admin);
        usable();

        // A restore that stops after creating its replacement keeps the gitfile, and the next
        // attempt clears that entry and restores the link.
        let swap = checkout.join(&name);
        std::os::unix::fs::symlink(&admin, &swap).unwrap();
        assert!(std::fs::symlink_metadata(&dot_git).unwrap().is_file());
        usable();
        Prepared::new(&checkout, &common).unwrap().finish();
        assert_eq!(std::fs::read_link(&dot_git).unwrap(), admin);
        assert!(!admin.join(ANNEX_LINK_RECORD).exists(), "record cleared");
        assert!(
            std::fs::symlink_metadata(&swap).is_err(),
            "swap entry cleared"
        );
        mine();
        usable();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A record that is a symlink or a hard link is not read.
    #[test]
    fn a_linked_record_is_not_read() {
        let root =
            std::env::temp_dir().join(format!("conn-vcs-annex-record-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let elsewhere = root.join("elsewhere");
        std::fs::write(&elsewhere, b".git.conn-swap-x\0/admin").unwrap();
        let record = root.join(ANNEX_LINK_RECORD);

        std::fs::copy(&elsewhere, &record).unwrap();
        assert!(read_record(&root).is_some(), "a plain record is read");
        std::fs::remove_file(&record).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &record).unwrap();
        assert!(read_record(&root).is_none(), "symlink");
        std::fs::remove_file(&record).unwrap();
        std::fs::hard_link(&elsewhere, &record).unwrap();
        assert!(read_record(&root).is_none(), "hard link");

        write_record(&root, OsStr::new(".git.conn-swap-y"), Path::new("/a")).unwrap();
        assert_eq!(
            std::fs::read(&elsewhere).unwrap(),
            b".git.conn-swap-x\0/admin",
            "the link's target is untouched"
        );
        assert!(
            read_record(&root).is_some(),
            "the new record is a plain file"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
