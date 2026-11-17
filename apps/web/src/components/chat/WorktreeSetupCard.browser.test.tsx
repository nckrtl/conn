import "~/index.css";
import { EnvironmentId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const linkMenu = vi.hoisted(() => ({ show: vi.fn(), openExternal: vi.fn(), copy: vi.fn() }));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: linkMenu.show },
      shell: { openExternal: linkMenu.openExternal },
    }) as never,
}));

function setupLinkMenu() {
  linkMenu.show.mockReset().mockResolvedValue(null);
  linkMenu.openExternal.mockReset().mockResolvedValue(undefined);
  linkMenu.copy.mockReset().mockResolvedValue(undefined);
  return vi.spyOn(navigator.clipboard, "writeText").mockImplementation(linkMenu.copy);
}

function rightClick(element: Element): boolean {
  return element.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
  );
}
import { OrbitReadyRow } from "./OrbitSetupCard";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

const NOW = new Date("2026-10-26T12:00:10.000Z");

function snapshot(overrides: Partial<WorktreeSetupSnapshot>): WorktreeSetupSnapshot {
  return {
    threadId: ThreadId.make("thread-1"),
    phase: "running",
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: null,
    branch: "t3/feature",
    baseRef: "main",
    worktreePath: "/repo/.t3/worktrees/feature",
    setupScript: null,
    stages: [
      {
        id: "fetch",
        status: "done",
        startedAt: "2026-10-26T12:00:00.000Z",
        endedAt: "2026-10-26T12:00:03.000Z",
        percent: null,
        detail: null,
        tail: [],
      },
      {
        id: "checkout",
        status: "running",
        startedAt: "2026-10-26T12:00:03.000Z",
        endedAt: null,
        percent: null,
        detail: null,
        tail: [],
      },
    ],
    error: null,
    sequence: 1,
    ...overrides,
  };
}

const card = (value: WorktreeSetupSnapshot) => (
  <WorktreeSetupCard snapshot={value} onCancel={null} onWorkLocally={null} onOpenTerminal={null} />
);

it("ticks the running stage while finished stages keep their duration", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  await using screen = await render(card(snapshot({})));
  // Assert synchronously: expect.element polls on timers these tests fake.
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files7s");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Fetch base branch3s");
  expect(section.element().textContent).toContain("Check out files12s");
});

it("stops a stage interrupted by the setup ending at the setup's end", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(NOW);
  const failed = snapshot({ phase: "failed", endedAt: "2026-10-26T12:00:05.000Z" });
  await using screen = await render(card(failed));
  const section = screen.getByRole("region", { name: "Worktree setup" });

  expect(section.element().textContent).toContain("Check out files2s");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(section.element().textContent).toContain("Check out files2s");
});

// Conn: the Orbit setup card shares this card's look and renders a client-built view.
it("folds a finished Orbit start to Instance ready with Details open and Conn's ready line", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-41"),
    threadId: ThreadId.make("thread-1"),
  };
  const view = {
    instanceName: "pricing-page",
    nodeName: "beast",
    url: "https://pricing-page.create-bench.test",
    readyLine: "",
    modelFallbackLine: "This Instance does not offer claude-opus-5-5, so the agent uses gpt-5.5.",
    branch: "feature/pricing",
    baseBranch: "develop",
    dependenciesLine: "Dependencies and build come from the default branch.",
  };
  await using screen = await render(<OrbitReadyRow view={view} threadRef={threadRef} />);
  await expect.element(screen.getByText("Instance ready")).toBeVisible();
  // No timing on the ready row (storyboard 7).
  expect(screen.container.querySelector("[data-orbit-setup-stage]")?.textContent).toBe(
    "Instance ready",
  );
  await expect
    .element(screen.getByRole("button", { name: "Details" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("pricing-page", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(view.modelFallbackLine)).toBeVisible();
  await expect.element(screen.getByText("develop", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(view.dependenciesLine)).toBeVisible();
  const line = screen.container.querySelector("[data-orbit-ready-line]");
  expect(line?.textContent).toBe(
    "Your Instance is ready. You can preview it at https://pricing-page.create-bench.test while I work on your request.",
  );
  await screen.getByRole("button", { name: "Details" }).click();
  expect(screen.getByText("Node").query()).toBeNull();
});

it("gives the ready line and Preview chip the chat link menu for the Instance address", async () => {
  using _clipboard = setupLinkMenu();
  const url = "https://meetup.dlf.test";
  const threadRef = {
    environmentId: EnvironmentId.make("env-41"),
    threadId: ThreadId.make("thread-1"),
  };
  const view = {
    instanceName: "meetup",
    nodeName: "beast",
    url,
    readyLine: "",
    modelFallbackLine: null,
    branch: null,
    baseBranch: null,
    dependenciesLine: null,
  };
  await using screen = await render(<OrbitReadyRow view={view} threadRef={threadRef} />);
  const lineLink = screen.container.querySelector<HTMLAnchorElement>("[data-orbit-ready-line] a")!;
  const chip = screen.container.querySelector<HTMLAnchorElement>(`dd a[href="${url}"]`)!;
  expect(lineLink.href).toBe(`${url}/`);
  expect(chip).not.toBeNull();

  linkMenu.show.mockResolvedValue("copy-link");
  // The native menu only offers Copy Link and text editing; the app's link menu replaces it.
  expect(await act(async () => rightClick(lineLink))).toBe(false);
  expect(linkMenu.show.mock.calls[0]?.[0].map((item: { id: string }) => item.id)).toContain(
    "open-external",
  );
  await vi.waitFor(() => expect(linkMenu.copy).toHaveBeenCalledWith(url));

  linkMenu.show.mockResolvedValue("open-external");
  expect(await act(async () => rightClick(chip))).toBe(false);
  await vi.waitFor(() => expect(linkMenu.openExternal).toHaveBeenCalledWith(url));
});
