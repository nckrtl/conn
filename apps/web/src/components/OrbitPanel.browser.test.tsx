import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayNode,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../test/render";
import { setEnvironmentProvider } from "../orbit/environmentProvider";
import { useOrbitProfileSyncStatus } from "../orbit/OrbitProfileSync";
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

const instanceServer: OrbitGatewayEnvironment = {
  ...host,
  environmentId: "instance-41",
  label: "pricing-page",
  url: "http://10.44.0.3:4141",
  instanceId: 41,
  powerState: "running",
};

/** Orbit mode in the desktop app (or not), with a Gateway that knows Node 45, one host and one Instance. */
function setup(provider: "default" | "orbit", desktop = true) {
  const profile = { id: 7, name: "Work", settingsVersion: 1, updatedAt: "2026-11-12T08:00:00Z" };
  gateway.client = {
    me: async () => ({ id: 45, name: "nick", wireguardIp: "10.44.0.12", profile }),
    profiles: async () => [profile],
    environments: async () => [host, instanceServer],
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
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/orbit/instances"));
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
  it("lists Instances, Connection and Profile, with the moved sections on Connection", async () => {
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
    await expect.element(nav.getByRole("button").first()).toHaveTextContent("Instances");
    expect(
      nav
        .getByRole("button")
        .elements()
        .map((item) => item.textContent),
    ).toEqual(["Instances", "Connection", "Profile"]);
    await expect.element(nav.getByRole("button").nth(1)).toHaveAttribute("aria-current", "page");

    await expect.element(page.getByText("Signed in to gateway.orbit as 10.44.0.12")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Nodes", exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText("The Nodes that run a T3 server. Conn pairs with them automatically."),
      )
      .toBeVisible();
    await expect.element(page.getByText("10.44.0.3", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Pairing…")).toBeVisible();
    await expect.element(page.getByText("pricing-page")).not.toBeInTheDocument();
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
      .element(page.getByRole("heading", { name: "Nodes", exact: true }))
      .not.toBeInTheDocument();
  });

  it("shows a failed reload on Profile, with Reload", async () => {
    using _env = setup("orbit");
    await using _screen = await render(
      <SidebarProvider>
        <OrbitPanelLayout>
          <OrbitProfilePage />
        </OrbitPanelLayout>
      </SidebarProvider>,
      { router: "/orbit/profile" },
    );
    await expect.element(page.getByRole("heading", { name: "Profile sync" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    (gateway.client as { me: () => Promise<never> }).me = async () => {
      throw new Error("gateway.orbit timed out");
    };
    await act(() => useOrbitProfileSyncStatus.setState({ syncedAt: 1 }));
    await expect.element(page.getByText("gateway.orbit timed out")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await act(() => useOrbitProfileSyncStatus.setState({ syncedAt: null }));
  });

  it("shows each check's state on Connection, and Reload runs the checks again", async () => {
    using _env = setup("orbit");
    let calls = 0;
    let answer: { resolve: (node: OrbitGatewayNode) => void; reject: (error: unknown) => void };
    const client = gateway.client as {
      -readonly [K in "me" | "environments"]: OrbitGatewayClient[K];
    };
    const servers = client.environments;
    client.environments = async () => {
      throw new Error("The Orbit Gateway did not answer.");
    };
    client.me = () =>
      new Promise((resolve, reject) => {
        answer = { resolve, reject };
        calls += 1;
      });
    await using _screen = await render(
      <SidebarProvider>
        <OrbitPanelLayout>
          <OrbitConnectionPage />
        </OrbitPanelLayout>
      </SidebarProvider>,
      { router: "/orbit/connection" },
    );
    const expectStates = (...states: string[]) =>
      vi.waitFor(() =>
        expect(
          ["gateway", "certificate", "device"].map((key) =>
            document
              .querySelector(`[data-check="${key}"] [data-check-state]`)
              ?.getAttribute("data-check-state"),
          ),
        ).toEqual(states),
      );
    const reload = page.getByRole("button", { name: "Reload" });

    await expectStates("checking", "checking", "checking");
    await expect.element(reload).toBeDisabled();

    const unreachable = (message: string) =>
      new OrbitGatewayError({ code: "gateway.unreachable", message, status: 0, details: {} });
    await act(() =>
      answer.reject(unreachable("The Orbit Gateway did not answer: net::ERR_CONNECTION_REFUSED")),
    );
    await expectStates("fail", "not_checked", "not_checked");
    await expect.element(page.getByText(/WireGuard tunnel to Orbit is up/)).toBeVisible();
    await expect.element(page.getByText("Nodes not available")).toBeVisible();

    await userEvent.click(reload);
    await expectStates("checking", "checking", "checking");
    await act(() =>
      answer.reject(
        unreachable("The Orbit Gateway did not answer: net::ERR_CERT_AUTHORITY_INVALID"),
      ),
    );
    await expectStates("pass", "fail", "not_checked");
    await expect.element(page.getByText(/Orbit root CA is not trusted/)).toBeVisible();

    await userEvent.click(reload);
    await act(() =>
      answer.reject(
        new OrbitGatewayError({
          code: "peer.identity_unknown",
          message: "Unknown peer.",
          status: 403,
          details: {},
        }),
      ),
    );
    await expectStates("pass", "pass", "fail");
    await expect.element(page.getByText(/not know this WireGuard address/)).toBeVisible();

    client.environments = servers;
    await userEvent.click(reload);
    await act(() =>
      answer.resolve({ id: 45, name: "nick", wireguardIp: "10.44.0.12", profile: null }),
    );
    await expectStates("pass", "pass", "pass");
    await expect.element(page.getByText("Signed in to gateway.orbit as 10.44.0.12")).toBeVisible();
    await expect.element(page.getByText("10.44.0.3", { exact: true })).toBeVisible();
    expect(calls).toBe(4);
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
