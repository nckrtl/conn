#!/bin/sh
# Offline checks for t3-orbit-register's runtime lookup and the job templates.
# Run: sh scripts/orbit/t3-orbit-register.test.sh   (needs python3 where PlistBuddy is missing)
set -u
here=$(cd "$(dirname "$0")" && pwd)
script="$here/t3-orbit-register"
# Run through sh: macOS can stall exec of a freshly extracted script while it assesses it.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failed=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1: $2"; failed=1; }

mkdir -p "$tmp/runtime/versions/1.2.3-test.1" "$tmp/Library/LaunchAgents"
bin="$tmp/runtime/versions/1.2.3-test.1/t3"
printf '#!/bin/sh\necho fake-t3 "$@"\n' > "$bin"
chmod +x "$bin"

write_plist() { # file arg...
    f=$1; shift
    {
        echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>x</string><key>ProgramArguments</key><array>'
        for a in "$@"; do echo "<string>$a</string>"; done
        echo '</array></dict></plist>'
    } > "$f"
}

write_plist "$tmp/Library/LaunchAgents/com.example.server.plist" "$bin" __service-launcher
out=$(HOME=$tmp sh "$script" --service-label com.example.server --print-cli http://127.0.0.1:1 2>&1)
[ "$out" = "$bin" ] && pass "label resolves ProgramArguments:0" || fail "label resolves ProgramArguments:0" "$out"

out=$(T3_SERVER_LABEL=com.example.server HOME=$tmp sh "$script" --print-cli http://127.0.0.1:1 2>&1)
[ "$out" = "$bin" ] && pass "T3_SERVER_LABEL env" || fail "T3_SERVER_LABEL env" "$out"

write_plist "$tmp/env.plist" /usr/bin/env T3CODE_HOME=/x FOO=bar "$bin" serve
out=$(sh "$script" --service-plist "$tmp/env.plist" --print-cli http://127.0.0.1:1 2>&1)
[ "$out" = "$bin" ] && pass "env wrapper skipped" || fail "env wrapper skipped" "$out"

write_plist "$tmp/gone.plist" "$tmp/runtime/versions/0.0.1-pruned/t3" serve
out=$(sh "$script" --service-plist "$tmp/gone.plist" --print-cli http://127.0.0.1:1 2>&1); rc=$?
[ "$rc" = 69 ] && pass "pruned runtime exits 69" || fail "pruned runtime exits 69" "rc=$rc $out"

out=$(sh "$script" --service-plist "$tmp/nope.plist" --print-cli http://127.0.0.1:1 2>&1); rc=$?
[ "$rc" = 66 ] && pass "missing plist exits 66" || fail "missing plist exits 66" "rc=$rc $out"

out=$(sh "$script" --service-plist "$tmp/env.plist" http://127.0.0.1:1 /usr/bin/t3 2>&1); rc=$?
[ "$rc" = 64 ] && pass "job plus CLI is a usage error" || fail "job plus CLI is a usage error" "rc=$rc $out"

out=$(sh "$script" --print-cli http://127.0.0.1:1 2>&1)
[ "$out" = "t3" ] && pass "default CLI is t3" || fail "default CLI is t3" "$out"

out=$(sh "$script" --print-cli http://127.0.0.1:1 "$bin" 2>&1)
case "$out" in *"versioned runtime path"*) pass "versioned CLI warns" ;; *) fail "versioned CLI warns" "$out" ;; esac

sh "$script" >/dev/null 2>&1; rc=$?
[ "$rc" = 64 ] && pass "no URL exits 64" || fail "no URL exits 64" "rc=$rc"

# Only the job's own arguments count, not the template comments.
if grep '<string>' "$here/com.nckrtl.t3-orbit-register.plist" | grep -q 'runtime/versions/'; then
    fail "plist template has no versioned path" "found runtime/versions/"
else
    pass "plist template has no versioned path"
fi
if grep '^ExecStart=' "$here/t3-orbit-register.service" | grep -q 'runtime/versions/'; then
    fail "systemd unit has no versioned path" "found runtime/versions/"
else
    pass "systemd unit has no versioned path"
fi
grep -q -- '--service-label' "$here/com.nckrtl.t3-orbit-register.plist" && pass "plist template uses --service-label" || fail "plist template uses --service-label" "missing"
if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$here/com.nckrtl.t3-orbit-register.plist" >/dev/null && pass "plist template lints" || fail "plist template lints" "plutil -lint"
fi

[ "$failed" = 0 ] && echo "PASS t3-orbit-register" || { echo "FAILED t3-orbit-register"; exit 1; }
