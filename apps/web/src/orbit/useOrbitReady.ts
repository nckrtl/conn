import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { orbitCompletionPhase } from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { OrbitReadyTimelineInput } from "../components/chat/MessagesTimeline.logic";
import { useOrbitInstance } from "./environmentProvider";
import { orbitReadyView, orbitSetupView } from "./orbitSetupView";
import { dismissOrbitThreadStart, retrySavedOrbitCompletion } from "./orbitThreadStarts";
import { useSentOrbitThreadStart } from "./orbitThreadStartStore";

/**
 * Conn: the Orbit row of a thread a pending Orbit start handed over to: the setup card while the
 * create's completion runs or failed, then "Instance ready".
 */
export function useOrbitReady(
  environmentId: string | null,
  threadId: string | null,
): OrbitReadyTimelineInput | null {
  const sent = useSentOrbitThreadStart(threadId);
  const start = sent !== null && sent.environmentId === environmentId ? sent : null;
  const url =
    useOrbitInstance(start === null ? null : EnvironmentId.make(start.environmentId!))?.url ?? null;
  if (start === null) return null;
  const completion = orbitCompletionPhase(start);
  const id = start.id;
  return {
    view: orbitReadyView(start, url),
    setup: completion === "none" || completion === "succeeded" ? null : orbitSetupView(start),
    onRetry: () => retrySavedOrbitCompletion(id),
    onDismiss: () => dismissOrbitThreadStart(id),
    messageId: start.messageId,
    threadRef: scopeThreadRef(
      EnvironmentId.make(start.environmentId!),
      ThreadId.make(start.threadId),
    ),
  };
}
