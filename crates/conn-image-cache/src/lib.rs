#![forbid(unsafe_code)]

//! Image bytes kept on disk, so a picture downloaded once never downloads again.
//!
//! Each entry is one file at `<root>/<environment>/<key>`, both names hex-encoded, so two
//! servers never share or overwrite each other's bytes. The cache holds at most `cap` bytes:
//! a write past the cap removes the entries used longest ago. Last use survives a restart as
//! the file's modified time.
//!
//! The cache knows nothing of threads, messages or GPUI. Callers pick the key (an attachment
//! id is stable for its bytes) and decode what comes back themselves; [`pixels`] holds the
//! crop and downscale they need, built optimized even in a dev build.

pub mod pixels;

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

/// Longest file or folder name the cache writes. Hex doubles a name, and macOS and Linux
/// allow 255 bytes.
const MAX_NAME_LEN: usize = 240;

/// Prefix of a write in progress. The scan skips and removes these.
const TEMP_PREFIX: &str = ".tmp-";

/// Image bytes on disk, by environment and key, bounded by a byte cap.
#[derive(Debug)]
pub struct ImageCache {
    root: PathBuf,
    cap: u64,
    state: Mutex<State>,
    temp_serial: AtomicU64,
}

#[derive(Debug, Default)]
struct State {
    entries: HashMap<PathBuf, Entry>,
    total: u64,
    clock: u64,
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    size: u64,
    used: u64,
}

impl State {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn remove(&mut self, relative: &Path) -> bool {
        match self.entries.remove(relative) {
            Some(entry) => {
                self.total -= entry.size;
                true
            }
            None => false,
        }
    }
}

impl ImageCache {
    /// Opens the cache at `root` (created when missing) and reads what earlier runs left there.
    /// Entries past `cap` go at once, oldest first.
    ///
    /// Reads every entry's size and time: call it off the UI thread.
    ///
    /// # Errors
    /// Returns the error of creating or listing `root`.
    pub fn open(root: impl Into<PathBuf>, cap: u64) -> io::Result<Self> {
        let root = root.into();
        create_private_dir(&root)?;
        let mut found = Vec::new();
        for environment in fs::read_dir(&root)? {
            let environment = environment?;
            if !environment.file_type()?.is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(environment.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name();
                if name.to_string_lossy().starts_with(TEMP_PREFIX) {
                    let _ = fs::remove_file(file.path());
                    continue;
                }
                let Ok(meta) = file.metadata() else { continue };
                if !meta.is_file() {
                    continue;
                }
                let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let relative = PathBuf::from(environment.file_name()).join(name);
                found.push((modified, relative, meta.len()));
            }
        }
        // Oldest first, so the clock orders entries as their last use did.
        found.sort_by_key(|(modified, _, _)| *modified);
        let mut state = State::default();
        for (_, relative, size) in found {
            let used = state.tick();
            state.total += size;
            state.entries.insert(relative, Entry { size, used });
        }
        let cache = Self {
            root,
            cap,
            state: Mutex::new(state),
            temp_serial: AtomicU64::new(0),
        };
        cache.evict(None);
        Ok(cache)
    }

    /// The folder the cache lives in.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The most bytes the cache keeps.
    pub fn cap(&self) -> u64 {
        self.cap
    }

    /// Bytes the cache holds now.
    pub fn total_bytes(&self) -> u64 {
        self.lock().total
    }

    /// Whether `key` of `environment` is on disk, without reading it or marking it used.
    pub fn contains(&self, environment: &str, key: &str) -> bool {
        relative_path(environment, key).is_some_and(|rel| self.lock().entries.contains_key(&rel))
    }

    /// The bytes of `key` in `environment`, marked as just used. `None` when they are not on
    /// disk or cannot be read (a broken entry is dropped).
    pub fn get(&self, environment: &str, key: &str) -> Option<Vec<u8>> {
        let relative = relative_path(environment, key)?;
        if !self.lock().entries.contains_key(&relative) {
            return None;
        }
        let path = self.root.join(&relative);
        match fs::read(&path) {
            Ok(bytes) => {
                let mut state = self.lock();
                let used = state.tick();
                if let Some(entry) = state.entries.get_mut(&relative) {
                    entry.used = used;
                }
                drop(state);
                // The time is how the next run orders entries; failing to set it loses nothing now.
                if let Ok(file) = fs::File::options().write(true).open(&path) {
                    let _ = file.set_modified(SystemTime::now());
                }
                Some(bytes)
            }
            Err(_) => {
                self.lock().remove(&relative);
                None
            }
        }
    }

