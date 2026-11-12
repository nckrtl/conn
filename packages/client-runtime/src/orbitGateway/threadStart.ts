import {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OPERATION_TIMEOUT_MS,
  ORBIT_BRANCH_EXISTS,
  ORBIT_BRANCH_IN_USE,
  ORBIT_BRANCH_NOT_FOUND,
  ORBIT_PLACEMENT_CONFLICT,
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  OrbitGatewayError,
  operationPollDelayMs,
  type OrbitGatewayBranchSelection,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
  type OrbitGatewayProject,
} from "./client.ts";

/**
 * Conn: a thread started in an Orbit Project (Orbit's docs/cli/instance/container/thread.mmd). The
 * Gateway creates a clone of the Project's default Instance, Conn pairs with the clone's T3 server
 * once, and sends the first message there. Each finished step is saved, so a reload resumes the
 * same start instead of creating or pairing again.
 */
export interface OrbitThreadStart {
  readonly id: string;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly nodeName: string;
  readonly instanceName: string;
  readonly message: string;
  /**
   * The thread, its first message and the launch command, fixed up front. A resumed send repeats
   * the same command, so the server finishes that launch instead of starting a second one.
   */
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly createdAt: number;
  /** Conn: the workspace selected at Start (null for all); the sent thread's project joins it. */
  readonly workspaceId?: string | null;
  /**
   * The `Idempotency-Key` of the create and of the pairing, saved before the first try, so a
   * repeat after a lost answer, a reload or Retry gets the same Operation. Missing on older rows.
   */
  readonly createKey?: string | null;
  readonly createOperationId: number | null;
  readonly instanceId: number | null;
  readonly environmentId: string | null;
  readonly pairingKey?: string | null;
  readonly pairingOperationId: number | null;
  readonly pairingId: number | null;
  /** Conn read the one-time pairing link. A resume that finds it with an unsaved server waits for Retry. */
  readonly pairingLinkRead: boolean;
  /** The device saved the clone's server: paired now or before. */
  readonly connected: boolean;
  /** Why the start stopped. A retry resumes from the last saved step. */
  readonly error: string | null;
  // Version 2. Rows saved by older builds lack these fields; `readOrbitThreadStarts` loads them.
  /** "existing": the start begins at a known clone and skips the create. Missing means "new". */
  readonly orbitInstanceKind?: OrbitInstanceKind;
  /** The composer's model and modes for the first turn; null or missing uses the clone's defaults. */
  readonly modelSelection?: ModelSelectionType | null;
  readonly runtimeMode?: RuntimeMode | null;
  readonly interactionMode?: ProviderInteractionMode | null;
  /** The Gateway's error code behind `error`, such as `instance.name_taken`. */
  readonly errorCode?: string | null;
  /** Stage times in ms, saved as each stage begins and ends. */
  readonly createStartedAt?: number | null;
  readonly createFinishedAt?: number | null;
  readonly connectStartedAt?: number | null;
  readonly connectFinishedAt?: number | null;
  readonly agentStartedAt?: number | null;
  readonly sentAt?: number | null;
  /**
   * The start opened a pending thread (the palette flow). It stays saved after the send, so the
   * real thread finds it by `threadId` for its "Instance ready" row. Older and dialog starts lack it.
   */
  readonly pendingThread?: boolean;
  /** Display facts for the pending thread and Change name; null on older rows. */
  readonly projectName?: string | null;
  readonly instanceDomainSuffix?: string | null;
  /** The clone did not offer the composer's model; the first turn used the clone's default. */
  readonly modelFallback?: OrbitModelFallback | null;
  /**
   * The branch the new Instance works on; null or missing clones the default branch as before.
   * Retry sends the same one: Orbit refuses the same name with another selection.
   */
  readonly branch?: OrbitGatewayBranchSelection | null;
  /** The Project's default branch as the draft knew it at send, or null. */
  readonly defaultBranch?: string | null;
  /** The Gateway's `details` behind `errorCode`, such as the Instance holding a branch. */
  readonly errorDetails?: Readonly<Record<string, unknown>> | null;
  /** Orbit's detail line from the failed Operation behind `errorCode`; null on older rows. */
  readonly errorDetail?: string | null;
  /** The create's result: the branch the Instance checked out and the base it was cut from. */
  readonly resultBranch?: string | null;
  readonly resultBaseBranch?: string | null;
}

