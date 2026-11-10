#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Standalone git merge CLI without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const FORK_SYNC_NEEDS_REVIEW_EXIT = 3;
export const FORK_SYNC_REPORT_VERSION = 1;
export const SETTINGS_SOURCE_PATH = "packages/contracts/src/settings.ts";
export const SETTINGS_SCHEMA_NAMES = ["ClientSettingsSchema", "ServerSettings"] as const;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SYNC_BRANCH = /^sync\/.+/;
const WORKTREE_PREFIX = "conn-fork-sync-";

export type ConflictStrategy = "ours" | "regenerate" | "manual" | "reapply";
export type PresenceKind = "file" | "symbol";
export type SettingsDefaultKind = "off" | "on" | "other";

export class ForkSyncError {
  readonly _tag = "ForkSyncError";
  readonly message: string;
  readonly worktree?: string;
  constructor(message: string, options: { worktree?: string } = {}) {
    this.message = message;
    if (options.worktree !== undefined) this.worktree = options.worktree;
  }
  toString() {
    return this.message;
  }
}

export function forkSyncMessage(cause: unknown): string {
  if (cause instanceof ForkSyncError || cause instanceof Error) return cause.message;
  return String(cause);
}

export interface ConflictRule {
  readonly glob: string;
  readonly strategy: ConflictStrategy;
  readonly command?: string | undefined;
  readonly patch?: string | undefined;
}

export interface PresenceCheck {
  readonly kind: PresenceKind;
  readonly path: string;
  readonly symbol?: string | undefined;
}

export interface ForkFeature {
  readonly id: string;
  readonly forkHeading: string;
  readonly files: ReadonlyArray<string>;
  readonly presence: ReadonlyArray<PresenceCheck>;
}

export interface ForkSyncManifest {
  readonly version: 1;
  readonly upstream: { readonly remote: string; readonly url: string; readonly ref: string };
  readonly conflictRules: ReadonlyArray<ConflictRule>;
  readonly features: ReadonlyArray<ForkFeature>;
  readonly guardTests: ReadonlyArray<string>;
  readonly settingsPolicy: string;
}

export interface SettingsPolicyEntry {
  readonly keepUpstreamDefault: boolean;
  readonly allowDefaultChange?: boolean | undefined;
  readonly note?: string | undefined;
}

export interface SettingsPolicy {
  readonly version: 1;
  readonly keys: Readonly<Record<string, SettingsPolicyEntry>>;
}

export interface SettingsField {
  readonly schema: string;
  readonly key: string;
  readonly defaultKind: SettingsDefaultKind;
}

export type SettingsChange =
  | {
      readonly kind: "added";
      readonly schema: string;
      readonly key: string;
      readonly defaultKind: SettingsDefaultKind;
    }
  | { readonly kind: "removed"; readonly schema: string; readonly key: string }
  | {
      readonly kind: "default-changed";
      readonly schema: string;
      readonly key: string;
      readonly from: SettingsDefaultKind;
      readonly to: SettingsDefaultKind;
    };

export interface SettingsChangeVerdict {
  readonly change: SettingsChange;
  readonly blocking: boolean;
  readonly keepUpstreamDefault: boolean;
  readonly reason: string;
}

export interface SettingsDiffResult {
  readonly oldSha: string;
  readonly newSha: string;
  readonly sourcePath: string;
  readonly changes: ReadonlyArray<SettingsChangeVerdict>;
  readonly blocking: boolean;
}

