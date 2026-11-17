import {
  createOrbitLaunchObserver,
  createOrbitLaunchSubmissions,
  newOrbitLaunchAdmission,
  orbitThreadInstanceName,
  readLegacyOrbitLaunches,
  resolveLegacyOrbitLaunch,
  type OrbitGatewayProject,
  type OrbitLaunch,
  type OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AppState } from "react-native";
import { useSyncExternalStore } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { writeFileAtomically } from "../../lib/atomic-file";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { selectWorkspaceDetail } from "../layout/workspace/workspace-detail-selection";
import { startOpeningDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { orbitGatewayClient } from "./orbitGatewayClient";
import {
  connectOrbitEnvironment,
  orbitGatewayState,
  subscribeOrbitGateway,
} from "./orbitGatewayStore";

async function launchFile(name: string) {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, name);
}

const SUBMISSIONS = "orbit-launch-admissions.json";
const LEGACY = "orbit-thread-starts.json";

export const mobileOrbitLaunches = createOrbitLaunchObserver(() => orbitGatewayClient);
export const mobileOrbitSubmissions = createOrbitLaunchSubmissions(
  {
    load: async () => {
      const file = await launchFile(SUBMISSIONS);
      return file.exists ? (JSON.parse(await file.text()) as OrbitLaunchSubmission[]) : [];
    },
    save: async (rows) => {
      const file = await launchFile(SUBMISSIONS);
      if (rows.length === 0) {
        if (file.exists) file.delete();
      } else await writeFileAtomically(file, JSON.stringify(rows));
    },
  },
  (record, reconcile) => mobileOrbitLaunches.submit(record.admission, record, reconcile),
);

export function useMobileOrbitLaunches() {
  return useSyncExternalStore(mobileOrbitLaunches.subscribe, mobileOrbitLaunches.view);
}

export async function readLegacyMobileLaunches() {
  const file = await launchFile(LEGACY);
  return readLegacyOrbitLaunches(file.exists ? await file.text() : null);
}

export async function resolveLegacyMobileLaunch(id: string) {
  const file = await launchFile(LEGACY);
  if (!file.exists) return;
  const remaining = resolveLegacyOrbitLaunch(await file.text(), id);
  if (remaining === null) file.delete();
  else await writeFileAtomically(file, remaining);
}

export async function startOrbitThread(
  project: OrbitGatewayProject,
  message: string,
): Promise<OrbitLaunch> {
  const current = orbitGatewayState();
  const profileId = current.node?.profile?.id;
  const nodeId = current.node?.id;
  if (current.provider !== "orbit" || profileId === undefined || nodeId === undefined) {
    throw new Error("Connect to an Orbit profile before sending.");
  }
  // The sheet has one draft. A second tap or a restart can only replay that same admission.
  const draftId = "new-orbit-thread";
  const saved = (await mobileOrbitSubmissions.pending({ profileId, nodeId })).find(
    (row) => row.draftId === draftId,
  );
  const name =
    saved?.admission.request.target.kind === "new"
      ? saved.admission.request.target.name
      : orbitThreadInstanceName(message, uuidv4().slice(0, 6));
  return mobileOrbitSubmissions.submit({
    profileId,
    nodeId,
    draftId,
    admission: newOrbitLaunchAdmission(uuidv4, {
      project_id: project.id,
      ...(current.selectedWorkspaceId === null
        ? {}
        : { workspace_id: current.selectedWorkspaceId }),
      target: { kind: "new", name },
      prompt: message,
      source: "mobile",
    }),
  });
}

export async function openMobileOrbitThread(
  thread: Pick<NonNullable<OrbitLaunch["thread"]>, "environment_id" | "thread_id">,
) {
  const environmentId = EnvironmentId.make(thread.environment_id);
  const entries = () => appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries;
  if (!entries().has(environmentId)) {
    const environment = (await orbitGatewayClient.environments()).find(
      (row) => row.environmentId === environmentId,
    );
    if (environment === undefined || !(await connectOrbitEnvironment(environment))) {
      throw new Error("Could not connect to this thread's environment.");
    }
  }
  if (entries().get(environmentId)?.enabled === false) {
    const result = await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setEnabled,
      { environmentId, enabled: true },
      { reportFailure: false },
    );
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  }
  const detail = {
    name: "Thread" as const,
    params: { environmentId, threadId: ThreadId.make(thread.thread_id) },
  };
  startOpeningDetail(detail);
  rootNavigationRef.dispatch({
    ...selectWorkspaceDetail(detail),
    target: rootNavigationRef.getRootState()?.key,
  });
}

export function installOrbitLaunchObserver(): () => void {
  const scope = () => {
    const gateway = orbitGatewayState();
    const node = gateway.node;
    mobileOrbitLaunches.setScope(
      AppState.currentState !== "background" && gateway.provider === "orbit" && node?.profile
        ? { profileId: node.profile.id, nodeId: node.id }
        : null,
    );
  };
  const stop = subscribeOrbitGateway(scope);
  const app = AppState.addEventListener("change", scope);
  scope();
  return () => {
    stop();
    app.remove();
    mobileOrbitLaunches.setScope(null);
  };
}
