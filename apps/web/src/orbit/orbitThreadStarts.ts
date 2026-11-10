import {
  newOrbitThreadStart,
  runOrbitThreadStart,
  type OrbitGatewayClient,
  type OrbitGatewayProject,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { recordOrbitPaired, useEnvironmentProvider } from "./environmentProvider";
import { readStored, saveStart, updateStarts } from "./orbitThreadStartStore";
import { type OrbitFirstMessagePorts, sendOrbitFirstMessage } from "./orbitThreadTurn";

/** Conn: runs the threads started in an Orbit Project (FORK.md, "Orbit"), in the main window only. */

/** The clone's T3 project: the create flow adds the container's workspace. */
const ORBIT_CLONE_WORKSPACE = "/srv/workspace";
const CLONE_READY_TIMEOUT_MS = 60_000;

/** The route each start began on in this window; the runner opens the thread only if it is still there. */
const startedOn = new Map<string, string>();

export function beginOrbitThreadStart(
  project: OrbitGatewayProject,
  message: string,
  pathname: string,
): void {
  const start = newOrbitThreadStart({
    id: randomUUID(),
    project,
    message,
    suffix: randomUUID().slice(0, 6),
    threadId: newThreadId(),
    messageId: newMessageId(),
    commandId: randomUUID(),
    now: Date.now(),
  });
  startedOn.set(start.id, pathname);
  updateStarts((starts) => [...starts, start]);
}

/** Whether the window still shows the route the start began on. */
export function stillOnStartRoute(id: string, pathname: string): boolean {
  const route = startedOn.get(id);
  startedOn.delete(id);
  return route === pathname;
}

export function retryOrbitThreadStart(id: string): void {
  updateStarts((starts) =>
    starts.map((start) => (start.id === id ? { ...start, error: null } : start)),
  );
}

export function dismissOrbitThreadStart(id: string): void {
  updateStarts((starts) => starts.filter((start) => start.id !== id));
}

function isSaved(environmentId: string): boolean {
  return appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.has(environmentId as EnvironmentId);
}

async function connect(environmentId: string, pairingUrl: string): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    { pairingUrl },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    throw new Error(
      `Could not pair with the clone: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  recordOrbitPaired(environmentId);
}

/** The clone's workspace project and its server's default model, once both loaded. */
async function waitForClone(environmentId: string) {
  const id = environmentId as EnvironmentId;
  const findProject = () =>
    appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find(
        (project) =>
          project.environmentId === id && project.workspaceRoot === ORBIT_CLONE_WORKSPACE,
      );
  const ready = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentProjects.projectsAtom,
    predicate: () => findProject() !== undefined,
    timeoutMs: CLONE_READY_TIMEOUT_MS,
  });
  const configured = await waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentServerConfigsAtom,
    predicate: (configs) => configs.has(id),
    timeoutMs: CLONE_READY_TIMEOUT_MS,
  });
  const project = findProject();
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(id);
  if (!ready || !configured || project === undefined || config === undefined) return null;
  const projectId = ProjectId.make(project.id);
  return {
    projectId,
    modelSelection:
      config.settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(config.providers, config.settings, projectId),
  };
}

const firstMessagePorts: OrbitFirstMessagePorts = {
  waitForClone,
  startTurn: async (environmentId, input) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      { environmentId: environmentId as EnvironmentId, input },
      { reportFailure: false },
    );
    return result._tag === "Success"
      ? { ok: true }
      : { ok: false, error: squashAtomCommandFailure(result) };
  },
  now: () => new Date().toISOString(),
  stopped: () => false,
};

const running = new Set<string>();

/**
 * Runs a start from its last saved step, once per window at a time. Resolves the thread it sent
 * the first message in, or null when the start stopped (its `error` says why).
 */
export async function runSavedOrbitThreadStart(
  client: OrbitGatewayClient,
  id: string,
): Promise<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null> {
  const start = readStored().find((entry) => entry.id === id);
  if (start === undefined || start.error !== null || running.has(id)) return null;
  running.add(id);
  // Dismiss removes the start; a switch to Default pauses it until Orbit mode is back.
  const stopped = () =>
    !readStored().some((entry) => entry.id === id) ||
    useEnvironmentProvider.getState().provider !== "orbit";
  try {
    // Whether the device saved the clone's server is known only once the catalog loaded.
    const catalogReady = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentCatalog.catalogValueAtom,
      predicate: (catalog) => catalog.isReady,
      timeoutMs: CLONE_READY_TIMEOUT_MS,
    });
    if (!catalogReady) {
      saveStart({ ...start, error: "Conn's saved environments did not load." });
      return null;
    }
    let environmentId: string | null = null;
    const sent = await runOrbitThreadStart(start, {
      client,
      save: saveStart,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      stopped,
      isSaved,
      connect,
      send: async (ready) => {
        environmentId = ready.environmentId;
        await sendOrbitFirstMessage(ready, { ...firstMessagePorts, stopped });
      },
    });
    if (!sent || environmentId === null) return null;
    dismissOrbitThreadStart(id);
    return {
      environmentId: environmentId as EnvironmentId,
      threadId: ThreadId.make(start.threadId),
    };
  } finally {
    running.delete(id);
  }
}