export interface OrbitModelFallback {
  readonly requestedModel: string;
  readonly usedModel: string;
}

export type OrbitInstanceKind = "new" | "existing";

/** A clone the device knows already; a start in it skips the create. */
export interface OrbitExistingInstance {
  readonly instanceId: number;
  readonly environmentId: string;
  readonly name: string;
  readonly nodeName: string;
}

const STAGE_TIME_FIELDS = [
  "createStartedAt",
  "createFinishedAt",
  "connectStartedAt",
  "connectFinishedAt",
  "agentStartedAt",
  "sentAt",
] as const;

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const isRuntimeMode = Schema.is(RuntimeMode);
const isInteractionMode = Schema.is(ProviderInteractionMode);

/**
 * The starts a store saved, from rows of any build. Rows without the ids a resume needs are
 * dropped; version 2 fields with a wrong type read as missing.
 */
export function readOrbitThreadStarts(value: unknown): OrbitThreadStart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): OrbitThreadStart[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.commandId !== "string" ||
      typeof row.threadId !== "string" ||
      typeof row.projectId !== "number"
    ) {
      return [];
    }
    const times = Object.fromEntries(
      STAGE_TIME_FIELDS.map((field) => [
        field,
        typeof row[field] === "number" ? (row[field] as number) : null,
      ]),
    );
    return [
      {
        ...(row as unknown as OrbitThreadStart),
        ...times,
        orbitInstanceKind: row.orbitInstanceKind === "existing" ? "existing" : "new",
        modelSelection: Option.getOrNull(decodeModelSelection(row.modelSelection)),
        runtimeMode: isRuntimeMode(row.runtimeMode) ? row.runtimeMode : null,
        interactionMode: isInteractionMode(row.interactionMode) ? row.interactionMode : null,
        errorCode: typeof row.errorCode === "string" ? row.errorCode : null,
        pendingThread: row.pendingThread === true,
        projectName: typeof row.projectName === "string" ? row.projectName : null,
        instanceDomainSuffix:
          typeof row.instanceDomainSuffix === "string" ? row.instanceDomainSuffix : null,
        modelFallback: readModelFallback(row.modelFallback),
        branch: readBranchSelection(row.branch),
        defaultBranch: typeof row.defaultBranch === "string" ? row.defaultBranch : null,
        errorDetails:
          typeof row.errorDetails === "object" &&
          row.errorDetails !== null &&
          !Array.isArray(row.errorDetails)
            ? (row.errorDetails as Record<string, unknown>)
            : null,
        errorDetail: typeof row.errorDetail === "string" ? row.errorDetail : null,
        resultBranch: typeof row.resultBranch === "string" ? row.resultBranch : null,
        resultBaseBranch: typeof row.resultBaseBranch === "string" ? row.resultBaseBranch : null,
      },
    ];
  });
}

/** A saved branch choice, or null for none or a broken one. */
function readBranchSelection(value: unknown): OrbitGatewayBranchSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.mode === "new" && typeof row.from === "string" && row.from !== "") {
    return { mode: "new", from: row.from };
  }
  if (row.mode === "existing" && typeof row.name === "string" && row.name !== "") {
    return { mode: "existing", name: row.name };
  }
  return null;
}

function readModelFallback(value: unknown): OrbitModelFallback | null {
  if (typeof value !== "object" || value === null) return null;
  const { requestedModel, usedModel } = value as Record<string, unknown>;
  return typeof requestedModel === "string" && typeof usedModel === "string"
    ? { requestedModel, usedModel }
    : null;
}

/**
 * The start Retry runs again: no error, and the times of each stage that runs again cleared, so
 * the stage shows pending until the runner reaches it and its time counts from the new attempt.
 * `patch` applies first, such as a new Instance name.
 */
