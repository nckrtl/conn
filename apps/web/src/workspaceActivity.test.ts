import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  lastWorkspaceThread,
  workspaceAttention,
  workspaceThreads,
} from "./workspaceActivity.logic";
import type { SidebarThreadSummary } from "./types";

const local = EnvironmentId.make("local");
const beast = EnvironmentId.make("beast");
function thread(environmentId = local, id = "t1") {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("p1"),
    archivedAt: null,
    lineage: { parentThreadId: null, rootThreadId: ThreadId.make(id), relationshipToParent: null },
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default" as const,
    latestRun: null as ThreadRunSummary | null,
    runtime: null as ThreadRuntimeSummary | null,
    pendingBackgroundTasks: [] as SidebarThreadSummary["pendingBackgroundTasks"],
  };
}
const ref = (environmentId = local, id = "t1") => scopeThreadRef(environmentId, ThreadId.make(id));
const visited = (environmentId = local, id = "t1", time = "2026-09-30T10:00:00Z") => ({
  [scopedThreadKey(ref(environmentId, id))]: time,
});

describe("workspace thread navigation", () => {
  it("remembers thread identity separately for matching ids on two machines", () => {
    const candidates = [thread(), thread(beast)];
    expect(lastWorkspaceThread(candidates, ref(beast), visited())).toEqual(ref(beast));
    expect(workspaceThreads(candidates, new Set(["local:p1"]))).toEqual([thread()]);
    expect(
      lastWorkspaceThread(
        workspaceThreads(candidates, new Set(["local:p1"])),
        ref(beast),
        visited(),
      ),
    ).toEqual(ref());
  });
  it("falls back to the last visited eligible thread when the saved one was removed", () => {
    const candidates = [thread(), thread(local, "t2")];
    expect(
      lastWorkspaceThread(candidates, ref(local, "gone"), {
        ...visited(),
        ...visited(local, "t2", "2026-09-30T11:00:00Z"),
      }),
    ).toEqual(ref(local, "t2"));
    expect(lastWorkspaceThread(candidates, undefined, {})).toBeNull();
    expect(lastWorkspaceThread([], ref(), visited())).toBeNull();
    expect(workspaceThreads([{ ...thread(), archivedAt: "2026-09-30T12:00:00Z" }], null)).toEqual(
      [],
    );
  });
});

