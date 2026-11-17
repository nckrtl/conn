import {
  createOrbitLaunchObserver,
  createOrbitLaunchSubmissions,
  newOrbitLaunchAdmission,
  fitOrbitThreadInstanceName,
  readLegacyOrbitLaunches,
  recordLegacyOrbitPreview,
  resolveLegacyOrbitLaunch,
  updateLegacyOrbitPreview,
  type LegacyOrbitLaunch,
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

let legacyArchiveEdits = Promise.resolve();
function changeLegacyMobileArchive(change: (raw: string) => string | null) {
  const edit = legacyArchiveEdits.then(async () => {
    const file = await launchFile(LEGACY);
    if (!file.exists) return;
    const next = change(await file.text());
    if (next === null) file.delete();
    else await writeFileAtomically(file, next);
  });
  legacyArchiveEdits = edit.catch(() => {});
  return edit;
}

export function resolveLegacyMobileLaunch(id: string) {
  return changeLegacyMobileArchive((raw) => resolveLegacyOrbitLaunch(raw, id));
}

export async function updateLegacyMobilePreview(
  row: LegacyOrbitLaunch,
  action: "refresh" | "retry",
) {
  if (row.completion === null) throw new Error("This preview is unavailable.");
  const operation = await updateLegacyOrbitPreview(orbitGatewayClient, row.completion, action);
  await changeLegacyMobileArchive((raw) => recordLegacyOrbitPreview(raw, row, operation));
}

export async function startOrbitThread(
  project: OrbitGatewayProject,
  message: string,
  sheetKey: string,
): Promise<OrbitLaunch> {
  const current = orbitGatewayState();
  const profileId = current.node?.profile?.id;
  const nodeId = current.node?.id;
  if (current.provider !== "orbit" || profileId === undefined || nodeId === undefined) {
    throw new Error("Connect to an Orbit profile before sending.");
  }
  // A new sheet or project is a different draft. Unconfirmed sends remain in Home for recovery.
  const draftId = `${sheetKey}:${project.id}`;
  const saved = (await mobileOrbitSubmissions.pending({ profileId, nodeId })).find(
    (row) => row.draftId === draftId,
  );
  const name =
    saved?.admission.request.target.kind === "new"
      ? saved.admission.request.target.name
      : await fitOrbitThreadInstanceName(
          orbitGatewayClient,
          project.id,
          message,
          uuidv4().slice(0, 6),
        );
  return mobileOrbitSubmissions.submit({
    profileId,
    nodeId,
    draftId,
    admission: newOrbitLaunchAdmission(
      uuidv4,
      { profileId, nodeId },
      {
        project_id: project.id,
        ...(current.selectedWorkspaceId === null
          ? {}
          : { workspace_id: current.selectedWorkspaceId }),
        target: { kind: "new", name },
        prompt: message,
        source: "mobile",
      },
    ),
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
