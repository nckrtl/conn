# Conn features

The Conn-specific features of the legacy TypeScript apps (`apps/web`, `apps/desktop`,
`apps/mobile`, `apps/server`). They moved here unchanged from `FORK.md`, so the headings
that code and docs cite still match. These apps are legacy and will be removed once the
native clients reach parity; until then this file is part of their design reference. See
[FORK.md](../../../../FORK.md).

## What the fork changes

Paths below are relative to the repository root unless a source list gives
another base directory.

### Shell design

The shell follows ChatGPT's desktop window structure in the active theme's
colors: inset cards, two-tone dividers, glass popovers, toolbar groups, soft
fields, inset scrollbars and a 44px header. This covers chat, sidebar, Settings,
browser, Files, Diff, terminal, Agents and fork panels.

The macOS window is frosted glass. `DesktopWindow.ts` creates it with
`vibrancy: "under-window"`, `visualEffectState: "followWindow"` and a clear
`#00000000` background, and `syncWindowAppearance` keeps that clear background
when the appearance changes. The `html.electron-macos` block at the end of
`index.css` makes the page transparent and tints the frame (`--shell-fill`) and
inner cards (`--shell-inner-fill`) over the native material. The CSS alone shows
no glass; without the window options the frame is opaque.

The thread sidebar is an inset card, like the chat and right panels. In
`Sidebar.tsx`, `SidebarContent` sits inside a `div` with `shell-inner-panel`
(rounded on the left, `mb-(--shell-inset)`), and that card ends with
`<SidebarChromeFooter utilities={false} />`. The workspace rail holds the update
button and the settings, source control and usage actions, so the sidebar
footer must not show them again. Without the wrapper the sidebar loses its
darker card; with the default footer a second row of utility icons appears
under the thread list.

The sidebar header (`SidebarChromeHeader` in `SidebarChrome.tsx`) shows no
brand and no back and forward buttons. Upstream added those buttons in #27430;
Conn keeps the history shortcuts and trackpad swipes but drops the buttons,
which otherwise show beside the traffic lights behind the sidebar card.

Browser pages meet the address bar's bottom divider. Keep `PreviewChromeRow`'s
zero bottom margin. Do not add a Conn override for the inline-panel subheader
(`[data-surface-subheader]` under `[data-right-panel-surface-content]`): it
removes the space above the panel toolbar controls.

Settings and Usage are upstream's route modals (`_chat.settings.*`, `_chat.usage`
over the thread view through `mainAppLocation`). Conn keeps upstream's modal
behavior and draws the shell inside it: `AppRouteModal` is the frosted frame,
`AppRouteModalHeader` the transparent 44px header, `AppRouteModalCard` the inset
card, and `APP_ROUTE_MODAL_NAV_CLASS` the inset Settings nav beside the card.
On a conflict there, take upstream's routing and dismissal logic and keep these
four pieces. The modal floats over the app, not over the desktop: its frame uses
`--shell-modal-fill` (94%, which `html.electron-macos` does not thin like
`--shell-fill`), and its backdrop is `DialogBackdrop variant="app"`
(`app-modal-backdrop`: 80% `--background` and the glass blur), so a bright
browser page behind it neither tints the frame nor stays readable. Small dialogs
and the palette keep the lighter `dialog-backdrop`.

The terminal's actions float in a `ToolbarGroup` over its top right corner, and
the dark chat composer is a step lighter than the chat card (`--shell-composer`).

The [nckrtl-shell-design skill][shell] has the full rules.

Sources:

- Web (`apps/web/src/`): `index.css` (shell tokens at the end),
  `components/ui/*` variants, `components/ToolbarGroup.tsx`,
  `components/ThreadTerminalDrawer.tsx`, `components/chat/ComposerSurface.tsx`,
  `components/settings/*`, `components/AppRouteModal.tsx`,
  `routes/_chat.settings.tsx`, `components/ChatView.tsx`,
  `components/RightPanelTabs.tsx`, `components/Sidebar.tsx`,
  `components/sidebar/SidebarChrome.tsx`, `lib/windowControlsOverlay.ts`
  (`electron-macos`), `navigationHistory.ts` (no button hook), `routes/__root.tsx`, `pierre-tree-theme.ts`.
- Desktop traffic lights and window glass:
  `apps/desktop/src/window/DesktopWindow.ts`.
- Guards: `apps/desktop/src/window/DesktopWindow.test.ts` (window glass) and
  `apps/web/src/components/sidebar/connShellSidebar.test.ts` (sidebar card and
  footer).

### Icons

Every web and desktop icon is a Superheroicons 16px solid glyph. The set is
vendored in `assets/conn/superheroicons/` (`16/solid/*.svg`, `manifest.json`,
README there); fix glyphs in github.com/nckrtl/superheroicons and copy them in.
`manifest.json` maps each Lucide name Conn uses to a glyph.

`node scripts/generate-conn-icons.ts` writes `apps/web/src/icons/lucide-react.ts`:
one component per Lucide name, with Lucide's props (`size`, `color`, `className`;
stroke props are ignored) and the `lucide lucide-<name>` classes. The web
tsconfig and Vite's `resolve.alias` map `lucide-react` to it, so upstream imports
stay unchanged. A Lucide name missing from the manifest fails the typecheck until
the set maps it. Both mappings are needed: the dev server ignores tsconfig paths
for pre-bundled packages. Colour icons with `text-*`, not `stroke-*`; for a halo
use `stroke-background [paint-order:stroke]`.

Icons with no Lucide name use a glyph by concept id: `connIcon("<concept>",
<concept>Glyph)` from `src/icons/glyphs.generated.ts` (Mini PC and Workstation
machines, SnapShots, screen rotation). Glyphs drawn at 24px or more use
the set's 24px files, vendored one by one in `24/solid/` (the foldable postures
in `DeviceDuoGlyph`, size-7); everything else is 16px. Project and workspace icons (any Lucide
name a user picks) stay on `lucide-react/dynamic` and `lucide-react-original`.

Sources:

- `assets/conn/superheroicons/`, `scripts/generate-conn-icons.ts`.
- Web (`apps/web/`): `src/icons/` (`lucide-react.ts`, `connIcon.tsx`),
  `tsconfig.json` (`paths`), `vite.config.ts`, `components/sidebar/workspaceVisuals.tsx`.

### Mobile icons

Mobile draws the Superheroicons **24px** solid set (`assets/conn/superheroicons/24/solid/`;
web and desktop stay on 16px). The manifest's `sf` map names a glyph for each SF Symbol name
the app uses.

- iOS: a custom symbol per mapped name (`ConnSymbols.xcassets`, `ConnSymbolNames.swift`). These
  are hand-owned: `scripts/build-conn-symbols.ts` built them and is gone; add a `.symbolset` and
  its name by hand, in `apps/ios/Conn` too. `ConnSymbols.swift` swaps
  `UIImage`'s `systemImageNamed` methods so every caller gets them: `AppSymbol.tsx`
  (expo-symbols), tab bars and menus. Unmapped names stay SF Symbols.
- Native header buttons take template images instead (`assets/header-icons/`,
  `src/native/connHeaderIcons.generated.ts`), so they draw the glyph at 24pt; build header
  icons with `connHeaderIcon(name)` (react-navigation items) or `connScreensHeaderIcon(name)`
  (react-native-screens items). `V5StackHeader` converts SF names itself.
- Android: `src/components/ui/connGlyphs.generated.ts` (from the same, now removed script);
  `AppSymbol.android.tsx` draws it with react-native-svg (`ConnGlyph.tsx`).
- Composer chips: `apps/mobile/scripts/sync-context-chip-icons.mjs` renders the
  manifest's `chips` from the 24px set.

Run the scripts after changing the set and commit their output.

Sources:

- `assets/conn/superheroicons/`, `apps/ios/Conn/ConnSymbols.xcassets`.
- `apps/mobile/modules/conn-symbols/ios/`, `apps/mobile/src/components/ui/`
  (`AppSymbol.tsx`, `AppSymbol.android.tsx`, `ConnGlyph.tsx`), `apps/mobile/src/native/connHeaderIcon.ts`.

### Workspaces

A workspace rail sits beside the thread sidebar. Workspaces have their own
projects, icons and extra windows. New threads stay in the selected workspace.

The rail alone does not provide workspace isolation. `Sidebar.tsx` must publish
the available projects to `useWorkspaceStore`, intersect the project filter
with the active workspace, and reset row selection and the settled tail on a
workspace change. `WorkspaceDialog` reads that project registry. On mobile,
`HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` must pass
`selectedWorkspaceProjectRefs` into the thread list when no narrower project
is selected. Preserve these consumers when upstream moves the list or filter
UI. The November 8 sync audit, now in `FORK.md`'s git history, lists the restored consumers.

Upstream has one desktop window, so upstream code often assumes a single main
window. In the fork every window must behave the same. `DesktopWindow.ts`
registers each window with `PreviewManager.addWindow`, and the preview manager
accepts browser guests hosted by any of them. When code
reads a main window, make it work in workspace windows too, or the browser
panel and its tools break there.

Sources:

