import type {
  OrbitGatewayClient,
  OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../test/render";
import { setEnvironmentProvider } from "../orbit/environmentProvider";
import { OrbitPanelLayout } from "./OrbitPanel";
import { OrbitConnectionPage, OrbitProfilePage } from "./settings/OrbitSettings";
import { RailActions } from "./sidebar/WorkspaceRail";
import { SidebarProvider } from "./ui/sidebar";

const gateway = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../orbit/OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orbit/OrbitProfileSync")>()),
  desktopOrbitGatewayClient: () => gateway.client,
}));

const host: OrbitGatewayEnvironment = {
  environmentId: "host-mini",
  label: "mini",
  url: "http://10.44.0.3:3773",
  serverVersion: null,
  registeredBy: null,
  registeredAt: "2026-11-10T10:00:00+00:00",
  status: "registered",
  instanceId: null,
  powerState: null,
  projectId: null,
  projectName: null,
  projectSlug: null,
  instanceName: null,
  nodeName: null,
  instanceUrl: null,
};

/** Orbit mode in the desktop app (or not), with a Gateway that knows Node 45 and one host. */
function setup(provider: "default" | "orbit", desktop = true) {
  const profile = { id: 7, name: "Work", settingsVersion: 1, updatedAt: "2026-11-12T08:00:00Z" };
  gateway.client = {
    me: async () => ({ id: 45, name: "nick", wireguardIp: "10.44.0.12", profile }),
    profiles: async () => [profile],
    environments: async () => [host],
  } satisfies Partial<OrbitGatewayClient>;
  setEnvironmentProvider(provider);
  const bridge = desktop ? stubGlobal("desktopBridge", { orbitGatewaySend: vi.fn() }) : null;
  return {
    [Symbol.dispose]() {
      bridge?.[Symbol.dispose]();
      setEnvironmentProvider("default");
    },
  };
}

function railLabels(container: HTMLElement) {
  return [...container.querySelectorAll("button[aria-label]")].map((button) =>
    button.getAttribute("aria-label"),
  );
}

describe("Orbit rail icon", () => {
  it("sits above Settings only while environments come from Orbit", async () => {
    using _env = setup("default");
    await using screen = await render(
      <SidebarProvider>
        <RailActions />
      </SidebarProvider>,
    );
    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(railLabels(screen.container)).not.toContain("Orbit");

    await act(() => setEnvironmentProvider("orbit"));
    await expect.element(screen.getByRole("button", { name: "Orbit" })).toBeVisible();
    expect(railLabels(screen.container).slice(-2)).toEqual(["Orbit", "Settings"]);

    await userEvent.click(screen.getByRole("button", { name: "Orbit" }));
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/orbit/connection"),
    );
    await expect
      .element(screen.getByRole("button", { name: "Orbit" }))
      .toHaveAttribute("aria-pressed", "true");

    await act(() => setEnvironmentProvider("default"));
    expect(railLabels(screen.container)).not.toContain("Orbit");
  });

  it("is absent outside the desktop app", async () => {
    using _env = setup("orbit", false);
    await using screen = await render(
      <SidebarProvider>
        <RailActions />
      </SidebarProvider>,
    );
    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(railLabels(screen.container)).not.toContain("Orbit");
  });
});

describe("Orbit panel", () => {
  it("opens on Connection, with Profile next and the moved sections", async () => {
    using _env = setup("orbit");
    await using screen = await render(
      <SidebarProvider>
        <OrbitPanelLayout>
          <OrbitConnectionPage />
        </OrbitPanelLayout>
      </SidebarProvider>,
      { router: "/orbit/connection" },
    );
    const nav = page.getByRole("navigation", { name: "Orbit sections" });
    await expect.element(nav.getByRole("button").first()).toHaveTextContent("Connection");
    expect(
      nav
        .getByRole("button")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["Connection", "Profile"]);
    await expect.element(nav.getByRole("button").first()).toHaveAttribute("aria-current", "page");

    await expect.element(page.getByText("Signed in to gateway.orbit as 10.44.0.12")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Orbit servers" })).toBeVisible();
    await expect.element(page.getByText("10.44.0.3:3773")).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Orbit profile" }))
      .not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Open Environments" }));
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/settings/connections"),
    );
    expect(screen.router?.state.location.hash).toBe("environment-provider");
  });

  it("shows the profile and its sync on Profile", async () => {
    using _env = setup("orbit");
    await using _screen = await render(
      <SidebarProvider>
        <OrbitPanelLayout>
          <OrbitProfilePage />
        </OrbitPanelLayout>
      </SidebarProvider>,
      { router: "/orbit/profile" },
    );
    await expect.element(page.getByRole("combobox", { name: "Profile" })).toHaveTextContent("Work");
    await expect.element(page.getByRole("heading", { name: "Profile sync" })).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "New profile name" })).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Orbit servers" }))
      .not.toBeInTheDocument();
  });

  it("closes when environments stop coming from Orbit", async () => {
    using _env = setup("orbit");
    await using screen = await render(
      <SidebarProvider>
        <OrbitPanelLayout>
          <OrbitConnectionPage />
        </OrbitPanelLayout>
      </SidebarProvider>,
      { router: "/orbit/connection" },
    );
    await expect.element(page.getByRole("dialog", { name: "Orbit" })).toBeVisible();
    await act(() => setEnvironmentProvider("default"));
    await expect.element(page.getByRole("dialog", { name: "Orbit" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  });
});
