import {
  OPERATION_TERMINAL_STATUSES,
  type OrbitGatewayOperation,
  type OrbitGatewayOperationStep,
} from "./client.ts";

/**
 * Conn: the five rows under "Create Instance" while Orbit creates a clone. Each row covers a group
 * of the create Operation's steps (Operation 18922 on Beast). Rows "container" and "address" run
 * at the same time; the others follow one after another.
 */
export const ORBIT_CREATE_ROW_IDS = [
  "container",
  "address",
  "workspace",
  "t3",
  "register",
] as const;
export type OrbitCreateRowId = (typeof ORBIT_CREATE_ROW_IDS)[number];
export type OrbitCreateRowStatus = "pending" | "running" | "done" | "failed";

export const ORBIT_CREATE_ROW_LABELS: Readonly<Record<OrbitCreateRowId, string>> = {
  container: "Copy the container",
  address: "Publish the address",
  workspace: "Copy the workspace",
  t3: "Start the T3 server",
  register: "Register with Orbit",
};

/** What the saved start keeps per row; times are ms. */
export interface OrbitCreateRowState {
  readonly status: OrbitCreateRowStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}
export type OrbitCreateRows = Readonly<Partial<Record<OrbitCreateRowId, OrbitCreateRowState>>>;

/** Rows that run beside each other share a phase; a later phase means the earlier ones ended. */
const ROW_PHASE: Readonly<Record<OrbitCreateRowId, number>> = {
  container: 0,
  address: 0,
  workspace: 1,
  t3: 2,
  register: 3,
};

const STEP_ROWS: Readonly<Record<string, OrbitCreateRowId>> = {
  input: "container",
  "clone-input": "container",
  "clone-container": "container",
  "clone-club-key": "container",
  csr: "address",
  sign: "address",
  "clone-route": "address",
  site: "address",
  "clone-workspace": "workspace",
  "clone-agent": "t3",
  "clone-t3": "t3",
  "clone-sessions": "register",
  "clone-session-copy": "register",
  "clone-register": "register",
  finish: "register",
  "clone-private-cleanup": "register",
  cleanup: "register",
  accepted: "register",
};

/** Step name prefixes of the address row: numbered steps and Orbit's step descriptions. */
const ADDRESS_PREFIXES = [
  "clone-route-csr-",
  "records-",
  "catalog-",
  "restart-",
  "Install cert",
  "Publish private DNS",
  "Probe the site",
];

function isRowId(value: unknown): value is OrbitCreateRowId {
  return typeof value === "string" && (ORBIT_CREATE_ROW_IDS as readonly string[]).includes(value);
}

/**
 * The row a create step belongs to: Orbit's `group` when it names a row, else the step name.
 * Null for a step Conn does not know.
 */
export function orbitCreateRowOf(step: {
  readonly name: string;
  readonly group?: string | null;
}): OrbitCreateRowId | null {
  if (isRowId(step.group)) return step.group;
  if (Object.hasOwn(STEP_ROWS, step.name)) return STEP_ROWS[step.name]!;
  return ADDRESS_PREFIXES.some((prefix) => step.name.startsWith(prefix)) ? "address" : null;
}

