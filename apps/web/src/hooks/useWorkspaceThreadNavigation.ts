import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMatches, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  useAllEnvironmentShellsBootstrapped,
  useDelegatedUnderParent,
  useThreadShells,
} from "../state/entities";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { lastWorkspaceThread, workspaceThreads } from "../workspaceActivity.logic";
import { useActiveWorkspaceProjectRefs, useWorkspaceStore } from "../workspaceStore";

/** Keep navigation in the client; socket selections and rail selections share it. */
export function useWorkspaceThreadNavigation() {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const projectRefs = useActiveWorkspaceProjectRefs();
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const ready = useAllEnvironmentShellsBootstrapped();
  const route = useParams({ strict: false, select: resolveThreadRouteRef });
  const navigate = useNavigate();
  // Matches, not location, so this agrees with the params `route` reads (see _chat.tsx).
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const previousWorkspace = useRef(workspaceId);
  const pending = useRef<string | null>(null);
  const routeKey = route ? JSON.stringify([route.environmentId, route.threadId]) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the router to the workspace's last thread when the selected workspace changes
  useEffect(() => {
    const changed = previousWorkspace.current !== workspaceId;
    // Settings and Usage stay open: a profile sync can change the selection under them.
    if (changed && (!ready || modalOpen)) return;
    const candidates = workspaceThreads(threads, projectRefs, delegatedUnderParent);
    const current = candidates.find(
      (thread) => thread.environmentId === route?.environmentId && thread.id === route?.threadId,
    );
    if (changed) {
      const previous = previousWorkspace.current;
      previousWorkspace.current = workspaceId;
      useUiStateStore.getState().setSidebarProjectScopeKeys([]);
      // A removed selection falls back to All; keep a draft, a page or a thread All still lists.
      const disappeared =
        workspaceId === null &&
        previous !== null &&
        !useWorkspaceStore.getState().workspaces.some((workspace) => workspace.id === previous);
      if (!disappeared || (route !== null && !current)) {
        const target = lastWorkspaceThread(
          candidates,
          useWorkspaceStore.getState().lastThreadByWorkspace[workspaceId ?? "all"],
          useUiStateStore.getState().threadLastVisitedAtById,
        );
        pending.current = routeKey;
        if (target)
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        else void navigate({ to: "/" });
        return;
      }
    } else if (pending.current !== null) {
      // The old route can render once more while a workspace switch navigates.
      if (pending.current === routeKey) return;
      pending.current = null;
    }
    if (current)
      useWorkspaceStore
        .getState()
        .rememberThread(workspaceId, scopeThreadRef(current.environmentId, current.id));
  }, [
    delegatedUnderParent,
    modalOpen,
    navigate,
    projectRefs,
    ready,
    route,
    routeKey,
    threads,
    workspaceId,
  ]);
}
