#!/usr/bin/env bash
# The Project's task check for Orbit task copies (Project 86, conn): the Conn Server's fast
# Rust gates, timed, with Orbit's delivery receipt written beside the copy's git state.
#
# Orbit reads the receipt at `<git dir>/orbit-handoff/delivery.json` after a turn and accepts a
# delivery only when it names the head commit and its tree (Orbit's delivery-receipt contract,
# as its bin/task-check writes it): one line of JSON,
#   {"commit": <sha>, "tree": <sha>, "parts": [{"name", "result": "passed"|"FAILED", "seconds"}]}
# A dirty tree is recorded as a synthetic commit of the working tree on top of HEAD
# (`git commit-tree`), as bin/task-check does. The script exits non-zero when a part failed.
#
# Usage: tools/orbit-task-check.sh   (from anywhere in the checkout)
set -u

root="$(git rev-parse --show-toplevel)" || exit 2
cd "$root" || exit 2
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

commit="$(git rev-parse HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"
if [ -n "$(git status --porcelain)" ]; then
  # The working tree as a commit: an index seeded from HEAD keeps tracked files that match an
  # ignore rule, which `git add --all` on an empty index would drop.
  index="$(mktemp)"
  rm -f "$index"
  GIT_INDEX_FILE="$index" git read-tree HEAD
  GIT_INDEX_FILE="$index" git add --all
  tree="$(GIT_INDEX_FILE="$index" git write-tree)"
  rm -f "$index"
  commit="$(git commit-tree "$tree" -p HEAD -m "orbit-task-check: working tree")"
fi

receipt="$(git rev-parse --path-format=absolute --git-path orbit-handoff/delivery.json)"
mkdir -p "$(dirname "$receipt")"
joined="$(IFS=,; echo "${parts[*]}")"
printf '{"commit":"%s","tree":"%s","parts":[%s]}\n' "$commit" "$tree" "$joined" >"$receipt.tmp"
mv "$receipt.tmp" "$receipt"
echo "orbit-task-check: receipt $receipt (commit $commit)" >&2
exit "$failed"
