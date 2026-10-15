import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironment } from "../state/environments";
import { checkOrbitAvailability, type OrbitAvailability } from "./orbitInstances";
import { createTerminalOrbitTransport, runHiddenShell } from "./orbitTransport";

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<
  string,
  { readonly at: number; readonly result: Promise<OrbitAvailability> }
>();

function cacheKey(environmentId: EnvironmentId, projectRoot: string): string {
  return `${environmentId}\u0000${projectRoot}`;
}

/** Whether "New Orbit instance" works for this project; cached for a few minutes. */
export function getOrbitAvailability(
  environmentId: EnvironmentId,
  projectRoot: string,
  options?: { readonly fresh?: boolean },
): Promise<OrbitAvailability> {
  const key = cacheKey(environmentId, projectRoot);
  const cached = cache.get(key);
  if (cached && !options?.fresh && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }
  const result = checkOrbitAvailability(
    createTerminalOrbitTransport({ environmentId, cwd: projectRoot }),
    (script, timeoutSeconds) =>
      runHiddenShell({ environmentId, cwd: projectRoot, script, timeoutSeconds }),
    projectRoot,
  );
  cache.set(key, { at: Date.now(), result });
  // A failed check should not stick for the whole TTL.
  void result.then((availability) => {
    if (!availability.available && cache.get(key)?.result === result) {
      cache.set(key, { at: Date.now() - CACHE_TTL_MS + 30_000, result });
    }
  });
  return result;
}

export type OrbitAvailabilityState = { readonly status: "checking" } | OrbitAvailability;

export function useOrbitAvailability(input: {
  readonly environmentId: EnvironmentId;
  readonly projectRoot: string | null;
  /** Check only once the user looks at the option. */
  readonly enabled: boolean;
}): OrbitAvailabilityState | null {
  const { enabled, environmentId, projectRoot } = input;
  const key = projectRoot === null ? null : cacheKey(environmentId, projectRoot);
  // The check runs a shell over the environment's connection. Before that connection is up
  // (right after a page load) the shell cannot open, and that failure would stick in the menu.
  const environment = useEnvironment(projectRoot === null ? null : environmentId);
  const connected = environment?.connection.phase === "connected";
  const [state, setState] = useState<{
    readonly key: string;
    readonly value: OrbitAvailability;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !connected || projectRoot === null || key === null) return;
    let cancelled = false;
    void getOrbitAvailability(environmentId, projectRoot).then((value) => {
      if (!cancelled) setState({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [connected, enabled, environmentId, key, projectRoot]);
  if (key === null) return null;
  if (state?.key === key) return state.value;
  return enabled ? { status: "checking" } : null;
}
