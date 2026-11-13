import {
  newOrbitThreadStart,
  type OrbitGatewayEnvironment,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useEnvironmentProvider } from "./environmentProvider";
import { finishOrbitPlusStart, readOrbitEnvironmentsListing } from "./OrbitThreadStartRunner";
import { readStored, updateStarts } from "./orbitThreadStartStore";

const gateway = vi.hoisted(() => ({ environments: vi.fn(), stale: vi.fn() }));
vi.mock("./OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./OrbitProfileSync")>()),
  desktopOrbitGatewayClient: () => ({ environments: gateway.environments }),
}));
// The palette's cached Gateway list, read before this create: the new Instance is not in it.
vi.mock("./orbitPaletteProjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./orbitPaletteProjects")>()),
  readOrbitEnvironments: gateway.stale,
}));

const listed: OrbitGatewayEnvironment = {
  environmentId: "env-41",
  label: "abc",
  url: "http://10.44.0.7:3800/",
  serverVersion: null,
  registeredBy: null,
  registeredAt: null,
  status: "registered",
  instanceId: 41,
  powerState: "running",
  projectId: 66,
  projectName: "create-bench",
  projectSlug: "create-bench",
  instanceName: "abc",
  nodeName: "beast",
  instanceUrl: "https://abc.create-bench.test",
};

const connectedPlusStart = (): OrbitThreadStart => ({
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
  createOperationId: 100,
  instanceId: 41,
  environmentId: "env-41",
  connected: true,
});

describe("readOrbitEnvironmentsListing", () => {
  it("reads once when the Instance is listed, and again a few times while it is not", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const once = vi.fn(async () => [listed]);
    expect(await readOrbitEnvironmentsListing(once, 41, sleep)).toEqual([listed]);
    expect(once).toHaveBeenCalledOnce();

    const late = vi.fn<() => Promise<readonly OrbitGatewayEnvironment[]>>();
    late.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([listed]);
    expect(await readOrbitEnvironmentsListing(late, 41, sleep)).toEqual([listed]);
    expect(late).toHaveBeenCalledTimes(3);

    const never = vi.fn(async () => []);
    expect(await readOrbitEnvironmentsListing(never, 41, sleep)).toEqual([]);
    expect(never).toHaveBeenCalledTimes(5);
    expect(sleeps.every((ms) => ms === 1_000)).toBe(true);
  });
});

describe("finishOrbitPlusStart with a stale palette list", () => {
  it("opens the new Instance from a fresh Gateway read that lists it one read late, without a toast", async () => {
    window.localStorage.clear();
    updateStarts(() => [connectedPlusStart()]);
    gateway.stale.mockReset().mockResolvedValue([]);
    gateway.environments.mockReset().mockResolvedValueOnce([]).mockResolvedValue([listed]);
    const bridgeWindow = window as { desktopBridge?: unknown };
    const previousBridge = bridgeWindow.desktopBridge;
    const previousProvider = useEnvironmentProvider.getState();
    bridgeWindow.desktopBridge = { orbitGatewaySend: vi.fn() };
    useEnvironmentProvider.setState({ provider: "orbit", orbitInstances: {} });
    try {
      await using screen = await render(<div />, { router: "/orbit/p1" });
      await finishOrbitPlusStart(screen.router!, "p1");
      expect(screen.router!.state.location.pathname).toMatch(/^\/draft\/.+/);
      const draftId = screen.router!.state.location.pathname.slice("/draft/".length) as DraftId;
      // Not paired on this test device: the same Orbit draft an unpaired Instance's pick opens.
      expect(useComposerDraftStore.getState().getDraftSession(draftId)?.orbitTarget).toMatchObject({
        instanceKind: "existing",
        instanceName: "abc",
        existing: { instanceId: 41, environmentId: "env-41" },
      });
      expect(gateway.stale).not.toHaveBeenCalled();
      expect(gateway.environments).toHaveBeenCalledTimes(2);
      expect(readStored()).toEqual([]);
      expect(screen.container.ownerDocument.body.textContent).not.toContain(
        "Could not open Instance",
      );
      useComposerDraftStore.getState().clearDraftThread(draftId);
    } finally {
      bridgeWindow.desktopBridge = previousBridge;
      useEnvironmentProvider.setState(previousProvider, true);
    }
  });
});
