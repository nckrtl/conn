// @effect-diagnostics nodeBuiltinImport:off - Drives real git against isolated fixture repos.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import { FULL_COMMIT_SHA_PATTERN } from "./sync-source-provenance.ts";
import {
  FORK_SYNC_NEEDS_REVIEW_EXIT,
  classifySettingsChange,
  compareBaselines,
  diffSettingsSources,
  extractSettingsFields,
  firstMatchingRule,
  forkChangeHeadings,
  loadManifest,
  matchGlob,
  mergeUpstream,
  parseForkSyncManifest,
  parseSettingsPolicy,
  provenancePointers,
  runPresenceChecks,
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
      { glob: "composer.ts", strategy: "theirs" },
      { glob: "ours.txt", strategy: "ours" },
    ],
    features: [
      {
        id: "keep",
        forkHeading: "Keep",
        files: ["keep.txt"],
        presence: [{ kind: "symbol", path: "keep.txt", symbol: "FORK" }],
      },
    ],
    settingsPolicy: "settings-carryover.json",
    ...overrides,
  };
}

function createMergeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-fork-sync-"));
  const repo = NodePath.join(root, "work");
  NodeFS.mkdirSync(repo);
  requireGit(repo, ["init", "-b", "main"]);
  requireGit(repo, ["config", "user.name", "fixture"]);
  requireGit(repo, ["config", "user.email", "fixture@example.test"]);
  requireGit(repo, ["config", "commit.gpgsign", "false"]);
  write(repo, "keep.txt", "FORK\n");
  write(repo, "ours.txt", "fork ours\n");
  write(repo, "composer.ts", "base composer\n");
  write(repo, "mixed.ts", "base mixed\n");
  write(repo, "pnpm-lock.yaml", "base lock\n");
  write(repo, "packages/contracts/src/settings.ts", SETTINGS_STUB);
  write(repo, "settings-carryover.json", JSON.stringify({ version: 1, keys: {} }));
  write(repo, "fork-sync.json", `${JSON.stringify(toyManifest(), null, 2)}\n`);
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", "base"]);
  requireGit(repo, ["checkout", "-b", "upstream"]);
  write(repo, "ours.txt", "upstream ours\n");
  write(repo, "composer.ts", "upstream composer\n");
  write(repo, "mixed.ts", "upstream mixed\n");
  write(repo, "pnpm-lock.yaml", "upstream lock\n");
  write(repo, "packages/contracts/src/settings.ts", SETTINGS_UPSTREAM);
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", "upstream"]);
  const upstreamSha = requireGit(repo, ["rev-parse", "HEAD"]).trim();
  requireGit(repo, ["checkout", "main"]);
  write(repo, "ours.txt", "fork ours changed\n");
  write(repo, "composer.ts", "fork composer\n");
  write(repo, "mixed.ts", "fork mixed\n");
  write(repo, "pnpm-lock.yaml", "fork lock\n");
  requireGit(repo, ["add", "."]);
  requireGit(repo, ["commit", "-m", "fork"]);
  return {
    root,
    repo,
    upstreamSha,
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
        { glob: "apps/web/src/composer*.ts", strategy: "theirs" },
        { glob: "apps/web/src/**", strategy: "ours" },
      ],
      "apps/web/src/composer-logic.ts",
    );
    expect(rule?.strategy).toBe("theirs");
  });
});

