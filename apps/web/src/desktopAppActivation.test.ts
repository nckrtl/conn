import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    findThread: () => ({ projectId: existingProjectId }),
    showThread: vi.fn(async () => undefined),
    selectWorkspace: vi.fn(() => ({ found: true, workspace: { id: "ws-1", name: "Orbit" } })),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });

  describe("open-thread", () => {
    const openThreadRequest = {
      version: 1,
      requestId: "request-thread",
      type: "open-thread",
      environmentId,
      threadId,
    } as const;

    it("shows an existing thread and reports its project", async () => {
      const deps = dependencies();

      const response = await handleDesktopAppActivationRequest(openThreadRequest, deps);

      expect(deps.showThread).toHaveBeenCalledWith({ environmentId, threadId });
      expect(deps.openThread).not.toHaveBeenCalled();
      expect(response).toEqual({
        version: 1,
        requestId: "request-thread",
        ok: true,
        projectId: existingProjectId,
        threadId,
      });
    });

    it("reports an unknown thread without navigating", async () => {
      const deps = dependencies({ findThread: () => null });

      const response = await handleDesktopAppActivationRequest(openThreadRequest, deps);

      expect(deps.showThread).not.toHaveBeenCalled();
      expect(response).toMatchObject({ ok: false, code: "thread-not-found" });
    });

    it("reports a failed navigation", async () => {
      const deps = dependencies({
        showThread: vi.fn(async () => {
          throw new Error("navigation failed");
        }),
      });

      const response = await handleDesktopAppActivationRequest(openThreadRequest, deps);

      expect(response).toMatchObject({
        ok: false,
        code: "thread-open-failed",
        message: "navigation failed",
      });
    });
  });

  describe("select-workspace", () => {
    const selectWorkspaceRequest = {
      version: 1,
      requestId: "request-3",
      type: "select-workspace",
      workspace: "orbit",
    } as const;

    it("selects the named workspace", async () => {
      const deps = dependencies();

      const response = await handleDesktopAppActivationRequest(selectWorkspaceRequest, deps);

      expect(deps.selectWorkspace).toHaveBeenCalledWith("orbit");
      expect(response).toEqual({
        version: 1,
        requestId: "request-3",
        ok: true,
        workspaceId: "ws-1",
        workspaceName: "Orbit",
      });
    });

    it("answers all projects with null ids", async () => {
      const deps = dependencies({ selectWorkspace: () => ({ found: true, workspace: null }) });

      const response = await handleDesktopAppActivationRequest(
        { ...selectWorkspaceRequest, workspace: "all" },
        deps,
      );

      expect(response).toMatchObject({ ok: true, workspaceId: null, workspaceName: null });
    });

    it("reports an unknown workspace", async () => {
      const deps = dependencies({ selectWorkspace: () => ({ found: false, workspace: null }) });

      const response = await handleDesktopAppActivationRequest(selectWorkspaceRequest, deps);

      expect(response).toMatchObject({ ok: false, code: "workspace-not-found" });
    });
  });
});
