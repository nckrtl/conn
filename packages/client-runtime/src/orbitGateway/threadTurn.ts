import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { deriveThreadTitleSeed } from "../operations/threadTitle.ts";
import type { OrbitModelFallback, OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: the launch that starts a thread in a clone with its first message, in the clone's
 * workspace project (Orbit's docs/cli/instance/container/thread.mmd). It reuses the start's
 * command id, so a repeated launch finishes the first one on the server instead of failing on the
 * thread it created. The model and modes the start carries win over the clone's defaults.
 */
export function orbitFirstTurnInput(input: {
  readonly start: OrbitThreadStart;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
}) {
  const title = deriveThreadTitleSeed({ text: input.start.message, attachments: [] });
  const modelSelection = input.start.modelSelection ?? input.modelSelection;
  const runtimeMode = input.start.runtimeMode ?? "full-access";
  const interactionMode = input.start.interactionMode ?? "default";
  return {
    commandId: CommandId.make(input.start.commandId),
    threadId: ThreadId.make(input.start.threadId),
    message: {
      messageId: MessageId.make(input.start.messageId),
      role: "user" as const,
      text: input.start.message,
      attachments: [],
    },
    modelSelection,
    titleSeed: title,
    runtimeMode,
    interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}

export interface OrbitFirstMessagePorts {
  /**
   * The clone's workspace project and its server's model, or null when they did not load within
   * `timeoutMs`.
   */
  readonly waitForClone: (
    environmentId: string,
    timeoutMs: number,
  ) => Promise<{
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection | null;
    /** Whether the clone's server offers a model's provider; without it every model counts. */
    readonly offers?: (selection: ModelSelection) => boolean;
  } | null>;
  /**
   * Queues the launch to go out by `deadline` (epoch ms); resolves the failure when the server did
   * not take it. Still queued at the deadline, it is dropped unsent; running, it is cancelled, so
   * it holds the thread's queue no longer. Either way it is `unanswered`.
   */
  readonly startTurn: (
    environmentId: string,
    input: ReturnType<typeof orbitFirstTurnInput>,
    deadline: number,
  ) => Promise<OrbitFirstMessageAttempt>;
  readonly now: () => string;
  /** True once the start was dismissed; no launch goes out then. */
  readonly stopped: () => boolean;
  /** The clone lacks the start's provider: the first turn uses the clone's default instead. */
  readonly onModelFallback?: (fallback: OrbitModelFallback) => void;
  /** The clone server's connection now: whether a session is up, and which one. */
  readonly connection?: (environmentId: string) => OrbitCloneConnection;
  /**
   * Resolves true once a session of at least `minGeneration` is up, or false after `timeoutMs`.
   */
  readonly waitForConnection?: (
    environmentId: string,
    minGeneration: number,
    timeoutMs: number,
  ) => Promise<boolean>;
  /** Epoch milliseconds; tests replace it. */
  readonly clock?: () => number;
}

export type OrbitFirstMessageAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly unanswered?: true };

export interface OrbitCloneConnection {
  readonly connected: boolean;
  readonly generation: number;
}

/**
 * A clone reloads its server when its reservation is finalized, and the first message can meet
 * that reload. The same command id makes a resend finish the first launch, never start a second.
 */
export const FIRST_MESSAGE_ATTEMPT_MS = 20_000;
/** From the finalize: the clone's project and server settings, then the send, all within this. */
export const FIRST_MESSAGE_PHASE_MS = 120_000;

const FIRST_MESSAGE_TIMED_OUT =
  "The clone's server did not confirm the first message in time. It may still have arrived: open the thread, or press Retry, which cannot send it twice.";

/** The send never reached a server that answered: its session was gone or went down under it. */
function isConnectionLoss(error: unknown): boolean {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
  return tag === "EnvironmentRpcUnavailableError" || tag === "RpcClientError";
}

/** Sends the first message; resolves its clone project. Only a launch the server took counts. */
export async function sendOrbitFirstMessage(
  start: OrbitThreadStart & { readonly environmentId: string },
  ports: OrbitFirstMessagePorts,
): Promise<ProjectId> {
  const clock = ports.clock ?? Date.now;
  const deadline = clock() + FIRST_MESSAGE_PHASE_MS;
  const clone = await ports.waitForClone(start.environmentId, FIRST_MESSAGE_PHASE_MS);
  if (clone === null) throw new Error("The clone's Conn project /srv/workspace did not appear.");
  const requested = start.modelSelection ?? null;
  const fallBack = requested !== null && clone.offers !== undefined && !clone.offers(requested);
  const modelSelection = fallBack ? clone.modelSelection : (requested ?? clone.modelSelection);
  if (modelSelection === null) throw new Error("The clone's Conn Server offers no model.");
  if (fallBack) {
    ports.onModelFallback?.({ requestedModel: requested.model, usedModel: modelSelection.model });
  }
  if (ports.stopped()) throw new Error("The thread start was stopped.");
  let before = ports.connection?.(start.environmentId);
  const input = orbitFirstTurnInput({
    start: fallBack ? { ...start, modelSelection } : start,
    projectId: clone.projectId,
    modelSelection,
    createdAt: ports.now(),
  });
  // Each attempt's deadline is fixed when it is queued, so time spent behind another command of
  // the thread counts; at the phase deadline no attempt is left queued or running.
  const attempt = () =>
    ports.startTurn(
      start.environmentId,
      input,
      Math.min(clock() + FIRST_MESSAGE_ATTEMPT_MS, deadline),
    );
  if (clock() >= deadline) throw new Error(FIRST_MESSAGE_TIMED_OUT);
  let result = await attempt();
  // Each attempt ends within its limit and is cancelled then, so none is left queued at the end.
  while (!result.ok && clock() < deadline) {
    const minGeneration = resendAfter(start.environmentId, ports, before, result);
    if (minGeneration === null) break;
    const back = await ports.waitForConnection!(
      start.environmentId,
      minGeneration,
      Math.max(deadline - clock(), 0),
    );
    if (!back || clock() >= deadline) break;
    if (ports.stopped()) throw new Error("The thread start was stopped.");
    before = ports.connection?.(start.environmentId);
    result = await attempt();
  }
  if (!result.ok) {
    // A send cut off at its deadline may still have reached the server: say only what is known.
    if (result.unanswered === true) throw new Error(FIRST_MESSAGE_TIMED_OUT);
    const error = result.error;
    throw new Error(
      `The clone did not take the first message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return clone.projectId;
}

/**
 * The session generation a failed send may go again on, or null when it may not. A send lost with
 * the session it used waits for a newer one: that one can still read as connected while it is torn
 * down. A send made with no session up, or one that was not answered, takes any session. A failure
 * on a steady session is the server's answer.
 */
function resendAfter(
  environmentId: string,
  ports: OrbitFirstMessagePorts,
  before: OrbitCloneConnection | undefined,
  failed: Extract<OrbitFirstMessageAttempt, { ok: false }>,
): number | null {
  if (before === undefined || ports.connection === undefined || !ports.waitForConnection) {
    return null;
  }
  const after = ports.connection(environmentId);
  const lost =
    isConnectionLoss(failed.error) || !after.connected || after.generation !== before.generation;
  if (!before.connected || failed.unanswered === true) return 0;
  return lost ? before.generation + 1 : null;
}
