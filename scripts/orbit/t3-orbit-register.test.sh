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

# Registration flow with fake t3 and curl: revoke only when the Gateway answered and refused.
if command -v jq >/dev/null 2>&1; then
    mkdir -p "$tmp/fake"
    cat > "$tmp/fake/curl" <<'EOF'
#!/bin/sh
echo "$*" >> "$FAKE_DIR/curl.log"
for a in "$@"; do last=$a; done
case "$last" in */.well-known/*) echo '{"environmentId":"env-1","label":"test"}'; exit 0 ;; esac
cat > "$FAKE_DIR/body"
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
echo '{"data":{"admin_session_expires_at":"later"}}' > "$out"
[ "$FAKE_STATUS" = 000 ] && exit 28
printf '%s' "$FAKE_STATUS"
EOF
    cat > "$tmp/fake/t3" <<'EOF'
#!/bin/sh
echo "$*" >> "$FAKE_DIR/t3.log"
case "$*" in *"session issue"*) echo '{"sessionId":"s-1","token":"tok-secret"}' ;; esac
EOF
    chmod +x "$tmp/fake/curl" "$tmp/fake/t3"
    rm -f "$tmp/curl.log"
    for c in 200:keep:0:Registered 409:revoke:1:answered 503:keep:1:kept 000:keep:1:kept; do
        st=${c%%:*}; rest=${c#*:}; want=${rest%%:*}; rest=${rest#*:}; want_rc=${rest%%:*}; want_out=${rest#*:}
        rm -f "$tmp/t3.log" "$tmp/body"
        out=$(FAKE_DIR=$tmp FAKE_STATUS=$st PATH="$tmp/fake:$PATH" sh "$script" http://127.0.0.1:1 2>&1); rc=$?
        if grep -q 'session revoke s-1' "$tmp/t3.log" 2>/dev/null; then got=revoke; else got=keep; fi
        if [ "$got" = "$want" ] && [ "$rc" = "$want_rc" ] && grep -q 'session issue' "$tmp/t3.log" 2>/dev/null \
            && case "$out" in *"$want_out"*) true ;; *) false ;; esac; then
            pass "status $st: session $want"
        else
            fail "status $st: session $want" "rc=$rc got=$got $out"
        fi
        grep -q 'tok-secret' "$tmp/t3.log" && fail "status $st: token off t3 argv" "seen"
    done
    grep -q 'tok-secret' "$tmp/curl.log" && fail "token stays off argv" "seen in curl argv" || pass "token stays off argv"
    jq -e '.admin_session == "tok-secret" and .environment_id == "env-1"' "$tmp/body" >/dev/null 2>&1 \
        && pass "token sent in body" || fail "token sent in body" "$(cat "$tmp/body" 2>/dev/null)"
else
    echo "skip registration flow (no jq)"
fi

# The loaded launchd job wins over the plist file: on 2026-11-06 the mini's server plist was rewritten
# as a bare JSON array, PlistBuddy could not read it, and registration failed for a week.
mkdir -p "$tmp/fakelaunchctl"
cat > "$tmp/fakelaunchctl/launchctl" <<FAKE
#!/bin/sh
[ "\$1" = print ] && [ "\$2" = "gui/\$(id -u)/com.example.loaded" ] || exit 113
printf 'gui/501/com.example.loaded = {\n\tpath = /x.plist\n\tprogram = %s\n\targuments = {\n\t\t%s\n\t\t__service-launcher\n\t}\n\n\tenvironment = {\n\t\tA => b\n\t}\n}\n' "$bin" "$bin"
FAKE
chmod +x "$tmp/fakelaunchctl/launchctl"
printf '["%s","__service-launcher"]' "$bin" > "$tmp/Library/LaunchAgents/com.example.loaded.plist"
out=$(HOME=$tmp PATH="$tmp/fakelaunchctl:$PATH" sh "$script" --service-label com.example.loaded --print-cli http://127.0.0.1:1 2>&1)
[ "$out" = "$bin" ] && pass "label resolves the loaded job over a broken plist" || fail "label resolves the loaded job over a broken plist" "$out"
rm "$tmp/Library/LaunchAgents/com.example.loaded.plist"
out=$(HOME=$tmp PATH="$tmp/fakelaunchctl:$PATH" sh "$script" --service-label com.example.loaded --print-cli http://127.0.0.1:1 2>&1)
[ "$out" = "$bin" ] && pass "label resolves the loaded job without a plist" || fail "label resolves the loaded job without a plist" "$out"

if command -v plutil >/dev/null 2>&1; then
    printf '{"Label":"x","ProgramArguments":["%s","serve"]}' "$bin" > "$tmp/json.plist"
    out=$(sh "$script" --service-plist "$tmp/json.plist" --print-cli http://127.0.0.1:1 2>&1)
    [ "$out" = "$bin" ] && pass "JSON plist resolves" || fail "JSON plist resolves" "$out"
    printf '["%s","serve"]' "$bin" > "$tmp/array.plist"
    out=$(sh "$script" --service-plist "$tmp/array.plist" --print-cli http://127.0.0.1:1 2>&1); rc=$?
    [ "$rc" = 65 ] && pass "bare-array plist exits 65" || fail "bare-array plist exits 65" "rc=$rc $out"
fi

# t3-orbit-relink: the same lookup, and a failed list fails the run.
relink="$here/t3-orbit-relink"
if command -v jq >/dev/null 2>&1; then
    cp "$script" "$tmp/t3-orbit-register"; cp "$relink" "$tmp/t3-orbit-relink"
    printf '#!/bin/sh\necho "$*" >> "%s/relink-t3.log"\ncase "$*" in "environment list --json") echo "[]" ;; esac\n' "$tmp" > "$bin"
    out=$(HOME=$tmp PATH="$tmp/fakelaunchctl:$PATH" sh "$tmp/t3-orbit-relink" --service-label com.example.loaded 2>&1); rc=$?
    { [ "$rc" = 0 ] && grep -q 'environment list --json' "$tmp/relink-t3.log"; } \
        && pass "relink uses the loaded job" || fail "relink uses the loaded job" "rc=$rc $out"
    out=$(HOME=$tmp sh "$tmp/t3-orbit-relink" --service-label com.example.missing 2>&1); rc=$?
    [ "$rc" = 66 ] && pass "relink with an unknown job exits 66" || fail "relink with an unknown job exits 66" "rc=$rc $out"
    printf '#!/bin/sh\necho broken >&2\nexit 3\n' > "$tmp/fake-failing-t3"; chmod +x "$tmp/fake-failing-t3"
    out=$(sh "$tmp/t3-orbit-relink" "$tmp/fake-failing-t3" 2>&1); rc=$?
    [ "$rc" = 1 ] && pass "relink fails when the list fails" || fail "relink fails when the list fails" "rc=$rc $out"
    printf '#!/bin/sh\necho fake-t3 "$@"\n' > "$bin"
else
    echo "skip relink (no jq)"
fi
if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$here/com.nckrtl.t3-orbit-relink.plist" >/dev/null && pass "relink plist lints" || fail "relink plist lints" "plutil -lint"
fi
grep -q 'PlistBuddy' "$here/com.nckrtl.t3-orbit-relink.plist" && fail "relink plist has no PlistBuddy" "found" || pass "relink plist has no PlistBuddy"

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
