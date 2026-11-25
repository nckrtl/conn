/**
 * Conn: the Orbit panel's pages, in nav order. The panel holds the fork's Orbit configuration, so
 * Settings stays close to upstream (see FORK.md, "Orbit panel"). It opens on the first page.
 */
export const ORBIT_PANEL_PAGES = [
  { path: "/orbit/instances", label: "Instances" },
  { path: "/orbit/connection", label: "Connection" },
  { path: "/orbit/profile", label: "Profile" },
] as const;

export type OrbitPanelPath = (typeof ORBIT_PANEL_PAGES)[number]["path"];

export const ORBIT_PANEL_HOME: OrbitPanelPath = ORBIT_PANEL_PAGES[0].path;

/** The panel's pages; `/orbit/$startId` (a pending Orbit thread) is not one. */
export function isOrbitPanelPage(pathname: string): boolean {
  return ORBIT_PANEL_PAGES.some((page) => page.path === pathname);
}
