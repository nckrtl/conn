import * as Schema from "effect/Schema";
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

/** One unsent intent. `id` changes with every edit, so an acknowledgement retires only what it sent. */
export interface SidebarHiddenOp {
  readonly intent: SidebarHiddenIntent;
  readonly id: string;
}

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

/** The set is larger than the profile section holds. Nothing is trimmed: the marks stay local. */
export class SidebarHiddenThreadsCapacityError extends Schema.TaggedError<SidebarHiddenThreadsCapacityError>()(
  "SidebarHiddenThreadsCapacityError",
  { message: Schema.String, rows: Schema.Number, bytes: Schema.Number },
) {}

function capacityError(rows: number, bytes: number): SidebarHiddenThreadsCapacityError {
  return new SidebarHiddenThreadsCapacityError({
    rows,
    bytes,
    message:
      `Too many hidden sidebar threads to sync (${rows} of ${SIDEBAR_HIDDEN_THREADS_LIMITS.rows}, ` +
      `${bytes} of ${SIDEBAR_HIDDEN_THREADS_LIMITS.bytes} bytes). They stay hidden on this ` +
      "device. Show some of them again from the Orbit panel to sync the rest.",
  });
}

/** The section for a set of keys, oldest first. */
function sidebarHiddenThreadsSection(keys: readonly string[]): JsonObject {
  const threads = keys.flatMap((key) => {
    const separator = key.indexOf(":");
    if (separator <= 0 || separator >= key.length - 1) return [];
    return [{ environmentId: key.slice(0, separator), threadId: key.slice(separator + 1) }];
  });
  return { schema: PROFILE_SCHEMA_VERSION, threads };
}

/** Throws when a section would exceed the Gateway's limits, instead of dropping marks. */
function assertSidebarHiddenThreadsFit(section: JsonObject): void {
  const rows = Array.isArray(section.threads) ? section.threads.length : 0;
  const bytes = new TextEncoder().encode(JSON.stringify(section)).length;
  if (rows > SIDEBAR_HIDDEN_THREADS_LIMITS.rows || bytes > SIDEBAR_HIDDEN_THREADS_LIMITS.bytes) {
    throw capacityError(rows, bytes);
  }
}

/** The set after this device's intents: shows leave it, new hides join at the end. */
export function applySidebarHiddenIntents(
  agreed: readonly string[],
  ops: ReadonlyMap<string, { readonly intent: SidebarHiddenIntent }>,
): string[] {
  const result = agreed.filter((key) => ops.get(key)?.intent !== "show");
  const present = new Set(result);
  for (const [key, op] of ops) {
    if (op.intent === "hide" && !present.has(key)) result.push(key);
  }
  return result;
}

export interface SidebarHiddenThreadsHost {
  readonly read: () => {
    readonly agreed: readonly string[];
    readonly ops: ReadonlyMap<string, SidebarHiddenOp>;
  };
  /**
   * The set the profile holds now, and the intents it satisfies: `done` maps each key to the op id
   * that was planned. The host retires an op only while it still holds that id.
   */
  readonly adopt: (agreed: readonly string[], done: ReadonlyMap<string, string>) => void;
}

/**
 * The profile sync channel. A write rebases the device's unsent ops onto the profile's latest set
 * instead of sending a snapshot, so another device's change is never undone and a first sync never
 * reads as deleting the profile's marks. Ops retire only against a value the Gateway returned.
 */
export function createSidebarHiddenThreadsChannel(
  host: SidebarHiddenThreadsHost,
): ProfileSyncChannel {
  // The ops the last rebase planned from; `applyRemote` follows `merge` within one run.
  let planned: ReadonlyMap<string, SidebarHiddenOp> = new Map();
  return {
    name: SIDEBAR_HIDDEN_THREADS_SECTION,
    rebases: true,
    empty: sidebarHiddenThreadsSection([]),
    hasPending: () => host.read().ops.size > 0,
    readLocal: () => {
      const { agreed, ops } = host.read();
      return sidebarHiddenThreadsSection(applySidebarHiddenIntents(agreed, ops));
    },
    applyRemote: (value) => {
      const agreed = parseSidebarHiddenThreads(value) ?? [];
      const present = new Set(agreed);
      const done = new Map<string, string>();
      for (const [key, op] of planned) {
        if ((op.intent === "hide") === present.has(key)) done.set(key, op.id);
      }
      planned = new Map();
      host.adopt(agreed, done);
    },
    merge: (_base, _local, remote) => {
      planned = host.read().ops;
      const agreed = parseSidebarHiddenThreads(remote) ?? [];
      // The latest read is what the device agrees on, also when the write below fails.
      host.adopt(agreed, new Map());
      // A section written by a newer schema is left as it is.
      if (typeof remote.schema === "number" && remote.schema > PROFILE_SCHEMA_VERSION)
        return remote;
      const section = sidebarHiddenThreadsSection(applySidebarHiddenIntents(agreed, planned));
      const before = Array.isArray(remote.threads) ? remote.threads.length : 0;
      if ((section.threads as unknown[]).length > before) assertSidebarHiddenThreadsFit(section);
      return section;
    },
  };
}
