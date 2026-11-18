import { useAtomValue } from "@effect/atom-react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  createOrbitLaunchThreadRowsAtom,
  ORBIT_LAUNCH_PHASE_LABELS,
} from "@t3tools/client-runtime/orbit-gateway";
import { T, useGT, useMessages } from "gt-react";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

import { Spinner } from "../components/ui/spinner";
import { environmentCatalog } from "../connection/catalog";
import { cn } from "../lib/utils";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentThreadShells } from "../state/threads";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import { orbitLaunches } from "./orbitLaunches";
import { OrbitLaunchRecovery } from "./OrbitLaunchRecovery";

const orbitLaunchRowsAtom = createOrbitLaunchThreadRowsAtom({
  observer: orbitLaunches,
  threadRefsAtom: environmentThreadShells.threadRefsAtom,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  archivedSnapshotAtom: (environmentId) =>
    orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} }),
});

export function OrbitPendingThreadList() {
  const gt = useGT();
  const messages = useMessages();
  const available = useOrbitThreadsAvailable();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { snapshot, rows } = useAtomValue(orbitLaunchRowsAtom);
  if (!available) return null;
  return (
    <>
      <OrbitLaunchRecovery />
      {snapshot.error ? (
        <p className="px-2 text-ui text-muted-foreground">
          <T>Could not refresh Orbit launches.</T>
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="mt-1 grid grid-cols-1 gap-0.5" aria-label={gt("Orbit launches")}>
          {rows.map((start) => {
            const active = pathname === `/orbit/${start.launch_id}`;
            return (
              <li key={start.launch_id}>
                <Link
                  to="/orbit/$startId"
                  params={{ startId: start.launch_id }}
                  aria-current={active ? "page" : undefined}
                  data-orbit-pending-row={start.phase}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-ui text-sidebar-muted-foreground hover:bg-accent",
                    active && "bg-accent text-sidebar-foreground",
                  )}
                >
                  {start.phase === "needs_retry" ? (
                    <CircleAlertIcon className="size-3.5 shrink-0 text-destructive-foreground" />
                  ) : start.phase === "ready" ? (
                    <CircleCheckIcon className="size-3.5 shrink-0" />
                  ) : (
                    <Spinner size="sm" className="shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                    {start.instance_id === null
                      ? gt("Orbit project #{id}", { id: start.project_id })
                      : gt("Instance #{id}", { id: start.instance_id })}
                  </span>
                  <span className="shrink-0 text-xs">
                    {messages(ORBIT_LAUNCH_PHASE_LABELS[start.phase])}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
