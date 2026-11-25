import { Platform } from "react-native";

// nckrtl shell: the iPhone has no tab bar to leave Settings by, so Settings opens as a page
// sheet over the workspace and its pages push inside it. iPad keeps Settings in its columns.
export const SETTINGS_OPENS_AS_SHEET = Platform.OS === "ios" && !Platform.isPad;

/**
 * The Settings list route's presentation. Its pages stay plain pages: the iOS navigator keeps
 * every route above a presented one in that sheet, so going into a page and back stays there.
 */
export const SETTINGS_LIST_PRESENTATION = SETTINGS_OPENS_AS_SHEET
  ? { presentation: "pageSheet" as const }
  : {};

type RouteLike = { readonly name: string };

/** The root stack with the Settings sheet, and every page open in it, dismissed. */
export function settingsSheetClosedState<
  State extends { readonly index: number; readonly routes: readonly RouteLike[] },
>(state: State): State {
  const list = state.routes.findIndex((route) => route.name === "Settings");
  if (list <= 0) return state;
  const routes = state.routes.slice(0, list);
  return { ...state, index: routes.length - 1, routes };
}
