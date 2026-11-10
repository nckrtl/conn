import {
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  isFinalPairingError,
  parseEnvironmentProvider,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  OrbitGatewayError,
  SETTINGS_VERSION_CONFLICT,
  type EnvironmentProvider,
  type OrbitEnvironmentState,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
  type OrbitGatewayProfile,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentLacksScope } from "../../state/session";
import { orbitGatewayClient as client } from "./orbitGatewayClient";
import { syncOrbitAppearance } from "./orbitProfileSync";
import { heldOrbitInstanceIds } from "./orbitThreadStartStore";

/**
 * The phone's view of the Orbit Gateway: Node, profile, workspaces (read-only) and T3 servers.
 * The appearance syncs both ways (orbitProfileSync). In Orbit mode it pairs the Gateway's servers
 * and switches off environments added by hand (see planEnvironmentProvider).
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

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

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
  return error instanceof Error ? error.message : String(error);
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

/** Conn: clones the user asked to connect in Settings; refreshes retry them in this session. */
const requestedEnvironmentIds = new Set<string>();
const pairings = new Map<string, Promise<boolean>>();

async function updateEnvironmentState(
  change: (current: OrbitEnvironmentState) => OrbitEnvironmentState,
): Promise<void> {
  environmentState = change(environmentState);
  await saveProvider();
}

/**
 * Conn: pairs this device with one Orbit server and records the attempt and its result. Resolves
 * true when the server is saved. A second call while one runs joins it.
 */
function pairOne(
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  isSaved: boolean,
): Promise<boolean> {
  const { environmentId } = environment;
  const running = pairings.get(environmentId);
  if (running) return running;
  const pairing = attemptPairing(environment, isSaved).finally(() =>
    pairings.delete(environmentId),
  );
  pairings.set(environmentId, pairing);
  return pairing;
}

async function attemptPairing(
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  isSaved: boolean,
): Promise<boolean> {
  const { environmentId } = environment;
  const now = Date.now();
  try {
    // Saved before the attempt, so a restart during the pairing still backs off.
    await updateEnvironmentState((current) =>
      isSaved
        ? recordAccessPairing(current, environmentId, now)
        : recordPairingAttempt(current, environmentId, now),
    );
    const pairing = await client.pair(environmentId);
    const result = await runAtomCommand(
      appAtomRegistry,
      connectPairingUrl,
      { pairingUrl: pairing.pairingUrl },
      { reportFailure: false },
    );
    if (result._tag !== "Success") return false;
    requestedEnvironmentIds.delete(environmentId);
    await updateEnvironmentState((current) => recordPaired(current, environmentId));
    return true;
  } catch (error) {
    // An unreachable server pairs on a later refresh; a refused one after it registers again.
    if (isFinalPairingError(error)) {
      await updateEnvironmentState((current) => recordPairingRefused(current, environment)).catch(
        () => {},
      );
    }
    return false;
  }
}

/** Conn: a thread start paired with its clone's server, which Orbit provides like any other. */
export function recordOrbitThreadStartPaired(environmentId: string): Promise<void> {
  return updateEnvironmentState((current) => recordPaired(current, environmentId));
}

/**
 * Conn: the Connect button for a clone in Settings › Orbit › Servers. Pairs it now, and lets a
 * later refresh retry it if this attempt fails.
 */
export function connectOrbitEnvironment(
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): Promise<boolean> {
  requestedEnvironmentIds.add(environment.environmentId);
  return pairOne(environment, false);
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
  // Conn: sessions Orbit paired before the Gateway asked for admin scopes cannot manage access.
  const lacksAccess = saved
    .filter((entry) =>
      readEnvironmentLacksScope(entry.environmentId as EnvironmentId, AuthAccessWriteScope),
    )
    .map((entry) => entry.environmentId);
  const plan = planEnvironmentProvider({
    provider: state.provider,
    saved,
    orbit,
    state: environmentState,
    lacksAccess,
    // Conn: a thread start pairs its own clone; the sync must not pair it a second time.
    heldInstanceIds: heldOrbitInstanceIds(),
    requestedEnvironmentIds: [...requestedEnvironmentIds],
    now: Date.now(),
  });
  const savedIds = new Set(saved.map((entry) => entry.environmentId));
  const setEnabled = (environmentId: string, enabled: boolean) =>
    runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setEnabled,
      { environmentId: environmentId as EnvironmentId, enabled },
      { reportFailure: false },
    );
  for (const environmentId of plan.disable) await setEnabled(environmentId, false);
  for (const environmentId of plan.enable) await setEnabled(environmentId, true);
  // Pairing records come from the current state, so a Connect during this refresh keeps its own.
  await updateEnvironmentState((current) =>
    plan.state.pairedByOrbit.reduce(recordPaired, {
      ...current,
      disabledByOrbit: plan.state.disabledByOrbit,
    }),
  );
  // One server per refresh: pairing waits for a Gateway Operation, and the refresh waits too.
  const environmentId = plan.pair.find((id) => !pairings.has(id));
  const environment = orbit?.find((entry) => entry.environmentId === environmentId);
  if (environment) await pairOne(environment, savedIds.has(environment.environmentId));
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

/**
 * Conn: adds a started thread's clone project to the profile workspace selected at Start, unless
 * it lists the ref already or is gone, so the workspace filter shows the thread. A version
 * conflict reads the profile again once. Failures leave the workspace as it was.
 */
export async function keepProjectInOrbitWorkspace(
  workspaceId: string | null,
  projectRef: string,
): Promise<void> {
  const profileId = state.node?.profile?.id;
  if (workspaceId === null || profileId === undefined) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const settings = await client.settings(profileId);
      const target = settings.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target || (target.projectRefs ?? []).includes(projectRef)) return;
      const saved = await client.replaceWorkspaces(
        profileId,
        settings.version,
        settings.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? { ...workspace, projectRefs: [...(workspace.projectRefs ?? []), projectRef] }
            : workspace,
        ),
      );
      set({ workspaces: saved.workspaces });
      return;
    } catch (error) {
      if (!isOrbitGatewayError(error) || error.code !== SETTINGS_VERSION_CONFLICT) return;
    }
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

export function subscribeOrbitGateway(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function orbitGatewayState(): OrbitGatewayState {
  return state;
}

let started = false;
/** How often an open app checks the profile for another device's appearance change. */
const APPEARANCE_PROBE_MS = 30_000;

/**
 * The Gateway state. The first use loads it, and it reloads whenever the app comes to the front.
 * While the app is in front it also checks the profile's appearance every 30 seconds.
 */
export function useOrbitGateway(): OrbitGatewayState {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the app-wide AppState listener and appearance timer once
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
  return useSyncExternalStore(subscribeOrbitGateway, () => state);
}
