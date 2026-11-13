import { CircleAlertIcon } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";

import { Spinner } from "../components/ui/spinner";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { cn } from "../lib/utils";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import { useOrbitThreadStarts } from "./orbitThreadStartStore";

/**
 * Conn: the threads started from the palette in an Orbit Project whose clone has not taken the
 * first message yet, so the user can leave a pending thread and come back. The real thread's row
 * takes over once it is sent.
 */
export function OrbitPendingThreadList() {
  const available = useOrbitThreadsAvailable();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const starts = useOrbitThreadStarts((state) => state.starts).filter(
    // A start that waits for its Cancel to reach Orbit is hidden until it ends or fails.
    (start) =>
      start.pendingThread &&
      start.sentAt == null &&
      !(start.cancelRequested && start.error === null),
  );
  // The plus's drafts that still exist; a discarded one leaves its start to the pending thread.
  const liveDrafts = useComposerDraftStore((state) =>
    starts
      .flatMap((start) =>
        start.draftId && state.getDraftSession(start.draftId as DraftId) !== null
          ? [start.draftId]
          : [],
      )
      .join(" "),
  ).split(" ");
  if (!available || starts.length === 0) return null;
  return (
    <ul className="mt-1 grid grid-cols-1 gap-0.5" aria-label="Threads being set up">
      {starts.map((start) => {
        // A start the plus made opens its draft until it has a message; the row then names the Instance.
        const draftId =
          start.message === "" && start.draftId && liveDrafts.includes(start.draftId)
            ? start.draftId
            : null;
        // Ready and waiting for its first message: nothing runs, so no spinner.
        const waiting = start.message === "" && start.connected && start.error === null;
        const active = pathname === (draftId === null ? `/orbit/${start.id}` : `/draft/${draftId}`);
        const linkProps =
          draftId === null
            ? ({ to: "/orbit/$startId", params: { startId: start.id } } as const)
            : ({ to: "/draft/$draftId", params: { draftId } } as const);
        return (
          <li key={start.id}>
            <Link
              {...linkProps}
              aria-current={active ? "page" : undefined}
              data-orbit-pending-row={start.error ? "failed" : "running"}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1 text-ui text-sidebar-muted-foreground hover:bg-accent",
                active && "bg-accent text-sidebar-foreground",
              )}
            >
              {start.error ? (
                <CircleAlertIcon className="size-3.5 shrink-0 text-destructive-foreground" />
              ) : waiting ? (
                <span className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <Spinner size="sm" className="shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                {start.message.split("\n")[0] || start.instanceName}
              </span>
              <span className="shrink-0 text-xs">
                {start.error ? "Setup failed" : start.projectSlug}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
