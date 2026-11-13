import { newOrbitThreadStart, type OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useEnvironmentProvider } from "./environmentProvider";
import { OrbitDraftSetup } from "./OrbitDraftSetup";
import { OrbitPendingThreadList } from "./OrbitPendingThreadList";
import { OrbitPendingThreadView } from "./OrbitPendingThreadView";
import { orbitReadyView } from "./orbitSetupView";
import { linkedOrbitStart, sendIntoOrbitStart, withUiFields } from "./orbitThreadStarts";
import { readStored, updateStarts } from "./orbitThreadStartStore";

const gateway = vi.hoisted(() => ({ cancelOperation: vi.fn() }));
vi.mock("./OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./OrbitProfileSync")>()),
  desktopOrbitGatewayClient: () => ({ cancelOperation: gateway.cancelOperation }),
}));

const DRAFT = "draft-plus" as DraftId;

/** A start the palette's plus made: no message, owned by the draft. */
const plusStart = (patch: Partial<OrbitThreadStart> = {}): OrbitThreadStart => ({
  ...newOrbitThreadStart({
    id: "p1",
    project: { id: 66, slug: "create-bench", nodeName: "beast" },
    message: "",
    suffix: "x",
    threadId: "thread-p",
    messageId: "message-p",
    commandId: "command-p",
    now: 0,
    instanceName: "abc",
    pendingThread: true,
    instanceDomainSuffix: ".create-bench.test",
    draftId: DRAFT,
  }),
  ...patch,
});

function setup(saved: OrbitThreadStart) {
  gateway.cancelOperation.mockReset();
  window.localStorage.clear();
  updateStarts(() => [saved]);
}

const draftView = () => (
  <SidebarProvider>
    <OrbitDraftSetup draftId={DRAFT} />
  </SidebarProvider>
);

describe("OrbitDraftSetup", () => {
  it("shows the create's steps in the draft before any message", async () => {
    setup(
      plusStart({
        createStartedAt: 1,
        createKey: "k",
        createOperationId: 100,
        instanceId: 41,
        createRows: {
          container: { status: "running", startedAt: 1, finishedAt: null },
          address: { status: "done", startedAt: 1, finishedAt: 2 },
        },
      }),
    );
    await using screen = await render(draftView(), { router: `/draft/${DRAFT}` });
    await expect.element(screen.getByText("Create Instance")).toBeVisible();
    await expect.element(screen.getByText("Copy the container")).toBeVisible();
    expect(screen.container.querySelector('[data-orbit-draft-setup="running"]')).not.toBeNull();
    expect(screen.container.querySelector("[data-orbit-pending-message]")).toBeNull();
  });

  it("shows the folded ready row without Conn's line once the Instance waits for its first message", async () => {
    setup(
      plusStart({
        createStartedAt: 1,
        createFinishedAt: 3_000,
        connectStartedAt: 3_000,
        connectFinishedAt: 4_000,
        createOperationId: 100,
        instanceId: 41,
        environmentId: "env-41",
        connected: true,
        resultBranch: "abc",
      }),
    );
    await using screen = await render(draftView(), { router: `/draft/${DRAFT}` });
    await expect.element(screen.getByText("Instance ready")).toBeVisible();
    expect(screen.container.querySelector('[data-orbit-draft-setup="ready"]')).not.toBeNull();
    expect(screen.container.querySelector("[data-orbit-ready-line]")).toBeNull();
    expect(screen.container.querySelector("[data-orbit-setup-phase]")).toBeNull();
  });

  it("shows a failed create as the pending thread does, and Dismiss drops the start", async () => {
    setup(
      plusStart({
        createStartedAt: 1,
        error: "The name abc is taken.",
        errorCode: "instance.name_taken",
      }),
    );
    await using screen = await render(draftView(), { router: `/draft/${DRAFT}` });
    await expect.element(screen.getByText("Instance setup failed")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Change name" })).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
  });

  it("Cancel during the create cancels Orbit's Operation and drops the start, as today", async () => {
    setup(
      plusStart({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }),
    );
    gateway.cancelOperation.mockResolvedValue({ id: 100, status: "running" });
    await using screen = await render(draftView(), { router: `/draft/${DRAFT}` });
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
    expect(gateway.cancelOperation).toHaveBeenCalledWith(100);
  });
});

describe("a waiting start whose draft is gone", () => {
  it("opens a new draft of its own from the pending thread, so its first message can be written", async () => {
    setup(plusStart({ createStartedAt: 1, environmentId: "env-41", connected: true }));
    const bridgeWindow = window as { desktopBridge?: unknown };
    const previousBridge = bridgeWindow.desktopBridge;
    const previousProvider = useEnvironmentProvider.getState();
    bridgeWindow.desktopBridge = { orbitGatewaySend: vi.fn() };
    useEnvironmentProvider.setState({ provider: "orbit", orbitInstances: {} });
    try {
      await using screen = await render(
        <SidebarProvider>
          <OrbitPendingThreadView startId="p1" />
        </SidebarProvider>,
        { router: "/orbit/p1" },
      );
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toMatch(/^\/draft\/.+/),
      );
      const draftId = screen.router!.state.location.pathname.slice("/draft/".length);
      expect(draftId).not.toBe(DRAFT);
      expect(readStored()[0]).toMatchObject({ id: "p1", draftId, message: "" });
      expect(
        useComposerDraftStore.getState().getDraftSession(draftId as DraftId)?.orbitTarget,
      ).toMatchObject({ projectId: 66, instanceName: "abc", branch: null });
      useComposerDraftStore.getState().clearDraftThread(draftId as DraftId);
    } finally {
      bridgeWindow.desktopBridge = previousBridge;
      useEnvironmentProvider.setState(previousProvider, true);
    }
  });
});

