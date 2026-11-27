//! Local files of the linked environments (`docs/scope.md` §2.1), in
//! `~/Library/Application Support/conn-gpui/` beside `orbit-sessions.json`:
//!
//! - `linked-shells/<environment id>.json`: each linked environment's last shell snapshot, so its
//!   threads list while it is asleep or offline (Conn keeps the same in its connection cache).
//!   The bytes come from `conn_state::environments::LinkedShellSnapshot`; this module only
//!   stores them.
//! - `linked-environments.json`: the user's choices, the per-environment switch (Conn's
//!   `setEnabled`) and the Instance servers to link before this device holds a session for them.
//!
//! Both are GPUI's own state. Nothing here writes to a server.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::OrbitSessionStore;

const SHELLS_DIR: &str = "linked-shells";
const SETTINGS_FILE: &str = "linked-environments.json";

/// The user's choices about linked environments.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkedEnvironmentSettings {
    /// Environments switched off: not connected, and their threads are not listed.
    #[serde(default)]
    pub disabled: BTreeSet<String>,
    /// Instance servers to link as soon as they run, before a session for them exists.
    #[serde(default)]
    pub instances: BTreeSet<String>,
}

impl LinkedEnvironmentSettings {
    /// Whether `environment_id` is switched on.
    #[must_use]
    pub fn is_enabled(&self, environment_id: &str) -> bool {
        !self.disabled.contains(environment_id)
    }

    /// Switches an environment on or off. Returns whether anything changed.
    pub fn set_enabled(&mut self, environment_id: &str, enabled: bool) -> bool {
        if enabled {
            self.disabled.remove(environment_id)
        } else {
            self.disabled.insert(environment_id.to_owned())
        }
    }
}

/// The directory of the linked-environment files.
#[derive(Debug, Clone)]
pub struct LinkedStore {
    dir: PathBuf,
}

/// An environment id is a UUID; anything else never becomes a file name.
fn file_stem(environment_id: &str) -> Option<&str> {
    let ok = !environment_id.is_empty()
        && environment_id.len() <= 80
        && environment_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(environment_id)
}

impl LinkedStore {
    /// Beside `orbit-sessions.json` (`CONN_GPUI_CONFIG_DIR` moves both).
    #[must_use]
    pub fn default_store() -> Option<Self> {
        let dir = OrbitSessionStore::default_path()?.parent()?.to_path_buf();
        Some(Self { dir })
    }

    #[must_use]
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn shells_dir(&self) -> PathBuf {
        self.dir.join(SHELLS_DIR)
    }

    fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write as _;

        Self::write_with(path, |writer| writer.write_all(bytes))
    }

    /// Replaces `path` with what `fill` writes, through a buffer: a serializer makes one small
    /// write per token, which would be millions of system calls for a large shell.
    fn write_with(
        path: &Path,
        fill: impl FnOnce(&mut std::io::BufWriter<std::fs::File>) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        use std::io::Write as _;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut writer = std::io::BufWriter::with_capacity(256 * 1024, options.open(&tmp)?);
        fill(&mut writer)?;
        writer.flush()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        drop(writer);
        std::fs::rename(&tmp, path)
    }

    /// Saves the snapshot bytes of one environment, replacing its last one.
    ///
    /// # Errors
    /// Returns an `InvalidInput` error for an id that is not a plain id, or any write error.
    pub fn save_shell(&self, environment_id: &str, bytes: &[u8]) -> std::io::Result<()> {
        Self::write(&self.shell_path(environment_id)?, bytes)
    }

    /// Saves one environment's snapshot as JSON, written straight to the file through a buffer
    /// rather than built in memory first.
    ///
    /// # Errors
    /// Returns an `InvalidInput` error for an id that is not a plain id, or any serialization or
    /// write error.
    pub fn save_shell_json(
        &self,
        environment_id: &str,
        snapshot: &impl Serialize,
    ) -> std::io::Result<()> {
        Self::write_with(&self.shell_path(environment_id)?, |writer| {
            serde_json::to_writer(writer, snapshot).map_err(std::io::Error::from)
        })
    }

    fn shell_path(&self, environment_id: &str) -> std::io::Result<PathBuf> {
        let stem = file_stem(environment_id).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "not an environment id")
        })?;
        Ok(self.shells_dir().join(format!("{stem}.json")))
    }

    /// The bytes of every saved snapshot, in file-name order.
    #[must_use]
    pub fn load_shells(&self) -> Vec<Vec<u8>> {
        let Ok(entries) = std::fs::read_dir(self.shells_dir()) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        files.sort();
        files
            .into_iter()
            .filter_map(|path| std::fs::read(path).ok())
            .collect()
    }

    /// Forgets an environment's snapshot. Returns whether a file was removed.
    pub fn remove_shell(&self, environment_id: &str) -> bool {
        let Some(stem) = file_stem(environment_id) else {
            return false;
        };
        std::fs::remove_file(self.shells_dir().join(format!("{stem}.json"))).is_ok()
    }

    /// The saved choices, or the defaults (everything on, no chosen Instances).
    #[must_use]
    pub fn load_settings(&self) -> LinkedEnvironmentSettings {
        std::fs::read_to_string(self.dir.join(SETTINGS_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    /// # Errors
    /// Returns any serialization or write error.
    pub fn save_settings(&self, settings: &LinkedEnvironmentSettings) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        Self::write(&self.dir.join(SETTINGS_FILE), &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_round_trip_replace_and_are_removed_by_environment() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LinkedStore::at(dir.path());
        assert!(store.load_shells().is_empty());
        store.save_shell("mini", b"{\"a\":1}").expect("save");
        store.save_shell("form-2605", b"{\"b\":2}").expect("save");
        store.save_shell("mini", b"{\"a\":3}").expect("replace");
        let loaded = store.load_shells();
        assert_eq!(loaded.len(), 2);
        assert!(loaded.contains(&b"{\"a\":3}".to_vec()));
        assert!(store.remove_shell("mini"));
        assert!(!store.remove_shell("mini"));
        assert_eq!(store.load_shells(), vec![b"{\"b\":2}".to_vec()]);
    }

    #[test]
    fn an_id_that_could_leave_the_folder_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LinkedStore::at(dir.path());
        assert!(store.save_shell("../escape", b"x").is_err());
        assert!(store.save_shell("", b"x").is_err());
        assert!(!store.remove_shell("../escape"));
        assert!(!dir.path().join("escape.json").exists());
    }

    #[test]
    fn settings_default_to_everything_on_and_keep_the_choices() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LinkedStore::at(dir.path());
        let mut settings = store.load_settings();
        assert!(settings.is_enabled("mini"));
        assert!(settings.instances.is_empty());

        assert!(settings.set_enabled("mini", false));
        assert!(
            !settings.set_enabled("mini", false),
            "no change the second time"
        );
        settings.instances.insert("form-2605".to_owned());
        store.save_settings(&settings).expect("save");

        let again = store.load_settings();
        assert!(!again.is_enabled("mini"));
        assert!(again.is_enabled("nick-vm"));
        assert!(again.instances.contains("form-2605"));
        let mut back_on = again;
        assert!(back_on.set_enabled("mini", true));
        assert!(back_on.is_enabled("mini"));
    }

    #[test]
    fn an_unreadable_settings_file_means_the_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join(SETTINGS_FILE), "{ not json").expect("write");
        assert_eq!(
            LinkedStore::at(dir.path()).load_settings(),
            LinkedEnvironmentSettings::default()
        );
    }
}
