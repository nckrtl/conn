import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createOrbitLaunchObserver,
  createOrbitLaunchSubmissions,
  newOrbitLaunchAdmission,
  readLegacyOrbitLaunches,
  resolveLegacyOrbitLaunch,
  type OrbitLaunch,
  type OrbitLaunchSubmission,
} from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { desktopOrbitGatewayClient } from "./desktopOrbitGateway";
import { useWorkspaceStore } from "../workspaceStore";
import { randomUUID } from "../lib/utils";
import { orbitThreadStartBlockedReason } from "./orbitLaunchAvailability";
import type { OrbitDraftStartInput } from "./orbitDraft";

const SUBMISSIONS_KEY = "conn:orbit-launch-admissions:v1";
const LEGACY_KEY = "conn:orbit-thread-starts:v1";

export const orbitLaunches = createOrbitLaunchObserver(desktopOrbitGatewayClient);
export const orbitLaunchSubmissions = createOrbitLaunchSubmissions(
  {
    lock: (work) => navigator.locks.request(SUBMISSIONS_KEY, work),
    load: async () =>
      JSON.parse(window.localStorage.getItem(SUBMISSIONS_KEY) ?? "[]") as OrbitLaunchSubmission[],
    save: async (rows) => {
      if (rows.length === 0) window.localStorage.removeItem(SUBMISSIONS_KEY);
      else window.localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(rows));
    },
  },
  (record, reconcile) => orbitLaunches.submit(record.admission, record, reconcile),
);

export function useOrbitLaunches() {
  return useSyncExternalStore(orbitLaunches.subscribe, orbitLaunches.view, orbitLaunches.view);
}

export function useOrbitLaunchScope() {
  return useSyncExternalStore(orbitLaunches.subscribe, orbitLaunches.scope, orbitLaunches.scope);
}

export function readLegacyWebLaunches() {
  return readLegacyOrbitLaunches(window.localStorage.getItem(LEGACY_KEY));
}

export function resolveLegacyWebLaunch(id: string) {
  const raw = window.localStorage.getItem(LEGACY_KEY);
  if (raw === null) return;
  const remaining = resolveLegacyOrbitLaunch(raw, id);
  if (remaining === null) window.localStorage.removeItem(LEGACY_KEY);
  else window.localStorage.setItem(LEGACY_KEY, remaining);
}

export async function submitOrbitDraft(draftId: string, start: OrbitDraftStartInput) {
  const blocked = orbitThreadStartBlockedReason();
  if (blocked !== null) throw new Error(blocked);
  const scope = orbitLaunches.scope();
  if (scope === null) throw new Error("Connect to an Orbit profile before sending.");
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const admission = newOrbitLaunchAdmission(randomUUID, {
    project_id: start.project.id,
    ...(workspaceId == null ? {} : { workspace_id: workspaceId }),
    target: start.existing
      ? { kind: "existing", instance_id: start.existing.instanceId }
      : {
          kind: "new",
          name: start.instanceName,
          ...(start.branch == null ? {} : { branch: start.branch }),
        },
    prompt: start.message,
    ...(start.modelSelection == null ? {} : { model_selection: start.modelSelection }),
    ...(start.runtimeMode == null ? {} : { runtime_mode: start.runtimeMode }),
    ...(start.interactionMode == null ? {} : { interaction_mode: start.interactionMode }),
    source: "web",
  });
  return orbitLaunchSubmissions.submit({ ...scope, draftId, admission });
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
