import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useProjects } from "../state/entities";
import type { Project } from "../types";
import { useWorkspaceStore } from "../workspaceStore";
import { newOrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { useOrbitThreadsAvailable } from "../orbit/environmentProvider";
import { OrbitPendingThreadList } from "../orbit/OrbitPendingThreadList";
import { updateStarts } from "../orbit/orbitThreadStartStore";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../orbit/environmentProvider", { spy: true });
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "normal", count: 2, shift: false, picker: false, workspace: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const previousWorkspaces = useWorkspaceStore.getState();
    stack.defer(() => useWorkspaceStore.setState(previousWorkspaces));
    useWorkspaceStore.setState({
      workspaces:
        "workspace" in scenario
          ? [
              {
                id: "selected",
                name: "Selected",
                color: "blue",
                icon: null,
                projectKeys: [],
                projectRefs: ["local:active"],
              },
            ]
          : [],
      activeWorkspaceId: "workspace" in scenario ? "selected" : null,
      availableProjects: [],
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await vi.waitFor(() =>
      expect(useWorkspaceStore.getState().availableProjects).toHaveLength(scenario.count),
    );
    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

describe("sidebar pending Orbit threads", () => {
  it("lists palette starts until the clone took the message, and links to their pending thread", async () => {
    vi.mocked(useOrbitThreadsAvailable).mockReturnValue(true);
    const base = (id: string, message: string) =>
      newOrbitThreadStart({
        id,
        project: { id: 66, slug: "create-bench", nodeName: "beast" },
        message,
        suffix: "x",
        threadId: `thread-${id}`,
        messageId: `message-${id}`,
        commandId: `command-${id}`,
        now: 0,
        instanceName: id,
        pendingThread: true,
      });
    window.localStorage.clear();
    updateStarts(() => [
      base("running", "Add a pricing page"),
      { ...base("failed", "Fix the login"), error: "The name is taken." },
      { ...base("sent", "Already handed over"), sentAt: 5 },
      { ...base("dialog", "Old dialog start"), pendingThread: false },
    ]);
    await using screen = await render(<OrbitPendingThreadList />, { router: "/orbit/running" });
    const rows = screen.getByRole("link");
    await expect.element(rows.first()).toHaveAttribute("href", "/orbit/running");
    expect(rows.all().map((row) => row.element().getAttribute("data-orbit-pending-row"))).toEqual([
      "running",
      "failed",
    ]);
    await expect.element(screen.getByText("Setup failed")).toBeVisible();
    window.localStorage.clear();
    updateStarts(() => []);
  });
});
