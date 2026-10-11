import {
  mergeWorkspaces,
  OrbitGatewayError,
  sameWorkspaces,
  SETTINGS_VERSION_CONFLICT,
  type OrbitGatewayClient,
  type OrbitGatewayNode,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Keeps this device's workspaces in step with its Orbit profile. The profile on the Gateway is the
 * shared copy; the workspace store stays the local working copy every window reads. Only the
 * workspace list syncs; the selected workspace and remembered threads stay per device.
 *
 * `state` records the profile version and the list this device last agreed on with the Gateway.
 * A local list that differs from it holds unsent edits; a profile version that differs holds
 * another device's edits. Both at once is a conflict, merged with mergeWorkspaces.
 */

export interface WorkspaceProfileSyncState {
  readonly profileId: number;
  readonly version: number;
  readonly base: readonly OrbitGatewayWorkspace[];
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGatewayWorkspace(value: unknown): value is OrbitGatewayWorkspace {
  if (typeof value !== "object" || value === null) return false;
  const workspace = value as Record<string, unknown>;
  return (
    typeof workspace.id === "string" &&
    typeof workspace.name === "string" &&
    typeof workspace.color === "string" &&
    (workspace.icon === null || typeof workspace.icon === "string") &&
    (workspace.image === undefined ||
      workspace.image === null ||
      typeof workspace.image === "string") &&
    (workspace.projectRefs === undefined || isStringArray(workspace.projectRefs)) &&
    (workspace.projectKeys === undefined || isStringArray(workspace.projectKeys))
  );
}

/**
 * Reads a stored sync snapshot. Anything of the wrong shape is null, so the next run is a first
 * sync instead of a merge against a `base` this device never agreed on.
 */
export function parseWorkspaceProfileSyncState(value: unknown): WorkspaceProfileSyncState | null {
  if (typeof value !== "object" || value === null) return null;
  const { profileId, version, base } = value as Record<string, unknown>;
  if (typeof profileId !== "number" || typeof version !== "number") return null;
  if (!Array.isArray(base) || !base.every(isGatewayWorkspace)) return null;
  return { profileId, version, base };
}

export interface WorkspaceProfileSyncPorts {
  readonly client: OrbitGatewayClient;
  readonly readLocal: () => readonly OrbitGatewayWorkspace[];
  readonly writeLocal: (workspaces: readonly OrbitGatewayWorkspace[]) => void;
  readonly loadState: () => WorkspaceProfileSyncState | null;
  readonly saveState: (state: WorkspaceProfileSyncState | null) => void;
}

export type WorkspaceProfileSyncResult =
  | { readonly kind: "unbound" }
  | { readonly kind: "unchanged"; readonly profileName: string }
  | { readonly kind: "pulled"; readonly profileName: string }
  | { readonly kind: "pushed"; readonly profileName: string }
  | { readonly kind: "merged"; readonly profileName: string };

/** Attempts at a replace before giving up on a run, when other devices keep writing in between. */
const MAX_REPLACE_ATTEMPTS = 3;

/** `knownMe` is the caller's node when the caller just read it, so one run probes the Gateway once. */
export async function syncWorkspaceProfile(
  ports: WorkspaceProfileSyncPorts,
  knownMe?: OrbitGatewayNode,
): Promise<WorkspaceProfileSyncResult> {
  const me = knownMe ?? (await ports.client.me());
  if (me.profile === null) {
    ports.saveState(null);
    return { kind: "unbound" };
  }
  const { id: profileId, name: profileName } = me.profile;
  const state = ports.loadState();
  const local = ports.readLocal();

  if (state === null || state.profileId !== profileId) {
    // First sync with this profile. An empty profile takes this device's workspaces; otherwise the
    // profile's list replaces the local one, as when a second device joins.
    const remote = await ports.client.settings(profileId);
    if (remote.workspaces.length === 0 && local.length > 0) {
      const saved = await replace(ports, profileId, remote.version, [], local);
      return { kind: saved.merged ? "merged" : "pushed", profileName };
    }
    adopt(ports, profileId, remote.version, remote.workspaces);
    return sameWorkspaces(local, remote.workspaces)
      ? { kind: "unchanged", profileName }
      : { kind: "pulled", profileName };
  }

  const dirty = !sameWorkspaces(local, state.base);
  const remoteChanged = me.profile.settingsVersion !== state.version;
  if (!dirty && !remoteChanged) return { kind: "unchanged", profileName };
  if (!dirty) {
    const remote = await ports.client.settings(profileId);
    adopt(ports, profileId, remote.version, remote.workspaces);
    return { kind: "pulled", profileName };
  }
  const saved = await replace(ports, profileId, state.version, state.base, local);
  return { kind: saved.merged ? "merged" : "pushed", profileName };
}

function adopt(
  ports: WorkspaceProfileSyncPorts,
  profileId: number,
  version: number,
  workspaces: readonly OrbitGatewayWorkspace[],
): void {
  if (!sameWorkspaces(ports.readLocal(), workspaces)) ports.writeLocal(workspaces);
  ports.saveState({ profileId, version, base: workspaces });
}

/** Sends `local`; on a version conflict merges it with the profile's newer list and tries again. */
async function replace(
  ports: WorkspaceProfileSyncPorts,
  profileId: number,
  version: number,
  base: readonly OrbitGatewayWorkspace[],
  local: readonly OrbitGatewayWorkspace[],
): Promise<{ merged: boolean }> {
  let sendVersion = version;
  let sendBase = base;
  let candidate = local;
  let merged = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const saved = await ports.client.replaceWorkspaces(profileId, sendVersion, candidate);
      adopt(ports, profileId, saved.version, saved.workspaces);
      return { merged };
    } catch (error) {
      if (
        !(error instanceof OrbitGatewayError) ||
        error.code !== SETTINGS_VERSION_CONFLICT ||
        attempt >= MAX_REPLACE_ATTEMPTS
      ) {
        throw error;
      }
      const remote = await ports.client.settings(profileId);
      candidate = mergeWorkspaces(sendBase, candidate, remote.workspaces);
      sendBase = remote.workspaces;
      sendVersion = remote.version;
      merged = true;
    }
  }
}
