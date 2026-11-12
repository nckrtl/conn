import { useAtomValue } from "@effect/atom-react";
import type {
  OrbitGatewayClient,
  OrbitGatewayInstanceNameCheck,
} from "@t3tools/client-runtime/orbit-gateway";
import { useEffect } from "react";
import { create } from "zustand";

import type { OrbitPaletteProjectsState } from "../components/CommandPalette.logic";
import { environmentCatalog } from "../connection/catalog";
import { useClientSettings } from "../hooks/useSettings";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";

type LoadState = Exclude<OrbitPaletteProjectsState, { status: "off" }>;

const useOrbitPaletteProjectsStore = create<{
  readonly state: LoadState;
  readonly generation: number;
}>(() => ({ state: { status: "loading" }, generation: 0 }));

/**
 * Conn: reads the Orbit Projects and the Gateway's environment list (for the instance counts).
 * A refresh after a good read keeps showing it; a later answer replaces an earlier one.
 * Resolves whether the Gateway answered.
 */
export async function loadOrbitPaletteProjects(
  client: OrbitGatewayClient,
  options?: { readonly keepLoadedOnFailure?: boolean },
): Promise<boolean> {
  const { state, generation } = useOrbitPaletteProjectsStore.getState();
  const current = generation + 1;
  useOrbitPaletteProjectsStore.setState({
    generation: current,
    state: state.status === "loaded" ? state : { status: "loading" },
  });
  let next: LoadState;
  try {
    const [projects, environments] = await Promise.all([
      client.projects({ includeUnavailable: true }),
      client.environments(),
    ]);
    next = { status: "loaded", projects, environments };
  } catch {
    if (options?.keepLoadedOnFailure && state.status === "loaded") return false;
    next = { status: "unreachable" };
  }
  if (useOrbitPaletteProjectsStore.getState().generation === current) {
    useOrbitPaletteProjectsStore.setState({ state: next });
  }
  return next.status === "loaded";
}

export function retryOrbitPaletteProjects(): void {
  const client = desktopOrbitGatewayClient();
  if (client) void loadOrbitPaletteProjects(client);
}

/** The checks page's "Check again": a failed read keeps the last good list. */
export async function recheckOrbitPaletteProjects(): Promise<boolean> {
  const client = desktopOrbitGatewayClient();
  return client ? loadOrbitPaletteProjects(client, { keepLoadedOnFailure: true }) : false;
}

/** `off` unless the Labs switch is on and this is the desktop app in Orbit mode. */
export function useOrbitPaletteProjects(listShown: boolean): OrbitPaletteProjectsState {
  const switchOn = useClientSettings((settings) => settings.orbitThreadsInPaletteEnabled);
  const enabled = useOrbitThreadsAvailable() && switchOn;
  const state = useOrbitPaletteProjectsStore((store) => store.state);
  const active = enabled && listShown;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Gateway each time the New thread list opens
  useEffect(() => {
    if (!active) return;
    const client = desktopOrbitGatewayClient();
    if (client) void loadOrbitPaletteProjects(client);
  }, [active]);
  return enabled ? state : { status: "off" };
}

/** Orbit's live check of a new Instance name; fails like any Gateway call, or without the bridge. */
export async function checkOrbitInstanceName(
  projectId: number,
  name: string,
): Promise<OrbitGatewayInstanceNameCheck> {
  const client = desktopOrbitGatewayClient();
  if (client === null) throw new Error("The Orbit Gateway is not available here.");
  return client.checkInstanceName(projectId, name);
}

/** The environments this device has paired with (saved in its catalog). */
export function useOrbitPairedEnvironmentIds(): ReadonlySet<string> {
  return new Set(useAtomValue(environmentCatalog.catalogValueAtom).entries.keys());
}
