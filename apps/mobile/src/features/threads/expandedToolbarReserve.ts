const EXPANDED_TOOLBAR_MIN_RESERVE = 52;
const EXPANDED_TOOLBAR_GAP = 8;

/**
 * Space the expanded editor leaves below it for the toolbar. The controls grow with
 * Dynamic Type, so the reserve follows their measured height and never drops below 52.
 */
export function expandedToolbarReserve(controlsHeight: number): number {
  return Math.max(EXPANDED_TOOLBAR_MIN_RESERVE, Math.ceil(controlsHeight) + EXPANDED_TOOLBAR_GAP);
}
