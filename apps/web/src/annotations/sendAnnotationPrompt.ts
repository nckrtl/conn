import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { newMessageId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { type AnnotatorRecord, annotationState, buildAnnotationPrompt } from "./annotatorQueue";
import { useAnnotationWatchStore } from "./annotationWatchStore";

/**
 * Sends the annotation prompt as a normal user message with the thread's own model and
 * modes. The message is dispatched as "queue", so the server holds it behind a running
 * turn and starts it as soon as the thread can take it. The annotations count as sent at
 * once; a failed dispatch restores the previous list so a retry can send them again.
 * Returns false when there is nothing to send, the thread is unknown or the connection
 * may not operate threads.
 */
export function sendAnnotationPrompt(input: {
  readonly threadRef: ScopedThreadRef;
  readonly annotationsUrl: string;
  readonly annotations: ReadonlyArray<AnnotatorRecord>;
}): boolean {
  const waiting = input.annotations.filter(
    (annotation) => annotationState(annotation) === "waiting",
  );
  const shell = readThreadShell(input.threadRef);
  if (waiting.length === 0 || shell === null) return false;
  if (!readEnvironmentScope(input.threadRef.environmentId, AuthOrchestrationOperateScope)) {
    return false;
  }
  const threadKey = scopedThreadKey(input.threadRef);
  const store = useAnnotationWatchStore.getState();
  const previousIds = store.lastSentIdsByThreadKey[threadKey] ?? [];
  store.markSent(
    threadKey,
    waiting.map((annotation) => annotation.id),
  );
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId: input.threadRef.environmentId,
      input: {
        threadId: input.threadRef.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildAnnotationPrompt(input),
          attachments: [],
        },
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "queue",
      },
    },
    { reportFailure: false },
  ).then((result) => {
    if (result._tag === "Success") return;
    useAnnotationWatchStore.getState().markSent(threadKey, previousIds);
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not send annotations",
      description: error instanceof Error ? error.message : "The thread did not accept them.",
    });
  });
  return true;
}
