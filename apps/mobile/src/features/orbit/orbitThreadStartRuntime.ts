import { useAtomValue } from "@effect/atom-react";
import {
  OrbitLaunchCopyError,
  createOrbitLaunchObserver,
  createOrbitLaunchSubmissions,
  createOrbitLaunchThreadRowsAtom,
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
import { msg } from "gt-react-native";
import { AppState } from "react-native";

import { m } from "../../i18n/messages";
import { environmentCatalog } from "../../connection/catalog";
import { writeFileAtomically } from "../../lib/atomic-file";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { uuidv4 } from "../../lib/uuid";
import { loadLaunchAdmissionsJson, saveLaunchAdmissionsJson } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadShells } from "../../state/threads";
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

function decodeLaunchAdmissions(raw: string): readonly OrbitLaunchSubmission[] {
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows))
    throw OrbitLaunchCopyError.fromCopy(msg("Could not read the Orbit submission journal."));
  return rows;
}

async function loadMobileLaunchAdmissions() {
  const saved = await loadLaunchAdmissionsJson();
  if (saved !== null) return decodeLaunchAdmissions(saved);
  const file = await launchFile(SUBMISSIONS);
  if (!file.exists) return [];
  const raw = await file.text();
  const rows = decodeLaunchAdmissions(raw);
  await saveLaunchAdmissionsJson(raw);
  // SQLite's row, including an empty array, takes precedence if deleting the old file fails.
  try {
    file.delete();
  } catch {}
  return rows;
}

export const mobileOrbitLaunches = createOrbitLaunchObserver(() => orbitGatewayClient, m);
const orbitLaunchRowsAtom = createOrbitLaunchThreadRowsAtom({
  observer: mobileOrbitLaunches,
  threadRefsAtom: environmentThreadShells.threadRefsAtom,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  archivedSnapshotAtom: (environmentId) =>
    orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} }),
});
export const mobileOrbitSubmissions = createOrbitLaunchSubmissions(
  {
    load: loadMobileLaunchAdmissions,
    save: (rows) => saveLaunchAdmissionsJson(JSON.stringify(rows)),
  },
  (record, reconcile) => mobileOrbitLaunches.submit(record.admission, record, reconcile),
);

export function acknowledgeMobileOrbitLaunch(launchId: string) {
  return mobileOrbitSubmissions.acknowledge(launchId, mobileOrbitLaunches.canAcknowledge);
}

export function useMobileOrbitLaunches() {
  return useAtomValue(orbitLaunchRowsAtom);
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
  if (row.completion === null)
    throw OrbitLaunchCopyError.fromCopy(msg("This preview is unavailable."));
  const operation = await updateLegacyOrbitPreview(orbitGatewayClient, row.completion, action);
  await changeLegacyMobileArchive((raw) => recordLegacyOrbitPreview(raw, row, operation));
}

export async function startOrbitThread(
  project: Pick<OrbitGatewayProject, "id">,
  message: string,
  sheetKey: string,
  recovery?: OrbitLaunchSubmission,
): Promise<OrbitLaunch> {
  const current = orbitGatewayState();
  const profileId = current.node?.profile?.id;
  const nodeId = current.node?.id;
  if (current.provider !== "orbit" || profileId === undefined || nodeId === undefined) {
    throw OrbitLaunchCopyError.fromCopy(msg("Connect to an Orbit profile before sending."));
  }
  if (recovery && (recovery.profileId !== profileId || recovery.nodeId !== nodeId)) {
    throw OrbitLaunchCopyError.fromCopy(
      msg("Connect to the original Orbit profile and device before sending."),
    );
  }
  // A sheet keeps the same admission even if the user changes Project.
  const draftId = recovery?.draftId ?? sheetKey;
  const saved = await mobileOrbitSubmissions.draft(draftId, { profileId, nodeId });
  if (recovery && saved === undefined) {
    throw OrbitLaunchCopyError.fromCopy(msg("This submission was already handled."));
  }
  const scope = mobileOrbitLaunches.scope();
  if (scope?.profileId !== profileId || scope.nodeId !== nodeId) {
    throw OrbitLaunchCopyError.fromCopy(
      msg("Connect to the original Orbit profile and device before sending."),
    );
  }
  const name =
    saved?.admission.request.target.kind === "new" &&
    (!saved.validationRefused ||
      (saved.admission.request.project_id === project.id &&
        saved.admission.request.prompt === message))
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
  const origin = rootNavigationRef.getRootState();
  if (origin === undefined) return;
  let navigated = false;
  const stop = rootNavigationRef.addListener("state", () => {
    navigated = true;
  });
  try {
    const environmentId = EnvironmentId.make(thread.environment_id);
    const entries = () => appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries;
    if (!entries().has(environmentId)) {
      const environment = (await orbitGatewayClient.environments()).find(
        (row) => row.environmentId === environmentId,
      );
      if (environment === undefined || !(await connectOrbitEnvironment(environment))) {
        throw OrbitLaunchCopyError.fromCopy(msg("Could not connect to this thread's environment."));
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
    if (navigated) return;
    const detail = {
      name: "Thread" as const,
      params: { environmentId, threadId: ThreadId.make(thread.thread_id) },
    };
    startOpeningDetail(detail);
    rootNavigationRef.dispatch({ ...selectWorkspaceDetail(detail), target: origin.key });
  } finally {
    stop();
  }
}

export function installOrbitLaunchObserver(): () => void {
  // The active shell forgets archived threads, even while Home is unmounted.
  const stopRows = appAtomRegistry.mount(orbitLaunchRowsAtom);
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
    stopRows();
    app.remove();
    mobileOrbitLaunches.setScope(null);
  };
}
