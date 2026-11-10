#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Standalone git merge CLI without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  checkPublishedSyncSource,
  FULL_COMMIT_SHA_PATTERN,
  syncSourceProvenanceMessage,
} from "./sync-source-provenance.ts";

export const FORK_SYNC_NEEDS_REVIEW_EXIT = 3;
export const FORK_SYNC_REPORT_VERSION = 1;
export const SETTINGS_SOURCE_PATH = "packages/contracts/src/settings.ts";
export const SETTINGS_SCHEMA_NAMES = ["ClientSettingsSchema", "ServerSettings"] as const;

export type ConflictStrategy = "ours" | "theirs" | "regenerate" | "manual";
export type PresenceKind = "file" | "symbol" | "route" | "test";
export type SettingsDefaultKind = "off" | "on" | "other";

export class ForkSyncError {
  readonly _tag = "ForkSyncError";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
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
}

export interface PresenceCheck {
  readonly kind: PresenceKind;
  readonly path: string;
  readonly symbol?: string | undefined;
  readonly route?: string | undefined;
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
  readonly reason: "no_rule" | "manual" | "regenerate_failed";
  readonly glob?: string | undefined;
}

export interface ForkSyncReport {
  readonly version: typeof FORK_SYNC_REPORT_VERSION;
  readonly status: "ok" | "needs_review" | "error";
  readonly exitCode: number;
  readonly command: string;
  readonly upstream: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly branch: { readonly name: string; readonly tip: string | null };
  readonly worktree: string | null;
  readonly autoResolved: ReadonlyArray<AutoResolvedConflict>;
  readonly unresolved: ReadonlyArray<UnresolvedConflict>;
  readonly presence: ReadonlyArray<FeaturePresenceResult>;
  readonly settings: SettingsDiffResult | null;
  readonly baseline: BaselineComparison | null;
  readonly provenance: {
    readonly publish: string;
    readonly check: string;
    readonly published?: { readonly commit: string; readonly syncRef: string };
  } | null;
  readonly notes: ReadonlyArray<string>;
}

export interface ForkSyncCliArgs {
  readonly command: string;
  readonly repo: string;
  readonly upstream: string | undefined;
  readonly base: string;
  readonly branch: string | undefined;
  readonly worktree: string | undefined;
  readonly inPlace: boolean;
  readonly report: string | undefined;
  readonly json: boolean;
  readonly manifest: string | undefined;
  readonly old: string | undefined;
  readonly new: string | undefined;
  readonly mainResults: string | undefined;
  readonly syncResults: string | undefined;
  readonly remote: string | undefined;
}

const STRATEGIES = new Set<ConflictStrategy>(["ours", "theirs", "regenerate", "manual"]);
const PRESENCE_KINDS = new Set<PresenceKind>(["file", "symbol", "route", "test"]);
const COMMANDS = ["merge", "guards", "settings-diff", "baseline", "check", "provenance"] as const;

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
  const pattern = glob.replaceAll("\\", "/");
  const file = filePath.replaceAll("\\", "/");
  return matchSegments(pattern.split("/"), file.split("/"));
}

function matchSegments(pattern: ReadonlyArray<string>, file: ReadonlyArray<string>): boolean {
  if (pattern.length === 0) return file.length === 0;
  const [head, ...rest] = pattern;
  if (head === undefined) return file.length === 0;
  if (head === "**") {
    if (rest.length === 0) return true;
    for (let index = 0; index <= file.length; index += 1) {
      if (matchSegments(rest, file.slice(index))) return true;
    }
    return false;
  }
  if (file.length === 0) return false;
  const [segment, ...remaining] = file;
  if (segment === undefined || !matchSegment(head, segment)) return false;
  return matchSegments(rest, remaining);
}

function matchSegment(pattern: string, segment: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(segment);
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
    throw new ForkSyncError(`${path}.kind is not a presence check kind`);
  }
  const filePath = requireString(value.path, `${path}.path`);
  if (kind === "symbol") {
    return { kind, path: filePath, symbol: requireString(value.symbol, `${path}.symbol`) };
  }
  if (kind === "route") {
    return { kind, path: filePath, route: requireString(value.route, `${path}.route`) };
  }
  return { kind: kind as "file" | "test", path: filePath };
}

