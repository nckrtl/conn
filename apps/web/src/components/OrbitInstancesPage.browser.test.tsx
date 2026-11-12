import type {
  OrbitGatewayClient,
  OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../test/render";
import { setEnvironmentProvider } from "../orbit/environmentProvider";
import { useOrbitInstanceListStore } from "../orbit/orbitInstanceList";
import { loadOrbitPaletteProjects } from "../orbit/orbitPaletteProjects";
import { OrbitInstancesPage } from "./OrbitInstancesPage";
import { OrbitPanelLayout } from "./OrbitPanel";
import { SidebarProvider } from "./ui/sidebar";

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  threads: [] as unknown[],
  openInstance: vi.fn(),
}));
vi.mock("../orbit/OrbitProfileSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../orbit/OrbitProfileSync")>()),
  desktopOrbitGatewayClient: () => mocks.client,
}));
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  useVisibleThreadShells: () => mocks.threads,
}));
vi.mock("../orbit/openOrbitInstance", () => ({ openOrbitInstanceById: mocks.openInstance }));

const NOW = Date.parse("2026-11-12T12:00:00Z");

function clone(
  id: number,
  name: string,
  projectId: number,
  fields: Partial<OrbitGatewayEnvironment> = {},
): OrbitGatewayEnvironment {
  return {
    environmentId: `env-${name}`,
    label: name,
    url: "http://10.44.0.20:3773",
    serverVersion: null,
    registeredBy: null,
    registeredAt: null,
    status: "registered",
    instanceId: id,
    powerState: "running",
    projectId,
    projectName: null,
    projectSlug: null,
    instanceName: name,
    nodeName: "beast",
    instanceUrl: `https://${name}.p${projectId}.test`,
    ...fields,
  };
}

const ENVIRONMENTS = [
  clone(1, "default", 5),
  clone(11, "pricing-page", 5),
  clone(12, "old-spike", 5, { powerState: "stopped" }),
  clone(13, "lost", 5, { status: "session_expired" }),
  clone(21, "bench-a", 66, { nodeName: "nick" }),
];
const PROJECTS = [
  { id: 5, slug: "nckrtl", name: "nckrtl.com", nodeId: 7, nodeName: "beast" },
  { id: 66, slug: "create-bench", name: "create-bench", nodeId: 45, nodeName: "nick" },
  { id: 70, slug: "empty", name: "Empty project", nodeId: 7, nodeName: "beast" },
].map((project) => ({
  ...project,
  instanceDomainSuffix: null,
  cloneable: true,
  cloneableReason: null,
  checks: [],
}));

function shell(id: string, environmentId: string, minutesAgo: number, running = false) {
  return {
    id,
    environmentId,
    title: `Thread ${id}`,
    lineage: { relationshipToParent: null, sideChat: null },
    archivedAt: null,
    updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    runtime: running ? { status: "running" } : null,
  };
}

/** Orbit mode in the desktop app with a Gateway that answers as `environments` says. */
function setup(
  environments: () => Promise<readonly OrbitGatewayEnvironment[]>,
  threads = [] as unknown[],
) {
  mocks.client = {
    environments,
    projects: async () => PROJECTS,
  } satisfies Partial<OrbitGatewayClient>;
  mocks.threads = threads;
  mocks.openInstance.mockReset();
  mocks.openInstance.mockResolvedValue({ kind: "opened", draftId: "draft-1" });
  useOrbitInstanceListStore.setState({ state: { status: "loading" }, generation: 0 });
  setEnvironmentProvider("orbit");
  const bridge = stubGlobal("desktopBridge", { orbitGatewaySend: vi.fn() });
  return {
    [Symbol.dispose]() {
      bridge[Symbol.dispose]();
      setEnvironmentProvider("default");
    },
  };
}

const renderPage = () =>
  render(
    <SidebarProvider>
      <OrbitPanelLayout>
        <OrbitInstancesPage />
      </OrbitPanelLayout>
    </SidebarProvider>,
    { router: "/orbit/instances" },
  );

/** Waits until the element's text contains `text`. */
const expectText = (locator: Locator, text: string) =>
  vi.waitFor(() => expect(locator.element().textContent).toContain(text));

const row = (name: string) => page.getByRole("group", { name, exact: true });