describe("fork-sync manifest", () => {
  it("rejects an unknown conflict strategy", () => {
    expect(() =>
      parseForkSyncManifest({
        ...toyManifest({
          conflictRules: [{ glob: "x", strategy: "union" }],
        }),
      }),
    ).toThrow(/ours, theirs, regenerate, or manual/);
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

  it("finds every committed feature on this tree", () => {
    const manifest = loadManifest(repoRoot);
    const results = runPresenceChecks(repoRoot, manifest.features);
    const missing = results.filter((result) => !result.ok);
    expect(missing, JSON.stringify(missing, null, 2)).toEqual([]);
  });
});

describe("fork-sync merge", () => {
  it("applies ours, theirs, and regenerate, and stops on an uncovered conflict", () => {
    const fixture = createMergeFixture();
    try {
      const merged = mergeUpstream({
        repo: fixture.repo,
        upstreamRef: fixture.upstreamSha,
        baseRef: "main",
        branch: "sync/fixture",
        inPlace: true,
        manifest: parseForkSyncManifest(toyManifest()),
      });
      expect(merged.unresolved).toEqual([{ path: "mixed.ts", reason: "no_rule" }]);
      expect(merged.autoResolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "composer.ts", rule: "theirs" }),
          expect.objectContaining({ path: "ours.txt", rule: "ours" }),
          expect.objectContaining({ path: "pnpm-lock.yaml", rule: "regenerate" }),
        ]),
      );
      expect(NodeFS.readFileSync(NodePath.join(fixture.repo, "composer.ts"), "utf8")).toBe(
        "upstream composer\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(fixture.repo, "ours.txt"), "utf8")).toBe(
        "fork ours changed\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(fixture.repo, "pnpm-lock.yaml"), "utf8")).toBe(
        "regenerated\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(fixture.repo, "mixed.ts"), "utf8")).toMatch(
        /^(<<<<<<<|fork mixed|upstream mixed)/,
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
        inPlace: true,
        manifest,
      });
      expect(clean.unresolved).toEqual([]);
      expect(clean.tip).toMatch(FULL_COMMIT_SHA_PATTERN);
      expect(requireGit(fixture.repo, ["log", "-1", "--pretty=%s"]).trim()).toContain("merge");
      expect(NodeFS.readFileSync(NodePath.join(fixture.repo, "mixed.ts"), "utf8")).toBe(
        "fork mixed\n",
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

describe("fork-sync settings defaults", () => {
  const policy = parseSettingsPolicy({
    version: 1,
    keys: {
      historySwipeNavigation: { keepUpstreamDefault: false },
    },
  });

  it("reports new default-off keys and removed keys without blocking", () => {
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
        ["removed", "gone", false],
      ]),
    );
  });

  it("blocks unknown non-default-off additions", () => {
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
});

describe("fork-sync CLI", () => {
  it("exits 3 when a conflict has no rule", () => {
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
          "--in-place",
          "--json",
        ],
        fixture.repo,
      );
      expect(result.status, result.stderr).toBe(FORK_SYNC_NEEDS_REVIEW_EXIT);
      const report = JSON.parse(result.stdout) as {
        unresolved: Array<{ path: string }>;
        autoResolved: Array<{ path: string; rule: string }>;
        provenance: { publish: string; check: string };
        settings: {
          blocking: boolean;
          changes: Array<{ change: { kind: string; key: string }; blocking: boolean }>;
        };
      };
      expect(report.unresolved).toEqual([{ path: "mixed.ts", reason: "no_rule" }]);
      expect(report.autoResolved.map((item) => item.path).sort()).toEqual([
        "composer.ts",
        "ours.txt",
        "pnpm-lock.yaml",
      ]);
      expect(report.provenance).toEqual(provenancePointers());
      expect(report.settings.blocking).toBe(false);
      expect(report.settings.changes).toEqual([
        expect.objectContaining({
          blocking: false,
          change: expect.objectContaining({ kind: "added", key: "snapShotEnabled" }),
        }),
      ]);
    } finally {
      fixture.dispose();
    }
  });

  it("loads settings policy beside --manifest when the merge tree lacks it", () => {
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
          "--in-place",
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
});

describe("fork-sync check:changed mapping", () => {
  it("does not run every CI job for the root manifests", () => {
    const packages = readWorkspace();
    const all = packages.map((pkg) => pkg.name).sort();
    for (const file of [
      "fork-sync.json",
      "settings-carryover.json",
      "knip.jsonc",
      ".github/scripts/ci-changes.cjs",
    ]) {
      const affected = decide([file], packages, false).affected;
      expect(affected).toContain("@t3tools/scripts");
      expect(affected).not.toEqual(all);
    }
  });
});

describe("fork-sync provenance pointers", () => {
  it("hands publish and check to the existing scripts", () => {
    expect(provenancePointers()).toEqual({
      publish: "node scripts/publish-sync-branch.ts",
      check: "node scripts/check-sync-provenance.ts --json",
    });
    const source = NodeFS.readFileSync(NodePath.join(scriptsDir, "fork-sync.ts"), "utf8");
    expect(source).toContain("checkPublishedSyncSource");
    expect(source).not.toContain("git push");
  });
});
