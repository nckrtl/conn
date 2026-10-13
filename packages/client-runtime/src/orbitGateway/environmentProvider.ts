import type { OrbitGatewayEnvironment } from "./client.ts";

/**
 * Where a client's environments come from. `default` is T3's own list: environments the user adds by
 * hand. `orbit` replaces it with the T3 servers registered on the Orbit Gateway, paired
 * automatically. The two lists never show together: switching to Orbit turns the default
 * environments off, and switching back turns them on again.
 */
export type EnvironmentProvider = "default" | "orbit";

/** What the client remembers between switches, so each switch restores the other side exactly. */
export interface OrbitEnvironmentState {
  /** Default environments Orbit turned off; switching back to `default` turns them on. */
  readonly disabledByOrbit: readonly string[];
  /** Environments Orbit paired; switching back to `default` turns them off, `orbit` on again. */
  readonly pairedByOrbit: readonly string[];
  /** Conn: when Orbit last paired a server again because its session could not manage access. */
  readonly accessPairedAt?: Readonly<Record<string, number>>;
}

export const EMPTY_ORBIT_ENVIRONMENT_STATE: OrbitEnvironmentState = {
  disabledByOrbit: [],
  pairedByOrbit: [],
};

/** Conn: how long to wait before pairing a server again whose session still lacks `access:write`. */
export const ACCESS_PAIRING_RETRY_MS = 6 * 60 * 60 * 1000;

/** A saved environment the provider manages. The desktop's own local backend is never passed in. */
export interface ManagedEnvironment {
  readonly environmentId: string;
  readonly enabled: boolean;
}

export interface EnvironmentProviderPlan {
  readonly enable: readonly string[];
  readonly disable: readonly string[];
  /**
   * Registered Orbit servers this client has not saved yet, and (Conn) saved ones to pair again
   * because their session lacks `access:write`. Record each success with `recordPaired`, and each
   * attempt at the second kind with `recordAccessPairing`.
   */
  readonly pair: readonly string[];
  readonly state: OrbitEnvironmentState;
}

/**
 * The changes that bring the saved environments in line with the provider. `orbit` is the Gateway's
 * server list, or null when it could not be read; without it Orbit mode changes nothing, because it
 * cannot tell an Orbit server from a default environment.
 */
export function planEnvironmentProvider(input: {
  readonly provider: EnvironmentProvider;
  readonly saved: readonly ManagedEnvironment[];
  readonly orbit: readonly OrbitGatewayEnvironment[] | null;
  readonly state: OrbitEnvironmentState;
  /** Conn: saved Orbit servers whose session is known to lack `access:write`. */
  readonly lacksAccess?: readonly string[];
  readonly now?: number;
}): EnvironmentProviderPlan {
  const { saved, state } = input;
  const disabledByOrbit = new Set(state.disabledByOrbit);
  const pairedByOrbit = new Set(state.pairedByOrbit);
  const enable: string[] = [];
  const disable: string[] = [];

  if (input.provider === "default") {
    for (const environment of saved) {
      if (disabledByOrbit.has(environment.environmentId)) {
        if (!environment.enabled) enable.push(environment.environmentId);
      } else if (pairedByOrbit.has(environment.environmentId) && environment.enabled) {
        disable.push(environment.environmentId);
      }
    }
    return {
      enable,
      disable,
      pair: [],
      state: { disabledByOrbit: [], pairedByOrbit: [...pairedByOrbit] },
    };
  }

  if (input.orbit === null) return { enable, disable, pair: [], state };

  const orbitIds = new Set(input.orbit.map((environment) => environment.environmentId));
  const savedIds = new Set(saved.map((environment) => environment.environmentId));
  for (const environment of saved) {
    const id = environment.environmentId;
    if (orbitIds.has(id)) {
      // An Orbit server Orbit turned off on an earlier switch to `default` comes back.
      if (!environment.enabled && pairedByOrbit.has(id)) enable.push(id);
    } else if (environment.enabled) {
      disable.push(id);
      // A server that left the Gateway stays Orbit's; anything else is a default environment.
      if (!pairedByOrbit.has(id)) disabledByOrbit.add(id);
    }
  }
  const lacksAccess = new Set(input.lacksAccess ?? []);
  const now = input.now ?? 0;
  const pair = input.orbit
    .filter((environment) => {
      if (environment.status !== "registered") return false;
      const id = environment.environmentId;
      if (!savedIds.has(id)) return true;
      // Conn: pair again so the session can manage linked environments (see FORK.md, "Orbit").
      const lastTry = state.accessPairedAt?.[id];
      return (
        lacksAccess.has(id) && (lastTry === undefined || now - lastTry >= ACCESS_PAIRING_RETRY_MS)
      );
    })
    .map((environment) => environment.environmentId);

  return {
    enable,
    disable,
    pair,
    state: { ...state, disabledByOrbit: [...disabledByOrbit], pairedByOrbit: [...pairedByOrbit] },
  };
}

/** Conn: records an attempt to pair a saved server again for access, successful or not. */
export function recordAccessPairing(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, accessPairedAt: { ...state.accessPairedAt, [environmentId]: now } };
}

export function recordPaired(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  return state.pairedByOrbit.includes(environmentId)
    ? state
    : { ...state, pairedByOrbit: [...state.pairedByOrbit, environmentId] };
}

export function parseEnvironmentProvider(value: unknown): EnvironmentProvider {
  return value === "orbit" ? "orbit" : "default";
}

export function parseOrbitEnvironmentState(value: unknown): OrbitEnvironmentState {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  const accessPairedAt: Record<string, number> = {};
  if (typeof record.accessPairedAt === "object" && record.accessPairedAt !== null) {
    for (const [id, at] of Object.entries(record.accessPairedAt)) {
      if (typeof at === "number") accessPairedAt[id] = at;
    }
  }
  return {
    disabledByOrbit: ids(record.disabledByOrbit),
    pairedByOrbit: ids(record.pairedByOrbit),
    accessPairedAt,
  };
}
