import type { OrbitGatewayClient } from "@t3tools/client-runtime/orbit-gateway";
import { useEffect } from "react";
import { create } from "zustand";

import type { OrbitPaletteProjectsState } from "../components/CommandPalette.logic";
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
 */
export async function loadOrbitPaletteProjects(client: OrbitGatewayClient): Promise<void> {
  const { state, generation } = useOrbitPaletteProjectsStore.getState();
  const current = generation + 1;
  useOrbitPaletteProjectsStore.setState({
    generation: current,
    state: state.status === "loaded" ? state : { status: "loading" },
  });
  let next: LoadState;
  try {
    const [projects, environments] = await Promise.all([client.projects(), client.environments()]);
    next = { status: "loaded", projects, environments };
  } catch {
    next = { status: "unreachable" };
  }
  if (useOrbitPaletteProjectsStore.getState().generation === current) {
    useOrbitPaletteProjectsStore.setState({ state: next });
  }
}

export function retryOrbitPaletteProjects(): void {
  const client = desktopOrbitGatewayClient();
  if (client) void loadOrbitPaletteProjects(client);
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