describe("workspace attention", () => {
  const runtime = (status: ThreadRuntimeSummary["status"]): ThreadRuntimeSummary => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-09-30T11:00:00Z",
  });
  const completed = {
    ...thread(),
    latestRun: {
      runId: "run-1" as never,
      status: "completed" as const,
      assistantMessageId: null,
      requestedAt: "2026-09-30T10:00:00Z",
      startedAt: "2026-09-30T10:00:00Z",
      completedAt: "2026-09-30T11:00:00Z",
    },
  };
  it("reports unread completions, approvals and input requests", () => {
    const candidates = [
      completed,
      { ...thread(beast), hasPendingApprovals: true },
      { ...thread(local, "t2"), hasPendingUserInput: true },
    ];
    expect(workspaceAttention(candidates, visited())).toEqual({ unread: 1, approval: 1, input: 1 });
    expect(
      workspaceAttention(workspaceThreads(candidates, new Set(["local:p1"])), visited()),
    ).toEqual({ unread: 1, approval: 0, input: 1 });
  });
  it("clears unread after a visit and follows T3's never-visited semantics", () => {
    expect(workspaceAttention([completed], visited(local, "t1", "2026-09-30T12:00:00Z"))).toEqual({
      unread: 0,
      approval: 0,
      input: 0,
    });
    expect(workspaceAttention([completed], {})).toEqual({ unread: 0, approval: 0, input: 0 });
  });
  it("waits for the run and runtime to finish before reporting done", () => {
    const running = {
      ...completed,
      latestRun: { ...completed.latestRun, status: "running" as const },
    };
    expect(workspaceAttention([running], visited()).unread).toBe(0);
    for (const status of ["running", "starting", "idle"] as const) {
      expect(
        workspaceAttention([{ ...completed, runtime: runtime(status) }], visited()).unread,
      ).toBe(0);
    }
    expect(
      workspaceAttention([{ ...completed, runtime: runtime("completed") }], visited()).unread,
    ).toBe(1);
    for (const status of ["failed", "interrupted"] as const) {
      expect(
        workspaceAttention(
          [{ ...completed, latestRun: { ...completed.latestRun, status } }],
          visited(),
        ).unread,
      ).toBe(0);
    }
  });
  it("suppresses done while background work continues", () => {
    for (const kind of ["subagent", "monitor"] as const) {
      expect(
        workspaceAttention(
          [{ ...completed, pendingBackgroundTasks: [{ taskId: "bg-1", kind }] }],
          visited(),
        ).unread,
      ).toBe(0);
    }
    expect(
      workspaceAttention(
        [{ ...completed, pendingBackgroundTasks: [{ taskId: "bg-1", kind: "command" }] }],
        visited(),
      ).unread,
    ).toBe(1);
  });
  it("prefers the server's visited watermark over this device's", () => {
    expect(
      workspaceAttention(
        [{ ...completed, lastVisitedAt: "2026-09-30T12:00:00Z" }],
        visited(local, "t1", "2026-09-30T10:00:00Z"),
      ).unread,
    ).toBe(0);
  });
  it("reports requests separately from unread completions", () => {
    expect(workspaceAttention([{ ...completed, hasPendingApprovals: true }], visited())).toEqual({
      unread: 0,
      approval: 1,
      input: 0,
    });
    expect(workspaceAttention([{ ...completed, hasPendingUserInput: true }], visited())).toEqual({
      unread: 0,
      approval: 0,
      input: 1,
    });
  });
  it("clears the workspace dot when the only active thread is read, even with unread settled history", () => {
    const history = { ...completed, id: ThreadId.make("old"), settledOverride: "settled" as const };
    const candidates = [completed, history];
    const visits = { ...visited(local, "t1", "2026-09-30T11:00:00Z"), ...visited(local, "old") };
    expect(workspaceAttention(candidates, visits).unread).toBe(0);
    expect(
      workspaceAttention([{ ...history, settledOverride: "active" as const }], visits).unread,
    ).toBe(1);
  });
  it("does not show attention from settled history, including stale requests", () => {
    for (const request of [{ hasPendingApprovals: true }, { hasPendingUserInput: true }, {}]) {
      expect(
        workspaceAttention([{ ...completed, ...request, settledOverride: "settled" }], visited()),
      ).toEqual({ unread: 0, approval: 0, input: 0 });
    }
  });
  it("uses the sidebar roster so hidden subagent completions cannot light the workspace", () => {
    const child = {
      ...completed,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        rootThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
      },
    };
    expect(workspaceAttention(workspaceThreads([child], null), visited()).unread).toBe(0);
    expect(
      workspaceThreads(
        [{ ...child, lineage: { ...child.lineage, relationshipToParent: "fork" as const } }],
        null,
      ),
    ).toHaveLength(1);
  });
  it("stops counting a project's unread completions when it is removed from the workspace", () => {
    const former = { ...completed, id: ThreadId.make("old"), projectId: ProjectId.make("former") };
    const candidates = [completed, former];
    const visits = { ...visited(local, "t1", "2026-09-30T11:00:00Z"), ...visited(local, "old") };
    expect(
      workspaceAttention(
        workspaceThreads(candidates, new Set(["local:p1", "local:former"])),
        visits,
      ).unread,
    ).toBe(1);
    expect(
      workspaceAttention(workspaceThreads(candidates, new Set(["local:p1"])), visits).unread,
    ).toBe(0);
  });
});
