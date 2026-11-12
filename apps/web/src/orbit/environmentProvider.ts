import {
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  isFinalPairingError,
  orbitInstanceFromEnvironment,
  orbitInstancesByEnvironment,
  parseEnvironmentProvider,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  preferredOrbitInstance,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  type EnvironmentProvider,
  type OrbitEnvironmentState,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  OrbitInstanceDescriptor,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "../state/entities";
import { readEnvironmentLacksScope } from "../state/session";
import { heldOrbitInstanceIds } from "./orbitThreadStartStore";

const PROVIDER_STORAGE_KEY = "t3code:environment-provider:v1";
const STATE_STORAGE_KEY = "t3code:orbit-environments:v1";
const INSTANCES_STORAGE_KEY = "t3code:orbit-instances:v1";

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

interface EnvironmentProviderStore {
  readonly provider: EnvironmentProvider;
  readonly state: OrbitEnvironmentState;
  /** Conn: the Gateway's Orbit facts of each clone, from the last sync, so the row shows at start. */
  readonly orbitInstances: Readonly<Record<string, OrbitInstanceDescriptor>>;
}

const decodeOrbitInstance = Schema.decodeUnknownOption(OrbitInstanceDescriptor);

function parseOrbitInstances(value: unknown): Record<string, OrbitInstanceDescriptor> {
  const result: Record<string, OrbitInstanceDescriptor> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [environmentId, entry] of Object.entries(value)) {
    const decoded = decodeOrbitInstance(entry);
    if (decoded._tag === "None") continue;
    // The Gateway's own rule again, so a stored URL other than http(s) never comes back.
    const { url, ...facts } = decoded.value;
    const descriptor = orbitInstanceFromEnvironment({
      ...facts,
      projectSlug: facts.projectSlug ?? null,
      projectName: facts.projectName ?? null,
      instanceName: facts.instanceName ?? null,
      nodeName: facts.nodeName ?? null,
      instanceUrl: url ?? null,
    });
    if (descriptor) result[environmentId] = descriptor;
  }
  return result;
}

/** This device's environment provider (see planEnvironmentProvider), kept in localStorage. */
export const useEnvironmentProvider = create<EnvironmentProviderStore>(() => ({
  provider: parseEnvironmentProvider(readJson(PROVIDER_STORAGE_KEY)),
  state: parseOrbitEnvironmentState(readJson(STATE_STORAGE_KEY) ?? EMPTY_ORBIT_ENVIRONMENT_STATE),
  orbitInstances: parseOrbitInstances(readJson(INSTANCES_STORAGE_KEY)),
}));

useEnvironmentProvider.subscribe((next, previous) => {
  if (next.provider !== previous.provider) {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next.provider));
  }
  if (next.state !== previous.state) {
    window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(next.state));
  }
  if (next.orbitInstances !== previous.orbitInstances) {
    window.localStorage.setItem(INSTANCES_STORAGE_KEY, JSON.stringify(next.orbitInstances));
  }
});

/** Keeps the old object when nothing changed, so a sync does not re-render the thread panel. */
function saveOrbitInstances(next: Record<string, OrbitInstanceDescriptor>): void {
  const { orbitInstances } = useEnvironmentProvider.getState();
  if (JSON.stringify(next) === JSON.stringify(orbitInstances)) return;
  useEnvironmentProvider.setState({ orbitInstances: next });
}

/**
 * Conn: the Orbit Instance a server runs in. The Gateway's record comes first, because clones run
 * the stock T3 server; a fork server's own descriptor is the fallback (see FORK.md, "Orbit").
 */
export function useOrbitInstance(
  environmentId: EnvironmentId | null,
): OrbitInstanceDescriptor | undefined {
  const gateway = useEnvironmentProvider((store) =>
    environmentId === null ? undefined : store.orbitInstances[environmentId],
  );
  const configs = useServerConfigs();
  const server = environmentId === null ? undefined : configs.get(environmentId)?.environment;
  return preferredOrbitInstance(gateway, server?.orbitInstance);
}

/** Conn: thread starts in Orbit Projects need the desktop's Gateway client and the Orbit provider. */
export function useOrbitThreadsAvailable(): boolean {
  const provider = useEnvironmentProvider((state) => state.provider);
  return window.desktopBridge?.orbitGatewaySend !== undefined && provider === "orbit";
}

/** `useOrbitThreadsAvailable` outside React: the desktop app in Orbit mode right now. */
export function orbitThreadsAvailableNow(): boolean {
  return (
    window.desktopBridge?.orbitGatewaySend !== undefined &&
    useEnvironmentProvider.getState().provider === "orbit"
  );
}

