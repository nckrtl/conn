#!/usr/bin/env bash
# Tests tools/orbit-task-check.sh on a throwaway git checkout with a stub `cargo`: the receipt
# names HEAD and its tree, a dirty checkout and an unwritable receipt fail without a receipt,
# and a failing part exits non-zero. Usage: bash tools/orbit-task-check.test.sh
set -u

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/orbit-task-check.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}

mkdir -p "$work/bin" "$work/home" "$work/repo/apps/conn-server" "$work/repo/tools"
printf '#!/bin/sh\nexit "${STUB_CARGO_EXIT:-0}"\n' >"$work/bin/cargo"
chmod +x "$work/bin/cargo"
cp "$script" "$work/repo/tools/orbit-task-check.sh"
chmod +x "$work/repo/tools/orbit-task-check.sh"
touch "$work/repo/apps/conn-server/.keep"
export HOME="$work/home" PATH="$work/bin:$PATH" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
cd "$work/repo" || exit 1
git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm fixture
receipt="$(git rev-parse --path-format=absolute --git-path orbit-handoff/delivery.json)"
run() { tools/orbit-task-check.sh >/dev/null 2>&1; }

run
code=$?
check "a clean pass exits 0" '[ "$code" -eq 0 ]'
check "the receipt names HEAD and its tree, three parts passed" \
  'node -e '"'"'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(r.commit!==process.argv[2]||r.tree!==process.argv[3]||r.parts.length!==3
       ||r.parts.some(p=>p.result!=="passed"))process.exit(1)'"'"' \
    "$receipt" "$(git rev-parse HEAD)" "$(git rev-parse "HEAD^{tree}")"'

STUB_CARGO_EXIT=1 run
code=$?
check "a failing part exits non-zero" '[ "$code" -ne 0 ]'
check "the receipt records the failure" 'grep -q "\"FAILED\"" "$receipt"'

rm -f "$receipt"
echo dirty >untracked.txt
run
code=$?
check "a dirty checkout is refused" '[ "$code" -ne 0 ]'
check "a dirty checkout gets no receipt" '[ ! -e "$receipt" ]'
rm -f untracked.txt

rm -rf "$(dirname "$receipt")"
: >"$(dirname "$receipt")"
run
code=$?
check "an unwritable receipt destination exits non-zero" '[ "$code" -ne 0 ]'

[ "$failures" -eq 0 ] || { echo "$failures failed"; exit 1; }
echo "all passed"
