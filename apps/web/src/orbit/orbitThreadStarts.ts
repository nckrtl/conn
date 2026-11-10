import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  newOrbitThreadStart,
  runOrbitThreadStart,
  type OrbitGatewayClient,
  type OrbitGatewayProject,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, waitForThreadShell } from "../state/entities";
import { environmentProjects } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { recordOrbitPaired } from "./environmentProvider";
import { readStored, saveStart, updateStarts } from "./orbitThreadStartStore";
import { orbitFirstTurnInput } from "./orbitThreadTurn";

/** Conn: runs the threads started in an Orbit Project (FORK.md, "Orbit"), in the main window only. */

/** The clone's T3 project: the create flow adds the container's workspace. */
const ORBIT_CLONE_WORKSPACE = "/srv/workspace";
const CLONE_READY_TIMEOUT_MS = 60_000;

export function beginOrbitThreadStart(project: OrbitGatewayProject, message: string): void {
  const start = newOrbitThreadStart({
    id: randomUUID(),
    project,
    message,
    suffix: randomUUID().slice(0, 4),
    threadId: newThreadId(),
    messageId: newMessageId(),
    now: Date.now(),
  });
  updateStarts((starts) => [...starts, start]);
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

/** Starts the thread with the first message in the clone's workspace project, queued behind any running turn. */
async function send(start: OrbitThreadStart & { readonly environmentId: string }): Promise<void> {
  const environmentId = start.environmentId as EnvironmentId;
  const threadId = ThreadId.make(start.threadId);
  if (readThreadShell(scopeThreadRef(environmentId, threadId)) !== null) return;
  const findProject = () =>
    appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find(
        (project) =>
          project.environmentId === environmentId &&
          project.workspaceRoot === ORBIT_CLONE_WORKSPACE,
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
    predicate: (configs) => configs.has(environmentId),
    timeoutMs: CLONE_READY_TIMEOUT_MS,
  });
  const project = findProject();
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  if (!ready || !configured || project === undefined || config === undefined) {
    throw new Error(`The clone's T3 project ${ORBIT_CLONE_WORKSPACE} did not appear.`);
  }
  // After a reload the thread may already exist: its shell arrives with the clone's snapshot.
  if (readThreadShell(scopeThreadRef(environmentId, threadId)) !== null) return;
  const projectId = ProjectId.make(project.id);
  const modelSelection =
    config.settings.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(config.providers, config.settings, projectId);
  if (modelSelection === null) throw new Error("The clone's T3 server offers no model.");
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId,
      input: orbitFirstTurnInput({
        start,
        projectId,
        modelSelection,
        createdAt: new Date().toISOString(),
      }),
    },
    { reportFailure: false },
  );
  // A refusal of a thread that exists means an earlier send already reached the clone.
  if (
    result._tag === "Failure" &&
    !(await waitForThreadShell(scopeThreadRef(environmentId, threadId)))
  ) {
    const error = squashAtomCommandFailure(result);
    throw new Error(
      `The clone did not take the first message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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
  try {
    // Whether the device saved the clone's server is known only once the catalog loaded.
    await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentCatalog.catalogValueAtom,
      predicate: (catalog) => catalog.isReady,
      timeoutMs: CLONE_READY_TIMEOUT_MS,
    });
    let environmentId: string | null = null;
    const sent = await runOrbitThreadStart(start, {
      client,
      save: saveStart,
      wait: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
      isSaved,
      connect,
      send: async (ready) => {
        environmentId = ready.environmentId;
        await send(ready);
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
