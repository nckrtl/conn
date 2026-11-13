import type { AuthSessionState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { OrbitGatewayEnvironment } from "./client.ts";

/**
 * Where a client's environments come from. `default` is T3's own list: environments the user adds by
 * hand. `orbit` replaces it with the T3 servers registered on the Orbit Gateway, paired
 * automatically (Conn: clones only on request). The two lists never show together: switching to
 * Orbit turns the default environments off, and switching back turns them on again.
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
  /** Conn: when Orbit last tried to pair a server this client has not saved yet. */
  readonly pairAttemptedAt?: Readonly<Record<string, number>>;
  /**
   * Conn: servers whose pairing T3 refused with a final error code, with the `registeredAt` they
   * had then. Orbit pairs such a server again only after it registers again.
   */
  readonly pairRefusedAt?: Readonly<Record<string, string>>;
  /** Conn: when Orbit last renewed a saved server's session that ends soon or has ended. */
  readonly renewedAt?: Readonly<Record<string, number>>;
  /**
   * Conn: servers whose renewal Orbit refused with `conn.pairing_revoked`, with the time of that
   * answer. They are never renewed again; only an explicit Connect (`forgetPairingRevoked`) pairs
   * them again.
   */
  readonly revokedAt?: Readonly<Record<string, number>>;
}

export const EMPTY_ORBIT_ENVIRONMENT_STATE: OrbitEnvironmentState = {
  disabledByOrbit: [],
  pairedByOrbit: [],
};

/** Conn: how long to wait before pairing a server again whose session still lacks `access:write`. */
export const ACCESS_PAIRING_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Conn: how long to wait before pairing a new server again after an attempt that did not save it.
 * Each attempt mints a link on the server, so a failure must not repeat on every sync.
 */
export const PAIRING_RETRY_MS = 5 * 60 * 1000;

/** Conn: a saved server's session is renewed once it ends within this time. */
export const SESSION_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
/** Conn: the wait between renewals of a session that has ended (each one mints a link). */
export const EXPIRED_RENEWAL_RETRY_MS = 5 * 60 * 1000;
/** Conn: the wait between renewals of a session that still works but ends soon. */
export const EXPIRING_RENEWAL_RETRY_MS = 6 * 60 * 60 * 1000;

/** Conn: why a saved server's session needs a renewal. */
export type SessionRenewalReason = "expired" | "expiring";

/** Conn: a saved Orbit server whose session ends soon or has ended. */
export interface SessionRenewal {
  readonly environmentId: string;
  readonly reason: SessionRenewalReason;
}

/**
 * Conn: whether a saved server's session needs a renewal. `expired` when the server refused the
 * credential (its session reads `authenticated: false`, or the connection is blocked on
 * authentication); `expiring` when the session ends within `SESSION_RENEW_BEFORE_MS`. A session
 * the client has not read yet, or one without an end, needs nothing.
 */
export function sessionRenewalReason(input: {
  readonly authenticationRefused: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "expiresAt"> | null;
  readonly now: number;
}): SessionRenewalReason | null {
  if (input.authenticationRefused) return "expired";
  const session = input.session;
  if (session === null) return null;
  if (!session.authenticated) return "expired";
  if (session.expiresAt === undefined) return null;
  const endsAt = DateTime.toEpochMillis(session.expiresAt);
  if (endsAt <= input.now) return "expired";
  return endsAt - input.now < SESSION_RENEW_BEFORE_MS ? "expiring" : null;
}

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
   * because their session lacks `access:write`. Record each success with `recordPaired`, each
   * attempt at the first kind with `recordPairingAttempt`, and at the second with
   * `recordAccessPairing`.
   */
  readonly pair: readonly string[];
  /**
   * Conn: the part of `pair` that renews a saved server's session. Pair these one after another
   * with `renew: true`, and record each attempt with `recordRenewal`.
   */
  readonly renew: readonly string[];
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
  /**
   * Conn: Instances whose server a thread start pairs with itself. Their servers are left alone, so
   * the device pairs with each once.
   */
  readonly heldInstanceIds?: readonly number[];
  /**
   * Conn: unsaved Instance servers (clones) the user asked to connect. Every other unsaved clone
   * is listed but left unpaired, so a new clone does not get a pairing from every device.
   */
  readonly requestedEnvironmentIds?: readonly string[];
  /** Conn: saved Orbit servers whose session ends soon or has ended (`sessionRenewalReason`). */
  readonly renew?: readonly SessionRenewal[];
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
      renew: [],
      state: { ...state, disabledByOrbit: [], pairedByOrbit: [...pairedByOrbit] },
    };
  }

  if (input.orbit === null) return { enable, disable, pair: [], renew: [], state };

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
  const held = new Set(input.heldInstanceIds ?? []);
  const requested = new Set(input.requestedEnvironmentIds ?? []);
  const renewals = new Map(
    (input.renew ?? []).map((renewal) => [renewal.environmentId, renewal.reason]),
  );
  const renew: string[] = [];
  const now = input.now ?? 0;
  const pair = input.orbit
    .filter((environment) => {
      if (environment.status !== "registered") return false;
      if (environment.instanceId !== null && held.has(environment.instanceId)) return false;
      // An asleep Instance's server cannot mint a pairing link.
      if (environment.powerState === "stopped") return false;
      const id = environment.environmentId;
      if (!savedIds.has(id)) {
        if (environment.instanceId !== null && !requested.has(id)) return false;
        const refusedAt = state.pairRefusedAt?.[id];
        if (refusedAt !== undefined && refusedAt === environment.registeredAt) return false;
        const lastAttempt = state.pairAttemptedAt?.[id];
        return lastAttempt === undefined || now - lastAttempt >= PAIRING_RETRY_MS;
      }
      // Conn: a revoked pairing is never renewed; only an explicit Connect pairs it again.
      if (state.revokedAt?.[id] !== undefined) return false;
      // Conn: a session that ends soon or has ended is renewed, unless T3 refused this
      // registration's pairing for good (it is tried again once the server registers again).
      const reason = renewals.get(id);
      if (reason !== undefined) {
        const refusedAt = state.pairRefusedAt?.[id];
        if (refusedAt !== undefined && refusedAt === environment.registeredAt) return false;
        const lastRenewal = state.renewedAt?.[id];
        const wait = reason === "expired" ? EXPIRED_RENEWAL_RETRY_MS : EXPIRING_RENEWAL_RETRY_MS;
        if (lastRenewal !== undefined && now - lastRenewal < wait) return false;
        renew.push(id);
        return true;
      }
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
    renew,
    state: { ...state, disabledByOrbit: [...disabledByOrbit], pairedByOrbit: [...pairedByOrbit] },
  };
}

