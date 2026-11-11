import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { openOrbitDraft } from "./openOrbitDraft";
import type { OrbitDraftTarget } from "./orbitDraft";

const mocks = vi.hoisted(() => ({
  enabled: true,
  existingDraft: null as { draftId: string; threadId: string } | null,
  setLogicalProjectDraftThreadId: vi.fn(),
}));

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => ({ orbitThreadsInPaletteEnabled: mocks.enabled }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftSessionByLogicalProjectKey: () => mocks.existingDraft,
      setLogicalProjectDraftThreadId: mocks.setLogicalProjectDraftThreadId,
    }),
  },
}));
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

function setup(input: { enabled: boolean; existingDraft?: typeof mocks.existingDraft }) {
  mocks.enabled = input.enabled;
  mocks.existingDraft = input.existingDraft ?? null;
  mocks.setLogicalProjectDraftThreadId.mockClear();
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

  it("does nothing while the Labs switch is off", async () => {
    const { router, navigate } = setup({ enabled: false });

    expect(await openOrbitDraft(router, target)).toBeNull();
    expect(mocks.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
