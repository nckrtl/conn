import type { NavigationState, PartialState } from "@react-navigation/native";

import {
  dispatchRootStackReset,
  resetRootStack,
  rootStackState,
  type RootStackNavigation,
} from "../../lib/root-stack-reset";
import { isWorkspaceOverlayRoute, workspaceRoutesOf } from "../layout/workspace-overlay-routes";

type RootParams = ReactNavigation.RootParamList;

/** Settings routes that open as modals over whatever is on screen, not as Settings pages. */
const SETTINGS_MODAL_ROUTES = new Set(["SettingsLegal", "SettingsAuth", "SettingsWaitlist"]);

/** Root routes that make up the Settings tab: its list and the pages it opens. */
export type SettingsRouteName = Exclude<
  Extract<keyof RootParams, `Settings${string}`>,
  "SettingsLegal" | "SettingsAuth" | "SettingsWaitlist"
>;

/** A page in the Settings tab's detail column. */
export type SettingsPageName = Exclude<SettingsRouteName, "Settings">;

export function isSettingsRoute(name: string): boolean {
  return name.startsWith("Settings") && !SETTINGS_MODAL_ROUTES.has(name);
}

/**
 * Settings is open while its `Settings` route is under the topmost workspace page and that
 * page is a Settings page. A Settings page pushed without it, such as a usage account opened
 * from the Usage tab, stays a detail of the current tab.
 */
export function settingsOpenIn(workspaceRoutes: readonly { readonly name: string }[]): boolean {
  return (
    workspaceRoutes.some((route) => route.name === "Settings") &&
    isSettingsRoute(workspaceRoutes.at(-1)?.name ?? "")
  );
}

/**
 * Whether Settings is open, counting the iPhone Settings sheet: its `Settings` route is
 * presented, so it is an overlay, yet Settings is open while it or a page in it is on top.
 */
export function settingsOpenOverWorkspace(routes: readonly { readonly name: string }[]): boolean {
  return settingsOpenIn(
    routes.filter((route) => route.name === "Settings" || !isWorkspaceOverlayRoute(route.name)),
  );
}

/**
 * A `settings/...` link names only its page, so put the Settings tab's route under it. A bare
 * `settings` link opens `page` beside the list when the window has columns.
 */
export function restoreSettingsLinkState(
  state: PartialState<NavigationState> | undefined,
  page: SettingsPageName | undefined,
) {
  if (!state) return state;
  const routes = [...state.routes];
  const list = routes.findIndex((route) => route.name === "Settings");
  const first = routes.findIndex((route) => isSettingsRoute(route.name));
  if (first < 0) return state;
  if (list < 0) routes.splice(first, 0, { name: "Settings" });
  const top = routes.at(-1);
  if (page && top?.name === "Settings") routes.push({ name: page });
  return routes.length === state.routes.length
    ? state
    : { ...state, index: routes.length - 1, routes };
}

type SettingsPageArgs<Name extends SettingsPageName> = undefined extends RootParams[Name]
  ? [params?: RootParams[Name]]
  : [params: RootParams[Name]];

type RouteLike = { readonly name: string; readonly key?: string; readonly params?: object };

/**
 * Settings pages sit on the root stack above Home, under a `Settings` route that keeps the
 * Settings list as the workspace's primary content. Opening a page replaces whatever was above
 * Home, so the tab always starts from its list and Back returns there. Routes already on screen
 * keep their keys, so reopening the open page doesn't rebuild it.
 */
export function settingsNavigationState<State extends { readonly routes: readonly RouteLike[] }>(
  state: State,
  page: SettingsPageName | undefined,
  params?: object,
  key?: string,
) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  const list = state.routes.find((route) => route.name === "Settings") ?? { name: "Settings" };
  const current = page
    ? state.routes.find(
        (route) => route.name === page && JSON.stringify(route.params) === JSON.stringify(params),
      )
    : undefined;
  const routes = [
    home,
    list,
    ...(page ? [current ?? (key ? { key, name: page, params } : { name: page, params })] : []),
  ];
  return { ...state, index: routes.length - 1, routes };
}

/**
 * iPhone: Settings is a sheet over the workspace, which stays as it is under it. The sheet opens
 * on `page` above its list; an open sheet keeps its list and shows `page` above it.
 */
export function settingsSheetNavigationState<
  State extends { readonly index: number; readonly routes: readonly RouteLike[] },
>(state: State, page: SettingsPageName | undefined, params?: object) {
  const listIndex = state.routes.findIndex((route) => route.name === "Settings");
  const below =
    listIndex >= 0
      ? state.routes.slice(0, listIndex)
      : workspaceRoutesOf(state.routes.slice(0, state.index + 1)).workspace;
  const list = listIndex >= 0 ? state.routes[listIndex]! : { name: "Settings" };
  const current = page
    ? state.routes
        .slice(listIndex + 1)
        .find(
          (route) =>
            listIndex >= 0 &&
            route.name === page &&
            JSON.stringify(route.params) === JSON.stringify(params),
        )
    : undefined;
  const routes = [...below, list, ...(page ? [current ?? { name: page, params }] : [])];
  return { ...state, index: routes.length - 1, routes };
}

/**
 * A Settings link opened while the app runs resets the root stack the way the Settings tab
 * does. React Navigation's default action pushes the linked route over whatever is open.
 */
export function settingsLinkAction(
  link: PartialState<NavigationState>,
  current: NavigationState | undefined,
) {
  const top = link.routes.at(-1);
  if (!current || !top || top.state || !isSettingsRoute(top.name)) return undefined;
  const page = top.name === "Settings" ? undefined : (top.name as SettingsPageName);
  return {
    type: "RESET" as const,
    payload: isWorkspaceOverlayRoute("Settings")
      ? settingsSheetNavigationState(current, page, top.params)
      : settingsNavigationState(current, page, top.params),
    target: current.key,
  };
}

/** Opens one Settings page in the Settings tab, from anywhere outside it. */
export function openSettings<Name extends SettingsPageName>(
  navigation: RootStackNavigation,
  page: Name,
  ...[params]: SettingsPageArgs<Name>
) {
  // The Settings route is registered as presented exactly where Settings opens as a sheet.
  resetRootStack(navigation, (state) =>
    isWorkspaceOverlayRoute("Settings")
      ? settingsSheetNavigationState(state, page, params)
      : settingsNavigationState(state, page, params),
  );
}

/**
 * Closes a Settings page that finished its job. The first page beside the list is replaced with
 * `fallback` when the window has columns, since going back would leave the detail column empty.
 */
export function leaveSettingsPage(
  navigation: RootStackNavigation & { readonly goBack: () => void },
  columns: boolean,
  fallback: SettingsPageName,
) {
  const state = rootStackState(navigation);
  const below = state?.routes[state.index - 1];
  if (state && columns && below?.name === "Settings") {
    dispatchRootStackReset(navigation, state, settingsNavigationState(state, fallback));
  } else {
    navigation.goBack();
  }
}
