import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { OrbitDraftTarget } from "../orbit/orbitDraft";
import { registerOrbitInstanceStepOpener } from "../orbit/orbitInstanceStep";
import { BranchToolbarOrbitInstance } from "./BranchToolbarOrbitInstance";

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

describe("BranchToolbarOrbitInstance", () => {
  it("shows the Node and Instance, and the Instance reopens the Project's Instance step", async () => {
    const opener = vi.fn();
    using _registration = { [Symbol.dispose]: registerOrbitInstanceStepOpener(opener) };
    await using screen = await render(<BranchToolbarOrbitInstance target={target} />);

    await expect.element(screen.getByText("beast")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /New instance pricing-page/ }));

    await expect.element(screen.getByText("pricing-page · nckrtl")).toBeVisible();
    expect(opener).toHaveBeenCalledWith(71);
  });
});
