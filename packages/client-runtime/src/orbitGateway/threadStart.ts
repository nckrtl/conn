import * as Schema from "effect/Schema";

import {
  OPERATION_TERMINAL_STATUSES,
  OrbitGatewayError,
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
  /** The thread and its first message, fixed up front so a resumed send cannot start a second thread. */
  readonly threadId: string;
  readonly messageId: string;
  readonly createdAt: number;
  readonly createOperationId: number | null;
  readonly instanceId: number | null;
  readonly environmentId: string | null;
  readonly pairingOperationId: number | null;
  readonly pairingId: number | null;
  /** The device saved the clone's server: paired now or before. */
  readonly connected: boolean;
  /** Why the start stopped. A retry resumes from the last saved step. */
  readonly error: string | null;
}

export interface OrbitThreadStartPorts {
  readonly client: OrbitGatewayClient;
  /** Saves the start after each step. */
  readonly save: (start: OrbitThreadStart) => void;
  readonly wait: (seconds: number) => Promise<void>;
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
const DEFAULT_POLL_SECONDS = 2;
const MAX_READ_MISSES = 5;

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
    createdAt: input.now,
    createOperationId: null,
    instanceId: null,
    environmentId: null,
    pairingOperationId: null,
    pairingId: null,
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

const isStepFailed = Schema.is(StepFailed);
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
  const follow = async (operationId: number, failed: (code: string) => StepFailed) => {
    let misses = 0;
    for (;;) {
      let operation;
      try {
        operation = await ports.client.operation(operationId);
        misses = 0;
      } catch (error) {
        // A create runs for minutes; a short Gateway outage must not stop it.
        if (!isTransient(error) || ++misses > MAX_READ_MISSES) throw error;
        await ports.wait(DEFAULT_POLL_SECONDS);
        continue;
      }
      if (operation.status === "succeeded") return;
      if (OPERATION_TERMINAL_STATUSES.has(operation.status)) {
        throw failed(operation.errorCode ?? `operation.${operation.status}`);
      }
      await ports.wait(operation.pollAfterSeconds ?? DEFAULT_POLL_SECONDS);
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
      await follow(current.createOperationId!, (code) =>
        stepFailed(`Orbit could not create the clone (${code}).`, {
          createOperationId: null,
        }),
      );
      const server = (await ports.client.environments()).find(
        (environment) => environment.instanceId === current.instanceId,
      );
      if (!server) {
        throw stepFailed("Orbit created the clone but lists no T3 server for it.", {});
      }
      if (server.powerState === "stopped") {
        throw stepFailed("The clone is asleep. Conn cannot wake it yet.", {});
      }
      update({ environmentId: server.environmentId });
    }
    const environmentId = current.environmentId!;

    if (!current.connected) {
      if (!ports.isSaved(environmentId)) {
        if (current.pairingOperationId === null) {
          const operation = await ports.client.startPairing(environmentId);
          update({ pairingOperationId: operation.id, pairingId: operation.targetId });
        }
        // A failed pairing, or a link read before a reload, needs a new pairing: only a retry starts it.
        const newPairing = { pairingOperationId: null, pairingId: null };
        await follow(current.pairingOperationId!, (code) =>
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
        update(newPairing);
        await ports.connect(environmentId, pairingUrl);
      }
      update({ connected: true });
    }

    await ports.send({ ...current, environmentId });
    return true;
  } catch (error) {
    update({
      ...(isStepFailed(error) ? (error.reset as Partial<OrbitThreadStart>) : {}),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
