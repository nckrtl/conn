//! The theme the main window opens with, saved locally so the first frame needs no network.
//!
//! The Orbit profile is the shared source of a theme choice, but it arrives over the network after
//! the window has painted. Every applied theme is saved to `theme.json` beside the other
//! `conn-gpui` files, with its full colors (custom Orbit themes have no built-in copy) and the
//! reduce-transparency choice. `main` reads it synchronously before it opens the window. When the
//! choice follows the system, both slot themes are saved and the macOS appearance picks one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use conn_theme::{Appearance, Rgba, ThemeDefinition, Tokens};
use serde::{Deserialize, Serialize};

/// File name of the record under the `conn-gpui` config dir.
const FILE_NAME: &str = "theme.json";

/// One theme with every color role, stored losslessly as `[r, g, b, a]`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct StoredTheme {
    id: String,
    name: String,
    appearance: Appearance,
    roles: BTreeMap<String, [f32; 4]>,
}

impl From<&ThemeDefinition> for StoredTheme {
    fn from(theme: &ThemeDefinition) -> Self {
        Self {
            id: theme.id.clone(),
            name: theme.name.clone(),
            appearance: theme.appearance,
            roles: theme
                .roles
                .iter()
                .map(|(role, c)| (role.clone(), [c.r, c.g, c.b, c.a]))
                .collect(),
        }
    }
}

impl StoredTheme {
    fn definition(&self) -> ThemeDefinition {
        ThemeDefinition {
            id: self.id.clone(),
            name: self.name.clone(),
            appearance: self.appearance,
            roles: self
                .roles
                .iter()
                .map(|(role, [r, g, b, a])| (role.clone(), Rgba::new(*r, *g, *b, *a)))
                .collect(),
        }
    }
}

/// The last applied theme choice.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootTheme {
    /// The theme last applied.
    #[serde(default)]
    theme: Option<StoredTheme>,
    /// The light and dark slot themes, set only when the choice follows the macOS appearance.
    #[serde(default)]
    follow_system: Option<SystemSlots>,
    #[serde(default)]
    pub(crate) reduce_transparency: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct SystemSlots {
    light: StoredTheme,
    dark: StoredTheme,
}

impl BootTheme {
    /// `theme.json` under `CONN_GPUI_CONFIG_DIR` or Application Support (none in unit tests).
    #[must_use]
    pub(crate) fn default_path() -> Option<PathBuf> {
        crate::terminal_settings::settings_path(FILE_NAME)
    }

    /// The saved record, or the empty one (first run) when there is no readable file.
    #[must_use]
    pub(crate) fn load() -> Self {
        Self::default_path()
            .map(|path| Self::load_from(&path))
            .unwrap_or_default()
    }

    /// The record at `path`, or the empty one when it is missing or unreadable.
    #[must_use]
    pub(crate) fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    /// Writes the record to `path` atomically.
    pub(crate) fn save_to(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        crate::drafts::write_drafts_file(path, &json)
    }

    /// Writes the record to its default path, if there is one.
    pub(crate) fn save(&self) {
        if let Some(path) = Self::default_path()
            && let Err(err) = self.save_to(&path)
        {
            eprintln!("theme: could not save {}: {err}", path.display());
        }
    }

    /// Records `theme` as applied. `system_slots` holds the light and dark themes when the
    /// choice follows the macOS appearance, and is `None` for a fixed choice.
    pub(crate) fn record(
        &mut self,
        theme: &ThemeDefinition,
        system_slots: Option<(&ThemeDefinition, &ThemeDefinition)>,
    ) {
        self.theme = Some(theme.into());
        self.follow_system = system_slots.map(|(light, dark)| SystemSlots {
            light: light.into(),
            dark: dark.into(),
        });
    }

    /// The theme to open with for the `system` appearance, if one was ever saved.
    #[must_use]
    pub(crate) fn resolve(&self, system: Option<Appearance>) -> Option<ThemeDefinition> {
        if let (Some(slots), Some(system)) = (&self.follow_system, system) {
            let slot = match system {
                Appearance::Light => &slots.light,
                Appearance::Dark => &slots.dark,
            };
            return Some(slot.definition());
        }
        self.theme.as_ref().map(StoredTheme::definition)
    }
}

