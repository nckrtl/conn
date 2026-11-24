//! Saved appearance of native source editors.
use std::sync::{Arc, LazyLock};

use crate::theme::{MONO_FONT, hsla};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::{Theme, highlighter::HighlightTheme};
use gpui_kit::{App, Global, SharedString};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Palette {
    #[default]
    One,
    Ayu,
    Gruvbox,
}

impl Palette {
    pub(crate) const ALL: [Self; 3] = [Self::One, Self::Ayu, Self::Gruvbox];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::One => "One",
            Self::Ayu => "Ayu",
            Self::Gruvbox => "Gruvbox",
        }
    }

    pub(crate) fn bytes(self) -> &'static [u8] {
        match self {
            Self::One => {
                include_bytes!("../../../.refs/zed-files-spike/assets/themes/one/one.json")
            }
            Self::Ayu => {
                include_bytes!("../../../.refs/zed-files-spike/assets/themes/ayu/ayu.json")
            }
            Self::Gruvbox => {
                include_bytes!("../../../.refs/zed-files-spike/assets/themes/gruvbox/gruvbox.json")
            }
        }
    }

    fn name(self, appearance: Appearance) -> String {
        format!(
            "{} {}",
            self.label(),
            if appearance == Appearance::Light {
                "Light"
            } else {
                "Dark"
            }
        )
    }
}

#[derive(Default, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct Preferences {
    pub(crate) font_family: String,
    pub(crate) palette: Palette,
}

#[derive(Default)]
struct Store {
    prefs: Preferences,
    family: SharedString,
}
impl Global for Store {}

pub(crate) fn current(cx: &App) -> Preferences {
    cx.try_global::<Store>()
        .map(|s| s.prefs.clone())
        .unwrap_or_default()
}

pub(crate) fn family(cx: &App) -> SharedString {
    cx.try_global::<Store>()
        .map(|s| s.family.clone())
        .unwrap_or_else(|| MONO_FONT.into())
}

fn resolve_family(value: &str, cx: &App) -> SharedString {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case(MONO_FONT) {
        return MONO_FONT.into();
    }
    cx.text_system()
        .all_font_names()
        .into_iter()
        .find(|name| name.eq_ignore_ascii_case(value))
        .map(Into::into)
        .unwrap_or_else(|| MONO_FONT.into())
}

pub(crate) fn init(cx: &mut App) {
    let prefs: Preferences = crate::terminal_settings::settings_path("editor-settings.json")
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    cx.set_global(Store {
        family: resolve_family(&prefs.font_family, cx),
        prefs,
    });
}

pub(crate) fn update(cx: &mut App, tokens: &Tokens, f: impl FnOnce(&mut Preferences)) {
    let previous = current(cx);
    let mut prefs = previous.clone();
    f(&mut prefs);
    if prefs == previous {
        return;
    }
    if let Some(path) = crate::terminal_settings::settings_path("editor-settings.json")
        && let Ok(json) = serde_json::to_string_pretty(&prefs)
        && let Err(error) = crate::drafts::write_drafts_file(&path, &json)
    {
        eprintln!("Could not save editor settings: {error}");
    }
    let effective_family = resolve_family(&prefs.font_family, cx);
    let changed = effective_family != family(cx) || prefs.palette != previous.palette;
    cx.set_global(Store {
        family: effective_family,
        prefs,
    });
    if changed {
        apply(tokens, cx);
    }
    cx.refresh_windows();
}

pub(crate) fn apply(tokens: &Tokens, cx: &mut App) {
    #[derive(Deserialize)]
    struct Family {
        themes: Vec<HighlightTheme>,
    }
    static THEMES: LazyLock<Vec<HighlightTheme>> = LazyLock::new(|| {
        Palette::ALL
            .into_iter()
            .flat_map(|p| {
                serde_json::from_slice::<Family>(p.bytes())
                    .expect("bundled editor theme")
                    .themes
            })
            .collect()
    });
    let name = current(cx).palette.name(tokens.appearance);
    let bg = hsla(tokens.shell_card);
    if let Some(theme) = THEMES.iter().find(|t| t.name == name) {
        Theme::update(cx, |kit| {
            let mut theme = theme.clone();
            theme.style.editor_background = Some(bg);
            theme.style.editor_active_line = Some(bg);
            theme.style.editor_gutter_background = Some(bg);
            kit.highlight_theme = Arc::new(theme);
        });
    }
    #[cfg(feature = "zed-files")]
    crate::panels::zed_preview::apply(&name, tokens, cx);
}
