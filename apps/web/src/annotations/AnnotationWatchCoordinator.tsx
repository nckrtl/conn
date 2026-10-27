import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { useEffect, useEffectEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { waitingIdsToSend } from "./annotationQueue";
import { useAnnotationWatch, useAnnotationWatchStore } from "./annotationWatchStore";
import { sendAnnotationPrompt } from "./sendAnnotationPrompt";
import { useAnnotationQueue } from "./useAnnotationQueue";

/**
 * Watch mode: prompts each watched thread when it is idle and annotations it has not
 * been told about are waiting. Mounted once, in the main window. The server queues the
 * message, so idle only has to mean "nothing is running, queued or waiting on the user".
 */
export function AnnotationWatchCoordinator() {
  const threadKeys = useAnnotationWatchStore(
    useShallow((state) => Object.keys(state.watchingByThreadKey)),
  );
  return threadKeys.map((threadKey) => (
    <ThreadAnnotationWatch key={threadKey} threadKey={threadKey} />
  ));
}

function ThreadAnnotationWatch({ threadKey }: { threadKey: string }) {
  const threadRef = parseScopedThreadKey(threadKey);
  const watch = useAnnotationWatch(threadKey);
  const lastSentIds = useAnnotationWatchStore(
    (state) => state.lastSentIdsByThreadKey[threadKey] ?? EMPTY_IDS,
  );
  const { annotations } = useAnnotationQueue(watch);
  const threadIdle = useThreadIdle(threadKey);

  const toSend = waitingIdsToSend({
    watching: watch !== null,
    threadIdle,
    annotations: annotations ?? [],
    lastSentIds,
  });
  const sendKey = toSend.join(",");
  const send = useEffectEvent(() => {
    if (threadRef === null || annotations === null) return;
    sendAnnotationPrompt({ threadRef, annotations });
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Watch prompts the thread when the queue or the thread's state changes, not on a user action.
  useEffect(() => {
    if (sendKey !== "") send();
  }, [sendKey]);
  return null;
}

const EMPTY_IDS: string[] = [];

/** The thread is connected and has no run, queued message or pending request. */
function useThreadIdle(threadKey: string): boolean {
  const threadRef = parseScopedThreadKey(threadKey);
  const shell = useThreadShell(threadRef);
  const environment = useEnvironment(threadRef?.environmentId ?? null);
  if (threadRef === null || shell === null) return false;
  if (environment !== null && environment.connection.phase !== "connected") return false;
  if (threadRuntimeIsActive(shell.runtime)) return false;
  return !shell.hasPendingApprovals && !shell.hasPendingUserInput;
}