export function setEnvironmentProvider(provider: EnvironmentProvider): void {
  useEnvironmentProvider.setState({ provider });
}

/** Conn: a thread start paired with its clone's server, which Orbit provides like any other. */
export function recordOrbitPaired(environmentId: string): void {
  useEnvironmentProvider.setState(({ state }) => ({ state: recordPaired(state, environmentId) }));
}

/**
 * Saves a reconcile run's switches. Pairing records come from the store, so a thread start or a
 * Connect that ran during the run keeps its own.
 */
function saveReconciledState(next: OrbitEnvironmentState): void {
  useEnvironmentProvider.setState(({ state: current }) => ({
    state: next.pairedByOrbit.reduce(recordPaired, {
      ...current,
      disabledByOrbit: next.disabledByOrbit,
    }),
  }));
}

function updateState(change: (state: OrbitEnvironmentState) => OrbitEnvironmentState): void {
  useEnvironmentProvider.setState(({ state }) => ({ state: change(state) }));
}

/** Conn: clones the user asked to connect in Settings; the sync retries them in this session. */
const requestedEnvironmentIds = new Set<string>();
const pairings = new Map<string, Promise<boolean>>();

/**
 * Conn: pairs this device with one Orbit server and records the attempt and its result. Resolves
 * true when the server is saved. A second call while one runs joins it.
 */
function pairOne(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  isSaved: boolean,
): Promise<boolean> {
  const { environmentId } = environment;
  const running = pairings.get(environmentId);
  if (running) return running;
  const pairing = attemptPairing(client, environment, isSaved).finally(() =>
    pairings.delete(environmentId),
  );
  pairings.set(environmentId, pairing);
  return pairing;
}

async function attemptPairing(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
  isSaved: boolean,
): Promise<boolean> {
  const { environmentId } = environment;
  const now = Date.now();
  try {
    // Recorded before the attempt, so a reload during the pairing still backs off.
    updateState((state) =>
      isSaved
        ? recordAccessPairing(state, environmentId, now)
        : recordPairingAttempt(state, environmentId, now),
    );
    const pairing = await client.pair(environmentId);
    const result = await runAtomCommand(
      appAtomRegistry,
      connectPairing,
      { pairingUrl: pairing.pairingUrl },
      { reportFailure: false },
    );
    if (result._tag !== "Success") return false;
    updateState((state) => recordPaired(state, environmentId));
    requestedEnvironmentIds.delete(environmentId);
    return true;
  } catch (error) {
    // An unreachable server pairs on a later run; a refused one after it registers again.
    if (isFinalPairingError(error)) {
      updateState((state) => recordPairingRefused(state, environment));
    }
    return false;
  }
}

/**
 * Conn: the Connect button for a clone in Settings › Orbit › Servers. Pairs it now, and lets the
 * sync retry it if this attempt fails.
 */
export function connectOrbitEnvironment(
  client: OrbitGatewayClient,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): Promise<boolean> {
  requestedEnvironmentIds.add(environment.environmentId);
  return pairOne(client, environment, false);
}

/**
 * Brings the saved environments in line with the provider: Orbit mode turns the default
 * environments off and pairs the Gateway's host servers and the clones the user connected;
 * Default mode undoes both. The desktop's own local backend is left alone. Returns the Gateway's server list when Orbit mode read it.
 */
export async function reconcileEnvironmentProvider(
  client: OrbitGatewayClient,
): Promise<readonly OrbitGatewayEnvironment[] | null> {
  const { provider, state } = useEnvironmentProvider.getState();
  const orbit = provider === "orbit" ? await client.environments() : null;
  saveOrbitInstances(orbit === null ? {} : orbitInstancesByEnvironment(orbit));
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return orbit;

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
  const now = Date.now();
  const plan = planEnvironmentProvider({
    provider,
    saved,
    orbit,
    state,
    lacksAccess,
    heldInstanceIds: heldOrbitInstanceIds(),
    requestedEnvironmentIds: [...requestedEnvironmentIds],
    now,
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

  saveReconciledState(plan.state);
  // One server per run: pairing waits for a Gateway Operation, and the rest of the sync waits too.
  const environmentId = plan.pair.find((id) => !pairings.has(id));
  const environment = orbit?.find((entry) => entry.environmentId === environmentId);
  if (environment) await pairOne(client, environment, savedIds.has(environment.environmentId));
  return orbit;
}
