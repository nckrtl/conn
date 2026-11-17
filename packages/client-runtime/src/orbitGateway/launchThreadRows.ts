import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { createOrbitLaunchObserver } from "./launchObserver.ts";
import { orbitLaunchNeedsAttention } from "./launches.ts";

export function createOrbitLaunchThreadRowsAtom(input: {
  observer: Pick<ReturnType<typeof createOrbitLaunchObserver>, "subscribe" | "view">;
  threadRefsAtom: Atom.Atom<readonly ScopedThreadRef[]>;
  catalogValueAtom: Atom.Atom<{
    isReady: boolean;
    entries: ReadonlyMap<EnvironmentId, { enabled: boolean }>;
  }>;
  archivedSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, unknown>>;
}) {
  const snapshotAtom = Atom.make((get) => {
    get.addFinalizer(input.observer.subscribe(() => get.setSelf(input.observer.view())));
    return input.observer.view();
  });
  return Atom.make((get) => {
    const snapshot = get(snapshotAtom);
    const previous = get.self<{ handedOff: ReadonlySet<string> }>();
    const previousHandoffs =
      previous._tag === "Some" ? previous.value.handedOff : new Set<string>();
    const handedOff = new Set(snapshot.loaded && snapshot.error === null ? [] : previousHandoffs);
    const knownThreads = snapshot.launches.length > 0 ? get(input.threadRefsAtom) : [];
    const rows = snapshot.launches.filter((launch) => {
      const { thread } = launch;
      const needsAttention = orbitLaunchNeedsAttention(launch);
      if (thread === null) return needsAttention;
      if (
        previousHandoffs.has(launch.launch_id) ||
        knownThreads.some(
          (ref) => ref.environmentId === thread.environment_id && ref.threadId === thread.thread_id,
        )
      ) {
        handedOff.add(launch.launch_id);
        return needsAttention;
      }
      if (needsAttention || launch.phase !== "ready") return needsAttention;

      const environmentId = EnvironmentId.make(thread.environment_id);
      const catalog = get(input.catalogValueAtom);
      if (!catalog.isReady) return false;
      if (catalog.entries.get(environmentId)?.enabled === true) {
        const archive = get(input.archivedSnapshotAtom(environmentId));
        if (
          AsyncResult.isSuccess(archive) &&
          archive.value.threads.some((row) => row.id === thread.thread_id)
        ) {
          handedOff.add(launch.launch_id);
          return false;
        }
        if (archive._tag === "Initial" || archive.waiting) return false;
      }
      return true;
    });
    return { snapshot, rows, handedOff };
  });
}
