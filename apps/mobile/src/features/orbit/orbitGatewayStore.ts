import {
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  OrbitGatewayError,
  parseEnvironmentProvider,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordPaired,
  type EnvironmentProvider,
  type OrbitEnvironmentState,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
  type OrbitGatewayProfile,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import { appAtomRegistry } from "../../state/atom-registry";
import { orbitGatewayClient as client } from "./orbitGatewayClient";
import { syncOrbitAppearance } from "./orbitProfileSync";

/**
 * The phone's view of the Orbit Gateway: this device's Node and profile, the profile's workspaces,
 * and the registered T3 servers. Workspaces are read-only here; the desktop edits them. The
 * appearance syncs both ways, see orbitProfileSync.
 *
 * It also applies the environment provider (see planEnvironmentProvider): in Orbit mode the
 * Gateway's servers are paired automatically and the environments added by hand are switched off.
 */

export interface OrbitGatewayState {
  /** Where this device's environments come from; Orbit calls the Gateway only in `orbit`. */
  readonly provider: EnvironmentProvider;
  readonly providerLoaded: boolean;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly node: OrbitGatewayNode | null;
  readonly profiles: readonly OrbitGatewayProfile[];
  readonly environments: readonly OrbitGatewayEnvironment[];
  readonly workspaces: readonly OrbitGatewayWorkspace[];
  readonly error: string | null;
  /** The workspace the thread list is scoped to on this device, or null for all projects. */
  readonly selectedWorkspaceId: string | null;
}

const PROVIDER_STORAGE_KEY = "t3code.environment-provider.v1";

let environmentState: OrbitEnvironmentState = EMPTY_ORBIT_ENVIRONMENT_STATE;

let state: OrbitGatewayState = {
  provider: "default",
  providerLoaded: false,
  phase: "idle",
  node: null,
  profiles: [],
  environments: [],
  workspaces: [],
  error: null,
  selectedWorkspaceId: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<OrbitGatewayState>): void {
  state = { ...state, ...patch };
  if (
    state.selectedWorkspaceId !== null &&
    !state.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)
  ) {
    state = { ...state, selectedWorkspaceId: null };
  }
  for (const listener of listeners) listener();
}

function message(error: unknown): string {
  return error instanceof OrbitGatewayError || error instanceof Error
    ? error.message
    : String(error);
}

async function saveProvider(): Promise<void> {
  await SecureStore.setItemAsync(
    PROVIDER_STORAGE_KEY,
    JSON.stringify({ provider: state.provider, environments: environmentState }),
  );
}

async function loadProvider(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(PROVIDER_STORAGE_KEY);
    const parsed = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    environmentState = parseOrbitEnvironmentState(parsed.environments);
    set({ provider: parseEnvironmentProvider(parsed.provider), providerLoaded: true });
  } catch {
    set({ providerLoaded: true });
  }
}

/** Switches the saved environments to match the provider, pairing Orbit servers as needed. */
async function reconcileEnvironments(
  orbit: readonly OrbitGatewayEnvironment[] | null,
): Promise<void> {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return;
  const saved = [...catalog.entries.entries()]
    .filter(([, entry]) => entry.target._tag !== "PrimaryConnectionTarget")
    .map(([environmentId, entry]) => ({
      environmentId: String(environmentId),
      enabled: entry.enabled,
    }));
  const plan = planEnvironmentProvider({
    provider: state.provider,
    saved,
    orbit,
    state: environmentState,
  });
  const setEnabled = (environmentId: string, enabled: boolean) =>
    runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setEnabled,
      { environmentId: environmentId as EnvironmentId, enabled },
      { reportFailure: false },
    );
  for (const environmentId of plan.disable) await setEnabled(environmentId, false);
  for (const environmentId of plan.enable) await setEnabled(environmentId, true);
  let next = plan.state;
  for (const environmentId of plan.pair) {
    try {
      const pairing = await client.pair(environmentId);
      const result = await runAtomCommand(appAtomRegistry, connectPairingUrl, pairing.pairingUrl, {
        reportFailure: false,
      });
      if (result._tag === "Success") next = recordPaired(next, environmentId);
    } catch {
      // An unreachable server pairs on a later refresh.
    }
  }
  environmentState = next;
  await saveProvider();
}

let refreshing: Promise<void> | null = null;

/**
 * Applies the environment provider. In Orbit mode it also reads the node, profiles, servers, and
 * the bound profile's workspaces; Default mode makes no Gateway call.
 */
export function refreshOrbitGateway(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (!state.providerLoaded) await loadProvider();
      if (state.provider === "default") {
        set({ phase: "idle", node: null, environments: [], workspaces: [], error: null });
        await reconcileEnvironments(null);
        return;
      }
      set({ phase: "loading", error: null });
      const [node, profiles, environments] = await Promise.all([
        client.me(),
        client.profiles(),
        client.environments(),
      ]);
      const workspaces = node.profile ? (await client.settings(node.profile.id)).workspaces : [];
      set({ phase: "ready", node, profiles, environments, workspaces });
      void syncOrbitAppearance(node);
      await reconcileEnvironments(environments);
    } catch (error) {
      set({ phase: "error", error: message(error) });
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Chooses where this device's environments come from and applies it at once. */
export async function setEnvironmentProvider(provider: EnvironmentProvider): Promise<void> {
  if (refreshing) await refreshing;
  set({ provider });
  await saveProvider();
  await refreshOrbitGateway();
}

/** Binds this device to a profile, creating it first when `profile` is a new name. */
export async function chooseOrbitProfile(
  profile: { readonly id: number } | { readonly name: string },
): Promise<void> {
  try {
    const id = "id" in profile ? profile.id : (await client.createProfile(profile.name)).id;
    await client.bindProfile(id);
  } catch (error) {
    set({ error: message(error) });
    throw error;
  }
  await refreshOrbitGateway();
}

/** Syncs the appearance with the profile now, as after a theme change on this phone. */
export async function syncOrbitAppearanceNow(): Promise<void> {
  if (state.provider !== "orbit") return;
  try {
    await syncOrbitAppearance(await client.me());
  } catch {
    // An unreachable Gateway syncs on a later run.
  }
}

export function selectOrbitWorkspace(workspaceId: string | null): void {
  set({ selectedWorkspaceId: workspaceId });
}

/** The selected workspace's projects as environment-scoped refs, or null without a selection. */
export function selectedWorkspaceProjectRefs(
  current: OrbitGatewayState,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }> | null {
  const workspace = current.workspaces.find((entry) => entry.id === current.selectedWorkspaceId);
  if (!workspace) return null;
  return (workspace.projectRefs ?? []).flatMap((ref) => {
    const at = ref.indexOf(":");
    return at > 0
      ? [
          {
            environmentId: ref.slice(0, at) as EnvironmentId,
            projectId: ref.slice(at + 1) as ProjectId,
          },
        ]
      : [];
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let started = false;
/** How often an open app checks the profile for another device's appearance change. */
const APPEARANCE_PROBE_MS = 30_000;

/**
 * The Gateway state. The first use loads it, and it reloads whenever the app comes to the front.
 * While the app is in front it also checks the profile's appearance every 30 seconds.
 */
export function useOrbitGateway(): OrbitGatewayState {
  useEffect(() => {
    if (started) return;
    started = true;
    void refreshOrbitGateway();
    AppState.addEventListener("change", (next) => {
      if (next === "active") void refreshOrbitGateway();
    });
    setInterval(() => {
      if (AppState.currentState === "active" && !refreshing) void syncOrbitAppearanceNow();
    }, APPEARANCE_PROBE_MS);
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}