/** Conn: records an attempt to renew a saved server's session, successful or not. */
export function recordRenewal(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, renewedAt: { ...state.renewedAt, [environmentId]: now } };
}

/** Conn: records that Orbit refused a renewal because this Node's pairing there is revoked. */
export function recordPairingRevoked(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, revokedAt: { ...state.revokedAt, [environmentId]: now } };
}

/** Conn: an explicit Connect lifts the revoked state, so the server pairs (and renews) again. */
export function forgetPairingRevoked(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  if (state.revokedAt?.[environmentId] === undefined) return state;
  const { [environmentId]: _lifted, ...revokedAt } = state.revokedAt;
  return { ...state, revokedAt };
}

/** Conn: whether Orbit revoked this device's pairing with the server (see `recordPairingRevoked`). */
export function isPairingRevoked(state: OrbitEnvironmentState, environmentId: string): boolean {
  return state.revokedAt?.[environmentId] !== undefined;
}

/** Conn: records an attempt to pair a saved server again for access, successful or not. */
export function recordAccessPairing(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, accessPairedAt: { ...state.accessPairedAt, [environmentId]: now } };
}

/** Conn: records an attempt to pair a server this client has not saved, successful or not. */
export function recordPairingAttempt(
  state: OrbitEnvironmentState,
  environmentId: string,
  now: number,
): OrbitEnvironmentState {
  return { ...state, pairAttemptedAt: { ...state.pairAttemptedAt, [environmentId]: now } };
}

/**
 * Conn: records that T3 refused a new server's pairing with a final error code. It is paired
 * again once its registration changes. Without a known registration time it only backs off.
 */
export function recordPairingRefused(
  state: OrbitEnvironmentState,
  environment: Pick<OrbitGatewayEnvironment, "environmentId" | "registeredAt">,
): OrbitEnvironmentState {
  if (environment.registeredAt === null) return state;
  return {
    ...state,
    pairRefusedAt: {
      ...state.pairRefusedAt,
      [environment.environmentId]: environment.registeredAt,
    },
  };
}

export function recordPaired(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  return state.pairedByOrbit.includes(environmentId)
    ? state
    : { ...state, pairedByOrbit: [...state.pairedByOrbit, environmentId] };
}

/** Conn: drops every record of a server Orbit removed, so no sync touches it again. */
export function forgetOrbitEnvironment(
  state: OrbitEnvironmentState,
  environmentId: string,
): OrbitEnvironmentState {
  const without = <T>(record: Readonly<Record<string, T>> | undefined) =>
    record === undefined
      ? undefined
      : Object.fromEntries(Object.entries(record).filter(([id]) => id !== environmentId));
  const accessPairedAt = without(state.accessPairedAt);
  const pairAttemptedAt = without(state.pairAttemptedAt);
  const pairRefusedAt = without(state.pairRefusedAt);
  const renewedAt = without(state.renewedAt);
  const revokedAt = without(state.revokedAt);
  return {
    disabledByOrbit: state.disabledByOrbit.filter((id) => id !== environmentId),
    pairedByOrbit: state.pairedByOrbit.filter((id) => id !== environmentId),
    ...(accessPairedAt === undefined ? {} : { accessPairedAt }),
    ...(pairAttemptedAt === undefined ? {} : { pairAttemptedAt }),
    ...(pairRefusedAt === undefined ? {} : { pairRefusedAt }),
    ...(renewedAt === undefined ? {} : { renewedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

export function parseEnvironmentProvider(value: unknown): EnvironmentProvider {
  return value === "orbit" ? "orbit" : "default";
}

export function parseOrbitEnvironmentState(value: unknown): OrbitEnvironmentState {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  const times = (value: unknown) => {
    const result: Record<string, number> = {};
    if (typeof value === "object" && value !== null) {
      for (const [id, at] of Object.entries(value)) {
        if (typeof at === "number") result[id] = at;
      }
    }
    return result;
  };
  const texts = (value: unknown) => {
    const result: Record<string, string> = {};
    if (typeof value === "object" && value !== null) {
      for (const [id, at] of Object.entries(value)) {
        if (typeof at === "string") result[id] = at;
      }
    }
    return result;
  };
  return {
    disabledByOrbit: ids(record.disabledByOrbit),
    pairedByOrbit: ids(record.pairedByOrbit),
    accessPairedAt: times(record.accessPairedAt),
    pairAttemptedAt: times(record.pairAttemptedAt),
    pairRefusedAt: texts(record.pairRefusedAt),
    renewedAt: times(record.renewedAt),
    revokedAt: times(record.revokedAt),
  };
}
