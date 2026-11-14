import type { OrbitInstanceThreadInput } from "./instanceList.ts";

/**
 * Conn (thread-index plan, C3): the Gateway's thread index (`GET /conn/threads`). With the flag
 * `connAttachedServers` on, a container server this device holds off (park reason `not-attached`
 * or `asleep`) shows its threads from the index instead of a connection; every other server keeps
 * its live (or cached) rows. Flag off: nothing here is called.
 */

/** One thread of the index, as the Gateway lists it. */
export interface OrbitThreadIndexRow {
  readonly environmentId: string;
  readonly instanceId: number;
  readonly projectId: number;
  readonly threadId: string;
  readonly title: string;
  /** T3's thread status (`idle`, `running`, `completed`, …); null until the Gateway read the server. */
  readonly state: string | null;
  readonly needsInput: boolean;
  readonly lastUserMessageAt: string | null;
  readonly lastRunCompletedAt: string | null;
  readonly seenAt: string;
}

/** One covered server of the index (`meta.environments`). */
export interface OrbitThreadIndexEnvironment {
  readonly environmentId: string;
  readonly instanceId: number;
  readonly powerState: string;
  /** When the Gateway last read this server; null when it never did. */
  readonly readAt: string | null;
  readonly readError: string | null;
}

export interface OrbitThreadIndex {
  readonly rows: readonly OrbitThreadIndexRow[];
  readonly environments: readonly OrbitThreadIndexEnvironment[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function indexRow(value: unknown): OrbitThreadIndexRow | null {
  const data = record(value);
  if (
    typeof data?.environment_id !== "string" ||
    typeof data.instance_id !== "number" ||
    typeof data.project_id !== "number" ||
    typeof data.thread_id !== "string" ||
    typeof data.title !== "string" ||
    typeof data.seen_at !== "string"
  ) {
    return null;
  }
  return {
    environmentId: data.environment_id,
    instanceId: data.instance_id,
    projectId: data.project_id,
    threadId: data.thread_id,
    title: data.title,
    state: nullableString(data.state),
    needsInput: data.needs_input === true,
    lastUserMessageAt: nullableString(data.last_user_message_at),
    lastRunCompletedAt: nullableString(data.last_run_completed_at),
    seenAt: data.seen_at,
  };
}

function indexEnvironment(value: unknown): OrbitThreadIndexEnvironment | null {
  const data = record(value);
  if (typeof data?.environment_id !== "string" || typeof data.instance_id !== "number") return null;
  return {
    environmentId: data.environment_id,
    instanceId: data.instance_id,
    powerState: typeof data.power_state === "string" ? data.power_state : "running",
    readAt: nullableString(data.read_at),
    readError: nullableString(data.read_error),
  };
}

/**
 * Reads the envelope's `data` and `meta.environments`; null when either is not a list. A row or
 * server entry that is not one is left out, so one odd row does not hide the rest.
 */
export function parseOrbitThreadIndex(data: unknown, meta: unknown): OrbitThreadIndex | null {
  const environments = record(meta)?.environments;
  if (!Array.isArray(data) || !Array.isArray(environments)) return null;
  return {
    rows: data.flatMap((entry) => indexRow(entry) ?? []),
    environments: environments.flatMap((entry) => indexEnvironment(entry) ?? []),
  };
}

/** What a device keeps of the index: per server, the rows of its newest good read. */
export interface OrbitThreadIndexState {
  readonly servers: ReadonlyMap<
    string,
    { readonly readAt: string | null; readonly rows: readonly OrbitThreadIndexRow[] }
  >;
}

export const EMPTY_ORBIT_THREAD_INDEX_STATE: OrbitThreadIndexState = { servers: new Map() };

const readAtMs = (readAt: string | null): number => {
  if (readAt === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(readAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/**
 * The kept index after a read. Freshness is the server's `read_at`: a server whose read failed
 * (`read_error`), or whose `read_at` is older than the kept one, keeps its last rows and takes
 * nothing new. A server the answer no longer covers (destroyed, or out of this Node's access) goes.
 * A failed call (`null`) keeps everything as it was.
 */
export function nextOrbitThreadIndexState(
  previous: OrbitThreadIndexState,
  index: OrbitThreadIndex | null,
): OrbitThreadIndexState {
  if (index === null) return previous;
  const rowsByServer = new Map<string, OrbitThreadIndexRow[]>();
  for (const row of index.rows) {
    const rows = rowsByServer.get(row.environmentId) ?? [];
    rows.push(row);
    rowsByServer.set(row.environmentId, rows);
  }
  const servers = new Map<
    string,
    { readonly readAt: string | null; readonly rows: readonly OrbitThreadIndexRow[] }
  >();
  for (const server of index.environments) {
    const kept = previous.servers.get(server.environmentId);
    const stale =
      server.readError !== null ||
      (kept !== undefined && readAtMs(server.readAt) < readAtMs(kept.readAt));
    if (stale) {
      if (kept !== undefined) servers.set(server.environmentId, kept);
      continue;
    }
    servers.set(server.environmentId, {
      readAt: server.readAt,
      rows: rowsByServer.get(server.environmentId) ?? [],
    });
  }
  return { servers };
}

/** T3's active run statuses: a live row shows these as working (`threadRuntimeIsActive`). */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Subagent threads live inside their parent's view and have no list row. The index has no
 * lineage, so they are known by the ids T3 gives them (`IdAllocator`: `thread:subagent:<hash>`,
 * legacy `thread:provider:<driver>:…:native-thread:<id>`).
 */
export function isIndexSubagentThreadId(threadId: string): boolean {
  return threadId.startsWith("thread:subagent:") || threadId.startsWith("thread:provider:");
}

/** The later of two ISO times; either may be null. */
function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return readAtMs(right) > readAtMs(left) ? right : left;
}

/**
 * An index row in the list's row model. Last activity: the later of the last user message and
 * the last finished run (empty when the server named neither, so the row shows no time). Working:
 * an active run status or a request that waits for the user, as a live row shows both.
 */
export function orbitIndexThreadInput(row: OrbitThreadIndexRow): OrbitInstanceThreadInput {
  return {
    environmentId: row.environmentId,
    id: row.threadId,
    title: row.title,
    updatedAt: later(row.lastUserMessageAt, row.lastRunCompletedAt) ?? "",
    archivedAt: null,
    working: row.needsInput || (row.state !== null && ACTIVE_STATES.has(row.state)),
  };
}

/**
 * The thread list the Orbit list joins. Flag off, or no server held off: `live` itself. Flag on:
 * each held-off server that the index covers shows its index rows in place of its live (cached)
 * rows; every other server keeps its live rows. One source per server, so a server that connects
 * (no longer held) shows its live rows only, never both.
 */
export function orbitThreadInputsWithIndex(input: {
  readonly enabled: boolean;
  readonly live: readonly OrbitInstanceThreadInput[];
  readonly index: OrbitThreadIndexState;
  /** Environments that hold at least one park reason now. */
  readonly held: ReadonlySet<string>;
}): readonly OrbitInstanceThreadInput[] {
  if (!input.enabled || input.held.size === 0) return input.live;
  const fromIndex = new Set(
    [...input.held].filter((environmentId) => input.index.servers.has(environmentId)),
  );
  if (fromIndex.size === 0) return input.live;
  const indexed = [...fromIndex].flatMap((environmentId) =>
    (input.index.servers.get(environmentId)?.rows ?? [])
      .filter((row) => !isIndexSubagentThreadId(row.threadId))
      .map(orbitIndexThreadInput),
  );
  return [...input.live.filter((thread) => !fromIndex.has(thread.environmentId)), ...indexed];
}

/**
 * One index read for the Orbit list. Called where the list itself is read, never on a timer of its
 * own. Flag off, or no server held off: no call, the kept state stays. A failed call keeps it too.
 */
export async function readOrbitThreadIndex(input: {
  readonly enabled: boolean;
  readonly held: ReadonlySet<string>;
  readonly previous: OrbitThreadIndexState;
  readonly threads: () => Promise<OrbitThreadIndex>;
}): Promise<OrbitThreadIndexState> {
  if (!input.enabled || input.held.size === 0) return input.previous;
  try {
    return nextOrbitThreadIndexState(input.previous, await input.threads());
  } catch {
    return input.previous;
  }
}
