use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Editor view choices that follow the user from file to file and survive a restart: whether
/// Markdown files open rendered, and whether long lines wrap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub(super) struct ViewPrefs {
    #[serde(default)]
    pub(super) markdown_preview: bool,
    #[serde(default)]
    pub(super) word_wrap: bool,
}

impl ViewPrefs {
    /// The settings file; none under test, so tests never touch the user's real settings.
    pub(super) fn path() -> Option<PathBuf> {
        crate::terminal_settings::settings_path("files-view.json")
    }

    /// Reads the saved choices; a missing or unreadable file gives the defaults.
    pub(super) fn load(path: Option<&Path>) -> Self {
        path.and_then(|path| std::fs::read(path).ok())
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default()
    }

    pub(super) fn save(&self, path: Option<&Path>) {
        if let Some(path) = path
            && let Ok(json) = serde_json::to_string(self)
        {
            let _ = crate::drafts::write_drafts_file(path, &json);
        }
    }
}
