import type { OrbitGatewayOperation } from "./client.ts";
import {
  ORBIT_CREATE_ROW_IDS,
  ORBIT_CREATE_ROW_LABELS,
  type OrbitCreateRowId,
  type OrbitCreateRowStatus,
} from "./orbitCreateRows.ts";
import { orbitCompletionPhase } from "./orbitCompletion.ts";
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
  /** "create": the rows of Orbit's create steps while it runs or where it failed; else null. */
  readonly rows: readonly OrbitSetupCreateRow[] | null;
  /** Set on the failed stage only. */
  readonly error: string | null;
  readonly errorCode: string | null;
}

export interface OrbitSetupCreateRow {
  readonly id: OrbitCreateRowId;
  readonly label: string;
  readonly status: OrbitCreateRowStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * The rows under "Create Instance" while it runs, or where it failed, and after it while its
 * completion runs or failed. They fold away once the stage is done and nothing follows it; a
 * create refused before Orbit admitted it has none.
 */
function createRows(
  start: OrbitThreadStart,
  status: OrbitSetupStageStatus,
): OrbitSetupCreateRow[] | null {
  const saved = start.createRows ?? null;
  const any = saved !== null && ORBIT_CREATE_ROW_IDS.some((id) => saved[id] !== undefined);
  const completion = orbitCompletionPhase(start);
  const completionShows =
    status === "done" && any && completion !== "none" && completion !== "succeeded";
  if (status !== "running" && !(status === "failed" && any) && !completionShows) return null;
  const failedHere =
    status === "failed" && !ORBIT_CREATE_ROW_IDS.some((id) => saved?.[id]?.status === "failed");
  // A failure the Operation never named (a timeout, a lost Gateway) stops the row that ran.
  const stopped = failedHere
    ? ORBIT_CREATE_ROW_IDS.findLast((id) => saved?.[id]?.status === "running")
    : undefined;
  return ORBIT_CREATE_ROW_IDS.map((id) => {
    const row = saved?.[id];
    return {
      id,
      label: ORBIT_CREATE_ROW_LABELS[id],
      status: id === stopped ? "failed" : (row?.status ?? "pending"),
      startedAt: row?.startedAt ?? null,
      finishedAt: id === stopped ? (start.createFinishedAt ?? null) : (row?.finishedAt ?? null),
    };
  });
}

/**
 * The stages of a start: Create Instance, Connect, Start agent; a start in an existing Instance
 * has only Connect and Start agent. The pairing state comes from the start record. `create` is the
 * latest read of the create Operation, when there is one.
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
    rows: readonly OrbitSetupCreateRow[] | null = null,
  ): OrbitSetupStage => ({
    id,
    status: failedAt === id ? "failed" : status,
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    detail,
    rows,
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
        createRows(start, status),
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
 * How long the setup took, for "Instance ready <N>s": the sum of the stages, so time a failed
 * start waited for Retry does not count. Null until the message is sent or when a time is
 * missing (older rows).
 */
export function orbitSetupReadyMs(start: OrbitThreadStart): number | null {
  const span = (from: number | null | undefined, to: number | null | undefined) =>
    from == null || to == null ? null : Math.max(0, to - from);
  const connect = span(start.connectStartedAt, start.connectFinishedAt);
  const agent = span(start.agentStartedAt, start.sentAt);
  if (connect === null || agent === null) return null;
  if (start.orbitInstanceKind === "existing") return connect + agent;
  const create = span(start.createStartedAt, start.createFinishedAt);
  return create === null ? null : create + connect + agent;
}
