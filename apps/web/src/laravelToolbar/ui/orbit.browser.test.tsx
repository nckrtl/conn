import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import { ToolbarProvider } from "../context";
import type { OrbitProcess, OrbitSource } from "../orbit";
import { OrbitPanel } from "./orbit";

const crashed: OrbitProcess = {
  id: 7,
  name: "queue",
  command: "php artisan queue:work",
  status: "crashed",
  cpu: null,
  memoryBytes: null,
};

function orbitSource(logs: OrbitSource["logs"], process: OrbitProcess = crashed): OrbitSource {
  return {
    page: async () => ({ domain: "app.test", instanceId: 1, nodeName: null }),
    applicationLogs: () => () => {},
    processes: async () => [process],
    dependencies: async () => ({ composer: [], javascript: [], package_manager: null }),
    logs,
    act: async () => {},
  };
}

async function renderPanel(orbit: OrbitSource, open = true) {
  const screen = await render(
    <ToolbarProvider tabId="tab" source={{ fetchDetails: async () => null, orbit }}>
      <OrbitPanel />
    </ToolbarProvider>,
    { router: false }, // The panel needs no route.
  );
  if (open) await openProcesses();
  return screen;
}

async function openProcesses() {
  await userEvent.click(page.getByRole("button", { name: /^Processes/ }));
}

describe("Orbit process log pane", () => {
  it("shows a slow tail once it arrives, marked as a one-time tail", async () => {
    let answer: (text: string) => void = () => {};
    const logs = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    await using screen = await renderPanel(orbitSource(logs));
    await expect.element(screen.getByText(/Reading the log/)).toBeVisible();
    await act(() => answer("worker started\nplain container line\n"));
    await expect.element(screen.getByText("plain container line")).toBeVisible();
    await expect.element(screen.getByText("One-time tail")).toBeVisible();
  });

  it("says when Orbit does not answer in time, and reads again on Retry", async () => {
    const logs = vi.fn(() => new Promise<string>(() => {}));
    await using screen = await renderPanel(orbitSource(logs), false);
    {
      using _timers = fakeTimers();
      await openProcesses();
      await expect.element(screen.getByText(/Reading the log/)).toBeVisible();
      await act(() => vi.advanceTimersByTime(36_000));
    }
    await expect.element(screen.getByText("Orbit did not return the log in time.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expect.element(screen.getByText(/Reading the log/)).toBeVisible();
    expect(logs).toHaveBeenCalledTimes(2);
  });

  it("ends in a visible state for an empty tail and for a failed read", async () => {
    await using empty = await renderPanel(orbitSource(async () => ""));
    await expect.element(empty.getByText("No log lines yet")).toBeVisible();
    await empty[Symbol.asyncDispose]();

    await using failed = await renderPanel(
      orbitSource(async () => {
        throw new Error("Orbit is not reachable from this machine.");
      }),
    );
    await expect
      .element(failed.getByText("Orbit is not reachable from this machine."))
      .toBeVisible();
    await expect.element(failed.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("keeps actions for a process whose status Orbit could not read", async () => {
    await using screen = await renderPanel(
      orbitSource(async () => "", { ...crashed, status: "unknown" }),
    );
    await expect.element(screen.getByText("status unknown")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Restart queue" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Stop queue" })).toBeEnabled();
  });
});