/// The theme and tokens for the first frame: `env_theme` (a built-in id from
/// `CONN_GPUI_THEME`) wins, then the saved choice, then the built-in default.
#[must_use]
pub(crate) fn startup_theme(
    saved: &BootTheme,
    env_theme: Option<&str>,
    system: Option<Appearance>,
) -> (ThemeDefinition, Tokens) {
    let theme = env_theme
        .and_then(conn_theme::theme_by_id)
        .or_else(|| saved.resolve(system))
        .unwrap_or_else(crate::live::default_theme);
    let mut tokens = Tokens::derive(&theme);
    if saved.reduce_transparency {
        crate::theme::reduce_transparency(&mut tokens);
    }
    (theme, tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builtin(id: &str) -> ThemeDefinition {
        conn_theme::theme_by_id(id).unwrap_or_else(|| panic!("{id} must be built in"))
    }

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "conn-theme-boot-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        dir.join(FILE_NAME)
    }

    #[test]
    fn a_saved_theme_round_trips_with_identical_tokens() {
        let path = temp_path("round-trip");
        let theme = builtin("dark-ocean");
        let mut boot = BootTheme::default();
        boot.record(&theme, None);
        boot.save_to(&path).unwrap_or_else(|e| panic!("save: {e}"));

        let loaded = BootTheme::load_from(&path);
        let (resolved, tokens) = startup_theme(&loaded, None, Some(Appearance::Light));
        assert_eq!(resolved, theme);
        assert_eq!(tokens, Tokens::derive(&theme));
        let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
    }

    #[test]
    fn a_custom_theme_is_restored_without_its_orbit_profile() {
        let mut custom = builtin("t3-code-light");
        custom.id = "custom-orbit-theme".to_owned();
        custom.name = "Mine".to_owned();
        custom
            .roles
            .insert("canvas".to_owned(), Rgba::new(0.1, 0.2, 0.3, 1.0));
        let mut boot = BootTheme::default();
        boot.record(&custom, None);
        let json = serde_json::to_string(&boot).unwrap_or_default();
        let loaded: BootTheme = serde_json::from_str(&json).unwrap_or_default();
        assert_eq!(startup_theme(&loaded, None, None).0, custom);
    }

    #[test]
    fn follow_system_picks_the_slot_for_the_macos_appearance() {
        let light = builtin("t3-code-light");
        let dark = builtin("dark-ocean");
        let mut boot = BootTheme::default();
        boot.record(&dark, Some((&light, &dark)));
        assert_eq!(
            startup_theme(&boot, None, Some(Appearance::Light)).0.id,
            "t3-code-light"
        );
        assert_eq!(
            startup_theme(&boot, None, Some(Appearance::Dark)).0.id,
            "dark-ocean"
        );
        // Unknown system appearance: the theme last applied.
        assert_eq!(startup_theme(&boot, None, None).0.id, "dark-ocean");
    }

    #[test]
    fn a_fixed_choice_ignores_the_macos_appearance() {
        let mut boot = BootTheme::default();
        boot.record(&builtin("dark-ocean"), None);
        assert_eq!(
            startup_theme(&boot, None, Some(Appearance::Light)).0.id,
            "dark-ocean"
        );
    }

    #[test]
    fn first_run_falls_back_to_the_default_theme() {
        let missing = BootTheme::load_from(&temp_path("missing"));
        assert_eq!(missing, BootTheme::default());
        let (theme, _) = startup_theme(&missing, None, Some(Appearance::Light));
        assert_eq!(theme, crate::live::default_theme());
    }

    #[test]
    fn a_corrupt_file_falls_back_to_the_default_theme() {
        let path = temp_path("corrupt");
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let _ = std::fs::write(&path, "{not json");
        assert_eq!(BootTheme::load_from(&path), BootTheme::default());
        let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
    }

    #[test]
    fn the_env_theme_wins_over_the_saved_one() {
        let mut boot = BootTheme::default();
        boot.record(&builtin("dark-ocean"), None);
        assert_eq!(
            startup_theme(&boot, Some("t3-code-light"), None).0.id,
            "t3-code-light"
        );
    }

    #[test]
    fn reduce_transparency_is_applied_to_the_first_tokens() {
        let boot = BootTheme {
            reduce_transparency: true,
            ..BootTheme::default()
        };
        let (_, tokens) = startup_theme(&boot, None, None);
        assert_eq!(tokens.shell_fill, tokens.sidebar);
        assert_eq!(tokens.shell_inner_fill, tokens.shell_card);
    }
}
