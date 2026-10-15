# Laravel Toolbar design preview

Live at `http://10.44.0.9:5799/toolbar-mockup.html` on mini (WireGuard).
This page imports the production `laravelToolbar/ui/ToolbarBar.tsx`, its panels,
context, store, T3 components and CSS from this checkout. There is no second toolbar UI.

## Working on it

- The checkout is `~/apps/conn`, branch `main`. Edit
  `apps/web/src/laravelToolbar/ui/` to change both the preview and the shipped toolbar.
  Vite updates the preview on save. Commit and push accepted changes to `origin/main`.
- `main.tsx` supplies browser chrome, a page screenshot and the theme. `source.ts` and
  `fixtures.ts` supply request payloads and a simulated Orbit source through the same
  `ToolbarProvider` used in the desktop browser. No T3 server or live database is needed.
- Requests have different recorded timings, memory, queries, models and responses.
  The PHP/PHP-FPM details, dependencies and Orbit processes are illustrative. The
  Dependencies live inside Orbit and load the saved instance inventory from the Gateway.
  An instance needs an Orbit dependency scan before live package data appears. Start, stop and
  restart only change this preview's in-memory process data. Reload resets the fixtures.
  Logs uses illustrative application log lines; live pages follow Orbit’s leased Reverb stream,
  with tail refresh when streaming is unavailable. Source paths are examples; this preview has no editor connection.
- `panel=` opens and pins requests, request, timings, memory, database, models, orbit
  or environment. Composer and the detected JavaScript package manager are tabs inside Orbit. `theme=light` and `theme=dark` select stock themes; no theme argument
  uses Nick's Dark Ocean theme. Check Dark Ocean and light after color changes.
- Nick can open the URL in T3's browser and annotate it. Use screenshots to verify changes.
  Keep temporary verification screenshots outside the repo.

## Running it

LaunchAgent `com.nckrtl.toolbar-mockup` runs Vite from this checkout's `apps/web`
using Node 24, bound to `10.44.0.9:5799`. It runs Node directly so it can access Data.
Log: `~/.local/share/toolbar-mockup/server.log`. If stopped:

```sh
launchctl kickstart -k gui/$(id -u)/com.nckrtl.toolbar-mockup
```

For a separate manual preview, from `apps/web`:

```sh
PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" \
node node_modules/vite-plus/bin/vp dev --host 10.44.0.9 --port 5798 --strictPort
```

Open `/toolbar-mockup.html` on that port. Do not start an app server against `~/.t3`.
The preview entry and images are imported only by this development HTML page; the
normal web/desktop entry does not load fixture data.

## Design rules

- Bar icons use Lucide, except for the Orbit, Laravel and PHP brand marks. Match the browser
  bar's `Button` `icon-xs` sizing: 14 px on desktop (`sm:size-3.5`), 16 px below `sm`
  (`size-4`). Keep Lucide's default stroke width.
- Two sizes: 12 px (`text-xs`) for text, 18 px (`text-lg`) for stat values.
  Medium weight for emphasis. Mono for code, paths, SQL, method and status; system
  font with tabular numbers for counts, durations and labels.
- Panels use `bg-background text-foreground`, the same canvas as the bar.
  Dark Ocean's `bg-popover` is the lighter small-menu surface.
- One panel at a time; hover opens, click pins. Panels are edge to edge, attached to
  the bar, with scrolling content and thin dividers. Drag the header to resize; the
  shared height persists across reloads and stays within the browser's page area.
  No cards or rounded corners. Stat blocks use labels without decorative icons.
- Underlined tabs inside panels; colored pills for status; thin vertical stage/process
  markers; stage colors come from the Laravel payload. Source links have faint underlines.
- Follow the fork's lint rules and shared component variants. Use duty-cycled status
  animations rather than continuously spinning icons.

The previous standalone mockup, frozen v1 and comparison screenshots remain archived
in `~/apps/t3code-design`, branch `laravel-toolbar-mockup`, private repo
`nckrtl/t3code-design`. That checkout is no longer the active preview source.
