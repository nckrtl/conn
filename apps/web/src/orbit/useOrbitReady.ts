import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { orbitLaunchNeedsAttention } from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { OrbitReadyTimelineInput } from "../components/chat/MessagesTimeline.logic";
import { useOrbitInstance } from "./environmentProvider";
import { orbitReadyLine } from "./orbitSetupView";
import { useOrbitLaunches } from "./orbitLaunches";

/**
 * Conn: the Orbit row of a thread a pending Orbit start handed over to: the setup card while the
 * create's completion runs or failed, then "Instance ready".
 */
export function useOrbitReady(
  environmentId: string | null,
  threadId: string | null,
): OrbitReadyTimelineInput | null {
  const snapshot = useOrbitLaunches();
  const launch = snapshot.launches.find(
    (row) => row.thread?.environment_id === environmentId && row.thread?.thread_id === threadId,
  );
  const thread = launch?.thread;
  const instance = useOrbitInstance(thread ? EnvironmentId.make(thread.environment_id) : null);
  if (!launch || !thread) return null;
  const url = launch.readiness.application_preview === true ? (instance?.url ?? null) : null;
  return {
    view: {
      instanceName: instance?.instanceName ?? "",
      nodeName: instance?.nodeName ?? "",
      url,
      readyLine: orbitReadyLine(url),
      modelFallbackLine: null,
      branch: null,
      baseBranch: null,
      dependenciesLine: null,
    },
    launch: orbitLaunchNeedsAttention(launch) ? launch : null,
    launchStale: snapshot.error !== null,
    messageId: thread.message_id,
    threadRef: scopeThreadRef(
      EnvironmentId.make(thread.environment_id),
      ThreadId.make(thread.thread_id),
    ),
  };
}
