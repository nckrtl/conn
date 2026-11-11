import {
  newOrbitThreadStart,
  runOrbitThreadStart,
  sendOrbitFirstMessage,
  type OrbitFirstMessagePorts,
  type OrbitGatewayClient,
  type OrbitGatewayProject,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";

import { isDraftThreadRoute } from "../threads/thread-route-state";
import type { OrbitThreadStartStore } from "./orbitThreadStartStore";

/** Conn: runs the threads started in an Orbit Project on this phone (FORK.md, "Orbit"). */

export interface MobileOrbitThreadStartPorts {
  readonly store: OrbitThreadStartStore;
  readonly gateway: OrbitGatewayClient;
  /** False once the device leaves Orbit mode: the start pauses until it comes back. */
  readonly orbitMode: () => boolean;
  /** Resolves false when the saved environments did not load in time. */
  readonly catalogReady: () => Promise<boolean>;
  readonly isSaved: (environmentId: string) => boolean;
  readonly connect: (environmentId: string, pairingUrl: string) => Promise<void>;
  readonly firstMessage: Omit<OrbitFirstMessagePorts, "stopped">;
  /** Adds the clone's project ref to the workspace selected at Start; never throws. */
  readonly keepInWorkspace: (workspaceId: string | null, projectRef: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/**
 * Where Start goes back to, from the Orbit project screen on top of `state`: past Choose project,
 * and past the new-thread draft that opened it, which closes itself on focus when it has no
 * project. The thread opens on send only while that route still shows.
 */
export function orbitStartReturn(
  state:
    | {
        readonly index: number;
        readonly routes: ReadonlyArray<{
          readonly key: string;
          readonly name: string;
          readonly params?: object;
        }>;
      }
    | undefined,
): { readonly back: number; readonly returnRouteKey: string | undefined } {
  if (state === undefined) return { back: 1, returnRouteKey: undefined };
  let back = state.routes[state.index - 1]?.name === "NewTaskProject" ? 2 : 1;
  if (isDraftThreadRoute(state.routes[state.index - back])) back += 1;
  return { back, returnRouteKey: state.routes[state.index - back]?.key };
}

export function beginOrbitThreadStart(
  store: OrbitThreadStartStore,
  input: {
    readonly project: OrbitGatewayProject;
    readonly message: string;
    readonly workspaceId: string | null;
    readonly uuid: () => string;
    readonly now: number;
  },
): OrbitThreadStart {
  const start = {
    ...newOrbitThreadStart({
      id: input.uuid(),
      project: input.project,
      message: input.message,
      suffix: input.uuid().slice(0, 6),
      threadId: input.uuid(),
      messageId: input.uuid(),
      commandId: input.uuid(),
      now: input.now,
    }),
    workspaceId: input.workspaceId,
  };
  store.update((starts) => [...starts, start]);
  return start;
}

const running = new Set<string>();

/**
 * The state machine saves a step and makes the next call at once; on the phone the save is an
 * async file write. Each call first waits for the write, so a key or Operation id the call
 * depends on is on disk before the Gateway sees it. A failed write stops the step.
 */
function afterSave(store: OrbitThreadStartStore, gateway: OrbitGatewayClient): OrbitGatewayClient {
  const saved =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      await store.flush();
      return call(...args);
    };
  return {
    ...gateway,
    createThreadInstance: saved(gateway.createThreadInstance),
    operation: saved(gateway.operation),
    environments: saved(gateway.environments),
    startPairing: saved(gateway.startPairing),
    // Not readPairing: the Operation poll before it already waited, and a failed wait there
    // would make Retry mint a second pairing.
  };
}

/**
 * Runs a start from its last saved step, once at a time. Resolves the thread it sent the first
 * message in, or null when the start stopped (its `error` says why) or paused.
 */
export async function runSavedOrbitThreadStart(
  id: string,
  ports: MobileOrbitThreadStartPorts,
): Promise<{ readonly environmentId: string; readonly threadId: string } | null> {
  const { store } = ports;
  const start = store.starts().find((entry) => entry.id === id);
  if (start === undefined || start.error !== null || running.has(id)) return null;
  running.add(id);
  const stopped = () => !store.starts().some((entry) => entry.id === id) || !ports.orbitMode();
  try {
    if (!(await ports.catalogReady())) {
      store.save({
        ...start,
        error: "Conn's saved environments did not load.",
        errorCode: null,
      });
      return null;
    }
    let environmentId: string | null = null;
    const sent = await runOrbitThreadStart(start, {
      client: afterSave(store, ports.gateway),
      save: store.save,
      sleep: ports.sleep,
      now: ports.now,
      stopped,
      isSaved: ports.isSaved,
      connect: async (environmentId, pairingUrl) => {
        await store.flush();
        await ports.connect(environmentId, pairingUrl);
      },
      send: async (ready) => {
        await store.flush();
        environmentId = ready.environmentId;
        const projectId = await sendOrbitFirstMessage(ready, { ...ports.firstMessage, stopped });
        // A clone is a new environment: without its ref the selected workspace hides the thread.
        await ports.keepInWorkspace(
          start.workspaceId ?? null,
          `${ready.environmentId}:${projectId}`,
        );
      },
    });
    if (!sent || environmentId === null) return null;
    store.update((starts) => starts.filter((entry) => entry.id !== id));
    return { environmentId, threadId: start.threadId };
  } finally {
    running.delete(id);
  }
}