/** A step's own status as a row status; null for skipped, legacy or unknown words, which count as nothing. */
function stepStatus(status: string): OrbitCreateRowStatus | null {
  switch (status) {
    case "pending":
    case "queued":
    case "waiting":
      return "pending";
    case "running":
    case "started":
      return "running";
    case "succeeded":
    case "completed":
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

interface RowRead {
  readonly status: OrbitCreateRowStatus;
  /** Orbit's own times over the row's steps, when it sent them. */
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

const time = (value: string | null): number | null => {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * What one read of the create Operation says about each row. A row the read says nothing about
 * is missing, so the saved state stays. A step Conn does not know counts for the row that ran
 * last before it, so it never moves the card back or blanks it.
 */
function readOrbitCreateRows(
  operation: OrbitGatewayOperation,
  previous: OrbitCreateRows | null = null,
): Partial<Record<OrbitCreateRowId, RowRead>> {
  const steps: readonly OrbitGatewayOperationStep[] = operation.steps ?? [];
  const running = runningRow(previous);
  const reads: Partial<Record<OrbitCreateRowId, RowRead>> = {};
  if (steps.length > 0) {
    const counted: Partial<Record<OrbitCreateRowId, OrbitGatewayOperationStep[]>> = {};
    const statuses = new Map<OrbitGatewayOperationStep, OrbitCreateRowStatus>();
    let last: OrbitCreateRowId | null = running;
    for (const step of steps) {
      const status = stepStatus(step.status);
      if (status === null) continue;
      const known = orbitCreateRowOf(step);
      const row = known ?? (status === "pending" ? null : (last ?? "container"));
      if (row === null) continue;
      if (status !== "pending") last = row;
      // An unknown step that finished says nothing new; one that runs or failed holds its row.
      if (known === null && status === "done") continue;
      (counted[row] ??= []).push(step);
      statuses.set(step, status);
    }
    for (const id of ORBIT_CREATE_ROW_IDS) {
      const rowSteps = counted[id];
      if (!rowSteps) continue;
      const states = rowSteps.map((step) => statuses.get(step)!);
      const status: OrbitCreateRowStatus = states.includes("failed")
        ? "failed"
        : states.includes("running")
          ? "running"
          : states.every((state) => state === "done")
            ? "done"
            : states.includes("done")
              ? "running"
              : "pending";
      const starts = rowSteps.map((step) => time(step.startedAt)).filter((t) => t !== null);
      const ends = rowSteps.map((step) => time(step.finishedAt));
      reads[id] = {
        status,
        startedAt: starts.length > 0 ? Math.min(...starts) : null,
        finishedAt:
          status === "done" && ends.every((t) => t !== null)
            ? Math.max(...(ends as number[]))
            : null,
      };
    }
  } else if (operation.currentStep) {
    // Orbit's Conn show may send only the current step: earlier phases have ended.
    const row = orbitCreateRowOf({ name: operation.currentStep }) ?? running;
    if (row !== null) {
      for (const id of ORBIT_CREATE_ROW_IDS) {
        if (ROW_PHASE[id] < ROW_PHASE[row]) {
          reads[id] = { status: "done", startedAt: null, finishedAt: null };
        }
      }
      reads[row] = { status: "running", startedAt: null, finishedAt: null };
    }
  }
  const failedName =
    operation.failedStep ?? steps.find((step) => step.status === "failed")?.name ?? null;
  if (operation.status === "succeeded") {
    const open = completionOpenRows(operation);
    for (const id of ORBIT_CREATE_ROW_IDS) {
      reads[id] = open.has(id)
        ? { startedAt: reads[id]?.startedAt ?? null, finishedAt: null, status: "running" }
        : { startedAt: null, finishedAt: null, ...reads[id], status: "done" };
    }
  } else if (
    (failedName !== null || OPERATION_TERMINAL_STATUSES.has(operation.status)) &&
    !ORBIT_CREATE_ROW_IDS.some((id) => reads[id]?.status === "failed")
  ) {
    const failedStep = failedName === null ? null : steps.find((step) => step.name === failedName);
    const row =
      (failedName === null ? null : orbitCreateRowOf(failedStep ?? { name: failedName })) ??
      ORBIT_CREATE_ROW_IDS.findLast((id) => reads[id]?.status === "running") ??
      running ??
      (failedName === null ? null : "container");
    if (row) reads[row] = { startedAt: null, finishedAt: null, ...reads[row], status: "failed" };
  }
  return reads;
}

/**
 * The rows a succeeded create leaves running for its `instance.complete` (Orbit release 2030):
 * the workspace, and the address when the create has a Route. None on older Gateways.
 */
function completionOpenRows(operation: OrbitGatewayOperation): ReadonlySet<OrbitCreateRowId> {
  if (typeof operation.completionOperationId !== "number") return new Set();
  return new Set<OrbitCreateRowId>(
    operation.routeId === null ? ["workspace"] : ["workspace", "address"],
  );
}

function runningRow(rows: OrbitCreateRows | null): OrbitCreateRowId | null {
  return ORBIT_CREATE_ROW_IDS.findLast((id) => rows?.[id]?.status === "running") ?? null;
}

/**
 * The rows after a read of the create Operation. While it runs, Orbit's step times may be null,
 * so a row counts from when Conn first saw it run (or end); once the Operation ended, Orbit's
 * exact times replace Conn's wherever Orbit sent them. Rows never go back to pending.
 */
export function observeOrbitCreateRows(
  previous: OrbitCreateRows | null,
  operation: OrbitGatewayOperation,
  now: number,
): OrbitCreateRows {
  const reads = readOrbitCreateRows(operation, previous);
  const terminal = OPERATION_TERMINAL_STATUSES.has(operation.status);
  const next: Partial<Record<OrbitCreateRowId, OrbitCreateRowState>> = { ...previous };
  for (const id of ORBIT_CREATE_ROW_IDS) {
    const before = previous?.[id] ?? null;
    const read = reads[id];
    let state: OrbitCreateRowState | null = before;
    if (read && read.status !== "pending") {
      const startedAt = before?.startedAt ?? now;
      state = {
        status: read.status,
        startedAt,
        finishedAt: read.status === "running" ? null : (before?.finishedAt ?? now),
      };
    } else if (terminal && before?.status === "running") {
      // The Operation ended without a word on this row.
      state = {
        ...before,
        status: operation.status === "succeeded" ? "done" : "failed",
        finishedAt: now,
      };
    }
    if (state !== null && terminal && read) {
      state = {
        ...state,
        startedAt: read.startedAt ?? state.startedAt,
        finishedAt: read.finishedAt ?? state.finishedAt,
      };
    }
    if (state !== null) next[id] = state;
  }
  return next;
}

/** The rows after a create failed where Orbit named no step: the row that ran failed now. */
export function stopRunningOrbitCreateRows(
  rows: OrbitCreateRows | null,
  now: number,
): OrbitCreateRows | null {
  const id = ORBIT_CREATE_ROW_IDS.findLast((row) => rows?.[row]?.status === "running");
  if (
    rows === null ||
    id === undefined ||
    ORBIT_CREATE_ROW_IDS.some((row) => rows[row]?.status === "failed")
  ) {
    return null;
  }
  return { ...rows, [id]: { ...rows[id]!, status: "failed", finishedAt: now } };
}

/** Saved rows from a stored start of any build; a broken row reads as missing. */
export function readSavedOrbitCreateRows(value: unknown): OrbitCreateRows | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rows: Partial<Record<OrbitCreateRowId, OrbitCreateRowState>> = {};
  for (const id of ORBIT_CREATE_ROW_IDS) {
    const row = (value as Record<string, unknown>)[id];
    if (typeof row !== "object" || row === null) continue;
    const { status, startedAt, finishedAt } = row as Record<string, unknown>;
    if (status !== "pending" && status !== "running" && status !== "done" && status !== "failed") {
      continue;
    }
    rows[id] = {
      status,
      startedAt: typeof startedAt === "number" ? startedAt : null,
      finishedAt: typeof finishedAt === "number" ? finishedAt : null,
    };
  }
  return rows;
}

/** Whether two saved row sets are the same, so a read that changed nothing saves nothing. */
export function sameOrbitCreateRows(
  left: OrbitCreateRows | null | undefined,
  right: OrbitCreateRows | null | undefined,
): boolean {
  return ORBIT_CREATE_ROW_IDS.every((id) => {
    const a = left?.[id];
    const b = right?.[id];
    return (
      a?.status === b?.status && a?.startedAt === b?.startedAt && a?.finishedAt === b?.finishedAt
    );
  });
}

/** The rows an `instance.complete` sets up; the other three end with the create. */
const COMPLETION_ROW_IDS = ["workspace", "address"] as const satisfies readonly OrbitCreateRowId[];

/**
 * The row a completion step belongs to, by its job first: child workflows reuse names such as
 * `input`, `csr` and `site`, which count for nothing here. Null for a step the card does not show.
 */
export function orbitCompletionRowOf(step: {
  readonly name: string;
  readonly job: string | null;
}): OrbitCreateRowId | null {
  if (step.job === "complete") return "workspace";
  const name = step.name.replace(/(-\d+)+$/, "");
  if (step.job === "publication" && (name === "route" || name === "route-csr")) return "address";
  return null;
}

/** The row a failed or cancelled completion stopped at: Orbit's phase, a failed step, else the workspace. */
export function orbitCompletionFailedRow(operation: OrbitGatewayOperation): OrbitCreateRowId {
  switch (operation.resultFailedStep) {
    case "database":
    case "fleet":
    case "workspace":
    case "check":
    case "complete":
      return "workspace";
    case "route":
      return "address";
  }
  for (const step of operation.steps ?? []) {
    const row = step.status === "failed" ? orbitCompletionRowOf(step) : null;
    if (row !== null) return row;
  }
  return "workspace";
}

/**
 * The workspace and address rows after a read of the create's `instance.complete`; no order is
 * inferred. A row runs until the completion ends, is done when it succeeded or all its steps did,
 * fails per `orbitCompletionFailedRow`, and reads pending if its steps never ended. It keeps its start.
 */
export function observeOrbitCompletionRows(
  previous: OrbitCreateRows | null,
  operation: OrbitGatewayOperation,
  now: number,
): OrbitCreateRows {
  const next: Partial<Record<OrbitCreateRowId, OrbitCreateRowState>> = { ...previous };
  const terminal = OPERATION_TERMINAL_STATUSES.has(operation.status);
  const failedRow =
    terminal && operation.status !== "succeeded" ? orbitCompletionFailedRow(operation) : null;
  for (const id of COMPLETION_ROW_IDS) {
    const before = previous?.[id] ?? null;
    const steps = (operation.steps ?? []).filter(
      (step) => orbitCompletionRowOf(step) === id && stepStatus(step.status) !== null,
    );
    const states = steps.map((step) => stepStatus(step.status));
    const starts = steps.map((step) => time(step.startedAt)).filter((t) => t !== null);
    const ends = steps.map((step) => time(step.finishedAt)).filter((t) => t !== null);
    const lastEnd = ends.length > 0 ? Math.max(...ends) : null;
    const startedAt = before?.startedAt ?? (starts.length > 0 ? Math.min(...starts) : now);
    let status: OrbitCreateRowStatus;
    if (operation.status === "succeeded") status = "done";
    else if (terminal) {
      if (id === failedRow) status = "failed";
      else if (states.length > 0 && states.every((state) => state === "done")) status = "done";
      // A row with no step in this read keeps its state (a refused admission: spec state 12).
      else if (before !== null && (states.length === 0 || before.status !== "running")) continue;
      // The completion ended while this row's steps were unfinished: they did not run.
      else status = "pending";
    } else if (states.includes("failed")) status = "failed";
    // A Retry re-runs the completion: a row that was done stays done until a step of it fails.
    else if (before?.status === "done") continue;
    else status = "running";
    next[id] = {
      status,
      startedAt,
      finishedAt:
        status === "running" || status === "pending"
          ? null
          : (lastEnd ?? before?.finishedAt ?? now),
    };
  }
  return next;
}

/** A Retry of the completion: its failed rows run again, the other rows stay as they are. */
export function reopenOrbitCompletionRows(rows: OrbitCreateRows | null): OrbitCreateRows | null {
  if (rows === null) return null;
  const next: Partial<Record<OrbitCreateRowId, OrbitCreateRowState>> = { ...rows };
  for (const id of COMPLETION_ROW_IDS) {
    const row = rows[id];
    if (row?.status === "failed") next[id] = { ...row, status: "running", finishedAt: null };
  }
  return next;
}
