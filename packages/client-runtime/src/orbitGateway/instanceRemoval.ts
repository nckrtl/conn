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
 * Conn: removing an Orbit Instance (handle A, `POST /conn/instances/{id}/destroy`).
 * Orbit checks every refusal before any effect. Conn reads only `instance.unsaved_work`; every
 * other code is a failure shown with Orbit's own message.
 */

const ORBIT_INSTANCE_UNSAVED_WORK = "instance.unsaved_work";
const DESTROY_OPERATION_KIND = "instance.destroy";
/**
 * After this long Conn reads the Operation at the slowest rate. It never calls a running destroy
 * failed: a batch on one Node queues for minutes, and only Orbit knows when it ends.
 */
export const DESTROY_TIMEOUT_MS = 10 * 60_000;
const SLOW_POLL_SECONDS = 15;
/** A lost answer to the destroy request repeats under the same key for this long. */
const ADMISSION_RETRY_MS = 60_000;

const DESTROY_FAILED_TEXT = "Orbit did not finish removing the Instance.";
/** A saved removal whose Operation Orbit no longer shows, while the Instance is still listed. */
export const ORBIT_REMOVAL_LOST_TEXT = "Conn lost track of this removal.";

export type OrbitInstanceRemoveOutcome =
  /** Removed, or already gone (any 404; Orbit answers `http.404` for a missing Instance). */
  | { readonly kind: "removed" }
  /**
   * Orbit refused without the tick: unsaved work, or a Git state it cannot tell (always so in the
   * first release: `state: "unknown"`, null counts). Nothing changed.
   */
  | { readonly kind: "unsaved_work"; readonly git: OrbitInstanceGitState }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  /** Following a saved Operation: Orbit answers 404 for it, so its end is unknown. */
  | { readonly kind: "lost" }
  /** The caller stopped following (`stopped()`); the Operation may still run. */
  | { readonly kind: "stopped" };

/** What the row shows while Orbit works on an admitted destroy. */
export type OrbitInstanceRemoveProgress =
  /** Admitted; `operationId` is saved so a restart can follow it again. */
  | { readonly kind: "admitted"; readonly operationId: number }
  /** Queued behind other work on the Node (another removal, mostly). */
  | { readonly kind: "waiting" }
  /** Running; `step` is a plain text of Orbit's step, or null when it has none. */
  | { readonly kind: "running"; readonly step: string | null };

/**
 * Plain words for the steps of today's `instance.destroy` (Orbit 2026-11-13). Step names may carry
 * a `-<n>-<n>` suffix per Process; unknown steps show no step text.
 */
const DESTROY_STEP_TEXT: ReadonlyArray<readonly [readonly string[], string]> = [
  [["Prepare container removal"], "Preparing"],
  [
    ["Write the git credential", "Check work is pushed", "Remove the git credential"],
    "Checking for unpushed work",
  ],
  [["Withdraw the Route"], "Taking the address offline"],
  [
    [
      "Stop, remove Processes",
      "Disable and stop the unit",
      "Stop the unit",
      "Remove the unit",
      "Reload systemd",
    ],
    "Stopping its processes",
  ],
  [
    [
      "Remove the container",
      "Delete the container",
      "Check container removal",
      "Read container removal",
      "Clean container files",
    ],
    "Removing the container",
  ],
  [
    ["Remove hibernation files", "Remove the source", "Remove the dev environment"],
    "Removing its files",
  ],
  [["Verify it is gone", "Check it is gone"], "Checking it is gone"],
];

export function orbitInstanceRemoveStepText(step: string | null | undefined): string | null {
  if (step === null || step === undefined) return null;
  const name = step.replace(/(-\d+)+$/, "").trim();
  if (name.startsWith("withdraw_")) return "Taking the address offline";
  return DESTROY_STEP_TEXT.find(([names]) => names.includes(name))?.[1] ?? null;
}

/** A destroy Operation still at work, as the row shows it. */
export function orbitInstanceRemoveProgress(
  operation: OrbitGatewayOperation,
): Exclude<OrbitInstanceRemoveProgress, { kind: "admitted" }> {
  if (operation.status === "queued" || operation.status === "waiting" || operation.capacityWait) {
    return { kind: "waiting" };
  }
  return { kind: "running", step: orbitInstanceRemoveStepText(operation.currentStep) };
}

