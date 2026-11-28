# Shared by tools/check.sh and tools/audit.sh: the canary, the sealed cargo, `run` and the
# summary. Source it after setting `group`; it changes to apps/conn-server.
# CHECK_SUMMARY=<file> also writes one line per check (`ok <name>`, `FAIL <name>`,
# `skip <name>`) to that file.
# The way out of the sealed cargo runner (tools/cargo-runner.mjs) is for hand runs only.
if [ -n "${CONN_UNSEALED:-}" ]; then
  echo "${0##*/}: CONN_UNSEALED is set; checks never run unsealed. Unset it." >&2
  exit 1
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
monorepo="$(cd "$repo/../.." && pwd)"
cd "$repo" || exit 1
. tools/check-timeout.sh

release="$repo/target/release"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-check.XXXXXX")"

# The canary (tools/canary.mjs): every check runs with a decoy HOME, marker variables in the
# shell, a stand-in SHELL and a TMPDIR the canary watches. The last check fails when a check
# read a decoy file, changed the decoy home, or let a marker reach its output or a file.
# Cargo and rustup keep their real folders, named here before HOME changes.
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
canary="$(mktemp -d /tmp/conn-canary.XXXXXX)"
canary_log="$canary/output.log"
canary_watch=""
cleanup() {
  [ -n "$canary_watch" ] && kill "$canary_watch" 2>/dev/null
  rm -rf "$scratch" "$canary"
}
trap cleanup EXIT
node tools/canary.mjs setup "$canary" || exit 1
# shellcheck source=/dev/null
. "$canary/env.sh"
: >"$canary_log"
node tools/canary.mjs watch "$canary" &
canary_watch=$!

# Cargo reads ~/.gitconfig through HOME (its git library ignores GIT_CONFIG_GLOBAL), so cargo
# runs with a throwaway HOME. A target runner gives the test and example binaries it starts
# the decoy HOME back, so the canary still sees what the code under test reads; their `git`
# runs get no global or system git configuration. This runner, set in the environment, wins
# over the sealed runner in .cargo/config.toml (proved by the sealed-run check): here the
# binaries must see the decoys, or the canary would prove nothing about the code. Tools that
# run cargo themselves drop it (sealedCargoEnv) and get the sealed runner.
canary_cargo_home="$canary/cargo-home"
mkdir -p "$canary_cargo_home"
cat >"$canary/runner" <<'RUNNER'
#!/bin/sh
if [ "$HOME" = "$CONN_CANARY_CARGO_HOME" ]; then HOME="$CONN_CANARY_TEST_HOME"; export HOME; fi
exec "$@"
RUNNER
chmod +x "$canary/runner"
canary_host="$(rustc -vV | sed -n 's/^host: //p' | tr 'a-z.-' 'A-Z__')"
export "CARGO_TARGET_${canary_host}_RUNNER=$canary/runner"
export CONN_CANARY_CARGO_HOME="$canary_cargo_home" CONN_CANARY_TEST_HOME="$HOME"
cargo() {
  HOME="$canary_cargo_home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 command cargo "$@"
}

passed=()
failed=()
skipped_tools=()
summary="${CHECK_SUMMARY:-$scratch/summary}"
: >"$summary"

# run <group> <limit in s> <name> <command...>: runs when `group` is all, that group, or the
# check's group is `always`.
run() {
  local check_group="$1" limit="$2" name="$3"
  shift 3
  [ "$group" = all ] || [ "$group" = "$check_group" ] || [ "$check_group" = always ] || return 0
  printf '\n==> %s\n' "$name"
  local started=$SECONDS status
  check_timeout "$limit" "$@" 2>&1 | tee -a "$canary_log"
  status=${PIPESTATUS[0]}
  node tools/canary.mjs mark "$canary" "$name"
  if [ "$status" -eq 0 ]; then
    passed+=("$name")
    printf 'ok %s\n' "$name" >>"$summary"
    printf '<== ok    %s (%ss)\n' "$name" $((SECONDS - started))
  else
    failed+=("$name")
    printf 'FAIL %s\n' "$name" >>"$summary"
    if [ "$status" -eq 124 ]; then
      printf '<== TIMEOUT %s (%ss, limit %ss)\n' "$name" "$((SECONDS - started))" "$limit"
    else
      printf '<== FAIL  %s (%ss)\n' "$name" $((SECONDS - started))
    fi
  fi
}

# skip <name> <why>: a check that cannot run here, never counted as passed.
skip() {
  printf '\n%s: skipping %s.\n' "$2" "$1"
  skipped_tools+=("$1")
}

has_sdk_host() {
  [ -d helpers/sdk-host/node_modules/@anthropic-ai/claude-agent-sdk ]
}

# The canary goes last: it reads what every check above left. Then the summary; the exit
# status says whether every check passed.
finish() {
  touch "$canary/stop"
  wait "$canary_watch"
  canary_watch=""
  canary_check() {
    node tools/canary.mjs selftest && node tools/canary.mjs verify "$canary" "$canary_log" "$scratch"
  }
  run always 120 "canary" canary_check

  printf '\n== Summary\n'
  printf 'passed  %d\n' "${#passed[@]}"
  for name in "${failed[@]+"${failed[@]}"}"; do printf 'FAILED  %s\n' "$name"; done
  for name in "${skipped_tools[@]+"${skipped_tools[@]}"}"; do
    printf 'skipped %s (a tool or npm ci is missing; see above)\n' "$name"
    printf 'skip %s\n' "$name" >>"$summary"
  done
  [ "${#failed[@]}" -eq 0 ]
}