- Web: `apps/web/src/workspace*.ts`; under `apps/web/src/components/sidebar/`,
  `WorkspaceRail.tsx` and `WorkspaceDialog.tsx`.
- Desktop windows and IPC: `apps/desktop/src/`.

### Desktop control socket and links

The desktop control socket accepts `open-thread` and `select-workspace`.
Workspace links use `t3code://workspace/...` or `conn://workspace/...`. Rooms
tooling uses these entry points.

The socket also starts when the local environment is disabled, through
`DesktopApp.ts` bootstrap. Upstream starts it only after the local backend.

Sources:

- `apps/desktop/src/ipc/*`, `apps/desktop/src/app/DesktopApp.ts`,
  `packages/contracts/src/desktopAppActivation.ts`.

### Orbit

Orbit in Conn means container Instances: Conn pairs with the servers the Gateway lists, shows
them, and starts threads in a Project's Instance container. Conn no longer makes worktree-based
Instances. Old ones and their threads are settled in Orbit; Conn keeps showing such a thread as a
plain worktree thread and never removes it.

Orbit's configuration lives in the Orbit panel, not in Settings, so Settings stays close to
upstream. Settings › Environments (`ConnectionsSettings.tsx`) keeps only the fork's
"Environments from" row (`EnvironmentProviderSection`); in Orbit mode it hides the
Environments list and keeps the per-environment Linked environments, Load balancing and
GitHub routing sections. Reading linked
environments needs `access:read` on that server; answering a link card needs
`access:write`.

The Gateway requests T3's administrative scopes for device pairing links (Orbit
commit `d17002d`). If a saved Orbit server's session lacks `access:write`, Conn
pairs it again at most once every 6 hours. The shared `lacksAccess` and
`accessPairedAt` logic is wired into the web and mobile Orbit providers.

The environment sync lists every server on the Gateway but pairs only host servers (no
`instance_id`) by itself. A clone, an Instance's server, pairs only when a thread starts in it on
this device (a new Instance or an existing one). Without this every device paired with every new
clone within minutes. The desktop has no manual Connect; the phone's Connect button is retried by
the sync, with the usual back-off, until the app restarts. Pairings made before this rule stay;
nothing revokes them. `planEnvironmentProvider` takes the phone's requested ids; web and mobile
share one pairing step (`pairOne`), and a second call for a server joins the one in flight.

A saved Instance server that two successful, non-empty Gateway lists in a row leave out, at
least `GONE_CONFIRM_MS` (2 min) apart, is removed from the device (`plan.remove`): its Instance is gone, and Orbit may give its address to a
new Instance. Web removes it as the Orbit panel removes an Instance (catalog, pairing records,
Orbit facts, thread starts); mobile removes the catalog entry and the pairing records. A server
counts as an Instance's when a list showed it with an `instance_id` (`instanceServers`, also the
web's remembered clone ids). Two lists and a minimum time, because only an explicit Connect pairs a
removed clone again, and a profile edit runs a second sync within seconds. A failed read or an
empty list removes nothing; host servers only switch off; a clone a thread start holds stays.
Losing access to a Node, or another Gateway, removes its clones the same way.

An old worktree-based Instance's checkout sits beside the Project's `default` checkout
(`<apps>/<project>/t3code-<8 hex>`, older ones `t3-<8 hex>`). `isOrbitCheckout`
(`apps/web/src/orbit/orbitCheckout.ts`) recognizes that path, so deleting such a thread never
offers to remove the worktree; Orbit owns it. Folders under `<T3 home>/worktrees/<repo>/` or a
`.t3` folder are T3's own and never match; an Orbit apps path named `worktrees` or inside `.t3`
would be missed.

In the desktop app in Orbit mode, New thread starts threads in Orbit Projects; there is no other
switch and no other entry (Orbit's `docs/cli/instance/container/thread.mmd`). Outside Orbit mode,
and in the web app, the palette and composer are unchanged.

**Project rows.** The New thread palette lists the Projects of `GET /api/v1/conn/projects` after
the local projects, asked with `include_unavailable=1` (Orbit lists only startable Projects without
it; the phone does not ask). Each row shows the number of the Project's Instances in the Gateway's
environment list (the default never counts), and the clone rows of those Projects leave the list.
While the list loads or after it fails, only local projects show, then skeleton rows or a notice
with Retry. A Project that is also a normal Conn project shows as two rows. A Project in which
threads cannot start yet (`cloneable: false`) stays selectable, greyed out with its failing check's
message. The parser tolerates missing `cloneable`, `cloneable_reason`, `checks` and
`instance_domain_suffix`; a row without `cloneable` can start threads.

**Checks page.** A greyed row opens its start checks (`CommandPaletteOrbitChecksPage.tsx`): Orbit's
five checks in order with Conn's own labels, one more row for any other failing check (Orbit's
`label`), and "Check again", which re-reads the list and keeps the last result when the Gateway
does not answer. Only the latest check's answer counts. Once threads can start there, it offers the
Instance step.

**Instance step.** A startable row opens the Instance step (`CommandPaletteOrbitInstanceStep.tsx`,
`orbitInstanceStepLogic.ts`): a name field with the Project's domain suffix, checked live with
`GET /api/v1/conn/projects/{id}/instances/check?name=` after the local name rule passes. Reason
`domain_invalid` (the address `<name>.<project domain>` breaks Orbit's limits; Conn hard-codes no
length) reads "This name makes the address too long. Use a shorter name." A failed
or slow check keeps create possible (Orbit's `instance.name_taken` at create is the guard); 409
`instance.default_missing` blocks it. A search that finds no Instance fills the field with the
search text as a slug, unless the user typed a name. "Existing instances" lists every Instance of
the Project in the Gateway's environment list (no owner filter, never the default); stopped and
expired ones are disabled. A paired one opens a normal draft in its `/srv/workspace` project, an
unpaired one an Orbit draft. The desktop IPC lets only these queries through (with the branch
search below).

**Orbit draft.** The composer draft carries an Orbit target (`orbitDraft.ts`, `openOrbitDraft`):
the Project, Node, and a new Instance with the typed name or an existing one this device has not
paired. An Orbit Project is no T3 project, so the draft uses a placeholder project id and is
anchored on a paired clone of the same Project, else the primary environment, for its model list.
The context row shows the Node and `<instance> · <project>`, which reopens the Instance step;
attachments are off. Send saves a start (typed name, model and modes) for the runner instead of
sending through a T3 server, opens its pending thread, then clears the draft. This is not the
older worktree env mode `"orbit"`.

**Branch control** (`orbitBranchControl.ts`). A new Instance's context row shows "From <default>" (no choice: the create
sends no `branch`); the draft reads the name once per Project per session and shows "From default
branch" until it is known or when the read fails, never a guessed `main`; and a menu from `GET /api/v1/conn/projects/{id}/branches?query=` (25 s limit)
with two modes, "New branch from" and "Work on branch". Under "Work on branch" the default branch
is disabled, and a branch another Instance works on selects that Instance instead; for a paired
Instance a typed prompt moves into its draft with attachments, modes and a picked model. Admission
refusals (`branch.in_use`, `branch.not_found`, `branch.exists`, `instance.placement_conflict`,
`source.head_unavailable`) made no Instance and offer Change branch or Change name; the create
step codes keep Retry only. Retry resends the same choice. The ready card shows Branch and Base,
and says dependencies come from the default branch when the code is not that branch.

**Pending thread and setup card.** The pending thread at `/orbit/$startId`
(`OrbitPendingThreadView.tsx`) shows the message and a setup card built on the client from the
saved start and the runner's reads of the create Operation (`orbitSetupView.ts`), since the clone's
server does not exist yet. The worktree setup contract is untouched. A pending start also shows as
a sidebar row (`OrbitPendingThreadList.tsx`) and survives a reload. While "Create Instance" runs it
shows five rows of Orbit's create steps (`orbitCreateRows.ts`: Orbit's step `group` when sent, else
the step name; an unknown step stays with the row that ran). Orbit fills step times only once the
Operation ended, so each row is timed from when the runner first saw it change, saved in the
start's `createRows`, and Orbit's times replace those at the end. The running card has Details and
Cancel; Cancel asks Orbit to cancel an admitted create (`POST /operations/{id}/cancel`), then
drops the start; an admitted Instance stays. A Cancel after the create was sent but before Orbit
answered, in any window, marks the start (`cancelRequested`, hidden from the sidebar); the main
window's runner repeats the admission under the same key, cancels the Operation and drops the
start, or keeps it as failed when the cancel fails. A start with no create sent is dropped at once.

