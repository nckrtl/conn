import type { OrbitGatewayProject } from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { selectWorkspaceDetail } from "../layout/workspace/workspace-detail-selection";
import { startOpeningDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { scheduledTaskDefaultModel } from "../settings/scheduledTaskDraft";
import {
  keepProjectInOrbitWorkspace,
  orbitGatewayState,
  recordOrbitThreadStartPaired,
  subscribeOrbitGateway,
} from "./orbitGatewayStore";
import { orbitGatewayClient } from "./orbitGatewayClient";
import { orbitThreadStartStore } from "./orbitThreadStartStore";
import {
  beginOrbitThreadStart,
  runSavedOrbitThreadStart,
  type MobileOrbitThreadStartPorts,
} from "./orbitThreadStarts";

/** Conn: wires the phone's thread starts in Orbit Projects to the app (FORK.md, "Orbit"). */

/** The clone's T3 project: Orbit's create flow adds the container's workspace. */
const ORBIT_CLONE_WORKSPACE = "/srv/workspace";
const CLONE_READY_TIMEOUT_MS = 60_000;

function waitFor<A>(atom: Atom.Atom<A>, predicate: (value: A) => boolean): Promise<boolean> {
  if (predicate(appAtomRegistry.get(atom))) return Promise.resolve(true);
  return new Promise((resolve) => {
    const unsubscribe = appAtomRegistry.subscribe(atom, (value) => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(true);
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, CLONE_READY_TIMEOUT_MS);
  });
}

function findCloneProject(environmentId: EnvironmentId) {
  return appAtomRegistry
    .get(environmentProjects.projectsAtom)
    .find(
      (project) =>
        project.environmentId === environmentId && project.workspaceRoot === ORBIT_CLONE_WORKSPACE,
    );
}

const ports: MobileOrbitThreadStartPorts = {
  store: orbitThreadStartStore,
  gateway: orbitGatewayClient,
  orbitMode: () => orbitGatewayState().provider === "orbit",
  catalogReady: () => waitFor(environmentCatalog.catalogValueAtom, (catalog) => catalog.isReady),
  isSaved: (environmentId) =>
    appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.has(EnvironmentId.make(environmentId)),
  connect: async (environmentId, pairingUrl) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      connectPairingUrl,
      { pairingUrl },
      { reportFailure: false },
    );
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      throw new Error(
        `Could not pair with the clone: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await recordOrbitThreadStartPaired(environmentId);
  },
  firstMessage: {
    waitForClone: async (environmentId) => {
      const id = EnvironmentId.make(environmentId);
      const found = await waitFor(
        environmentProjects.projectsAtom,
        () => findCloneProject(id) !== undefined,
      );
      const configured = await waitFor(environmentServerConfigsAtom, (configs) => configs.has(id));
      const project = findCloneProject(id);
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(id);
      if (!found || !configured || project === undefined || config === undefined) return null;
      return {
        projectId: ProjectId.make(project.id),
        modelSelection: scheduledTaskDefaultModel(config, project),
      };
    },
    startTurn: async (environmentId, input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.startTurn,
        { environmentId: EnvironmentId.make(environmentId), input },
        { reportFailure: false },
      );
      return result._tag === "Success"
        ? { ok: true }
        : { ok: false, error: squashAtomCommandFailure(result) };
    },
    now: () => new Date().toISOString(),
  },
  keepInWorkspace: keepProjectInOrbitWorkspace,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/** Starts opened from this app session; a thread opens on send only while Home still shows. */
const openOnSend = new Set<string>();

export function startOrbitThread(project: OrbitGatewayProject, message: string): void {
  const start = beginOrbitThreadStart(orbitThreadStartStore, {
    project,
    message,
    workspaceId: orbitGatewayState().selectedWorkspaceId,
    uuid: uuidv4,
    now: Date.now(),
  });
  openOnSend.add(start.id);
}

function openThread(environmentId: string, threadId: string): void {
  const detail = {
    name: "Thread" as const,
    params: { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) },
  };
  startOpeningDetail(detail);
  rootNavigationRef.dispatch(selectWorkspaceDetail(detail));
}

function runReadyStarts(): void {
  const gateway = orbitGatewayState();
  if (!orbitThreadStartStore.loaded() || !gateway.providerLoaded || gateway.provider !== "orbit") {
    return;
  }
  for (const start of orbitThreadStartStore.starts()) {
    if (start.error !== null) continue;
    void runSavedOrbitThreadStart(start.id, ports).then((sent) => {
      // A null result also means "already running": only the run that sent may use the flag.
      if (sent === null) return;
      const open = openOnSend.delete(start.id);
      if (
        open &&
        rootNavigationRef.isReady() &&
        rootNavigationRef.getCurrentRoute()?.name === "Home"
      ) {
        openThread(sent.environmentId, sent.threadId);
      }
    });
  }
}

/** Runs the saved starts now and whenever the list or the provider changes. */
export function installOrbitThreadStarts(): () => void {
  const disposers = [
    orbitThreadStartStore.subscribe(runReadyStarts),
    subscribeOrbitGateway(runReadyStarts),
  ];
  void orbitThreadStartStore.load();
  return () => {
    for (const dispose of disposers) dispose();
  };
}
