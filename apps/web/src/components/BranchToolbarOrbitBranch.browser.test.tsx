import type { OrbitGatewayBranches } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { createOrbitDefaultBranchCache } from "../orbit/orbitBranchControl";
import type { OrbitDraftTarget } from "../orbit/orbitDraft";
import { BranchToolbarOrbitBranch } from "./BranchToolbarOrbitBranch";

const target: OrbitDraftTarget = {
  projectId: 66,
  projectSlug: "create-bench",
  projectName: "create-bench",
  nodeName: "beast",
  instanceKind: "new",
  instanceName: "pricing-page",
  existing: null,
  domainSuffix: ".create-bench.test",
};

const LIST: OrbitGatewayBranches = {
  pullRequestsUnavailable: false,
  branches: [
    { name: "trunk", default: true, pullRequest: null, instance: { id: 1, name: "default" } },
    {
      name: "feature/login",
      default: false,
      pullRequest: { number: 482, title: "Login", url: null },
      instance: { id: 42, name: "login" },
    },
    { name: "develop", default: false, pullRequest: null, instance: null },
  ],
};

describe("BranchToolbarOrbitBranch", () => {
  it("names a default that is not main before the menu opens, never guessing main", async () => {
    let answer: (list: OrbitGatewayBranches) => void = () => {};
    const readBranches = vi.fn(
      (_projectId: number, _query: string) =>
        new Promise<OrbitGatewayBranches>((resolve) => {
          answer = resolve;
        }),
    );
    const onTargetChange = vi.fn();
    await using screen = await render(
      <BranchToolbarOrbitBranch
        target={target}
        onTargetChange={onTargetChange}
        readBranches={readBranches}
        defaultBranches={createOrbitDefaultBranchCache()}
      />,
    );

    await expect.element(screen.getByText("From default branch")).toBeVisible();
    expect(readBranches).toHaveBeenCalledWith(66, "");
    answer({
      pullRequestsUnavailable: false,
      branches: [{ name: "13.x", default: true, pullRequest: null, instance: null }],
    });
    await expect.element(screen.getByText("From 13.x")).toBeVisible();
    expect(onTargetChange).toHaveBeenCalledWith({ defaultBranch: "13.x" });
    expect(screen.container.textContent).not.toContain("From main");
  });

  it("learns the default and offers both modes with their rules", async () => {
    const readBranches = vi.fn(async (_projectId: number, _query: string) => LIST);
    const onTargetChange = vi.fn();
    await using screen = await render(
      <BranchToolbarOrbitBranch
        target={target}
        onTargetChange={onTargetChange}
        readBranches={readBranches}
        defaultBranches={createOrbitDefaultBranchCache()}
      />,
    );

    await expect.element(screen.getByText("From trunk")).toBeVisible();
    expect(onTargetChange).toHaveBeenCalledWith({ defaultBranch: "trunk" });
    await userEvent.click(screen.getByRole("combobox"));
    await expect.element(page.getByRole("option", { name: /develop/ })).toBeVisible();
    expect(readBranches).toHaveBeenCalledTimes(2);
    await expect.element(page.getByText("PR #482")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Work on branch" }));
    await expect
      .element(page.getByRole("option", { name: /trunk/ }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(page.getByText("in instance login")).toBeVisible();

    await userEvent.click(page.getByRole("option", { name: /develop/ }));
    expect(onTargetChange).toHaveBeenLastCalledWith({
      branch: { mode: "existing", name: "develop" },
    });
  });
});
