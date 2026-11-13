import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  createOrbitInstanceWaker,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitInstanceWakeOutcome,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * Conn: asleep Orbit Instances. An Instance Orbit lists as `stopped` and that no window shows is
 * parked: Conn does not connect to it (a connect to a frozen container hangs and wakes nothing),
 * and its rows read "Stopped". A window that shows one of its threads or drafts uses it: Conn asks
 * Orbit to wake it, then connects. Lists, badges and background syncs never wake an Instance.
 */

/** An older Gateway without the wake route is asked again after this long. */
const UNSUPPORTED_RECHECK_MS = 60 * 60_000;
/** A failed wake is not repeated for the same environment before this. */
const FAILED_WAKE_PAUSE_MS = 30_000;
/** A fresh list read for an environment in use that is not connected, at most this often. */
const FRESH_READ_EVERY_MS = 5_000;
/** A listing read while a wake ran may still say `stopped`: trust the wake this long. */
const WOKEN_GRACE_MS = 30_000;
/** A view that remounts (a route swap) holds the environment again within this. */
const RELEASE_SETTLE_MS = 1_000;
const UNSUPPORTED_STORAGE_KEY = "t3code:orbit-wake-unsupported-at:v1";

interface OrbitInstanceSleepStore {
  /** Environments whose connection Conn holds off because the Instance is asleep. */
  readonly parked: ReadonlySet<string>;
  /** When an older Gateway answered that it has no wake route; null when it has one. */
  readonly unsupportedAt: number | null;
}

