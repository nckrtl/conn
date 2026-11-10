import { useEffect, useRef, useState } from "react";

import { hasProcessWarning } from "./orbit";
import type { OrbitPage, OrbitProcess, OrbitSource, ProcessAction } from "./orbit";

export type OrbitState =
  | { readonly status: "loading" }
  /** Not an Orbit page, or Orbit is not reachable from this thread's machine. */
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly page: OrbitPage;
      readonly processes: readonly OrbitProcess[];
      /** The last start, stop or restart that failed. */
      readonly error: string | null;
    };

export interface OrbitTool {
  readonly state: OrbitState;
  readonly warnings: Partial<Record<"processes" | "composer" | "javascript", string>>;
  readonly source: OrbitSource | null;
  readonly refresh: () => Promise<void>;
  readonly act: (process: OrbitProcess, action: ProcessAction) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Orbit did not answer.";
}

type Loaded = Exclude<OrbitState, { readonly status: "loading" }>;

/** The page's Orbit Instance and its processes; loads once per source (page domain). */
export function useOrbit(source: OrbitSource | null): OrbitTool {
  // Results are keyed by source, so a new page never shows the previous page's processes.
  const [loaded, setLoaded] = useState<{ readonly source: OrbitSource; readonly state: Loaded }>();
  const pageRef = useRef<OrbitPage | null>(null);
  // Each call is a short script on the thread's machine; never run two refreshes at once.
  const refreshing = useRef<Promise<void> | null>(null);
  const state: OrbitState = !source
    ? { status: "none" }
    : loaded?.source === source
      ? loaded.state
      : { status: "loading" };

  const update = (next: (current: Loaded) => Loaded) => {
    setLoaded((current) =>
      current && current.source === source
        ? { source: current.source, state: next(current.state) }
        : current,
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the Orbit page from the thread's machine when the source changes
  useEffect(() => {
    pageRef.current = null;
    if (!source) return;
    let cancelled = false;
    void (async () => {
      let next: Loaded = { status: "none" };
      try {
        const page = await source.page();
        if (page) {
          const processes = await source.processes(page.instanceId);
          next = { status: "ready", page, processes, error: null };
          if (!cancelled) pageRef.current = page;
        }
      } catch {
        // Orbit is not reachable from this machine; the tool stays hidden.
      }
      if (!cancelled) setLoaded({ source, state: next });
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const refresh = async () => {
    const page = pageRef.current;
    if (!source || !page) return;
    if (refreshing.current) return refreshing.current;
    refreshing.current = source
      .processes(page.instanceId)
      .then((processes) => {
        if (pageRef.current !== page) return;
        update((current) => (current.status === "ready" ? { ...current, processes } : current));
      })
      .catch(() => {})
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  };

  const act = async (process: OrbitProcess, action: ProcessAction) => {
    if (!source) return;
    update((current) => (current.status === "ready" ? { ...current, error: null } : current));
    try {
      await source.act(process.id, action);
    } catch (error) {
      update((current) =>
        current.status === "ready"
          ? { ...current, error: `Could not ${action} ${process.name}: ${message(error)}` }
          : current,
      );
    }
    await refresh();
  };

  const warnings: OrbitTool["warnings"] =
    state.status === "ready" && hasProcessWarning(state.processes)
      ? { processes: "Some processes are not running" }
      : {};
  return { state, source, refresh, act, warnings };
}
