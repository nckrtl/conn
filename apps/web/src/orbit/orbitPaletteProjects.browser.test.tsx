import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { useEnvironmentProvider } from "./environmentProvider";
import { useOrbitPaletteProjects } from "./orbitPaletteProjects";

const gateway = vi.hoisted(() => ({
  projects: vi.fn(async () => [{ id: 66, slug: "create-bench" }]),
  environments: vi.fn(async () => []),
}));

vi.mock("./OrbitProfileSync", () => ({ desktopOrbitGatewayClient: () => gateway }));

function Probe() {
  const state = useOrbitPaletteProjects(true);
  return (
    <span>{state.status === "loaded" ? `${state.projects.length} projects` : state.status}</span>
  );
}

function setup(provider: "orbit" | "default") {
  gateway.projects.mockClear();
  useEnvironmentProvider.setState({ provider });
}

describe("useOrbitPaletteProjects", () => {
  it("lists the Orbit Projects in the desktop app in Orbit mode, with no other switch", async () => {
    setup("orbit");
    using _bridge = stubGlobal("desktopBridge", { orbitGatewaySend: vi.fn() });
    await using screen = await render(<Probe />);

    await expect.element(screen.getByText("1 projects")).toBeVisible();
    expect(gateway.projects).toHaveBeenCalledWith({ includeUnavailable: true });
  });

  it("stays off in the desktop app outside Orbit mode", async () => {
    setup("default");
    using _bridge = stubGlobal("desktopBridge", { orbitGatewaySend: vi.fn() });
    await using screen = await render(<Probe />);

    await expect.element(screen.getByText("off")).toBeVisible();
    expect(gateway.projects).not.toHaveBeenCalled();
  });

  it("stays off in the web app, even in Orbit mode", async () => {
    setup("orbit");
    await using screen = await render(<Probe />);

    await expect.element(screen.getByText("off")).toBeVisible();
    expect(gateway.projects).not.toHaveBeenCalled();
  });
});
