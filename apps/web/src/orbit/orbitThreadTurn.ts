import type { OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import { MessageId, type ModelSelection, type ProjectId, ThreadId } from "@t3tools/contracts";

/**
 * Conn: the turn that starts a thread in a clone with its first message. It creates the thread in
 * the clone's workspace project and queues the message, so it never steers a turn that a task
 * already runs there (Orbit's docs/cli/instance/container/thread.mmd).
 */
export function orbitFirstTurnInput(input: {
  readonly start: OrbitThreadStart;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}) {
  const title = deriveThreadTitleSeed({ text: input.start.message, attachments: [] });
  return {
    threadId: ThreadId.make(input.start.threadId),
    message: {
      messageId: MessageId.make(input.start.messageId),
      role: "user" as const,
      text: input.start.message,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: title,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    dispatchMode: "queue" as const,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title,
        modelSelection: input.modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}
