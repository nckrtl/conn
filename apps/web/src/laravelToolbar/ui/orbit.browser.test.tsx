import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import type { DesktopOrbitToolRequest, EnvironmentId } from "@t3tools/contracts";

import { createDesktopOrbitTransport } from "~/orbit/desktopOrbitTransport";
import { ToolbarProvider } from "../context";
import { gatewayOrbitSource, type OrbitProcess, type OrbitSource } from "../orbit";
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

  it("follows a process whose status Orbit could not read, keeping its tail over a failed read", async () => {
    const logs = vi
      .fn<OrbitSource["logs"]>()
      .mockResolvedValueOnce("first tail line\n")
      .mockRejectedValue(new Error("Orbit is not reachable from this machine."));
    await using screen = await renderPanel(
      orbitSource(logs, { ...crashed, status: "unknown" }),
      false,
    );
    using _timers = fakeTimers();
    await openProcesses();
    await expect.element(screen.getByText("first tail line")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Following" })).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(logs).toHaveBeenCalledTimes(2);
    await expect.element(screen.getByText("first tail line")).toBeVisible();
  });

  it("keeps actions for a process whose status Orbit could not read", async () => {
    await using screen = await renderPanel(
      orbitSource(async () => "", { ...crashed, status: "unknown" }),
    );
    await expect.element(screen.getByText("status unknown")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Restart queue" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Stop queue" })).toBeEnabled();
  });

  it("reads the Instance's processes and a log tail through the desktop transport", async () => {
    const answers: Record<string, unknown> = {
      "/api/v1/instances/resolve": { instance_id: 2040, node_id: 3 },
      "/api/v1/nodes": [{ id: 3, name: "beast" }],
      "/api/v1/processes": [{ id: 51, name: "vp-dev", status: "running" }],
      "/api/v1/processes/51/logs": { logs: "vite ready in 412 ms\n" },
    };
    const send = vi.fn(async (request: DesktopOrbitToolRequest) => ({
      error: null,
      status: 200,
      body: JSON.stringify({ data: answers[request.path] ?? null }),
    }));
    const transport = createDesktopOrbitTransport({
      environmentId: "env-clone" as EnvironmentId,
      send,
    });
    await using screen = await renderPanel(gatewayOrbitSource(transport, "clone.test"));
    await expect.element(screen.getByText("vite ready in 412 ms")).toBeVisible();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "env-clone",
        method: "GET",
        path: "/api/v1/processes",
        query: { target_type: "instance", target_id: "2040" },
      }),
    );
  });
});
