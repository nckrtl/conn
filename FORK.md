# nckrtl fork of T3 Code

This is Nick's fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
at [nckrtl/conn](https://github.com/nckrtl/conn), shipped as Conn. Read this
file before you merge upstream, build, or change shared UI. Upstream's
`AGENTS.md` applies to everything else.

## Branch and build

- `main` is the only long-lived development branch. It holds every
  customization, and new work lands there directly. Until 2026-10-11 this line
  was the `nckrtl` branch of `nckrtl/t3code`. That branch and the old
  `upstream-mirror` and `rooms-patches*` branches were deleted on 2026-10-15.
  `wip/*` branches hold unreviewed saved work.
- Conn tracks upstream `main`. The Grok bot runs a nightly sync to keep each
  merge small; manual syncs follow the same procedure below. Merge
  `upstream/main` into a `sync/<yyyy-mm-dd>` branch off `main`, then merge it
  back after a good build. Do not merge upstream's preview or stable tags. They
  are cut on release branches, so the next sync from upstream `main` merges
  their cherry-picks again. Never force-push `main`.
- The Mac desktop app, iPhone app and T3 servers (beast, mini, shark and the
  headless server on nick) use Conn builds from `main`. Build server runtimes
  with `scripts/build-cli-archive.ts`.
- Build, sign and install with the [build guide][build]. Builds ship no update
  feed (`publish: null` in `scripts/build-desktop-artifact.ts`), so the app
  never replaces itself with an upstream release. Re-sign macOS builds with a
  local identity using `scripts/sign-macos-local.ts`.

## What the fork changes

Paths below are relative to the repository root unless a source list gives
another base directory.

### Shell design

The shell follows ChatGPT's desktop window structure in the active theme's
colors: inset cards, two-tone dividers, glass popovers, toolbar groups, soft
fields, inset scrollbars and a 44px header. This covers chat, sidebar, Settings,
browser, Files, Diff, terminal, Agents and fork panels.

Settings and Usage are upstream's route modals (`_chat.settings.*`, `_chat.usage`
over the thread view through `mainAppLocation`). Conn keeps upstream's modal
behavior and draws the shell inside it: `AppRouteModal` is the frosted frame,
`AppRouteModalHeader` the transparent 44px header, `AppRouteModalCard` the inset
card, and `APP_ROUTE_MODAL_NAV_CLASS` the inset Settings nav beside the card.
On a conflict there, take upstream's routing and dismissal logic and keep these
four pieces.

The [nckrtl-shell-design skill][shell] has the full rules.

Sources:

- Web (`apps/web/src/`): `index.css` (shell tokens at the end),
  `components/ui/*` variants, `components/ToolbarGroup.tsx`,
  `components/settings/*`, `components/AppRouteModal.tsx`,
  `routes/_chat.settings.tsx`, `components/ChatView.tsx`,
  `components/RightPanelTabs.tsx`, `routes/__root.tsx`, `pierre-tree-theme.ts`.
- Desktop traffic lights: `apps/desktop/src/window/DesktopWindow.ts`.

### Icons

Web thread timeline icons are Phosphor: solid by default, bold for carets and
line glyphs whose solid form adds a box. Icons elsewhere stay Lucide.
`ConnIconScope` around `MessagesTimeline` in `ChatView.tsx` selects Phosphor.

The web tsconfig and Vite's `resolve.alias` map `lucide-react` and `lucide` to
Conn modules that pair each Lucide icon with a Phosphor icon. Upstream imports
stay unchanged. A new upstream icon fails typecheck until it gets an entry. Both
mappings are needed: the dev server ignores tsconfig paths for pre-bundled
packages.

`MorphIcon` morphs original Lucide shapes outside the thread (`lucideNodes` from
`lucide-original`) and crossfades inside it. Project and workspace icons use
`lucide-react/dynamic` and `lucide-react-original`.

Sources:

- Web (`apps/web/`): `src/icons/` (`lucide-react.ts`, `lucide.ts`,
  `connIcon.tsx`), `tsconfig.json` (`paths`), `vite.config.ts`.
