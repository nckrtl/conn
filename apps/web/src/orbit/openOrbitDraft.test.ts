import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import type { OrbitGatewayEnvironment } from "@t3tools/client-runtime/orbit-gateway";

import { openOrbitDraft } from "./openOrbitDraft";
import { openOrbitInstanceById } from "./openOrbitInstance";
import type { OrbitDraftTarget } from "./orbitDraft";

const mocks = vi.hoisted(() => ({
  enabled: true,
  existingDraft: null as {
    draftId: string;
    threadId: string;
    orbitTarget?: OrbitDraftTarget;
  } | null,
  setLogicalProjectDraftThreadId: vi.fn(),
  newThread: vi.fn(async () => ({ draftId: "draft-clone", threadId: "thread-clone" })),
  projects: [] as Array<{ environmentId: string; id: string; workspaceRoot: string }>,
}));

vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftSessionByLogicalProjectKey: () => mocks.existingDraft,
      setLogicalProjectDraftThreadId: mocks.setLogicalProjectDraftThreadId,
    }),
  },
}));
vi.mock("../hooks/useHandleNewThread", () => ({ createNewThreadHandler: () => mocks.newThread }));
vi.mock("../state/entities", () => ({ readProjects: () => mocks.projects }));
vi.mock("../lib/utils", () => ({ newDraftId: () => "draft-new", newThreadId: () => "thread-new" }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: "catalog" } }));
vi.mock("../state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: "primary" }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom === "catalog" ? { entries: new Map([["clone-71", {}]]) } : "env-primary",
  },
}));
vi.mock("./environmentProvider", () => ({
  // The desktop app in Orbit mode; there is no other switch.
  orbitThreadsAvailableNow: () => mocks.enabled,
  useEnvironmentProvider: {
    getState: () => ({ orbitInstances: { "clone-71": { projectId: 71, instanceId: 5 } } }),
  },
}));

const target: OrbitDraftTarget = {
  projectId: 71,
  projectSlug: "nckrtl",
  projectName: "nckrtl.com",
  nodeName: "beast",
  instanceKind: "new",
  instanceName: "pricing-page",
  existing: null,
  domainSuffix: null,
};

function setup(input: {
  enabled: boolean;
  existingDraft?: typeof mocks.existingDraft;
  projects?: typeof mocks.projects;
}) {
  mocks.enabled = input.enabled;
  mocks.existingDraft = input.existingDraft ?? null;
  mocks.projects = input.projects ?? [];
  mocks.setLogicalProjectDraftThreadId.mockClear();
  mocks.newThread.mockClear();
  const navigate = vi.fn(async () => {});
  return { router: { navigate } as unknown as AnyRouter, navigate };
}

describe("openOrbitDraft", () => {
  it("opens a draft anchored on the Project's paired clone, with the target", async () => {
    const { router, navigate } = setup({ enabled: true });

    expect(await openOrbitDraft(router, target)).toBe("draft-new");
    expect(mocks.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "orbit-project:71",
      { environmentId: "clone-71", projectId: "orbit-project:71" },
      "draft-new",
      expect.objectContaining({ threadId: "thread-new", envMode: "local", orbitTarget: target }),
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId: "draft-new" },
    });
  });

  it("reuses the Project's open draft, so its text stays", async () => {
    const { router } = setup({
      enabled: true,
      existingDraft: { draftId: "draft-old", threadId: "thread-old" },
    });

    expect(await openOrbitDraft(router, target)).toBe("draft-old");
    expect(mocks.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "orbit-project:71",
      expect.anything(),
      "draft-old",
      expect.objectContaining({ threadId: "thread-old" }),
    );
  });

  it("does nothing outside the desktop app in Orbit mode", async () => {
    const { router, navigate } = setup({ enabled: false });

    expect(await openOrbitDraft(router, target)).toBeNull();
    expect(mocks.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("openOrbitDraft keeps the Project draft's branch", () => {
  it("keeps the chosen branch for a new Instance target without one, and takes a target's own", async () => {
    const branch = { mode: "existing", name: "feature/login" } as const;
    const { router } = setup({
      enabled: true,
      existingDraft: {
        draftId: "draft-old",
        threadId: "thread-old",
        orbitTarget: { ...target, branch, defaultBranch: "main" },
      },
    });
    await openOrbitDraft(router, { ...target, instanceName: "other" });
    expect(mocks.setLogicalProjectDraftThreadId.mock.lastCall?.[3]).toMatchObject({
      orbitTarget: { instanceName: "other", branch, defaultBranch: "main" },
    });
    await openOrbitDraft(router, { ...target, branch: null });
    expect(mocks.setLogicalProjectDraftThreadId.mock.lastCall?.[3].orbitTarget.branch).toBeNull();
  });
});

describe("openOrbitInstanceById", () => {
  const project = {
    id: 71,
    slug: "nckrtl",
    name: "nckrtl.com",
    nodeName: "beast",
    domainSuffix: null,
  };
  const environment = (
    environmentId: string,
    extra: Partial<OrbitGatewayEnvironment> = {},
  ): OrbitGatewayEnvironment => ({
    environmentId,
    label: environmentId,
    url: "http://10.44.0.7:3800",
    serverVersion: null,
    registeredBy: null,
    registeredAt: null,
    status: "registered",
    instanceId: 42,
    powerState: "running",
    projectId: 71,
    projectName: "nckrtl.com",
    projectSlug: "nckrtl",
    instanceName: "login",
    nodeName: "shark",
    instanceUrl: null,
    ...extra,
  });
  const open = (environments: OrbitGatewayEnvironment[]) =>
    openOrbitInstanceById({
      router: setup({
        enabled: true,
        projects: [{ environmentId: "clone-71", id: "ws", workspaceRoot: "/srv/workspace" }],
      }).router,
      project,
      instance: { id: 42, name: "login" },
      environments: async () => environments,
    });

  it("opens a normal draft in a paired Instance's workspace project", async () => {
    expect(await open([environment("clone-71")])).toEqual({
      kind: "opened",
      draftId: "draft-clone",
    });
    expect(mocks.newThread).toHaveBeenCalledWith({ environmentId: "clone-71", projectId: "ws" });
    expect(mocks.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it("opens an Orbit draft of kind existing for an Instance this device has not paired", async () => {
    expect(await open([environment("env-42")])).toEqual({ kind: "opened", draftId: "draft-new" });
    expect(mocks.newThread).not.toHaveBeenCalled();
    expect(mocks.setLogicalProjectDraftThreadId.mock.lastCall?.[3].orbitTarget).toEqual({
      projectId: 71,
      projectSlug: "nckrtl",
      projectName: "nckrtl.com",
      nodeName: "shark",
      instanceKind: "existing",
      instanceName: "login",
      existing: { instanceId: 42, environmentId: "env-42" },
      domainSuffix: null,
    });
  });

  it("creates nothing when the Instance has no reachable server or cannot be picked", async () => {
    expect(await open([environment("env-9", { instanceId: 9 })])).toEqual({
      kind: "unavailable",
      reason: "Instance login has no T3 server this device can reach.",
    });
    expect(await open([environment("env-42", { powerState: "stopped" })])).toMatchObject({
      kind: "unavailable",
    });
    expect(mocks.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(mocks.newThread).not.toHaveBeenCalled();
  });
});
