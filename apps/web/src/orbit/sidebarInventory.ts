import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * Conn: one untrimmed read of an environment's shell over the existing HTTP shell route, without
 * `omitOlderSettled` or `omitIdleSubagents`. The rows only feed the sidebar marks of a Tasks
 * peek; they never reach the shell state the sidebar lists from.
 */
const inventoryRead = createRuntimeCommand(connectionAtomRuntime, {
  label: "conn:sidebar-hidden-threads:inventory",
  execute: Effect.fn("SidebarHiddenThreads.readInventory")(function* (
    environmentId: EnvironmentId,
  ) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const loader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
    return yield* registry.run(
      environmentId,
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared)) return null;
        const answer = yield* loader.load(prepared.value, {});
        if (Option.isNone(answer) || "resumable" in answer.value) return null;
        return answer.value.threads.map((thread) => String(thread.id));
      }),
    );
  }),
});

/** Every active thread id of the environment, or null when the read failed (retry later). */
export async function readSidebarThreadInventory(environmentId: string): Promise<string[] | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    inventoryRead,
    environmentId as EnvironmentId,
    { reportFailure: false },
  );
  return result._tag === "Success" ? result.value : null;
}
