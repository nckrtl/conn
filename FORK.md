# Conn and T3 Code

Conn ([nckrtl/conn](https://github.com/nckrtl/conn)) started as a fork of
[pingdotgg/t3code](https://github.com/pingdotgg/t3code). It is no longer a fork in practice:
full upstream merges have ended, and active work is on Conn's own native stack. This file
says what Conn is, how it still relates to T3 Code, and where the old fork notes went.

## What Conn is

| Part             | Where                           | What it is                                                                                                                                    |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Conn Server      | `apps/conn-server`              | Rust server for Conn clients. It serves the T3 client contract, `/mcp` and the provider protocols. One server runs in each Orbit container.   |
| Desktop client   | `apps/conn-gpui`                | Native Rust + GPUI macOS app. It talks to the Conn Server through its Rust contract crates.                                                   |
| iPhone app       | `apps/ios`                      | Native SwiftUI app on the shared Rust core (`conn-ffi`). It builds only in nick-vm.                                                           |
| Shared Rust core | `crates/`                       | GPUI-free crates both native clients use: `conn-client`, `conn-state`, `conn-theme`, `conn-orbit`, `conn-ffi` and others.                     |
| Design labs      | `apps/lab-gpui`, `apps/lab-ios` | Vite mocks of the desktop and iPhone shells with local fixtures (`npm --prefix apps run lab:gpui`, `lab:ios`). They never start an agent run. |

Builds:

- **Conn Server.** A `conn-server-v<version>` tag makes a Linux release that Orbit downloads.
  See [apps/conn-server/docs/scope.md](apps/conn-server/docs/scope.md), "Release".
- **Desktop client.** Built and bundled on the Mac with the scripts in
  `apps/conn-gpui/scripts`. See [apps/conn-gpui/README.md](apps/conn-gpui/README.md).
- **iPhone app.** Built in nick-vm; see [iPhone app (native)](apps/ios/README.md).
- **Legacy apps.** The Electron desktop app and the T3 server still build from `main` with the
  [build guide](.agents/skills/nckrtl-shell-design/references/build.md). See
  [docs/development.md](docs/development.md).

`main` is the only long-lived branch. Work lands there through pull requests to
`nckrtl/conn`.

## Relationship to T3 Code

- Conn began as a fork of pingdotgg/t3code (MIT). The code it took keeps T3 Tools' copyright
  notice in [LICENSE](LICENSE).
- Full upstream merges ended. The last one into `main` is `51f9f0bdab` (2026-11-19), which
  merged upstream `05e3674636`. The nightly sync that ForkBot and the Grok bot ran has
  stopped. The `sync/2026-11-22-s4` to `sync/2026-11-22-s8` branches were never merged.
- The `upstream` remote is fetch-only. Never push to pingdotgg/t3code or open pull requests,
  issues or comments there.
- Upstream is now a read-only source of provider fixes. They are ported into the Conn Server
  through the `audit-t3-providers` skill, which records its progress in the checkpoint below.

## Provider audit checkpoint

The [`audit-t3-providers`](.agents/skills/audit-t3-providers/SKILL.md) skill reads this block
to find its review window and updates it after each full-scope audit (all four providers plus
engine, contract and MCP); the skill defines that scope. Keep the field names.

<!-- provider-audit-checkpoint:start -->

- **Upstream reviewed through:** `05e36746364bef7778ee9f2cc07dc2a3d4fe210b`
- **Conn tested against:** `51f9f0bdabe15b3287910e85f6d4952140fd9b48`
- **Date:** 2026-11-19
- **Report:** none. This baseline is the last full upstream merge, not an audited point.
  Conn PRs #438, #457 and #459 record no explicit "reviewed through" SHA.
- **Unexamined areas:** every upstream provider change after this SHA.

<!-- provider-audit-checkpoint:end -->

## Legacy TypeScript apps

`apps/web`, `apps/desktop`, `apps/mobile`, `apps/server` and the TypeScript packages they use
are legacy. They will be removed once the GPUI and iOS clients reach parity. No new feature
work goes there.

Until then they stay the design reference for the native clients: `apps/conn-gpui/AGENTS.md`
takes every pixel, token and behaviour from `apps/web`, `apps/desktop` and
[apps/conn-gpui/docs/reference/conn-features.md](apps/conn-gpui/docs/reference/conn-features.md). The Conn Server's tools also read the
contract, the web client and `apps/server` from this tree.

The upstream-only workflows keep their `github.repository == 'pingdotgg/t3code'` guards. They
go with the legacy apps.

## Where the old fork notes went

| Content                                                                                                                                                                                              | Now in                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Conn features of the legacy apps ("What the fork changes": Shell design, Icons, Workspaces, Orbit, the panels, Linked environments, i18n and the app name, Provider CLIs, Codex MCP network wait, …) | [apps/conn-gpui/docs/reference/conn-features.md](apps/conn-gpui/docs/reference/conn-features.md), same headings |
| Conn Server scope, "Not served, by decision", platform and host scope                                                                                                                                | [apps/conn-server/docs/scope.md](apps/conn-server/docs/scope.md)                                                |
| Legacy build and signing, Vendored dependency patches, Pull request runners                                                                                                                          | [docs/development.md](docs/development.md)                                                                      |
| Upstream sync procedure, sync audits and sync notes                                                                                                                                                  | Removed. They are in this file's git history up to `70560d579a`.                                                |
