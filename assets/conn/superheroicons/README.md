# Superheroicons

Conn's icon set: every icon in the web, desktop and mobile apps. Vendored from
github.com/nckrtl/superheroicons (`consumers/conn/final`, commit 1302cb2); fix
glyphs there, then copy `16/solid/`, `24/solid/` and `manifest.json` here again.

- `16/solid/<concept>.svg`: 16×16 glyphs, `fill="currentColor"`. Web and desktop draw these.
- `24/solid/<concept>.svg`: 24×24 glyphs. Mobile draws these for every icon; web uses five of
  them (the foldable postures in `DeviceDuoGlyph`).
- `manifest.json`: `lucide` maps each Lucide name Conn's web app imports to a concept; `sf` maps
  each SF Symbol name the mobile app uses to a concept; `chips` maps the mobile composer chip
  images to concepts.

After changing these files run `node scripts/generate-conn-icons.ts` (web) and
`node apps/mobile/scripts/sync-context-chip-icons.mjs` (mobile), and commit their output. The iPhone
app's symbols (`apps/ios/Conn/ConnSymbols.xcassets`, `ConnSymbolNames.swift`) are hand-owned: add a
glyph there as a `.symbolset` and list its SF name. License: `LICENSE` (MIT; Heroicons MIT, Lucide ISC).
