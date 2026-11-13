import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type AnyRouter, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { buildThreadRouteParams } from "../threadRoutes";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import { ORBIT_INSTANCE_STAYS_LINE } from "./orbitSetupView";
import { openOrbitInstanceById } from "./openOrbitInstance";
import { orbitStartDraftTarget } from "./OrbitPendingThreadView";
import { readOrbitEnvironments } from "./orbitPaletteProjects";
import {
  dismissOrbitThreadStart,
  orbitPendingThreadPath,
  runSavedOrbitThreadStart,
} from "./orbitThreadStarts";
import { readStored, useOrbitThreadStarts } from "./orbitThreadStartStore";

/**
 * Runs the saved thread starts. Mounted once, in the main window, so no start runs twice. A start's
 * pending thread hands over and shows its error itself; elsewhere a toast does.
 */
export function OrbitThreadStartRunner() {
  const available = useOrbitThreadsAvailable();
  const starts = useOrbitThreadStarts((state) => state.starts);
  const navigate = useNavigate();
  const router = useRouter();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs each saved start that has not stopped
  useEffect(() => {
    const client = desktopOrbitGatewayClient();
    if (!available || client === null) return;
    for (const start of starts) {
      // A sent start is kept only for its thread's ready row.
      if (start.error !== null || (start.sentAt != null && start.pendingThread)) continue;
      void runSavedOrbitThreadStart(client, start.id, {
        onCancelled: () =>
          toastManager.add({
            type: "info",
            title: "Instance setup cancelled",
            description: ORBIT_INSTANCE_STAYS_LINE,
          }),
      }).then((sent) => {
        if (sent !== null && sent.threadId === null) {
          void finishOrbitPlusStart(router, start.id);
          return;
        }
        if (router.state.location.pathname === orbitPendingThreadPath(start.id)) return;
        if (sent !== null) {
          const id = toastManager.add({
            type: "success",
            title: `Thread started in ${start.projectSlug}`,
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(id);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(
                    scopeThreadRef(sent.environmentId, sent.threadId!),
                  ),
                });
              },
            },
          });
          return;
        }
        const stopped = useOrbitThreadStarts
          .getState()
          .starts.find((entry) => entry.id === start.id);
        if (stopped?.error) {
          toastManager.add({
            type: "error",
            title: `Could not start the thread in ${stopped.projectSlug}`,
            description: stopped.error,
          });
        }
      });
    }
  }, [available, navigate, router, starts]);

  return null;
}

/** Starts whose Instance is being opened, so a re-run of the runner opens it only once. */
const finishing = new Set<string>();

/**
 * The end of a start with no message (the palette's plus), once its Instance is connected: from
 * its pending thread Conn opens what picking that Instance in the palette opens, a new-thread
 * draft there; elsewhere nothing moves. Then the start is done and its row leaves the sidebar.
 */
export async function finishOrbitPlusStart(router: AnyRouter, startId: string): Promise<void> {
  // The saved start, not the runner's snapshot: only it knows the created Instance.
  const start = readStored().find((entry) => entry.id === startId);
  if (start === undefined || finishing.has(start.id) || start.instanceId === null) return;
  finishing.add(start.id);
  try {
    if (router.state.location.pathname === orbitPendingThreadPath(start.id)) {
      const target = orbitStartDraftTarget(start);
      const result = await openOrbitInstanceById({
        router,
        project: {
          id: target.projectId,
          slug: target.projectSlug,
          name: target.projectName,
          nodeName: target.nodeName,
          domainSuffix: target.domainSuffix,
        },
        instance: { id: start.instanceId, name: start.instanceName },
        environments: readOrbitEnvironments,
      }).catch((error: unknown) => ({
        kind: "unavailable" as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
      if (result.kind === "unavailable") {
        toastManager.add({
          type: "error",
          title: `Could not open Instance ${start.instanceName}`,
          description: result.reason,
        });
        void router.navigate({ to: "/", replace: true });
      }
    }
    dismissOrbitThreadStart(start.id);
  } finally {
    finishing.delete(start.id);
  }
}