/** The outcome of an ended destroy Operation, or null while it still runs. */
export function orbitInstanceRemoveOutcomeOf(
  operation: OrbitGatewayOperation,
): Extract<OrbitInstanceRemoveOutcome, { kind: "removed" | "failed" }> | null {
  if (operation.status === "succeeded") return { kind: "removed" };
  // `interrupted` ends it too; `error.detail` may be null. A failed start (Nick's case on
  // 2026-11-13, `swamp.start_unavailable`) has a detail and no message.
  if (OPERATION_TERMINAL_STATUSES.has(operation.status)) {
    return {
      kind: "failed",
      code: operation.error?.code ?? operation.errorCode ?? `operation.${operation.status}`,
      message: operation.error?.message ?? operation.error?.detail ?? DESTROY_FAILED_TEXT,
    };
  }
  return null;
}

/** One key per remove attempt: Retry and a ticked second try are new attempts. */
export function orbitInstanceRemoveKey(instanceId: number, attemptAt: number): string {
  return `conn-instance-destroy:${instanceId}:${attemptAt}`;
}

const isGatewayError = Schema.is(OrbitGatewayError);
const isLostAnswer = (error: unknown) =>
  isGatewayError(error) && error.code === "gateway.unreachable";
/**
 * After admission only these end a follow: a 404 (Orbit no longer shows the Operation) and an
 * answer Conn cannot read. A 401 (expired session), a 429 or a 5xx passes; Orbit keeps removing.
 */
const endsFollow = (error: unknown) =>
  !isGatewayError(error) || error.code === "gateway.response_invalid";

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

export interface OrbitInstanceRemoveFollow {
  readonly onProgress?: (progress: OrbitInstanceRemoveProgress) => void;
  /** Checked before each read; true ends the follow with `stopped`. */
  readonly stopped?: () => boolean;
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
  } & OrbitInstanceRemoveFollow,
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
  input.onProgress?.({ kind: "admitted", operationId: operation.id });
  return followDestroy(ports, operation, input);
}

/**
 * Follows a destroy Operation that this device saved (after a restart, or when the panel opens).
 * A 404 on the Operation is `lost`: the caller decides from the list whether the Instance went.
 */
export async function followOrbitInstanceRemoval(
  ports: OrbitInstanceRemovePorts,
  input: { readonly operationId: number } & OrbitInstanceRemoveFollow,
): Promise<OrbitInstanceRemoveOutcome> {
  for (;;) {
    if (input.stopped?.()) return { kind: "stopped" };
    try {
      const operation = await ports.client.operation(input.operationId);
      if (operation.kind !== DESTROY_OPERATION_KIND) return { kind: "lost" };
      return await followDestroy(ports, operation, input);
    } catch (error) {
      if (isGatewayError(error) && error.status === 404) return { kind: "lost" };
      if (endsFollow(error)) return failed(error);
      await ports.sleep(operationPollDelayMs(SLOW_POLL_SECONDS));
    }
  }
}

async function followDestroy(
  ports: OrbitInstanceRemovePorts,
  first: OrbitGatewayOperation,
  follow: OrbitInstanceRemoveFollow,
): Promise<OrbitInstanceRemoveOutcome> {
  const slowAfter = ports.now() + DESTROY_TIMEOUT_MS;
  let operation = first;
  for (;;) {
    const outcome = orbitInstanceRemoveOutcomeOf(operation);
    if (outcome !== null) return outcome;
    follow.onProgress?.(orbitInstanceRemoveProgress(operation));
    await ports.sleep(
      operationPollDelayMs(
        ports.now() >= slowAfter ? SLOW_POLL_SECONDS : operation.pollAfterSeconds,
      ),
    );
    if (follow.stopped?.()) return { kind: "stopped" };
    try {
      operation = await ports.client.operation(operation.id);
    } catch (error) {
      // A Gateway outage or an expired session does not end the destroy.
      if (isGatewayError(error) && error.status === 404) return { kind: "lost" };
      if (endsFollow(error)) return failed(error);
      operation = { ...operation, pollAfterSeconds: SLOW_POLL_SECONDS };
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
  const parts = orbitInstanceGitParts(git);
  if (git !== undefined && git.state !== "known") {
    return {
      ...base,
      warning: {
        kind: "unknown",
        text: "Orbit cannot tell whether this Instance holds work that is not on the remote.",
      },
      acknowledge: "Remove it anyway. Any unsaved work is lost.",
    };
  }
  const items = [...parts];
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
