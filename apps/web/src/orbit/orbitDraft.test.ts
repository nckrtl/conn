import { describe, expect, it } from "vite-plus/test";

import {
  chooseOrbitDraftAnchor,
  ORBIT_DRAFT_NO_ENVIRONMENT_ID,
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

  it("anchors on a paired clone, the primary, the host server, any saved environment, else none", () => {
    const anchor = (
      saved: Array<[string, boolean]>,
      primary: string | null = "primary",
      host: string | null = null,
    ) =>
      chooseOrbitDraftAnchor({
        orbitProjectId: 71,
        orbitInstances,
        savedEnvironments: new Map(saved.map(([id, enabled]) => [id, { enabled }])),
        primaryEnvironmentId: primary,
        hostEnvironmentId: host,
      });

    expect(
      anchor([
        ["clone-b", true],
        ["clone-a", true],
        ["clone-other", true],
      ]),
    ).toBe("clone-a");
    // A clone this device has not paired is no anchor; neither is another Project's clone.
    expect(anchor([["clone-other", true]])).toBe("primary");
    // A Project with no Instances, local environment off (no primary): Orbit's host servers.
    expect(
      anchor(
        [
          ["beast", true],
          ["nick", true],
        ],
        null,
        "nick",
      ),
    ).toBe("nick");
    expect(
      anchor(
        [
          ["off", false],
          ["beast", true],
        ],
        null,
      ),
    ).toBe("beast");
    expect(anchor([["off", false]], null, "gone")).toBe("off");
    expect(anchor([], null)).toBe(ORBIT_DRAFT_NO_ENVIRONMENT_ID);
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
