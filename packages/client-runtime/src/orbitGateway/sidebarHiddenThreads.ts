import { PROFILE_SCHEMA_VERSION, isJsonObject, type JsonObject } from "./profileDocument.ts";
import type { ProfileSyncChannel } from "./profileSync.ts";

/**
 * Conn: the profile section that lists threads hidden from the sidebar. Same shape, ref syntax and
 * limits as `attachedThreads`: `{schema: 1, threads: [{environmentId, threadId}]}` or null. Each
 * write replaces the whole set at the section version this device last read.
 */
export const SIDEBAR_HIDDEN_THREADS_SECTION = "sidebarHiddenThreads";

const SIDEBAR_HIDDEN_THREADS_LIMITS = { rows: 500, bytes: 64 * 1024 } as const;

/** What this device wants for one thread, rebased onto the profile's latest set at each write. */
export type SidebarHiddenIntent = "hide" | "show";

/** The key of a ref, as `scopedThreadKey` writes it. */
export function sidebarHiddenThreadKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function isRefPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** The section's thread keys in order, without duplicates; null when the value is not one. */
export function parseSidebarHiddenThreads(value: unknown): string[] | null {
  if (!isJsonObject(value) || typeof value.schema !== "number") return null;
  if (!Array.isArray(value.threads)) return null;
  const keys = new Set<string>();
  for (const entry of value.threads) {
    if (!isJsonObject(entry)) continue;
    const { environmentId, threadId } = entry;
    // The key's first ":" separates the parts, so an environment id never holds one.
    if (!isRefPart(environmentId) || !isRefPart(threadId) || environmentId.includes(":")) continue;
    keys.add(sidebarHiddenThreadKey(environmentId, threadId));
  }
  return [...keys];
}

/**
 * The section for a set of keys, oldest first. Above the Gateway's limits the oldest marks give
 * way, so a write is never refused for its size.
 */
function sidebarHiddenThreadsSection(keys: readonly string[]): JsonObject {
  const threads = keys.flatMap((key) => {
    const separator = key.indexOf(":");
    if (separator <= 0 || separator >= key.length - 1) return [];
    return [{ environmentId: key.slice(0, separator), threadId: key.slice(separator + 1) }];
  });
  let kept = threads.slice(-SIDEBAR_HIDDEN_THREADS_LIMITS.rows);
  const size = () =>
    new TextEncoder().encode(JSON.stringify({ schema: PROFILE_SCHEMA_VERSION, threads: kept }))
      .length;
  while (kept.length > 0 && size() > SIDEBAR_HIDDEN_THREADS_LIMITS.bytes) kept = kept.slice(1);
  return { schema: PROFILE_SCHEMA_VERSION, threads: kept };
}

/** The set after this device's intents: shows leave it, new hides join at the end. */
export function applySidebarHiddenIntents(
  agreed: readonly string[],
  intents: ReadonlyMap<string, SidebarHiddenIntent>,
): string[] {
  const result = agreed.filter((key) => intents.get(key) !== "show");
  const present = new Set(result);
  for (const [key, intent] of intents) {
    if (intent === "hide" && !present.has(key)) result.push(key);
  }
  return result;
}

/** Intents the agreed set does not reflect yet; the rest are done. */
function pendingSidebarHiddenIntents(
  agreed: readonly string[],
  intents: ReadonlyMap<string, SidebarHiddenIntent>,
): Map<string, SidebarHiddenIntent> {
  const present = new Set(agreed);
  const pending = new Map<string, SidebarHiddenIntent>();
  for (const [key, intent] of intents) {
    if ((intent === "hide") !== present.has(key)) pending.set(key, intent);
  }
  return pending;
}

/**
 * The value to write over `remote`: this device's per-thread intents rebased onto the profile's
 * latest set, so another device's marks survive and no snapshot replaces a newer one. A section
 * written by a newer schema is returned as is.
 */
function rebaseSidebarHiddenThreads(
  remote: JsonObject,
  intents: ReadonlyMap<string, SidebarHiddenIntent>,
): JsonObject {
  if (typeof remote.schema === "number" && remote.schema > PROFILE_SCHEMA_VERSION) return remote;
  return sidebarHiddenThreadsSection(
    applySidebarHiddenIntents(parseSidebarHiddenThreads(remote) ?? [], intents),
  );
}

export interface SidebarHiddenThreadsHost {
  readonly read: () => {
    readonly agreed: readonly string[];
    readonly intents: ReadonlyMap<string, SidebarHiddenIntent>;
  };
  /** The set the profile agreed on, and the intents it does not reflect yet. */
  readonly adopt: (
    agreed: readonly string[],
    intents: ReadonlyMap<string, SidebarHiddenIntent>,
  ) => void;
}

/**
 * The profile sync channel. The device's value is the agreed set with its intents applied; a write
 * rebases the intents onto the profile's latest set instead of sending a snapshot, so another
 * device's change is never undone and a first sync never reads as deleting the profile's marks.
 */
export function createSidebarHiddenThreadsChannel(
  host: SidebarHiddenThreadsHost,
): ProfileSyncChannel {
  const adopt = (value: JsonObject) => {
    const agreed = parseSidebarHiddenThreads(value) ?? [];
    host.adopt(agreed, pendingSidebarHiddenIntents(agreed, host.read().intents));
  };
  return {
    name: SIDEBAR_HIDDEN_THREADS_SECTION,
    rebases: true,
    empty: sidebarHiddenThreadsSection([]),
    readLocal: () => {
      const { agreed, intents } = host.read();
      return sidebarHiddenThreadsSection(applySidebarHiddenIntents(agreed, intents));
    },
    applyRemote: adopt,
    merge: (_base, _local, remote) => rebaseSidebarHiddenThreads(remote, host.read().intents),
  };
}
