---
name: audit-t3-providers
description: Check recent upstream T3 Code provider changes for bugs or improvements that apply to Conn’s Rust server. Use for provider checkups and for implementing selected findings when requested.
---

# Audit T3 provider changes for Conn

Conn Server has its own release history. Use upstream changes to find scenarios worth testing. Recommend a change when Conn users, the engine, or a supported provider would observe a meaningful difference.

## Establish the review window

Take the baseline, the last **upstream T3 commit actually examined**, from the "Provider audit checkpoint" block in `FORK.md`. Ask the user only if the block is missing. Fetch the default branches of `pingdotgg/t3code` and `nckrtl/conn` into separate refs. Check the remote URLs first; a fresh Conn clone may have only `origin`. Upstream is read-only: only fetch from it. Record three full SHAs: the T3 baseline, the T3 tip, and the Conn revision under test. A date-only request can use the upstream first-parent history at the requested time and timezone.

Verify the baseline is an ancestor of the T3 tip. Inspect `git log --oneline BASE..TIP` and `git diff --name-status BASE TIP` **within T3**. Conn's SHA identifies the code being tested. Comparing the two projects' heads or counting commits between them cannot establish provider behavior.

## Find changes that reach Conn

Start with Codex, Claude, Grok, and Antigravity unless the request or current Conn capability list gives a different scope. Scan the full commit subjects and changed paths before narrowing. Provider changes can land in orchestration, MCP, permissions, session recovery, shared contracts, usage reporting, SDK dependencies, or replay fixtures. Inspect the upstream patch and regression test together. Extract the triggering input, event order, expected result, and any CLI or SDK version boundary.

Read `apps/conn-server/docs/scope.md`, `apps/conn-server/AGENTS.md`, and the relevant crate README. Follow the scenario through the actual Conn implementation:

| Boundary                                                         | Starting point under `apps/conn-server/`                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Codex app-server requests, acknowledgements, and compaction      | `crates/conn-provider-codex`                                        |
| Claude SDK callbacks, policy decisions, and background work      | `helpers/sdk-host` and `crates/conn-provider-claude`                |
| Grok and Antigravity requests, approvals, and native sessions    | `crates/conn-provider-acp`, including each provider’s overrides     |
| Persisted turn state, handoffs, client events, and tool exposure | `crates/conn-engine`, `crates/conn-contract`, and `crates/conn-mcp` |

Check current Conn main and open Conn PRs for an equivalent fix. Distinguish fixes merged into Conn, work awaiting merge, and behavior verified on an installed server. Preserve Conn’s Orbit-owned authentication and routing when assessing upstream account or credential changes.

## Test the decision

Use an isolated checkout of the recorded Conn revision and the crate’s existing replay or conformance harness. Feed the upstream scenario through the Rust entry point with synthetic traffic. Observe the decision or output at the boundary that matters: an outbound native request, a prompt shown to the user, an engine row after reopen, or the next turn’s context. A green pre-existing suite is weak evidence if it never exercises the triggering case.

For example, an SDK callback reaching Conn proves only that the callback is wired. Follow the Rust reply to see whether Conn asks the user or sends an immediate allowance. For a CLI version change, replay both sides of the version boundary and record which binary was actually exercised. Reaching a native handshake proves less than completing an authenticated turn.

## Report or implement

For a checkup, lead with which changes Conn needs and why. For each recommendation, give the user-visible effect, the exact observed result, and links to the upstream change and pinned Conn code. Label source-only findings and missing runtime evidence. Briefly identify important cases Conn already handles or deliberately delegates to Orbit. An empty review window or zero applicable changes is a valid result.

Close the report with the **upstream SHA reviewed through**, plus the Conn SHA tested and any unexamined areas or pending replays. Carry unresolved cases into the next audit. The upstream SHA is a search checkpoint, independent of which fixes have merged.

Then update the checkpoint block in `FORK.md`: the upstream SHA reviewed through, the Conn SHA tested, the date, a link to the report or PR, and the unexamined areas (full SHAs). Commit it with the fix PR, or in a small PR of its own when nothing needed fixing.

When asked to implement, put the failing case in the owning Rust crate, fix the behavior through its normal entry point, and rerun the regression and affected conformance checks. Preserve older supported runtimes and stored data. Follow the server’s checks for shared contract or fixture changes. In the PR, link the source change and show what the same scenario did before and after the fix. PRs and issues go to `nckrtl/conn` only; pass `--repo nckrtl/conn` to every `gh` command. Never push to `pingdotgg/t3code`, and never open PRs, issues, or comments there.

[Conn PR #438](https://github.com/nckrtl/conn/pull/438) illustrates this workflow for approvals, Claude notifications, Codex compaction, and context handoff sizing.
