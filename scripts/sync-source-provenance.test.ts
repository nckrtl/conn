// @effect-diagnostics nodeBuiltinImport:off - Drives real git against an isolated bare remote fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vite-plus/test";

import {
  assertHeadUnchanged,
  assertInstallArtifactProvenance,
  bindArtifactProvenance,
  checkPublishedSyncSource,
  FULL_COMMIT_SHA_PATTERN,
  parseArtifactProvenanceBinding,
  publishExactHeadToSyncBranch,
  sealPublishedSyncSource,
  SYNC_BRANCH_REF_PREFIX,
  syncPublishPushArgs,
  syncRefForCommit,
  SyncSourceProvenanceError,
} from "./sync-source-provenance.ts";

const scriptsDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const checkCli = NodePath.join(scriptsDir, "check-sync-provenance.ts");
const publishCli = NodePath.join(scriptsDir, "publish-sync-branch.ts");

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

function runCli(
  script: string,
  args: readonly string[],
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: gitEnv(),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createBareRemoteFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-sync-prov-"));
  const bare = NodePath.join(root, "origin.git");
  const clone = NodePath.join(root, "work");
  NodeFS.mkdirSync(clone, { recursive: true });
  requireGit(clone, ["init", "-b", "main"]);
  requireGit(clone, ["config", "user.name", "fixture"]);
  requireGit(clone, ["config", "user.email", "fixture@example.test"]);
  NodeFS.writeFileSync(NodePath.join(clone, "README"), "fixture\n");
  requireGit(clone, ["add", "README"]);
  requireGit(clone, ["commit", "-m", "initial"]);
  requireGit(root, ["clone", "--bare", clone, bare]);
  requireGit(clone, ["remote", "add", "origin", bare]);
  requireGit(clone, ["push", "-u", "origin", "HEAD:refs/heads/main"]);
  return {
    root,
    bare,
    clone,
    dispose() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

function headSha(repo: string): string {
  const sha = requireGit(repo, ["rev-parse", "HEAD"]).trim().toLowerCase();
  expect(sha).toMatch(FULL_COMMIT_SHA_PATTERN);
  return sha;
}

function writeUnpushedCommit(repo: string, name: string): string {
  NodeFS.writeFileSync(NodePath.join(repo, name), `${name}\n`);
  requireGit(repo, ["add", name]);
  requireGit(repo, ["commit", "-m", name]);
  return headSha(repo);
}

async function writeAppArtifact(
  root: string,
  binding: { readonly t3codeCommitHash: string; readonly t3codeSyncRef: string },
): Promise<string> {
  const sourceDir = NodePath.join(root, "app-source");
  const appPath = NodePath.join(root, "Conn.app");
  const resourcesDir = NodePath.join(appPath, "Contents/Resources");
  NodeFS.mkdirSync(sourceDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(sourceDir, "package.json"),
    JSON.stringify({ name: "conn", ...binding }),
  );
  NodeFS.mkdirSync(resourcesDir, { recursive: true });
  await createPackageWithOptions(sourceDir, NodePath.join(resourcesDir, "app.asar"), {});
  return appPath;
}

describe("sync-source provenance", () => {
  it("pushes the exact SHA to a sync ref without force or hook bypass", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect([...syncPublishPushArgs("origin", commit)]).toEqual([
      "push",
      "origin",
      `${commit}:${syncRefForCommit(commit)}`,
    ]);
    expect(
      syncPublishPushArgs("origin", commit).some(
        (arg) => arg === "--force" || arg.startsWith("--force"),
      ),
    ).toBe(false);
    expect(syncPublishPushArgs("origin", commit).includes("--no-verify")).toBe(false);
  });

  it("rejects a short SHA in artifact provenance", () => {
    expect(() =>
      parseArtifactProvenanceBinding({
        t3codeCommitHash: "f16f4ad12612",
        t3codeSyncRef: `${SYNC_BRANCH_REF_PREFIX}demo`,
      }),
    ).toThrow(/full 40-character t3codeCommitHash/);
  });

  it("fails closed on an unpushed commit, publishes, then verifies the exact SHA", async () => {
    const fixture = createBareRemoteFixture();
    try {
      const unpublished = writeUnpushedCommit(fixture.clone, "unpublished");
      const beforePublish = runCli(checkCli, ["--repo", fixture.clone, "--json"]);
      expect(beforePublish.status).toBe(1);
      expect(beforePublish.stderr).toContain(unpublished);
      expect(beforePublish.stderr).toMatch(/not published/);
      expect(() => checkPublishedSyncSource({ repo: fixture.clone })).toThrow(
        SyncSourceProvenanceError,
      );

      const published = runCli(publishCli, ["--repo", fixture.clone, "--json"]);
      expect(published.status, published.stderr).toBe(0);
      const publishedJson = JSON.parse(published.stdout) as {
        commit: string;
        syncRef: string;
        remote: string;
        remoteUrl: string;
      };
      expect(publishedJson.commit).toBe(unpublished);
      expect(publishedJson.syncRef).toBe(syncRefForCommit(unpublished));
      expect(publishedJson.remote).toBe("origin");
      expect(publishedJson.remoteUrl).toBe(fixture.bare);

      const afterPublish = runCli(checkCli, ["--repo", fixture.clone, "--json"]);
      expect(afterPublish.status, afterPublish.stderr).toBe(0);
      const checked = JSON.parse(afterPublish.stdout) as typeof publishedJson;
      expect(checked).toEqual(publishedJson);
      expect(sealPublishedSyncSource({ repo: fixture.clone, expected: checked })).toEqual(checked);

      const appPath = await writeAppArtifact(fixture.root, bindArtifactProvenance(checked));
      const artifactCheck = runCli(checkCli, [
        "--repo",
        fixture.clone,
        "--artifact",
        appPath,
        "--json",
      ]);
      expect(artifactCheck.status, artifactCheck.stderr).toBe(0);
      const artifactJson = JSON.parse(artifactCheck.stdout) as {
        commit: string;
        syncRef: string;
        artifact: { t3codeCommitHash: string; t3codeSyncRef: string; path: string };
      };
      expect(artifactJson.commit).toBe(unpublished);
      expect(artifactJson.syncRef).toBe(syncRefForCommit(unpublished));
      expect(artifactJson.artifact).toEqual({
        path: appPath,
        t3codeCommitHash: unpublished,
        t3codeSyncRef: syncRefForCommit(unpublished),
      });
      expect(
        assertInstallArtifactProvenance({ artifactPath: appPath, repo: fixture.clone }).commit,
      ).toBe(unpublished);
    } finally {
      fixture.dispose();
    }
  });

  it("fails closed when publication is rejected and does not install", async () => {
    const fixture = createBareRemoteFixture();
    try {
      const unpublished = writeUnpushedCommit(fixture.clone, "rejected");
      const hook = NodePath.join(fixture.bare, "hooks/pre-receive");
      NodeFS.writeFileSync(hook, "#!/bin/sh\necho fixture-reject >&2\nexit 1\n", { mode: 0o755 });

      const published = runCli(publishCli, ["--repo", fixture.clone, "--json"]);
      expect(published.status).toBe(1);
      expect(published.stderr).toMatch(/fixture-reject|failed to publish/);

      const check = runCli(checkCli, ["--repo", fixture.clone, "--json"]);
      expect(check.status).toBe(1);
      expect(check.stderr).toContain(unpublished);

      const appPath = await writeAppArtifact(fixture.root, {
        t3codeCommitHash: unpublished,
        t3codeSyncRef: syncRefForCommit(unpublished),
      });
      const artifactCheck = runCli(checkCli, ["--repo", fixture.clone, "--artifact", appPath]);
      expect(artifactCheck.status).toBe(1);
      expect(() =>
        assertInstallArtifactProvenance({ artifactPath: appPath, repo: fixture.clone }),
      ).toThrow(/is not published|could not read/);
    } finally {
      fixture.dispose();
    }
  });

  it("fails closed on a stale or mismatched remote sync ref and does not install", async () => {
    const fixture = createBareRemoteFixture();
    try {
      const parent = headSha(fixture.clone);
      const publishedSha = writeUnpushedCommit(fixture.clone, "published");
      expect(runCli(publishCli, ["--repo", fixture.clone, "--json"]).status).toBe(0);

      const mismatchedApp = await writeAppArtifact(fixture.root, {
        t3codeCommitHash: parent,
        t3codeSyncRef: syncRefForCommit(publishedSha),
      });
      expect(() =>
        assertInstallArtifactProvenance({ artifactPath: mismatchedApp, repo: fixture.clone }),
      ).toThrow(/does not match artifact commit/);

      requireGit(fixture.bare, ["update-ref", syncRefForCommit(publishedSha), parent]);

      const staleCheck = runCli(checkCli, ["--repo", fixture.clone, "--json"]);
      expect(staleCheck.status).toBe(1);
      expect(staleCheck.stderr).toContain(publishedSha);

      const staleApp = await writeAppArtifact(fixture.root, {
        t3codeCommitHash: publishedSha,
        t3codeSyncRef: syncRefForCommit(publishedSha),
      });
      expect(runCli(checkCli, ["--repo", fixture.clone, "--artifact", staleApp]).status).toBe(1);
      expect(() =>
        assertInstallArtifactProvenance({ artifactPath: staleApp, repo: fixture.clone }),
      ).toThrow(/does not match artifact commit/);
    } finally {
      fixture.dispose();
    }
  });

  it("fails if HEAD changes after provenance is recorded", () => {
    const fixture = createBareRemoteFixture();
    try {
      writeUnpushedCommit(fixture.clone, "seal-base");
      const provenance = publishExactHeadToSyncBranch({ repo: fixture.clone });
      writeUnpushedCommit(fixture.clone, "changed-head");
      expect(() => assertHeadUnchanged(fixture.clone, provenance.commit)).toThrow(/HEAD changed/);
      expect(() => sealPublishedSyncSource({ repo: fixture.clone, expected: provenance })).toThrow(
        /HEAD changed/,
      );
    } finally {
      fixture.dispose();
    }
  });
});