export function parseConflictRule(value: unknown, path: string): ConflictRule {
  if (!isRecord(value)) throw new ForkSyncError(`${path} must be an object`);
  const glob = requireString(value.glob, `${path}.glob`);
  const strategy = requireString(value.strategy, `${path}.strategy`);
  if (!STRATEGIES.has(strategy as ConflictStrategy)) {
    throw new ForkSyncError(`${path}.strategy must be ours, theirs, regenerate, or manual`);
  }
  if (strategy === "regenerate") {
    return { glob, strategy, command: requireString(value.command, `${path}.command`) };
  }
  if (value.command !== undefined) {
    throw new ForkSyncError(`${path}.command is only valid for regenerate`);
  }
  return { glob, strategy: strategy as Exclude<ConflictStrategy, "regenerate"> };
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

export function loadSettingsPolicyFromRoots(
  roots: ReadonlyArray<string>,
  relativePath: string,
): SettingsPolicy {
  const tried: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const resolved = NodePath.resolve(root, relativePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    tried.push(resolved);
    if (NodeFS.existsSync(resolved)) return parseSettingsPolicy(loadJsonFile(resolved));
  }
  throw new ForkSyncError(`could not read ${relativePath} (tried ${tried.join(", ")})`);
}

export function loadSettingsPolicy(repo: string, relativePath: string): SettingsPolicy {
  return loadSettingsPolicyFromRoots([repo], relativePath);
}

function settingsPolicyRoots(args: ForkSyncCliArgs, extra?: string): ReadonlyArray<string> {
  const roots: string[] = [];
  if (extra !== undefined) roots.push(extra);
  roots.push(args.repo);
  if (args.manifest !== undefined) roots.push(NodePath.dirname(NodePath.resolve(args.manifest)));
  return roots;
}

export function forkChangeHeadings(markdown: string): ReadonlyArray<string> {
  const start = markdown.indexOf("\n## What the fork changes\n");
  const end = markdown.indexOf("\n## Keep the customizations");
  if (start < 0 || end < 0 || end <= start) {
    throw new ForkSyncError("FORK.md is missing What the fork changes / Keep the customizations");
  }
  return [...markdown.slice(start, end).matchAll(/^### (.+)$/gm)].map((match) => match[1] ?? "");
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
  if (result.error !== undefined) {
    throw new ForkSyncError(`${onFail}: ${result.error.message}`);
  }
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

export function utcDateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
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
    if (body === undefined) continue;
    for (const field of topLevelFields(body)) {
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

export function classifySettingsChange(
  change: SettingsChange,
  policy: SettingsPolicy,
): SettingsChangeVerdict {
  const entry = policy.keys[change.key];
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
  if (change.defaultKind === "off") {
    return {
      change,
      blocking: false,
      keepUpstreamDefault: true,
      reason: entry?.note ?? "standing policy: new default-off keys keep the upstream default",
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

export function runPresenceChecks(
  root: string,
  features: ReadonlyArray<ForkFeature>,
): ReadonlyArray<FeaturePresenceResult> {
  return features.map((feature) => {
    const checks = feature.presence.map((check) => runPresenceCheck(root, check));
    return {
      id: feature.id,
      forkHeading: feature.forkHeading,
      ok: checks.every((check) => check.ok),
      checks,
    };
  });
}

function runPresenceCheck(root: string, check: PresenceCheck): PresenceCheckResult {
  const absolute = NodePath.join(root, check.path);
  if (!NodeFS.existsSync(absolute)) {
    return {
      kind: check.kind,
      path: check.path,
      ok: false,
      detail: `missing ${check.path}`,
    };
  }
  if (check.kind === "file" || check.kind === "test") {
    return { kind: check.kind, path: check.path, ok: true, detail: `found ${check.path}` };
  }
  const contents = NodeFS.readFileSync(absolute, "utf8");
  const needle = check.kind === "symbol" ? check.symbol : check.route;
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
    upstream: { ref: "", sha: "" },
    base: { ref: "", sha: "" },
    branch: { name: "", tip: null },
    worktree: null,
    autoResolved: [],
    unresolved: [],
    presence: [],
    settings: null,
    baseline: null,
    provenance: null,
    notes: [],
  };
}

function finalizeReport(report: ForkSyncReport): ForkSyncReport {
  const needsReview =
    report.unresolved.length > 0 ||
    report.presence.some((feature) => !feature.ok) ||
    report.settings?.blocking === true ||
    (report.baseline !== null && report.baseline.newFailures.length > 0);
  if (report.status === "error") return report;
  if (!needsReview) return { ...report, status: "ok", exitCode: 0 };
  return { ...report, status: "needs_review", exitCode: FORK_SYNC_NEEDS_REVIEW_EXIT };
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

export function applyConflictRules(
  repo: string,
  rules: ReadonlyArray<ConflictRule>,
  paths: ReadonlyArray<string>,
): {
  readonly autoResolved: ReadonlyArray<AutoResolvedConflict>;
  readonly unresolved: ReadonlyArray<UnresolvedConflict>;
} {
  const autoResolved: AutoResolvedConflict[] = [];
  const unresolved: UnresolvedConflict[] = [];
  for (const path of paths) {
    const rule = firstMatchingRule(rules, path);
    if (rule === undefined) {
      unresolved.push({ path, reason: "no_rule" });
      continue;
    }
    if (rule.strategy === "manual") {
      unresolved.push({ path, reason: "manual", glob: rule.glob });
      continue;
    }
    const side = rule.strategy === "ours" ? "--ours" : "--theirs";
    try {
      requireGit(repo, ["checkout", side, "--", path], `could not checkout ${side} for ${path}`);
      if (rule.strategy === "regenerate") {
        const command = rule.command;
        if (command === undefined) {
          unresolved.push({ path, reason: "regenerate_failed", glob: rule.glob });
          continue;
        }
        const regenerated = runShellCommand(repo, command);
        if (regenerated.status !== 0) {
          unresolved.push({ path, reason: "regenerate_failed", glob: rule.glob });
          continue;
        }
      }
      requireGit(repo, ["add", "--", path], `could not stage ${path}`);
      autoResolved.push({ path, rule: rule.strategy, glob: rule.glob });
    } catch {
      unresolved.push({
        path,
        reason: rule.strategy === "regenerate" ? "regenerate_failed" : "no_rule",
        glob: rule.glob,
      });
    }
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

export function mergeUpstream(input: {
  readonly repo: string;
  readonly upstreamRef: string;
  readonly baseRef: string;
  readonly branch?: string | undefined;
  readonly worktree?: string | undefined;
  readonly inPlace: boolean;
  readonly manifest: ForkSyncManifest;
}): {
  readonly repo: string;
  readonly worktree: string | null;
  readonly branch: string;
  readonly upstreamSha: string;
  readonly baseSha: string;
  readonly tip: string | null;
  readonly autoResolved: ReadonlyArray<AutoResolvedConflict>;
  readonly unresolved: ReadonlyArray<UnresolvedConflict>;
  readonly notes: ReadonlyArray<string>;
} {
  const upstreamSha = resolveCommit(input.repo, input.upstreamRef);
  const baseSha = resolveCommit(input.repo, input.baseRef);
  const branch = input.branch ?? `sync/${utcDateStamp()}`;
  const notes: string[] = [];
  let repo = input.repo;
  let worktree: string | null = null;

  if (!input.inPlace) {
    worktree =
      input.worktree ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-fork-sync-"));
    const existing = runGit(input.repo, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    if (existing.status === 0) {
      throw new ForkSyncError(`branch ${branch} already exists; pass --branch or delete it`);
    }
    requireGit(
      input.repo,
      ["worktree", "add", "-b", branch, worktree, baseSha],
      `could not create worktree at ${worktree}`,
    );
    repo = worktree;
  } else {
    requireGit(
      repo,
      ["checkout", "-B", branch, baseSha],
      `could not create ${branch} from ${input.baseRef}`,
    );
  }

  const ancestor = runGit(repo, ["merge-base", "--is-ancestor", upstreamSha, "HEAD"]);
  if (ancestor.status === 0) {
    notes.push(`HEAD already contains ${upstreamSha}`);
    return {
      repo,
      worktree,
      branch,
      upstreamSha,
      baseSha,
      tip: resolveCommit(repo, "HEAD"),
      autoResolved: [],
      unresolved: [],
      notes,
    };
  }

  const merge = runGit(repo, ["merge", "--no-commit", "--no-ff", upstreamSha]);
  if (merge.error !== undefined) {
    throw new ForkSyncError(`merge failed: ${merge.error.message}`);
  }
  const conflicts = unmergedPaths(repo);
  if (merge.status !== 0 && conflicts.length === 0) {
    throw new ForkSyncError(
      `merge failed: ${(merge.stderr || merge.stdout).trim() || `git merge exited ${String(merge.status)}`}`,
    );
  }
  const applied = applyConflictRules(repo, input.manifest.conflictRules, conflicts);
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
  }
  const tip = runGit(repo, ["rev-parse", "HEAD"]).status === 0 ? resolveCommit(repo, "HEAD") : null;
  return {
    repo,
    worktree,
    branch,
    upstreamSha,
    baseSha,
    tip,
    autoResolved: applied.autoResolved,
    unresolved: applied.unresolved,
    notes,
  };
}

export function provenancePointers(): { readonly publish: string; readonly check: string } {
  return {
    publish: "node scripts/publish-sync-branch.ts",
    check: "node scripts/check-sync-provenance.ts --json",
  };
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
  let inPlace = false;
  let report: string | undefined;
  let json = false;
  let manifest: string | undefined;
  let oldSha: string | undefined;
  let newSha: string | undefined;
  let mainResults: string | undefined;
  let syncResults: string | undefined;
  let remote: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--in-place") {
      inPlace = true;
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
      flag === "--sync" ||
      flag === "--remote";
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
      else if (flag === "--sync") syncResults = value;
      else remote = value;
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
    inPlace,
    report,
    json,
    manifest,
    old: oldSha,
    new: newSha,
    mainResults,
    syncResults,
    remote,
  };
}

function attachPresenceAndSettings(
  report: ForkSyncReport,
  repo: string,
  policyRoots: ReadonlyArray<string>,
  manifest: ForkSyncManifest,
  oldSha: string,
  newSha: string,
): ForkSyncReport {
  const presence = runPresenceChecks(repo, manifest.features);
  let settings: SettingsDiffResult | null = null;
  const notes = [...report.notes];
  try {
    settings = diffSettingsAtShas(
      repo,
      oldSha,
      newSha,
      loadSettingsPolicyFromRoots(policyRoots, manifest.settingsPolicy),
    );
  } catch (cause) {
    notes.push(forkSyncMessage(cause));
  }
  return finalizeReport({ ...report, presence, settings, notes });
}

export function runForkSync(args: ForkSyncCliArgs): ForkSyncReport {
  if (args.command === "baseline") {
    if (args.mainResults === undefined || args.syncResults === undefined) {
      throw new ForkSyncError("baseline requires --main <file> and --sync <file>");
    }
    const baseline = compareBaselines(
      parseCheckResults(loadJsonFile(args.mainResults)),
      parseCheckResults(loadJsonFile(args.syncResults)),
    );
    return finalizeReport({
      ...emptyReport("baseline"),
      baseline,
      notes: [`${String(baseline.newFailures.length)} new failures versus main`],
    });
  }

  if (args.command === "provenance") {
    try {
      const published = checkPublishedSyncSource({ repo: args.repo, remote: args.remote });
      return finalizeReport({
        ...emptyReport("provenance"),
        provenance: { ...provenancePointers(), published },
        notes: [`HEAD ${published.commit} is ${published.syncRef} on ${published.remote}`],
      });
    } catch (cause) {
      throw new ForkSyncError(syncSourceProvenanceMessage(cause));
    }
  }

  const manifest = loadManifest(args.repo, args.manifest);

  if (args.command === "guards") {
    const presence = runPresenceChecks(args.repo, manifest.features);
    return finalizeReport({ ...emptyReport("guards"), presence });
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
    const policy = loadSettingsPolicyFromRoots(settingsPolicyRoots(args), manifest.settingsPolicy);
    const settings = diffSettingsAtShas(args.repo, oldSha, newSha, policy);
    return finalizeReport({
      ...emptyReport("settings-diff"),
      upstream: { ref: args.new ?? args.upstream ?? manifest.upstream.ref, sha: newSha },
      base: { ref: args.old ?? args.base, sha: oldSha },
      settings,
    });
  }

  if (args.command === "check") {
    const presence = runPresenceChecks(args.repo, manifest.features);
    const upstreamRef = args.upstream ?? `${manifest.upstream.remote}/${manifest.upstream.ref}`;
    let settings: SettingsDiffResult | null = null;
    const notes: string[] = [];
    try {
      const newSha = resolveCommit(args.repo, upstreamRef);
      const oldSha = resolveMergeBase(args.repo, args.base, newSha);
      settings = diffSettingsAtShas(
        args.repo,
        oldSha,
        newSha,
        loadSettingsPolicyFromRoots(settingsPolicyRoots(args), manifest.settingsPolicy),
      );
    } catch (cause) {
      notes.push(forkSyncMessage(cause));
    }
    return finalizeReport({ ...emptyReport("check"), presence, settings, notes });
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
    inPlace: args.inPlace,
    manifest,
  });
  const report: ForkSyncReport = {
    ...emptyReport("merge"),
    upstream: { ref: upstreamRef, sha: merged.upstreamSha },
    base: { ref: args.base, sha: merged.baseSha },
    branch: { name: merged.branch, tip: merged.tip },
    worktree: merged.worktree,
    autoResolved: merged.autoResolved,
    unresolved: merged.unresolved,
    provenance: provenancePointers(),
    notes: merged.notes,
  };
  return attachPresenceAndSettings(
    report,
    merged.repo,
    settingsPolicyRoots(args, merged.repo),
    manifest,
    resolveMergeBase(merged.repo, merged.baseSha, merged.upstreamSha),
    merged.upstreamSha,
  );
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
    if (args !== undefined) {
      writeReport(
        {
          ...emptyReport(args.command),
          status: "error",
          exitCode: 1,
          notes: [message],
        },
        args.report,
        args.json,
      );
    }
    process.exitCode = 1;
  }
}