describe("the ready line of a plus start", () => {
  it("is left out when the Instance was ready before any prompt, and kept when a prompt came during the create", () => {
    const url = "https://abc.create-bench.test";
    expect(orbitReadyView(plusStart({ readyWithoutPrompt: true }), url).readyLine).toBeNull();
    expect(orbitReadyView(plusStart({ message: "Fix it" }), url).readyLine).toContain(
      "while I work on your request",
    );
  });
});

describe("the plus's start and its first message", () => {
  it("writes a prompt sent during the create into the start once, and the runner's saves keep it", async () => {
    setup(
      plusStart({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }),
    );
    const runnerCopy = readStored()[0]!;
    const opened: string[] = [];
    const prompt = {
      message: "Add a pricing page",
      modelSelection: null,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    };
    const send = () =>
      sendIntoOrbitStart({
        startId: "p1",
        prompt,
        openPending: (path) => {
          opened.push(path);
        },
        clearDraft: () => {},
      });
    expect(send()).toBe(true);
    // A second send finds the message there and changes nothing.
    expect(send()).toBe(false);
    expect(opened).toEqual(["/orbit/p1"]);
    expect(readStored()[0]).toMatchObject({ message: "Add a pricing page" });
    expect(linkedOrbitStart(readStored(), DRAFT)?.id).toBe("p1");

    // The runner saves its older copy while it follows the create: the message stays.
    const saved = withUiFields({ ...runnerCopy, environmentId: "env-41" });
    expect(saved).toMatchObject({ message: "Add a pricing page", environmentId: "env-41" });
  });

  it("names a waiting start after its Instance in the sidebar, without a spinner, and opens its draft", async () => {
    setup(plusStart({ createStartedAt: 1, environmentId: "env-41", connected: true }));
    const bridgeWindow = window as { desktopBridge?: unknown };
    const previousBridge = bridgeWindow.desktopBridge;
    const previousProvider = useEnvironmentProvider.getState();
    bridgeWindow.desktopBridge = { orbitGatewaySend: vi.fn() };
    useEnvironmentProvider.setState({ provider: "orbit" });
    const store = useComposerDraftStore.getState();
    try {
      // Its draft is gone (discarded): the row opens the pending thread, which can dismiss it.
      {
        await using screen = await render(
          <SidebarProvider>
            <OrbitPendingThreadList />
          </SidebarProvider>,
          { router: "/" },
        );
        const row = screen.getByRole("link", { name: /abc/ });
        await expect.element(row).toBeVisible();
        expect(row.element().getAttribute("href")).toBe("/orbit/p1");
        expect(row.element().querySelector('[role="status"], .animate-spin')).toBeNull();
      }
      store.setLogicalProjectDraftThreadId(
        "orbit-project:66:plus:check",
        scopeProjectRef(EnvironmentId.make("env-anchor"), ProjectId.make("orbit-project:66")),
        DRAFT,
        {
          threadId: ThreadId.make("thread-draft"),
          envMode: "local",
          branch: null,
          worktreePath: null,
        },
      );
      await using screen = await render(
        <SidebarProvider>
          <OrbitPendingThreadList />
        </SidebarProvider>,
        { router: "/" },
      );
      const row = screen.getByRole("link", { name: /abc/ });
      await vi.waitFor(() => expect(row.element().getAttribute("href")).toBe(`/draft/${DRAFT}`));
    } finally {
      store.clearDraftThread(DRAFT);
      bridgeWindow.desktopBridge = previousBridge;
      useEnvironmentProvider.setState(previousProvider, true);
    }
  });
});