**Runner.** `OrbitThreadStartRunner`, mounted once in the main window's root route, runs every
saved start (`orbitThreadStarts.ts` on the shared `runOrbitThreadStart`): Orbit creates a clone of
the Project's default Instance (or the start uses the picked one), Conn pairs with the clone's T3
server once, and sends the first message in its `/srv/workspace` project (`sendOrbitFirstMessage`).
Each start is saved in localStorage after every step, with a fixed launch command id, so a reload
resumes it and a repeated launch finishes the first one. The Gateway admits a create or a pairing
only after it copies secrets to Swamp (19-27 s), so those two calls get a 60 s limit instead of
the desktop's 15 s default, and carry a saved `Idempotency-Key`. A lost answer (none, or a proxy's
502 or 504 without the Gateway's error envelope) repeats the same request with a clamped back-off,
so the Gateway returns the Operation it may already have admitted. A create refused with 409
`operation.target_busy` (another Operation owns the Instance) repeats the same way until the
create's deadline, then stops with "press Retry in a minute"; the pairing admission takes no
target lock, so it cannot be busy. Any other Gateway error stops the start. The environment sync
skips a clone a start is pairing with (`heldOrbitInstanceIds`), and an asleep one. Away from the
pending thread, a toast reports the result. Starts saved by the removed sidebar dialog load as
pending threads, so they resume or can be dismissed; one whose send finished is dropped.