export function retryOrbitThreadStartRecord(
  start: OrbitThreadStart,
  patch: Partial<OrbitThreadStart> = {},
): OrbitThreadStart {
  const next = {
    ...start,
    ...patch,
    error: null,
    errorCode: null,
    errorDetails: null,
    errorDetail: null,
  };
  const createAgain = next.environmentId === null;
  return {
    ...next,
    ...(createAgain && next.createOperationId === null
      ? { createStartedAt: null, createFinishedAt: null }
      : {}),
    ...(next.connected ? {} : { connectStartedAt: null, connectFinishedAt: null }),
    ...(next.sentAt == null ? { agentStartedAt: null } : {}),
  };
}

/**
 * Whether the start made an Instance that stays when the start is dismissed: its create was
 * admitted (Orbit holds the Instance, also after a failed create) or it finished. A start in an
 * existing Instance made none.
 */
export function orbitThreadStartCreatedInstance(start: OrbitThreadStart): boolean {
  return (
    start.orbitInstanceKind !== "existing" &&
    (start.instanceId !== null || start.environmentId !== null)
  );
}

export interface OrbitThreadStartPorts {
  readonly client: OrbitGatewayClient;
  /** Saves the start after each step. */
  readonly save: (start: OrbitThreadStart) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** True once the user dismissed the start, or Orbit no longer provides the environments. */
  readonly stopped: () => boolean;
  /** Whether the device has saved the server already. */
  readonly isSaved: (environmentId: string) => boolean;
  /** Each read of the create Operation, for the setup card's clone step. */
  readonly onCreateOperation?: (operation: OrbitGatewayOperation) => void;
  /** Opens a one-time pairing link and saves the server. */
  readonly connect: (environmentId: string, pairingUrl: string) => Promise<void>;
  /**
   * Starts the thread with the first message in the clone's workspace project. It may resolve facts
   * to save with the sent start, such as a model fallback.
   */
  readonly send: (
    start: OrbitThreadStart & { readonly environmentId: string },
  ) => Promise<void | Partial<OrbitThreadStart>>;
}

/** The longest name the Gateway takes is 63 characters; the slug leaves room for the suffix. */
const NAME_SLUG_LENGTH = 40;
const NAME_SLUG_WORDS = 6;
/** How long Operation reads may keep failing before the start stops. */
const READ_OUTAGE_MS = 60_000;
/** A clone's create runs for minutes; a pairing follows #9's `pair` deadline. */
const CREATE_TIMEOUT_MS = 30 * 60_000;
const PAIRING_TIMEOUT_MS = OPERATION_TIMEOUT_MS;
/** How long a pairing admission may keep losing its answer; each try may take up to 60 s. */
const PAIRING_ADMISSION_MS = 5 * 60_000;

/**
 * The clone's Instance name: the first words of the message as a slug, and a random suffix so two
 * threads with the same opening never name the same Instance.
 */
export function orbitThreadInstanceName(message: string, suffix: string): string {
  const slug = message
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word !== "")
    .slice(0, NAME_SLUG_WORDS)
    .join("-")
    .slice(0, NAME_SLUG_LENGTH)
    .replace(/-+$/, "");
  return `${slug || "thread"}-${suffix}`;
}

export function newOrbitThreadStart(input: {
  readonly id: string;
  readonly project: Pick<OrbitGatewayProject, "id" | "slug" | "nodeName">;
  readonly message: string;
  readonly suffix: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly now: number;
  /** The name the user gave the new Instance; without it the name comes from the message. */
  readonly instanceName?: string;
  /** Starts in this clone instead of creating one. */
  readonly existing?: OrbitExistingInstance;
  readonly modelSelection?: ModelSelectionType | null;
  readonly runtimeMode?: RuntimeMode | null;
  readonly interactionMode?: ProviderInteractionMode | null;
  readonly pendingThread?: boolean;
  readonly projectName?: string | null;
  readonly instanceDomainSuffix?: string | null;
  /** A new Instance only; ignored for an existing one. */
  readonly branch?: OrbitGatewayBranchSelection | null;
  readonly defaultBranch?: string | null;
}): OrbitThreadStart {
  const existing = input.existing;
  return {
    id: input.id,
    projectId: input.project.id,
    projectSlug: input.project.slug,
    nodeName: existing?.nodeName ?? input.project.nodeName,
    instanceName:
      existing?.name ?? input.instanceName ?? orbitThreadInstanceName(input.message, input.suffix),
    message: input.message,
    threadId: input.threadId,
    messageId: input.messageId,
    commandId: input.commandId,
    createdAt: input.now,
    createKey: null,
    createOperationId: null,
    instanceId: existing?.instanceId ?? null,
    environmentId: existing?.environmentId ?? null,
    pairingKey: null,
    pairingOperationId: null,
    pairingId: null,
    pairingLinkRead: false,
    connected: false,
    error: null,
    orbitInstanceKind: existing ? "existing" : "new",
    modelSelection: input.modelSelection ?? null,
    runtimeMode: input.runtimeMode ?? null,
    interactionMode: input.interactionMode ?? null,
    errorCode: null,
    createStartedAt: null,
    createFinishedAt: null,
    connectStartedAt: null,
    connectFinishedAt: null,
    agentStartedAt: null,
    sentAt: null,
    pendingThread: input.pendingThread ?? false,
    projectName: input.projectName ?? null,
    instanceDomainSuffix: input.instanceDomainSuffix ?? null,
    modelFallback: null,
    branch: existing ? null : (input.branch ?? null),
    defaultBranch: input.defaultBranch ?? null,
    errorDetails: null,
    errorDetail: null,
    resultBranch: null,
    resultBaseBranch: null,
  };
}

