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
