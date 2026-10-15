import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "./components/Sidebar.logic";
import type { SidebarThreadSummary } from "./types";

type WorkspaceThread = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "projectId"
  | "archivedAt"
  | "lineage"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "pendingBackgroundTasks"
  | "lastVisitedAt"
>;

export function workspaceThreads<T extends WorkspaceThread>(
  threads: readonly T[],
  projectRefs: ReadonlySet<string> | null,
) {
  return filterSidebarV2VisibleThreads(threads, projectRefs);
}

export function lastWorkspaceThread(
  threads: readonly WorkspaceThread[],
  remembered: ScopedThreadRef | undefined,
  visited: Readonly<Record<string, string>>,
): ScopedThreadRef | null {
  const rememberedThread =
    remembered &&
    threads.find(
      (thread) =>
        thread.environmentId === remembered.environmentId && thread.id === remembered.threadId,
    );
  if (rememberedThread) return remembered;
  let latest: WorkspaceThread | null = null;
  let latestVisit = -Infinity;
  for (const thread of threads) {
    const time = Date.parse(
      visited[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))] ?? "",
    );
    if (time > latestVisit) {
      latest = thread;
      latestVisit = time;
    }
  }
  return latest ? scopeThreadRef(latest.environmentId, latest.id) : null;
}

export function workspaceAttention(
  threads: readonly WorkspaceThread[],
  visited: Readonly<Record<string, string>>,
) {
  let unread = 0;
  let approval = 0;
  let input = 0;
  for (const thread of threads) {
    // Settled history is deliberately outside the workspace inbox.
    if (thread.settledOverride === "settled") continue;
    const status = resolveSidebarThreadStatus(thread);
    if (status === "approval") approval++;
    else if (status === "input") input++;
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      visited[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    );
    // A mid-run checkpoint can set completedAt while the agent is still working.
    if (
      status === "ready" &&
      thread.latestRun?.status === "completed" &&
      !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks) &&
      hasUnseenCompletion({ ...thread, lastVisitedAt })
    )
      unread++;
  }
  return { unread, approval, input };
}