/** The step a start is at, for display. */
export function orbitThreadStartStep(start: OrbitThreadStart): "creating" | "pairing" | "sending" {
  if (start.environmentId === null) return "creating";
  return start.connected ? "sending" : "pairing";
}

/** A step that stopped the start, with the saved steps a retry must redo. */
class StepFailed extends Schema.TaggedError<StepFailed>()("OrbitThreadStepFailed", {
  message: Schema.String,
  code: Schema.NullOr(Schema.String),
  reset: Schema.Record(Schema.String, Schema.Unknown),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  detail: Schema.optional(Schema.NullOr(Schema.String)),
}) {}

/** The user dismissed the start. */
class Stopped extends Schema.TaggedError<Stopped>()("OrbitThreadStartStopped", {}) {}

const isStepFailed = Schema.is(StepFailed);
const isStopped = Schema.is(Stopped);
const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** The Gateway did not answer, or failed on its side. */
function isTransient(error: unknown): boolean {
  return isOrbitGatewayError(error) && (error.status === 0 || error.status >= 500);
}

/**
 * An admission whose answer was lost on the way: no answer, or a proxy's 502/504 without the
 * Gateway's error envelope. A Gateway error, also a 5xx, is final.
 */
function isLostAdmission(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) &&
    (error.status === 0 ||
      ((error.status === 502 || error.status === 504) && error.code === "gateway.request_failed"))
  );
}

/**
 * Another Operation owns the Instance, such as an older build's create or one whose key was lost.
 * The same create is admitted once that Operation ends.
 */
function isTargetBusy(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) && error.status === 409 && error.code === "operation.target_busy"
  );
}

function stepFailed(
  message: string,
  reset: Partial<OrbitThreadStart>,
  code: string | null = null,
  detail: string | null = null,
): StepFailed {
  return new StepFailed({ message, code, reset, detail });
}

/**
 * Refusals of a create at admission: Orbit made no Instance, so a retry or another name or branch
 * is a new attempt under a new key.
 */
const ADMISSION_REFUSALS: ReadonlySet<string> = new Set([
  "instance.name_taken",
  ORBIT_BRANCH_IN_USE,
  ORBIT_BRANCH_NOT_FOUND,
  ORBIT_BRANCH_EXISTS,
  ORBIT_SOURCE_HEAD_UNAVAILABLE,
  ORBIT_PLACEMENT_CONFLICT,
  // A malformed request (such as a branch object Orbit refuses) admits nothing either.
  "validation.failed",
]);

function isAdmissionRefusal(error: unknown): error is OrbitGatewayError {
  return isOrbitGatewayError(error) && ADMISSION_REFUSALS.has(error.code);
}

/**
 * Runs a start from its last saved step to the sent message. Resolves `true` once the message is
 * sent; otherwise it saves the start with `error` set and resolves `false`.
 */
