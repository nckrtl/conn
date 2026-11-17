import {
  createOrbitGatewayClient,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayRequest,
  type OrbitGatewayResponse,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../test/render";
import { setEnvironmentProvider } from "../orbit/environmentProvider";
import { useOrbitInstanceListStore } from "../orbit/orbitInstanceList";
import { resetOrbitInstanceRemovalsForTest } from "../orbit/orbitInstanceRemoval";
import { useOrbitInstanceSleep } from "../orbit/orbitInstanceSleep";
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
  gateway: (request: OrbitGatewayRequest) => Promise<OrbitGatewayResponse> = async () => {
    throw new Error("no Gateway call expected");
  },
  /** Orbit's answer to the Git read when the remove dialog opens; default: an older Gateway. */
  gitRead: (request: OrbitGatewayRequest) => Promise<OrbitGatewayResponse> = async () =>
    answer(404, { error: { code: "http.404", message: "Not Found.", details: {} } }),
) {
  const real = createOrbitGatewayClient((request) =>
    request.method === "GET" && /^\/instances\/\d+\/work$/.test(request.path)
      ? gitRead(request)
      : gateway(request),
  );
  mocks.client = {
    me: async () => ({ id: 11, name: "mini", wireguardIp: "10.44.0.9", profile: null }),
    environments,
    projects: async () => PROJECTS,
    destroyInstance: real.destroyInstance,
    operation: real.operation,
    instanceGit: real.instanceGit,
  } satisfies Partial<OrbitGatewayClient>;
  resetOrbitInstanceRemovalsForTest();
  window.localStorage.removeItem("conn:orbit-instance-removals:v1");
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

  it("starts a thread in a running or asleep Instance and says why a lost one cannot", async () => {
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

    // Conn wakes an asleep Instance when a thread starts in it.
    await expect.element(newThread("old-spike")).not.toHaveAttribute("aria-disabled");
    await vi.waitFor(() => expect(row("old-spike").element().textContent).toContain("· Stopped ·"));
    // An older Gateway without the wake route: today's reason, and the button stays blocked.
    // A fixed time far ahead, so the memory of an older Gateway cannot expire in the test.
    useOrbitInstanceSleep.setState({ unsupportedAt: Number.MAX_SAFE_INTEGER });
    await expect.element(newThread("old-spike")).toHaveAttribute("aria-disabled", "true");
    await expect
      .element(newThread("old-spike"))
      .toHaveAttribute("aria-description", "Orbit cannot start a stopped Instance yet");
    await expect.element(newThread("lost")).toHaveAttribute("aria-disabled", "true");
    await expect
      .element(newThread("lost"))
      .toHaveAttribute("aria-description", "Must register with Orbit again");

    // A blocked button stays in the tab order, shows its reason on keyboard focus and does nothing.
    await userEvent.keyboard("{Shift}");
    (newThread("old-spike").element() as HTMLElement).focus();
    expect(document.activeElement).toBe(newThread("old-spike").element());
    await expect
      .element(page.getByText("Orbit cannot start a stopped Instance yet", { exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(newThread("lost"), { force: true });
    expect(mocks.openInstance).toHaveBeenCalledTimes(1);
    useOrbitInstanceSleep.setState({ unsupportedAt: null });
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

  it("keeps the search field usable when the row is narrow", async () => {
    using _env = setup(async () => ENVIRONMENTS);
    await page.viewport(360, 720);
    await using _screen = await renderPage();
    const search = page.getByRole("searchbox", { name: "Search instances" });
    await expect.element(search).toBeVisible();
    const field = search.element().closest('[data-slot="input-group"]')!.getBoundingClientRect();
    const filter = page.getByRole("button", { name: "Project filter" }).element();
    // The filter wraps under the field instead of squeezing it.
    expect(field.width).toBeGreaterThanOrEqual(192);
    expect(filter.getBoundingClientRect().top).toBeGreaterThanOrEqual(field.bottom);
  });
});

/** Orbit's answers to handle A, as its proof recorded them. */
const answer = (status: number, body: unknown): OrbitGatewayResponse => ({
  status,
  body: JSON.stringify(body),
});
const destroyOperation = (status: string) =>
  answer(status === "queued" ? 202 : 200, {
    data: {
      id: 77,
      kind: "instance.destroy",
      status,
      target_id: 11,
      poll_after_seconds: status === "succeeded" ? null : 1,
    },
  });
const refusal = (code: string, message: string, details: unknown = {}) =>
  answer(409, { error: { code, message, details } });

describe("Removing an Instance", () => {
  it("against an older Gateway (no Git read): asks once, takes Orbit's unknown-state refusal as the tick, shows Removing…, then drops the row", async () => {
    const requests: OrbitGatewayRequest[] = [];
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let removed = false;
    using _env = setup(
      async () =>
        removed
          ? ENVIRONMENTS.filter((environment) => environment.instanceId !== 11)
          : ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        if (request.path === "/instances/11/destroy") {
          const body = request.body as { acknowledge_unsaved: boolean };
          return body.acknowledge_unsaved
            ? destroyOperation("queued")
            : refusal(
                "instance.unsaved_work",
                "The Instance may hold unsaved work. Acknowledge its removal to continue.",
                { uncommitted: null, unpushed: null, state: "unknown" },
              );
        }
        await finished;
        removed = true;
        return destroyOperation("succeeded");
      },
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    await expectText(dialog, "Orbit removes the Instance pricing-page.p5.test on beast");
    await expect.element(dialog.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Remove Instance" }));

    // Orbit cannot read the Git state yet: it refuses once, and the dialog asks for the tick.
    await expect
      .element(page.getByText(/Orbit cannot tell whether this Instance holds work/))
      .toBeVisible();
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeDisabled();
    await userEvent.click(page.getByText("Remove it anyway. Any unsaved work is lost."));
    await userEvent.click(confirm);

    await expect.element(row("pricing-page").getByText("Removing…")).toBeVisible();
    finish();
    await expect.element(row("pricing-page")).not.toBeInTheDocument();
    await expect.element(row("old-spike")).toBeVisible();

    const destroys = requests.filter((request) => request.method === "POST");
    expect(destroys.map((request) => request.body)).toEqual([
      { acknowledge_unsaved: false },
      { acknowledge_unsaved: true },
    ]);
    expect(destroys[0]!.idempotencyKey).toMatch(/^conn-instance-destroy:11:/);
    expect(destroys[1]!.idempotencyKey).not.toBe(destroys[0]!.idempotencyKey);
  });

  it("keeps Orbit's refusal on the row, with Retry", async () => {
    let calls = 0;
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async () => {
        calls++;
        return refusal(
          "instance.default_protected",
          "The default Instance cannot be removed from Conn.",
        );
      },
    );
    await using _screen = await renderPage();

    await userEvent.click(row("old-spike").getByRole("button", { name: "Remove Instance" }));
    await userEvent.click(
      page.getByRole("alertdialog").getByRole("button", { name: "Remove Instance" }),
    );
    await expect
      .element(
        row("old-spike").getByText(
          "Could not remove: The default Instance cannot be removed from Conn.",
        ),
      )
      .toBeVisible();
    await userEvent.click(row("old-spike").getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(calls).toBe(2));
    await expect
      .element(row("old-spike").getByRole("button", { name: "Remove Instance" }))
      .toBeVisible();
  });

  it("shows a failed removal with Orbit's reason and Retry, and shows it again after a restart", async () => {
    let destroys = 0;
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        if (request.path === "/instances/11/destroy") {
          destroys++;
          return destroyOperation("queued");
        }
        return answer(200, {
          data: {
            id: 501,
            kind: "instance.destroy",
            status: "failed",
            target_id: 11,
            poll_after_seconds: null,
            error: {
              code: "swamp.start_unavailable",
              detail: "The native workflow start could not connect.",
            },
          },
        });
      },
    );
    {
      await using _screen = await renderPage();
      await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
      await userEvent.click(
        page.getByRole("alertdialog").getByRole("button", { name: "Remove Instance" }),
      );
      await expect
        .element(
          row("pricing-page").getByText(
            "Removal failed: The native workflow start could not connect.",
          ),
        )
        .toBeVisible();
    }
    // A restart: the window's memory is gone, the saved record is not.
    resetOrbitInstanceRemovalsForTest();
    useOrbitInstanceListStore.setState({ state: { status: "loading" }, generation: 0 });
    await using _again = await renderPage();
    await expect
      .element(
        row("pricing-page").getByText(
          "Removal failed: The native workflow start could not connect.",
        ),
      )
      .toBeVisible();
    await userEvent.click(row("pricing-page").getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(destroys).toBe(2));
  });
});

const gitState = (data: unknown) => async () => answer(200, { data });
const destroys = (requests: readonly OrbitGatewayRequest[]) =>
  requests.filter((request) => request.method === "POST").map((request) => request.body);

/** Orbit's `/work` read (contract v2). */
const work = (fields: {
  modified?: number;
  untracked?: number;
  branches?: ReadonlyArray<{ name: string; count: number }>;
  branchCount?: number;
  stashes?: number;
}) => {
  const branches = fields.branches ?? [];
  const commits = branches.reduce((sum, branch) => sum + branch.count, 0);
  const modified = fields.modified ?? 0;
  const untracked = fields.untracked ?? 0;
  const stashes = fields.stashes ?? 0;
  const dirty = modified + untracked + commits + stashes > 0;
  return {
    instance_id: 11,
    state: dirty ? "dirty" : "clean",
    reason: null,
    read_at: "2026-11-13T20:31:02Z",
    duration_ms: 180,
    baseline: "recorded",
    head: "main",
    uncommitted: modified + untracked,
    unpushed: commits,
    modified: {
      count: modified,
      names: Array.from({ length: Math.min(modified, 5) }, (_, i) => `f${i}`),
    },
    untracked: { count: untracked, names: [] },
    commits: {
      count: commits,
      branch_count: fields.branchCount ?? branches.length,
      branches: branches.slice(0, 5),
    },
    stashes: { count: stashes, names: [] },
  };
};
const UNKNOWN = {
  instance_id: 12,
  state: "unknown",
  reason: "asleep",
  read_at: "2026-11-13T20:32:00Z",
  duration_ms: 40,
  baseline: null,
  head: null,
  uncommitted: null,
  unpushed: null,
  modified: null,
  untracked: null,
  commits: null,
  stashes: null,
};

describe("Removing an Instance, work state read when the dialog opens", () => {
  it("clean: no warning, and one click removes", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      gitState(work({})),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeEnabled();
    await expect.element(dialog.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(confirm);
    await expect.element(row("pricing-page").getByText("Removing…")).toBeVisible();
    expect(destroys(requests)).toEqual([{ acknowledge_unsaved: false }]);
  });

  it("dirty: the warning with every fact from the start; the ticked click removes at once", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      gitState(
        work({
          modified: 3,
          untracked: 2,
          branches: [
            { name: "feature-x", count: 2 },
            { name: "feature-y", count: 1 },
            { name: "fix-z", count: 4 },
            { name: "spike-1", count: 1 },
            { name: "spike-2", count: 1 },
          ],
          branchCount: 7,
          stashes: 1,
        }),
      ),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    await expect
      .element(dialog.getByText("This Instance holds work that is not on the remote:"))
      .toBeVisible();
    await vi.waitFor(() =>
      expect([...dialog.element().querySelectorAll("li")].map((item) => item.textContent)).toEqual([
        "3 uncommitted changes",
        "2 new files",
        "2 commits not pushed on branch feature-x",
        "1 commit not pushed on branch feature-y",
        "4 commits not pushed on branch fix-z",
        "and 4 more branches",
        "1 stash",
      ]),
    );
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeDisabled();
    await userEvent.click(dialog.getByText("Remove it anyway. This work is lost."));
    await expect.element(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await expect.element(row("pricing-page").getByText("Removing…")).toBeVisible();
    expect(destroys(requests)).toEqual([{ acknowledge_unsaved: true }]);
  });

  it("unknown: Orbit's sentence and the tick from the start, with no reason in words", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      gitState(UNKNOWN),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("old-spike").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    await expect
      .element(
        dialog.getByText(
          "Orbit cannot tell whether this Instance holds work that is not on the remote.",
        ),
      )
      .toBeVisible();
    expect(dialog.element().textContent).not.toContain("asleep");
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeDisabled();
    await userEvent.click(dialog.getByText("Remove it anyway. Any unsaved work is lost."));
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(destroys(requests)).toEqual([{ acknowledge_unsaved: true }]));
  });

  it("a host Instance (409 not_container): the dialog works as before", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      async () => refusal("instance.not_container", "Only container Instances."),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeEnabled();
    await expect.element(dialog.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(destroys(requests)).toEqual([{ acknowledge_unsaved: false }]));
  });

  it("a state that changed before the click: Orbit's refusal opens the dialog again with it", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        const body = request.body as { acknowledge_unsaved: boolean };
        return body.acknowledge_unsaved
          ? destroyOperation("queued")
          : refusal(
              "instance.unsaved_work",
              "The Instance holds unsaved work.",
              work({ modified: 2 }),
            );
      },
      gitState(work({})),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await expect
      .element(page.getByRole("alertdialog").getByText("2 uncommitted changes"))
      .toBeVisible();
    await userEvent.click(page.getByText("Remove it anyway. This work is lost."));
    await userEvent.click(
      page.getByRole("alertdialog").getByRole("button", { name: "Remove Instance" }),
    );
    await vi.waitFor(() =>
      expect(destroys(requests)).toEqual([
        { acknowledge_unsaved: false },
        { acknowledge_unsaved: true },
      ]),
    );
  });

  it("a slow read: Remove Instance waits only a moment, then works as before", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      () => new Promise<OrbitGatewayResponse>(() => {}),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeDisabled();
    await expect.element(confirm, { timeout: 3_000 }).toBeEnabled();
    await expect.element(dialog.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(destroys(requests)).toEqual([{ acknowledge_unsaved: false }]));
  });

  it("a late answer with work: the button turns off, and a click in that same moment removes nothing", async () => {
    const requests: OrbitGatewayRequest[] = [];
    let answerLate: (response: OrbitGatewayResponse) => void = () => {};
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      () =>
        new Promise<OrbitGatewayResponse>((resolve) => {
          answerLate = resolve;
        }),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm, { timeout: 3_000 }).toBeEnabled();

    // The answer lands; before React draws it, the pointer clicks the still-active button.
    answerLate(answer(200, { data: work({ modified: 1 }) }));
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const button = confirm.element() as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();

    await expect.element(dialog.getByText("1 uncommitted change")).toBeVisible();
    await expect.element(confirm).toBeDisabled();
    expect(destroys(requests)).toEqual([]);
    await userEvent.click(dialog.getByText("Remove it anyway. This work is lost."));
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(destroys(requests)).toEqual([{ acknowledge_unsaved: true }]));
  });

  it("clean with a working thread: the tick only stops the thread, so Orbit still reads at the destroy", async () => {
    const requests: OrbitGatewayRequest[] = [];
    using _env = setup(
      async () => ENVIRONMENTS,
      [shell("t1", "env-pricing-page", 1, true)],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      gitState(work({})),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("Remove it anyway. The thread stops.")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm).toBeDisabled();
    await vi.waitFor(() => expect(requests).toEqual([]));
    await userEvent.click(dialog.getByText("Remove it anyway. The thread stops."));
    await expect.element(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await vi.waitFor(() => expect(destroys(requests)).toEqual([{ acknowledge_unsaved: false }]));
  });

  it("a late clean answer in the same moment as a click: the click removes, without the override", async () => {
    const requests: OrbitGatewayRequest[] = [];
    let answerLate: (response: OrbitGatewayResponse) => void = () => {};
    using _env = setup(
      async () => ENVIRONMENTS,
      [],
      async (request) => {
        requests.push(request);
        return destroyOperation("queued");
      },
      () =>
        new Promise<OrbitGatewayResponse>((resolve) => {
          answerLate = resolve;
        }),
    );
    await using _screen = await renderPage();

    await userEvent.click(row("pricing-page").getByRole("button", { name: "Remove Instance" }));
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Remove Instance" });
    await expect.element(confirm, { timeout: 3_000 }).toBeEnabled();
    answerLate(answer(200, { data: work({}) }));
    for (let i = 0; i < 50; i++) await Promise.resolve();
    (confirm.element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(destroys(requests)).toEqual([{ acknowledge_unsaved: false }]));
  });
});
