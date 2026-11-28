#!/usr/bin/env bash
# The Project's task check for Orbit task copies (Project 86, conn): the Conn Server's fast
# Rust gates, timed, with Orbit's delivery receipt written beside the copy's git state.
#
# Orbit reads the receipt at `<git dir>/orbit-handoff/delivery.json` after a turn and accepts a
# delivery only when it names the head commit and its tree (Orbit's delivery-receipt contract,
# as its bin/task-check writes it): one line of JSON,
#   {"commit": <sha>, "tree": <sha>, "parts": [{"name", "result": "passed"|"FAILED", "seconds"}]}
# The receipt certifies HEAD, so a dirty checkout is refused before any part runs. The script
# exits non-zero when a part failed or the receipt could not be written.
#
# Usage: tools/orbit-task-check.sh   (from anywhere in the checkout)
set -u

fail() {
  echo "orbit-task-check: $*" >&2
  exit 2
}

root="$(git rev-parse --show-toplevel)" || fail "not in a git checkout"
cd "$root" || fail "cannot enter $root"
if [ -n "$(git status --porcelain)" ]; then
  fail "the checkout has uncommitted changes; commit them first (the receipt names HEAD)"
fi
commit="$(git rev-parse HEAD)" || fail "cannot resolve HEAD"
tree="$(git rev-parse 'HEAD^{tree}')" || fail "cannot resolve the tree of HEAD"
receipt="$(git rev-parse --path-format=absolute --git-path orbit-handoff/delivery.json)" ||
  fail "cannot resolve the receipt path"
# shellcheck source=/dev/null
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

parts=()
failed=0
run_part() {
  local name="$1"
  shift
  local start end result
  start=$(date +%s)
  if (cd apps/conn-server && "$@"); then
    result=passed
  else
    result=FAILED
    failed=1
  fi
  end=$(date +%s)
  echo "orbit-task-check: $name $result ($((end - start))s)" >&2
  parts+=("{\"name\":\"$name\",\"result\":\"$result\",\"seconds\":$((end - start))}")
}

run_part "cargo fmt" cargo fmt --check
run_part "cargo clippy" cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
run_part "cargo test conn-server" cargo test --locked -p conn-server

# The parts must not have changed the checkout the receipt describes.
[ -z "$(git status --porcelain)" ] || fail "the checkout changed while the check ran"
mkdir -p "$(dirname "$receipt")" || fail "cannot create $(dirname "$receipt")"
joined="$(IFS=,; echo "${parts[*]}")"
printf '{"commit":"%s","tree":"%s","parts":[%s]}\n' "$commit" "$tree" "$joined" >"$receipt.tmp" ||
  fail "cannot write $receipt.tmp"
mv -f "$receipt.tmp" "$receipt" || fail "cannot move the receipt into $receipt"
echo "orbit-task-check: receipt $receipt (commit $commit)" >&2
exit "$failed"