export interface PresenceCheckResult {
  readonly kind: PresenceKind;
  readonly path: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface FeaturePresenceResult {
  readonly id: string;
  readonly forkHeading: string;
  readonly ok: boolean;
  readonly checks: ReadonlyArray<PresenceCheckResult>;
}

export interface GuardTestResult {
  readonly path: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CheckFailure {
  readonly id: string;
  readonly detail?: string | undefined;
}

export interface CheckResults {
  readonly failures: ReadonlyArray<CheckFailure>;
}

export interface BaselineComparison {
  readonly newFailures: ReadonlyArray<CheckFailure>;
  readonly stillFailing: ReadonlyArray<CheckFailure>;
  readonly resolved: ReadonlyArray<CheckFailure>;
}

export interface AutoResolvedConflict {
  readonly path: string;
  readonly rule: ConflictStrategy;
  readonly glob: string;
}

export interface UnresolvedConflict {
  readonly path: string;
  readonly reason:
    | "no_rule"
    | "manual"
    | "regenerate_failed"
    | "reapply_failed"
    | "checkout_failed"
    | "package_json_conflicted";
  readonly glob?: string | undefined;
  readonly id?: string | undefined;
  readonly forkHeading?: string | undefined;
}

export interface CleanMerge {
  readonly path: string;
  readonly id?: string | undefined;
  readonly forkHeading?: string | undefined;
}

export interface ForkSyncReport {
  readonly version: typeof FORK_SYNC_REPORT_VERSION;
  readonly status: "ok" | "needs_review" | "error";
  readonly exitCode: number;
  readonly command: string;
  readonly failures: ReadonlyArray<string>;
  readonly upstream: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly branch: {
    readonly name: string | null;
    readonly tip: string | null;
    readonly committed: boolean;
  };
  readonly worktree: string | null;
  readonly autoResolved: ReadonlyArray<AutoResolvedConflict>;
  readonly unresolved: ReadonlyArray<UnresolvedConflict>;
  readonly cleanMerges: ReadonlyArray<CleanMerge>;
  readonly conflictMarkers: ReadonlyArray<string>;
  readonly presence: ReadonlyArray<FeaturePresenceResult>;
  readonly guards: ReadonlyArray<GuardTestResult>;
  readonly settings: SettingsDiffResult | null;
  readonly baseline: BaselineComparison | null;
  readonly notes: ReadonlyArray<string>;
}

export interface ForkSyncCliArgs {
  readonly command: string;
  readonly repo: string;
  readonly upstream: string | undefined;
  readonly base: string;
  readonly branch: string | undefined;
  readonly worktree: string | undefined;
  readonly report: string | undefined;
  readonly json: boolean;
  readonly manifest: string | undefined;
  readonly old: string | undefined;
  readonly new: string | undefined;
  readonly mainResults: string | undefined;
  readonly syncResults: string | undefined;
}

const STRATEGIES = new Set<ConflictStrategy>(["ours", "regenerate", "manual", "reapply"]);
const PRESENCE_KINDS = new Set<PresenceKind>(["file", "symbol"]);
const COMMANDS = ["merge", "guards", "settings-diff", "baseline", "check"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ForkSyncError(`${path} must be a nonempty string`);
  }
  return value;
}

function requireArray(value: unknown, path: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new ForkSyncError(`${path} must be an array`);
  return value;
}

export function matchGlob(glob: string, filePath: string): boolean {
  return NodePath.matchesGlob(filePath.replaceAll("\\", "/"), glob.replaceAll("\\", "/"));
}

export function firstMatchingRule(
  rules: ReadonlyArray<ConflictRule>,
  filePath: string,
): ConflictRule | undefined {
  return rules.find((rule) => matchGlob(rule.glob, filePath));
}

export function parsePresenceCheck(value: unknown, path: string): PresenceCheck {
  if (!isRecord(value)) throw new ForkSyncError(`${path} must be an object`);
  const kind = requireString(value.kind, `${path}.kind`);
  if (!PRESENCE_KINDS.has(kind as PresenceKind)) {
    throw new ForkSyncError(`${path}.kind must be file or symbol`);
  }
  const filePath = requireString(value.path, `${path}.path`);
  if (kind === "symbol") {
    return { kind, path: filePath, symbol: requireString(value.symbol, `${path}.symbol`) };
  }
  return { kind: "file", path: filePath };
}

export function parseConflictRule(value: unknown, path: string): ConflictRule {
  if (!isRecord(value)) throw new ForkSyncError(`${path} must be an object`);
  const glob = requireString(value.glob, `${path}.glob`);
  const strategy = requireString(value.strategy, `${path}.strategy`);
  if (!STRATEGIES.has(strategy as ConflictStrategy)) {
    throw new ForkSyncError(`${path}.strategy must be ours, regenerate, manual, or reapply`);
  }
  if (strategy === "regenerate") {
    return { glob, strategy, command: requireString(value.command, `${path}.command`) };
  }
  if (strategy === "reapply") {
    return { glob, strategy, patch: requireString(value.patch, `${path}.patch`) };
  }
  if (value.command !== undefined || value.patch !== undefined) {
    throw new ForkSyncError(`${path}.command/patch are only valid for regenerate/reapply`);
  }
  return { glob, strategy: strategy as "ours" | "manual" };
}

export function parseForkSyncManifest(value: unknown): ForkSyncManifest {
  if (!isRecord(value)) throw new ForkSyncError("fork-sync manifest must be an object");
  if (value.version !== 1) throw new ForkSyncError("fork-sync manifest version must be 1");
  if (!isRecord(value.upstream)) throw new ForkSyncError("upstream must be an object");
  const features = requireArray(value.features, "features").map((feature, index) => {
    if (!isRecord(feature)) throw new ForkSyncError(`features[${String(index)}] must be an object`);
    const files = requireArray(feature.files, `features[${String(index)}].files`).map(
      (file, fileIndex) =>
        requireString(file, `features[${String(index)}].files[${String(fileIndex)}]`),
    );
    if (files.length === 0) {
      throw new ForkSyncError(`features[${String(index)}].files must not be empty`);
    }
    const presence = requireArray(feature.presence, `features[${String(index)}].presence`).map(
      (check, checkIndex) =>
        parsePresenceCheck(check, `features[${String(index)}].presence[${String(checkIndex)}]`),
    );
    if (presence.length === 0) {
      throw new ForkSyncError(`features[${String(index)}].presence must not be empty`);
    }
    return {
      id: requireString(feature.id, `features[${String(index)}].id`),
      forkHeading: requireString(feature.forkHeading, `features[${String(index)}].forkHeading`),
      files,
      presence,
    };
  });
  if (features.length === 0) throw new ForkSyncError("features must not be empty");
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) throw new ForkSyncError(`duplicate feature id ${feature.id}`);
    ids.add(feature.id);
  }
  return {
    version: 1,
    upstream: {
      remote: requireString(value.upstream.remote, "upstream.remote"),
      url: requireString(value.upstream.url, "upstream.url"),
      ref: requireString(value.upstream.ref, "upstream.ref"),
    },
    conflictRules: requireArray(value.conflictRules, "conflictRules").map((rule, index) =>
      parseConflictRule(rule, `conflictRules[${String(index)}]`),
    ),
    features,
    guardTests:
      value.guardTests === undefined
        ? []
        : requireArray(value.guardTests, "guardTests").map((test, index) =>
            requireString(test, `guardTests[${String(index)}]`),
          ),
    settingsPolicy:
      typeof value.settingsPolicy === "string" && value.settingsPolicy.length > 0
        ? value.settingsPolicy
        : "settings-carryover.json",
  };
}

export function parseSettingsPolicy(value: unknown): SettingsPolicy {
  if (!isRecord(value)) throw new ForkSyncError("settings policy must be an object");
  if (value.version !== 1) throw new ForkSyncError("settings policy version must be 1");
  if (!isRecord(value.keys)) throw new ForkSyncError("settings policy keys must be an object");
  const keys: Record<string, SettingsPolicyEntry> = {};
  for (const [key, entry] of Object.entries(value.keys)) {
    if (!isRecord(entry)) throw new ForkSyncError(`keys.${key} must be an object`);
    if (typeof entry.keepUpstreamDefault !== "boolean") {
      throw new ForkSyncError(`keys.${key}.keepUpstreamDefault must be a boolean`);
    }
    keys[key] = {
      keepUpstreamDefault: entry.keepUpstreamDefault,
      ...(typeof entry.allowDefaultChange === "boolean"
        ? { allowDefaultChange: entry.allowDefaultChange }
        : {}),
      ...(typeof entry.note === "string" ? { note: entry.note } : {}),
    };
  }
  return { version: 1, keys };
}

export function loadJsonFile(path: string): unknown {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    throw new ForkSyncError(`could not read ${path}: ${forkSyncMessage(cause)}`);
  }
}

export function loadManifest(repo: string, manifestPath?: string): ForkSyncManifest {
  const path = manifestPath ?? NodePath.join(repo, "fork-sync.json");
  return parseForkSyncManifest(loadJsonFile(path));
}

export function loadSettingsPolicy(policyFile: string): SettingsPolicy {
  return parseSettingsPolicy(loadJsonFile(policyFile));
}

function policyFilePath(args: ForkSyncCliArgs, relativePath: string): string {
  if (args.manifest !== undefined) {
    return NodePath.join(NodePath.dirname(NodePath.resolve(args.manifest)), relativePath);
  }
  return NodePath.join(args.repo, relativePath);
}

