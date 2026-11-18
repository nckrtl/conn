import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  OrbitLaunchCopyError,
  createOrbitLaunchObserver,
  createOrbitLaunchSubmissions,
  newOrbitLaunchAdmission,
  readLegacyOrbitLaunches,
  recordLegacyOrbitPreview,
  resolveLegacyOrbitLaunch,
  updateLegacyOrbitPreview,
  type LegacyOrbitLaunch,
  type OrbitLaunch,
  type OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useSyncExternalStore } from "react";

import {
  captureOrbitDraftRevision,
  clearAcceptedOrbitDraft,
  DraftId,
  prepareOrbitDraftAdmission,
} from "../composerDraftStore";
import { m } from "../i18n/messages";
import { desktopOrbitGatewayClient } from "./desktopOrbitGateway";
import { useWorkspaceStore } from "../workspaceStore";
import { randomUUID } from "../lib/utils";
import { orbitThreadStartBlockedMessage } from "./orbitLaunchAvailability";
import { orbitDraftLaunchTarget, type OrbitDraftStartInput } from "./orbitDraft";

const SUBMISSIONS_KEY = "conn:orbit-launch-admissions:v1";
const LEGACY_KEY = "conn:orbit-thread-starts:v1";

export const orbitLaunches = createOrbitLaunchObserver(desktopOrbitGatewayClient, m);
export const orbitLaunchSubmissions = createOrbitLaunchSubmissions(
  {
    fingerprintAcknowledged: (input) => bytesToHex(sha256(new TextEncoder().encode(input))),
    lock: (work) => navigator.locks.request(SUBMISSIONS_KEY, work),
    lockDraft: (draftId, work) =>
      navigator.locks.request(
        `${SUBMISSIONS_KEY}:draft:${draftId}`,
        { ifAvailable: true },
        (lock) => {
          if (lock === null)
            throw OrbitLaunchCopyError.fromCopy(
              msg("Conn is already checking this Orbit submission."),
            );
          return work();
        },
      ),
    load: async () =>
      JSON.parse(window.localStorage.getItem(SUBMISSIONS_KEY) ?? "[]") as OrbitLaunchSubmission[],
    save: async (rows) => {
      if (rows.length === 0) window.localStorage.removeItem(SUBMISSIONS_KEY);
      else window.localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(rows));
    },
  },
  (record, reconcile) => orbitLaunches.submit(record.admission, record, reconcile),
);

export function acknowledgeOrbitDraft(launchId: string, matchesDraft: () => boolean) {
  return orbitLaunchSubmissions.acknowledge(launchId, (record) => {
    if (!orbitLaunches.canAcknowledge(record)) return false;
    clearAcceptedOrbitDraft(DraftId.make(record.draftId), matchesDraft());
    return true;
  });
}

export function useOrbitLaunches() {
  return useSyncExternalStore(orbitLaunches.subscribe, orbitLaunches.view, orbitLaunches.view);
}

export function useOrbitLaunchScope() {
  return useSyncExternalStore(orbitLaunches.subscribe, orbitLaunches.scope, orbitLaunches.scope);
}

export function readLegacyWebLaunches() {
  return readLegacyOrbitLaunches(window.localStorage.getItem(LEGACY_KEY));
}

function changeLegacyWebArchive(change: (raw: string) => string | null) {
  return navigator.locks.request(LEGACY_KEY, () => {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (raw === null) return;
    const next = change(raw);
    if (next === null) window.localStorage.removeItem(LEGACY_KEY);
    else window.localStorage.setItem(LEGACY_KEY, next);
  });
}

export function resolveLegacyWebLaunch(id: string) {
  return changeLegacyWebArchive((raw) => resolveLegacyOrbitLaunch(raw, id));
}

export async function updateLegacyWebPreview(row: LegacyOrbitLaunch, action: "refresh" | "retry") {
  const client = desktopOrbitGatewayClient();
  if (client === null || row.completion === null)
    throw OrbitLaunchCopyError.fromCopy(msg("This preview is unavailable."));
  const operation = await updateLegacyOrbitPreview(client, row.completion, action);
  await changeLegacyWebArchive((raw) => recordLegacyOrbitPreview(raw, row, operation));
}

export async function submitOrbitDraft(draftId: DraftId, start: OrbitDraftStartInput) {
  const blocked = orbitThreadStartBlockedMessage();
  if (blocked !== null) throw OrbitLaunchCopyError.fromCopy(blocked);
  const scope = orbitLaunches.scope();
  if (scope === null)
    throw OrbitLaunchCopyError.fromCopy(msg("Connect to an Orbit profile before sending."));
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const admission = newOrbitLaunchAdmission(randomUUID, scope, {
    project_id: start.project.id,
    ...(workspaceId == null ? {} : { workspace_id: workspaceId }),
    target: orbitDraftLaunchTarget(start),
    prompt: start.message,
    ...(start.modelSelection == null ? {} : { model_selection: start.modelSelection }),
    ...(start.runtimeMode == null ? {} : { runtime_mode: start.runtimeMode }),
    ...(start.interactionMode == null ? {} : { interaction_mode: start.interactionMode }),
    source: "web",
  });
  const captured = captureOrbitDraftRevision(draftId);
  return orbitLaunchSubmissions.submit({ ...scope, draftId, admission }, () =>
    prepareOrbitDraftAdmission(draftId, captured),
  );
}

export function orbitLaunchThreadRef(thread: NonNullable<OrbitLaunch["thread"]>) {
  return scopeThreadRef(EnvironmentId.make(thread.environment_id), ThreadId.make(thread.thread_id));
}

export async function attachOrbitLaunchThread(thread: NonNullable<OrbitLaunch["thread"]>) {
  const ref = orbitLaunchThreadRef(thread);
  const { prepareOrbitThreadEnvironment } = await import("./tasks/orbitAgentConversation");
  await prepareOrbitThreadEnvironment(ref.environmentId);
  return ref;
}
