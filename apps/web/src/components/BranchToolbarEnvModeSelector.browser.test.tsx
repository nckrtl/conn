import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

describe("BranchToolbarEnvModeSelector", () => {
  it("offers only the current checkout and a new worktree", async () => {
    await using screen = await render(
      <BranchToolbarEnvModeSelector
        envLocked={false}
        effectiveEnvMode="local"
        activeWorktreePath={null}
        onEnvModeChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Workspace" }));

    await expect.element(screen.getByRole("option", { name: "New worktree" })).toBeVisible();
    expect(screen.getByRole("option").elements()).toHaveLength(2);
    expect(screen.getByText(/Orbit/).elements()).toHaveLength(0);
  });

  it("shows a thread in an old Orbit checkout as a plain worktree", async () => {
    await using screen = await render(
      <BranchToolbarEnvModeSelector
        envLocked
        effectiveEnvMode="worktree"
        activeWorktreePath="/fast/apps/acme/t3code-1a2b3c4d"
        onEnvModeChange={vi.fn()}
      />,
    );

    // Like any worktree, it is named by its folder.
    await expect.element(screen.getByText("t3code-1a2b3c4d")).toBeVisible();
    expect(screen.getByText(/Orbit/).elements()).toHaveLength(0);
  });
});
