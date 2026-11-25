//! Conn's file-type icons for the Files tree, file tabs, the breadcrumb menu and the chips.
//!
//! These are the Pierre Icons "Complete" theme for Zed (`pierrecomputer/vscode-icons`, MIT), solid
//! only. `tables.rs` holds the theme's tables, copied from the design lab's `pierreIcons.ts`. The
//! lookup follows Zed's `FileIcons::get_icon`: the whole name, then each dotted suffix, then the
//! stem, then the default. Pierre has no PHP or Blade icon: `php-conn` and `blade-conn` are Nick's
//! own SVGs. See `assets/icons/files/PROVENANCE.md`.
//!
//! The lookup is pure and returns embedded asset paths (`files/<name>.svg`). A Pierre icon keeps
//! its own colours, so it is drawn as an image ([`icon_img`]), not as a tinted glyph. Folders get
//! a solid closed or open icon ([`folder_icon`]).

use conn_theme::Appearance;
use gpui_kit::{Img, ObjectFit, Styled as _, StyledImage as _, img, px};

mod tables;

use tables::{FOLDER, FOLDER_OPEN, ICONS, STEMS, SUFFIXES};

/// The `files/` prefix every Pierre asset path carries.
pub(crate) const ASSET_PREFIX: &str = "files/";

/// The default file icon, `[dark, light]`.
const DEFAULT: [&str; 2] = ["files/file-solid.svg", "files/file-solid-light.svg"];

/// A resolved file-type or folder icon: the embedded SVG for the active appearance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FileIcon {
    pub(crate) asset: &'static str,
}

/// Picks the dark or light SVG of a `[dark, light]` pair.
const fn pick(pair: [&'static str; 2], appearance: Appearance) -> FileIcon {
    FileIcon {
        asset: match appearance {
            Appearance::Dark => pair[0],
            Appearance::Light => pair[1],
        },
    }
}

fn find(table: &'static [(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table
        .binary_search_by_key(&key, |(name, _)| name)
        .ok()
        .map(|index| table[index].1)
}

fn pair(kind: &str) -> Option<[&'static str; 2]> {
    ICONS
        .binary_search_by_key(&kind, |(name, _)| name)
        .ok()
        .map(|index| ICONS[index].1)
}

/// The theme's icon type for a name, suffix or stem: stems first, then suffixes (`forSuffix`).
fn kind_for(key: &str) -> Option<&'static str> {
    find(STEMS, key).or_else(|| find(SUFFIXES, key))
}

/// Resolves the icon type for a file path or base name, as Zed's `FileIcons::get_icon` does:
/// 1. the whole name, for example `Dockerfile` or `package.json`;
/// 2. each dotted suffix, longest first, for example `blade.php` then `php`;
/// 3. the stem (the part before the first dot);
/// 4. the default file icon.
///
/// Matching is case-sensitive, as in Zed.
fn resolve(path: &str) -> [&'static str; 2] {
    let name = path.rsplit('/').next().unwrap_or(path);
    let found = kind_for(name).or_else(|| {
        let mut rest = name;
        let mut stem = None;
        while let Some(dot) = rest.find('.') {
            stem.get_or_insert(&name[..name.len() - rest.len() + dot]);
            rest = &rest[dot + 1..];
            if let Some(kind) = kind_for(rest) {
                return Some(kind);
            }
        }
        stem.filter(|stem| !stem.is_empty()).and_then(kind_for)
    });
    found.and_then(pair).unwrap_or(DEFAULT)
}

/// The icon for a file path or base name in the given appearance.
#[must_use]
pub(crate) fn file_icon(path: &str, appearance: Appearance) -> FileIcon {
    pick(resolve(path), appearance)
}

/// The solid folder icon, closed or open. It has no arrow.
#[must_use]
pub(crate) const fn folder_icon(open: bool, appearance: Appearance) -> FileIcon {
    pick(if open { FOLDER_OPEN } else { FOLDER }, appearance)
}

