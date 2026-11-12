import {
  ORBIT_BRANCH_EXISTS,
  ORBIT_BRANCH_IN_USE,
  ORBIT_BRANCH_NOT_FOUND,
  ORBIT_CREATE_CLONE_FAILED,
  ORBIT_CREATE_WORKSPACE_FAILED,
  ORBIT_PLACEMENT_CONFLICT,
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  orbitSetupReadyMs,
  orbitSetupStages,
  orbitThreadStartCreatedInstance,
  type OrbitGatewayOperation,
  type OrbitSetupStageId,
  type OrbitSetupStageStatus,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";

/**
 * Conn: what the Orbit setup card shows, built on the client from the saved start and the latest
 * read of its create Operation. The clone's server does not exist yet, so nothing comes from a
 * T3 server, and the wire contract's worktree stage ids stay untouched.
 */
export interface OrbitSetupViewStage {
  readonly id: OrbitSetupStageId;
  readonly label: string;
  readonly status: OrbitSetupStageStatus;
  /** "Create Instance": the Node. */
  readonly detail: string | null;
  /** "Create Instance": the clone step that runs or failed. */
  readonly subDetail: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface OrbitSetupView {
  readonly phase: "running" | "done" | "failed";
  readonly stages: readonly OrbitSetupViewStage[];
  readonly error: string | null;
  /** A refusal that made no Instance: a taken name, or a name that is a branch already. */
  readonly canChangeName: boolean;
  /** A branch that is gone or held: reopen the draft with the branch menu. */
  readonly canChangeBranch: boolean;
  /** The Instance that works on the branch, which the user can open instead. */
  readonly openInstance: { readonly id: number; readonly name: string } | null;
  /** The start made an Instance: Dismiss leaves it, and the card says so. */
  readonly instanceStays: boolean;
}

export const ORBIT_SETUP_FAILED_TITLE = "Instance setup failed";
export const ORBIT_SETUP_RUNNING_TITLE = "Setting up Instance…";
export const ORBIT_INSTANCE_STAYS_LINE = "The Instance stays; remove it in Orbit.";
const NAME_TAKEN = "instance.name_taken";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The branch the start asked for: its own (named after the Instance) or the existing one. */
function requestedBranch(start: OrbitThreadStart): string {
  const branch = start.branch ?? null;
  if (branch === null) return start.defaultBranch ?? start.instanceName;
  return branch.mode === "new" ? start.instanceName : branch.name;
}

/** The holder in a `branch.in_use` refusal; empty when the holder's Node is out of reach. */
function branchHolder(start: OrbitThreadStart): { id: number; name: string } | null {
  const instance = record(record(start.errorDetails)?.instance);
  return typeof instance?.id === "number" && typeof instance.name === "string"
    ? { id: instance.id, name: instance.name }
    : null;
}

interface OrbitStartFailure {
  readonly message: string | null;
  readonly changeName: boolean;
  readonly changeBranch: boolean;
  readonly openInstance: { readonly id: number; readonly name: string } | null;
}

/**
 * The failed card's text and actions for a start's error code. Branch refusals come at admission,
 * where Orbit made nothing; the two create step codes come from a failed Operation whose Instance
 * stays, so they offer no Change name or Change branch.
 */
export function orbitStartFailure(start: OrbitThreadStart): OrbitStartFailure {
  const none = { changeName: false, changeBranch: false, openInstance: null };
  const madeNothing = !orbitThreadStartCreatedInstance(start);
  const details = record(start.errorDetails);
  switch (start.errorCode) {
    case NAME_TAKEN:
      return { ...none, message: start.error, changeName: madeNothing };
    case ORBIT_BRANCH_IN_USE: {
      const holder = branchHolder(start);
      const branch = requestedBranch(start);
      return {
        message: holder
          ? `Instance ${holder.name} already works on ${branch}.`
          : `Another Instance already works on ${branch}.`,
        changeName: false,
        changeBranch: madeNothing,
        openInstance: holder,
      };
    }
    case ORBIT_BRANCH_NOT_FOUND: {
      // Mode new names only a base (field branch.from), mode existing only a branch (branch.name).
      const branch = start.branch ?? null;
      const name =
        branch === null
          ? requestedBranch(start)
          : branch.mode === "new"
            ? branch.from
            : branch.name;
      return { ...none, message: `Branch ${name} no longer exists.`, changeBranch: madeNothing };
    }
    case ORBIT_BRANCH_EXISTS: {
      const name = typeof details?.branch === "string" ? details.branch : start.instanceName;
      return {
        ...none,
        message: `A branch named ${name} already exists.`,
        changeName: madeNothing,
      };
    }
    case ORBIT_PLACEMENT_CONFLICT:
      return {
        ...none,
        message: "This name was already used with another branch. Choose another name.",
        changeName: madeNothing,
      };
    case ORBIT_SOURCE_HEAD_UNAVAILABLE:
      return { ...none, message: "Could not read the repository." };
    case ORBIT_CREATE_CLONE_FAILED:
      return { ...none, message: "Orbit could not prepare the branch." };
    case ORBIT_CREATE_WORKSPACE_FAILED:
      return { ...none, message: "Orbit could not set up the workspace." };
    default:
      return { ...none, message: start.error };
  }
}

const STAGE_LABELS: Readonly<Record<OrbitSetupStageId, string>> = {
  create: "Create Instance",
  connect: "Connect",
  agent: "Start agent",
};

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function orbitSetupView(
  start: OrbitThreadStart,
  create: OrbitGatewayOperation | null = null,
): OrbitSetupView {
  const stages = orbitSetupStages({ start, create }).map((stage): OrbitSetupViewStage => ({
    id: stage.id,
    label: STAGE_LABELS[stage.id],
    status: stage.status,
    detail: stage.detail,
    subDetail: stage.subDetail,
    startedAt: iso(stage.startedAt),
    endedAt: iso(stage.finishedAt),
  }));
  const phase = start.error !== null ? "failed" : start.sentAt != null ? "done" : "running";
  const failed = phase === "failed";
  const newInstance = start.orbitInstanceKind !== "existing";
  const failure = failed ? orbitStartFailure(start) : null;
  return {
    phase,
    stages,
    error: failure?.message ?? start.error,
    canChangeName: newInstance && (failure?.changeName ?? false),
    canChangeBranch: newInstance && (failure?.changeBranch ?? false),
    openInstance: failure?.openInstance ?? null,
    instanceStays: failed && orbitThreadStartCreatedInstance(start),
  };
}

/** What the real thread shows above the agent's work once the start handed over. */
export interface OrbitReadyView {
  /** "Instance ready", with the setup's time when it is known. */
  readonly readyMs: number | null;
  readonly instanceName: string;
  readonly nodeName: string;
  readonly url: string | null;
  /** The one assistant-style line Conn renders; never sent to the agent. */
  readonly readyLine: string;
  /** The model the agent uses instead of the composer's, or null. */
  readonly modelFallbackLine: string | null;
  /** From the create's result: the branch checked out, and the base (null in mode existing). */
  readonly branch: string | null;
  readonly baseBranch: string | null;
  /** Shown only when the checked-out code is not the default branch. */
  readonly dependenciesLine: string | null;
}

export const ORBIT_DEPENDENCIES_LINE = "Dependencies and build come from the default branch.";

/**
 * Orbit reruns no setup after the checkout yet, so the code differs from what dependencies and the
 * build came from when the Instance works on another branch, or cut its own from another base.
 * The base is the create result's when Orbit sent one, else the one asked for.
 */
function checksOutOtherCode(start: OrbitThreadStart): boolean {
  const branch = start.branch ?? null;
  if (branch === null) return false;
  if (branch.mode === "existing") return true;
  return (start.resultBaseBranch ?? branch.from) !== start.defaultBranch;
}

export function orbitReadyView(start: OrbitThreadStart, url: string | null): OrbitReadyView {
  const fallback = start.modelFallback ?? null;
  return {
    readyMs: orbitSetupReadyMs(start),
    instanceName: start.instanceName,
    nodeName: start.nodeName,
    url,
    readyLine: orbitReadyLine(url),
    modelFallbackLine: fallback
      ? `This Instance does not offer ${fallback.requestedModel}, so the agent uses ${fallback.usedModel}.`
      : null,
    branch: start.resultBranch ?? null,
    baseBranch: start.resultBaseBranch ?? null,
    dependenciesLine: checksOutOtherCode(start) ? ORBIT_DEPENDENCIES_LINE : null,
  };
}

export function orbitReadyLine(url: string | null): string {
  return url === null
    ? "Your Instance is ready."
    : `Your Instance is ready. You can preview it at ${url} while I work on your request.`;
}
