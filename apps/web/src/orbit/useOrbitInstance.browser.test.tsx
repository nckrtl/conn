import type { EnvironmentId, OrbitInstanceDescriptor } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { ThreadDetailsOrbitRows } from "../components/chat/ThreadDetailsOrbitRows";
import { useEnvironmentProvider, useOrbitInstance } from "./environmentProvider";

const servers = vi.hoisted(() => new Map<string, { environment: object }>());

vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useServerConfigs: () => servers,
}));

const CLONE = "env-clone" as EnvironmentId;

function setup(input: {
  readonly gateway?: OrbitInstanceDescriptor;
  readonly server?: OrbitInstanceDescriptor;
}) {
  servers.clear();
  // A stock T3 server sends no `orbitInstance`.
  servers.set(CLONE, {
    environment: input.server === undefined ? {} : { orbitInstance: input.server },
  });
  useEnvironmentProvider.setState({
    orbitInstances: input.gateway === undefined ? {} : { [CLONE]: input.gateway },
  });
}

function PanelRow() {
  const orbitInstance = useOrbitInstance(CLONE);
  return orbitInstance ? (
    <ThreadDetailsOrbitRows orbitInstance={orbitInstance} onOpenUrl={vi.fn()} />
  ) : (
    <span>no row</span>
  );
}

it("shows the row from the Gateway's facts for a stock server", async () => {
  setup({
    gateway: {
      projectId: 3,
      instanceId: 41,
      projectName: "Mealou",
      instanceName: "fix",
      nodeName: "beast",
      url: "https://fix.mealou.test",
    },
    server: { projectId: 3, instanceId: 41, projectName: "From server" },
  });
  await using _screen = await render(<PanelRow />, { router: false }); // A leaf row: no route reads it.

  await expect
    .element(page.getByLabelText("Orbit Project Mealou, Instance fix, Node beast"))
    .toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Open https://fix.mealou.test" }))
    .toBeVisible();
});

it("falls back to the server's descriptor", async () => {
  setup({ server: { projectId: 3, instanceId: 41, projectName: "From server" } });
  await using _screen = await render(<PanelRow />, { router: false }); // A leaf row: no route reads it.
  await expect.element(page.getByLabelText("Orbit Project From server")).toBeVisible();
});

it("shows no row without either", async () => {
  setup({});
  await using _screen = await render(<PanelRow />, { router: false }); // A leaf row: no route reads it.
  await expect.element(page.getByText("no row")).toBeVisible();
});
