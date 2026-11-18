import { useNavigate, useRouter } from "@tanstack/react-router";
import { T, msg, useGT } from "gt-react";
import { useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { m } from "../i18n/messages";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { buildThreadRouteParams } from "../threadRoutes";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { OrbitLaunchProgress } from "./OrbitLaunchProgress";
import { attachOrbitLaunchThread, orbitLaunches, useOrbitLaunches } from "./orbitLaunches";

export function OrbitPendingThreadView({ startId }: { startId: string }) {
  const gt = useGT();
  const state = useOrbitLaunches();
  const launch = state.launches.find((row) => row.launch_id === startId);
  const navigate = useNavigate();
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openThread = async () => {
    if (!launch?.thread || opening) return;
    const origin = router.state.location.pathname;
    setOpening(true);
    setError(null);
    try {
      const ref = await attachOrbitLaunchThread(launch.thread);
      if (router.state.location.pathname === origin) {
        await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m(msg("Could not open the thread.")));
    }
    setOpening(false);
  };
  return (
    <PendingThreadShell
      startId={startId}
      header={
        <span className="text-ui font-medium">
          <T>Orbit launch</T>
        </span>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both bg-background">
        <div className="mx-auto grid w-full max-w-(--chat-content-max-width) gap-4 px-3 py-6">
          {launch ? (
            <>
              <OrbitLaunchProgress launch={launch} stale={state.error !== null} />
              {launch.thread ? (
                <div>
                  <Button variant="outline" disabled={opening} onClick={() => void openThread()}>
                    <T>Open thread</T>
                  </Button>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-ui text-destructive-foreground">
                  {error}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p role="status" className="text-ui text-muted-foreground">
                {state.error ??
                  (state.loaded ? gt("Orbit does not show this launch.") : gt("Loading launch…"))}
              </p>
              <div>
                <Button variant="outline" onClick={() => void orbitLaunches.refresh()}>
                  <T>Refresh</T>
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </PendingThreadShell>
  );
}

/** ChatView's frame: the shell fill, its header height and its card, so the handover keeps them. */
function PendingThreadShell({
  startId,
  header,
  children,
}: {
  startId?: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarInset className="h-full" data-orbit-pending-thread={startId}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--shell-fill) backdrop-blur-(--shell-blur) backdrop-saturate-(--shell-saturate)">
        <header
          className={cn(
            "flex h-(--shell-header-height) min-h-(--shell-header-height) shrink-0 items-center gap-3",
            isElectron
              ? "drag-region px-3 sm:px-5"
              : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {header}
        </header>
        <div
          data-shell-sidebar-edge=""
          className="relative z-0 mr-(--shell-inset) mb-(--shell-inset) flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tr-(--shell-corner) rounded-br-(--shell-corner) shell-inner-panel [--background:var(--shell-card)]"
        >
          {children}
        </div>
      </div>
    </SidebarInset>
  );
}
