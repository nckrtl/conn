import {
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
  /** Only a taken name offers Change name. */
  readonly canChangeName: boolean;
  /** The start made an Instance: Dismiss leaves it, and the card says so. */
  readonly instanceStays: boolean;
}

export const ORBIT_SETUP_FAILED_TITLE = "Instance setup failed";
export const ORBIT_SETUP_RUNNING_TITLE = "Setting up Instance…";
export const ORBIT_INSTANCE_STAYS_LINE = "The Instance stays; remove it in Orbit.";
const NAME_TAKEN = "instance.name_taken";

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
  return {
    phase,
    stages,
    error: start.error,
    canChangeName:
      phase === "failed" &&
      start.orbitInstanceKind !== "existing" &&
      start.errorCode === NAME_TAKEN,
    instanceStays: phase === "failed" && orbitThreadStartCreatedInstance(start),
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
  };
}

export function orbitReadyLine(url: string | null): string {
  return url === null
    ? "Your Instance is ready."
    : `Your Instance is ready. You can preview it at ${url} while I work on your request.`;
}
