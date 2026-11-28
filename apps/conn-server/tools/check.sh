#!/usr/bin/env bash
# Runs every check that needs no model and no TypeScript, in order, and prints a summary. CI
# runs the same checks (.github/workflows/conn-server-checks.yml): `--group rust` and
# `--group flows` in two jobs.
# Usage: tools/check.sh [--group rust|flows]
# The comparisons against the T3 server are the audit kit (tools/audit.sh), not checks.
# No check calls a model: the flows use `examples/replay_server` (the engine's fake provider)
# or recording stubs. Every server gets a temp state folder.
set -u
group=all
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != --group ]; then
    echo "Usage: tools/check.sh [--group rust|flows]" >&2
    exit 2
  fi
  case "$2" in rust|flows) group="$2" ;; *) echo "Unknown check group: $2" >&2; exit 2 ;; esac
fi
. "$(dirname "${BASH_SOURCE[0]}")/check-lib.sh"

# CI and the release build install the toolchain by name; it must be the one
# rust-toolchain.toml pins. The workflows live in the monorepo's .github.
toolchain_pin() {
  local pinned ci workflow
  pinned="$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"
  for workflow in "$monorepo"/.github/workflows/conn-server-{ci,checks,release}.yml; do
    ci="$(sed -n 's/^  RUST_TOOLCHAIN: "\(.*\)"$/\1/p' "$workflow")"
    if [ -z "$pinned" ] || [ "$pinned" != "$ci" ]; then
      printf 'rust-toolchain.toml pins %s; %s installs %s\n' "$pinned" "$workflow" "$ci"
      return 1
    fi
  done
}

decode_check() {
  CARGO_TARGET_DIR="$repo/target" cargo test --locked --manifest-path fixtures/decode-check/Cargo.toml
}

run rust 30 "timeout wrapper" bash tools/check-timeout.test.sh
run rust 60 "toolchain pin" toolchain_pin
run rust 120 "cargo fmt --check" cargo fmt --check
run rust 600 "cargo clippy" cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
run rust 900 "cargo test" cargo test --locked --workspace --no-fail-fast
run rust 300 "decode check" decode_check
# The Gateway client types and ops match the pinned openapi.json (crates/conn-gateway-api).
run rust 300 "gateway-api --check" cargo run --locked -q -p conn-gateway-api --features gen -- --check
# Advisories, licences, bans and sources (deny.toml). Advisories need network access for the
# RustSec database; DENY_OFFLINE=1 (`cargo deny --offline`) uses the cached copy.
if [ "$group" = all ] || [ "$group" = rust ]; then
  if command -v cargo-deny >/dev/null 2>&1; then
    run rust 300 "cargo deny" cargo deny --locked ${DENY_OFFLINE:+--offline} check
  else
    skip "cargo deny" "cargo-deny is not installed (cargo install cargo-deny --locked)"
  fi
fi
# Hand runs are sealed: plain `cargo test` with a decoy outer environment, the way out, and
# the runner order (tools/sealed-run-check.mjs).
run rust 180 "sealed-run" node tools/sealed-run-check.mjs

# Every example compiles, so the audit kit's examples cannot rot unseen.
run flows 1200 "release build" cargo build --locked --release --workspace --bins --examples --features fake-provider
# A capability is advertised if and only if what it promises is registered; every flag has a row.
run flows 120 "capabilities" node crates/conn-server/tools/capabilities-check.mjs "$release/conn-server"
run flows 120 "orbit-flow (fake provider)" \
  node crates/conn-server/tools/orbit-flow.mjs "$release/examples/replay_server"
# Claude and Codex instances from providerInstances, through the server, on recording stubs
# (no CLI, no model). Claude runs through the SDK host, so it needs `npm ci` in
# helpers/sdk-host.
if [ "$group" = all ] || [ "$group" = flows ]; then
  if has_sdk_host; then
    run flows 180 "instances-flow" node crates/conn-server/tools/instances-flow.mjs "$release/conn-server"
  else
    skip "instances-flow" "helpers/sdk-host has no node_modules (run npm ci in helpers/sdk-host)"
  fi
fi

finish
