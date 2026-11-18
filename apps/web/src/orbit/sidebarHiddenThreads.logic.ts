import {
  applySidebarHiddenIntents,
  sidebarHiddenThreadKey,
  type SidebarHiddenIntent,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Conn: threads hidden from the sidebar, apart from `hiddenThreadKeysAtom` (tag filter, deletion).
 * `held` lists environments a Tasks peek surfaced whose threads have not arrived yet: until they
 * do, each of their threads counts as hidden unless the user showed it.
 */
export interface SidebarHiddenMarks {
  readonly keys: ReadonlySet<string>;
  readonly held: ReadonlySet<string>;
  readonly shown: ReadonlySet<string>;
}

export const NO_SIDEBAR_HIDDEN_MARKS: SidebarHiddenMarks = {
  keys: new Set(),
  held: new Set(),
  shown: new Set(),
};

export function sidebarHiddenMarks(input: {
  readonly agreed: readonly string[];
  readonly intents: ReadonlyMap<string, SidebarHiddenIntent>;
  readonly held: ReadonlySet<string>;
}): SidebarHiddenMarks {
  const shown = new Set<string>();
  for (const [key, intent] of input.intents) if (intent === "show") shown.add(key);
  return {
    keys: new Set(applySidebarHiddenIntents(input.agreed, input.intents)),
    held: input.held,
    shown,
  };
}

export function isSidebarHiddenThread(
  marks: SidebarHiddenMarks,
  environmentId: string,
  threadId: string,
): boolean {
  const key = sidebarHiddenThreadKey(environmentId, threadId);
  return marks.keys.has(key) || (marks.held.has(environmentId) && !marks.shown.has(key));
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
 * Leaves out project groups whose threads are all hidden. An empty group stays, unless every
 * environment it lives on lists only hidden threads (or is held): a peeked environment's empty
 * projects do not appear either.
 */
export function withoutSidebarHiddenProjects<T extends MarkedProjectGroup>(
  groups: readonly T[],
  threads: readonly MarkedThread[],
  marks: SidebarHiddenMarks,
): T[] {
  if (marks.keys.size === 0 && marks.held.size === 0) return [...groups];
  const projectThreads = new Map<string, { total: number; hidden: number }>();
  const environmentThreads = new Map<string, { total: number; hidden: number }>();
  const count = (
    map: Map<string, { total: number; hidden: number }>,
    key: string,
    hidden: boolean,
  ) => {
    const entry = map.get(key) ?? { total: 0, hidden: 0 };
    entry.total += 1;
    if (hidden) entry.hidden += 1;
    map.set(key, entry);
  };
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const hidden = isSidebarHiddenThread(marks, thread.environmentId, thread.id);
    count(projectThreads, `${thread.environmentId}:${thread.projectId}`, hidden);
    count(environmentThreads, thread.environmentId, hidden);
  }
  const allHidden = (entry: { total: number; hidden: number } | undefined) =>
    entry !== undefined && entry.total > 0 && entry.total === entry.hidden;
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
      group.memberProjects.every(
        (project) =>
          marks.held.has(project.environmentId) ||
          allHidden(environmentThreads.get(project.environmentId)),
      )
    );
  });
}
