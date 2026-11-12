import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OrbitGatewayError,
  operationPollDelayMs,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
} from "./client.ts";
import {
  orbitInstanceGitFromUnsavedWork,
  orbitInstanceGitParts,
  orbitInstanceRemoveNeedsAck,
  type OrbitInstanceGitState,
} from "./instanceGit.ts";

/**
 * Conn: removing an Orbit Instance (handle A, `POST /conn/instances/{id}/destroy`, not live yet).
 * Orbit checks every refusal before any effect. Conn reads only `instance.unsaved_work`; every
 * other code is a failure shown with Orbit's own message.
 */

const ORBIT_INSTANCE_UNSAVED_WORK = "instance.unsaved_work";
const DESTROY_OPERATION_KIND = "instance.destroy";
/** How long Conn follows a destroy before it shows the row as failed. */
export const DESTROY_TIMEOUT_MS = 10 * 60_000;
/** A lost answer to the destroy request repeats under the same key for this long. */
const ADMISSION_RETRY_MS = 60_000;

const DESTROY_FAILED_TEXT = "Orbit did not finish removing the Instance.";

export type OrbitInstanceRemoveOutcome =
  /** Removed, or already gone (any 404; Orbit answers `http.404` for a missing Instance). */
  | { readonly kind: "removed" }
  /**
   * Orbit refused without the tick: unsaved work, or a Git state it cannot tell (always so in the
   * first release: `state: "unknown"`, null counts). Nothing changed.
   */
  | { readonly kind: "unsaved_work"; readonly git: OrbitInstanceGitState }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/** One key per remove attempt: Retry and a ticked second try are new attempts. */
export function orbitInstanceRemoveKey(instanceId: number, attemptAt: number): string {
  return `conn-instance-destroy:${instanceId}:${attemptAt}`;
}

const isGatewayError = Schema.is(OrbitGatewayError);
const isLostAnswer = (error: unknown) =>
  isGatewayError(error) && error.code === "gateway.unreachable";

function failed(error: unknown): OrbitInstanceRemoveOutcome {
  return isGatewayError(error)
    ? { kind: "failed", code: error.code, message: error.message }
    : {
        kind: "failed",
        code: "gateway.request_failed",
        message: error instanceof Error ? error.message : String(error),
      };
}

