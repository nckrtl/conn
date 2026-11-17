import type { OrbitLaunch } from "@t3tools/client-runtime/orbit-gateway";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { OrbitPendingThreadView } from "./OrbitPendingThreadView";
import { orbitLaunches, useOrbitLaunches } from "./orbitLaunches";

vi.mock("./orbitLaunches", () => ({
  useOrbitLaunches: vi.fn(),
  orbitLaunches: { act: vi.fn(), refresh: vi.fn() },
  attachOrbitLaunchThread: vi.fn(),
}));

it("shows a launch awaiting cleanup from Orbit and offers its current retry", async () => {
  const waiting = { status: "pending", started_at: null, finished_at: null, error: null } as const;
  const blocked = { available: false, reason: null, requires: null };
  const snapshot: OrbitLaunch = {
    id: 14,
    kind: "conn.launch",
    status: "waiting",
    created_at: "2026-11-17T12:00:00Z",
    started_at: "2026-11-17T12:00:01Z",
    finished_at: null,
    cancel_requested: true,
    poll_after_seconds: 10,
    error_code: "resource.busy",
    launch_id: "launch-14",
    project_id: 78,
    instance_id: 21,
    workspace_id: null,
    target_node_id: 1,
    initiator_node_id: 2,
    source: "web",
    phase: "cancelling",
    stages: {
      workspace_server: waiting,
      first_message: waiting,
      publication: waiting,
      application_preview: waiting,
      cleanup: {
        ...waiting,
        status: "failed",
        error: { code: "resource.busy", detail: "The instance still has a route." },
      },
    },
    readiness: { workspace_server: null, first_message: null, application_preview: null },
    actions: {
      cancel: blocked,
      retry_launch: { ...blocked, available: true },
      retry_application: blocked,
    },
    children: {
      create_operation_id: 11,
      wake_operation_id: null,
      completion_operation_id: null,
      destroy_operation_id: 20,
    },
    thread: null,
  };
  vi.mocked(useOrbitLaunches).mockReturnValue({ launches: [snapshot], loaded: true, error: null });
  await using screen = await render(<OrbitPendingThreadView startId="launch-14" />, {
    router: "/orbit/launch-14",
  });
  await expect.element(screen.getByText("Cancelling", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("The instance still has a route.")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Cancel launch" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
  expect(orbitLaunches.act).toHaveBeenCalledWith(14, "retry_launch");
});