export async function runOrbitThreadStart(
  start: OrbitThreadStart,
  ports: OrbitThreadStartPorts,
): Promise<boolean> {
  let current: OrbitThreadStart = {
    ...start,
    error: null,
    errorCode: null,
    errorDetails: null,
    errorDetail: null,
  };
  const update = (patch: Partial<OrbitThreadStart>) => {
    current = { ...current, ...patch };
    ports.save(current);
  };
  /** A stage time, set once: a resume keeps the first. */
  const stamp = (field: (typeof STAGE_TIME_FIELDS)[number]): Partial<OrbitThreadStart> =>
    current[field] == null ? { [field]: ports.now() } : {};
  const checkStopped = () => {
    if (ports.stopped()) throw new Stopped();
  };
  /** Follows an Operation with the rules of #9's `settle`: clamped polls and a deadline. */
  const follow = async (
    operationId: number,
    timeoutMs: number,
    failed: (code: string, detail: string | null) => StepFailed,
    observe?: (operation: OrbitGatewayOperation) => void,
  ): Promise<OrbitGatewayOperation> => {
    const deadline = ports.now() + timeoutMs;
    let outageSince: number | null = null;
    for (;;) {
      checkStopped();
      let operation;
      try {
        operation = await ports.client.operation(operationId);
        outageSince = null;
        observe?.(operation);
      } catch (error) {
        // A create runs for minutes; a short Gateway outage must not stop it.
        outageSince ??= ports.now();
        if (!isTransient(error) || ports.now() - outageSince >= READ_OUTAGE_MS) throw error;
        operation = null;
      }
      if (operation?.status === "succeeded") return operation;
      if (operation && OPERATION_TERMINAL_STATUSES.has(operation.status)) {
        throw failed(
          operation.errorCode ?? `operation.${operation.status}`,
          operation.error?.detail ?? null,
        );
      }
      if (ports.now() >= deadline) throw failed("operation.timeout", null);
      const wait = operationPollDelayMs(operation?.pollAfterSeconds ?? null);
      await ports.sleep(Math.max(Math.min(wait, deadline - ports.now()), 0));
    }
  };

  /**
   * Starts an Operation under a saved key. A lost answer repeats the same request with a growing,
   * clamped wait until the deadline: the Gateway returns the Operation it may have admitted.
   */
  const admit = async (
    deadline: number,
    start: () => Promise<OrbitGatewayOperation>,
    repeats: (error: unknown) => boolean = isLostAdmission,
  ): Promise<OrbitGatewayOperation> => {
    for (let attempt = 0; ; attempt++) {
      checkStopped();
      try {
        return await start();
      } catch (error) {
        if (!repeats(error) || ports.now() >= deadline) throw error;
      }
      const wait = operationPollDelayMs(2 ** attempt);
      await ports.sleep(Math.max(Math.min(wait, deadline - ports.now()), 0));
    }
  };
  const newKey = (step: string) => `conn-thread-start:${current.id}:${step}:${ports.now()}`;

  try {
    checkStopped();
    if (current.environmentId === null) {
      const createDeadline = ports.now() + CREATE_TIMEOUT_MS;
      if (current.createOperationId === null) {
        // A new key is a new attempt (first try, a new name, or after a failed create): its time
        // counts from now. A repeat under the saved key keeps the first time.
        const begin = current.createKey
          ? stamp("createStartedAt")
          : { createKey: newKey("create"), createStartedAt: ports.now(), createFinishedAt: null };
        if (Object.keys(begin).length > 0) update(begin);
        let operation;
        try {
          operation = await admit(
            createDeadline,
            () =>
              ports.client.createThreadInstance(
                current.projectId,
                current.instanceName,
                current.createKey!,
                current.branch ?? null,
              ),
            (error) => isLostAdmission(error) || isTargetBusy(error),
          );
        } catch (error) {
          // A refused create admitted nothing: the next attempt needs a new key.
          if (isAdmissionRefusal(error)) {
            throw new StepFailed({
              message: error.message,
              code: error.code,
              reset: { createKey: null },
              details: error.details,
            });
          }
          if (!isTargetBusy(error)) throw error;
          throw stepFailed(
            "Orbit is still creating this clone; press Retry in a minute.",
            {},
            "operation.target_busy",
          );
        }
        update({ createOperationId: operation.id, instanceId: operation.targetId });
      }
      // A failed clone resumes when the same name is created again, so a retry admits it anew
      // under a new key. A create still running past the deadline keeps its Operation.
      const created = await follow(
        current.createOperationId!,
        createDeadline - ports.now(),
        (code, detail) =>
          stepFailed(
            `Orbit could not create the clone (${code}).`,
            code === "operation.timeout" ? {} : { createOperationId: null, createKey: null },
            code,
            detail,
          ),
        ports.onCreateOperation,
      );
      const server = (await ports.client.environments()).find(
        (environment) => environment.instanceId === current.instanceId,
      );
      if (!server) {
        throw stepFailed("Orbit created the clone but lists no T3 server for it.", {});
      }
      if (server.status !== "registered") {
        throw stepFailed("The clone's T3 server registration expired.", {});
      }
      if (server.powerState === "stopped") {
        throw stepFailed("The clone is asleep. Conn cannot wake it yet.", {});
      }
      const result = created.result ?? null;
      update({
        environmentId: server.environmentId,
        resultBranch: typeof result?.branch === "string" ? result.branch : null,
        resultBaseBranch: typeof result?.base_branch === "string" ? result.base_branch : null,
        ...stamp("createFinishedAt"),
      });
    }
    const environmentId = current.environmentId!;

    checkStopped();

    if (!current.connected) {
      const begin = stamp("connectStartedAt");
      if (Object.keys(begin).length > 0) update(begin);
      if (!ports.isSaved(environmentId)) {
        // The link was read before a reload or a failed connect: only Retry may pair again.
        if (current.pairingLinkRead) {
          throw stepFailed("Conn read the pairing link but did not save the clone's server.", {
            pairingLinkRead: false,
          });
        }
        if (current.pairingOperationId === null) {
          if (!current.pairingKey) update({ pairingKey: newKey("pairing") });
          const operation = await admit(ports.now() + PAIRING_ADMISSION_MS, () =>
            ports.client.startPairing(environmentId, current.pairingKey!),
          );
          update({ pairingOperationId: operation.id, pairingId: operation.targetId });
        }
        // A failed pairing needs a new pairing: only a retry starts it, under a new key.
        const newPairing = { pairingOperationId: null, pairingId: null, pairingKey: null };
        await follow(current.pairingOperationId!, PAIRING_TIMEOUT_MS, (code, detail) =>
          stepFailed(`Orbit could not pair with the clone (${code}).`, newPairing, code, detail),
        );
        let pairingUrl: string;
        try {
          pairingUrl = (await ports.client.readPairing(environmentId, current.pairingId!))
            .pairingUrl;
        } catch (error) {
          // The Gateway may have handed the link out before the read failed: Retry pairs anew.
          throw stepFailed(
            isOrbitGatewayError(error) && error.status === 409
              ? "The pairing link was already used or expired."
              : error instanceof Error
                ? error.message
                : String(error),
            newPairing,
          );
        }
        // The Gateway hands the link out once: a failed connect needs a new pairing.
        update({ ...newPairing, pairingLinkRead: true });
        try {
          await ports.connect(environmentId, pairingUrl);
        } catch (error) {
          throw stepFailed(error instanceof Error ? error.message : String(error), {
            pairingLinkRead: false,
          });
        }
      }
      update({ connected: true, pairingLinkRead: false, ...stamp("connectFinishedAt") });
    }

    checkStopped();
    const begin = stamp("agentStartedAt");
    if (Object.keys(begin).length > 0) update(begin);
    const sent = await ports.send({ ...current, environmentId });
    update({ ...sent, sentAt: ports.now() });
    return true;
  } catch (error) {
    // A start stopped mid-step ends without an error, so it resumes if it comes back.
    if (isStopped(error) || ports.stopped()) return false;
    update({
      ...(isStepFailed(error) ? (error.reset as Partial<OrbitThreadStart>) : {}),
      error: error instanceof Error ? error.message : String(error),
      errorCode: isStepFailed(error) ? error.code : isOrbitGatewayError(error) ? error.code : null,
      errorDetails: isStepFailed(error)
        ? (error.details ?? null)
        : isOrbitGatewayError(error)
          ? error.details
          : null,
      errorDetail: isStepFailed(error) ? (error.detail ?? null) : null,
    });
    return false;
  }
}