    /// Stores `bytes` as `key` of `environment`, replacing what was there, then removes the
    /// entries used longest ago until the cache fits its cap. Returns `false`, storing nothing,
    /// when the bytes alone pass a quarter of the cap or a name is too long to keep.
    ///
    /// # Errors
    /// Returns the error of writing the file.
    pub fn put(&self, environment: &str, key: &str, bytes: &[u8]) -> io::Result<bool> {
        let Some(relative) = relative_path(environment, key) else {
            return Ok(false);
        };
        let size = bytes.len() as u64;
        if size > self.cap / 4 {
            return Ok(false);
        }
        let path = self.root.join(&relative);
        let folder = path.parent().unwrap_or(&self.root);
        create_private_dir(folder)?;
        let serial = self.temp_serial.fetch_add(1, Ordering::Relaxed);
        let temp = folder.join(format!("{TEMP_PREFIX}{}-{serial}", std::process::id()));
        let written = write_private(&temp, bytes).and_then(|()| fs::rename(&temp, &path));
        if let Err(err) = written {
            let _ = fs::remove_file(&temp);
            return Err(err);
        }
        let mut state = self.lock();
        state.remove(&relative);
        let used = state.tick();
        state.total += size;
        state.entries.insert(relative.clone(), Entry { size, used });
        drop(state);
        self.evict(Some(&relative));
        Ok(true)
    }

    /// Removes `key` of `environment`. Returns whether it was there.
    pub fn remove(&self, environment: &str, key: &str) -> bool {
        let Some(relative) = relative_path(environment, key) else {
            return false;
        };
        let removed = self.lock().remove(&relative);
        if removed {
            let _ = fs::remove_file(self.root.join(&relative));
        }
        removed
    }

    /// Removes the entries used longest ago, never `keep`, until the cache fits its cap.
    fn evict(&self, keep: Option<&Path>) {
        let mut state = self.lock();
        while state.total > self.cap {
            let oldest = state
                .entries
                .iter()
                .filter(|(relative, _)| Some(relative.as_path()) != keep)
                .min_by_key(|(_, entry)| entry.used)
                .map(|(relative, _)| relative.clone());
            let Some(oldest) = oldest else { break };
            state.remove(&oldest);
            let _ = fs::remove_file(self.root.join(&oldest));
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A panic while holding the lock leaves whole entries behind; keep using them.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// `<hex(environment)>/<hex(key)>`, or `None` when either is empty or too long.
fn relative_path(environment: &str, key: &str) -> Option<PathBuf> {
    let folder = hex_name(environment)?;
    let file = hex_name(key)?;
    Some(PathBuf::from(folder).join(file))
}

fn hex_name(value: &str) -> Option<String> {
    if value.is_empty() || value.len() * 2 > MAX_NAME_LEN {
        return None;
    }
    Some(value.bytes().map(|byte| format!("{byte:02x}")).collect())
}

/// Creates `dir` and its parents, readable by this user only.
fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_data()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(len: usize, fill: u8) -> Vec<u8> {
        vec![fill; len]
    }

    #[test]
    fn put_then_get_returns_the_bytes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ImageCache::open(dir.path(), 1_000).expect("open");
        assert!(cache.put("http://a:1/", "img-1", b"png").expect("put"));
        assert_eq!(
            cache.get("http://a:1/", "img-1").as_deref(),
            Some(&b"png"[..])
        );
        assert!(cache.contains("http://a:1/", "img-1"));
        assert_eq!(cache.total_bytes(), 3);
    }

    #[test]
    fn environments_never_share_entries() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ImageCache::open(dir.path(), 1_000).expect("open");
        assert!(cache.put("http://a:1/", "same-id", b"from a").expect("put"));
        assert!(cache.put("http://b:2/", "same-id", b"from b").expect("put"));
        assert_eq!(
            cache.get("http://a:1/", "same-id").as_deref(),
            Some(&b"from a"[..])
        );
        assert_eq!(
            cache.get("http://b:2/", "same-id").as_deref(),
            Some(&b"from b"[..])
        );
        assert_eq!(cache.get("http://c:3/", "same-id"), None);
        assert!(cache.remove("http://a:1/", "same-id"));
        assert_eq!(cache.get("http://a:1/", "same-id"), None);
        assert_eq!(
            cache.get("http://b:2/", "same-id").as_deref(),
            Some(&b"from b"[..])
        );
    }

