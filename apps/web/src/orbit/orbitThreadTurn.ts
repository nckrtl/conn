import type { OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Conn: the launch that starts a thread in a clone with its first message, in the clone's
 * workspace project (Orbit's docs/cli/instance/container/thread.mmd). It reuses the start's
 * command id, so a repeated launch finishes the first one on the server instead of failing on the
 * thread it created.
 */
export function orbitFirstTurnInput(input: {
  readonly start: OrbitThreadStart;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}) {
  const title = deriveThreadTitleSeed({ text: input.start.message, attachments: [] });
  return {
    commandId: CommandId.make(input.start.commandId),
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

export interface OrbitFirstMessagePorts {
  /** The clone's workspace project and its server's model, or null when they did not load in time. */
  readonly waitForClone: (environmentId: string) => Promise<{
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection | null;
  } | null>;
  /** Runs the launch; resolves the failure when the server did not take it. */
  readonly startTurn: (
    environmentId: string,
    input: ReturnType<typeof orbitFirstTurnInput>,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }>;
  readonly now: () => string;
  /** True once the start was dismissed; no launch goes out then. */
  readonly stopped: () => boolean;
}

/** Sends the first message; resolves its clone project. Only a launch the server took counts. */
export async function sendOrbitFirstMessage(
  start: OrbitThreadStart & { readonly environmentId: string },
  ports: OrbitFirstMessagePorts,
): Promise<ProjectId> {
  const clone = await ports.waitForClone(start.environmentId);
  if (clone === null) throw new Error("The clone's T3 project /srv/workspace did not appear.");
  if (clone.modelSelection === null) throw new Error("The clone's T3 server offers no model.");
  if (ports.stopped()) throw new Error("The thread start was stopped.");
  const result = await ports.startTurn(
    start.environmentId,
    orbitFirstTurnInput({
      start,
      projectId: clone.projectId,
      modelSelection: clone.modelSelection,
      createdAt: ports.now(),
    }),
  );
  if (!result.ok) {
    const error = result.error;
    throw new Error(
      `The clone did not take the first message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return clone.projectId;
}