- Components (`apps/web/src/components/`): `MorphIcon.tsx`, `ChatView.tsx`,
  `sidebar/workspaceVisuals.tsx`.

### iOS icons

On iOS, thread feed icons in messages and the work log are Phosphor. The rest of
the app, including native toolbars, tab bars and menus, keeps SF Symbols.
Android keeps Tabler. `AppSymbol.ios.tsx` also uses SF Symbols for git icons
that upstream drew with Tabler.

`symbols.json` maps SF names to Phosphor icons and weights: solid by default,
bold for carets and line glyphs that solid would box. Inside `ConnSymbolScope`
around `ThreadFeed` in `ThreadDetailScreen.tsx`, `AppSymbol.ios.tsx` requests
mapped names with a `conn.` prefix. `ConnSymbols.swift` swaps `UIImage`'s
`systemImageNamed` methods only for those names.

After changing `symbols.json`, run `node scripts/build-conn-symbols.ts`. It
builds custom symbols and `ConnSymbolNames.swift`. Commit the output and rebuild
the app.

Sources:

- `apps/mobile/modules/conn-symbols/` (`symbols.json`, `ios/`).
- `scripts/build-conn-symbols.ts`.
- Mobile (`apps/mobile/src/`): `components/ui/AppSymbol.ios.tsx`,
  `components/ConnSymbolScope.tsx`, `features/threads/ThreadDetailScreen.tsx`.

### Workspaces

A workspace rail sits beside the thread sidebar. Workspaces have their own
projects, icons and extra windows. New threads stay in the selected workspace.

Upstream has one desktop window, so upstream code often assumes a single main
window. In the fork every window must behave the same. `DesktopWindow.ts`
registers each window with `PreviewManager.addWindow`, and the preview manager
accepts browser guests hosted by any of them. When an upstream sync adds code
that reads a main window, make it work in workspace windows too, or the browser
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

New threads can start an Orbit instance. Conn also looks up projects by
repository and registers with Orbit.

In Orbit mode, Settings › Connections shows the per-environment Linked
environments, Load balancing and GitHub routing sections under Orbit's sections.
`ConnectionsSettings.tsx` renders them for both providers. Reading linked
environments needs `access:read` on that server; answering a link card needs
`access:write`.

The Gateway requests T3's administrative scopes for device pairing links (Orbit
commit `d17002d`). If a saved Orbit server's session lacks `access:write`, Conn
pairs it again at most once every 6 hours. The shared `lacksAccess` and
`accessPairedAt` logic is wired into the web and mobile Orbit providers.

Sources:

- `apps/web/src/orbit/*`.
- `apps/web/src/components/settings/ConnectionsSettings.tsx`.
- `packages/client-runtime/src/orbitGateway/environmentProvider.ts`.

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
merge per key or theme. The first sync adopts the profile or seeds an empty one.
Previous values remain available in Settings › Connections › Profile sync ›
Restore previous settings. Each part can be switched off per device.

An environment's `t3 theme set` is not a user choice and never syncs.
`orbit/themeOrigin.ts` wraps both calls in `useDefaultTheme.ts`. Themes a device
lacks are installed in the "From profile" collection until replaced by the live
published theme. On an older Gateway without sections, workspace sync still
works and Conn shows "Gateway doesn't support profile sync yet".

The phone adds Settings › Orbit with a profile picker and one-tap pairing for
the Gateway's T3 servers. The thread list has a Workspace filter.

Sources:

- Shared (`packages/client-runtime/src/orbitGateway/`): `profileSync.ts`
  (engine), `sectionMerge.ts`, `profileDocument.ts` and supporting files.
- Web (`apps/web/src/orbit/`): `OrbitProfileSync.tsx`,
  `OrbitAppearanceSync.tsx`, `appearanceProfileSync.ts`,
  `deviceSettingsSync.ts`, `profileSync*.ts`, `themeOrigin.ts`,
  `workspaceProfileSync.ts`.
- Web (`apps/web/src/`): `components/settings/OrbitSettings.tsx` (Profile sync),
  `components/settings/settingsSearch.ts` (`orbit-profile-sync`),
  `hooks/useDefaultTheme.ts` (two wrapped calls).
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

