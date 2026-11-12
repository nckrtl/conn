import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { OrbitReadyTimelineInput } from "../components/chat/MessagesTimeline.logic";
import { useOrbitInstance } from "./environmentProvider";
import { orbitReadyView } from "./orbitSetupView";
import { useSentOrbitThreadStart } from "./orbitThreadStartStore";

/** Conn: the "Instance ready" row of a thread a pending Orbit start handed over to. */
export function useOrbitReady(
  environmentId: string | null,
  threadId: string | null,
): OrbitReadyTimelineInput | null {
  const sent = useSentOrbitThreadStart(threadId);
  const start = sent !== null && sent.environmentId === environmentId ? sent : null;
  const url =
    useOrbitInstance(start === null ? null : EnvironmentId.make(start.environmentId!))?.url ?? null;
  if (start === null) return null;
  return {
    view: orbitReadyView(start, url),
    messageId: start.messageId,
    threadRef: scopeThreadRef(
      EnvironmentId.make(start.environmentId!),
      ThreadId.make(start.threadId),
    ),
  };
}
