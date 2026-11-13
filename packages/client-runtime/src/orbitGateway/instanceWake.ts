// @effect-diagnostics globalTimers:off - The Gateway client runs in the app, outside an Effect runtime.
import * as Schema from "effect/Schema";

import {
  OrbitGatewayError,
  operationPollDelayMs,
  type OrbitGatewayClient,
  type OrbitGatewayWakeOperation,
} from "./client.ts";

/**
 * Conn: wakes an asleep Orbit Instance before Conn connects to its T3 server. A connect to a frozen
 * container hangs and wakes nothing, so the wake must come first (Orbit's wake contract: `POST
 * /api/v1/instances/{id}/wake`, then `GET /api/v1/operations/{id}` until the Operation ends).
 */
export type OrbitInstanceWakeOutcome =
  | { readonly kind: "awake" }
  /** The Gateway has no wake route (404 or 405): Conn behaves as before the wake existed. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/** A wake that has not ended after this long counts as failed; Orbit's slow path takes 9-13 s. */
const ORBIT_WAKE_TIMEOUT_MS = 90_000;
/** Orbit answers 409 while a sleep or other lifecycle work runs: try again a few times. */
const BUSY_CODES: ReadonlySet<string> = new Set([
  "instance.lifecycle_busy",
  "operation.target_busy",
]);
const BUSY_RETRIES = 4;
const BUSY_RETRY_MS = 2_000;
const isOrbitGatewayError = Schema.is(OrbitGatewayError);
const OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "queued", "running", "waiting"]);

export interface OrbitInstanceWaker {
  /** Wakes the Instance; a second call while one runs for the same Instance shares it. */
  readonly wake: (
    client: OrbitGatewayClient,
    instanceId: number,
  ) => Promise<OrbitInstanceWakeOutcome>;
  readonly inFlight: (instanceId: number) => boolean;
}

export function createOrbitInstanceWaker(
  options: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly newKey?: () => string;
  } = {},
): OrbitInstanceWaker {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  // The same key within one wake; Orbit also shares an open wake between callers.
  const newKey = (instanceId: number) => options.newKey?.() ?? `conn-wake:${instanceId}:${now()}`;
  const running = new Map<number, Promise<OrbitInstanceWakeOutcome>>();

  const run = async (
    client: OrbitGatewayClient,
    instanceId: number,
  ): Promise<OrbitInstanceWakeOutcome> => {
    const deadline = now() + ORBIT_WAKE_TIMEOUT_MS;
    const key = newKey(instanceId);
    try {
      let operation: OrbitGatewayWakeOperation | null = null;
      for (let attempt = 0; operation === null; attempt += 1) {
        try {
          operation = await client.wakeInstance(instanceId, key);
        } catch (error) {
          if (isOrbitGatewayError(error) && BUSY_CODES.has(error.code) && attempt < BUSY_RETRIES) {
            await sleep(BUSY_RETRY_MS);
            continue;
          }
          throw error;
        }
      }
      while (OPEN_STATUSES.has(operation.status)) {
        if (now() >= deadline) {
          return {
            kind: "failed",
            code: "operation.timeout",
            message: `Orbit did not wake Instance ${instanceId} in time.`,
          };
        }
        await sleep(operationPollDelayMs(operation.pollAfterSeconds));
        operation = await client.wakeOperation(operation.id);
      }
      if (operation.status === "succeeded") return { kind: "awake" };
      return {
        kind: "failed",
        code: operation.errorCode ?? "operation.failed",
        message: `Orbit could not wake Instance ${instanceId}: the Operation ${operation.status}.`,
      };
    } catch (error) {
      if (isOrbitGatewayError(error)) {
        if (error.status === 404 || error.status === 405) return { kind: "unsupported" };
        return { kind: "failed", code: error.code, message: error.message };
      }
      return {
        kind: "failed",
        code: "gateway.unreachable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    wake: (client, instanceId) => {
      const existing = running.get(instanceId);
      if (existing) return existing;
      const started = run(client, instanceId).finally(() => running.delete(instanceId));
      running.set(instanceId, started);
      return started;
    },
    inFlight: (instanceId) => running.has(instanceId),
  };
}