Sources:

- `apps/web/src/laravelToolbar/*`.
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
templates, prompts, server info, and a JSON-RPC log with stderr. The desktop
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
such a `t3_preview_list` description (upstream #24850), and agents on Beast
refused to drive Nick's tabs. In every sync, read upstream's changes to the
preview tool descriptions and agent instructions, and keep or rewrite any line
that limits agents to server tabs. The guard
`apps/server/src/mcp/toolkits/connForkPreviewCopy.test.ts` fails on the known
phrases. Extend it when upstream finds new words.

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
tool, so it can show the user its work running. Conn comes to the front, selects
the agent's thread and opens the panel: `browser`, `database`, `mcp`, `diff` or
`files`. Only Conn threads can do this; the tool needs a thread scope.

- `browser` with `url` opens a new desktop tab, and later `preview_*` calls
  without a `tabId` drive it. `tabId` shows an existing tab instead.
- `database` with `sql` puts the query in the editor.
- `focusWindow: false` opens the panel without bringing Conn forward.

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
`PANEL_OPENERS`. Panel-specific arguments go on `AgentPanelRequest`.

Sources:

- `packages/contracts/src/agentPanels.ts`.
- `apps/server/src/panels/AgentPanelBroker.ts`.
- `apps/server/src/mcp/toolkits/panels/`.
- `apps/web/src/panels/agentPanelRequests.ts`.

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
- Server branding in `apps/server`. The dev backend allows
  `T3CODE_DEV_ALLOWED_ORIGINS=conn-dev://app`. Fork features still change server
  code.

The Conn logo replaces the T3 mark on blueprint dev icons and black production
icons. Fork-owned Icon Composer projects are in
`assets/conn/{dev,prod}/app-icon.icon`, copied from upstream with only
`text.svg` swapped. `assets/conn/export-icons.sh` uses `ictool` to render iOS,
universal, favicon and `.ico` assets into `assets/conn/*/conn-*`. It uses
`assets/conn/safe-area.swift` to place the macOS render in the pre-Tahoe safe
area (824px body, soft shadow), because the GUI-only preset cannot be scripted.

The `icons` entries in `forkBrand.json` select these assets, falling back to
upstream paths in `appBrand.ts`. Source-tree icons, the dev runtime bundle's
`icon-dev.icns` and packaged stable builds use them. Nightly icons stay
upstream's. Desktop packaging applies the Conn name on Linux and Windows as
well; platform integration files retain some T3 names.

`apps/web/public` holds Conn dev favicons and the splash logo.
`vp run icons:check` reports those four assets as stale; `vp run icons:export`
would overwrite them. Packaged stable builds also use the Conn splash logo.

With `T3CODE_IOS_BUNDLE_ID` set, the iPhone's development and production
variants use the Conn iOS icon, `.icon` project and splash. Widgets and Live
Activities use `assets/conn/widget/ConnMark.svg`. Preview and Android artwork
stay T3. Upstream's `assets/{dev,prod,nightly}` are untouched.

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
the composer's text size. This needs the `react-native-screens` patch below.

Sources:

- `patches/react-native-screens-conn.patch`.
- `apps/mobile/src/native/V5StackHeader.ios.tsx` (`filterInsideSearch`, search
  field `fontSize`).
- Workspace (`apps/mobile/src/features/workspace/`): `WorkspacePhoneBar.tsx`,
  `useWorkspacePhoneBar.ts`, `WorkspaceNativeTabs.ios.tsx`,
  `WorkspaceRootScreen.tsx` (`connPhoneBar`).
- Mobile (`apps/mobile/src/features/`): `home/HomeHeader.tsx`,
  `home/HomeScreen.tsx`, `pull-requests/PullRequestsScreen.tsx`.

### Mobile thread feed and lists

The connection pill floats over the thread feed, so messages do not shift while
connecting. The resting composer has 8pt more room above it.

Markdown uses the system font with weights and JetBrains Mono for code. Blocks
and headings have 12pt above/between them; list items have 6pt between them.
List markers start at the list's edge, with an 8pt gap to the text for both
numbers and bullets. This needs the enriched-markdown patch below.

On iOS 26 and later, a native `EdgeBlur` replaces upstream's color fade under
the composer and header, and the composer is realigned. `T3EdgeBlurView` lives
in `t3-composer-editor`.

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
- `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift`.

### Linked environments (peer links)

The fork retains linked environments, delegation to them and environment link
MCP tools from upstream's `t3code/peer/*` stack, imported through the v0.0.46
preview tag. The stack is not yet on the synced upstream `main`.

Its migration is `070_PeerLinks`; upstream uses 61 through 69.
`reconcileConnPeerLinksMigration` moves records from 61 through 69 to 70 and
runs the upstream migrations they displaced. A runtime from before the move (69)
cannot start on a database that a 70 runtime has migrated, so a rollback past it also
needs the database backup taken before the update. See the merge rules below for the required
startup order and future ID conflicts.

Plain HTTP links also work for Orbit WireGuard addresses in `10.44.0.0/16`
(`isOrbitWireGuardHost` in `apps/server/src/peer/PeerLinks.ts`). WireGuard
encrypts this traffic. Upstream allows only HTTPS, loopback and Tailscale. When
the stack lands on upstream `main`, drop Conn's copy and reconcile the migration
ID again.

Sources:

- Server (`apps/server/src/`): `peer/*`, `persistence/Migrations.ts`,
  `mcp/toolkits/orchestrator/*`.
- `packages/contracts/src/rpc.ts` (`peerLinks*`).

### Linked environment renewal

Linked sessions expire after 30 days without automatic renewal in T3.
`scripts/orbit/t3-orbit-relink` renews links that expire within 10 days. It
requests a pairing link with `POST /api/v1/conn/environments/<id>/pairings`,
then links again with the same addresses and access.

Install the script in `~/.local/bin`, next to `t3-orbit-register`, and its
`scripts/orbit/com.nckrtl.t3-orbit-relink.plist` in `~/Library/LaunchAgents`. It
runs daily and logs to `~/Library/Logs/t3-orbit-relink.log`. The recorded mini
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
environment ID and label. The agent is told to use `t3_environment_link` before
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

### Fork RPC group

Conn's `serverRestart`, `peerLinks*`, `credentials*`, `testLogins*` and `panels.*` RPCs live
in `ForkWsRpcGroup`, merged into `WsRpcGroup`. They have a separate handler
layer because one group with every RPC exceeds TypeScript's instantiation limit.
Add new fork RPCs there.

Sources:

- `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts` (`layerWsForkRpc`).

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

## Keep the customizations through an upstream merge

1. Merge `upstream/main` into the sync branch. Work through every conflict,
   keeping all fork work and as much upstream work as possible. Conflicts are
   expected in the files listed above, most often `index.css`,
   `components/ui/*`, `ChatView.tsx`, `RightPanelTabs.tsx`, settings components
   and the sidebar. Keep the fork's side for styling and fork features, and
   re-apply upstream's logic and new features around it. Never drop a fork
   feature or an upstream fix to make a merge clean. Use the
   [nckrtl-shell-design skill][shell] as the rules for every UI conflict. Commit
   the resolution with a message that lists each conflicted file, how it was
   resolved, and which resolutions are uncertain. Known spots and how to resolve
   them:
   - `apps/server/src/persistence/Migrations.ts`: keep Conn's
     `reconcileConnPeerLinksMigration` call in `runMigrations`, before
     upstream's `assertV2MigrationsCanRun`, and keep `070_PeerLinks` after
     upstream's IDs (move it past any new upstream ID and extend the reconcile).
   - `apps/web/src/components/chat/ChatComposer.tsx`: take upstream's draft
     changes, but keep `composerEnvironmentContexts` from `composerDraft`.
   - Composer: upstream's composer redesign (#25869) is adopted as of
     2026-10-30 (Nick); Conn's own composer animation is retired. On conflicts
     in composer files take upstream's composer and re-apply only the listed
     fork features (environment contexts: `composerEnvironmentContexts`, the
     `@` environment chips, `EnvironmentContextChip.tsx`).
   - `apps/web/src/components/ChatView.tsx`: keep `<ConnIconScope>` around
     `<MessagesTimeline>`;
     `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`: keep
     `<ConnSymbolScope>` around `<ThreadFeed>`.
   - `apps/mobile/src/components/ui/AppSymbol.ios.tsx`: keep Conn's version (no
     Tabler; `conn.` names inside `ConnSymbolScope`).
   - Work-log icon unions (`thread-work-log.tsx`): keep both sides' icons.
   - `apps/web/vite.config.ts` (`resolve.alias`), `apps/web/tsconfig.json`
     (`paths`), `apps/web/package.json` (`lucide-react-original`,
     `lucide-original`, `@phosphor-icons/react`), `apps/mobile/package.json`
     (the `-conn.tgz` tarballs) and `pnpm-workspace.yaml` (the Conn tarball's
     build allowance): keep the Conn entries next to upstream's.
   - Desktop relay routing: keep
     `apps/server/src/mcp/PreviewAutomationBroker.ts`,
     `apps/server/src/preview/DesktopTabRelay.ts` and the desktop runner in
     `apps/desktop/src/preview/DesktopTabRunner.ts` connected through the client
     stream. Preserve thread scoping, one host per tab and Playwright over
     `CdpRelay.ts` on `webContents.debugger`. Keep the relay blocks on commands
     that close the guest or disable shared debugger events. Preserve the
     `preview_cdp_endpoint` tool and its wiring in
     `apps/server/src/mcp/toolkits/preview/tools.ts` and
     `apps/server/src/mcp/McpHttpServer.ts`.
   - Desktop bridge: preserve `apps/desktop/src/preview/Manager.ts`,
     `apps/desktop/src/ipc/methods/preview.ts` and
     `apps/desktop/src/preload.ts`. Retain `capturePage` with `stayHidden` and
     the Vault privacy controls described above.
   - Web relay: preserve stable tab identity, automatic hosting and
     `acquireBrowserSurfaceActivity` while the thread is off screen. Keep
     re-registration after a server restart. Interrupted requests must fail
     without replay. The files under `apps/web/src/` are
     `rpc/desktopTabRelay.ts`, `browser/HostedBrowserWebview.tsx`,
     `browser/ElectronBrowserHost.tsx` and `browser/previewRuntimeTabId.ts`.
   - Under `packages/contracts/src/`, keep Conn's desktop preview entries in
     `previewAutomation.ts`, `rpc.ts`, `ipc.ts` and `clientRpcPermissions.ts`
     next to upstream's.
   - `apps/server/src/preview/ServerBrowser.ts` shares page operations and
     session control with the desktop runner. Port relevant upstream changes
     into `packages/shared/src/previewPage.ts` and
     `packages/shared/src/previewSessionControl.ts`. Do not restore separate
     server copies.
   - In `apps/server/src/preview/Manager.ts`, keep `"desktop"` as the default
     runtime for an implicit tab. Keep `docs/user/default-browser.md` aligned
     with the behavior.
   - If upstream adds desktop-tab automation, compare both implementations
     against the behavior above. Keep Conn's behavior unless Nick decides
     otherwise.
   - Annotations: keep `layerAnnotationsToolkit` in
     `apps/server/src/mcp/McpHttpServer.ts`, the `ConnAnnotationsPreload.ts`
     import in `apps/desktop/src/preview-pick-preload.ts`, the overlay
     injection and binding in `apps/server/src/preview/ServerBrowser.ts`, the
     `annotations.*` RPCs in `packages/contracts/src/rpc.ts` and `ws.ts`, and
     the `attachOverlayBridge` effect in
     `apps/web/src/browser/HostedBrowserWebview.tsx`.
   - `pnpm-lock.yaml`: take upstream's, then let `vp i` rewrite it.
