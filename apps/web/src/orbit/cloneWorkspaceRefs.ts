import type {
  EnvironmentProvider,
  OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";

import type { Workspace } from "../workspaces.logic";
import { useWorkspaceStore } from "../workspaceStore";

// Conn: a gone clone's Gateway record no longer says it was a clone, so this device remembers the
// clone ids a list showed with an `instanceId` and drops only their refs. An id is never remembered
// before a list shows it: a clone a start made after this run's list was read must keep its ref.
const STORAGE_KEY = "t3code:orbit-clone-environments:v1";
/** Gone ids stay remembered, so a ref that a profile merge brings back is dropped again. */
const MAX_REMEMBERED = 500;

export interface CloneRefPrune {
  /** The same array when nothing changed. */
  readonly workspaces: readonly Workspace[];
  readonly cloneEnvironmentIds: readonly string[];
}

type ListedEnvironment = Pick<OrbitGatewayEnvironment, "environmentId" | "instanceId">;

/**
 * `listed` is this run's successful Gateway list, or null when none was read. Outside Orbit mode,
 * without a list, or with an empty one (a Gateway that briefly lists nothing), nothing changes.
 */
export function pruneGoneCloneRefs(input: {
  readonly provider: EnvironmentProvider;
  readonly workspaces: readonly Workspace[];
  readonly listed: readonly ListedEnvironment[] | null;
  readonly cloneEnvironmentIds: readonly string[];
}): CloneRefPrune {
  const { provider, workspaces, listed, cloneEnvironmentIds } = input;
  if (provider !== "orbit" || listed === null || listed.length === 0) {
    return { workspaces, cloneEnvironmentIds };
  }
  const listedIds = new Set(listed.map((environment) => environment.environmentId));
  const known = rememberIds(
    cloneEnvironmentIds,
    listed.flatMap((environment) =>
      environment.instanceId === null ? [] : [environment.environmentId],
    ),
  );
  const gone = new Set(known.filter((id) => !listedIds.has(id)));
  if (gone.size === 0) return { workspaces, cloneEnvironmentIds: known };

  let changed = false;
  const next = workspaces.map((workspace) => {
    const refs = workspace.projectRefs;
    if (refs === undefined) return workspace;
    const kept = refs.filter((ref) => !gone.has(refEnvironmentId(ref)));
    if (kept.length === refs.length) return workspace;
    changed = true;
    return { ...workspace, projectRefs: kept };
  });
  return { workspaces: changed ? next : workspaces, cloneEnvironmentIds: known };
}

function refEnvironmentId(ref: string): string {
  const separator = ref.indexOf(":");
  return separator === -1 ? ref : ref.slice(0, separator);
}

/** Adds ids at the end (newest last) and keeps the newest MAX_REMEMBERED. */
function rememberIds(current: readonly string[], added: readonly string[]): string[] {
  const ids = [...current.filter((id) => !added.includes(id)), ...added];
  const unique = [...new Set(ids)];
  return unique.slice(Math.max(0, unique.length - MAX_REMEMBERED));
}

function readRemembered(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeRemembered(ids: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // A device without storage forgets clones; their refs then stay, which is safe.
  }
}

export function pruneWorkspaceCloneRefs(
  provider: EnvironmentProvider,
  listed: readonly ListedEnvironment[] | null,
): void {
  const { workspaces } = useWorkspaceStore.getState();
  const result = pruneGoneCloneRefs({
    provider,
    workspaces,
    listed,
    cloneEnvironmentIds: readRemembered(),
  });
  writeRemembered(result.cloneEnvironmentIds);
  if (result.workspaces !== workspaces) {
    useWorkspaceStore.setState({ workspaces: [...result.workspaces] });
  }
}
