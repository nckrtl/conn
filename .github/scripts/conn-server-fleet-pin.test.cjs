const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");

const tag = "conn-server-v0.5.2";
const branch = `release/${tag}`;
const source = "c226a97f9ee5d5c564441c2117f33b10a412de1c";
const prUrl = "https://example.invalid/orbit/pull/1";

function recover(t, { extraChange = false, openPr = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "conn-fleet-pin-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const env = {
    HOME: scratch,
    PATH: `${scratch}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Release test",
    GIT_AUTHOR_EMAIL: "release@example.invalid",
    GIT_COMMITTER_NAME: "Release test",
    GIT_COMMITTER_EMAIL: "release@example.invalid",
    GITHUB_STEP_SUMMARY: join(scratch, "summary"),
    PIN_BODY: join(scratch, "pr-body"),
    PR_CREATED: join(scratch, "pr-created"),
    PR_RESPONSE: openPr
      ? JSON.stringify({ html_url: prUrl, state: "open", body: `Conn-Source: ${source}` })
      : "{}",
    TAG: tag,
    SOURCE_SHA: source,
  };
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  writeFileSync(
    join(scratch, "gh"),
    `#!/bin/bash
case "$*" in
  'api /installation/repositories '*) echo true ;;
  'api --method GET repos/hardimpactdev/orbit/pulls '*) echo "$PR_RESPONSE" ;;
  'auth setup-git '*) ;;
  'pr create '*) touch "$PR_CREATED"; echo '${prUrl}' ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const seed = join(scratch, "seed");
  const origin = pathToFileURL(join(scratch, "origin.git")).href;
  const candidate = join(scratch, "candidate");
  git(scratch, "init", "--bare", "--initial-branch=main", "origin.git");
  git(scratch, "init", "--initial-branch=main", seed);
  writeFileSync(join(seed, "recipe.json"), "0.5.1\n");
  writeFileSync(join(seed, "unrelated.txt"), "original\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Base");
  git(seed, "switch", "-c", branch);
  if (extraChange) {
    writeFileSync(join(seed, "unrelated.txt"), "unexpected\n");
    git(seed, "commit", "-am", "Change an unrelated file before the pin");
  }
  writeFileSync(join(seed, "recipe.json"), "0.5.2\n");
  git(seed, "commit", "-am", "Pin the release", "-m", `Conn-Source: ${source}`);
  git(seed, "switch", "main");
  writeFileSync(join(seed, "unrelated.txt"), "advanced on main\n");
  git(seed, "commit", "-am", "Advance main independently");
  git(seed, "push", origin, "main", branch);
  git(scratch, "clone", "--depth=1", origin, candidate);
  writeFileSync(join(candidate, "recipe.json"), "0.5.2\n");
  writeFileSync(env.PIN_BODY, `Conn-Source: ${source}\n`);
  const run = spawnSync("bash", [join(__dirname, "conn-server-fleet-pin.sh"), "propose"], {
    cwd: candidate,
    env,
    encoding: "utf8",
  });
  assert.ifError(run.error);
  return { run, env };
}

test("recovers a complete pin proposal from an earlier main commit", (t) => {
  const { run, env } = recover(t);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(env.PR_CREATED));
  assert.equal(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8").trim(), prUrl);
});

test("reuses an open PR for the matching complete pin proposal", (t) => {
  const { run, env } = recover(t, { openPr: true });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!existsSync(env.PR_CREATED));
  assert.equal(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8").trim(), prUrl);
});

for (const openPr of [false, true]) {
  test(`rejects unrelated changes on a release branch ${openPr ? "with an open PR" : "before opening a PR"}`, (t) => {
    const { run, env } = recover(t, { extraChange: true, openPr });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /complete release branch diff does not match/);
    assert.ok(!existsSync(env.PR_CREATED));
    assert.ok(!existsSync(env.GITHUB_STEP_SUMMARY));
  });
}

