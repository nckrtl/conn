import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios", isPad: false } }));

import {
  partitionStackPresentations,
  projectWorkspaceStack,
  isPresentedRoute,
} from "../../native/workspace-stack-projection";
import { workspaceTabNavigationState } from "../layout/workspace/workspace-tab-navigation";
import {
  SETTINGS_LIST_PRESENTATION,
  SETTINGS_OPENS_AS_SHEET,
  settingsSheetClosedState,
} from "./settings-sheet";

type Route = { readonly key: string; readonly name: string };

// On iPhone only the Settings list route carries a presentation; its pages are plain pages.
const presentationOf = (route: { readonly name: string }) =>
  route.name === "Settings" ? SETTINGS_LIST_PRESENTATION : undefined;

const home: Route = { key: "home", name: "Home" };
const thread: Route = { key: "thread", name: "Thread" };
const available = { thread: () => true, pullRequest: () => true };
const names = (routes: readonly { readonly name: string }[]) => routes.map((route) => route.name);

function stack(routes: readonly Route[]) {
  return { key: "root", index: routes.length - 1, routes, stale: false as const, type: "stack" };
}

/** What the iOS workspace navigator shows: the workspace and the sheets presented over it. */
function shown(routes: readonly Route[]) {
  const projection = projectWorkspaceStack(stack(routes) as never, (route) =>
    isPresentedRoute(presentationOf(route)),
  );
  const sheets = partitionStackPresentations(projection.overlays, (route) =>
    isPresentedRoute(presentationOf(route)),
  );
  const workspace = [projection.primary, ...projection.detail].flatMap((route) =>
    route ? [route] : [],
  );
  return { workspace, sheets };
}

describe("iPhone Settings sheet", () => {
  it("presents the Settings list as a sheet", () => {
    expect(SETTINGS_OPENS_AS_SHEET).toBe(true);
    expect(isPresentedRoute(presentationOf({ name: "Settings" }))).toBe(true);
  });

  it("opens over the workspace, which stays as it was", () => {
    const opened = workspaceTabNavigationState(
      { routes: [home, thread] },
      "settings",
      {},
      {
        columns: false,
        check: available,
        settingsSheet: SETTINGS_OPENS_AS_SHEET,
      },
    );
    expect(names(opened.routes)).toEqual(["Home", "Thread", "Settings"]);
    expect(opened.routes.slice(0, 2)).toEqual([home, thread]);
  });

  it("stays one sheet into every page depth and back again", () => {
    const list: Route = { key: "settings", name: "Settings" };
    // In the sheet, a row in the list or in a page pushes its page above the list.
    const page = { routes: [home, list, { key: "voice", name: "SettingsVoice" }] };
    const deeper = [...page.routes, { key: "edit", name: "SettingsScheduledTaskEdit" }];
    const steps = [
      [home, list],
      page.routes,
      deeper,
      deeper.slice(0, -1), // Back from the second page
      deeper.slice(0, -2), // Back to the list
    ];
    for (const routes of steps) {
      const view = shown(routes);
      expect(names(view.workspace)).toEqual(["Home"]);
      expect(view.sheets).toHaveLength(1);
      expect(view.sheets[0]![0]).toBe(list);
      expect(names(view.sheets[0]!)).toEqual(names(routes.slice(1)));
    }
  });

  it("closes from any page back to the workspace under it", () => {
    const state = stack([
      home,
      thread,
      { key: "settings", name: "Settings" },
      { key: "v", name: "SettingsVoice" },
    ]);
    expect(settingsSheetClosedState(state)).toMatchObject({ index: 1, routes: [home, thread] });
  });
});
