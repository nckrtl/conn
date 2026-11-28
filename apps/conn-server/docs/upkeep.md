# Upkeep: keep the Conn Server in step with upstream T3

CI runs only native checks: `tools/check.sh` needs nothing outside `apps/conn-server` and no
TypeScript. The comparisons against the T3 server are the audit kit, `tools/audit.sh`, which
the `audit-t3-providers` skill runs. No step calls a model.

## When the checks run

- `conn-server-checks.yml` (`tools/check.sh`): every pull request starts it; its `changes`
  job runs the checks only when the diff touches what they read
  (`.github/scripts/conn-server-checks-paths.cjs`: `apps/conn-server/**`, the root
  `rustfmt.toml`, the three Conn Server workflows and the selector). Pushes to main always
  run it. Two jobs: `--group rust` (format, clippy, tests, decode check, gateway-api, cargo
  deny, sealed run) and `--group flows` (release build with every example, capabilities,
  orbit-flow, instances-flow). Both end with the canary. The final `Conn Server checks` gate
  fails if either fails.
- `conn-server-ci.yml` (production musl build): pull requests and main pushes that touch
  `apps/conn-server/**` or the workflow.
- `conn-server-release.yml`: a `conn-server-v*` tag.

Only main pushes save Rust caches. Each check has a timeout that stops its process group;
each CI job also has a time limit.

## Frozen files

The contract, the `/mcp` catalog and texts, the upstream tables, the instruction texts and the
case files were generated from Conn's TypeScript tree until the generators were removed. They
are hand-owned since upstream T3 Code `05e3674636`; README.md, "Frozen files", lists them. A
change is an edit by hand with a test. Regenerating them from upstream would delete Conn's own
features, so upstream changes to their sources are ported by hand: the audit's report lists
them per part.

## The audit

Full upstream merges ended after 2026-11-19 (`FORK.md`, "Relationship to T3 Code"). Upstream
provider fixes are ported by hand through the `audit-t3-providers` skill; scope is the
container profile, the areas `docs/orbit-profile.md` rates needed or useful.

`tools/audit.sh [--from <sha> --to <sha>]` runs, with the canary:

- the provider comparisons: Codex, Claude, ACP (Grok) and Antigravity conformance; the Codex,
  Claude and Grok probe conformance; the Claude T3 replay; the T3 fixture replay;
- `provider-auth-diff` and `textgen-diff`;
- the frozen model catalogs (`--check`) and the Claude Agent SDK pin (`tools/sdk-pin.mjs`);
- with `--from` and `--to`, `tools/bump-report.mjs`: the upstream commits in that range for
  each part (`tools/upkeep/followed-files.txt`), frozen parts included.

It needs `vp i` at the monorepo root and `npm ci` in `helpers/sdk-host`, and it reads the
TypeScript tree of this monorepo. Run it in your own checkout or worktree: the capture tools put
temporary test files into the monorepo's `apps/server`.

An in-scope change that cannot be ported yet becomes a known difference with its reason, in
the tool's known list and in `docs/status.md`. A tool is never weakened to pass.

Source-control parity follows only GitHub and the core registry's unknown-host fallback
(`docs/scope.md`, "Platforms and hosts"). The followed files include source-control core and
GitHub, but no other host packages.

### Adopt upstream changes

The capture tools (`crates/conn-provider-codex/tools/capture-ts-events.mjs`,
`crates/conn-provider-acp/tools/capture-ts-events.mjs`,
`crates/conn-provider-claude/tools/capture-ts/run.sh`) bring new upstream fixtures into the
provider crates' `testdata`; `tools/reference-events.mjs` then puts back every reference file
whose events did not change, so `git diff` shows only real changes. The catalog generators
without `--check` refresh the Codex, Antigravity and Claude catalogs, and a copy of the T3
server's `model-manifest.json` refreshes `crates/conn-server/src/model_manifest/bundled.json`.
The `cargo test` replays then hold them in CI. New models reach users with a Conn Server
release.

### When an audit tool is red

| Tool | Usual cause | Fix |
| --- | --- | --- |
| `codex conformance`, `claude conformance` | What a CLI is sent moved upstream (argv, environment, the spawn script, a prompt text) | Follow the adapter commits in the report. The diff names the field. A launch difference is a defect, never a listed exception. |
| `claude t3-replay` | A T3 Claude transcript changed its result | Fix the session; if it is a known gap, list it in `crates/conn-provider-claude/tools/t3-replay/expected-failures.txt` with the reason. A listed one that passes fails too: remove it. |
| `claude catalog --check` and the other catalogs | T3's bundled models moved | Run the generator without `--check`, and refresh `bundled.json`. |
| `sdk pin` | T3 moved its Claude Agent SDK | Move `helpers/sdk-host/package.json` and `npm install`, then rerun the Claude tools and the capture. |

