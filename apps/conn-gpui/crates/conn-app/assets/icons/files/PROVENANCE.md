# File-type icon provenance

Solid SVGs for the file-type and folder icons Conn shows in the Files tree, header file tabs, the
breadcrumb menu, and the code-card and attachment labels (`crates/conn-app/src/file_icons.rs`).

## Source

**Pierre Icons** for Zed, the "Complete" theme, dark and light
(<https://github.com/pierrecomputer/vscode-icons>, `zed/`; MIT, see `LICENSE.md`).

- The SVGs are copied unchanged from the design lab's `pierre-icons/` folder. Do not regenerate them.
- Solid only: every duo icon is a single-tone solid SVG, and brand icons have no translucent layers.
  The one exception is Pierre's own Next.js mark, which fades a diagonal with a gradient stop.
- Each icon has a dark file (`<name>.svg`) and a light file (`<name>-light.svg`). The app picks one
  by appearance.
- Only icons the lookup can return are shipped. A test fails if one is orphaned.
- The lookup tables (`src/file_icons/tables.rs`) come from the lab's `pierreIcons.ts`, which took them
  from `zed/icon_themes/pierre-icons-complete.json`. The lookup follows Zed's
  `FileIcons::get_icon`: whole name, dotted suffixes, stem, default.

## Nick's own icons

Pierre has no PHP or Blade icon. `php-conn*.svg` (an elephant, `#7B67FD`) and `blade-conn*.svg` (the
Laravel mark, `#FF585B`) are Nick's own SVGs (2026-11-25), bare and centred in the 16px box.

## Replaces

The earlier `@pierre/trees` `file-tree-builtin-*` and Conn `t3-file-icon-*` sets were removed. Nothing
else referenced them.
