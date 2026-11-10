import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OPERATION_TIMEOUT_MS,
  OrbitGatewayError,
  operationPollDelayMs,
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
  /** Opens a one-time pairing link and saves the server. */
  readonly connect: (environmentId: string, pairingUrl: string) => Promise<void>;
  /** Starts the thread with the first message in the clone's workspace project. */
  readonly send: (start: OrbitThreadStart & { readonly environmentId: string }) => Promise<void>;
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
  readonly project: OrbitGatewayProject;
  readonly message: string;
  readonly suffix: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly now: number;
}): OrbitThreadStart {
  return {
    id: input.id,
    projectId: input.project.id,
    projectSlug: input.project.slug,
    nodeName: input.project.nodeName,
    instanceName: orbitThreadInstanceName(input.message, input.suffix),
    message: input.message,
    threadId: input.threadId,
    messageId: input.messageId,
    commandId: input.commandId,
    createdAt: input.now,
    createKey: null,
    createOperationId: null,
    instanceId: null,
    environmentId: null,
    pairingKey: null,
    pairingOperationId: null,
    pairingId: null,
    pairingLinkRead: false,
    connected: false,
    error: null,
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
  reset: Schema.Record(Schema.String, Schema.Unknown),
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
 * The same create replays it or admits a resume once that Operation ends.
 */
function isTargetBusy(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) && error.status === 409 && error.code === "operation.target_busy"
  );
}

function stepFailed(message: string, reset: Partial<OrbitThreadStart>): StepFailed {
  return new StepFailed({ message, reset });
}

/**
 * Runs a start from its last saved step to the sent message. Resolves `true` once the message is
 * sent; otherwise it saves the start with `error` set and resolves `false`.
 */
export async function runOrbitThreadStart(
  start: OrbitThreadStart,
  ports: OrbitThreadStartPorts,
): Promise<boolean> {
  let current: OrbitThreadStart = { ...start, error: null };
  const update = (patch: Partial<OrbitThreadStart>) => {
    current = { ...current, ...patch };
    ports.save(current);
  };
  const checkStopped = () => {
    if (ports.stopped()) throw new Stopped();
  };
  /** Follows an Operation with the rules of #9's `settle`: clamped polls and a deadline. */
  const follow = async (
    operationId: number,
    timeoutMs: number,
    failed: (code: string) => StepFailed,
  ) => {
    const deadline = ports.now() + timeoutMs;
    let outageSince: number | null = null;
    for (;;) {
      checkStopped();
      let operation;
      try {
        operation = await ports.client.operation(operationId);
        outageSince = null;
      } catch (error) {
        // A create runs for minutes; a short Gateway outage must not stop it.
        outageSince ??= ports.now();
        if (!isTransient(error) || ports.now() - outageSince >= READ_OUTAGE_MS) throw error;
        operation = null;
      }
      if (operation?.status === "succeeded") return;
      if (operation && OPERATION_TERMINAL_STATUSES.has(operation.status)) {
        throw failed(operation.errorCode ?? `operation.${operation.status}`);
      }
      if (ports.now() >= deadline) throw failed("operation.timeout");
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
        if (!current.createKey) update({ createKey: newKey("create") });
        let operation;
        try {
          operation = await admit(
            createDeadline,
            () =>
              ports.client.createThreadInstance(
                current.projectId,
                current.instanceName,
                current.createKey!,
              ),
            (error) => isLostAdmission(error) || isTargetBusy(error),
          );
        } catch (error) {
          if (!isTargetBusy(error)) throw error;
          throw stepFailed("Orbit is still creating this clone; press Retry in a minute.", {});
        }
        update({ createOperationId: operation.id, instanceId: operation.targetId });
      }
      // A failed clone resumes when the same name is created again, so a retry admits it anew
      // under a new key. A create still running past the deadline keeps its Operation.
      await follow(current.createOperationId!, createDeadline - ports.now(), (code) =>
        stepFailed(
          `Orbit could not create the clone (${code}).`,
          code === "operation.timeout" ? {} : { createOperationId: null, createKey: null },
        ),
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
      update({ environmentId: server.environmentId });
    }
    const environmentId = current.environmentId!;

    checkStopped();

    if (!current.connected) {
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
        await follow(current.pairingOperationId!, PAIRING_TIMEOUT_MS, (code) =>
          stepFailed(`Orbit could not pair with the clone (${code}).`, newPairing),
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
      update({ connected: true, pairingLinkRead: false });
    }

    checkStopped();
    await ports.send({ ...current, environmentId });
    return true;
  } catch (error) {
    // A start stopped mid-step ends without an error, so it resumes if it comes back.
    if (isStopped(error) || ports.stopped()) return false;
    update({
      ...(isStepFailed(error) ? (error.reset as Partial<OrbitThreadStart>) : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