export interface OrbitInstanceRemovePorts {
  readonly client: Pick<OrbitGatewayClient, "destroyInstance" | "operation">;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/**
 * Asks Orbit to destroy the Instance and follows the Operation to its end. Never throws: every
 * result is an outcome the row or the dialog shows.
 */
export async function removeOrbitInstance(
  ports: OrbitInstanceRemovePorts,
  input: {
    readonly instanceId: number;
    readonly acknowledgeUnsaved: boolean;
    readonly idempotencyKey: string;
    /** The list's Git state, kept where Orbit's refusal leaves a count out. */
    readonly git?: OrbitInstanceGitState;
  },
): Promise<OrbitInstanceRemoveOutcome> {
  const start = ports.now();
  let operation: OrbitGatewayOperation;
  for (let attempt = 0; ; attempt++) {
    try {
      operation = await ports.client.destroyInstance(
        input.instanceId,
        input.acknowledgeUnsaved,
        input.idempotencyKey,
      );
      break;
    } catch (error) {
      if (isGatewayError(error) && error.status === 404) {
        return { kind: "removed" };
      }
      if (isGatewayError(error) && error.code === ORBIT_INSTANCE_UNSAVED_WORK) {
        return {
          kind: "unsaved_work",
          git: orbitInstanceGitFromUnsavedWork(error.details, input.git),
        };
      }
      // The same key returns the Operation Orbit may have admitted before the answer was lost.
      if (!isLostAnswer(error) || ports.now() - start >= ADMISSION_RETRY_MS) return failed(error);
      await ports.sleep(operationPollDelayMs(2 ** attempt));
    }
  }
  if (operation.kind !== DESTROY_OPERATION_KIND) {
    return {
      kind: "failed",
      code: "gateway.response_invalid",
      message: `The Orbit Gateway answered with a ${operation.kind} Operation.`,
    };
  }

  const deadline = ports.now() + DESTROY_TIMEOUT_MS;
  for (;;) {
    if (operation.status === "succeeded") return { kind: "removed" };
    // `interrupted` ends it too; `error.detail` may be null, so only the message is read.
    if (OPERATION_TERMINAL_STATUSES.has(operation.status)) {
      return {
        kind: "failed",
        code: operation.error?.code ?? operation.errorCode ?? `operation.${operation.status}`,
        message: operation.error?.message ?? DESTROY_FAILED_TEXT,
      };
    }
    if (ports.now() >= deadline) {
      return { kind: "failed", code: "operation.timeout", message: DESTROY_FAILED_TEXT };
    }
    await ports.sleep(
      Math.max(
        Math.min(operationPollDelayMs(operation.pollAfterSeconds), deadline - ports.now()),
        0,
      ),
    );
    try {
      operation = await ports.client.operation(operation.id);
    } catch (error) {
      // A short Gateway outage does not end the destroy; the deadline does.
      if (!isLostAnswer(error)) return failed(error);
    }
  }
}

export interface OrbitInstanceRemoveTarget {
  readonly name: string;
  readonly domain: string | null;
  readonly nodeName: string | null;
  readonly threadCount: number;
  readonly workingCount: number;
  readonly git: OrbitInstanceGitState | undefined;
}

export interface OrbitInstanceRemoveText {
  readonly title: string;
  /** The body around the bold target: `${before}<b>${target}</b>${after}`. */
  readonly before: string;
  readonly target: string;
  readonly after: string;
  readonly warning:
    | { readonly kind: "unknown"; readonly text: string }
    | { readonly kind: "lost"; readonly heading: string; readonly items: readonly string[] }
    | null;
  /** The extra tick, or null when one confirmation is enough. */
  readonly acknowledge: string | null;
}

/** The remove dialog's words, as in the approved demo (DESIGN.md, "Orbit panel"). */
export function orbitInstanceRemoveText(
  target: OrbitInstanceRemoveTarget,
): OrbitInstanceRemoveText {
  const { git, workingCount, threadCount } = target;
  const threads =
    threadCount === 0
      ? "It has no threads."
      : threadCount === 1
        ? "The thread in it is removed from Conn."
        : `The ${threadCount} threads in it are removed from Conn.`;
  const node = target.nodeName === null ? "" : ` on ${target.nodeName}`;
  const base = {
    title: `Remove ${target.name}?`,
    before: "Orbit removes the Instance ",
    target: target.domain ?? target.name,
    after: `${node} and its container. ${threads} You cannot undo this.`,
  };
  if (!orbitInstanceRemoveNeedsAck({ git, workingCount })) {
    return { ...base, warning: null, acknowledge: null };
  }
  if (git?.state !== "known") {
    return {
      ...base,
      warning: {
        kind: "unknown",
        text: "Orbit cannot tell whether this Instance holds work that is not on the remote.",
      },
      acknowledge: "Remove it anyway. Any unsaved work is lost.",
    };
  }
  const parts = orbitInstanceGitParts(git);
  const items = parts.map((part) =>
    part.endsWith("not pushed") && git.branch !== null ? `${part} on branch ${git.branch}` : part,
  );
  if (workingCount === 1) items.push("1 thread is working now. It stops.");
  else if (workingCount > 1) items.push(`${workingCount} threads are working now. They stop.`);
  return {
    ...base,
    warning: {
      kind: "lost",
      heading:
        parts.length > 0
          ? "This Instance holds work that is not on the remote:"
          : "This Instance is in use:",
      items,
    },
    acknowledge:
      parts.length > 0
        ? "Remove it anyway. This work is lost."
        : workingCount === 1
          ? "Remove it anyway. The thread stops."
          : "Remove it anyway. The threads stop.",
  };
}