## When a check is red

| Failed check | Usual cause | Fix |
| --- | --- | --- |
| `cargo test` in `scopes` | A payload-dependent scope rule changed | Follow `from_payload` and `HAND_PAYLOAD_RULES` in `scopes.rs`. |
| `cargo test engine_commands` | A command type the engine handles was dropped or renamed in the contract | Follow the rename in `crates/conn-engine/src/commands.rs`. |
| `capabilities` | The contract has a new capability flag, or a method was registered whose flag is still off | Give the flag a row in `crates/conn-server/tools/capabilities.json` that says what proves it. Turn the flag on in `environment.rs` only when the server serves what it promises; until then the row carries `off` with the reason. |
| `cargo clippy`, `cargo test`, `release build` | A changed method type | Follow the change in `crates/conn-server/src/methods`. |
| `cargo deny` | A new advisory | Plan the crate change; add a dated exception to `deny.toml` only with a reason. |

## Notes

- `tools/upkeep/followed-files.txt` maps upstream pathspecs to the part here that follows them
  (crates and some files of `conn-server`). Add a pathspec when a part starts to follow a
  file. The report lists new upstream files no part follows; that list is for reading.
- `tools/upkeep/http-routes.json` holds the T3 server's HTTP routes, and
  `tools/upkeep/mcp-tools.json` a digest of each T3 `/mcp` tool, both frozen. The report
  compares them with what this server registers.

## Bumps

Before the move into the monorepo (2026-11-15) the Conn Server pinned one Conn commit in
`conn.pin` and moved it with `tools/bump-conn.sh`. These are the records of those bumps.

### 2026-11-14: b685417bb6 → b12470dcad

The first real bump: 278 Conn commits (an upstream merge of 266), about 300 files. About
four hours, most of it reading upstream changes and finishing the tools.

- **Red at the raw bump (13 checks):** the build broke on two contract changes
  (`ClientServerSettingsPatch`, `AuthPairingLink.connectDeviceRequest`), so every check that
  needs the binary failed; the Codex instruction text was stale, because the bump did not
  run its generator. Two tests held the method count by hand.
- **Found by reading, not by a check:** the access scope of `requireConnectDeviceApproval`,
  the client patch keys, two allowed tools in Claude's read-only list, the new Claude spawn
  script and system prompt text. Each now has a generator or a check.
- **Providers:** SDK 0.3.321 and Codex 0.166.0 did not move. Claude conformance: no
  differences after the spawn script and prompt fix. T3 replay: 15 of 18 pass, the same 3
  as before. Codex conformance: no open difference after the text regeneration. Codex
  answers now keep the native question id. Not followed: Codex Stop that waits for "Force
  stop" (the engine has no unresponsive Stop), T3's reaping of a recorded Claude CLI after a
  restart, the Claude Monitor wake and self-resumed subagent rows, skill mentions from
  handoff history, `autoCompactEnabled`.
- **Served shapes:** `thread.metadata.update` continuation, `projects.listIgnoredFiles`
  query, `serverTime`, and the `/mcp` thread list and read changes are followed and tested.
- **New upstream, not served:** `pullRequests.subscribeLinkedThreadRefreshes`; HTTP
  `/api/auth/connect-devices/approve` and `/revoke` (T3 Connect device approval); the `/mcp`
  tools `send_to_user`, `conn_theme_read`, `conn_theme_set`; environment themes.
- **Tools changed:** see the table above; the report starts with "What to do".

## Rehearsing on a copy of a state folder

A Conn Server started on a copy of a T3 home imports the threads that were running there and,
like the T3 server after a restart, continues them. On a copy that repeats the original's work
(git pushes, PRs) while the original still runs. Start every copy with `CONN_SERVER_INERT=1`:
no providers, no run recovery, no checkpoints, no scheduled-task timer or webhooks, no task
followers, peer links, pull request sweeps or actions, and the sessions carried from T3 are
dropped, so the original's clients cannot reach the copy. Imports, pairing and every read
still work for a client paired with the copy itself. The real switch runs without it, so
in-flight runs continue as after a T3 restart (`crates/conn-engine/src/restart.rs`).
