import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { makeThreadFixture } from "../test-fixtures";
import type { Project, Thread } from "../types";
import { CommandPalette } from "./CommandPalette";
import type { OrbitPaletteProjectsState } from "./CommandPalette.logic";

const entities = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Project>,
  threads: [] as ReadonlyArray<Thread>,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => entities.projects,
  useVisibleThreadShells: () => entities.threads,
}));

const orbit = vi.hoisted(() => ({
  state: { status: "off" } as OrbitPaletteProjectsState,
  retry: vi.fn(),
}));
vi.mock("../orbit/orbitPaletteProjects", () => ({
  useOrbitPaletteProjects: () => orbit.state,
  retryOrbitPaletteProjects: () => orbit.retry(),
}));

function setup(
  state: {
    projects?: ReadonlyArray<Project>;
    threads?: ReadonlyArray<Thread>;
    orbit?: OrbitPaletteProjectsState;
  } = {},
) {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  entities.projects = state.projects ?? [];
  entities.threads = state.threads ?? [];
  orbit.state = state.orbit ?? { status: "off" };
  orbit.retry.mockReset();
}

describe("CommandPalette open intents", () => {
  it("drags a searched thread into the current composer without navigating", async () => {
    const environmentId = EnvironmentId.make("remote");
    const threadId = ThreadId.make("dragged-thread");
    setup({
      threads: [makeThreadFixture({ environmentId, id: threadId, title: "Drag this thread" })],
    });
    const onDrop = vi.fn();
    await using screen = await render(
      <CommandPalette>
        <div
          data-thread-context-drop="true"
          ref={(node) => {
            node?.addEventListener("t3-thread-context-drop", onDrop);
          }}
          style={{ position: "fixed", bottom: 0, width: 300, height: 100 }}
        >
          Composer
        </div>
      </CommandPalette>,
    );
    const pathname = screen.router?.state.location.pathname;
    openCommandPalette({ query: "Drag this thread" });
    const row = page.getByRole("option", { name: /Drag this thread/ });
    await expect.element(row).toBeVisible();
    const bounds = row.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", bounds.x + 20, bounds.y + 10));
      document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 20));
    });
    expect(useCommandPaletteStore.getState().open).toBe(false);
    await act(() => {
      document.dispatchEvent(pointer("pointermove", 50, window.innerHeight - 30));
      document.dispatchEvent(pointer("pointerup", 50, window.innerHeight - 30));
    });
    expect(onDrop).toHaveBeenCalledOnce();
    expect((onDrop.mock.calls[0]![0] as CustomEvent).detail).toEqual([{ environmentId, threadId }]);
    expect(screen.router?.state.location.pathname).toBe(pathname);
  });

  it("opens New thread in... with focus in the search input, not the Back button", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
  });

  it("highlights the first project when New thread in... opens from the root list", async () => {
    const environmentId = EnvironmentId.make("local");
    const project = (id: string, title: string): Project => ({
      id: ProjectId.make(id),
      environmentId,
      title,
      workspaceRoot: `/work/${id}`,
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    });
    setup({
      projects: [project("acme", "Acme"), project("beta", "Beta"), project("gamma", "Gamma")],
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({});
    await expect
      .element(page.getByPlaceholder("Search commands, projects, and threads..."))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("option", { name: /^New thread in\.\.\./ }))
      .toHaveAttribute("data-highlighted");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByPlaceholder("Search...")).toHaveFocus();
    await expect.element(page.getByRole("option").first()).toHaveAttribute("data-highlighted");
    await expect.element(page.getByRole("option").nth(1)).not.toHaveAttribute("data-highlighted");
  });

  it("opens a search intent with its query in the focused input", async () => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "acme" });

    const input = page.getByPlaceholder("Search commands, projects, and threads...");
    await expect.element(input).toHaveFocus();
    await expect.element(input).toHaveValue("acme");
  });

  it("opens a searched project's latest listed thread, not a newer subagent", async () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("acme");
    const parentId = ThreadId.make("parent");
    setup({
      projects: [
        {
          id: projectId,
          environmentId,
          title: "Acme",
          workspaceRoot: "/work/acme",
          repositoryIdentity: null,
          defaultModelSelection: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          scripts: [],
        },
      ],
      threads: [
        makeThreadFixture({
          id: parentId,
          environmentId,
          projectId,
          latestUserMessageAt: "2026-03-02T00:00:00.000Z",
        }),
        makeThreadFixture({
          id: ThreadId.make("subagent"),
          environmentId,
          projectId,
          updatedAt: "2026-03-03T00:00:00.000Z",
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
      ],
    });
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ query: "Acme" });
    await page.getByRole("option", { name: /Acme/ }).first().click();

    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/parent"));
  });

  it("lists an Orbit Project with its instance count and offers Retry when Orbit is unreachable", async () => {
    const localProject: Project = {
      id: ProjectId.make("acme"),
      environmentId: EnvironmentId.make("local"),
      title: "Acme",
      workspaceRoot: "/work/acme",
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    };
    // A local project with the Orbit Project's name stays its own row: no deduplication.
    const namesake: Project = {
      ...localProject,
      id: ProjectId.make("nckrtl-local"),
      title: "nckrtl",
      workspaceRoot: "/work/nckrtl",
    };
    setup({
      projects: [localProject, namesake],
      orbit: {
        status: "loaded",
        projects: [
          {
            id: 3,
            slug: "nckrtl",
            name: "nckrtl",
            nodeId: 7,
            nodeName: "beast",
            instanceDomainSuffix: null,
            cloneable: true,
            cloneableReason: null,
            checks: null,
          },
        ],
        environments: [
          { instanceId: 41, projectId: 3, instanceName: "fix" },
          { instanceId: 42, projectId: 3, instanceName: "login" },
          { instanceId: 9, projectId: 3, instanceName: "default" },
        ],
      },
    });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);

    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByRole("option", { name: /nckrtl/ }).nth(1)).toBeVisible();
    const row = page.getByRole("option", { name: /orbit · 2 instances/ });
    await expect.element(row).toBeVisible();
    expect(page.getByRole("option", { name: /nckrtl/ }).all()).toHaveLength(2);
    expect(row.element().textContent).toContain("orbit · 2 instances");
    await expect.element(page.getByRole("option", { name: /Acme/ })).toBeVisible();
    await row.click();
    await expect.element(page.getByText(/Instance step comes in PR 2b/)).toBeVisible();

    orbit.state = { status: "loading" };
    await act(() =>
      useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true),
    );
    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByText("Loading Orbit projects…")).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /orbit · 2 instances/ }))
      .not.toBeInTheDocument();

    orbit.state = { status: "unreachable" };
    await act(() =>
      useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true),
    );
    openCommandPalette({ open: "new-thread-in" });
    await expect.element(page.getByRole("option", { name: /Acme/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /orbit · 2 instances/ }))
      .not.toBeInTheDocument();
    const notice = page.getByRole("option", { name: /Orbit projects are not shown/ });
    await expect.element(notice).toBeVisible();
    expect(notice.element().textContent).toContain("Retry");
    await notice.click();
    expect(orbit.retry).toHaveBeenCalledOnce();
  });
});
