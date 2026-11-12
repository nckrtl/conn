import { EnvironmentId, ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import type { OrbitSetupView } from "~/orbit/orbitSetupView";
import { OrbitReadyRow, OrbitSetupCard } from "./OrbitSetupCard";
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
const orbitStage = (
  id: "create" | "connect" | "agent",
  label: string,
  status: "pending" | "running" | "done" | "failed",
  extra: { detail?: string; subDetail?: string } = {},
) => ({
  id,
  label,
  status,
  detail: extra.detail ?? null,
  subDetail: extra.subDetail ?? null,
  startedAt: status === "pending" ? null : "2026-10-26T12:00:00.000Z",
  endedAt: status === "done" || status === "failed" ? "2026-10-26T12:00:04.000Z" : null,
});

function orbitCard(
  view: Partial<OrbitSetupView>,
  actions = { retry: vi.fn(), name: vi.fn(), dismiss: vi.fn() },
) {
  const value: OrbitSetupView = {
    phase: "running",
    stages: [
      orbitStage("create", "Create Instance", "running", {
        detail: "beast",
        subDetail: "Copying the container",
      }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: null,
    canChangeName: false,
    instanceStays: false,
    ...view,
  };
  return {
    actions,
    element: (
      <OrbitSetupCard
        view={value}
        onRetry={actions.retry}
        onChangeName={actions.name}
        onDismiss={actions.dismiss}
      />
    ),
  };
}

it("shows a running Orbit setup with the Node and the clone step, and no actions", async () => {
  await using screen = await render(orbitCard({}).element);
  const section = screen.getByRole("region", { name: "Instance setup" });
  await expect.element(screen.getByText("Copying the container")).toBeVisible();
  expect(section.element().textContent).toContain("Create Instancebeast");
  expect(section.element().textContent).not.toContain("Instance setup failed");
  expect(screen.getByRole("button", { name: "Retry" }).query()).toBeNull();
});

it("shows a done Orbit setup with every stage checked", async () => {
  const done = orbitCard({
    phase: "done",
    stages: [
      orbitStage("create", "Create Instance", "done", { detail: "beast" }),
      orbitStage("connect", "Connect", "done"),
      orbitStage("agent", "Start agent", "done"),
    ],
  });
  await using screen = await render(done.element);
  const rows = screen.container.querySelectorAll('[data-orbit-setup-status="done"]');
  expect(rows).toHaveLength(3);
});

it("offers Retry, Change name and Dismiss on a taken name, without the Instance line", async () => {
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "failed", { detail: "beast" }),
      orbitStage("connect", "Connect", "pending"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: "The name pricing-page is taken in create-bench.",
    canChangeName: true,
  });
  await using screen = await render(failed.element);
  await expect.element(screen.getByText("Instance setup failed")).toBeVisible();
  await expect
    .element(screen.getByText("The name pricing-page is taken in create-bench."))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("The Instance stays");
  await screen.getByRole("button", { name: "Retry" }).click();
  await screen.getByRole("button", { name: "Change name" }).click();
  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(failed.actions.retry).toHaveBeenCalledOnce();
  expect(failed.actions.name).toHaveBeenCalledOnce();
  expect(failed.actions.dismiss).toHaveBeenCalledOnce();
});

it("says the Instance stays after a created Instance and offers no Change name", async () => {
  const failed = orbitCard({
    phase: "failed",
    stages: [
      orbitStage("create", "Create Instance", "done", { detail: "beast" }),
      orbitStage("connect", "Connect", "failed"),
      orbitStage("agent", "Start agent", "pending"),
    ],
    error: "Orbit could not pair with the clone (conn.server_unreachable).",
    instanceStays: true,
  });
  await using screen = await render(failed.element);
  await expect.element(screen.getByText("The Instance stays; remove it in Orbit.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Change name" }).query()).toBeNull();
  expect(screen.container.textContent).not.toMatch(/Discard|Destroy|Remove instance/i);
});

it("folds a finished Orbit start to Instance ready with Details open and Conn's ready line", async () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-41"),
    threadId: ThreadId.make("thread-1"),
  };
  const view = {
    readyMs: 12_000,
    instanceName: "pricing-page",
    nodeName: "beast",
    url: "https://pricing-page.create-bench.test",
    readyLine: "",
    modelFallbackLine: "This Instance does not offer claude-opus-5-5, so the agent uses gpt-5.5.",
  };
  await using screen = await render(<OrbitReadyRow view={view} threadRef={threadRef} />);
  await expect.element(screen.getByText("Instance ready")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Details" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("pricing-page", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(view.modelFallbackLine)).toBeVisible();
  const line = screen.container.querySelector("[data-orbit-ready-line]");
  expect(line?.textContent).toBe(
    "Your Instance is ready. You can preview it at https://pricing-page.create-bench.test while I work on your request.",
  );
  await screen.getByRole("button", { name: "Details" }).click();
  expect(screen.getByText("Node").query()).toBeNull();
});