describe("Orbit Instances page", () => {
  it("lists Instances by Project with dots, facts, working threads and the filter", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    using _env = setup(
      async () => ENVIRONMENTS,
      [shell("t1", "env-pricing-page", 5, true), shell("t2", "env-pricing-page", 90)],
    );
    await using _screen = await renderPage();

    await expect.element(page.getByRole("heading", { name: "nckrtl.com" })).toBeVisible();
    expect(
      [...document.querySelectorAll("section h2")].map((heading) => heading.textContent),
    ).toEqual(["CBcreate-bench", "NCnckrtl.com"]);
    expect(document.querySelector('[data-orbit-instance="1"]')).toBeNull();
    await expect.element(page.getByText(": 4 in 2 projects", { exact: false })).toBeVisible();

    await expectText(row("pricing-page"), "beast · pricing-page.p5.test · 2 threads · used 5m ago");
    await expectText(row("pricing-page"), "1 thread working");
    await expectText(row("old-spike"), "Stopped · no threads");
    await expectText(row("lost"), "Must register with Orbit again");
    const dots = Object.fromEntries(
      ["pricing-page", "old-spike", "lost"].map((name) => [
        name,
        row(name).element().querySelector("[data-instance-dot]")?.getAttribute("data-instance-dot"),
      ]),
    );
    expect(dots).toEqual({ "pricing-page": "running", "old-spike": "stopped", lost: "expired" });

    await userEvent.click(page.getByRole("button", { name: "Project filter" }));
    const items = page.getByRole("menuitem");
    await expectText(items.first(), "All projects");
    expect(items.elements().map((item) => item.textContent)).toEqual([
      "All projects",
      "create-bench1",
      "nckrtl.com3",
    ]);
    await userEvent.click(page.getByRole("menuitem", { name: /create-bench/ }));
    await expect.element(page.getByRole("heading", { name: "nckrtl.com" })).not.toBeInTheDocument();
    await expect.element(page.getByText("bench-a", { exact: true })).toBeVisible();
  });

  it("says when a search matches nothing", async () => {
    using _env = setup(async () => ENVIRONMENTS);
    await using _screen = await renderPage();
    const search = page.getByRole("searchbox", { name: "Search instances" });
    await expect.element(page.getByText("bench-a", { exact: true })).toBeVisible();
    await userEvent.fill(search, "nick");
    await expect.element(page.getByText("pricing-page", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("bench-a", { exact: true })).toBeVisible();
    await userEvent.fill(search, "zzz");
    await expect.element(page.getByText("Nothing found.")).toBeVisible();
  });

  it("unfolds a row's threads and opens one in the thread view", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    using _env = setup(
      async () => ENVIRONMENTS,
      [shell("t1", "env-pricing-page", 5, true), shell("t2", "env-pricing-page", 90)],
    );
    await using screen = await renderPage();
    const toggle = row("pricing-page").getByRole("button", { expanded: false });
    await userEvent.click(toggle);
    const list = page.getByRole("list", { name: "Threads in pricing-page" });
    await expect.element(list).toBeVisible();
    await expectText(list.getByRole("button").first(), "Thread t1Working");
    await expectText(list.getByRole("button").nth(1), "Thread t2");
    expect(list.getByRole("button").nth(1).element().textContent).not.toContain("Working");
    // A row without threads does not unfold.
    await expect
      .element(row("old-spike").getByRole("button", { expanded: false }))
      .not.toBeInTheDocument();

    await userEvent.click(list.getByRole("button", { name: /Thread t2/ }));
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/env-pricing-page/t2"),
    );
  });

  it("starts a thread in a running Instance and says why a stopped or lost one cannot", async () => {
    using _env = setup(async () => ENVIRONMENTS);
    await using _screen = await renderPage();
    const newThread = (name: string) =>
      row(name).getByRole("button", { name: "New thread in this Instance" });

    await userEvent.click(newThread("pricing-page"));
    await vi.waitFor(() => expect(mocks.openInstance).toHaveBeenCalledTimes(1));
    expect(mocks.openInstance.mock.calls[0]![0]).toMatchObject({
      project: {
        id: 5,
        slug: "nckrtl",
        name: "nckrtl.com",
        nodeName: "beast",
        domainSuffix: ".p5.test",
      },
      instance: { id: 11, name: "pricing-page" },
    });
    // The open reads the environments afresh, never the palette's cached list (here stale).
    await loadOrbitPaletteProjects({
      projects: async () => PROJECTS,
      environments: async () => [],
    } as unknown as OrbitGatewayClient);
    await expect(mocks.openInstance.mock.calls[0]![0].environments()).resolves.toEqual(
      ENVIRONMENTS,
    );

    await expect.element(newThread("old-spike")).toBeDisabled();
    await expect
      .element(newThread("old-spike"))
      .toHaveAttribute("aria-description", "Orbit cannot start a stopped Instance yet");
    await expect.element(newThread("lost")).toBeDisabled();
    await expect
      .element(newThread("lost"))
      .toHaveAttribute("aria-description", "Must register with Orbit again");
  });

  it("shows skeleton rows while loading, then the Gateway notice with a working Retry", async () => {
    let answer: (value: readonly OrbitGatewayEnvironment[]) => void = () => {};
    let fail: (error: Error) => void = () => {};
    using _env = setup(
      () =>
        new Promise((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    );
    await using _screen = await renderPage();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-orbit-instance-skeleton]")).toHaveLength(4),
    );

    fail(new Error("gateway.orbit timed out"));
    await expect
      .element(page.getByText("Instances are not shown: the Gateway did not answer."))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-orbit-instance-skeleton]")).toHaveLength(4),
    );
    answer([]);
    await expect.element(page.getByText("No instances yet.")).toBeVisible();
    await expect
      .element(page.getByText("To make one, choose New thread, then an Orbit Project."))
      .toBeVisible();
  });
});
