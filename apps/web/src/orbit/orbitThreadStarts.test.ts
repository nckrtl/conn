import type { OrbitGatewayClient } from "@t3tools/client-runtime/orbit-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useWorkspaceStore } from "../workspaceStore";
import type { Workspace } from "../workspaces.logic";
import { beginOrbitThreadStart, runSavedOrbitThreadStart } from "./orbitThreadStarts";
import { readStored } from "./orbitThreadStartStore";

vi.mock("@t3tools/client-runtime/orbit-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/orbit-gateway")>()),
  // The clone is created and paired; only the first message is left.
  runOrbitThreadStart: async (
    start: Parameters<
      typeof import("@t3tools/client-runtime/orbit-gateway").runOrbitThreadStart
    >[0],
    ports: Parameters<
      typeof import("@t3tools/client-runtime/orbit-gateway").runOrbitThreadStart
    >[1],
  ) => {
    await ports.send({ ...start, environmentId: "clone" });
    return true;
  },
  sendOrbitFirstMessage: async () => "ws",
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../lib/utils", () => ({
  newMessageId: () => "message-1",
  newThreadId: () => "thread-1",
  randomUUID: () => "start-1",
}));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../providerInstances", () => ({ resolveProjectDefaultProviderModelSelection: vi.fn() }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: vi.fn() } }));
vi.mock("../state/projects", () => ({ environmentProjects: { projectsAtom: {} } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../state/waitForAtomValue", () => ({ waitForAtomValue: async () => true }));
vi.mock("./environmentProvider", () => ({
  recordOrbitPaired: vi.fn(),
  useEnvironmentProvider: { getState: () => ({ provider: "orbit" }) },
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const project = { id: 3, slug: "bench", name: "Bench", nodeId: 7, nodeName: "beast" };
const client = {} as OrbitGatewayClient;
const workspace = (id: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name: id,
  projectKeys: [],
  projectRefs: ["beast:bench"],
  color: "blue",
  icon: null,
  ...extra,
});

/** Starts a thread with `selected` chosen, lets `between` run, then sends the first message. */
async function startAndSend(selected: string | null, between: () => void = () => {}) {
  useWorkspaceStore.setState({ activeWorkspaceId: selected });
  beginOrbitThreadStart(project, "List the files", "/env/thread-a");
  const id = readStored()[0]!.id;
  between();
  expect(await runSavedOrbitThreadStart(client, id)).toEqual({
    environmentId: "clone",
    threadId: "thread-1",
  });
  return useWorkspaceStore.getState().workspaces;
}

describe("runSavedOrbitThreadStart", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: createLocalStorageStub() });
    useWorkspaceStore.setState({
      workspaces: [workspace("S"), workspace("U")],
      activeWorkspaceId: null,
      availableProjects: [],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("adds the clone's project to the workspace selected at Start once the message is sent", async () => {
    // Nick moves on to workspace U while the clone is made.
    const workspaces = await startAndSend("S", () =>
      useWorkspaceStore.getState().selectWorkspace("U"),
    );

    expect(workspaces.map((entry) => entry.projectRefs)).toEqual([
      ["beast:bench", "clone:ws"],
      ["beast:bench"],
    ]);
  });

  it("changes no workspace for a start with all projects, or whose workspace is gone", async () => {
    const before = useWorkspaceStore.getState().workspaces;
    expect(await startAndSend(null)).toBe(before);

    window.localStorage.clear();
    expect(
      await startAndSend("S", () => useWorkspaceStore.getState().deleteWorkspace("S")),
    ).toEqual([workspace("U")]);
  });

  it("leaves a workspace that already lists the clone's project as it is", async () => {
    const byKey = workspace("S", { projectKeys: ["/srv/workspace"] });
    useWorkspaceStore.setState({
      workspaces: [byKey],
      availableProjects: [
        { projectKey: "/srv/workspace", displayName: "workspace", refs: ["clone:ws"] },
      ],
    });

    expect((await startAndSend("S"))[0]).toBe(byKey);
  });
});
