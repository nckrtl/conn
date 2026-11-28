#!/usr/bin/env bash
# The audit kit: runs the comparisons against the T3 server's own code, in order, and prints a
# summary. The `audit-t3-providers` skill runs it; CI never does. No tool calls a model: the
# providers run on stub CLIs and recordings.
# Usage: tools/audit.sh [--from <upstream sha> --to <upstream sha>]
# The tools read the TypeScript tree of the Conn monorepo this folder sits in (two levels up,
# tools/monorepo.mjs), so run `vp i` at the monorepo root first, and `npm ci` in
# helpers/sdk-host for the Claude tools. With --from and --to it ends with
# tools/bump-report.mjs: the upstream commits in that range for each part of the server
# (tools/upkeep/followed-files.txt), frozen parts included.
#
# Adopting upstream changes writes files, so it is not part of this run. Run these by hand:
#   node crates/conn-provider-codex/tools/capture-ts-events.mjs        # testdata/ts, testdata/cli
#   node crates/conn-provider-acp/tools/capture-ts-events.mjs          # testdata/grok, antigravity
#   crates/conn-provider-claude/tools/capture-ts/run.sh                # Claude testdata
#   node crates/conn-provider-codex/tools/gen-model-catalog.mjs        # src/model_catalog.json
#   node crates/conn-provider-acp/tools/gen-model-catalog.mjs          # antigravity_catalog.json
#   crates/conn-provider-claude/tools/gen-catalog/run.sh               # src/model_catalog.json
# and copy apps/server/src/provider/model-manifest.json to
# crates/conn-server/src/model_manifest/bundled.json.
set -u
from=""
to=""
while [ "$#" -ne 0 ]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --to) to="${2:-}"; shift 2 ;;
    *) echo "Usage: tools/audit.sh [--from <sha> --to <sha>]" >&2; exit 2 ;;
  esac
done
if [ -n "$from$to" ] && { [ -z "$from" ] || [ -z "$to" ]; }; then
  echo "tools/audit.sh: --from and --to go together." >&2
  exit 2
fi
group=all
. "$(dirname "${BASH_SOURCE[0]}")/check-lib.sh"
if [ ! -d "$monorepo/node_modules" ]; then
  echo "tools/audit.sh: $monorepo has no node_modules; run vp i at the monorepo root first." >&2
  exit 1
fi

run audit 1200 "release build" cargo build --locked --release -p conn-server --bins --example text_generation
# The Claude Agent SDK pin in helpers/sdk-host against the T3 server's lockfile.
run audit 60 "sdk pin" node tools/sdk-pin.mjs
# Codex: argv, environment, stdin and wire against T3's adapter on a stub CLI (no CLI, no model).
run audit 900 "codex conformance" node crates/conn-provider-codex/tools/conformance.mjs
# Codex's status entry: T3's checkCodexProviderStatus and ours against stub CLIs (about 45 s,
# two scenarios wait out the 20 s probe limit).
run audit 180 "codex probe conformance" node crates/conn-provider-codex/tools/probe-conformance/run.mjs
run audit 120 "codex model catalog --check" node crates/conn-provider-codex/tools/gen-model-catalog.mjs --check
# The Claude conformance checks run the real Agent SDK in the SDK host.
if has_sdk_host; then
  run audit 240 "claude conformance" crates/conn-provider-claude/tools/conformance/run.sh
  # Claude's status entry: T3's checkClaudeProviderStatus and ours against stub CLIs.
  run audit 180 "claude probe conformance" node crates/conn-provider-claude/tools/probe-conformance/run.mjs
else
  skip "claude conformance" "helpers/sdk-host has no node_modules (run npm ci in helpers/sdk-host)"
  skip "claude probe conformance" "helpers/sdk-host has no node_modules"
fi
run audit 120 "claude catalog --check" crates/conn-provider-claude/tools/gen-catalog/run.sh --check
# T3's own Claude transcripts against our session; exactly the scenarios in
# expected-failures.txt may fail.
run audit 180 "claude t3-replay" node crates/conn-provider-claude/tools/t3-replay/check.mjs
# The T3 Grok adapter and conn-provider-acp against one stub agent (no agent, no model).
run audit 480 "acp conformance" node crates/conn-provider-acp/tools/conformance.mjs
# T3's Antigravity driver and adapter against ours on a recorded `agy acp` (no agent, no model).
run audit 240 "antigravity conformance" node crates/conn-provider-acp/tools/antigravity-conformance.mjs
# T3's Grok status probe and ours against one stub CLI per scenario.
run audit 180 "grok probe conformance" node crates/conn-provider-acp/tools/probe-conformance.mjs
run audit 120 "antigravity model catalog --check" node crates/conn-provider-acp/tools/gen-model-catalog.mjs --check
# T3's testkit fixtures through this engine and our providers, judged by T3's own assertions;
# exactly the variants in its expected-failures.txt may fail (about 10 min).
run audit 480 "t3 fixture replay" node crates/conn-engine/tools/t3-fixture-replay/check.mjs
# Provider sign-in: every provider.auth.* reply and the CLI runs on both servers (stub CLIs).
run audit 180 "provider-auth-diff" node crates/conn-server/tools/provider-auth-diff.mjs "$release/conn-server"
# Text generators and thread titles against T3's own code, on a loopback stub (no model).
run audit 120 "textgen-diff" node crates/conn-server/tools/textgen-diff.mjs "$release/examples/text_generation"

if [ -n "$from" ]; then
  printf '\n== Upstream commits %s..%s\n' "$from" "$to"
  node tools/bump-report.mjs --before "$repo" --from "$from" --to "$to" --checks "$summary" \
    --binary "$release/conn-server"
fi

finish