const published = 1_795_600_000;
const alertUrl = "https://example.invalid/conn/issues/1";

function watchDeadline(t, start, lookups) {
  const scratch = mkdtempSync(join(tmpdir(), "conn-fleet-deadline-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const env = {
    HOME: scratch,
    PATH: `${scratch}:${process.env.PATH}`,
    RUNNER_TEMP: scratch,
    GITHUB_RUN_ID: "1",
    TAG: tag,
    PUBLISHED: String(published),
    CLOCK: join(scratch, "clock"),
    LOOKUP_STARTS: join(scratch, "lookup-starts"),
    LOOKUPS: JSON.stringify(lookups),
    ISSUE_CREATED: join(scratch, "issue-created"),
  };
  const shim = (name, script) =>
    writeFileSync(join(scratch, name), `#!/bin/bash\nset -eu\n${script}\n`, { mode: 0o755 });
  writeFileSync(env.CLOCK, String(published + start));
  writeFileSync(env.LOOKUP_STARTS, "");
  shim("date", 'cat "$CLOCK"');
  shim("sleep", 'echo "$(($(cat "$CLOCK") + $1))" > "$CLOCK"');
  shim(
    "gh",
    `case "$*" in
  'api --method GET repos/hardimpactdev/orbit/pulls '*)
    index=$(wc -l < "$LOOKUP_STARTS")
    now=$(cat "$CLOCK")
    echo "$((now - PUBLISHED))" >> "$LOOKUP_STARTS"
    lookup=$(jq -ce --argjson index "$index" '.[$index]' <<<"$LOOKUPS")
    echo "$((now + $(jq -r '.duration // 0' <<<"$lookup")))" > "$CLOCK"
    if jq -e '.error // false' <<<"$lookup" > /dev/null; then
      echo 'Orbit lookup failed' >&2
      exit 1
    fi
    jq -c '.pr // {}' <<<"$lookup"
    ;;
  'api --paginate --slurp repos/nckrtl/conn/issues?'*) echo '[[]]' ;;
  'issue create '*) touch "$ISSUE_CREATED"; echo '${alertUrl}' ;;
  *) exit 2 ;;
esac`,
  );
  const run = spawnSync("bash", [join(__dirname, "conn-server-fleet-pin.sh"), "deadline"], {
    cwd: scratch,
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(run.error);
  return {
    run,
    starts: readFileSync(env.LOOKUP_STARTS, "utf8").trim().split("\n").map(Number),
    alerted: existsSync(env.ISSUE_CREATED),
  };
}

function openPin(created) {
  return {
    state: "open",
    created_at: new Date((published + created) * 1000).toISOString().replace(".000Z", "Z"),
    merged_at: null,
  };
}

test("retries an Orbit lookup error and accepts a timely PR", (t) => {
  const { run, starts, alerted } = watchDeadline(t, 280, [{ error: true }, { pr: openPin(290) }]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(starts, [280, 290]);
  assert.equal(alerted, false);
});

test("alerts the owner when Orbit lookups fail through the deadline", (t) => {
  const { run, starts, alerted } = watchDeadline(t, 285, [
    { error: true },
    { error: true },
    { error: true },
  ]);
  assert.equal(run.status, 1);
  assert.deepEqual(starts, [285, 295, 300]);
  assert.equal(alerted, true);
  assert.match(run.stdout, /https:\/\/example\.invalid\/conn\/issues\/1/);
});

for (const created of [300, 301]) {
  test(`checks a PR created at +${created}s when a +299s lookup finishes after the deadline`, (t) => {
    const { run, starts, alerted } = watchDeadline(t, 299, [{ duration: 3, pr: openPin(created) }]);
    const late = created > 300;
    assert.equal(run.status, late ? 1 : 0, run.stderr);
    assert.deepEqual(starts, [299]);
    assert.equal(alerted, late);
  });
}
