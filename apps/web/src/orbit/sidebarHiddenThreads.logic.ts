import {
  applySidebarHiddenIntents,
  sidebarHiddenThreadKey,
  type SidebarHiddenIntent,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Conn: threads hidden from the sidebar, apart from `hiddenThreadKeysAtom` (tag filter, deletion).
 * `environments` lists environments whose threads all hide unless shown: a peek holds the
 * environment until its whole inventory is marked, or the profile's marks have not been read yet.
 */
export interface SidebarHiddenMarks {
  readonly keys: ReadonlySet<string>;
  readonly environments: ReadonlySet<string>;
  readonly shown: ReadonlySet<string>;
}

export const NO_SIDEBAR_HIDDEN_MARKS: SidebarHiddenMarks = {
  keys: new Set(),
  environments: new Set(),
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
  /** Threads shown while the attempt lasts; neither the target's hide nor the sweep takes them. */
  readonly shown: readonly string[];
  /** The window running the preparation, and when it last said so; for orphan recovery. */
  readonly owner?: string;
  readonly beat?: number;
}

export function sidebarHiddenMarks(input: {
  readonly agreed: readonly string[];
  readonly ops: ReadonlyMap<string, { readonly intent: SidebarHiddenIntent }>;
  readonly attempts: readonly SidebarPeekAttempt[];
  /** Environments whose marks are not known yet. */
  readonly unhydrated: Iterable<string>;
}): SidebarHiddenMarks {
  const keys = new Set(applySidebarHiddenIntents(input.agreed, input.ops));
  const shown = new Set<string>();
  const environments = new Set<string>(input.unhydrated);
  for (const [key, op] of input.ops) if (op.intent === "show") shown.add(key);
  for (const attempt of input.attempts) for (const key of attempt.shown) shown.add(key);
  for (const attempt of input.attempts) {
    // An explicit show wins over a provisional hide at once, before preparation resolves.
    if (attempt.target !== null && !shown.has(attempt.target)) keys.add(attempt.target);
    if (attempt.hold) environments.add(attempt.environmentId);
  }
  return { keys, environments, shown };
}

export function isSidebarHiddenThread(
  marks: SidebarHiddenMarks,
  thread: { readonly environmentId: string; readonly id: string },
): boolean {
  const key = sidebarHiddenThreadKey(thread.environmentId, thread.id);
  if (marks.keys.has(key)) return true;
  return marks.environments.has(thread.environmentId) && !marks.shown.has(key);
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
}

interface MarkedProjectGroup {
  readonly memberProjects: ReadonlyArray<{ readonly environmentId: string; readonly id: string }>;
}

/**
 * Hidden marks of an environment that no held row resolves: rows of older pages not read yet, or
 * left out of the shell. Each may be one of the older settled threads the server still counts.
 */
export function unresolvedSidebarHiddenCount(
  marks: SidebarHiddenMarks,
  environmentId: string,
  heldKeys: ReadonlySet<string>,
): number {
  const prefix = `${environmentId}:`;
  let count = 0;
  for (const key of marks.keys) if (key.startsWith(prefix) && !heldKeys.has(key)) count += 1;
  return count;
}

/**
 * The Settled shelf's size: listed rows plus the server's unloaded older ones per scope. Unresolved
 * hidden marks may be among those, so `atLeast` leaves them out and `upTo` keeps them; the shelf
 * pages while `upTo` exceeds what it lists, and says a number only once both agree.
 */
export function sidebarSettledCount(input: {
  readonly listed: number;
  readonly scopes: ReadonlyArray<{ readonly unloaded: number; readonly unresolvedHidden: number }>;
}): { readonly atLeast: number; readonly upTo: number } {
  let atLeast = input.listed;
  let upTo = input.listed;
  for (const { unloaded, unresolvedHidden } of input.scopes) {
    upTo += unloaded;
    atLeast += Math.max(0, unloaded - unresolvedHidden);
  }
  return { atLeast, upTo };
}

/**
 * Leaves out project groups whose threads are all hidden. A group with older settled threads not
 * loaded yet stays: one of them may show. An empty group stays, unless each of its environments
 * is one a peek holds or whose marks are still unknown.
 */
export function withoutSidebarHiddenProjects<T extends MarkedProjectGroup>(
  groups: readonly T[],
  threads: readonly MarkedThread[],
  marks: SidebarHiddenMarks,
  unloadedOlder: (project: {
    readonly environmentId: string;
    readonly id: string;
  }) => number = () => 0,
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
    let unloaded = 0;
    for (const project of group.memberProjects) {
      const entry = projectThreads.get(`${project.environmentId}:${project.id}`);
      total += entry?.total ?? 0;
      hidden += entry?.hidden ?? 0;
      if (!marks.environments.has(project.environmentId)) unloaded += unloadedOlder(project);
    }
    if (total > 0) return hidden < total || unloaded > 0;
    return !(
      group.memberProjects.length > 0 &&
      group.memberProjects.every((project) => marks.environments.has(project.environmentId))
    );
  });
}