    #[test]
    fn a_write_past_the_cap_evicts_the_least_recently_used() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ImageCache::open(dir.path(), 400).expect("open");
        for key in ["a", "b", "c", "d"] {
            assert!(cache.put("env", key, &bytes(100, 1)).expect("put"));
        }
        // `a` is read, so `b` is now the one used longest ago.
        assert!(cache.get("env", "a").is_some());
        assert!(cache.put("env", "e", &bytes(100, 2)).expect("put"));
        assert!(cache.contains("env", "a"));
        assert!(!cache.contains("env", "b"));
        assert!(cache.contains("env", "e"));
        assert_eq!(cache.total_bytes(), 400);
        let on_disk = fs::read_dir(dir.path().join(hex_name("env").expect("name")))
            .expect("folder")
            .count();
        assert_eq!(on_disk, 4, "the evicted file left the disk");
    }

    #[test]
    fn an_entry_bigger_than_a_quarter_of_the_cap_is_not_kept() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ImageCache::open(dir.path(), 400).expect("open");
        assert!(!cache.put("env", "big", &bytes(101, 0)).expect("put"));
        assert!(!cache.contains("env", "big"));
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn a_reopened_cache_keeps_entries_and_their_order_of_use() {
        let dir = tempfile::tempdir().expect("temp dir");
        {
            let cache = ImageCache::open(dir.path(), 400).expect("open");
            for key in ["old", "mid", "new", "last"] {
                assert!(cache.put("env", key, &bytes(100, 1)).expect("put"));
                // File times order entries after a restart; keep them apart.
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            // Reading `old` makes it the newest.
            assert!(cache.get("env", "old").is_some());
        }
        // A stale write in progress from a run that ended goes on open.
        let folder = dir.path().join(hex_name("env").expect("name"));
        fs::write(folder.join(format!("{TEMP_PREFIX}1-0")), b"partial").expect("temp");
        let cache = ImageCache::open(dir.path(), 400).expect("reopen");
        assert_eq!(cache.total_bytes(), 400);
        assert!(cache.get("env", "new").is_some());
        assert!(cache.put("env", "next", &bytes(100, 3)).expect("put"));
        assert!(!cache.contains("env", "mid"), "mid was used longest ago");
        assert!(cache.contains("env", "old"));
        assert!(!folder.join(format!("{TEMP_PREFIX}1-0")).exists());
    }

    #[test]
    fn a_smaller_cap_on_open_trims_the_oldest() {
        let dir = tempfile::tempdir().expect("temp dir");
        {
            let cache = ImageCache::open(dir.path(), 1_000).expect("open");
            for key in ["a", "b", "c"] {
                assert!(cache.put("env", key, &bytes(100, 1)).expect("put"));
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        let cache = ImageCache::open(dir.path(), 200).expect("reopen");
        assert!(!cache.contains("env", "a"));
        assert!(cache.contains("env", "b") && cache.contains("env", "c"));
    }

    #[test]
    fn a_file_removed_behind_the_cache_reads_as_missing() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ImageCache::open(dir.path(), 1_000).expect("open");
        assert!(cache.put("env", "gone", b"x").expect("put"));
        let path = dir.path().join(relative_path("env", "gone").expect("path"));
        fs::remove_file(path).expect("remove");
        assert_eq!(cache.get("env", "gone"), None);
        assert!(!cache.contains("env", "gone"));
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn names_are_hex_and_bounded() {
        assert_eq!(hex_name("a/b").as_deref(), Some("612f62"));
        assert_eq!(hex_name(""), None);
        assert_eq!(hex_name(&"x".repeat(121)), None);
        let dir = tempfile::tempdir().expect("temp dir");
        let cache = ImageCache::open(dir.path(), 1_000).expect("open");
        assert!(!cache.put("env", &"x".repeat(200), b"x").expect("put"));
    }

    #[cfg(unix)]
    #[test]
    fn entries_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("images");
        let cache = ImageCache::open(&root, 1_000).expect("open");
        assert!(cache.put("env", "k", b"x").expect("put"));
        let file = root.join(relative_path("env", "k").expect("path"));
        let mode = fs::metadata(file).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let mode = fs::metadata(&root).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
