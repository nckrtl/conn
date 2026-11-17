import { CircleAlertIcon } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";

import { Spinner } from "../components/ui/spinner";
import { cn } from "../lib/utils";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import {
  ORBIT_LAUNCH_PHASE_LABELS,
  orbitLaunchNeedsAttention,
} from "@t3tools/client-runtime/orbit-gateway";
import { useOrbitLaunches } from "./orbitLaunches";
import { OrbitLaunchRecovery } from "./OrbitLaunchRecovery";

/**
 * Conn: the threads started from the palette in an Orbit Project whose clone has not taken the
 * first message yet, so the user can leave a pending thread and come back. The real thread's row
 * takes over once it is sent.
 */
export function OrbitPendingThreadList() {
  const available = useOrbitThreadsAvailable();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const state = useOrbitLaunches();
  const starts = state.launches.filter(orbitLaunchNeedsAttention);
  if (!available) return null;
  return (
    <>
      <OrbitLaunchRecovery />
      {state.error ? (
        <p className="px-2 text-ui text-muted-foreground">Could not refresh Orbit launches.</p>
      ) : null}
      {starts.length > 0 ? (
        <ul className="mt-1 grid grid-cols-1 gap-0.5" aria-label="Threads being set up">
          {starts.map((start) => {
            const active = pathname === `/orbit/${start.launch_id}`;
            return (
              <li key={start.launch_id}>
                <Link
                  to="/orbit/$startId"
                  params={{ startId: start.launch_id }}
                  aria-current={active ? "page" : undefined}
                  data-orbit-pending-row={start.phase === "needs_retry" ? "failed" : "running"}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-ui text-sidebar-muted-foreground hover:bg-accent",
                    active && "bg-accent text-sidebar-foreground",
                  )}
                >
                  {start.phase === "needs_retry" ? (
                    <CircleAlertIcon className="size-3.5 shrink-0 text-destructive-foreground" />
                  ) : (
                    <Spinner size="sm" className="shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                    {start.instance_id === null
                      ? `Orbit project #${start.project_id}`
                      : `Instance #${start.instance_id}`}
                  </span>
                  <span className="shrink-0 text-xs">{ORBIT_LAUNCH_PHASE_LABELS[start.phase]}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
