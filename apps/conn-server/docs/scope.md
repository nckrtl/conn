# Conn Server scope

`apps/conn-server` is the Conn Server: our own Rust server behind the T3 client contract. It
came in with its history from `hardimpactdev/conn-server` on 2026-11-15. Its own `AGENTS.md`
and `README.md` apply there. It is not a pnpm workspace package. Its tools read the contract,
the web client and `apps/server` from this tree.

## Platforms and hosts

Conn's GUI targets macOS and iOS only. The Conn Server runs on Linux in Orbit containers
(macOS later). Windows, Android and the Linux desktop app are out of scope, and so are the
hosted web app (app.t3.codes and its previews), the T3 Connect relay (`infra/relay`) and the
marketing site (`apps/marketing`). None of them is a Conn surface.

Only GitHub is used as a source-control host. GitLab, Forgejo, Bitbucket, Azure DevOps,
GitCafe and Cursor origin are out of scope (Nick, 2026-11-16). Every area that
[orbit-profile.md](orbit-profile.md) rates "not needed" is out of scope too.

## Checks

Pull requests and main pushes run the Conn Server workflows. They read only `apps/conn-server`
and run no TypeScript; the comparisons against the T3 server are the audit kit
(`tools/audit.sh`). Both workflows support manual runs. [upkeep.md](upkeep.md) has the
details.

## Release

A tag `conn-server-v<version>` (the `conn-server` crate's version) runs
`conn-server-release.yml`. It makes a GitHub Release on `nckrtl/conn` with
`conn-server-<version>-linux-x64.tar.gz` and its `.sha256`, not marked Latest; Orbit downloads
it. Conn's `release.yml` takes only `v*.*.*` tags, so neither starts the other.

## Provider CLIs

Orbit installs and updates every provider CLI and owns PATH. The Conn Server never installs,
updates or removes one (Nick, 2026-11-20). Providers sign in through Orbit's AI router; the
server never holds provider account tokens. See [Provider CLIs](../../conn-gpui/docs/reference/conn-features.md#provider-clis).

## Not served, by decision

The Conn Server does not serve these client areas (Nick, 2026-11-20). They stay unregistered,
and parity work skips them:

- Resource telemetry: `subscribeResourceTelemetry`, the resource and process history and
  its retry (the Settings › Diagnostics CPU and memory panel). Orbit tracks resources.
- The Usage page: `server.getUsageSummary` and `server.refreshUsageRates`.
- Session import: `agentSessions.scan` and `agentSessions.import` (provider transcripts
  turned into threads). This is not the T3 state import: a Conn Server that starts in a
  T3 server's state folder carries that server's threads over once
  ([status.md](status.md), "T3 state import").
- Clone from the client: `projectClone.*`. The `/mcp` clone tool stays.
- The test-login group of the browser's key menu: `credentials.listForSite` and
  `credentials.fillForSite`. Vault logins in that menu stay; the desktop fills them itself.
- Linear and other standalone trackers: `issueTrackers.*`. GitHub issues stay.
- Provider install and update: `provider.install.*` and `server.updateProvider`. Orbit
  installs and updates provider CLIs (see above). The T3 server does not mount them either.
- Server self-update (Nick, 2026-11-21): `server.getNpmRelease`, `server.updateServer`,
  `server.updateServerWithProgress` and `server.commitDesktopUpdate`. They fetch T3's own
  releases. Orbit releases the Conn Server in containers; on Macs the Conn desktop build
  carries it.
- The ACP registry: its 11 `server.*AcpRegistry*` methods. Orbit tools install agent CLIs,
  and the Conn Server runs ACP agents such as Antigravity without the registry.
- ChatGPT profile and handoff (`provider.chatgpt.*`) and `provider.consumeResetCredit`.
  They need provider account tokens, which the server never holds.
- T3 cloud: `cloud.getRelayClientStatus`, `cloud.installRelayClient` and
  `guestShare.create`. Conn links through the Orbit Gateway.
- `server.prepareTriage` (a bug report about T3 itself), `server.checkOtlpEndpoint` (the
  server sends no telemetry), `server.checkSecretSource` (the server never reads secret
  references), and storage cleanup (`server.getStorageCleanupReport`,
  `server.runStorageCleanup`).

The Diagnostics panel, the Usage page and the key menu's test-login group may later be
removed from Conn itself.

## Exclusions

Root Vite+ format, lint and test configs ignore `apps/conn-server/**`,
`.github/scripts/ci-changes.cjs` treats it and the `conn-server-*` workflows as inert for
Conn's CI, and `.gitignore` re-includes `apps/conn-server/helpers/sdk-host/build/`.
