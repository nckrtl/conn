import { useEffect } from "react";

import { useOrbitThreadsAvailable } from "./environmentProvider";
import { desktopOrbitGatewayClient, useOrbitProfileSyncStatus } from "./OrbitProfileSync";
import { orbitLaunches } from "./orbitLaunches";

export function OrbitLaunchObserver({ mainWindow }: { mainWindow: boolean }) {
  const available = useOrbitThreadsAvailable();
  const profileId = useOrbitProfileSyncStatus((state) => state.profileId);
  const nodeId = useOrbitProfileSyncStatus((state) => state.nodeId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the current profile's Orbit snapshots
  useEffect(() => {
    if (!available || mainWindow) {
      orbitLaunches.setScope(
        available && profileId !== null && nodeId !== null ? { profileId, nodeId } : null,
      );
      return () => orbitLaunches.setScope(null);
    }
    // Additional windows do not run profile sync. Read their binding without writing profile data.
    let active = true;
    let requested = 0;
    const loadScope = async () => {
      requested += 1;
      const request = requested;
      try {
        const me = await desktopOrbitGatewayClient()?.me();
        if (active && request === requested) {
          orbitLaunches.setScope(me?.profile ? { profileId: me.profile.id, nodeId: me.id } : null);
        }
      } catch {
        // The launch observer reports connection errors separately from operation phases.
      }
    };
    const refresh = () => {
      void loadScope();
    };
    refresh();
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
      orbitLaunches.setScope(null);
    };
  }, [available, mainWindow, profileId, nodeId]);
  return null;
}