function readUnsupportedAt(): number | null {
  try {
    const raw = Number(window.localStorage.getItem(UNSUPPORTED_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

function rememberUnsupported(at: number): void {
  try {
    window.localStorage.setItem(UNSUPPORTED_STORAGE_KEY, String(at));
  } catch {
    // Without storage the memory lasts until the app restarts.
  }
  useOrbitInstanceSleep.setState({ unsupportedAt: at });
}

export const useOrbitInstanceSleep = create<OrbitInstanceSleepStore>(() => ({
  parked: new Set(),
  unsupportedAt: readUnsupportedAt(),
}));

/** Whether Conn may wake Instances: false once an older Gateway said it has no wake route. */
export function orbitWakeSupported(
  unsupportedAt: number | null = useOrbitInstanceSleep.getState().unsupportedAt,
  now: number = Date.now(),
): boolean {
  return unsupportedAt === null || now - unsupportedAt >= UNSUPPORTED_RECHECK_MS;
}

/** True while Conn holds the environment off because its Instance is asleep. */
export function useOrbitEnvironmentParked(environmentId: string | null): boolean {
  return useOrbitInstanceSleep((state) =>
    environmentId === null ? false : state.parked.has(environmentId),
  );
}

interface ListedInstance {
  readonly instanceId: number;
  readonly stopped: boolean;
}

/** The ports the controller drives; the app's registry and Gateway, or fakes in tests. */
export interface OrbitInstanceSleepPorts {
  readonly isSaved: (environmentId: string) => boolean;
  readonly setParked: (environmentId: string, parked: boolean) => Promise<void>;
  readonly retryNow: (environmentId: string) => Promise<void>;
  readonly wake: (
    client: OrbitGatewayClient,
    instanceId: number,
  ) => Promise<OrbitInstanceWakeOutcome>;
  readonly now: () => number;
  /** Runs `run` after `ms`; tests run it at once. */
  readonly later?: (run: () => void, ms: number) => void;
}

export function createOrbitInstanceSleepController(ports: OrbitInstanceSleepPorts) {
  let client: OrbitGatewayClient | null = null;
  let listed = new Map<string, ListedInstance>();
  const inUse = new Map<string, number>();
  const failedAt = new Map<string, number>();
  const wokenAt = new Map<string, number>();
  const freshReadAt = new Map<string, number>();
  const waking = new Set<string>();
  const later = ports.later ?? ((run: () => void, ms: number) => void setTimeout(run, ms));

  const parked = () => useOrbitInstanceSleep.getState().parked;
  const setParked = (environmentId: string, hold: boolean): Promise<void> => {
    const current = parked();
    if (current.has(environmentId) === hold) return Promise.resolve();
    const next = new Set(current);
    if (hold) next.add(environmentId);
    else next.delete(environmentId);
    useOrbitInstanceSleep.setState({ parked: next });
    return ports.setParked(environmentId, hold);
  };
  const releaseAll = async (): Promise<void> => {
    for (const environmentId of parked()) await setParked(environmentId, false);
  };
  const isStopped = (environmentId: string): boolean => {
    const item = listed.get(environmentId);
    if (item === undefined || !item.stopped) return false;
    const woken = wokenAt.get(environmentId);
    return woken === undefined || ports.now() - woken >= WOKEN_GRACE_MS;
  };

  const wake = async (environmentId: string): Promise<void> => {
    const item = listed.get(environmentId);
    if (client === null || item === undefined || waking.has(environmentId)) return;
    const failed = failedAt.get(environmentId);
    if (failed !== undefined && ports.now() - failed < FAILED_WAKE_PAUSE_MS) return;
    waking.add(environmentId);
    try {
      // Connecting starts now, so the view shows what a slow connect shows today.
      await setParked(environmentId, false);
      const outcome = await ports.wake(client, item.instanceId);
      if (outcome.kind === "awake") {
        failedAt.delete(environmentId);
        wokenAt.set(environmentId, ports.now());
        const current = listed.get(environmentId);
        if (current) listed.set(environmentId, { ...current, stopped: false });
        // Nothing may have held it off meanwhile; release it again before the connect.
        await setParked(environmentId, false);
        await ports.retryNow(environmentId);
      } else if (outcome.kind === "unsupported") {
        rememberUnsupported(ports.now());
        await releaseAll();
      } else {
        // The connection keeps trying as it does today, and shows today's failure.
        failedAt.set(environmentId, ports.now());
        console.warn(`Conn could not wake ${environmentId}: ${outcome.code}: ${outcome.message}`);
      }
    } finally {
      waking.delete(environmentId);
    }
  };

  /** Parks an asleep Instance nobody uses, wakes one in use, and lets an awake one connect. */
  const settle = async (environmentId: string): Promise<void> => {
    if (!orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now())) {
      await setParked(environmentId, false);
      return;
    }
    if (!isStopped(environmentId)) {
      await setParked(environmentId, false);
      return;
    }
    if (waking.has(environmentId)) return;
    if ((inUse.get(environmentId) ?? 0) > 0) {
      // A list read must not wait for the wake.
      void wake(environmentId);
      return;
    }
    if (ports.isSaved(environmentId)) await setParked(environmentId, true);
  };

  /** Each Gateway list read: power states of the Instances' servers. Null outside Orbit mode. */
  const observe = async (
    nextClient: OrbitGatewayClient,
    orbit: readonly OrbitGatewayEnvironment[] | null,
  ): Promise<void> => {
    client = nextClient;
    if (orbit === null) {
      listed = new Map();
      await releaseAll();
      return;
    }
    const previous = listed;
    const next = new Map<string, ListedInstance>();
    for (const environment of orbit) {
      if (environment.instanceId === null || environment.status !== "registered") continue;
      next.set(environment.environmentId, {
        instanceId: environment.instanceId,
        stopped: environment.powerState === "stopped",
      });
    }
    listed = next;
    for (const environmentId of parked()) {
      if (!next.has(environmentId)) await setParked(environmentId, false);
    }
    for (const [environmentId, item] of next) {
      const wasStopped = previous.get(environmentId)?.stopped === true;
      const wasParked = parked().has(environmentId);
      await settle(environmentId);
      // Woken elsewhere (a Route visit, another device): connect now, not after the backoff.
      if (wasStopped && !item.stopped && !wasParked && ports.isSaved(environmentId)) {
        await ports.retryNow(environmentId);
      }
    }
  };

  /**
   * A window shows a thread or draft of the environment. When it is not connected and Orbit lists
   * its Instance asleep, it wakes; an Instance listed awake whose connection fails is read again.
   */
  const ensureAwake = async (
    environmentId: string,
    phase: EnvironmentConnectionPhase | null,
  ): Promise<void> => {
    if (phase === "connected" || !listed.has(environmentId)) return;
    if (!orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now())) return;
    if (isStopped(environmentId)) {
      await wake(environmentId);
      return;
    }
    if (phase !== "reconnecting" && phase !== "error") return;
    const lastRead = freshReadAt.get(environmentId);
    if (client === null || (lastRead !== undefined && ports.now() - lastRead < FRESH_READ_EVERY_MS))
      return;
    freshReadAt.set(environmentId, ports.now());
    const reader = client;
    let orbit: readonly OrbitGatewayEnvironment[];
    try {
      orbit = await reader.environments();
    } catch {
      return;
    }
    await observe(reader, orbit);
  };

  /** Marks the environment in use until the returned release runs. */
  const hold = (environmentId: string): (() => void) => {
    inUse.set(environmentId, (inUse.get(environmentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (inUse.get(environmentId) ?? 1) - 1;
      if (count > 0) inUse.set(environmentId, count);
      else {
        inUse.delete(environmentId);
        // A remount holds it again at once; only an environment nobody shows is parked.
        later(() => {
          if (!inUse.has(environmentId)) void settle(environmentId);
        }, RELEASE_SETTLE_MS);
      }
    };
  };

  /** The create runner's wake: shares the in-flight wake and remembers an older Gateway. */
  const wakeForStart = async (
    startClient: OrbitGatewayClient,
    instanceId: number,
  ): Promise<OrbitInstanceWakeOutcome> => {
    if (!orbitWakeSupported(useOrbitInstanceSleep.getState().unsupportedAt, ports.now())) {
      return { kind: "unsupported" };
    }
    const outcome = await ports.wake(startClient, instanceId);
    if (outcome.kind === "unsupported") {
      rememberUnsupported(ports.now());
      await releaseAll();
    }
    return outcome;
  };

  return { observe, ensureAwake, hold, wakeForStart };
}

const waker = createOrbitInstanceWaker();

const controller = createOrbitInstanceSleepController({
  isSaved: (environmentId) =>
    appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.has(environmentId as EnvironmentId),
  setParked: async (environmentId, parked) => {
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setParked,
      { environmentId: environmentId as EnvironmentId, parked },
      { reportFailure: false },
    );
  },
  retryNow: async (environmentId) => {
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.retryNow,
      environmentId as EnvironmentId,
      { reportFailure: false },
    );
  },
  wake: (client, instanceId) => waker.wake(client, instanceId),
  now: Date.now,
});

export const observeOrbitInstancePower = controller.observe;
export const ensureOrbitEnvironmentAwake = controller.ensureAwake;
export const holdOrbitEnvironmentInUse = controller.hold;
export const wakeOrbitInstanceForStart = controller.wakeForStart;

/**
 * Conn: the window shows a thread or draft of this environment, so it is in use: an asleep Orbit
 * Instance is woken and then connected. Mount it only where the user works in the environment;
 * a list or badge that mounts it would keep Instances awake.
 */
export function useOrbitEnvironmentInUse(
  environmentId: string | null,
  phase: EnvironmentConnectionPhase | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the shown environment as in use with the sleep controller while mounted
  useEffect(() => {
    if (environmentId === null) return;
    return holdOrbitEnvironmentInUse(environmentId);
  }, [environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks Orbit to wake the shown environment's Instance when its connection is not up
  useEffect(() => {
    if (environmentId === null) return;
    void ensureOrbitEnvironmentAwake(environmentId, phase);
  }, [environmentId, phase]);
}