/// Every distinct icon the lookup can return, folders and the default included, for one
/// appearance. The screenshot grid lists them.
#[cfg(test)]
pub(crate) fn all_icons(appearance: Appearance) -> Vec<FileIcon> {
    let mut icons: Vec<FileIcon> = ICONS
        .iter()
        .map(|(_, pair)| pick(*pair, appearance))
        .collect();
    icons.extend([FOLDER, FOLDER_OPEN].map(|pair| pick(pair, appearance)));
    icons
}

/// Whether an asset path is a Pierre icon (drawn in its own colours), not a tinted glyph.
#[must_use]
pub(crate) fn is_file_icon_asset(asset: &str) -> bool {
    asset.starts_with(ASSET_PREFIX)
}

/// Draws an icon at `size_px`, in the SVG's own colours.
#[must_use]
pub(crate) fn icon_img(asset: &'static str, size_px: f32) -> Img {
    img(asset)
        .size(px(size_px))
        .flex_none()
        .object_fit(ObjectFit::Contain)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use gpui_kit::AssetSource as _;

    use super::*;
    use crate::superhero::AppAssets;

    fn name(icon: FileIcon) -> &'static str {
        icon.asset
            .strip_prefix(ASSET_PREFIX)
            .and_then(|s| s.strip_suffix(".svg"))
            .expect("asset path must have form files/<name>.svg")
    }

    fn dark(path: &str) -> &'static str {
        name(file_icon(path, Appearance::Dark))
    }

    #[test]
    fn whole_name_wins() {
        assert_eq!(dark("Dockerfile"), "docker-color", "Dockerfile");
        assert_eq!(dark("package.json"), "npm-color", "package.json, not json");
        assert_eq!(dark("pnpm-lock.yaml"), "pnpm-color", "not yaml");
        assert_eq!(dark(".gitignore"), "git-color", "a dotfile");
        assert_eq!(dark("CLAUDE.md"), "claude-color", "not markdown");
        assert_eq!(dark("vite.config.ts"), "vite-color", "not typescript");
        assert_eq!(dark("LICENSE"), "file-text-solid", "a suffix-table name");
        assert_eq!(dark("src/app/Dockerfile"), "docker-color", "a path");
    }

    #[test]
    fn dotted_suffixes_resolve_longest_first() {
        assert_eq!(
            dark("resources/views/home.blade.php"),
            "blade-conn",
            ".blade.php"
        );
        assert_eq!(dark("app/Models/User.php"), "php-conn", ".php");
        assert_eq!(
            dark("types.d.ts"),
            "lang-typescript-solid",
            ".d.ts falls to .ts"
        );
        assert_eq!(
            dark("button.test.tsx"),
            "lang-typescript-test-solid",
            ".test.tsx"
        );
        assert_eq!(
            dark("button.spec.ts"),
            "lang-typescript-test-solid",
            ".spec.ts"
        );
        assert_eq!(dark("view.tsx"), "react-color", ".tsx");
        assert_eq!(dark("notes.md"), "lang-markdown", ".md");
        assert_eq!(dark("data.json"), "braces", ".json");
        assert_eq!(dark("logo.png"), "image-solid", ".png");
        assert_eq!(dark(".env.local"), "file-text-solid", ".env.local");
    }

    #[test]
    fn the_stem_is_the_last_resort() {
        assert_eq!(
            dark("LICENSE.custom"),
            "file-text-solid",
            "LICENSE.custom by stem"
        );
        assert_eq!(
            dark("CHANGELOG.unknown"),
            "file-text-solid",
            "CHANGELOG.unknown by stem"
        );
        assert_eq!(
            dark("Dockerfile.dev"),
            "docker-color",
            "Dockerfile.dev by stem"
        );
    }

    #[test]
    fn unknown_names_get_the_default_file() {
        assert_eq!(dark("mystery.zzz"), "file-solid", "unknown extension");
        assert_eq!(dark("Makefile"), "file-solid", "no extension");
        assert_eq!(dark(".unknownrc"), "file-solid", "an unknown dotfile");
        assert_eq!(dark(""), "file-solid", "an empty name");
        assert_eq!(
            dark("README.MD"),
            "file-solid",
            "matching is case-sensitive, as in Zed"
        );
    }

    #[test]
    fn folders_are_solid_closed_and_open() {
        assert_eq!(name(folder_icon(false, Appearance::Dark)), "folder-solid");
        assert_eq!(
            name(folder_icon(true, Appearance::Dark)),
            "folder-open-solid"
        );
        assert_eq!(
            name(folder_icon(false, Appearance::Light)),
            "folder-solid-light"
        );
        assert_eq!(
            name(folder_icon(true, Appearance::Light)),
            "folder-open-solid-light"
        );
    }

    #[test]
    fn the_appearance_picks_the_dark_or_light_svg() {
        for path in [
            "a.php",
            "a.blade.php",
            "a.ts",
            "a.json",
            "Dockerfile",
            "a.zzz",
        ] {
            let dark = file_icon(path, Appearance::Dark).asset;
            let light = file_icon(path, Appearance::Light).asset;
            assert_ne!(dark, light, "{path} has two variants");
            assert_eq!(
                light,
                dark.replace(".svg", "-light.svg"),
                "{path}: the light file is the dark name plus -light"
            );
        }
    }

    #[test]
    fn php_and_blade_are_nicks_own_icons() {
        assert_eq!(dark("a.php"), "php-conn");
        assert_eq!(dark("a.phtml"), "php-conn");
        assert_eq!(dark("a.blade.php"), "blade-conn");
        assert_eq!(
            name(file_icon("a.blade.php", Appearance::Light)),
            "blade-conn-light"
        );
    }

    #[test]
    fn tables_are_sorted_for_binary_search() {
        for table in [STEMS, SUFFIXES] {
            assert!(
                table.windows(2).all(|w| w[0].0 < w[1].0),
                "sorted and unique"
            );
        }
        assert!(
            ICONS.windows(2).all(|w| w[0].0 < w[1].0),
            "icons sorted and unique"
        );
    }

    #[test]
    fn every_table_entry_names_a_real_icon() {
        for (key, kind) in STEMS.iter().chain(SUFFIXES) {
            assert!(pair(kind).is_some(), "{key} -> {kind} has no icon");
        }
    }

    /// Every asset the lookup can return is embedded, is a well-formed SVG, and is solid: one
    /// fill colour, no translucent layers, no opacity attributes.
    #[test]
    fn every_returnable_asset_exists_and_is_solid_svg() {
        let assets: BTreeSet<&str> = ICONS
            .iter()
            .flat_map(|(_, pair)| pair.iter().copied())
            .chain(FOLDER)
            .chain(FOLDER_OPEN)
            .collect();
        assert!(assets.len() > 100, "the full set is embedded");
        for asset in assets {
            let bytes = AppAssets
                .load(asset)
                .expect("asset load")
                .unwrap_or_else(|| panic!("{asset} is not embedded"));
            let text = std::str::from_utf8(&bytes).expect("utf-8 svg");
            assert!(text.trim_start().starts_with("<svg"), "{asset}: not an svg");
            // Pierre's Next.js mark fades its diagonal with a gradient stop; that is the source's.
            assert!(
                !text.replace("stop-opacity", "").contains("opacity"),
                "{asset}: translucent layer"
            );
            assert!(
                !text.contains("currentColor"),
                "{asset}: needs a tint, not own colours"
            );
        }
    }

    #[test]
    fn the_old_icon_sets_are_gone() {
        let assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons/files");
        for entry in std::fs::read_dir(assets).expect("assets dir") {
            let file = entry.expect("entry").file_name();
            let file = file.to_string_lossy();
            assert!(!file.starts_with("file-tree-builtin-"), "{file}");
            assert!(!file.starts_with("t3-file-icon-"), "{file}");
        }
    }

    /// Every SVG on disk is reachable from the lookup, so no orphan ships.
    #[test]
    fn no_asset_on_disk_is_orphaned() {
        let reachable: BTreeSet<&str> = ICONS
            .iter()
            .flat_map(|(_, pair)| pair.iter().copied())
            .chain(FOLDER)
            .chain(FOLDER_OPEN)
            .collect();
        let assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons/files");
        for entry in std::fs::read_dir(assets).expect("assets dir") {
            let file = entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned();
            if file.ends_with(".svg") {
                assert!(
                    reachable.contains(format!("files/{file}").as_str()),
                    "{file}"
                );
            }
        }
    }
}
