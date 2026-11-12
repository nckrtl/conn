import type { OrbitGatewayOperation } from "./client.ts";
import type { OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: the setup stages of a thread started in an Orbit Project, for the setup card shown before
 * the clone's server exists.
 */
export type OrbitSetupStageId = "create" | "connect" | "agent";
export type OrbitSetupStageStatus = "pending" | "running" | "done" | "failed";

export interface OrbitSetupStage {
  readonly id: OrbitSetupStageId;
  readonly status: OrbitSetupStageStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** "create": the Node the clone lands on. */
  readonly detail: string | null;
  /** "create": the clone step that runs, or where it failed; none for a step Conn does not know. */
  readonly subDetail: string | null;
  /** Set on the failed stage only. */
  readonly error: string | null;
  readonly errorCode: string | null;
}

const CLONE_STEP_LABELS: Readonly<Record<string, string>> = {
  "clone-container": "Copying the container",
  "clone-workspace": "Copying the workspace",
  "clone-t3": "Starting the T3 server",
  "clone-register": "Registering with Orbit",
};

function cloneStepLabel(step: string | null | undefined): string | null {
  return step && Object.hasOwn(CLONE_STEP_LABELS, step) ? CLONE_STEP_LABELS[step]! : null;
}

function createSubDetail(
  operation: OrbitGatewayOperation | null,
  status: OrbitSetupStageStatus,
): string | null {
  if (operation === null) return null;
  const steps = operation.steps ?? [];
  if (status === "running") {
    return cloneStepLabel(
      operation.currentStep ?? steps.findLast((step) => step.status === "running")?.name,
    );
  }
  if (status === "failed") {
    return cloneStepLabel(
      operation.failedStep ?? steps.find((step) => step.status === "failed")?.name,
    );
  }
  return null;
}

/**
 * The stages of a start: Create Instance, Connect, Start agent; a start in an existing Instance
 * has only Connect and Start agent. The pairing state comes from the start record. `create` is the
 * latest read of the create Operation, when there is one; it gives the clone step.
 */
export function orbitSetupStages(input: {
  readonly start: OrbitThreadStart;
  readonly create?: OrbitGatewayOperation | null;
}): OrbitSetupStage[] {
  const { start } = input;
  const create = input.create ?? null;
  // Only the saved start fails a stage: a Retry clears its error while an old read still shows
  // the failed Operation.
  const failedAt: OrbitSetupStageId | null =
    start.error === null
      ? null
      : start.environmentId === null
        ? "create"
        : start.connected
          ? "agent"
          : "connect";
  const errorCode = start.errorCode ?? create?.errorCode ?? create?.error?.code ?? null;
  const stage = (
    id: OrbitSetupStageId,
    status: OrbitSetupStageStatus,
    startedAt: number | null | undefined,
    finishedAt: number | null | undefined,
    detail: string | null = null,
    subDetail: string | null = null,
  ): OrbitSetupStage => ({
    id,
    status: failedAt === id ? "failed" : status,
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    detail,
    subDetail,
    error: failedAt === id ? start.error : null,
    errorCode: failedAt === id ? errorCode : null,
  });

  const stages: OrbitSetupStage[] = [];
  if (start.orbitInstanceKind !== "existing") {
    const status: OrbitSetupStageStatus =
      failedAt === "create"
        ? "failed"
        : start.environmentId !== null || create?.status === "succeeded"
          ? "done"
          : start.createStartedAt != null || start.createOperationId !== null || create !== null
            ? "running"
            : "pending";
    stages.push(
      stage(
        "create",
        status,
        start.createStartedAt,
        start.createFinishedAt,
        start.nodeName,
        createSubDetail(create, status),
      ),
    );
  }
  stages.push(
    stage(
      "connect",
      start.connected
        ? "done"
        : // Runs once the runner stamped it: after a Retry it waits until the runner gets there.
          start.environmentId !== null && start.connectStartedAt != null
          ? "running"
          : "pending",
      start.connectStartedAt,
      start.connectFinishedAt,
    ),
    stage(
      "agent",
      start.sentAt != null ? "done" : start.connected ? "running" : "pending",
      start.agentStartedAt,
      start.sentAt,
    ),
  );
  return stages;
}

/**
 * How long the setup took, for "Instance ready <N>s": the create, then Connect to the sent first
 * message. Time a failed start waited for Retry between them does not count. Null until the
 * message is sent or when a time is missing (older rows).
 */
export function orbitSetupReadyMs(start: OrbitThreadStart): number | null {
  if (start.sentAt == null || start.connectStartedAt == null) return null;
  const connectToSent = Math.max(0, start.sentAt - start.connectStartedAt);
  if (start.orbitInstanceKind === "existing") return connectToSent;
  if (start.createStartedAt == null || start.createFinishedAt == null) return null;
  return Math.max(0, start.createFinishedAt - start.createStartedAt) + connectToSent;
}