2. Run the regression scan in the shell skill's "Upstream sync procedure" on
   upstream's diff. New upstream UI must follow the fork's shell rules (glass
   popovers, `ToolbarGroup`, `text-ui`, shell dividers, `scrollbar-inset`). Fix
   what the scan finds on the sync branch, before the build.
3. Lint and typecheck only the touched scope (`vp lint <files>`,
   `vp exec tsc --noEmit` in `apps/web`), and run the tests for the fork areas
   you touched (from the root, use `vp test run` with paths such as
   `apps/web/src/laravelToolbar`, `apps/web/src/annotations`,
   `apps/web/src/workspaces.test.ts` and `apps/desktop/src/window`). For desktop
   tab automation, run `apps/desktop/src/preview/DesktopTabRunner.test.ts`,
   `apps/desktop/src/preview/CdpRelay.test.ts`,
   `apps/server/src/mcp/PreviewAutomationBroker.test.ts`,
   `apps/server/src/preview/DesktopTabRelay.test.ts`,
   `apps/web/src/rpc/desktopTabRelay.test.ts` and
   `apps/web/src/browser/ElectronBrowserHost.test.tsx`. These focused relay
   tests need a Playwright headless shell. Always run the fork guards
   `apps/mobile/src/native/connForkPatches.test.ts`,
   `apps/web/src/icons/connIcons.test.ts` and
   `apps/server/src/mcp/toolkits/connForkPreviewCopy.test.ts`. Run `vp i` first: merges change
   dependencies. When the web typecheck reports a Lucide name missing from
   `apps/web/src/icons/lucide-react.ts`, add a line for it (the Lucide icon and
   the closest Phosphor icon). New SF Symbol names in the mobile thread feed
   stay SF Symbols until they get an entry in
   `apps/mobile/modules/conn-symbols/symbols.json` and
   `node scripts/build-conn-symbols.ts` runs. If upstream bumps a vendored
   tarball in `apps/mobile/deps`, rebuild Conn's as described below.
