import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAllEnvironmentShellsBootstrapped, useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { lastWorkspaceThread, workspaceThreads } from "../workspaceActivity.logic";
import { useActiveWorkspaceProjectRefs, useWorkspaceStore } from "../workspaceStore";

/** Keep navigation in the client; socket selections and rail selections share it. */
export function useWorkspaceThreadNavigation() {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const projectRefs = useActiveWorkspaceProjectRefs();
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const route = useParams({ strict: false, select: resolveThreadRouteRef });
  const navigate = useNavigate();
  const previousWorkspace = useRef(workspaceId);
  const pending = useRef<string | null>(null);
  const routeKey = route ? JSON.stringify([route.environmentId, route.threadId]) : null;

  useEffect(() => {
    const changed = previousWorkspace.current !== workspaceId;
    if (changed && !ready) return;
    const candidates = workspaceThreads(threads, projectRefs);
    if (changed) {
      previousWorkspace.current = workspaceId;
      useUiStateStore.getState().setSidebarProjectScopeKeys([]);
      const target = lastWorkspaceThread(
        candidates,
        useWorkspaceStore.getState().lastThreadByWorkspace[workspaceId ?? "all"],
        useUiStateStore.getState().threadLastVisitedAtById,
      );
      pending.current = routeKey;
      if (target)
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
      else void navigate({ to: "/" });
      return;
    }
    // The old route can render once more while a workspace switch navigates.
    if (pending.current !== null) {
      if (pending.current === routeKey) return;
      pending.current = null;
    }
    const current = candidates.find(
      (thread) => thread.environmentId === route?.environmentId && thread.id === route?.threadId,
    );
    if (current)
      useWorkspaceStore
        .getState()
        .rememberThread(workspaceId, scopeThreadRef(current.environmentId, current.id));
  }, [navigate, projectRefs, ready, route, routeKey, threads, workspaceId]);
}