export function forkChangeHeadings(markdown: string): ReadonlyArray<string> {
  const start = markdown.indexOf("\n## What the fork changes\n");
  const end = markdown.indexOf("\n## Keep the customizations");
  if (start < 0 || end < 0 || end <= start) {
    throw new ForkSyncError("FORK.md is missing What the fork changes / Keep the customizations");
  }
  return [...markdown.slice(start, end).matchAll(/^### (.+)$/gm)]
    .map((match) => match[1] ?? "")
    .filter((heading) => heading.length > 0 && !heading.startsWith("Upstream sync audit"));
}

export function knownSpotPaths(markdown: string): ReadonlyArray<string> {
  const start = markdown.indexOf("Known spots and how to resolve");
  const end = markdown.indexOf("\n2. Run the regression");
  if (start < 0 || end < 0 || end <= start) {
    throw new ForkSyncError("FORK.md is missing Known spots");
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of markdown.slice(start, end).matchAll(/`([^`]+)`/g)) {
    const value = match[1];
    if (value === undefined || seen.has(value) || !looksLikeRepoPath(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function looksLikeRepoPath(value: string): boolean {
  if (value.includes(" ") || value.startsWith("http") || value.startsWith("@")) return false;
  return value.includes("/") || /\.(ts|tsx|js|json|css|swift|kt|kts|md|yaml|yml)$/.test(value);
}

export function pathCoveredBy(entry: string, filePath: string): boolean {
  if (entry === filePath) return true;
  if (filePath.startsWith(`${entry}/`)) return true;
  if (matchGlob(entry, filePath)) return true;
  if (entry.endsWith("/**") && matchGlob(entry, filePath)) return true;
  if (filePath.startsWith(entry.replace(/\/\*\*?$/, "/"))) return true;
  return false;
}

export function featureForPath(
  features: ReadonlyArray<ForkFeature>,
  filePath: string,
): ForkFeature | undefined {
  return features.find((feature) => feature.files.some((file) => pathCoveredBy(file, filePath)));
}

function namesTheSamePath(entry: string, known: string): boolean {
  const file = entry.replace(/\\/g, "/");
  const spot = known.replace(/\\/g, "/").replace(/\/$/, "");
  if (pathCoveredBy(file, spot) || pathCoveredBy(spot, file)) return true;
  if (file === spot || file.endsWith(`/${spot}`) || spot.endsWith(`/${NodePath.basename(file)}`)) {
    return true;
  }
  if (file.includes(`/${spot}/`) || file.includes(`/${spot}/**`) || file.endsWith(`/${spot}`)) {
    return true;
  }
  if (spot.includes("*") && file.includes(spot)) return true;
  const base = NodePath.basename(file);
  const knownBase = NodePath.basename(spot);
  if (base === knownBase) return true;
  if (base.replace(/\.ios\.(tsx|ts)$/, ".$1") === knownBase.replace(/\.ios\.(tsx|ts)$/, ".$1")) {
    return true;
  }
  return matchGlob(file, spot);
}

export function coversKnownSpot(manifest: ForkSyncManifest, known: string): boolean {
  if (
    manifest.features.some((feature) => feature.files.some((file) => namesTheSamePath(file, known)))
  ) {
    return true;
  }
  return manifest.conflictRules.some(
    (rule) => namesTheSamePath(rule.glob, known) || matchGlob(rule.glob, known),
  );
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_") || value === undefined) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

function runGit(repo: string, args: ReadonlyArray<string>): GitResult {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: 50 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function requireGit(repo: string, args: ReadonlyArray<string>, onFail: string): string {
  const result = runGit(repo, args);
  if (result.error !== undefined) throw new ForkSyncError(`${onFail}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail =
      (result.stderr || result.stdout).trim() ||
      `git ${args.join(" ")} exited ${String(result.status)}`;
    throw new ForkSyncError(`${onFail}: ${detail}`);
  }
  return result.stdout;
}

export function resolveCommit(repo: string, ref: string): string {
  const sha = requireGit(
    repo,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    `could not resolve ${ref}`,
  )
    .trim()
    .toLowerCase();
  if (!FULL_COMMIT_SHA_PATTERN.test(sha)) {
    throw new ForkSyncError(
      `${ref} is not a full 40-character commit SHA (got ${JSON.stringify(sha)})`,
    );
  }
  return sha;
}

export function resolveMergeBase(repo: string, a: string, b: string): string {
  return resolveCommit(
    repo,
    requireGit(repo, ["merge-base", a, b], `could not find merge-base of ${a} and ${b}`).trim(),
  );
}

export function listFilesAtRef(repo: string, ref: string): ReadonlyArray<string> {
  return requireGit(repo, ["ls-tree", "-r", "--name-only", ref], `could not list ${ref}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function oursRulesHittingRef(
  repo: string,
  ref: string,
  rules: ReadonlyArray<ConflictRule>,
): ReadonlyArray<{ readonly glob: string; readonly hits: ReadonlyArray<string> }> {
  const files = listFilesAtRef(repo, ref);
  return rules
    .filter((rule) => rule.strategy === "ours")
    .map((rule) => ({
      glob: rule.glob,
      hits: files.filter((file) => matchGlob(rule.glob, file)),
    }))
    .filter((entry) => entry.hits.length > 0);
}

function skipCommentOrString(source: string, index: number): number | undefined {
  if (source.startsWith("//", index)) {
    const end = source.indexOf("\n", index);
    return end < 0 ? source.length : end + 1;
  }
  if (source.startsWith("/*", index)) {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  }
  const quote = source[index];
  if (quote === "'" || quote === '"' || quote === "`") {
    let cursor = index + 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === quote) return cursor + 1;
      cursor += 1;
    }
    return source.length;
  }
  return undefined;
}

function schemaBody(source: string, schemaName: string): string | undefined {
  const marker = `export const ${schemaName} = Schema.Struct({`;
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  let index = start + marker.length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const skipped = skipCommentOrString(source, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const char = source[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    index += 1;
  }
  return source.slice(start + marker.length, index - 1);
}

function topLevelFields(
  body: string,
): ReadonlyArray<{ readonly name: string; readonly text: string }> {
  const fields: Array<{ name: string; text: string }> = [];
  let depth = 0;
  let fieldStart = -1;
  let name = "";
  let index = 0;
  while (index < body.length) {
    const skipped = skipCommentOrString(body, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    if (depth === 0) {
      const slice = body.slice(index);
      const match = slice.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (match && match[2] !== undefined) {
        if (fieldStart >= 0) fields.push({ name, text: body.slice(fieldStart, index) });
        name = match[2];
        fieldStart = index;
        index += match[0].length;
        continue;
      }
    }
    const char = body[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    index += 1;
  }
  if (fieldStart >= 0) fields.push({ name, text: body.slice(fieldStart) });
  return fields;
}

export function classifySettingsDefault(fieldText: string): SettingsDefaultKind {
  const booleanField = /Schema\.Boolean/.test(fieldText);
  if (booleanField && /Effect\.succeed\(\s*false\s*\)/.test(fieldText)) return "off";
  if (booleanField && /Effect\.succeed\(\s*true\s*\)/.test(fieldText)) return "on";
  return "other";
}

export function extractSettingsFields(source: string): ReadonlyArray<SettingsField> {
  const fields: SettingsField[] = [];
  for (const schema of SETTINGS_SCHEMA_NAMES) {
    const body = schemaBody(source, schema);
    if (body === undefined) {
      throw new ForkSyncError(`settings schema ${schema} is missing`);
    }
    const parsed = topLevelFields(body);
    if (parsed.length === 0) {
      throw new ForkSyncError(`settings schema ${schema} has no fields`);
    }
    for (const field of parsed) {
      fields.push({ schema, key: field.name, defaultKind: classifySettingsDefault(field.text) });
    }
  }
  return fields;
}

export function diffSettingsFields(
  oldFields: ReadonlyArray<SettingsField>,
  newFields: ReadonlyArray<SettingsField>,
): ReadonlyArray<SettingsChange> {
  const oldByKey = new Map(oldFields.map((field) => [`${field.schema}.${field.key}`, field]));
  const newByKey = new Map(newFields.map((field) => [`${field.schema}.${field.key}`, field]));
  const changes: SettingsChange[] = [];
  for (const [id, field] of newByKey) {
    const previous = oldByKey.get(id);
    if (previous === undefined) {
      changes.push({
        kind: "added",
        schema: field.schema,
        key: field.key,
        defaultKind: field.defaultKind,
      });
      continue;
    }
    if (previous.defaultKind !== field.defaultKind) {
      changes.push({
        kind: "default-changed",
        schema: field.schema,
        key: field.key,
        from: previous.defaultKind,
        to: field.defaultKind,
      });
    }
  }
  for (const [id, field] of oldByKey) {
    if (!newByKey.has(id)) changes.push({ kind: "removed", schema: field.schema, key: field.key });
  }
  return changes;
}

function policyEntry(
  policy: SettingsPolicy,
  schema: string,
  key: string,
): SettingsPolicyEntry | undefined {
  return policy.keys[`${schema}.${key}`] ?? policy.keys[key];
}

export function classifySettingsChange(
  change: SettingsChange,
  policy: SettingsPolicy,
): SettingsChangeVerdict {
  const entry = policyEntry(policy, change.schema, change.key);
  if (change.kind === "removed") {
    return {
      change,
      blocking: false,
      keepUpstreamDefault: true,
      reason: entry?.note ?? "removed keys are reported, not blocking",
    };
  }
  if (change.kind === "default-changed") {
    const allowed = entry?.allowDefaultChange === true;
    return {
      change,
      blocking: !allowed,
      keepUpstreamDefault: entry?.keepUpstreamDefault ?? false,
      reason: allowed
        ? (entry?.note ?? "policy allows this default change")
        : "settings default changed; unknown to policy",
    };
  }
  if (change.defaultKind === "off" || change.defaultKind === "other") {
    return {
      change,
      blocking: false,
      keepUpstreamDefault: true,
      reason:
        entry?.note ??
        (change.defaultKind === "off"
          ? "standing policy: new default-off keys keep the upstream default"
          : "standing policy: new non-boolean keys keep the upstream default"),
    };
  }
  if (entry?.keepUpstreamDefault === true) {
    return {
      change,
      blocking: false,
      keepUpstreamDefault: true,
      reason: entry.note ?? "policy keeps the upstream default",
    };
  }
  return {
    change,
    blocking: true,
    keepUpstreamDefault: entry?.keepUpstreamDefault ?? false,
    reason: "unknown or non-default-off settings change has no policy",
  };
}

export function diffSettingsSources(
  oldSource: string,
  newSource: string,
  policy: SettingsPolicy,
  shas: { readonly oldSha: string; readonly newSha: string },
): SettingsDiffResult {
  const changes = diffSettingsFields(
    extractSettingsFields(oldSource),
    extractSettingsFields(newSource),
  ).map((change) => classifySettingsChange(change, policy));
  return {
    oldSha: shas.oldSha,
    newSha: shas.newSha,
    sourcePath: SETTINGS_SOURCE_PATH,
    changes,
    blocking: changes.some((change) => change.blocking),
  };
}

function gitShow(repo: string, sha: string, path: string): string {
  const result = runGit(repo, ["show", `${sha}:${path}`]);
  if (result.status !== 0) {
    throw new ForkSyncError(
      `could not read ${path} at ${sha}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

export function diffSettingsAtShas(
  repo: string,
  oldSha: string,
  newSha: string,
  policy: SettingsPolicy,
): SettingsDiffResult {
  return diffSettingsSources(
    gitShow(repo, oldSha, SETTINGS_SOURCE_PATH),
    gitShow(repo, newSha, SETTINGS_SOURCE_PATH),
    policy,
    { oldSha, newSha },
  );
}

function presenceFromContents(
  check: PresenceCheck,
  contents: string | undefined,
): PresenceCheckResult {
  if (contents === undefined) {
    return { kind: check.kind, path: check.path, ok: false, detail: `missing ${check.path}` };
  }
  if (check.kind === "file") {
    return { kind: check.kind, path: check.path, ok: true, detail: `found ${check.path}` };
  }
  const needle = check.symbol;
  if (needle === undefined || !contents.includes(needle)) {
    return {
      kind: check.kind,
      path: check.path,
      ok: false,
      detail: `${check.path} does not contain ${JSON.stringify(needle)}`,
    };
  }
  return {
    kind: check.kind,
    path: check.path,
    ok: true,
    detail: `${check.path} contains ${JSON.stringify(needle)}`,
  };
}

export function runPresenceChecks(
  root: string,
  features: ReadonlyArray<ForkFeature>,
): ReadonlyArray<FeaturePresenceResult> {
  return features.map((feature) => {
    const checks = feature.presence.map((check) => {
      const absolute = NodePath.join(root, check.path);
      const contents = NodeFS.existsSync(absolute)
        ? NodeFS.readFileSync(absolute, "utf8")
        : undefined;
      return presenceFromContents(check, contents);
    });
    return {
      id: feature.id,
      forkHeading: feature.forkHeading,
      ok: checks.every((check) => check.ok),
      checks,
    };
  });
}

export function runPresenceChecksAtRef(
  repo: string,
  ref: string,
  features: ReadonlyArray<ForkFeature>,
): ReadonlyArray<FeaturePresenceResult> {
  return features.map((feature) => {
    const checks = feature.presence.map((check) => {
      const shown = runGit(repo, ["show", `${ref}:${check.path}`]);
      return presenceFromContents(check, shown.status === 0 ? shown.stdout : undefined);
    });
    return {
      id: feature.id,
      forkHeading: feature.forkHeading,
      ok: checks.every((check) => check.ok),
      checks,
    };
  });
}

export function defaultGuardRunner(root: string, testPath: string): GuardTestResult {
  const absolute = NodePath.join(root, testPath);
  if (!NodeFS.existsSync(absolute)) {
    return { path: testPath, ok: false, detail: `missing ${testPath}` };
  }
  const command =
    testPath.endsWith(".test.ts") || testPath.endsWith(".test.tsx")
      ? (["vp", ["test", "run", testPath]] as const)
      : ([process.execPath, [absolute]] as const);
  const result = NodeChildProcess.spawnSync(command[0], command[1], {
    cwd: root,
    encoding: "utf8",
    env: gitEnv(),
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const ok = (result.status ?? 1) === 0;
  return {
    path: testPath,
    ok,
    detail: ok ? `passed ${testPath}` : output.slice(-500) || `failed ${testPath}`,
  };
}

export function runGuardTests(
  root: string,
  tests: ReadonlyArray<string>,
  run: (root: string, testPath: string) => GuardTestResult = defaultGuardRunner,
): ReadonlyArray<GuardTestResult> {
  return tests.map((testPath) => run(root, testPath));
}

export function parseCheckResults(value: unknown): CheckResults {
  if (!isRecord(value)) throw new ForkSyncError("check results must be an object");
  const failures = requireArray(value.failures, "failures").map((failure, index) => {
    if (typeof failure === "string") return { id: failure };
    if (!isRecord(failure)) {
      throw new ForkSyncError(`failures[${String(index)}] must be a string or object`);
    }
    return {
      id: requireString(failure.id, `failures[${String(index)}].id`),
      ...(typeof failure.detail === "string" ? { detail: failure.detail } : {}),
    };
  });
  return { failures };
}

export function parseTypecheckOutput(text: string): CheckResults {
  const failures: CheckFailure[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/^(.+?):(\d+):(\d+) - (?:error|suggestion) (TS\d+): (.+)$/gm)) {
    const file = match[1];
    const code = match[4];
    const message = match[5];
    if (file === undefined || code === undefined || message === undefined) continue;
    const id = `${file} ${code} ${message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    failures.push({ id, detail: match[0] });
  }
  return { failures };
}

export function parseTestOutput(text: string): CheckResults {
  const failures: CheckFailure[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/^(?: FAIL | × )\s*(.+?\.test\.\w+)\s+>\s+(.+)$/gm)) {
    const file = match[1];
    const name = match[2];
    if (file === undefined || name === undefined) continue;
    const id = `${file} > ${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    failures.push({ id, detail: match[0] });
  }
  return { failures };
}

export function loadBaselineFile(path: string): CheckResults {
  const text = NodeFS.readFileSync(path, "utf8");
  try {
    return parseCheckResults(JSON.parse(text) as unknown);
  } catch {
    if (/ - (?:error|suggestion) TS\d+:/.test(text)) return parseTypecheckOutput(text);
    return parseTestOutput(text);
  }
}

export function compareBaselines(main: CheckResults, sync: CheckResults): BaselineComparison {
  const mainIds = new Set(main.failures.map((failure) => failure.id));
  const syncIds = new Set(sync.failures.map((failure) => failure.id));
  return {
    newFailures: sync.failures.filter((failure) => !mainIds.has(failure.id)),
    stillFailing: sync.failures.filter((failure) => mainIds.has(failure.id)),
    resolved: main.failures.filter((failure) => !syncIds.has(failure.id)),
  };
}

function emptyReport(command: string): ForkSyncReport {
  return {
    version: FORK_SYNC_REPORT_VERSION,
    status: "ok",
    exitCode: 0,
    command,
    failures: [],
    upstream: { ref: "", sha: "" },
    base: { ref: "", sha: "" },
    branch: { name: null, tip: null, committed: false },
    worktree: null,
    autoResolved: [],
    unresolved: [],
    cleanMerges: [],
    conflictMarkers: [],
    presence: [],
    guards: [],
    settings: null,
    baseline: null,
    notes: [],
  };
}

function failureLines(report: ForkSyncReport): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const item of report.unresolved) {
    const feature = item.forkHeading === undefined ? "" : ` (${item.forkHeading})`;
    lines.push(`unresolved ${item.path} ${item.reason}${feature}`);
  }
  for (const feature of report.presence) {
    if (feature.ok) continue;
    for (const check of feature.checks) {
      if (!check.ok) lines.push(`presence ${feature.id}: ${check.detail}`);
    }
  }
  for (const guard of report.guards) {
    if (!guard.ok) lines.push(`guard ${guard.path}: ${guard.detail.split("\n")[0] ?? "failed"}`);
  }
  for (const change of report.settings?.changes ?? []) {
    if (change.blocking) {
      lines.push(`settings ${change.change.schema}.${change.change.key}: ${change.reason}`);
    }
  }
  for (const path of report.conflictMarkers) lines.push(`conflict-marker ${path}`);
  for (const failure of report.baseline?.newFailures ?? []) {
    lines.push(`baseline ${failure.id}`);
  }
  return lines;
}

function finalizeReport(report: ForkSyncReport): ForkSyncReport {
  const failures = failureLines(report);
  const needsReview =
    failures.length > 0 ||
    report.unresolved.length > 0 ||
    report.presence.some((feature) => !feature.ok) ||
    report.guards.some((guard) => !guard.ok) ||
    report.settings?.blocking === true ||
    (report.baseline !== null && report.baseline.newFailures.length > 0);
  if (report.status === "error") return { ...report, failures };
  if (!needsReview) return { ...report, failures, status: "ok", exitCode: 0 };
  return { ...report, failures, status: "needs_review", exitCode: FORK_SYNC_NEEDS_REVIEW_EXIT };
}

function unmergedPaths(repo: string): ReadonlyArray<string> {
  return requireGit(
    repo,
    ["diff", "--name-only", "--diff-filter=U"],
    "could not list unmerged paths",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function runShellCommand(
  cwd: string,
  command: string,
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = NodeChildProcess.spawnSync(command, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    shell: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function annotateUnresolved(
  item: UnresolvedConflict,
  features: ReadonlyArray<ForkFeature>,
): UnresolvedConflict {
  const feature = featureForPath(features, item.path);
  if (feature === undefined) return item;
  return { ...item, id: feature.id, forkHeading: feature.forkHeading };
}

export function applyConflictRules(
  repo: string,
  rules: ReadonlyArray<ConflictRule>,
  paths: ReadonlyArray<string>,
  features: ReadonlyArray<ForkFeature> = [],
): {
  readonly autoResolved: ReadonlyArray<AutoResolvedConflict>;
  readonly unresolved: ReadonlyArray<UnresolvedConflict>;
} {
  const autoResolved: AutoResolvedConflict[] = [];
  const unresolved: UnresolvedConflict[] = [];
  const regenerate: string[] = [];
  const rest: string[] = [];
  for (const path of paths) {
    const rule = firstMatchingRule(rules, path);
    if (rule?.strategy === "regenerate") regenerate.push(path);
    else rest.push(path);
  }
  const applyOne = (path: string): void => {
    const rule = firstMatchingRule(rules, path);
    if (rule === undefined) {
      unresolved.push(annotateUnresolved({ path, reason: "no_rule" }, features));
      return;
    }
    if (rule.strategy === "manual") {
      unresolved.push(annotateUnresolved({ path, reason: "manual", glob: rule.glob }, features));
      return;
    }
    const side = rule.strategy === "ours" ? "--ours" : "--theirs";
    const checkout = runGit(repo, ["checkout", side, "--", path]);
    if (checkout.status !== 0) {
      unresolved.push(
        annotateUnresolved({ path, reason: "checkout_failed", glob: rule.glob }, features),
      );
      return;
    }
    if (rule.strategy === "regenerate") {
      const command = rule.command;
      if (command === undefined) {
        unresolved.push(
          annotateUnresolved({ path, reason: "regenerate_failed", glob: rule.glob }, features),
        );
        return;
      }
      const regenerated = runShellCommand(repo, command);
      if (regenerated.status !== 0) {
        unresolved.push(
          annotateUnresolved({ path, reason: "regenerate_failed", glob: rule.glob }, features),
        );
        return;
      }
    }
    if (rule.strategy === "reapply") {
      const patch = rule.patch === undefined ? undefined : NodePath.join(repo, rule.patch);
      if (patch === undefined || !NodeFS.existsSync(patch)) {
        unresolved.push(
          annotateUnresolved({ path, reason: "reapply_failed", glob: rule.glob }, features),
        );
        return;
      }
      const applied = runGit(repo, ["apply", "--whitespace=nowarn", patch]);
      if (applied.status !== 0) {
        unresolved.push(
          annotateUnresolved({ path, reason: "reapply_failed", glob: rule.glob }, features),
        );
        return;
      }
    }
    const staged = runGit(repo, ["add", "--", path]);
    if (staged.status !== 0) {
      unresolved.push(
        annotateUnresolved({ path, reason: "checkout_failed", glob: rule.glob }, features),
      );
      return;
    }
    autoResolved.push({ path, rule: rule.strategy, glob: rule.glob });
  };
  for (const path of rest) applyOne(path);
  const packageJsonConflicted = [...unresolved, ...unmergedPaths(repo)].some((item) => {
    const path = typeof item === "string" ? item : item.path;
    return NodePath.basename(path) === "package.json";
  });
  if (packageJsonConflicted) {
    for (const path of regenerate) {
      const rule = firstMatchingRule(rules, path);
      unresolved.push(
        annotateUnresolved({ path, reason: "package_json_conflicted", glob: rule?.glob }, features),
      );
    }
  } else {
    for (const path of regenerate) applyOne(path);
  }
  return { autoResolved, unresolved };
}

function mergeMessage(
  upstreamSha: string,
  autoResolved: ReadonlyArray<AutoResolvedConflict>,
  unresolved: ReadonlyArray<UnresolvedConflict>,
): string {
  const lines = [`Conn nightly: merge ${upstreamSha}`, ""];
  if (autoResolved.length > 0) {
    lines.push("Auto-resolved:");
    for (const item of autoResolved) lines.push(`- ${item.path} (${item.rule} via ${item.glob})`);
    lines.push("");
  }
  if (unresolved.length > 0) {
    lines.push("Unresolved:");
    for (const item of unresolved) lines.push(`- ${item.path} (${item.reason})`);
    lines.push("");
  }
  return lines.join("\n");
}

function inMerge(repo: string): boolean {
  return runGit(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0;
}

function assertSyncBranch(name: string): void {
  if (!SYNC_BRANCH.test(name) || name === "sync/main") {
    throw new ForkSyncError(`merge branch must match sync/<name> and cannot be main (got ${name})`);
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return NodeFS.realpathSync(a) === NodeFS.realpathSync(b);
  } catch {
    return NodePath.resolve(a) === NodePath.resolve(b);
  }
}

function worktreeForBranch(repo: string, branch: string): string | undefined {
  const listed = runGit(repo, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return undefined;
  let current: string | undefined;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}` && current !== undefined) return current;
  }
  return undefined;
}

function removeWorktree(repo: string, worktree: string, deleteBranch?: string): void {
  runGit(repo, ["worktree", "remove", "--force", worktree]);
  NodeFS.rmSync(worktree, { recursive: true, force: true });
  if (deleteBranch !== undefined) runGit(repo, ["branch", "-D", deleteBranch]);
}

function pruneStaleForkSyncWorktrees(repo: string, keep?: string): void {
  runGit(repo, ["worktree", "prune"]);
  const listed = runGit(repo, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return;
  let current: string | undefined;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    if (line === "" && current !== undefined) {
      const path = current;
      current = undefined;
      if (keep !== undefined && samePath(path, keep)) continue;
      if (!path.includes(WORKTREE_PREFIX)) continue;
      if (samePath(path, repo)) continue;
      runGit(repo, ["worktree", "remove", "--force", path]);
    }
  }
}

function linkNodeModules(worktree: string, source: string): void {
  const from = NodePath.join(source, "node_modules");
  const to = NodePath.join(worktree, "node_modules");
  if (!NodeFS.existsSync(from) || NodeFS.existsSync(to)) return;
  NodeFS.symlinkSync(from, to, "dir");
}

function conflictMarkerPaths(repo: string, paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const marked: string[] = [];
  for (const path of paths) {
    const absolute = NodePath.join(repo, path);
    if (!NodeFS.existsSync(absolute) || NodeFS.statSync(absolute).isDirectory()) continue;
    const contents = NodeFS.readFileSync(absolute, "utf8");
    if (contents.includes("\n<<<<<<< ") || contents.startsWith("<<<<<<< ")) marked.push(path);
  }
  return marked;
}

function cleanMergePaths(
  repo: string,
  baseSha: string,
  upstreamSha: string,
  unmerged: ReadonlyArray<string>,
  features: ReadonlyArray<ForkFeature>,
): ReadonlyArray<CleanMerge> {
  const changed = new Set(
    runGit(repo, ["diff", "--name-only", baseSha, upstreamSha])
      .stdout.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const blocked = new Set(unmerged);
  const seen = new Set<string>();
  const result: CleanMerge[] = [];
  for (const feature of features) {
    for (const file of feature.files) {
      for (const path of changed) {
        if (blocked.has(path) || seen.has(path) || !pathCoveredBy(file, path)) continue;
        if (unmergedPaths(repo).includes(path)) continue;
        seen.add(path);
        result.push({ path, id: feature.id, forkHeading: feature.forkHeading });
      }
    }
  }
  return result;
}

export function mergeUpstream(input: {
  readonly repo: string;
  readonly upstreamRef: string;
  readonly baseRef: string;
  readonly branch?: string | undefined;
  readonly worktree?: string | undefined;
  readonly manifest: ForkSyncManifest;
}): {
  readonly repo: string;
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly upstreamSha: string;
  readonly baseSha: string;
  readonly tip: string | null;
  readonly committed: boolean;
  readonly autoResolved: ReadonlyArray<AutoResolvedConflict>;
  readonly unresolved: ReadonlyArray<UnresolvedConflict>;
  readonly cleanMerges: ReadonlyArray<CleanMerge>;
  readonly conflictMarkers: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
} {
  const upstreamSha = resolveCommit(input.repo, input.upstreamRef);
  const baseSha = resolveCommit(input.repo, input.baseRef);
  const notes: string[] = [];
  const ancestor = runGit(input.repo, ["merge-base", "--is-ancestor", upstreamSha, baseSha]);
  if (ancestor.status === 0) {
    notes.push(`HEAD already contains ${upstreamSha}`);
    return {
      repo: input.repo,
      worktree: null,
      branch: null,
      upstreamSha,
      baseSha,
      tip: baseSha,
      committed: true,
      autoResolved: [],
      unresolved: [],
      cleanMerges: [],
      conflictMarkers: [],
      notes,
    };
  }

  const branch = input.branch ?? `sync/${upstreamSha}`;
  assertSyncBranch(branch);
  pruneStaleForkSyncWorktrees(input.repo, input.worktree);
  const existingWorktree = worktreeForBranch(input.repo, branch);
  let worktree =
    existingWorktree ??
    input.worktree ??
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), WORKTREE_PREFIX));
  if (samePath(worktree, input.repo)) {
    throw new ForkSyncError("merge worktree cannot be the main checkout");
  }
  let createdWorktree = false;
  let createdBranch = false;
  try {
    const existingBranch = runGit(input.repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    if (existingWorktree !== undefined) {
      worktree = existingWorktree;
    } else if (existingBranch.status === 0) {
      requireGit(
        input.repo,
        ["worktree", "add", worktree, branch],
        `could not attach worktree at ${worktree}`,
      );
      createdWorktree = true;
    } else {
      requireGit(
        input.repo,
        ["worktree", "add", "-b", branch, worktree, baseSha],
        `could not create worktree at ${worktree}`,
      );
      createdWorktree = true;
      createdBranch = true;
    }
    const repo = worktree;
    if (
      !inMerge(repo) &&
      runGit(repo, ["merge-base", "--is-ancestor", upstreamSha, "HEAD"]).status !== 0
    ) {
      const merge = runGit(repo, ["merge", "--no-commit", "--no-ff", upstreamSha]);
      if (merge.error !== undefined) {
        throw new ForkSyncError(`merge failed: ${merge.error.message}`, { worktree });
      }
      const conflicts = unmergedPaths(repo);
      if (merge.status !== 0 && conflicts.length === 0) {
        throw new ForkSyncError(
          `merge failed: ${(merge.stderr || merge.stdout).trim() || `git merge exited ${String(merge.status)}`}`,
          { worktree },
        );
      }
    }
    const conflicts = unmergedPaths(repo);
    const applied = applyConflictRules(
      repo,
      input.manifest.conflictRules,
      conflicts,
      input.manifest.features,
    );
    let committed = false;
    if (applied.unresolved.length === 0 && unmergedPaths(repo).length === 0 && inMerge(repo)) {
      requireGit(
        repo,
        [
          "commit",
          "--no-edit",
          "-m",
          mergeMessage(upstreamSha, applied.autoResolved, applied.unresolved),
        ],
        "could not commit merge",
      );
      committed = true;
    }
    const remaining = unmergedPaths(repo);
    const markers = conflictMarkerPaths(repo, remaining);
    return {
      repo,
      worktree,
      branch,
      upstreamSha,
      baseSha,
      tip: committed ? resolveCommit(repo, "HEAD") : null,
      committed,
      autoResolved: applied.autoResolved,
      unresolved: applied.unresolved,
      cleanMerges: cleanMergePaths(repo, baseSha, upstreamSha, remaining, input.manifest.features),
      conflictMarkers: markers,
      notes,
    };
  } catch (cause) {
    if (createdWorktree) removeWorktree(input.repo, worktree, createdBranch ? branch : undefined);
    if (cause instanceof ForkSyncError) {
      throw new ForkSyncError(cause.message, { worktree: cause.worktree ?? worktree });
    }
    throw new ForkSyncError(forkSyncMessage(cause), { worktree });
  }
}

export function parseForkSyncArgs(argv: ReadonlyArray<string>): ForkSyncCliArgs {
  const [command, ...flags] = argv;
  if (command === undefined || command.startsWith("--")) {
    throw new ForkSyncError(`usage: fork-sync.ts <${COMMANDS.join("|")}> [options]`);
  }
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    throw new ForkSyncError(`unknown command ${command}`);
  }
  let repo = process.cwd();
  let upstream: string | undefined;
  let base = "main";
  let branch: string | undefined;
  let worktree: string | undefined;
  let report: string | undefined;
  let json = false;
  let manifest: string | undefined;
  let oldSha: string | undefined;
  let newSha: string | undefined;
  let mainResults: string | undefined;
  let syncResults: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = flags[index + 1];
    const needsValue =
      flag === "--repo" ||
      flag === "--upstream" ||
      flag === "--base" ||
      flag === "--branch" ||
      flag === "--worktree" ||
      flag === "--report" ||
      flag === "--manifest" ||
      flag === "--old" ||
      flag === "--new" ||
      flag === "--main" ||
      flag === "--sync";
    if (needsValue) {
      if (value === undefined || value.startsWith("--")) {
        throw new ForkSyncError(`missing value for ${flag}`);
      }
      index += 1;
      if (flag === "--repo") repo = value;
      else if (flag === "--upstream") upstream = value;
      else if (flag === "--base") base = value;
      else if (flag === "--branch") branch = value;
      else if (flag === "--worktree") worktree = value;
      else if (flag === "--report") report = value;
      else if (flag === "--manifest") manifest = value;
      else if (flag === "--old") oldSha = value;
      else if (flag === "--new") newSha = value;
      else if (flag === "--main") mainResults = value;
      else syncResults = value;
      continue;
    }
    throw new ForkSyncError(`unknown argument: ${flag}`);
  }
  return {
    command,
    repo,
    upstream,
    base,
    branch,
    worktree,
    report,
    json,
    manifest,
    old: oldSha,
    new: newSha,
    mainResults,
    syncResults,
  };
}

function attachChecks(
  report: ForkSyncReport,
  repo: string,
  sourceRepo: string,
  manifest: ForkSyncManifest,
  policyFile: string,
  oldSha: string,
  newSha: string,
): ForkSyncReport {
  if (repo !== sourceRepo) linkNodeModules(repo, sourceRepo);
  const presence = runPresenceChecks(repo, manifest.features);
  const guards = runGuardTests(repo, manifest.guardTests);
  const settings = diffSettingsAtShas(repo, oldSha, newSha, loadSettingsPolicy(policyFile));
  return finalizeReport({ ...report, presence, guards, settings });
}

export function runForkSync(args: ForkSyncCliArgs): ForkSyncReport {
  if (args.command === "baseline") {
    if (args.mainResults === undefined || args.syncResults === undefined) {
      throw new ForkSyncError("baseline requires --main <file> and --sync <file>");
    }
    const baseline = compareBaselines(
      loadBaselineFile(args.mainResults),
      loadBaselineFile(args.syncResults),
    );
    return finalizeReport({
      ...emptyReport("baseline"),
      baseline,
      notes: [`${String(baseline.newFailures.length)} new failures versus main`],
    });
  }

  const manifest = loadManifest(args.repo, args.manifest);

  if (args.command === "guards") {
    const presence = runPresenceChecks(args.repo, manifest.features);
    const guards = runGuardTests(args.repo, manifest.guardTests);
    return finalizeReport({ ...emptyReport("guards"), presence, guards });
  }

  if (args.command === "settings-diff") {
    const newSha = resolveCommit(
      args.repo,
      args.new ?? args.upstream ?? `${manifest.upstream.remote}/${manifest.upstream.ref}`,
    );
    const oldSha = resolveCommit(
      args.repo,
      args.old ?? resolveMergeBase(args.repo, args.base, newSha),
    );
    const settings = diffSettingsAtShas(
      args.repo,
      oldSha,
      newSha,
      loadSettingsPolicy(policyFilePath(args, manifest.settingsPolicy)),
    );
    return finalizeReport({
      ...emptyReport("settings-diff"),
      upstream: { ref: args.new ?? args.upstream ?? manifest.upstream.ref, sha: newSha },
      base: { ref: args.old ?? args.base, sha: oldSha },
      settings,
    });
  }

  if (args.command === "check") {
    const presence = runPresenceChecks(args.repo, manifest.features);
    const guards = runGuardTests(args.repo, manifest.guardTests);
    const upstreamRef = args.upstream ?? `${manifest.upstream.remote}/${manifest.upstream.ref}`;
    const newSha = resolveCommit(args.repo, upstreamRef);
    const oldSha = resolveMergeBase(args.repo, args.base, newSha);
    const settings = diffSettingsAtShas(
      args.repo,
      oldSha,
      newSha,
      loadSettingsPolicy(policyFilePath(args, manifest.settingsPolicy)),
    );
    return finalizeReport({ ...emptyReport("check"), presence, guards, settings });
  }

  if (args.command !== "merge") {
    throw new ForkSyncError(`unknown command ${args.command}`);
  }
  const upstreamRef = args.upstream ?? `${manifest.upstream.remote}/${manifest.upstream.ref}`;
  const merged = mergeUpstream({
    repo: args.repo,
    upstreamRef,
    baseRef: args.base,
    branch: args.branch,
    worktree: args.worktree,
    manifest,
  });
  const report: ForkSyncReport = {
    ...emptyReport("merge"),
    upstream: { ref: upstreamRef, sha: merged.upstreamSha },
    base: { ref: args.base, sha: merged.baseSha },
    branch: { name: merged.branch, tip: merged.tip, committed: merged.committed },
    worktree: merged.worktree,
    autoResolved: merged.autoResolved,
    unresolved: merged.unresolved,
    cleanMerges: merged.cleanMerges,
    conflictMarkers: merged.conflictMarkers,
    notes: merged.notes,
  };
  if (merged.worktree === null) return finalizeReport(report);
  const checked = attachChecks(
    report,
    merged.repo,
    args.repo,
    manifest,
    policyFilePath(args, manifest.settingsPolicy),
    resolveMergeBase(merged.repo, merged.baseSha, merged.upstreamSha),
    merged.upstreamSha,
  );
  if (args.mainResults !== undefined && args.syncResults !== undefined) {
    return finalizeReport({
      ...checked,
      baseline: compareBaselines(
        loadBaselineFile(args.mainResults),
        loadBaselineFile(args.syncResults),
      ),
    });
  }
  return checked;
}

export function writeReport(report: ForkSyncReport, path: string | undefined, json: boolean): void {
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (path !== undefined) NodeFS.writeFileSync(path, body);
  if (json || path === undefined) process.stdout.write(body);
}

function isCliEntry(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return NodePath.resolve(invoked) === NodeURL.fileURLToPath(import.meta.url);
}

if (isCliEntry()) {
  let args: ForkSyncCliArgs | undefined;
  try {
    args = parseForkSyncArgs(process.argv.slice(2));
    const report = runForkSync(args);
    writeReport(report, args.report, args.json);
    process.exitCode = report.exitCode;
  } catch (error) {
    const message = forkSyncMessage(error);
    console.error(message);
    const worktree = error instanceof ForkSyncError ? (error.worktree ?? null) : null;
    if (args !== undefined) {
      writeReport(
        {
          ...emptyReport(args.command),
          status: "error",
          exitCode: 1,
          worktree,
          notes: [message],
          failures: [message],
        },
        args.report,
        args.json,
      );
    }
    process.exitCode = 1;
  }
}