4. Build, sign and install with the [build guide][build]. Merge the sync branch
   into `main` only after a good build.

### Vendored dependency patches

Upstream vendors some dependencies as tarballs in `apps/mobile/deps`, which pnpm
patches cannot target. Conn keeps its changes to them as patch files and ships a
rebuilt tarball next to upstream's:

- `react-native-screens`: `patches/react-native-screens-conn.patch` adds a
  search field accessory (a toolbar menu item shown inside the toolbar search
  field) and a `fontSize` prop for the search bar.
- `react-native-enriched-markdown`:
  `patches/react-native-enriched-markdown-conn.patch` sizes each list's marker
  column to its widest number (iOS), so numbers start at the list's edge like
  bullets, and ends bullets where numbers end, so both keep the same gap to the
  item text. `pnpm-workspace.yaml` allows the Conn tarball's install script next
  to upstream's.

`node scripts/build-conn-vendored-tarball.ts <package>` applies a patch to
upstream's tarball and writes `<upstream tarball name>-conn.tgz`;
`apps/mobile/package.json` points at that file.

After a merge that bumps upstream's tarball, keep upstream's new tarball, delete
the old `-conn.tgz`, run
`node scripts/build-conn-vendored-tarball.ts <package>`, point
`apps/mobile/package.json` at the new `-conn.tgz` and run `vp install`. If a
hunk no longer applies, port the change to the new upstream sources, regenerate
the patch with `diff -ruN a b` from the two extracted `package` directories, and
rebuild. The guard test fails while any of this is missing.

For rollback, the sync merge's first parent (`<merge>^1`) is the previous tip,
and the install keeps a backup of the previous app. `main` takes the sync only
after a good build. If an automatic merge damaged fork work, revert the merge
(`git revert -m 1 <merge>`) and redo the sync by hand.

When a fork feature, file path or rule changes, update this file in the same
commit.

[build]: .agents/skills/nckrtl-shell-design/references/build.md
[shell]: .agents/skills/nckrtl-shell-design/SKILL.md

## Pull request runners

Public forks use GitHub-hosted Ubuntu and macOS runners for the main CI and native fingerprint checks. Upstream keeps its Blacksmith labels. The fork does not register runners or require a Blacksmith installation; server shards run at most four at a time.
