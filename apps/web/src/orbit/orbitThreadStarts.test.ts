import { ProviderInstanceId } from "@t3tools/contracts";
import type { OrbitGatewayClient } from "@t3tools/client-runtime/orbit-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useWorkspaceStore } from "../workspaceStore";
import type { Workspace } from "../workspaces.logic";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { buildOrbitDraftStart, type OrbitDraftTarget } from "./orbitDraft";
import {
  dismissOrbitThreadStart,
  retryOrbitThreadStart,
  runSavedOrbitThreadStart,
  sendOrbitDraft,
} from "./orbitThreadStarts";
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
    const sent = await ports.send({ ...start, environmentId: "clone" });
    ports.save({ ...start, ...sent, environmentId: "clone", sentAt: 1 });
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
vi.mock("../providerInstances", () => ({
  providerInstanceEntriesFor: vi.fn(),
  resolveProjectDefaultProviderModelSelection: vi.fn(),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: vi.fn() } }));
vi.mock("../state/projects", () => ({ environmentProjects: { projectsAtom: {} } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../state/waitForAtomValue", () => ({ waitForAtomValue: async () => true }));
vi.mock("./environmentProvider", () => ({
  recordOrbitPaired: vi.fn(),
  useEnvironmentProvider: { getState: () => ({ provider: "orbit" }) },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

const projectTarget: OrbitDraftTarget = {
  projectId: 3,
  projectSlug: "bench",
  projectName: "Bench",
  nodeName: "beast",
  instanceKind: "new",
  instanceName: "",
  existing: null,
  domainSuffix: null,
};
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
  sendOrbitDraft({
    start: buildOrbitDraftStart({
      target: { ...projectTarget, instanceName: "list-files" },
      message: "List the files",
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      branchControl: false,
    }),
    openPending: () => {},
    clearDraft: () => {},
  });
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
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
      desktopBridge: { orbitGatewaySend: vi.fn() },
    });
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

describe("sendOrbitDraft", () => {
  const target: OrbitDraftTarget = {
    projectId: 71,
    projectSlug: "nckrtl",
    projectName: "nckrtl.com",
    nodeName: "beast",
    instanceKind: "new",
    instanceName: "pricing-page",
    existing: null,
    domainSuffix: ".nckrtl.test",
  };
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-opus-5-5",
  };
  const send = (
    draftTarget: OrbitDraftTarget,
    navigation?: Promise<void>,
    branchControl = false,
  ) => {
    const events: string[] = [];
    const sent = sendOrbitDraft({
      start: buildOrbitDraftStart({
        target: draftTarget,
        message: "Add a pricing page",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branchControl,
      }),
      openPending: (route) => {
        events.push(`open ${route}`);
        return navigation;
      },
      clearDraft: () => events.push(`clear after ${readStored().length} saved`),
    });
    return { sent, start: readStored()[0]!, events };
  };

  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageStub(),
      desktopBridge: { orbitGatewaySend: vi.fn() },
    });
    useWorkspaceStore.setState({ workspaces: [workspace("S")], activeWorkspaceId: "S" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves a start, opens its pending thread, and clears the draft only after that", async () => {
    const navigation = deferred();
    const { start, events } = send(target, navigation.promise);
    // The draft route redirects home once its draft is gone, so the clear waits for the route.
    await Promise.resolve();
    expect(events).toEqual(["open /orbit/start-1"]);
    navigation.resolve();
    await navigation.promise;
    await Promise.resolve();

    expect(start).toMatchObject({
      projectId: 71,
      projectSlug: "nckrtl",
      nodeName: "beast",
      message: "Add a pricing page",
      instanceName: "pricing-page",
      orbitInstanceKind: "new",
      environmentId: null,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceId: "S",
      pendingThread: true,
      projectName: "nckrtl.com",
      instanceDomainSuffix: ".nckrtl.test",
    });
    expect(events).toEqual(["open /orbit/start-1", "clear after 1 saved"]);
    // The start machine sends later; nothing goes through a T3 server now.
    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("saves the branch choice only with branch control on, and the default branch either way", () => {
    const onBranch: OrbitDraftTarget = {
      ...target,
      branch: { mode: "existing", name: "feature/login" },
      defaultBranch: "main",
    };
    expect(send(onBranch).start).toMatchObject({ branch: null, defaultBranch: "main" });
    window.localStorage.clear();
    expect(send(onBranch, undefined, true).start).toMatchObject({
      branch: { mode: "existing", name: "feature/login" },
      defaultBranch: "main",
    });
    window.localStorage.clear();
    expect(send({ ...onBranch, branch: null }, undefined, true).start.branch).toBeNull();
  });

  it("starts in an existing, unpaired Instance without a create", () => {
    const { start } = send({
      ...target,
      instanceKind: "existing",
      instanceName: "checkout",
      existing: { instanceId: 2055, environmentId: "env-2055" },
    });

    expect(start).toMatchObject({
      instanceName: "checkout",
      orbitInstanceKind: "existing",
      instanceId: 2055,
      environmentId: "env-2055",
    });
  });

  it("still clears the draft when the navigation fails", async () => {
    const navigation = deferred();
    const { events } = send(target, navigation.promise);
    navigation.reject(new Error("blocked"));
    await navigation.promise.catch(() => {});
    await Promise.resolve();
    expect(events).toEqual(["open /orbit/start-1", "clear after 1 saved"]);
  });

  it("saves nothing and keeps the draft when the window cannot run a start", () => {
    vi.stubGlobal("window", { localStorage: createLocalStorageStub() });
    const { sent, events } = send(target);
    expect(sent).toBeNull();
    expect(readStored()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("keeps a pending thread's start after the send, for the real thread's ready row", async () => {
    const { start } = send(target);
    expect(await runSavedOrbitThreadStart(client, start.id)).toEqual({
      environmentId: "clone",
      threadId: "thread-1",
    });
    expect(readStored()).toEqual([
      expect.objectContaining({ id: start.id, sentAt: expect.any(Number), modelFallback: null }),
    ]);
    // A sent start never runs again.
    expect(await runSavedOrbitThreadStart(client, start.id)).toBeNull();
  });

  it("Retry clears the error and the times of the stages that run again; Dismiss drops only the start", () => {
    const { start } = send(target);
    window.localStorage.setItem(
      "conn:orbit-thread-starts:v1",
      JSON.stringify([
        {
          ...start,
          environmentId: "env-1",
          instanceId: 9,
          createStartedAt: 1,
          connectStartedAt: 5,
          error: "Orbit could not pair.",
        },
      ]),
    );
    retryOrbitThreadStart(start.id);
    expect(readStored()[0]).toMatchObject({
      error: null,
      createStartedAt: 1,
      connectStartedAt: null,
    });

    dismissOrbitThreadStart(start.id);
    expect(readStored()).toEqual([]);
    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("resumes an unsent start of the old sidebar dialog as a pending thread", async () => {
    const { start } = send(target);
    const {
      pendingThread: _pending,
      projectName: _name,
      instanceDomainSuffix: _suffix,
      sentAt: _sentAt,
      ...dialogRow
    } = start;
    window.localStorage.setItem("conn:orbit-thread-starts:v1", JSON.stringify([dialogRow]));

    expect(await runSavedOrbitThreadStart(client, start.id)).toEqual({
      environmentId: "clone",
      threadId: "thread-1",
    });
    // Kept like any pending thread's start, for the real thread's ready row.
    expect(readStored()).toEqual([
      expect.objectContaining({ id: start.id, pendingThread: true, sentAt: expect.any(Number) }),
    ]);
  });

  it("drops an old dialog start whose send finished before a quit, without running it", async () => {
    const { start } = send(target);
    const { pendingThread: _pending, ...dialogRow } = start;
    window.localStorage.setItem(
      "conn:orbit-thread-starts:v1",
      JSON.stringify([{ ...dialogRow, environmentId: "clone", connected: true, sentAt: 4 }]),
    );
    expect(await runSavedOrbitThreadStart(client, start.id)).toBeNull();
    expect(readStored()).toEqual([]);
  });
});
