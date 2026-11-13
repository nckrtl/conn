import { newOrbitThreadStart, type OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { useThreadShell } from "../state/entities";
import { useComposerDraftStore } from "../composerDraftStore";
import { useEnvironmentProvider } from "./environmentProvider";
import { orbitDraftLogicalProjectKey } from "./orbitDraft";
import { OrbitPendingThreadList } from "./OrbitPendingThreadList";
import { OrbitPendingThreadView } from "./OrbitPendingThreadView";
import { finishOrbitPlusStart } from "./OrbitThreadStartRunner";
import { readStored, updateStarts } from "./orbitThreadStartStore";

vi.mock("../state/entities", { spy: true });
const orbit = vi.hoisted(() => ({ openOrbitInstanceById: vi.fn(), cancelOperation: vi.fn() }));
// The same function an Instance holder pick uses; it opens what the Instance's palette row opens.
vi.mock("./openOrbitInstance", () => ({
  openOrbitInstanceById: (...args: unknown[]) => orbit.openOrbitInstanceById(...args),
}));
vi.mock("./OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./OrbitProfileSync")>()),
  desktopOrbitGatewayClient: () => ({
    cancelOperation: orbit.cancelOperation,
    // The Gateway lists the new Instance at the hand-over's fresh read.
    environments: async () => [{ instanceId: 41, environmentId: "env-41" }],
  }),
}));

/** A start the palette's plus made: no message. */
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
    projectName: "create-bench",
    instanceDomainSuffix: ".create-bench.test",
  }),
  ...patch,
});

function setup(saved: OrbitThreadStart) {
  orbit.openOrbitInstanceById.mockReset();
  orbit.cancelOperation.mockReset();
  window.localStorage.clear();
  updateStarts(() => [saved]);
  vi.mocked(useThreadShell).mockReturnValue(null);
}

const view = () => (
  <SidebarProvider>
    <OrbitPendingThreadView startId="p1" />
  </SidebarProvider>
);

const connected = {
  createStartedAt: 1,
  createFinishedAt: 2,
  createOperationId: 100,
  instanceId: 41,
  environmentId: "env-41",
  connected: true,
  connectStartedAt: 2,
  connectFinishedAt: 3,
};

describe("a start with no message (the palette's plus)", () => {
  it("shows its pending thread with the steps and no message bubble", async () => {
    setup(
      plusStart({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }),
    );
    await using screen = await render(view(), { router: "/orbit/p1" });
    await expect.element(screen.getByText("Create Instance")).toBeVisible();
    await expect.element(screen.getByText("abc", { exact: true })).toBeVisible();
    expect(screen.container.querySelector("[data-orbit-pending-message]")).toBeNull();
  });

  it("once connected, opens the Instance as its palette pick does, then the start is done", async () => {
    setup(plusStart(connected));
    orbit.openOrbitInstanceById.mockResolvedValue({ kind: "opened", draftId: "draft-41" });
    await using screen = await render(view(), { router: "/orbit/p1" });
    await finishOrbitPlusStart(screen.router!, "p1");
    expect(orbit.openOrbitInstanceById).toHaveBeenCalledOnce();
    expect(orbit.openOrbitInstanceById.mock.calls[0]![0]).toMatchObject({
      project: { id: 66, slug: "create-bench", domainSuffix: ".create-bench.test" },
      instance: { id: 41, name: "abc" },
    });
    expect(readStored()).toEqual([]);
    // A second run of the runner finds nothing left to open.
    await finishOrbitPlusStart(screen.router!, "p1");
    expect(orbit.openOrbitInstanceById).toHaveBeenCalledOnce();
  });

  it("opens nothing when the user is elsewhere; the start is done and its row leaves the sidebar", async () => {
    setup(plusStart(connected));
    const bridgeWindow = window as { desktopBridge?: unknown };
    const previousBridge = bridgeWindow.desktopBridge;
    const previousProvider = useEnvironmentProvider.getState();
    bridgeWindow.desktopBridge = { orbitGatewaySend: vi.fn() };
    useEnvironmentProvider.setState({ provider: "orbit" });
    try {
      await using screen = await render(
        <SidebarProvider>
          <OrbitPendingThreadList />
        </SidebarProvider>,
        { router: "/" },
      );
      const row = screen.getByRole("link", { name: /abc/ });
      await expect.element(row).toBeVisible();
      expect(row.element().getAttribute("href")).toBe("/orbit/p1");
      await finishOrbitPlusStart(screen.router!, "p1");
      expect(orbit.openOrbitInstanceById).not.toHaveBeenCalled();
      expect(screen.router!.state.location.pathname).toBe("/");
      await expect.element(screen.getByRole("link", { name: /abc/ })).not.toBeInTheDocument();
    } finally {
      bridgeWindow.desktopBridge = previousBridge;
      useEnvironmentProvider.setState(previousProvider, true);
    }
  });

  it("shows a failed create as today, and Dismiss drops the start", async () => {
    setup(
      plusStart({
        createStartedAt: 1,
        instanceId: 41,
        error: "Orbit could not create the clone (instance.t3_unready).",
        errorCode: "instance.t3_unready",
      }),
    );
    await using screen = await render(view(), { router: "/orbit/p1" });
    await expect.element(screen.getByText("Instance setup failed")).toBeVisible();
    await expect.element(screen.getByText("The Instance stays; remove it in Orbit.")).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
  });

  it("Change name after a taken name puts the name back in the Project's draft; no text exists to strand", async () => {
    setup(
      plusStart({
        createStartedAt: 1,
        error: "The name abc is taken.",
        errorCode: "instance.name_taken",
      }),
    );
    const bridgeWindow = window as { desktopBridge?: unknown };
    const previousBridge = bridgeWindow.desktopBridge;
    const previousProvider = useEnvironmentProvider.getState();
    bridgeWindow.desktopBridge = { orbitGatewaySend: vi.fn() };
    useEnvironmentProvider.setState({ provider: "orbit", orbitInstances: {} });
    try {
      await using screen = await render(view(), { router: "/orbit/p1" });
      await screen.getByRole("button", { name: "Change name" }).click();
      await vi.waitFor(() => expect(readStored()).toEqual([]));
      const draft = useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(orbitDraftLogicalProjectKey(66));
      expect(draft?.orbitTarget).toMatchObject({ instanceKind: "new", instanceName: "abc" });
      if (draft) useComposerDraftStore.getState().clearDraftThread(draft.draftId);
    } finally {
      bridgeWindow.desktopBridge = previousBridge;
      useEnvironmentProvider.setState(previousProvider, true);
    }
  });

  it("Cancel during the create cancels Orbit's Operation and drops the start, as today", async () => {
    setup(
      plusStart({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }),
    );
    orbit.cancelOperation.mockResolvedValue({ id: 100, status: "running" });
    await using screen = await render(view(), { router: "/orbit/p1" });
    await screen.getByRole("button", { name: "Cancel" }).click();
    await vi.waitFor(() => expect(readStored()).toEqual([]));
    expect(orbit.cancelOperation).toHaveBeenCalledWith(100);
  });
});
