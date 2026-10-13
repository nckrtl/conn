import {
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  parseEnvironmentProvider,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
  type EnvironmentProvider,
  type OrbitEnvironmentState,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthAccessWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentLacksScope } from "../state/session";

const PROVIDER_STORAGE_KEY = "t3code:environment-provider:v1";
const STATE_STORAGE_KEY = "t3code:orbit-environments:v1";

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
}

/** This device's environment provider (see planEnvironmentProvider), kept in localStorage. */
export const useEnvironmentProvider = create<EnvironmentProviderStore>(() => ({
  provider: parseEnvironmentProvider(readJson(PROVIDER_STORAGE_KEY)),
  state: parseOrbitEnvironmentState(readJson(STATE_STORAGE_KEY) ?? EMPTY_ORBIT_ENVIRONMENT_STATE),
}));

useEnvironmentProvider.subscribe((next, previous) => {
  if (next.provider !== previous.provider) {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next.provider));
  }
  if (next.state !== previous.state) {
    window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(next.state));
  }
});

export function setEnvironmentProvider(provider: EnvironmentProvider): void {
  useEnvironmentProvider.setState({ provider });
}

/**
 * Brings the saved environments in line with the provider: Orbit mode turns the default
 * environments off and pairs the Gateway's servers; Default mode undoes both. The desktop's own
 * local backend is left alone. Returns the Gateway's server list when Orbit mode read it.
 */
export async function reconcileEnvironmentProvider(
  client: OrbitGatewayClient,
): Promise<readonly OrbitGatewayEnvironment[] | null> {
  const { provider, state } = useEnvironmentProvider.getState();
  const orbit = provider === "orbit" ? await client.environments() : null;
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
  const plan = planEnvironmentProvider({ provider, saved, orbit, state, lacksAccess, now });
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

  let next = plan.state;
  for (const environmentId of plan.pair) {
    if (savedIds.has(environmentId)) next = recordAccessPairing(next, environmentId, now);
    try {
      const pairing = await client.pair(environmentId);
      const result = await runAtomCommand(
        appAtomRegistry,
        connectPairing,
        { pairingUrl: pairing.pairingUrl },
        { reportFailure: false },
      );
      if (result._tag === "Success") next = recordPaired(next, environmentId);
    } catch {
      // An unreachable server pairs on a later run.
    }
  }
  useEnvironmentProvider.setState({ state: next });
  return orbit;
}
