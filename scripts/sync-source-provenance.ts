// @effect-diagnostics nodeBuiltinImport:off - Standalone git provenance CLI without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { extractFile } from "@electron/asar";

export const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SYNC_BRANCH_REF_PREFIX = "refs/heads/sync/";
export const DEFAULT_SYNC_PROVENANCE_REMOTE = "origin";

export class SyncSourceProvenanceError {
  readonly _tag = "SyncSourceProvenanceError";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
  toString() {
    return this.message;
  }
}

export function syncSourceProvenanceMessage(cause: unknown): string {
  if (cause instanceof SyncSourceProvenanceError || cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

export interface SyncSourceProvenance {
  readonly commit: string;
  readonly syncRef: string;
  readonly remote: string;
  readonly remoteUrl: string;
  readonly artifact?: ArtifactProvenanceBinding;
}

export interface ArtifactProvenanceBinding {
  readonly path?: string;
  readonly t3codeCommitHash: string;
  readonly t3codeSyncRef: string;
}

export interface SyncSourceCliArgs {
  readonly repo: string;
  readonly remote: string;
  readonly artifact: string | undefined;
  readonly json: boolean;
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

interface RemoteSyncTip {
  readonly sha: string;
  readonly ref: string;
}

function gitSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || value === undefined) continue;
    env[key] = value;
  }
  // Fail closed instead of waiting on a TTY password prompt.
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function runGit(repo: string, args: readonly string[]): GitResult {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: gitSubprocessEnv(),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function requireGit(repo: string, args: readonly string[], onFail: string): string {
  const result = runGit(repo, args);
  if (result.error !== undefined) {
    throw new SyncSourceProvenanceError(`${onFail}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail =
      (result.stderr || result.stdout).trim() ||
      `git ${args.join(" ")} exited ${String(result.status)}`;
    throw new SyncSourceProvenanceError(`${onFail}: ${detail}`);
  }
  return result.stdout;
}

export function syncRefForCommit(commit: string): string {
  return `${SYNC_BRANCH_REF_PREFIX}${commit}`;
}

export function syncPublishPushArgs(remote: string, commit: string): readonly string[] {
  return ["push", remote, `${commit}:${syncRefForCommit(commit)}`];
}

function configuredRemote(explicit?: string | undefined): string {
  return explicit ?? process.env.T3CODE_SYNC_PROVENANCE_REMOTE ?? DEFAULT_SYNC_PROVENANCE_REMOTE;
}

export function parseSyncSourceCliArgs(
  argv: ReadonlyArray<string>,
  defaults: { readonly repo?: string | undefined; readonly remote?: string | undefined } = {},
): SyncSourceCliArgs {
  let repo = defaults.repo ?? process.cwd();
  let remote = configuredRemote(defaults.remote);
  let artifact: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--repo" || flag === "--remote" || flag === "--artifact") {
      if (value === undefined || value.startsWith("--")) {
        throw new SyncSourceProvenanceError(`missing value for ${flag}`);
      }
      index += 1;
      if (flag === "--repo") repo = value;
      else if (flag === "--remote") remote = value;
      else artifact = value;
      continue;
    }
    throw new SyncSourceProvenanceError(`unknown argument: ${flag}`);
  }
  return { repo, remote, artifact, json };
}

export function resolveFullHeadSha(repo: string): string {
  const sha = requireGit(repo, ["rev-parse", "--verify", "HEAD"], "could not resolve HEAD")
    .trim()
    .toLowerCase();
  if (!FULL_COMMIT_SHA_PATTERN.test(sha)) {
    throw new SyncSourceProvenanceError(
      `HEAD is not a full 40-character commit SHA (got ${JSON.stringify(sha)})`,
    );
  }
  return sha;
}

export function resolveRemoteUrl(
  repo: string,
  remote: string = DEFAULT_SYNC_PROVENANCE_REMOTE,
): { readonly name: string; readonly url: string } {
  const url = requireGit(
    repo,
    ["remote", "get-url", remote],
    `remote ${remote} is not configured`,
  ).trim();
  if (url.length === 0) {
    throw new SyncSourceProvenanceError(`remote ${remote} has an empty URL`);
  }
  return { name: remote, url };
}

function parseLsRemoteTips(stdout: string): RemoteSyncTip[] {
  const tips: RemoteSyncTip[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [shaRaw, ref] = trimmed.split("\t");
    const sha = shaRaw?.trim().toLowerCase();
    if (!sha || !ref?.startsWith(SYNC_BRANCH_REF_PREFIX)) continue;
    if (!FULL_COMMIT_SHA_PATTERN.test(sha)) {
      throw new SyncSourceProvenanceError(
        `remote sync ref ${ref} is not a full 40-character SHA (got ${JSON.stringify(shaRaw)})`,
      );
    }
    tips.push({ sha, ref });
  }
  return tips;
}

export function listRemoteSyncTips(repo: string, remote: string): readonly RemoteSyncTip[] {
  const result = runGit(repo, ["ls-remote", "--refs", remote, `${SYNC_BRANCH_REF_PREFIX}*`]);
  if (result.error !== undefined) {
    throw new SyncSourceProvenanceError(
      `could not list ${remote} sync branches: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail =
      (result.stderr || result.stdout).trim() || `git ls-remote exited ${String(result.status)}`;
    throw new SyncSourceProvenanceError(`could not list ${remote} sync branches: ${detail}`);
  }
  return parseLsRemoteTips(result.stdout);
}

function preferSyncRef(commit: string, refs: readonly string[]): string {
  const exact = syncRefForCommit(commit);
  if (refs.includes(exact)) return exact;
  const [first] = [...refs].sort();
  if (first === undefined) {
    throw new SyncSourceProvenanceError(`HEAD ${commit} is not published on any sync branch`);
  }
  return first;
}

export function checkPublishedSyncSource(input: {
  readonly repo: string;
  readonly remote?: string | undefined;
}): SyncSourceProvenance {
  const commit = resolveFullHeadSha(input.repo);
  const remote = resolveRemoteUrl(input.repo, configuredRemote(input.remote));
  const matching = listRemoteSyncTips(input.repo, remote.name)
    .filter((tip) => tip.sha === commit)
    .map((tip) => tip.ref);
  if (matching.length === 0) {
    throw new SyncSourceProvenanceError(
      `HEAD ${commit} is not published as the tip of any ${remote.name} ${SYNC_BRANCH_REF_PREFIX}* branch`,
    );
  }
  return {
    commit,
    syncRef: preferSyncRef(commit, matching),
    remote: remote.name,
    remoteUrl: remote.url,
  };
}

export function assertHeadUnchanged(repo: string, expectedCommit: string): string {
  const commit = resolveFullHeadSha(repo);
  if (commit !== expectedCommit) {
    throw new SyncSourceProvenanceError(
      `HEAD changed from ${expectedCommit} to ${commit} after provenance was recorded`,
    );
  }
  return commit;
}

export function sealPublishedSyncSource(input: {
  readonly repo: string;
  readonly expected: SyncSourceProvenance;
  readonly remote?: string | undefined;
}): SyncSourceProvenance {
  assertHeadUnchanged(input.repo, input.expected.commit);
  const sealed = checkPublishedSyncSource({
    repo: input.repo,
    remote: input.remote ?? input.expected.remote,
  });
  if (sealed.commit !== input.expected.commit || sealed.syncRef !== input.expected.syncRef) {
    throw new SyncSourceProvenanceError(
      `published sync provenance changed from ${input.expected.commit} ${input.expected.syncRef} to ${sealed.commit} ${sealed.syncRef}`,
    );
  }
  return sealed;
}

export function publishExactHeadToSyncBranch(input: {
  readonly repo: string;
  readonly remote?: string | undefined;
}): SyncSourceProvenance {
  const commit = resolveFullHeadSha(input.repo);
  const remote = resolveRemoteUrl(input.repo, configuredRemote(input.remote));
  requireGit(
    input.repo,
    syncPublishPushArgs(remote.name, commit),
    `failed to publish ${commit} to ${remote.name} ${syncRefForCommit(commit)}`,
  );
  return checkPublishedSyncSource({ repo: input.repo, remote: remote.name });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseArtifactProvenanceBinding(
  manifest: unknown,
  artifactPath?: string | undefined,
): ArtifactProvenanceBinding {
  if (!isRecord(manifest)) {
    throw new SyncSourceProvenanceError("artifact provenance manifest is not an object");
  }
  const commit = manifest.t3codeCommitHash;
  const syncRef = manifest.t3codeSyncRef;
  if (typeof commit !== "string" || !FULL_COMMIT_SHA_PATTERN.test(commit.toLowerCase())) {
    throw new SyncSourceProvenanceError(
      `artifact records no full 40-character t3codeCommitHash (got ${JSON.stringify(commit)})`,
    );
  }
  if (
    typeof syncRef !== "string" ||
    !syncRef.startsWith(SYNC_BRANCH_REF_PREFIX) ||
    syncRef === SYNC_BRANCH_REF_PREFIX
  ) {
    throw new SyncSourceProvenanceError(
      `artifact records no origin sync ref in t3codeSyncRef (got ${JSON.stringify(syncRef)})`,
    );
  }
  return {
    ...(artifactPath === undefined ? {} : { path: artifactPath }),
    t3codeCommitHash: commit.toLowerCase(),
    t3codeSyncRef: syncRef,
  };
}

export function bindArtifactProvenance(
  provenance: SyncSourceProvenance,
  artifactPath?: string | undefined,
): ArtifactProvenanceBinding {
  return {
    ...(artifactPath === undefined ? {} : { path: artifactPath }),
    t3codeCommitHash: provenance.commit,
    t3codeSyncRef: provenance.syncRef,
  };
}

export function readProvenanceManifest(artifactPath: string): unknown {
  if (artifactPath.endsWith(".json")) {
    return JSON.parse(NodeFS.readFileSync(artifactPath, "utf8")) as unknown;
  }
  const asarPath = artifactPath.endsWith(".asar")
    ? artifactPath
    : NodePath.join(artifactPath, "Contents/Resources/app.asar");
  if (!NodeFS.existsSync(asarPath)) {
    throw new SyncSourceProvenanceError(`missing packaged app.asar at ${asarPath}`);
  }
  try {
    return JSON.parse(extractFile(asarPath, "package.json").toString("utf8")) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new SyncSourceProvenanceError(`could not read package.json from ${asarPath}: ${detail}`);
  }
}

function readExactRemoteSyncTip(repo: string, remote: string, syncRef: string): string {
  const result = runGit(repo, ["ls-remote", "--refs", remote, syncRef]);
  if (result.error !== undefined) {
    throw new SyncSourceProvenanceError(
      `could not read ${remote} ${syncRef}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail =
      (result.stderr || result.stdout).trim() || `git ls-remote exited ${String(result.status)}`;
    throw new SyncSourceProvenanceError(`could not read ${remote} ${syncRef}: ${detail}`);
  }
  const [tip] = parseLsRemoteTips(result.stdout).filter((entry) => entry.ref === syncRef);
  if (tip === undefined) {
    throw new SyncSourceProvenanceError(`${remote} ${syncRef} is not published`);
  }
  return tip.sha;
}

export function checkArtifactSyncProvenance(input: {
  readonly repo: string;
  readonly remote?: string | undefined;
  readonly manifest: unknown;
  readonly artifactPath?: string | undefined;
}): SyncSourceProvenance {
  const binding = parseArtifactProvenanceBinding(input.manifest, input.artifactPath);
  const remote = resolveRemoteUrl(input.repo, configuredRemote(input.remote));
  const publishedSha = readExactRemoteSyncTip(input.repo, remote.name, binding.t3codeSyncRef);
  if (publishedSha !== binding.t3codeCommitHash) {
    throw new SyncSourceProvenanceError(
      `${remote.name} ${binding.t3codeSyncRef} tip ${publishedSha} does not match artifact commit ${binding.t3codeCommitHash}`,
    );
  }
  return {
    commit: binding.t3codeCommitHash,
    syncRef: binding.t3codeSyncRef,
    remote: remote.name,
    remoteUrl: remote.url,
    artifact: binding,
  };
}

export function assertInstallArtifactProvenance(input: {
  readonly artifactPath: string;
  readonly repo: string;
  readonly remote?: string | undefined;
}): SyncSourceProvenance {
  return checkArtifactSyncProvenance({
    repo: input.repo,
    remote: input.remote,
    artifactPath: input.artifactPath,
    manifest: readProvenanceManifest(input.artifactPath),
  });
}
