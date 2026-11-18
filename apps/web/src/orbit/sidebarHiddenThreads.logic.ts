import {
  applySidebarHiddenIntents,
  sidebarHiddenThreadKey,
  type SidebarHiddenIntent,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Conn: threads hidden from the sidebar, apart from `hiddenThreadKeysAtom` (tag filter, deletion).
 * `environments` lists environments whose threads hide unless shown: `null` hides every thread
 * (a peek holds the environment, or the profile's marks have not been read yet), a cutoff hides
 * the inventory a peek found (threads created up to it), also the pages that load later.
 */
export interface SidebarHiddenMarks {
  readonly keys: ReadonlySet<string>;
  readonly environments: ReadonlyMap<string, string | null>;
  readonly shown: ReadonlySet<string>;
}

export const NO_SIDEBAR_HIDDEN_MARKS: SidebarHiddenMarks = {
  keys: new Set(),
  environments: new Map(),
  shown: new Set(),
};

/** A Tasks peek in flight or awaiting its environment's threads; local to this device. */
export interface SidebarPeekAttempt {
  readonly profile: string;
  readonly environmentId: string;
  /** The target, hidden until the attempt commits its hide or is cancelled. */
  readonly target: string | null;
  readonly hold: boolean;
  /** Preparation succeeded: the hold now waits for the environment's threads. */
  readonly committed: boolean;
  /** Threads shown while the hold lasts; the sweep leaves them out. */
  readonly shown: readonly string[];
}

/** An environment a peek surfaced, after its threads arrived. */
export interface SidebarPeekedEnvironment {
  readonly cutoff: string;
  readonly shown: readonly string[];
}

export function sidebarHiddenMarks(input: {
  readonly agreed: readonly string[];
  readonly ops: ReadonlyMap<string, { readonly intent: SidebarHiddenIntent }>;
  readonly attempts: readonly SidebarPeekAttempt[];
  readonly peeked: ReadonlyMap<string, SidebarPeekedEnvironment>;
  /** Environments whose marks are not known yet. */
  readonly unhydrated: Iterable<string>;
}): SidebarHiddenMarks {
  const keys = new Set(applySidebarHiddenIntents(input.agreed, input.ops));
  const shown = new Set<string>();
  const environments = new Map<string, string | null>();
  for (const [key, op] of input.ops) if (op.intent === "show") shown.add(key);
  for (const [environmentId, entry] of input.peeked) {
    environments.set(environmentId, entry.cutoff);
    for (const key of entry.shown) shown.add(key);
  }
  for (const attempt of input.attempts) {
    if (attempt.target !== null) keys.add(attempt.target);
    if (attempt.hold) environments.set(attempt.environmentId, null);
    for (const key of attempt.shown) shown.add(key);
  }
  for (const environmentId of input.unhydrated) environments.set(environmentId, null);
  return { keys, environments, shown };
}

export function isSidebarHiddenThread(
  marks: SidebarHiddenMarks,
  thread: { readonly environmentId: string; readonly id: string; readonly createdAt?: string },
): boolean {
  const key = sidebarHiddenThreadKey(thread.environmentId, thread.id);
  if (marks.keys.has(key)) return true;
  const cutoff = marks.environments.get(thread.environmentId);
  if (cutoff === undefined || marks.shown.has(key)) return false;
  return cutoff === null || thread.createdAt === undefined || thread.createdAt <= cutoff;
}

/** Whether the environment's unloaded threads stay out too: the shelf neither pages nor counts them. */
export function hidesSidebarEnvironmentInventory(
  marks: SidebarHiddenMarks,
  environmentId: string,
): boolean {
  return marks.environments.has(environmentId);
}

/**
 * What a Tasks agent click does to the sidebar. A target the sidebar lists stays; any other is
 * hidden before its environment connects, and an environment the click surfaces is held until its
 * threads arrive, so none of them flash in.
 */
export function planSidebarPeek(input: {
  readonly targetListed: boolean;
  readonly environmentSurfaced: boolean;
}): { readonly hideTarget: boolean; readonly holdEnvironment: boolean } {
  if (input.targetListed) return { hideTarget: false, holdEnvironment: false };
  return { hideTarget: true, holdEnvironment: input.environmentSurfaced };
}

interface MarkedThread {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly archivedAt: string | null;
  readonly createdAt?: string;
}

interface MarkedProjectGroup {
  readonly memberProjects: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
}

/**
 * Leaves out project groups whose threads are all hidden. An empty group stays, unless each of its
 * environments is one a peek surfaced or whose marks are still unknown.
 */
export function withoutSidebarHiddenProjects<T extends MarkedProjectGroup>(
  groups: readonly T[],
  threads: readonly MarkedThread[],
  marks: SidebarHiddenMarks,
): T[] {
  if (marks.keys.size === 0 && marks.environments.size === 0) return [...groups];
  const projectThreads = new Map<string, { total: number; hidden: number }>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const entry = projectThreads.get(key) ?? { total: 0, hidden: 0 };
    entry.total += 1;
    if (isSidebarHiddenThread(marks, thread)) entry.hidden += 1;
    projectThreads.set(key, entry);
  }
  return groups.filter((group) => {
    let total = 0;
    let hidden = 0;
    for (const project of group.memberProjects) {
      const entry = projectThreads.get(`${project.environmentId}:${project.id}`);
      total += entry?.total ?? 0;
      hidden += entry?.hidden ?? 0;
    }
    if (total > 0) return hidden < total;
    return !(
      group.memberProjects.length > 0 &&
      group.memberProjects.every((project) => marks.environments.has(project.environmentId))
    );
  });
}
