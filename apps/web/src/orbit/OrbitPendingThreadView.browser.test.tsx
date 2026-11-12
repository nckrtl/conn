import { newOrbitThreadStart, type OrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SidebarProvider } from "../components/ui/sidebar";
import { useThreadShell } from "../state/entities";
import { OrbitPendingThreadView } from "./OrbitPendingThreadView";
import { readStored, updateStarts, useOrbitThreadStarts } from "./orbitThreadStartStore";

vi.mock("../state/entities", { spy: true });

const start = (patch: Partial<OrbitThreadStart> = {}): OrbitThreadStart => ({
  ...newOrbitThreadStart({
    id: "s1",
    project: { id: 66, slug: "create-bench", nodeName: "beast" },
    message: "List the files in this folder",
    suffix: "x",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
    instanceName: "pricing-page",
    pendingThread: true,
  }),
  ...patch,
});

function setup(saved: OrbitThreadStart) {
  window.localStorage.clear();
  updateStarts(() => [saved]);
  vi.mocked(useThreadShell).mockReturnValue(null);
}

const bubbles = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-orbit-pending-message]")].map((node) => node.textContent);

const view = () => (
  <SidebarProvider>
    <OrbitPendingThreadView startId="s1" />
  </SidebarProvider>
);

describe("OrbitPendingThreadView", () => {
  it("shows the message and the setup card from the saved start, also after a reload", async () => {
    setup(start({ createStartedAt: 1, createKey: "k", createOperationId: 100, instanceId: 41 }));
    {
      await using screen = await render(view(), { router: "/orbit/s1" });
      await expect.element(screen.getByText("Create Instance")).toBeVisible();
      expect(bubbles(screen.container)).toEqual(["List the files in this folder"]);
    }
    // A reload reads the start from localStorage again.
    useOrbitThreadStarts.setState({ starts: readStored() });
    await using screen = await render(view(), { router: "/orbit/s1" });
    await expect.element(screen.getByText("Create Instance")).toBeVisible();
    expect(bubbles(screen.container)).toEqual(["List the files in this folder"]);
    expect(screen.container.querySelectorAll('[data-orbit-setup-status="running"]')).toHaveLength(
      1,
    );
  });

  it("replaces the route with the real thread once, when the clone's thread reached the window", async () => {
    const sent = start({
      environmentId: "env-41",
      instanceId: 41,
      connected: true,
      createStartedAt: 1,
      connectStartedAt: 2,
      sentAt: 3,
    });
    setup(sent);
    vi.mocked(useThreadShell).mockReturnValue({ id: "thread-1" } as never);
    await using screen = await render(view(), { router: "/orbit/s1" });
    const router = screen.router!;
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/env-41/thread-1"));
    expect(router.history.length).toBe(1);
    // The pending view never sends or adds a message; the real thread shows the one sent.
    expect(bubbles(screen.container)).toHaveLength(1);
  });

  it("Dismiss removes only the saved start, without a Gateway call", async () => {
    setup(
      start({
        createStartedAt: 1,
        instanceId: 41,
        error: "Orbit could not create the clone (instance.t3_unready).",
        errorCode: "instance.t3_unready",
      }),
    );
    const fetchSpy = vi.spyOn(window, "fetch");
    await using screen = await render(view(), { router: "/orbit/s1" });
    await expect.element(screen.getByText("The Instance stays; remove it in Orbit.")).toBeVisible();
    await screen.getByRole("button", { name: "Dismiss" }).click();
    expect(readStored()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
