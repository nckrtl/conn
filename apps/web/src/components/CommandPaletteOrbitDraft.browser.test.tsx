import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore } from "../composerDraftStore";
import { useEnvironmentProvider } from "../orbit/environmentProvider";
import { orbitDraftLogicalProjectKey } from "../orbit/orbitDraft";
import { dismissOrbitThreadStart } from "../orbit/orbitThreadStarts";
import { readStored } from "../orbit/orbitThreadStartStore";
import { CommandPalette } from "./CommandPalette";
import type { OrbitPaletteProjectsState } from "./CommandPalette.logic";

const orbit = vi.hoisted(() => ({
  state: { status: "off" } as OrbitPaletteProjectsState,
}));
vi.mock("../orbit/orbitPaletteProjects", () => ({
  recheckOrbitPaletteProjects: async () => false,
  useOrbitPaletteProjects: () => orbit.state,
  useOrbitPairedEnvironmentIds: () => new Set<string>(),
  retryOrbitPaletteProjects: () => {},
  checkOrbitInstanceName: async (_projectId: number, name: string) => ({
    name,
    available: true,
    reason: null,
    domain: `${name}.house.test`,
  }),
}));

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  orbit.state = {
    status: "loaded",
    projects: [
      {
        id: 69,
        slug: "house",
        name: "house",
        nodeId: 7,
        nodeName: "beast",
        instanceDomainSuffix: ".house.test",
        cloneable: true,
        cloneableReason: null,
        checks: null,
      },
    ],
    environments: [],
  };
  // The desktop app in Orbit mode, local environment off: no primary, no clone, no host.
  const previousProvider = useEnvironmentProvider.getState();
  const bridgeWindow = window as { desktopBridge?: unknown };
  const previousBridge = bridgeWindow.desktopBridge;
  useEnvironmentProvider.setState({ provider: "orbit", orbitInstances: {} });
  bridgeWindow.desktopBridge = {
    orbitGatewaySend: vi.fn(),
    getLocalEnvironmentEnabled: () => false,
    getLocalEnvironmentBootstraps: () => [],
  };
  return {
    [Symbol.dispose]() {
      bridgeWindow.desktopBridge = previousBridge;
      useEnvironmentProvider.setState(previousProvider, true);
    },
  };
}

describe("CommandPalette Orbit draft", () => {
  it("starts the create on Enter and opens its pending thread, on a device with no primary environment", async () => {
    using _desktop = setup();
    await using screen = await render(<CommandPalette>{null}</CommandPalette>);

    const plusOnce = async (name: string) => {
      openCommandPalette({ open: "new-thread-in" });
      await page.getByRole("option", { name: /orbit · no instances/ }).click();
      await expect.element(page.getByText("No instances yet.")).toBeVisible();
      await userEvent.type(page.getByRole("textbox", { name: "Instance name" }), name);
      await expect.element(page.getByText(`${name}.house.test is available.`)).toBeVisible();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toMatch(/^\/orbit\/.+/),
      );
      return screen.router!.state.location.pathname.slice("/orbit/".length);
    };

    const startId = await plusOnce("form");
    expect(readStored().find((entry) => entry.id === startId)).toMatchObject({
      projectId: 69,
      instanceName: "form",
      message: "",
      branch: null,
      pendingThread: true,
      error: null,
    });
    // No draft: the Project's usual draft is left as it was.
    expect(
      useComposerDraftStore
        .getState()
        .getDraftSessionByLogicalProjectKey(orbitDraftLogicalProjectKey(69)),
    ).toBeNull();
    expect(page.getByText("Unable to open the Orbit draft").query()).toBeNull();

    // A start nobody uses does not block the next plus for the same Project.
    await act(() =>
      useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true),
    );
    const second = await plusOnce("form-two");
    expect(second).not.toBe(startId);
    expect(readStored().map((entry) => entry.instanceName)).toEqual(["form", "form-two"]);
    for (const entry of readStored()) dismissOrbitThreadStart(entry.id);
  });
});
