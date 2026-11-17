import { parseOrbitInstanceGit } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import {
  OrbitInstanceGitLine,
  OrbitInstanceRemoveAction,
  OrbitInstanceRemoveDialog,
  OrbitInstanceRemoveFailure,
} from "./OrbitInstanceRemove";

const target = (git: unknown, workingCount = 0) => ({
  name: "pricing-page",
  domain: "pricing-page.nckrtl.test",
  nodeName: "beast",
  threadCount: 2,
  workingCount,
  git: parseOrbitInstanceGit(git),
});

describe("OrbitInstanceRemoveDialog", () => {
  it("keeps Remove Instance off until the tick is set when work would be lost", async () => {
    const onConfirm = vi.fn();
    await using _screen = await render(
      <OrbitInstanceRemoveDialog
        target={target({ state: "known", branch: "pricing-page", uncommitted: 3, unpushed: 2 })}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    );
    const remove = page.getByRole("button", { name: "Remove Instance" });
    await expect.element(remove).toBeDisabled();
    await userEvent.click(page.getByText("Remove it anyway. This work is lost."));
    await expect.element(remove).toBeEnabled();
    await userEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledWith(true, expect.objectContaining({ state: "known" }));
  });

  it("asks once for a clean Instance, and asks for the tick again on Orbit's newer state", async () => {
    const onConfirm = vi.fn();
    const clean = target({ state: "known", branch: "x", uncommitted: 0, unpushed: 0 });
    await using screen = await render(
      <OrbitInstanceRemoveDialog target={clean} onCancel={() => undefined} onConfirm={onConfirm} />,
    );
    const remove = page.getByRole("button", { name: "Remove Instance" });
    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledWith(false, expect.objectContaining({ state: "known" }));

    // Orbit answered `instance.unsaved_work`: the same dialog now needs the tick.
    await screen.rerender(
      <OrbitInstanceRemoveDialog
        target={target({ state: "unknown" })}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    );
    await expect
      .element(page.getByText(/Orbit cannot tell whether this Instance holds work/))
      .toBeVisible();
    await expect.element(remove).toBeDisabled();
    await userEvent.click(page.getByText("Remove it anyway. Any unsaved work is lost."));
    await expect.element(remove).toBeEnabled();
    await userEvent.click(remove);
    expect(onConfirm).toHaveBeenLastCalledWith(true, { state: "unknown", reason: null });
  });

  it("replaces the bin button while removing, so a remove cannot start twice", async () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const row = (failure: string | null) => (
      <div>
        <OrbitInstanceGitLine git={parseOrbitInstanceGit({ state: "unknown" })} />
        <OrbitInstanceRemoveAction removing={failure === null} onRemove={onRemove} />
        {failure === null ? null : (
          <OrbitInstanceRemoveFailure refused message={failure} onRetry={onRetry} />
        )}
      </div>
    );
    await using screen = await render(row(null));
    await expect.element(page.getByText("Git state unknown")).toBeVisible();
    await expect.element(page.getByText("Removing…")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Remove Instance" }))
      .not.toBeInTheDocument();

    await screen.rerender(row("Orbit says no."));
    await expect.element(page.getByText("Could not remove: Orbit says no.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await userEvent.click(page.getByRole("button", { name: "Remove Instance" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
