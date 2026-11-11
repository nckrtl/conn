import { describe, expect, it } from "vite-plus/test";

import {
  chooseOrbitDraftAnchor,
  orbitDraftAttachmentsBlockedReason,
  type OrbitDraftTarget,
} from "./orbitDraft";

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

describe("chooseOrbitDraftAnchor", () => {
  const orbitInstances = {
    "clone-other": { projectId: 12, instanceId: 3 },
    "clone-unsaved": { projectId: 71, instanceId: 4 },
    "clone-b": { projectId: 71, instanceId: 6 },
    "clone-a": { projectId: 71, instanceId: 5 },
  };

  it("anchors on a paired clone of the same Project, else on the primary environment", () => {
    const anchor = (saved: string[], primary: string | null = "primary") =>
      chooseOrbitDraftAnchor({
        orbitProjectId: 71,
        orbitInstances,
        savedEnvironmentIds: new Set(saved),
        primaryEnvironmentId: primary,
      });

    expect(anchor(["clone-b", "clone-a", "clone-other"])).toBe("clone-a");
    // A clone this device has not paired is no anchor; neither is another Project's clone.
    expect(anchor(["clone-other"])).toBe("primary");
    expect(anchor([], null)).toBeNull();
  });
});

describe("orbitDraftAttachmentsBlockedReason", () => {
  it("names why an Orbit draft takes no attachments, and leaves other drafts alone", () => {
    expect(orbitDraftAttachmentsBlockedReason(target)).toBe(
      "Attachments are not available for a new Instance yet.",
    );
    expect(
      orbitDraftAttachmentsBlockedReason({
        ...target,
        instanceKind: "existing",
        existing: { instanceId: 2055, environmentId: "env-2055" },
      }),
    ).toBe("Attachments are not available until this Instance is connected.");
    expect(orbitDraftAttachmentsBlockedReason(null)).toBeNull();
  });
});
