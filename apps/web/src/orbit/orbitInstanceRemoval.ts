import {
  orbitInstanceRemoveKey,
  removeOrbitInstance,
  type OrbitInstanceGitState,
  type OrbitInstanceRemoveOutcome,
  type OrbitInstanceRemovePorts,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { forgetOrbitInstanceEnvironment, orbitInstanceEnvironmentIds } from "./environmentProvider";
import { loadOrbitInstanceList } from "./orbitInstanceList";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import { dropOrbitInstanceStarts } from "./orbitThreadStartStore";

/** Conn: removing an Instance from the Orbit panel (DESIGN.md, "Orbit panel and Manage Instances"). */

export interface OrbitInstanceCleanupPorts {
  /** The Instance's saved servers the last Gateway sync knew. */
  readonly knownEnvironmentIds: (instanceId: number) => readonly string[];
  /** Removes a saved server: its stored pairing credential and its cached threads. */
  readonly removeEnvironment: (environmentId: string) => Promise<void>;
  /** Drops the Orbit provider's pairing records and Orbit facts of a server. */
  readonly forgetEnvironment: (environmentId: string) => void;
  /** Drops the saved thread-start records of the Instance. */
  readonly dropThreadStarts: (instanceId: number, environmentIds: readonly string[]) => void;
}

/**
 * Everything Conn keeps of an Instance Orbit removed. Every step runs even when one fails, so a
 * server that cannot be removed does not leave the others; the first failure is thrown after.
 */
export async function cleanUpRemovedOrbitInstance(
  instance: { readonly id: number; readonly environmentId: string | null },
  ports: OrbitInstanceCleanupPorts,
): Promise<void> {
  const environmentIds = [
    ...new Set([
      ...(instance.environmentId === null ? [] : [instance.environmentId]),
      ...ports.knownEnvironmentIds(instance.id),
    ]),
  ];
  // First, so the environment sync no longer holds the Instance for a thread start.
  ports.dropThreadStarts(instance.id, environmentIds);
  const failures: unknown[] = [];
  for (const environmentId of environmentIds) {
    try {
      await ports.removeEnvironment(environmentId);
    } catch (error) {
      failures.push(error);
    }
    ports.forgetEnvironment(environmentId);
  }
  if (failures.length > 0) throw failures[0];
}

export const webOrbitInstanceCleanupPorts: OrbitInstanceCleanupPorts = {
  knownEnvironmentIds: orbitInstanceEnvironmentIds,
  removeEnvironment: async (environmentId) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.remove,
      environmentId as EnvironmentId,
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw new Error(`Could not remove the server ${environmentId}.`);
  },
  forgetEnvironment: forgetOrbitInstanceEnvironment,
  dropThreadStarts: dropOrbitInstanceStarts,
};

export type OrbitInstanceRemoval =
  | { readonly status: "removing" }
  | { readonly status: "failed"; readonly message: string; readonly acknowledgeUnsaved: boolean }
  /** Orbit removed it; the row stays hidden even if a list read still carries it. */
  | { readonly status: "removed" };

/** The row state of each Instance being removed, by Instance id; this window only. */
export const useOrbitInstanceRemovals = create<{
  readonly byInstance: Readonly<Record<number, OrbitInstanceRemoval>>;
}>(() => ({ byInstance: {} }));

function setRemoval(instanceId: number, removal: OrbitInstanceRemoval | null): void {
  useOrbitInstanceRemovals.setState(({ byInstance }) => {
    const { [instanceId]: _previous, ...rest } = byInstance;
    return { byInstance: removal === null ? rest : { ...rest, [instanceId]: removal } };
  });
}

export interface OrbitInstanceRemovalPorts {
  readonly gateway: OrbitInstanceRemovePorts | null;
  readonly cleanup: OrbitInstanceCleanupPorts;
  readonly reloadList: () => Promise<void>;
}

export function webOrbitInstanceRemovalPorts(): OrbitInstanceRemovalPorts {
  const client = desktopOrbitGatewayClient();
  return {
    gateway:
      client === null
        ? null
        : {
            client,
            now: Date.now,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          },
    cleanup: webOrbitInstanceCleanupPorts,
    reloadList: loadOrbitInstanceList,
  };
}

/**
 * One remove attempt (the dialog's Remove Instance, or the row's Retry): the row reads
 * "Removing…", then goes, or shows the failure with Retry.
 * `unsaved_work` clears the row; the caller opens the dialog again with Orbit's Git state.
 */
export async function runOrbitInstanceRemoval(
  instance: {
    readonly id: number;
    readonly environmentId: string | null;
    readonly git?: OrbitInstanceGitState;
  },
  acknowledgeUnsaved: boolean,
  ports: OrbitInstanceRemovalPorts,
): Promise<OrbitInstanceRemoveOutcome> {
  const current = useOrbitInstanceRemovals.getState().byInstance[instance.id]?.status;
  if (current === "removing" || current === "removed") {
    return { kind: "failed", code: "conn.remove_running", message: "Removing already." };
  }
  setRemoval(instance.id, { status: "removing" });
  const outcome: OrbitInstanceRemoveOutcome =
    ports.gateway === null
      ? {
          kind: "failed",
          code: "gateway.unavailable",
          message: "The Orbit Gateway is not available here.",
        }
      : await removeOrbitInstance(ports.gateway, {
          instanceId: instance.id,
          acknowledgeUnsaved,
          idempotencyKey: orbitInstanceRemoveKey(instance.id, ports.gateway.now()),
          ...(instance.git ? { git: instance.git } : {}),
        });
  if (outcome.kind === "failed") {
    setRemoval(instance.id, { status: "failed", message: outcome.message, acknowledgeUnsaved });
    return outcome;
  }
  if (outcome.kind === "unsaved_work") {
    setRemoval(instance.id, null);
    return outcome;
  }
  setRemoval(instance.id, { status: "removed" });
  // Orbit removed it; a cleanup failure must not show the row as "Could not remove".
  await cleanUpRemovedOrbitInstance(instance, ports.cleanup).catch(() => undefined);
  await ports.reloadList();
  return outcome;
}
