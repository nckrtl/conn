import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OPERATION_TIMEOUT_MS,
  OrbitGatewayError,
  operationPollDelayMs,
  type OrbitGatewayClient,
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
  readonly createOperationId: number | null;
  readonly instanceId: number | null;
  readonly environmentId: string | null;
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
  /** True once the user dismissed the start; the run ends at the next step. */
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
const MAX_READ_MISSES = 5;
/** A clone's create runs for minutes; a pairing follows #9's `pair` deadline. */
const CREATE_TIMEOUT_MS = 30 * 60_000;
const PAIRING_TIMEOUT_MS = OPERATION_TIMEOUT_MS;

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
    createOperationId: null,
    instanceId: null,
    environmentId: null,
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
    let misses = 0;
    for (;;) {
      checkStopped();
      let operation;
      try {
        operation = await ports.client.operation(operationId);
        misses = 0;
      } catch (error) {
        // A create runs for minutes; a short Gateway outage must not stop it.
        if (!isTransient(error) || ++misses > MAX_READ_MISSES) throw error;
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

  try {
    if (current.environmentId === null) {
      if (current.createOperationId === null) {
        const operation = await ports.client.createThreadInstance(
          current.projectId,
          current.instanceName,
        );
        update({ createOperationId: operation.id, instanceId: operation.targetId });
      }
      // A failed clone resumes when the same name is created again, so a retry admits it anew.
      // A create that is still running past the deadline keeps its Operation for the retry.
      await follow(current.createOperationId!, CREATE_TIMEOUT_MS, (code) =>
        stepFailed(
          `Orbit could not create the clone (${code}).`,
          code === "operation.timeout" ? {} : { createOperationId: null },
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
          const operation = await ports.client.startPairing(environmentId);
          update({ pairingOperationId: operation.id, pairingId: operation.targetId });
        }
        // A failed pairing needs a new pairing: only a retry starts it.
        const newPairing = { pairingOperationId: null, pairingId: null };
        await follow(current.pairingOperationId!, PAIRING_TIMEOUT_MS, (code) =>
          stepFailed(`Orbit could not pair with the clone (${code}).`, newPairing),
        );
        let pairingUrl: string;
        try {
          pairingUrl = (await ports.client.readPairing(environmentId, current.pairingId!))
            .pairingUrl;
        } catch (error) {
          if (isOrbitGatewayError(error) && error.status === 409) {
            throw stepFailed("The pairing link was already used or expired.", newPairing);
          }
          throw error;
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
    if (isStopped(error)) return false;
    update({
      ...(isStepFailed(error) ? (error.reset as Partial<OrbitThreadStart>) : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
