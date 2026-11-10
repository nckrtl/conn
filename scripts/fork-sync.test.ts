// @effect-diagnostics nodeBuiltinImport:off - Drives real git against isolated fixture repos.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  FORK_SYNC_NEEDS_REVIEW_EXIT,
  classifySettingsChange,
  compareBaselines,
  coversKnownSpot,
  diffSettingsSources,
  extractSettingsFields,
  firstMatchingRule,
  forkChangeHeadings,
  knownSpotPaths,
  loadManifest,
  matchGlob,
  mergeUpstream,
  oursRulesHittingRef,
  parseForkSyncManifest,
  parseSettingsPolicy,
  parseTestOutput,
  parseTypecheckOutput,
  runGuardTests,
  runPresenceChecks,
  runPresenceChecksAtRef,
} from "./fork-sync.ts";

const scriptsDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const repoRoot = NodePath.dirname(scriptsDir);
const cli = NodePath.join(scriptsDir, "fork-sync.ts");

const SETTINGS_STUB = `export const ClientSettingsSchema = Schema.Struct({
  existing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export const ServerSettings = Schema.Struct({
  other: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
`;

const SETTINGS_UPSTREAM = `export const ClientSettingsSchema = Schema.Struct({
  existing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snapShotEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export const ServerSettings = Schema.Struct({
  other: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  speechLocale: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("auto"))),
});
`;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || value === undefined) continue;
    env[key] = value;
  }
  env.GIT_AUTHOR_NAME = "fixture";
  env.GIT_AUTHOR_EMAIL = "fixture@example.test";
  env.GIT_COMMITTER_NAME = "fixture";
  env.GIT_COMMITTER_EMAIL = "fixture@example.test";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function runGit(cwd: string, args: readonly string[]): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
}

function requireGit(cwd: string, args: readonly string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function write(repo: string, relative: string, contents: string) {
  const absolute = NodePath.join(repo, relative);
  NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
  NodeFS.writeFileSync(absolute, contents);
}

function toyManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    upstream: {
      remote: "upstream",
      url: "https://example.test/upstream.git",
      ref: "main",
    },
    conflictRules: [
      {
        glob: "pnpm-lock.yaml",
        strategy: "regenerate",
        command: "node -e \"require('fs').writeFileSync('pnpm-lock.yaml', 'regenerated\\n')\"",
      },
      { glob: "composer.ts", strategy: "reapply", patch: "patches/composer.ts.patch" },
      { glob: "fork-only.txt", strategy: "ours" },
    ],
    features: [
      {
        id: "keep",
        forkHeading: "Keep",
        files: ["keep.txt", "fork-only.txt"],
        presence: [{ kind: "symbol", path: "keep.txt", symbol: "FORK" }],
      },
    ],
    guardTests: ["guard.mjs"],
    settingsPolicy: "settings-carryover.json",
    ...overrides,
  };
}

const COMPOSER_PATCH = `--- a/composer.ts
+++ b/composer.ts
@@ -1 +1,2 @@
 upstream composer
+FORK_REAPPLY
`;

function createMergeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-fork-sync-"));
  const repo = NodePath.join(root, "work");
  NodeFS.mkdirSync(repo);
  requireGit(repo, ["init", "-b", "main"]);
  requireGit(repo, ["config", "user.name", "fixture"]);
  requireGit(repo, ["config", "user.email", "fixture@example.test"]);
  requireGit(repo, ["config", "commit.gpgsign", "false"]);
  write(repo, "keep.txt", "FORK\n");
  write(repo, "composer.ts", "base composer\n");
  write(repo, "mixed.ts", "base mixed\n");
  write(repo, "pnpm-lock.yaml", "base lock\n");
  write(repo, "patches/composer.ts.patch", COMPOSER_PATCH);
  write(repo, "guard.mjs", "process.exit(0);\n");
  write(repo, "packages/contracts/src/settings.ts", SETTINGS_STUB);
  write(repo, "settings-carryover.json", JSON.stringify({ version: 1, keys: {} }));
  write(repo, "fork-sync.json", `${JSON.stringify(toyManifest(), null, 2)}\n`);
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", "base"]);
  requireGit(repo, ["checkout", "-b", "upstream"]);
  write(repo, "fork-only.txt", "upstream only\n");
  write(repo, "composer.ts", "upstream composer\n");
  write(repo, "mixed.ts", "upstream mixed\n");
  write(repo, "pnpm-lock.yaml", "upstream lock\n");
  write(repo, "packages/contracts/src/settings.ts", SETTINGS_UPSTREAM);
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", "upstream"]);
  const upstreamSha = requireGit(repo, ["rev-parse", "HEAD"]).trim();
  requireGit(repo, ["checkout", "main"]);
  write(repo, "fork-only.txt", "fork only\n");
  write(repo, "composer.ts", "fork composer\n");
  write(repo, "mixed.ts", "fork mixed\n");
  write(repo, "pnpm-lock.yaml", "fork lock\n");
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", "fork"]);
  return {
    root,
    repo,
    upstreamSha,
    worktree() {
      return NodePath.join(root, "wt");
    },
    dispose() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

function runCli(args: readonly string[], cwd?: string) {
  const result = NodeChildProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function resolvePristineUpstream(repo: string): string {
  for (const ref of ["upstream/main", "refs/t3code/main"]) {
    const result = runGit(repo, ["rev-parse", "--verify", ref]);
    if (result.status === 0) return ref;
  }
  const fetch = runGit(repo, [
    "fetch",
    "--no-tags",
    "--depth",
    "1",
    "https://github.com/pingdotgg/t3code.git",
    "+refs/heads/main:refs/t3code/main",
  ]);
  if (fetch.status !== 0) {
    throw new Error(`need upstream/main: ${fetch.stderr || fetch.stdout}`);
  }
  return "refs/t3code/main";
}

describe("fork-sync glob matching", () => {
  it("matches exact paths, stars, and ** trees", () => {
    expect(matchGlob("pnpm-lock.yaml", "pnpm-lock.yaml")).toBe(true);
    expect(matchGlob("apps/web/src/orbit/**", "apps/web/src/orbit/foo.ts")).toBe(true);
    expect(matchGlob("apps/web/src/orbit/**", "apps/web/src/orbit/a/b.ts")).toBe(true);
    expect(matchGlob("apps/web/src/orbit/**", "apps/web/src/other.ts")).toBe(false);
    expect(matchGlob("apps/web/src/composer*.ts", "apps/web/src/composer-logic.ts")).toBe(true);
    expect(matchGlob("apps/web/src/composer*.ts", "apps/web/src/chat/composer.ts")).toBe(false);
    expect(matchGlob("patches/*-conn.patch", "patches/react-native-screens-conn.patch")).toBe(true);
  });

  it("uses the first matching conflict rule", () => {
    const rule = firstMatchingRule(
      [
        { glob: "apps/web/src/composer*.ts", strategy: "manual" },
        { glob: "apps/web/src/**", strategy: "ours" },
      ],
      "apps/web/src/composer-logic.ts",
    );
    expect(rule?.strategy).toBe("manual");
  });
});

describe("fork-sync manifest", () => {
  it("rejects theirs", () => {
    expect(() =>
      parseForkSyncManifest({
        ...toyManifest({
          conflictRules: [{ glob: "x", strategy: "theirs" }],
        }),
      }),
    ).toThrow(/ours, regenerate, manual, or reapply/);
  });

  it("rejects regenerate without a command", () => {
    expect(() =>
      parseForkSyncManifest({
        ...toyManifest({
          conflictRules: [{ glob: "pnpm-lock.yaml", strategy: "regenerate" }],
        }),
      }),
    ).toThrow(/command/);
  });

  it("parses the committed fork-sync.json and stays in step with FORK.md", () => {
    const manifest = loadManifest(repoRoot);
    expect(manifest.upstream.ref).toBe("main");
    const strategies: ReadonlyArray<string> = manifest.conflictRules.map((rule) => rule.strategy);
    expect(strategies).not.toContain("theirs");
    const markdown = NodeFS.readFileSync(NodePath.join(repoRoot, "FORK.md"), "utf8");
    const headings = forkChangeHeadings(markdown);
    const featureHeadings = manifest.features
      .filter((feature) => feature.id !== "vendored-patches")
      .map((feature) => feature.forkHeading);
    expect([...featureHeadings].sort()).toEqual([...headings].sort());
    for (const feature of manifest.features) {
      expect(markdown).toContain(`### ${feature.forkHeading}`);
    }
  });

  it("keeps ours globs off paths that exist on upstream/main", () => {
    const manifest = loadManifest(repoRoot);
    const ref = resolvePristineUpstream(repoRoot);
    expect(oursRulesHittingRef(repoRoot, ref, manifest.conflictRules)).toEqual([]);
  });

  it("covers every Known-spots path", () => {
    const manifest = loadManifest(repoRoot);
    const markdown = NodeFS.readFileSync(NodePath.join(repoRoot, "FORK.md"), "utf8");
    const missing = knownSpotPaths(markdown).filter((path) => !coversKnownSpot(manifest, path));
    expect(missing, JSON.stringify(missing, null, 2)).toEqual([]);
  });

  it("finds every committed feature on this tree", () => {
    const manifest = loadManifest(repoRoot);
    const results = runPresenceChecks(repoRoot, manifest.features);
    const missing = results.filter((result) => !result.ok);
    expect(missing, JSON.stringify(missing, null, 2)).toEqual([]);
  });

  it("fails every presence check on pristine upstream/main", () => {
    const manifest = loadManifest(repoRoot);
    const ref = resolvePristineUpstream(repoRoot);
    const results = runPresenceChecksAtRef(repoRoot, ref, manifest.features);
    const passed = results.flatMap((feature) =>
      feature.checks.filter((check) => check.ok).map((check) => `${feature.id} ${check.path}`),
    );
    expect(passed, JSON.stringify(passed, null, 2)).toEqual([]);
  });
});

describe("fork-sync merge", () => {
  it("applies ours, reapply, and regenerate, and stops on an uncovered conflict", () => {
    const fixture = createMergeFixture();
    try {
      const merged = mergeUpstream({
        repo: fixture.repo,
        upstreamRef: fixture.upstreamSha,
        baseRef: "main",
        branch: "sync/fixture",
        worktree: fixture.worktree(),
        manifest: parseForkSyncManifest(toyManifest()),
      });
      expect(merged.committed).toBe(false);
      expect(merged.tip).toBeNull();
      expect(merged.unresolved).toEqual([
        expect.objectContaining({ path: "mixed.ts", reason: "no_rule" }),
      ]);
      expect(merged.autoResolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "composer.ts", rule: "reapply" }),
          expect.objectContaining({ path: "fork-only.txt", rule: "ours" }),
          expect.objectContaining({ path: "pnpm-lock.yaml", rule: "regenerate" }),
        ]),
      );
      expect(NodeFS.readFileSync(NodePath.join(merged.repo, "composer.ts"), "utf8")).toBe(
        "upstream composer\nFORK_REAPPLY\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(merged.repo, "fork-only.txt"), "utf8")).toBe(
        "fork only\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(merged.repo, "pnpm-lock.yaml"), "utf8")).toBe(
        "regenerated\n",
      );
    } finally {
      fixture.dispose();
    }
  });

  it("commits when every conflict has a rule", () => {
    const fixture = createMergeFixture();
    try {
      const manifest = parseForkSyncManifest(
        toyManifest({
          conflictRules: [...toyManifest().conflictRules, { glob: "mixed.ts", strategy: "ours" }],
        }),
      );
      const clean = mergeUpstream({
        repo: fixture.repo,
        upstreamRef: fixture.upstreamSha,
        baseRef: "main",
        branch: "sync/clean",
        worktree: fixture.worktree(),
        manifest,
      });
      expect(clean.unresolved).toEqual([]);
      expect(clean.committed).toBe(true);
      expect(clean.tip).toMatch(/^[0-9a-f]{40}$/);
      expect(requireGit(clean.repo, ["log", "-1", "--pretty=%s"]).trim()).toContain("merge");
    } finally {
      fixture.dispose();
    }
  });

  it("reuses a sync worktree on rerun", () => {
    const fixture = createMergeFixture();
    try {
      const input = {
        repo: fixture.repo,
        upstreamRef: fixture.upstreamSha,
        baseRef: "main" as const,
        branch: "sync/rerun",
        worktree: fixture.worktree(),
        manifest: parseForkSyncManifest(toyManifest()),
      };
      const first = mergeUpstream(input);
      expect(first.unresolved.some((item) => item.path === "mixed.ts")).toBe(true);
      const second = mergeUpstream(input);
      expect(second.worktree).toBe(first.worktree);
      expect(second.unresolved.some((item) => item.path === "mixed.ts")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("refuses to merge onto main", () => {
    const fixture = createMergeFixture();
    try {
      expect(() =>
        mergeUpstream({
          repo: fixture.repo,
          upstreamRef: fixture.upstreamSha,
          baseRef: "main",
          branch: "main",
          worktree: fixture.worktree(),
          manifest: parseForkSyncManifest(toyManifest()),
        }),
      ).toThrow(/sync\//);
      expect(requireGit(fixture.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    } finally {
      fixture.dispose();
    }
  });

  it("creates no branch when already up to date", () => {
    const fixture = createMergeFixture();
    try {
      const result = mergeUpstream({
        repo: fixture.repo,
        upstreamRef: "main",
        baseRef: "main",
        branch: "sync/noop",
        worktree: fixture.worktree(),
        manifest: parseForkSyncManifest(toyManifest()),
      });
      expect(result.branch).toBeNull();
      expect(result.worktree).toBeNull();
      expect(result.notes[0]).toMatch(/already contains/);
      expect(
        runGit(fixture.repo, ["rev-parse", "--verify", "refs/heads/sync/noop"]).status,
      ).not.toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it("removes a worktree it created when merge fails", () => {
    const fixture = createMergeFixture();
    try {
      requireGit(fixture.repo, ["checkout", "--orphan", "other"]);
      write(fixture.repo, "other.txt", "other\n");
      requireGit(fixture.repo, ["add", "."]);
      requireGit(fixture.repo, ["commit", "-m", "other"]);
      const other = requireGit(fixture.repo, ["rev-parse", "HEAD"]).trim();
      requireGit(fixture.repo, ["checkout", "main"]);
      const worktree = fixture.worktree();
      expect(() =>
        mergeUpstream({
          repo: fixture.repo,
          upstreamRef: other,
          baseRef: "main",
          branch: "sync/fail",
          worktree,
          manifest: parseForkSyncManifest(toyManifest()),
        }),
      ).toThrow(/merge failed/);
      expect(NodeFS.existsSync(worktree)).toBe(false);
      expect(
        runGit(fixture.repo, ["rev-parse", "--verify", "refs/heads/sync/fail"]).status,
      ).not.toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it("holds the lockfile until package.json is resolved", () => {
    const fixture = createMergeFixture();
    try {
      write(fixture.repo, "package.json", '{"name":"fork"}\n');
      requireGit(fixture.repo, ["add", "package.json"]);
      requireGit(fixture.repo, ["commit", "-m", "fork package"]);
      requireGit(fixture.repo, ["checkout", fixture.upstreamSha]);
      write(fixture.repo, "package.json", '{"name":"upstream"}\n');
      requireGit(fixture.repo, ["add", "package.json"]);
      requireGit(fixture.repo, ["commit", "-m", "upstream package"]);
      const upstream = requireGit(fixture.repo, ["rev-parse", "HEAD"]).trim();
      requireGit(fixture.repo, ["checkout", "main"]);
      const merged = mergeUpstream({
        repo: fixture.repo,
        upstreamRef: upstream,
        baseRef: "main",
        branch: "sync/lock",
        worktree: fixture.worktree(),
        manifest: parseForkSyncManifest(toyManifest()),
      });
      expect(merged.unresolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "package.json", reason: "no_rule" }),
          expect.objectContaining({ path: "pnpm-lock.yaml", reason: "package_json_conflicted" }),
        ]),
      );
    } finally {
      fixture.dispose();
    }
  });
});

describe("fork-sync presence", () => {
  it("fails when a listed symbol disappears", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-fork-presence-"));
    try {
      write(root, "keep.txt", "nothing\n");
      const results = runPresenceChecks(root, [
        {
          id: "keep",
          forkHeading: "Keep",
          files: ["keep.txt"],
          presence: [{ kind: "symbol", path: "keep.txt", symbol: "FORK" }],
        },
      ]);
      expect(results[0]?.ok).toBe(false);
      expect(results[0]?.checks[0]?.detail).toContain("does not contain");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fork-sync guards", () => {
  it("runs guard tests and records failures", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-fork-guard-"));
    try {
      write(root, "ok.mjs", "process.exit(0);\n");
      write(root, "fail.mjs", "process.exit(1);\n");
      const results = runGuardTests(root, ["ok.mjs", "fail.mjs"]);
      expect(results).toEqual([
        expect.objectContaining({ path: "ok.mjs", ok: true }),
        expect.objectContaining({ path: "fail.mjs", ok: false }),
      ]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fork-sync settings defaults", () => {
  const policy = parseSettingsPolicy({
    version: 1,
    keys: {
      "ClientSettingsSchema.historySwipeNavigation": { keepUpstreamDefault: false },
    },
  });

  it("reports new default-off, non-boolean, and removed keys without blocking", () => {
    const oldSource = `export const ClientSettingsSchema = Schema.Struct({
  gone: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  kept: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export const ServerSettings = Schema.Struct({
  fastWorktreeCheckout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
`;
    const newSource = `export const ClientSettingsSchema = Schema.Struct({
  kept: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snapShotEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export const ServerSettings = Schema.Struct({
  fastWorktreeCheckout: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  promptSuggestionsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  speechLocale: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("auto"))),
});
`;
    const diff = diffSettingsSources(oldSource, newSource, policy, {
      oldSha: "a".repeat(40),
      newSha: "b".repeat(40),
    });
    expect(diff.blocking).toBe(false);
    expect(
      diff.changes.map((change) => [change.change.kind, change.change.key, change.blocking]),
    ).toEqual(
      expect.arrayContaining([
        ["added", "snapShotEnabled", false],
        ["added", "promptSuggestionsEnabled", false],
        ["added", "speechLocale", false],
        ["removed", "gone", false],
      ]),
    );
  });

  it("blocks unknown default-on additions", () => {
    const verdict = classifySettingsChange(
      {
        kind: "added",
        schema: "ClientSettingsSchema",
        key: "shinyNewOn",
        defaultKind: "on",
      },
      policy,
    );
    expect(verdict.blocking).toBe(true);
    expect(verdict.reason).toMatch(/unknown or non-default-off/);
  });

  it("fails when a schema has no fields", () => {
    expect(() =>
      extractSettingsFields(`export const ClientSettingsSchema = Schema.Struct({
});
export const ServerSettings = Schema.Struct({
  other: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
`),
    ).toThrow(/has no fields/);
  });

  it("reads real ClientSettings and ServerSettings defaults", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(repoRoot, "packages/contracts/src/settings.ts"),
      "utf8",
    );
    const fields = extractSettingsFields(source);
    expect(fields.find((field) => field.key === "historySwipeNavigation")?.defaultKind).toBe("on");
    expect(fields.find((field) => field.key === "fastWorktreeCheckout")?.defaultKind).toBe("off");
    expect(fields.find((field) => field.key === "promptSuggestionsEnabled")?.defaultKind).toBe(
      "off",
    );
  });
});

describe("fork-sync baseline", () => {
  it("reports only failures that are new versus main", () => {
    const comparison = compareBaselines(
      { failures: [{ id: "typecheck:server" }, { id: "test:old" }] },
      { failures: [{ id: "typecheck:server" }, { id: "test:new" }] },
    );
    expect(comparison.newFailures).toEqual([{ id: "test:new" }]);
    expect(comparison.stillFailing).toEqual([{ id: "typecheck:server" }]);
    expect(comparison.resolved).toEqual([{ id: "test:old" }]);
  });

  it("parses typecheck and test output without line columns", () => {
    expect(
      parseTypecheckOutput("src/app/DesktopApp.ts:59:76 - error TS2304: Cannot find name Foo\n")
        .failures,
    ).toEqual([
      {
        id: "src/app/DesktopApp.ts TS2304 Cannot find name Foo",
        detail: "src/app/DesktopApp.ts:59:76 - error TS2304: Cannot find name Foo",
      },
    ]);
    expect(parseTestOutput(" FAIL  apps/web/src/foo.test.ts > does a thing\n").failures).toEqual([
      {
        id: "apps/web/src/foo.test.ts > does a thing",
        detail: " FAIL  apps/web/src/foo.test.ts > does a thing",
      },
    ]);
  });
});

describe("fork-sync CLI", () => {
  it("exits 3 when a conflict has no rule and lists guard results", () => {
    const fixture = createMergeFixture();
    try {
      const result = runCli(
        [
          "merge",
          "--repo",
          fixture.repo,
          "--upstream",
          fixture.upstreamSha,
          "--base",
          "main",
          "--branch",
          "sync/cli",
          "--worktree",
          fixture.worktree(),
          "--json",
        ],
        fixture.repo,
      );
      expect(result.status, result.stderr).toBe(FORK_SYNC_NEEDS_REVIEW_EXIT);
      const report = JSON.parse(result.stdout) as {
        unresolved: Array<{ path: string }>;
        autoResolved: Array<{ path: string; rule: string }>;
        guards: Array<{ path: string; ok: boolean }>;
        failures: string[];
        branch: { committed: boolean; tip: string | null };
        settings: {
          blocking: boolean;
          changes: Array<{ change: { kind: string; key: string }; blocking: boolean }>;
        };
      };
      expect(report.unresolved).toEqual([
        expect.objectContaining({ path: "mixed.ts", reason: "no_rule" }),
      ]);
      expect(report.autoResolved.map((item) => item.path).sort()).toEqual([
        "composer.ts",
        "fork-only.txt",
        "pnpm-lock.yaml",
      ]);
      expect(report.guards).toEqual([expect.objectContaining({ path: "guard.mjs", ok: true })]);
      expect(report.failures.some((line) => line.includes("mixed.ts"))).toBe(true);
      expect(report.branch.committed).toBe(false);
      expect(report.branch.tip).toBeNull();
      expect(report.settings.blocking).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("exits non-zero when check cannot resolve a ref", () => {
    const fixture = createMergeFixture();
    try {
      const result = runCli(
        ["check", "--repo", fixture.repo, "--upstream", "does-not-exist", "--json"],
        fixture.repo,
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/could not resolve does-not-exist/);
    } finally {
      fixture.dispose();
    }
  });

  it("exits non-zero when check is missing the settings policy", () => {
    const fixture = createMergeFixture();
    try {
      NodeFS.rmSync(NodePath.join(fixture.repo, "settings-carryover.json"));
      const result = runCli(
        [
          "check",
          "--repo",
          fixture.repo,
          "--upstream",
          fixture.upstreamSha,
          "--base",
          "main",
          "--json",
        ],
        fixture.repo,
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/settings-carryover/);
    } finally {
      fixture.dispose();
    }
  });

  it("loads settings policy beside --manifest", () => {
    const fixture = createMergeFixture();
    try {
      const sidecar = NodePath.join(fixture.root, "policy");
      NodeFS.mkdirSync(sidecar);
      NodeFS.copyFileSync(
        NodePath.join(fixture.repo, "fork-sync.json"),
        NodePath.join(sidecar, "fork-sync.json"),
      );
      NodeFS.copyFileSync(
        NodePath.join(fixture.repo, "settings-carryover.json"),
        NodePath.join(sidecar, "settings-carryover.json"),
      );
      NodeFS.rmSync(NodePath.join(fixture.repo, "settings-carryover.json"));
      requireGit(fixture.repo, ["add", "settings-carryover.json"]);
      requireGit(fixture.repo, ["commit", "-m", "drop policy"]);
      const result = runCli(
        [
          "merge",
          "--repo",
          fixture.repo,
          "--manifest",
          NodePath.join(sidecar, "fork-sync.json"),
          "--upstream",
          fixture.upstreamSha,
          "--base",
          "main",
          "--branch",
          "sync/policy-fallback",
          "--worktree",
          fixture.worktree(),
          "--json",
        ],
        fixture.repo,
      );
      expect(result.status, result.stderr).toBe(FORK_SYNC_NEEDS_REVIEW_EXIT);
      const report = JSON.parse(result.stdout) as {
        settings: { changes: Array<{ change: { key: string } }> } | null;
      };
      expect(report.settings?.changes.map((change) => change.change.key)).toContain(
        "snapShotEnabled",
      );
    } finally {
      fixture.dispose();
    }
  });

  it("fails guards when a feature file is gone", () => {
    const fixture = createMergeFixture();
    try {
      NodeFS.rmSync(NodePath.join(fixture.repo, "keep.txt"));
      const result = runCli(["guards", "--repo", fixture.repo, "--json"], fixture.repo);
      expect(result.status).toBe(FORK_SYNC_NEEDS_REVIEW_EXIT);
      expect(result.stdout).toContain("missing keep.txt");
    } finally {
      fixture.dispose();
    }
  });

  it("prints only new baseline failures", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-fork-baseline-"));
    try {
      write(root, "main.json", JSON.stringify({ failures: [{ id: "old" }] }));
      write(root, "sync.json", JSON.stringify({ failures: [{ id: "old" }, { id: "new" }] }));
      const result = runCli(
        [
          "baseline",
          "--main",
          NodePath.join(root, "main.json"),
          "--sync",
          NodePath.join(root, "sync.json"),
          "--json",
        ],
        root,
      );
      expect(result.status).toBe(FORK_SYNC_NEEDS_REVIEW_EXIT);
      const report = JSON.parse(result.stdout) as {
        baseline: { newFailures: Array<{ id: string }> };
      };
      expect(report.baseline.newFailures).toEqual([{ id: "new" }]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects --in-place and provenance", () => {
    expect(runCli(["merge", "--in-place"], repoRoot).stderr).toMatch(/unknown argument/);
    expect(runCli(["provenance"], repoRoot).stderr).toMatch(/unknown command/);
  });
});

describe("fork-sync check:changed mapping", () => {
  it("does not run every CI job for the root manifests", () => {
    const packages = readWorkspace();
    const all = packages.map((pkg) => pkg.name).sort();
    for (const file of ["fork-sync.json", "settings-carryover.json"]) {
      const affected = decide([file], packages, false).affected;
      expect(affected).toContain("@t3tools/scripts");
      expect(affected).not.toEqual(all);
    }
  });
});

describe("fork-sync does not publish", () => {
  it("does not push or wrap provenance", () => {
    const source = NodeFS.readFileSync(NodePath.join(scriptsDir, "fork-sync.ts"), "utf8");
    expect(source).not.toContain("git push");
    expect(source).not.toContain("checkPublishedSyncSource");
    expect(source).not.toContain("--in-place");
  });
});
