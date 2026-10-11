// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Runs before Electron is ready and before any Effect service exists; a one-time folder copy.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UPSTREAM_APP_BRAND, appBrandDisplayName, type AppBrand } from "./appBrand.ts";

/**
 * First launch after an app rename: the renamed app starts from a copy of the
 * old app's Electron user-data folder (cookies, browser profiles, localStorage,
 * window state). The old folder is only read, never changed or removed.
 */

export const MIGRATION_MARKER_FILE = "app-rename-migration.json";

/** Regenerable caches. Skipping them keeps the copy short; Chromium rebuilds them. */
const SKIPPED_CACHE_NAMES: ReadonlySet<string> = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "GrShaderCache",
  "Shared Dictionary",
  "component_crx_cache",
  "extensions_crx_cache",
]);

/**
 * Process-bound files. A copied `SingletonLock` would point at the old app's pid,
 * so the renamed app could not take its single-instance lock while the old one runs.
 */
const SKIPPED_PROCESS_FILES: ReadonlySet<string> = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "DevToolsActivePort",
  "lockfile",
]);

export function shouldCopyUserDataEntry(name: string): boolean {
  return !SKIPPED_CACHE_NAMES.has(name) && !SKIPPED_PROCESS_FILES.has(name);
}

export type MigrationStatus = "copied" | "complete";

export interface MigrationMarker {
  readonly version: 1;
  readonly status: MigrationStatus;
  readonly from: string;
  readonly copiedAt: string;
  readonly completedAt?: string;
  readonly localStorageEntries?: number;
  /** Saved secrets were checked against the new key (see AppRenameSecrets.ts). */
  readonly secretsChecked?: boolean;
}

export function readMigrationMarker(userDataPath: string): MigrationMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userDataPath, MIGRATION_MARKER_FILE), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      ((parsed as { status?: unknown }).status === "copied" ||
        (parsed as { status?: unknown }).status === "complete")
    ) {
      return parsed as MigrationMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeMigrationMarker(userDataPath: string, marker: MigrationMarker): void {
  const markerPath = NodePath.join(userDataPath, MIGRATION_MARKER_FILE);
  const tempPath = `${markerPath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`);
  NodeFS.renameSync(tempPath, markerPath);
}

export type UserDataCopyResult =
  | { readonly status: "not-needed" }
  | { readonly status: "copied"; readonly source: string; readonly target: string }
  | { readonly status: "failed"; readonly source: string; readonly cause: unknown };

/**
 * Copies the old app's folder to the new one when the new one does not exist yet. The old
 * folder is upstream's display-name folder when that exists, else its scheme folder.
 * The copy lands in a sibling folder first and is renamed into place, so a crash
 * never leaves a half-copied folder that looks complete. A failure leaves the
 * new folder absent, so the next launch tries again.
 */
export function copyPreviousUserData(input: {
  readonly appDataDirectory: string;
  readonly brand: AppBrand;
  readonly isDevelopment: boolean;
  readonly now?: () => Date;
}): UserDataCopyResult {
  const { brand, isDevelopment } = input;
  if (brand.previous === null) return { status: "not-needed" };

  const target = NodePath.join(
    input.appDataDirectory,
    isDevelopment ? brand.devUserDataDirName : brand.userDataDirName,
  );
  if (NodeFS.existsSync(target)) return { status: "not-needed" };
  // The display-name folder ("T3 Code (Alpha)") comes first: upstream's resolveUserDataPath
  // prefers it whenever it exists, so it holds the live data. The scheme folder may be stale.
  const source = [
    appBrandDisplayName(UPSTREAM_APP_BRAND, isDevelopment ? "Dev" : "Alpha"),
    isDevelopment ? brand.previous.devUserDataDirName : brand.previous.userDataDirName,
  ]
    .map((name) => NodePath.join(input.appDataDirectory, name))
    .find((candidate) => NodeFS.existsSync(candidate));
  if (source === undefined) return { status: "not-needed" };

  const staging = `${target}.migrating`;
  try {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    NodeFS.cpSync(source, staging, {
      recursive: true,
      // APFS clones the files instead of copying their bytes where it can.
      mode: NodeFS.constants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
      filter: (entry) => shouldCopyUserDataEntry(NodePath.basename(entry)),
    });
    writeMigrationMarker(staging, {
      version: 1,
      status: "copied",
      from: source,
      copiedAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    NodeFS.renameSync(staging, target);
    return { status: "copied", source, target };
  } catch (cause) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    return { status: "failed", source, cause };
  }
}

/** Keeps the string entries of a localStorage dump; anything else cannot be a stored value. */
export function shapeLocalStorageEntries(raw: unknown): Record<string, string> {
  const entries: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return entries;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}

/** Runs in a page at the old origin. */
export const READ_LOCAL_STORAGE_SCRIPT = `(() => {
  const entries = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key !== null) entries[key] = localStorage.getItem(key);
  }
  return entries;
})()`;

/** Runs in a page at the new origin. A key the new origin already has is left alone. */
export function writeLocalStorageScript(entries: Readonly<Record<string, string>>): string {
  return `(() => {
  const entries = ${JSON.stringify(entries)};
  let written = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, value);
      written += 1;
    }
  }
  return written;
})()`;
}