**Pre-warm (reservations).** While the prompt box of a new Instance shows (the desktop draft in
the main window, the phone's Orbit project screen), Conn reserves a clone of the Project
(`POST /conn/projects/{id}/reservations`, `reservations.ts`), polls it every 2 s while it
prepares, and installs a one-time link as soon as a ready GET delivers it. With no link it
uses the existing pairing endpoints. The link is used in memory before any further read. Conn reads
the reservation every 60 s once ready to keep it held. A send during that read or install lets
it finish before reading the reservation again. The runner finalizes it
(`POST /conn/reservations/{id}/finalize` with the name and branch), follows that Operation with
the same create rows, and skips pairing if the device already saved the server. Conn waits up
to two minutes for readiness. If the wait expires, the reservation is gone or failed, or the
finalize fails, Conn releases it and starts an ordinary create with a fresh deadline. An
abandoned reservation stays hidden until its pairing install settles and Conn removes the
connection and credential it installed. The catalog stores the install identity with each
record. Cleanup matches that identity, resumes after a restart, and leaves independently
saved routes visible. Finalize clears the provisional identity and keeps the connection.
Closing the prompt releases it (`DELETE`, the desktop's only allowed DELETE). A restart
releases what the last run held. At most 3 are held: a fourth Project releases the oldest. Reserved clones (Gateway rows with `reservation_id`, and the ones a start finalizes)
stay out of every list: the lists read `visibleCatalogValueAtom`, and the Gateway-fed lists drop
reserved rows. Nothing about it shows on screen.

**Workspaces.** A start saves the workspace selected at Start (null for all). Once the first
message is sent, that workspace gets the clone's `<environmentId>:<projectId>` ref unless it
already lists the project or no longer exists, so the sidebar shows the thread (a clone is a new
environment). The profile sync then drops the refs of clones that are gone
(`cloneWorkspaceRefs.ts`). A gone record no longer says it was a clone, so each device remembers
the clone ids it saw in the Gateway list (with an `instance_id`), and drops only refs of those ids
that a later fresh, non-empty list in Orbit mode leaves out. A clone gone before any list showed it
keeps its ref. Host and manual environments' refs are never touched.

**Handover.** Once the clone's server took the first message and the thread reached the window,
the pending route is replaced by the real thread. The start stays saved after the send (the newest
50), so the real thread finds it by thread id and Conn draws "Instance ready", its Details and the
ready line itself; none of it goes to the agent. If the clone lacks the composer's provider, the
first turn uses the clone's default and the ready area says so.

**Failures.** A failed start offers Retry (from the last saved step), Change name (for refusals
that made no Instance, such as `instance.name_taken` and `route.domain_invalid`; reopens the draft with the message and model, then the Instance step) and
Dismiss, which drops only the saved start on this device; it removes no Instance (the Orbit
panel's Instances page does). A create that failed with `instance.container_process_inactive` (a Project process
did not stay up, named by `result.process_failure.unit`) offers Retry on the desktop and the phone
only when the Operation's `result.recovery.requires` is `project_process_definition`: Orbit then
retries with the Project's current process definitions, and the card says to change or remove the
process first. Without it (older Gateways) the kept Instance keeps the broken process, so the card
offers no Retry and says to remove the Instance and create it again.

Still waiting for Orbit: the Node menu ("Run on") and
starting a stopped Instance (stopped Instances stay disabled).

The phone starts the same thread from Choose project › Orbit project in Orbit mode. Its Instance
name comes from the message (`orbitThreadInstanceName`, saved with `nameSuffix`); before each new
create the runner checks it and, while Orbit answers `domain_invalid`, tries the slug cut to 24,
then 12, then `thread`, keeping the suffix. When none fits, or a check fails after such an answer,
the start stops with `route.domain_invalid` instead of creating. It runs the
shared state machine and first-message launch (`threadStart.ts`, `threadTurn.ts`); the starts
live in `orbit-thread-starts.json` in the app's documents folder. The file write is async, so
each Gateway call, the pairing and the send first wait for it; a failed write stops the start. Start rows with the stage, Retry and Dismiss sit above the
thread list. The thread opens once sent if the screen the start returned to still shows. The phone's workspaces are the
profile's, so a sent start adds the clone's ref to the workspace selected at Start in the
profile itself (one re-read on a version conflict).

On a clone thread the Laravel toolbar's Orbit tool calls the Gateway from the desktop main
process, with writes limited to the clone's own Instance; see [Laravel Toolbar](#laravel-toolbar).

The thread panel's machine row becomes the Orbit row for a server in an Orbit Instance:
Project, Instance and Node, and the URL as a link (`ThreadDetailsOrbitRows.tsx`). Clones run
the stock T3 server, so the Gateway's environment record is their source: in Orbit mode each
clone record of `GET /api/v1/conn/environments` carries `project_id`, `project_name`,
`project_slug`, `instance_name`, `node_name` and `instance_url` next to `instance_id`
(`orbitInstanceFromEnvironment`; both ids or no facts, missing or mistyped fields read as
null). The desktop keeps the last list's facts in localStorage, so the row shows right after
start (`useOrbitInstance`). The same URL is where the thread's API panel starts
(`useOrbitInstance(...)?.url` in `ChatView.tsx`). The phone has no thread details panel like the desktop's, so it shows none of this; its
thread lists keep the environment label.

The fallback, for a fork server outside Orbit mode: the server reads `/etc/orbit/instance` at
start (`apps/server/src/orbit/OrbitInstanceFile.ts`). Orbit writes it: `KEY=value` lines, `#`
comments, unquoted values. Conn reads `ORBIT_PROJECT_ID`, `ORBIT_INSTANCE_ID`,
`ORBIT_PROJECT` (slug), `ORBIT_PROJECT_NAME`, `ORBIT_INSTANCE`, `ORBIT_NODE` and `ORBIT_URL`,
and ignores other keys. With both ids as positive integers, the environment descriptor gets
`orbitInstance` with the facts; otherwise it has none, and a missing or unreadable file never
stops the server. Old clones without `ORBIT_PROJECT_ID` have no descriptor. The sidebar title of the clone's
`/srv/workspace` project comes from Orbit, which adds it with `t3 project add --title`.

The Orbit panel is a modal like Settings, with its own nav: Instances, Connection and Profile
(the profile this device follows). Instances lists every Instance this device can reach, by Orbit Project,
never a default: today from the Gateway's environments named from its Projects, later from Orbit's
flat `GET /conn/instances`. Only `listOrbitInstances` in `client-runtime/src/orbitGateway/instanceList.ts`
reads the source; grouping, search, the Project filter and the join with local threads beside it
are pure, so mobile reuses them. "New thread in this Instance" does what the palette's Instance
step does (`openOrbitInstanceById`). The bin button removes an Instance through
`POST /conn/instances/{id}/destroy` (`removeOrbitInstance`, one `Idempotency-Key` per attempt) and
follows its `instance.destroy` Operation; any 404 counts as already removed. The list carries no
Git state yet, so the first request goes without `acknowledge_unsaved`, and Orbit's 409
`instance.unsaved_work` (always `state: "unknown"` for now) makes the dialog ask for the tick. Every
other refusal (a default or checkout Instance, a busy one, …) stays on the row with Orbit's message
and Retry. After a remove, `cleanUpRemovedOrbitInstance` drops the saved starts, pairings, servers
and their threads. The phone has no remove yet. Conn picks up the Orbit connection from the
machine (tunnel, root CA and Node are set up outside Conn), so Connection has no Gateway address
field and no set-up flow. It shows this device's Node name and WireGuard address with Reload,
three checks read from one `me` call (Gateway reachable, certificate trusted, device known), the
Nodes that run a T3 server (host servers only; Instance servers never show here) and a link back
to "Environments from". The desktop transport passes Chromium's `net::ERR_*` text on, which is how
a TLS failure is told from a connection failure; `orbitConnectionChecks` and `orbitNodeServers`
(`packages/client-runtime/src/orbitGateway/orbitConnection.ts`) map them for web and, later,
mobile. A check after a failed one shows "Not checked". An Orbit icon above Settings in the
workspace rail opens the panel on Instances; it shows only in
the desktop app with "Environments from" set to Orbit, and the panel closes when that changes.
A profile sync that drops the selected workspace leaves the panel open, as it does Settings
(`isAppModalPage`). Settings search has no entries for the panel's sections.

Sources:

- `apps/web/src/orbit/*`.
- Orbit panel: `apps/web/src/components/OrbitPanel.tsx`, `OrbitInstancesPage.tsx`,
  `orbit/orbitPanelPages.ts`, `orbit/orbitInstanceList.ts`,
  `routes/_chat._orbitPanel*.tsx`, the rail button in `components/sidebar/WorkspaceRail.tsx`,
  `components/sidebar/mainAppLocation.ts` (`isAppModalPage`).
- Settings files the fork touches for Orbit: `components/settings/OrbitSettings.tsx` (the
  panel pages and `EnvironmentProviderSection`), `components/settings/ConnectionsSettings.tsx`
  (the "Environments from" row only), `components/settings/settingsSearch.ts`
  (`environment-provider`).
- `packages/client-runtime/src/orbitGateway/environmentProvider.ts`.
- `packages/client-runtime/src/orbitGateway/threadStart.ts` and `threadTurn.ts`.
- Mobile (`apps/mobile/src/features/orbit/`): `orbitThreadStart*.ts`, `orbitThreadStarts.ts`,
  `orbitWorkspaceRef.ts`, `OrbitThreadStartScreen.tsx`, `OrbitThreadStartRows.tsx`.

### Orbit profile sync

The desktop app saves workspaces in the device's Orbit profile on the Gateway
(`/api/v1/conn`), so phones and other desktops share them. Edits merge on a
version conflict. Manual environments still work.

The profile also carries:

- Appearance: light and dark theme slots, full palettes for custom and published
  themes, mode, contrast and the custom theme library.
- Settings per device type. `devices.desktop` holds fonts, sizes, chat width,
  glass, motion, diffs and timestamps.

Conn writes each section with `PATCH /profiles/{id}/settings`. Version conflicts
merge per key or theme. A profile is one set of settings: every part always syncs, and
nothing can be switched off, forced or restored per device. The first sync with a profile,
also after a switch in the Orbit panel › Profile, adopts the profile or seeds an empty one,
with no confirmation; a switch first sends this device's unsent edits to the profile it
leaves (`switchOrbitProfile`). "New profile…" in the profile menu makes a profile from
this device.

An environment's `t3 theme set` is not a user choice and never syncs.
`orbit/themeOrigin.ts` wraps both calls in `useDefaultTheme.ts`. Themes a device
lacks are installed in the "From profile" collection until replaced by the live
published theme. On an older Gateway without sections, workspace sync still
works and Conn shows "Gateway doesn't support profile sync yet".

Keep `patches/@alchemy.run__drizzle@2.0.0-beta.85.patch` in
`patchedDependencies` while the catalog pins that version. drizzle-kit fails
on an absolute `out`.

The phone adds Settings › Orbit with a profile picker and one-tap pairing for
the Gateway's T3 servers. The thread list has a Workspace filter.

Sources:

- Shared (`packages/client-runtime/src/orbitGateway/`): `profileSync.ts`
  (engine), `sectionMerge.ts`, `profileDocument.ts` and supporting files.
- Web (`apps/web/src/orbit/`): `OrbitProfileSync.tsx`,
  `OrbitAppearanceSync.tsx`, `appearanceProfileSync.ts`,
  `deviceSettingsSync.ts`, `profileSync*.ts`, `themeOrigin.ts`,
  `workspaceProfileSync.ts`.
- Web (`apps/web/src/`): `components/OrbitProfilePage.tsx` (the Orbit panel's Profile
  page; its logic is `orbitGateway/profilePage.ts`), `hooks/useDefaultTheme.ts` (two
  wrapped calls).
- Gateway PATCH IPC: `apps/desktop/src/ipc/methods/orbitGateway.ts`,
  `packages/contracts/src/ipc.ts` (`orbitGatewaySend`).
- Mobile (`apps/mobile/src/`): `features/orbit/*`,
  `features/home/home-list-filter-menu.ts`, `features/home/HomeHeader*.tsx`,
  `features/home/HomeScreen.tsx`,
  `features/threads/ThreadNavigationSidebar.tsx`.

### Laravel Toolbar

A Laravel debug bar sits under the browser page. It shows requests, timings,
queries, models, PHP, Orbit processes and logs, and dependencies. Its flyout is
a floating sheet portaled to `body`. Apps using php-data-bridge's Symfony
adapter show Symfony's icon, version and environment. Pages with a
Content-Security-Policy get no inline toolbar data; the desktop main process
reads the `x-toolbar` response headers instead.

Preserve the whole browser integration, including its mount points:

1. `preview-pick-preload.ts` imports `LaravelToolbarPreload.ts`. The preload
   reads page data and update events, or the header payload supplied by
   `ResponseHeaderRelay.ts`, and sends `laravel-toolbar` messages to its host.
   The preview manager must install the response listener and attach each guest.
2. `HostedBrowserWebview.tsx` passes those guest messages to
   `relayLaravelToolbarMessage` with the environment-scoped runtime tab ID.
   The relay writes `useLaravelToolbarStore`; a `none` message clears that tab.
3. `components/preview/PreviewView.tsx` renders `BrowserLaravelToolbar` below
   the page area, with the same `runtimeTabId`, `threadRef` and page URL. Mount
   it only for an existing, nonempty tab without a load failure. The component
   renders nothing until data arrives. Keep it outside the page area so its
   height does not cover the page.

Numbers use the toolbar's own format, not the bridge's text. `formatMs` in
`laravelToolbar/model.ts` shows a space before the unit and steps up from
`ms` to `s` to `min` (`245 ms`, `30.2 s`, `2 min 5 s`); `formatCount` groups
thousands. Request rows reformat the bridge's duration (`30168ms`) through
`parseDuration` and sort on `RequestSummary.durationMs`. `model.test.ts`
covers both.

The Orbit tool reaches the Gateway in one of two ways (`BrowserLaravelToolbar.tsx`,
`orbit/desktopOrbitTransport.ts`). For a thread whose environment is an Orbit Instance
(`useOrbitInstance` gives an instance id) the desktop main process sends the calls
(`orbitToolSend`, `apps/desktop/src/ipc/methods/orbitTool.ts`): in a container `curl` goes through
the Node's proxy, which refuses `.orbit` names, and the tool would hide. Other threads, and the
web build, keep the hidden terminal on the thread's server. The page's domain still decides which
Instance the tool shows. The main process sends only these calls, with integer ids, the listed
query keys and no others, and the same `..` and encoded-slash checks as the Conn layer:

- GET `/api/v1/instances/resolve` (`domain`), GET `/api/v1/nodes`, GET `/api/v1/realtime`.
- GET `/api/v1/processes` (`target_type=instance`, `target_id`), GET
  `/api/v1/processes/{id}/logs` (`lines`), POST `/api/v1/processes/{id}/start|stop|restart`.
- GET `/api/v1/instances/{id}/dependencies`, GET `/api/v1/instances/{id}/logs` (`lines`).
- POST `/api/v1/instances/{id}/log-streams`, PUT and DELETE
  `/api/v1/instances/{id}/log-streams/{stream}`.

Reads follow the page. Writes (process actions and log streams) go only to the thread's own
Instance: the main process reads `instance_id` of the request's environment from
`GET /api/v1/conn/environments` (10 s cache) and, for a process action, checks that the Process
is in that Instance's process list. Without an Instance, or for another Instance, it refuses
before the write. The application log's realtime WebSocket opens in the renderer, as before.

The Orbit tool's process status falls back to the Gateway's `status` when
`runtime_status` is `unknown` or missing, as for container Instances. Without a
usable answer it shows `unknown`, never `crashed`, and keeps the process's
actions and log follow. The Processes log pane reads a one-time tail (the
Gateway can take 8 s or more for container Processes) and must always end in a
tail, an empty message, or an error with Retry. A non-followed read is not
repeated, so never swallow its failure.

`ApiPanel.tsx` has a separate toolbar mount. Keeping that mount, the toolbar
directory, or the preload is not enough to preserve the browser toolbar. The
November 7 sync removed the browser mount and the guest attachment in
`Manager.prepareWebview`, while still typechecking. Preserve both the
response-header and dictation attachments, in-page navigation notification,
and guest cleanup when porting selected upstream preview-manager fixes.

Run `PreviewView.browser.test.tsx` as well as the toolbar relay and store tests.
The browser test sends a page payload through the relay, checks that the
Requests control and request details appear, then clears them with `none`.
For an integrated desktop check, open a bridge-enabled Laravel page, inspect
a request, navigate to a non-Laravel page, and check that another tab's data
does not appear. Include a CSP page so the response-header path is exercised.

The native display of server-owned tabs uses the same guest attachment. A
working PHP bridge or API-panel toolbar alone does not prove this path works.
`Manager.test.ts` covers header delivery through the guest preload handler;
`PreviewView.browser.test.tsx` covers the relay-to-toolbar consumer.

Sources:

- `apps/web/src/laravelToolbar/*`.
- `apps/web/src/components/preview/PreviewView.tsx` and
  `PreviewView.browser.test.tsx` in the same directory.
- `apps/web/src/browser/HostedBrowserWebview.tsx`,
  `apps/web/src/api/ApiPanel.tsx`.
- `apps/desktop/src/preview-pick-preload.ts`.
- `apps/web/src/orbit/desktopOrbitTransport.ts`, `apps/desktop/src/ipc/methods/orbitTool.ts`.
- Desktop (`apps/desktop/src/preview/`): `LaravelToolbarPreload.ts`,
  `ResponseHeaderRelay.ts`.
- `packages/shared/src/laravelToolbarHeaders.ts`.

### API panel

The API right panel saves requests per project, with headers, body, response and
a Laravel Toolbar for each request. The desktop main process sends requests
through `apiSend` IPC. This avoids CORS and needs no server change.

Sources:

- Web (`apps/web/src/`): `api/*`, `laravelToolbar/headers.ts`,
  `rightPanelStore.ts`, `components/RightPanelTabs.tsx`,
  `components/ChatView.tsx`.
- `apps/desktop/src/ipc/methods/apiRequest.ts`.
- `packages/contracts/src/ipc.ts` (`apiSend`).

### Database panel

The Database right panel shows the project's database from its `.env`, saved
connections, tables and columns, and a read-only SQL editor. Laravel Toolbar
queries open there through "Open in Database".

The desktop main process connects through `databaseRun` IPC using `mysql2`,
`postgres` or `node:sqlite`. It keeps one connection per database for 5 idle
minutes, so a query costs one round trip. Only reading statements run. MySQL
sessions are read-only. PostgreSQL calls use a pipelined read-only transaction
that is rolled back.

Vault Mac app databases appear under Vault in the connection menu, grouped as
Personal, then by organization. Conn starts Vault's signed relay with
`Vault --conn-bridge`; it accepts only Conn by code signature. Listings contain
no password. Calls fetch credentials and TLS mode from the unlocked Vault. Only
a user action lets a locked Vault ask for Touch ID.

An entry with an SSH host uses this Mac's `ssh`, so `~/.ssh/config` aliases and
`known_hosts` apply. Conn uses Vault's SSH agent, stores no key and closes the
tunnel with the connection. Refresh closes open connections so changed Vault
entries are read again.

When the dev launcher builds its Electron runtime, it signs the binary with the
team's Developer ID as `com.nckrtl.conn.dev`. This lets dev builds use Vault.
Set `CONN_DEV_SIGNING_IDENTITY=-` to keep it ad-hoc.

Sources:

- Web (`apps/web/src/`): `database/*`, `laravelToolbar/model.ts`
  (`inlineBindings`), `laravelToolbar/context.tsx` (`openQuery`),
  `rightPanelStore.ts`, `components/RightPanelTabs.tsx`,
  `components/ChatView.tsx`.
- Desktop (`apps/desktop/src/ipc/methods/`): `database.ts`, `vault.ts`,
  `sshTunnel.ts`.
- `packages/contracts/src/ipc.ts` (`databaseRun`, `vaultDatabases`).
- `apps/desktop/scripts/electron-launcher.mjs`.

### MCP panel

The MCP right panel works like MCP Inspector. It saves servers per project:
stdio commands, Streamable HTTP or SSE URLs. New entries default to the app URL
plus `/mcp`; servers from a project's `.mcp.json` can be added.

The panel offers tools with forms from their input schemas, resources and
templates, prompts, server info, and a JSON-RPC log with stderr. A selected
tool, resource or prompt opens on Overview (description and inputs, so long
descriptions fit) or Playground (inputs beside their labels, the run button on
top, the result below). Results render Markdown and highlight JSON; copy and
raw/formatted actions float over the result, like the terminal's. The desktop
main process holds sessions through `@modelcontextprotocol/client`, using
`mcpConnect`, `mcpRequest` and `mcpDisconnect` IPC with `mcp-event` pushes.
Stdio servers run on this machine with the login shell's PATH.

Sources:

- Web (`apps/web/src/`): `mcp/*`, `api/ApiRequestEditor.tsx` (`HeaderRows`),
  `rightPanelStore.ts`, `components/RightPanelTabs.tsx`,
  `components/ChatView.tsx`.
- `apps/desktop/src/ipc/methods/mcp.ts`.
- `packages/contracts/src/ipc.ts` (`mcpConnect`).

### Browser and device annotations

Browser and Device panel annotations are Conn-native. The Conn server stores
them per project as plain files under `<stateDir>/annotations/<projectId>`. A
thread works through its project's queue. Tap the annotation icon in the
browser toolbar to load the overlay and start annotating; no annotator server
runs. The overlay is ported from `@nckrtl/annotator` into
`packages/annotation-overlay`. Desktop tabs reach the queue through a guest
preload and the hosting renderer; server tabs through a Playwright binding.
Agents use the `annotations_list`, `annotations_claim`,
`annotations_complete` and `annotations_release` MCP tools. Send and Watch
prompt the thread with those tools.

The queue needs visible entry points as well as its store and overlay bridge.
`PreviewView.tsx` passes `BrowserAnnotationControl` to
`PreviewChromeRow.annotationAction`. `DeviceWorkspace.tsx` connects the
annotation target and queue to `DeviceStreamView` and places
`AnnotationQueuePopover` in `DeviceControlsRail`. Upstream's element picker
and dictation UI do not replace Conn's persistent annotation queue. These
entry points were lost in the November 7 sync and later restored.

Drift dictation starts from the overlay. On desktop tabs the overlay asks the
guest preload (`window.__ANNOTATOR_HOST__`), and the main process POSTs the
dictation URLs the renderer registered for the tab, so the page never gets
them and its CSP cannot block them. Server tabs POST from the page.

On desktop tabs each box is an Operator caller session named by its draft ID
(`/dictate/start`, `/dictate/stop`, `/dictate/wait` and `/dictate/cancel` with
`{"session"}`). Operator shows the recording, so the box shows no recorder or
timer. Right after the start the box sends `/dictate/wait`, which answers
when the session ends without stopping it: Operator's shortcut, or the next
box's start. Then, or on Enter, the send button or a click on the next
element, the box closes, and its stop's text fills and saves it; empty text
discards it. An Operator without `/dictate/wait` (before 2026-10-28) answers
404, and the box then waits for Enter or a click. An Operator without sessions
records and pastes as before.

Sources:

- Server (`apps/server/src/`): `annotations/AnnotationStore.ts`,
  `mcp/toolkits/annotations/*`, `preview/ServerBrowser.ts`, `ws.ts`.
- `packages/contracts/src/annotations.ts`,
  `packages/shared/src/annotationBridge.ts`, `packages/annotation-overlay`.
- Desktop (`apps/desktop/src/preview/`): `ConnAnnotationsPreload.ts`,
  `AnnotatorHostPreload.ts`, `AnnotatorDictation.ts`.
- Web (`apps/web/src/`): `annotations/*`, `components/device/*`,
  `browser/HostedBrowserWebview.tsx`.

### Desktop tab automation

Agents on trusted environments can drive their thread's open desktop browser
tabs, including tabs the environment did not launch. Tabs register automatically
with no consent step. Stopping the thread or closing a tab ends its automation
session and closes its endpoints.

All preview tools work except recording. Hidden tabs use Electron's native
screenshots. `preview_cdp_endpoint` gives scripts on the tab's host a temporary
loopback endpoint for `chromium.connectOverCDP`. Each endpoint accepts one
connection.

Personal Vault logins remain private, as described under
[Password-manager autofill](#password-manager-autofill). Agents only get Conn's
test logins.

This also holds when the server runs on another machine (Beast, mini, nick-vm).
Only `preview_cdp_endpoint` stays on the tab's host, because it listens on
loopback. Upstream does not have the relay, and its agent copy says desktop
tabs cannot be reached from another machine. On 2026-10-28, a sync brought in
such a `conn_preview_list` description (upstream #24850), and agents on Beast
refused to drive Nick's tabs. Keep or rewrite any line in the preview tool
descriptions and agent instructions that limits agents to server tabs. The guard
`apps/server/src/mcp/toolkits/connForkPreviewCopy.test.ts` fails on the known
phrases. Extend it when new words appear.

Sources:

- Desktop (`apps/desktop/src/preview/`): `DesktopTabRunner.ts`, `CdpRelay.ts`,
  `Manager.ts`.
- `apps/server/src/mcp/PreviewAutomationBroker.ts`.
- `apps/server/src/preview/DesktopTabRelay.ts`.
- Web (`apps/web/src/`): `rpc/desktopTabRelay.ts`, `browser/`.
- `packages/contracts/src/previewAutomation.ts`.
- Shared (`packages/shared/src/`): `previewPage.ts`, `previewSessionControl.ts`.
- `docs/user/default-browser.md`.

### Agent-opened panels

A thread's agent can show a panel in the Conn desktop with the `panel_open` MCP
tool, so it can show the user its work running: `browser`, `database`, `mcp`,
`diff` or `files`. Only Conn threads can do this; the tool needs a thread scope.

Conn never switches threads for an agent. When the user is on the agent's
thread, Conn comes to the front and opens the panel. On another thread, Conn
prepares the panel for that thread without navigating or coming forward, and
panel actions (`database_query`, `mcp_connect`, `mcp_call`) fail with
`NOT_ON_THREAD`, asking the user to open the thread.

- `browser` with `url` opens a new desktop tab, and later `preview_*` calls
  without a `tabId` drive it. `tabId` shows an existing tab instead.
- `database` with `sql` puts the query in the editor.
- `focusWindow: false` opens the panel without bringing Conn forward, even on
  the agent's thread.

Two tools act inside a panel and answer with its result, so the user and the
agent see the same thing:

- `database_query` picks a Database panel connection by name, puts the query in
  the editor and runs it. The panel runs queries read-only, so it runs without
  asking. The agent gets the columns, the row count and the first 20 rows, with
  values cut at 500 characters. An unknown name fails with the names the panel
  has. A Vault connection may ask for Touch ID.
- `mcp_connect` adds or updates an MCP panel server (by name, else by URL or
  command), selects it and connects. Headers or env carry auth and are saved
  with the server, as typed ones are. The agent gets the server's tools. OAuth
  servers are not supported, as in the panel itself.
- `mcp_call` calls a tool on a saved MCP panel server: the panel selects the
  tool, fills its form with the agent's arguments and shows the result. The
  agent gets the content, with text cut at 8,000 characters and images left
  out, and any structured content. It is meant for building MCP servers: the
  user watches each change work. After the agent changes its server, it
  reconnects with `mcp_connect` so the panel lists the new tools.

The panel carries out the request where it already knows the project's
connections and servers (`pendingByThreadKey` in `databaseStore.ts`,
`useMcpAgentRequestStore` in `mcpStore.ts`). The server waits up to 90 s.

The server sends each request to every desktop connected to it
(`panels.requests` stream); the first desktop that shows the panel answers
(`panels.respond`). With no desktop connected, or when none answers in 15 s, the
tool fails with a clear reason. It never falls back to the headless browser.

The browser opens differently per server. On the server the desktop bundles,
desktop-runtime tabs are not relayed, so the tool opens a native server tab
through the broker's `open` operation. On a remote server (Beast, mini,
nick-vm) it opens a desktop-runtime tab and waits up to 20 s for the desktop to
register as its host. Remote servers need this build too.

Known issue: the first remote browser open after adding an environment once
failed with `tab_not_hosted`; after a renderer reload it worked every time.

To add a panel, add its kind to `AgentPanelKind` and an opener to
`PANEL_OPENERS`. Panel-specific arguments go on `AgentPanelRequest`, and
results on `AgentPanelResponse`.

Sources:

- `packages/contracts/src/agentPanels.ts`.
- `apps/server/src/panels/AgentPanelBroker.ts`.
- `apps/server/src/mcp/toolkits/panels/`.
- `apps/web/src/panels/agentPanelRequests.ts`.
- `apps/web/src/database/databaseStore.ts`, `apps/web/src/mcp/mcpStore.ts`.

### Password-manager autofill

Agents use test logins through the browser panel. `request_credentials` lists
item IDs, titles, usernames and URLs. `fill_credential` checks the tab's origin
and routes through `PreviewAutomationBroker` to the active server or desktop
browser runtime, which inserts the value over CDP.

Personal Vault logins are available only to the user. The address-bar key and
inline suggestions use desktop `vaultFill` IPC to read Vault and fill over the
tab's debugger. A fill marks the document and redacts the value from all CDP
relay messages sent to the server. Open script endpoints close before the fill.
While the mark remains, agents cannot use `preview_evaluate`, open endpoints or
take screenshots; `preview_snapshot` omits its image. Snapshot text and evaluate
results are redacted against masked and filled inputs.

Test logins live in T3 Code's secrets folder. Agents save them with
`save_test_login`. They fill without a prompt and support one-time codes.
Settings › Passwords lists them.

Sources:

- Server (`apps/server/src/`): `credentials/*`, `mcp/toolkits/credentials/*`,
  `preview/ServerBrowser.ts` (`credentialFill`, `credentialLock`, redaction).
- `packages/shared/src/credentialFill.ts`.
- `packages/contracts/src/credentials.ts`.
- Web (`apps/web/src/`): `credentials/*`,
  `components/settings/PasswordsSettings.tsx`.
- Desktop (`apps/desktop/src/`): `preview/Manager.ts` (`fillCredential`),
  `preview/DesktopBrowserHost.ts` (relay redaction),
  `ipc/methods/vaultLogins.ts`, `vault/Logins.ts`.

### Conn (app rename)

The desktop app is **Conn**: `Conn.app` or `Conn (Dev).app`, app ID
`com.nckrtl.conn` (dev `com.nckrtl.conn.dev.<checkout>`), link scheme `conn://`
(dev `conn-dev://`) and user-data folder `conn` (dev `conn-dev`). Window titles,
menus, About, permission prompts, onboarding and the sidebar wordmark use the
name. macOS builds use Apple team 9SVJ4SYB9B.

`forkBrand.json` holds the identity. `appBrand.ts` resolves it, with upstream
values as defaults. `T3CODE_APP_NAME`, `T3CODE_DESKTOP_APP_ID`,
`T3CODE_DESKTOP_SCHEME` and `T3CODE_APPLE_TEAM_ID` override single values. The
desktop bundle bakes in `__T3CODE_APP_BRAND__`; tests and other code use
upstream's defaults. To build the stock app, set `forkBrand.json` to `{}`.

First launch copies `t3code(-dev)` user data to `conn(-dev)`, excluding caches
and lock files and leaving the old folder untouched. Before opening any window,
it copies the old origin's localStorage to the new origin. It re-encrypts saved
secrets if the safeStorage key changes.

The app still handles `t3code://` links. The stock server accepts only that
scheme for sign-in return links, so the web client's `serverReturnHref` uses it.
These also keep their T3 names:

- `@t3tools/*` packages, `T3CODE_*` variables, `t3code:*` localStorage keys and
  `~/.t3/...`.
- The staged package name `t3code`, which fixes the keychain item name "t3code
  Safe Storage".
- Identifiers other software matches: MCP tool names and titles (`t3_*`,
  "Create T3 threads"; the Conn Server's catalog mirrors the titles), the `t3`
  CLI name, launchd and systemd unit text, Codex and ACP client names, checkpoint
  commit authors and trailers, and model-facing instructions. The dev backend
  allows `T3CODE_DEV_ALLOWED_ORIGINS=conn-dev://app`.

User-visible text names the product Conn in every client and both servers
(Nick, 2026-11-22): "Conn thread", "Conn Server", "Conn's home folder". "T3
Connect", "T3 Chat" and "T3 account" stay: they name T3's hosted services.

The Conn logo replaces the T3 mark on blueprint dev icons and black production
icons. Fork-owned Icon Composer projects are in
`assets/conn/{dev,prod}/app-icon.icon`, copied from upstream with only
`text.svg` swapped. `assets/conn/export-icons.sh` uses `ictool` to render iOS,
universal, favicon and `.ico` assets into `assets/conn/*/conn-*`; the 192 and
512 web icons are the iOS render scaled down. It uses
`assets/conn/safe-area.swift` to place the macOS render in the pre-Tahoe safe
area (824px body, soft shadow), because the GUI-only preset cannot be scripted.

The `icons` entries in `forkBrand.json` select these assets, falling back to
upstream paths in `appBrand.ts`. Source-tree icons, the dev runtime bundle's
`icon-dev.icns` and packaged stable builds use them. Nightly icons stay
upstream's. Desktop packaging applies the Conn name on Linux and Windows as
well; platform integration files retain some T3 names.

`apps/web/public` holds Conn dev favicons, manifest icons and the splash logo.
`vp run icons:check` reports those six assets as stale; `vp run icons:export`
would overwrite them. Packaged stable builds copy the Conn production web icons
over upstream's (`resolveDesktopWebIconOverrides`).

Every mobile variant is named Conn and uses the Conn iOS icon, `.icon` project
and splash (preview uses production's). Widgets and Live Activities use
`assets/conn/widget/ConnMark.svg`. Android artwork comes from
`assets/conn/android`, rendered by `node scripts/export-conn-android-icons.ts`.
Upstream's `assets/{dev,prod,nightly}` are untouched.

Sources:

- Desktop (`apps/desktop/src/`): `branding/*`, `app/DesktopAssets.ts`,
  `app/DesktopEnvironment.ts`, `electron/ElectronProtocol.ts`,
  `app/DesktopAppIdentity.ts`, `app/DesktopApp.ts`, `app/DesktopClerk.ts`.
- `assets/conn/*`.
- Mobile: `apps/mobile/app.config.ts`,
  `apps/mobile/plugins/withWidgetLogoAsset.cjs`.
- `apps/desktop/scripts/electron-launcher.mjs`.
- `apps/desktop/vite.config.ts`.
- `scripts/build-desktop-artifact.ts`, `scripts/sign-macos-local.ts`.
- `apps/web/src/lib/serverReturnHref.ts`.

### i18n and the app name

Upstream translates the UI with GT (`docs/internals/i18n.md`): `<T>`, `gt()` and `msg()`
in source, hand-written catalogs in `apps/{web,mobile,desktop}/src/i18n/translations`.
Conn renames the app, so **copy never names it literally**:

- Write `{appName}` in the message and pass `{ appName: appName() }` from
  `@t3tools/shared/appName`. Inside `<T>`, write `<Var>{appName()}</Var>`. Desktop main
  code passes `appBrand.name`.
- `appName()` reads the desktop bridge's branding in the renderer, so module-level
  `msg()` constants get Conn's name. Mobile sets it from the Expo config in
  `apps/mobile/src/lib/installAppName.ts`, imported by `index.ts` before `App`. Default:
  `Conn`.
- Every locale keeps `{appName}` where upstream's translation said "T3 Code" (German
  compounds: `{appName}-Server`).
- Strings that must stay literal (legacy directory and keychain names, file markers,
  lookup keys, OpenAI's fixed wording, upstream's issue title) carry
  `// oxlint-disable-next-line t3code/no-hardcoded-app-name -- <why>`. Comparisons with
  `"T3 Code"` are allowed.

The gate, in CI and in the nightly run:

- Lint rule `t3code/no-hardcoded-app-name` (`oxlint-plugin-t3code`) fails on "T3 Code"
  in string literals, templates and JSX text under `apps/{web,mobile,desktop}/src` and
  `packages/{client-runtime,shared}/src`, tests excluded. Comments are not checked.
- `vp run brand:check` (`scripts/check-conn-brand.ts`) fails on "T3 Code" or "T3-Code"
  anywhere in the 30 catalogs. CI runs it after the i18n catalog check.

Fork copy: fork screens kept English when upstream adopted GT (2026-11-18). The files in
the `no-untranslated-copy: "warn"` override in `vite.config.ts` warn instead of failing
(914 strings). Wrap a screen's copy when you touch it and drop the file from the list.

Sources: `packages/shared/src/appName.ts`, `apps/mobile/src/lib/installAppName.ts`,
`oxlint-plugin-t3code/rules/no-hardcoded-app-name.ts`, `scripts/check-conn-brand.ts`,
`scripts/conn-brand.ts`, `vite.config.ts` (the two lint overrides).

### Mobile home bar and filter

On iPhone, the bottom toolbar holds Settings, a Threads / Pulls / Search group
and New chat. It replaces upstream's tab bar and hides the top brand, search and
settings bar. The connection status appears above the bottom bar only while
reconnecting.

Tabs are 64pt wide. The toolbar pads custom views about 5pt at each side, so the
group pads only its top and bottom. The selected pill uses foreground at 12% and
sits evenly inside the glass.

Search replaces the group with a toolbar search field for the selected tab.
Cancelling or leaving it empty restores the group. On Threads, the workspace,
environment and project filter sits inside the field, like Mail, replacing
upstream's filter pills. Pull requests keeps its own filter row. The field uses
the composer's text size. This needs the `react-native-screens` patch in
[Vendored dependency patches](../../../../docs/development.md#vendored-dependency-patches).

Sources:

- `patches/react-native-screens-conn.patch`.
- `apps/mobile/src/native/V5StackHeader.ios.tsx` (`filterInsideSearch`, search
  field `fontSize`).
- Workspace (`apps/mobile/src/features/layout/workspace/`): `WorkspacePhoneBar.tsx`,
  `useWorkspacePhoneBar.ts`, `WorkspaceNativeTabs.ios.tsx`,
  `WorkspaceRootScreen.tsx` (`connPhoneBar`).
- Mobile (`apps/mobile/src/features/`): `home/HomeHeader.tsx`,
  `home/HomeScreen.tsx`, `pull-requests/PullRequestsScreen.tsx`.

### Mobile thread feed and lists

The connection pill floats over the thread feed, so messages do not shift while
connecting.

Markdown uses the system font with weights and JetBrains Mono for code. Blocks
and headings have 12pt above/between them; list items have 6pt between them.
List markers start at the list's edge, with an 8pt gap to the text for both
numbers and bullets. This needs the enriched-markdown patch in
[Vendored dependency patches](../../../../docs/development.md#vendored-dependency-patches).

On iOS 26 and later, a native `EdgeBlur` replaces upstream's color fade under
the composer and header, and the composer is realigned. `T3EdgeBlurView` lives
in `t3-composer-editor`.

The iOS composer editor follows Dynamic Type through JS: `T3ComposerEditor.ios.tsx`
sends the body size and line height times `fontScale` and re-renders when the text
size changes. `T3ComposerEditorView.swift` therefore keeps
`adjustsFontForContentSizeCategory` off, re-applies typography on a content size
change, uses the JS font family (default "System"), gives chips the system font and
supports `singleLineCentered`.

The "Worked for" fold row has 10.5pt on both sides of its divider (`mb-3`). Its
fixed size is 49 in `ThreadFeed.tsx` and `thread-feed-item-size.ts`. Dividers on
glass and sheets use foreground at 12%: the working pill, composer command
popover and terminal sheet.

Sources:

- Threads (`apps/mobile/src/features/threads/`): `ThreadDetailScreen.tsx`,
  `ThreadFeed.tsx`, `thread-feed-item-size.ts`, `floating-working-control.tsx`,
  `ComposerCommandPopover.tsx`, `ThreadComposer.tsx`.
- Mobile (`apps/mobile/src/`): `native/EnrichedMarkdownText.tsx`,
  `lib/fonts.ts`, `features/terminal/TerminalContextSheet.tsx`,
  `native/EdgeBlur*`.
- `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift`,
  `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift` and
  `apps/mobile/src/native/T3ComposerEditor.ios.tsx`.

### Linked environments (peer links)

The fork retains linked environments, delegation to them and environment link
MCP tools from upstream's `t3code/peer/*` stack, imported through the v0.0.46
preview tag.

Its migration is `070_PeerLinks`; upstream uses 61 through 69.
`reconcileConnPeerLinksMigration` moves records from 61 through 69 to 70 and
runs the upstream migrations they displaced. A runtime from before the move (69)
cannot start on a database that a 70 runtime has migrated, so a rollback past it also
needs the database backup taken before the update. `runMigrations` calls the reconcile before
upstream's `assertV2MigrationsCanRun`, behind the same `hasPending` gate.

Plain HTTP links also work for Orbit WireGuard addresses in `10.44.0.0/16`
(`isOrbitWireGuardHost` in `apps/server/src/peer/PeerLinks.ts`). WireGuard
encrypts this traffic. Upstream allows only HTTPS, loopback and Tailscale.

`t3 environment link-orbit <id>` links a server that Orbit lists without a pairing code in
an agent's transcript. The server asks the Gateway for a pairing as its own Node, follows the
Operation (one pairing per call), takes the code from the link and calls `PeerLinks.link` with
the Gateway's URL for that server. It prints only the outcome, or `<code>: <message>`.

Stale records never take a link: a switched-off saved server offers no addresses
(`linkableMachines` in `packages/client-runtime/src/linkRequest.ts`), so a card for an address
that Orbit gave to a new Instance links whatever answers there now. When a saved server still
claims the address, `PeerLinks.answeringAs` names both: `<url> now answers as <label> (<id>),
not <expected>.` There is
no MCP tool for it: agents that orchestrate Orbit clones run `t3` in a shell, and a tool would
add to every agent's tool list. A peer with Linked environments off refuses with
`peer_disabled` (`PEER_LINKS_OFF_DESCRIPTION`), shown as `target_links_off`. The server reuses
the Gateway client from `packages/client-runtime/src/orbitGateway/client.ts`.

Sources:

- Server (`apps/server/src/`): `peer/*`, `persistence/Migrations.ts`,
  `mcp/toolkits/orchestrator/*`, `orbit/OrbitEnvironmentLink.ts`, `cli/environment.ts`.
- `packages/contracts/src/rpc.ts` (`peerLinks*`).

### Orbit registration

`apps/conn-server/orbit/t3-orbit-register URL` registers the host's server with the
Orbit Gateway. Conn Server's thread push needs the session it issues. It issues a fresh admin session labeled "Orbit Gateway" and
sends it to `POST /api/v1/conn/environments`. A scheduled job runs it daily,
because the Gateway's admin session expires.

The script needs the CLI of the server that is running now (default `conn-server`). On macOS, give
it the server's launchd job with `--service-label LABEL`. At every run it reads
the first argument of the loaded job (`launchctl print gui/<uid>/LABEL`). Only
when launchd does not know the job does it read `ProgramArguments` of
`~/Library/LaunchAgents/LABEL.plist` with `plutil`. It skips an
`env VAR=value` wrapper. The label differs per host:

- mini: `com.t3tools.t3code.service`.
- nick and nick-vm: `com.nckrtl.conn-server`.

Install the script in `~/.local/bin`. Fill in the placeholders of
`apps/conn-server/orbit/com.nckrtl.t3-orbit-register.plist` and put it in
`~/Library/LaunchAgents`. It logs to `~/Library/Logs/t3-orbit-register.log`.
`RunAtLoad` registers as soon as the job loads, so load it only when you mean
to register. On Linux, install `apps/conn-server/orbit/t3-orbit-register.service` and
`.timer` in `~/.config/systemd/user`. Put `T3_ORBIT_REGISTER_URL=<url>` in
`~/.config/t3-orbit-register.env`, then enable the timer and lingering. The
unit runs `~/.local/bin/conn-server`; give it a stable path.

> [!WARNING]
> Never put a versioned runtime path (`…/runtime/versions/<version>/t3`) in a
> register or relink job. Runtimes are pruned after updates, and `t3 update`
> repoints only launcher symlinks, not job files. On 2026-10-30 nick-vm's job
> still pointed at the pruned 0.0.46 runtime and failed with "No such file or
> directory". It had not registered since 2026-10-27. The script warns when
> it gets a versioned path. `--print-cli` shows the binary it resolves
> without contacting anything. `sh apps/conn-server/orbit/t3-orbit-register.test.sh`
> checks the lookup offline.

> [!WARNING]
> On 2026-11-06 a hand-run `plutil -extract ProgramArguments json FILE`
> (without `-o -`) rewrote the server plists on mini and nick-vm as bare JSON
> arrays. PlistBuddy could not read them, so registration failed until
> 2026-11-13. The lookup now asks launchd first.

Sources:

- `apps/conn-server/orbit/t3-orbit-register`,
  `apps/conn-server/orbit/com.nckrtl.t3-orbit-register.plist`,
  `apps/conn-server/orbit/t3-orbit-register.service`,
  `apps/conn-server/orbit/t3-orbit-register.timer`,
  `apps/conn-server/orbit/t3-orbit-register.test.sh`.

### Linked environment renewal

Linked sessions expire after 30 days without automatic renewal in T3.
`scripts/orbit/t3-orbit-relink` renews links that expire within 10 days. It
requests a pairing link with `POST /api/v1/conn/environments/<id>/pairings`,
then links again with the same addresses and access.

Install the script in `~/.local/bin`, next to `t3-orbit-register` (see Orbit
registration), and its
`scripts/orbit/com.nckrtl.t3-orbit-relink.plist` in `~/Library/LaunchAgents`. It
runs daily and logs to `~/Library/Logs/t3-orbit-relink.log`. Its
`--service-label LABEL` finds the T3 CLI with the same lookup as
`t3-orbit-register` (set the label of the host's server job). A failed
`environment list` fails the run. The recorded mini
setup links nick, beast and shark with full access.

It also renews links whose status is already `expired`. On Linux hosts install
`scripts/orbit/t3-orbit-relink.service` and `.timer` in `~/.config/systemd/user`,
enable the timer, and enable lingering (`loginctl enable-linger`) so it runs
without a login session.

Gateway codes carry administrative scopes. Renewed sessions therefore have more
scopes than the app's orchestration-only request.

Sources:

- `scripts/orbit/t3-orbit-relink`,
  `scripts/orbit/com.nckrtl.t3-orbit-relink.plist`,
  `scripts/orbit/t3-orbit-relink.service`, `scripts/orbit/t3-orbit-relink.timer`.

### Machine @-mentions

Typing `@` in the composer offers other T3 Code environments alongside threads
and files. Picking one inserts a machine chip. Messages carry only the
environment ID and label. The agent is told to use `conn_environment_link` before
delegating there.

Web persists `environmentContexts` on the composer draft and restores them on
undo or failed sends. Upstream's thread contexts use the attachment draft.
Mobile offers machines in the `@` popover and draws chips natively through
`t3-composer-editor` (`T3ContextChip` on Android).

Sources:

- Web (`apps/web/src/components/`): `chat/ChatComposer.tsx`
  (`composerEnvironmentContexts`), `ChatView.tsx`, `ChatView.logic.ts`,
  `EnvironmentContextChip.tsx`, `composerContextPresentation.tsx`,
  `contextPresentationRegistry.ts`, `chat/ComposerCommandMenu.tsx`,
  `chat/MessagesTimeline.tsx`.
- Mobile (`apps/mobile/src/`): `features/threads/use-composer-command-menu.ts`,
  `features/threads/ComposerCommandPopover.tsx`, `lib/composerContext.ts`,
  `state/environments.ts`.
- Native chips: `apps/mobile/modules/t3-composer-editor/`.

### Mobile Operator dictation

Settings > Voice lets the user select an Operator server and sign in, instead
of using the device recognizer. Keep both the settings UI
(`SettingsTranscriptionSection.tsx`) and the recording consumer connected to
`voice-input/operatorTranscription.ts`. A recording with Operator selected
must use `getOperatorVoiceTranscriber`; its availability must also reach the
microphone control. Preserve this choice alongside upstream's environment and
cloud transcription routes. The November 7 sync kept the settings but removed
the consumer from `VoiceInputProvider.tsx`.

Sources under `apps/mobile/src/features/`:

- `settings/SettingsVoiceRouteScreen.tsx`, `settings/SettingsTranscriptionSection.tsx`.
- `voice-input/VoiceInputProvider.tsx`, `voice-input/voiceDestination.ts`,
  `voice-input/operatorTranscription.ts` and its tests.

### Fork RPC group

Conn's fork contracts live in `ForkWsRpcGroup`. On November 8, Nick authorized
restoring the RPCs required by annotation queues and Orbit registration. The
Orbit registration RPCs (`orbitWorkspaces.*`) left with the worktree-based Orbit
mode, so the group is `annotations.{subscribe,create,remove}`. `wsFork.ts` mounts
only these three methods; `ws.ts` merges them into the production socket group. Keep their
handler layer separate from the large upstream groups to avoid TypeScript's
handler-type expansion limit.

Subscriptions require `orchestration:read`. Annotation mutations require
`preview:operate`. Both the
scope authorization and instrumentation middleware apply to the fork group.
`wsFork.test.ts` exercises the handlers through RPC, including rejected
mutations and the real annotation store. `wsMountedRpc.test.ts` checks the
production mount against the explicit three-method allowlist.

`serverRestart`, `credentials*`, `testLogins*` and `panels.*` remain unmounted.
Do not broaden this allowlist without a new decision.
Typed contracts alone do not prove a method is available on a server.

Sources:

- `packages/contracts/src/rpc.ts` (`OfficialWsRpcGroup`, `ForkWsRpcGroup`).
- `apps/server/src/wsFork.ts`, `ws.ts`.

### Provider CLIs

Orbit installs and updates every provider CLI (vp, brew and brew-cask) and owns PATH: the brew
and vp bins on Nodes, the agent folder in containers. Conn and the Conn Server never install,
update or remove one (Nick, 2026-11-20).

- **Finding a CLI.** Each CLI is resolved on PATH, or the instance's `binaryPath`; the version
  comes from the binary on every health check. Antigravity runs `agy` (`agy --version`, sessions
  `agy acp`); the managed `localharness` runtime is gone. Managed Codex (the ChatGPT account
  mode) runs `codex` from PATH. `binaryPath` stays: removing it touches every driver schema, the
  settings form and saved settings, and its default already resolves on PATH.
- **Server.** `ws.ts` does not mount `provider.install.*` or `server.updateProvider`; the
  contracts keep them, so the Conn Server's generated contract does not move.
  `provider/orbitManagedProviders.ts` supplies a `ProviderLatestVersions` layer that never looks
  up a release, and strips `versionAdvisory` and `setup.canInstall` from published snapshots. A
  compatibility advisory never blocks a Codex session.
- **Clients.** Each provider shows its version and "Managed by Orbit". No install, update or
  remove control, no update pill or launch notification, no update-check toggle. A
  compatibility advisory is one quiet line; it never replaces the status, raises an alert, or
  hides models.
- **Conn Server.** Serves neither group; `apps/conn-server/docs/status.md` lists them.

Sources: `apps/server/src/provider/orbitManagedProviders.ts`, `providerCliOnPath.ts`,
`Drivers/AntigravityDriver.ts`, `CodexManagedRuntime.ts`, `ws.ts`.

### Codex MCP network wait

Codex starts a thread's MCP servers once and never retries one that failed.
After a reboot the Orbit network (WireGuard, `*.orbit`) can come up after the
T3 server spawns `codex app-server`, and those threads run without Recall or
executor tools. Before it spawns `codex app-server`, the Codex adapter waits
until every enabled `*.orbit` URL under `[mcp_servers.*]` in the effective
`config.toml` accepts a TCP connection. The wait has a 120-second budget, set
with `T3CODE_CODEX_MCP_WAIT_SECONDS` (`0` turns it off), then the spawn goes
ahead with a warning. The result is cached per config file, so only the first
spawn per server process can wait. Configs without `*.orbit` MCP URLs never
wait.

Sources:

- `apps/server/src/provider/codexMcpNetworkGate.ts`.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`
  (`layerAppServerClientFactory`).

### Swipe navigation setting

Upstream's two-finger trackpad swipe goes back and forward in history. It can
fire while the user scrolls and switch to the previous thread. Settings >
General > "Swipe between threads" (`historySwipeNavigation`, default on) turns
it off. On a conflict, keep the setting gate around `<HistorySwipeNavigation />`.

Sources:

- `packages/contracts/src/settings.ts` (`historySwipeNavigation`).
- `apps/web/src/components/AppSidebarLayout.tsx`.
- `apps/web/src/components/settings/SettingsPanels.tsx`,
  `apps/web/src/components/settings/settingsSearch.ts`.

[shell]: ../.agents/skills/nckrtl-shell-design/SKILL.md
