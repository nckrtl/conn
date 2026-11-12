import type {
  OrbitGatewayClient,
  OrbitGatewayNode,
  OrbitGatewayProfile,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../test/render";
import { setEnvironmentProvider } from "../orbit/environmentProvider";
import { useOrbitProfileSyncStatus } from "../orbit/OrbitProfileSync";
import { OrbitPanelLayout } from "./OrbitPanel";
import { OrbitProfilePage } from "./OrbitProfilePage";
import { SidebarProvider } from "./ui/sidebar";

const gateway = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../orbit/OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orbit/OrbitProfileSync")>()),
  desktopOrbitGatewayClient: () => gateway.client,
}));

const profile = (id: number, name: string): OrbitGatewayProfile => ({
  id,
  name,
  settingsVersion: 1,
  updatedAt: "2026-11-12T08:00:00Z",
});

/** A fake Gateway with profiles Nick (bound) and Work; it records every write. */
function setup() {
  const profiles = [profile(1, "Nick"), profile(2, "Work")];
  let bound: OrbitGatewayProfile | null = profiles[0]!;
  const writes: string[] = [];
  const node = (): OrbitGatewayNode => ({
    id: 45,
    name: "nick",
    wireguardIp: "10.44.0.12",
    profile: bound,
  });
  gateway.client = {
    me: async () => node(),
    profiles: async () => [...profiles],
    createProfile: async (name: string) => {
      writes.push(`create ${name}`);
      const created = profile(3, name);
      profiles.push(created);
      return created;
    },
    bindProfile: async (id: number) => {
      writes.push(`bind ${id}`);
      bound = profiles.find((entry) => entry.id === id) ?? null;
      return node();
    },
  } satisfies Partial<OrbitGatewayClient>;
  setEnvironmentProvider("orbit");
  useOrbitProfileSyncStatus.setState({
    phase: "synced",
    profileName: "Nick",
    error: null,
    syncedAt: 0,
    sections: "supported",
    sectionsError: null,
  });
  const bridge = stubGlobal("desktopBridge", { orbitGatewaySend: vi.fn() });
  return {
    writes,
    [Symbol.dispose]() {
      bridge[Symbol.dispose]();
      setEnvironmentProvider("default");
      useOrbitProfileSyncStatus.setState({ phase: "off", syncedAt: null, sections: "unknown" });
    },
  };
}

// The nav item is also called Profile; only the menu trigger carries the label.
const trigger = () => page.getByLabelText("Profile", { exact: true });

const renderPage = () =>
  render(
    <SidebarProvider>
      <OrbitPanelLayout>
        <OrbitProfilePage />
      </OrbitPanelLayout>
    </SidebarProvider>,
    { router: "/orbit/profile" },
  );

describe("Orbit profile page", () => {
  it("shows one profile with every part synced, and none of the removed controls", async () => {
    using _env = setup();
    await using _screen = await renderPage();
    await expect.element(trigger()).toHaveTextContent("Nick");
    await expect.element(page.getByText(/^Synced with Nick\. Last synced /)).toBeVisible();
    for (const part of ["Workspaces", "Appearance", "Desktop settings"]) {
      await expect.element(page.getByText(part, { exact: true })).toBeVisible();
    }
    expect(document.querySelectorAll("[data-profile-part]")).toHaveLength(3);
    await expect.element(page.getByText("Synced", { exact: true }).nth(2)).toBeVisible();
    expect(document.querySelectorAll("[role=switch]")).toHaveLength(0);
    for (const removed of ["Sync now", "Use this device", "Use the profile", "Restore"]) {
      await expect.element(page.getByRole("button", { name: removed })).not.toBeInTheDocument();
    }
    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
  });

  it("switches to another profile at once, without asking", async () => {
    using env = setup();
    await using _screen = await renderPage();
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole("menuitemradio", { name: "Work" }));
    await vi.waitFor(() => expect(env.writes).toEqual(["bind 2"]));
    await expect.element(page.getByRole("dialog", { name: /confirm/i })).not.toBeInTheDocument();
    await expect.element(trigger()).toHaveTextContent("Work");
  });

  it("turns the row into a name field with New profile…, and creates on Enter", async () => {
    using env = setup();
    await using _screen = await renderPage();
    await userEvent.click(trigger());
    await userEvent.click(page.getByRole("menuitem", { name: "New profile…" }));
    const field = page.getByRole("textbox", { name: "Profile name" });
    await expect.element(field).toHaveFocus();
    await expect
      .element(page.getByText("The new profile starts with what this device has now."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Create" })).toBeDisabled();

    await userEvent.keyboard("   ");
    await expect.element(page.getByRole("button", { name: "Create" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await expect.element(field).not.toBeInTheDocument();
    expect(env.writes).toEqual([]);

    await userEvent.click(trigger());
    await userEvent.click(page.getByRole("menuitem", { name: "New profile…" }));
    await userEvent.keyboard("  Laptop {Enter}");
    await vi.waitFor(() => expect(env.writes).toEqual(["create Laptop", "bind 3"]));
    await expect.element(trigger()).toHaveTextContent("Laptop");
    await expect.element(field).not.toBeInTheDocument();
  });

  it("shows a failed reload with Reload", async () => {
    using _env = setup();
    await using _screen = await renderPage();
    await expect.element(trigger()).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).not.toBeInTheDocument();
    (gateway.client as { me: () => Promise<never> }).me = async () => {
      throw new Error("gateway.orbit timed out");
    };
    await act(() => useOrbitProfileSyncStatus.setState({ syncedAt: 1 }));
    await expect.element(page.getByText("gateway.orbit timed out")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reload" })).toBeVisible();
  });
});
