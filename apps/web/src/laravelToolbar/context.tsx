import { createContext, type ReactNode, useContext, useEffect } from "react";

import type { OrbitSource } from "./orbit";
import { type TabToolbar, useLaravelToolbarStore } from "./store";
import type { ToolbarData } from "./types";
import { type OrbitTool, useOrbit } from "./useOrbit";

/** Where the toolbar gets what the page did not push: the browser tab, or the design page's mocks. */
export interface ToolbarSource {
  /** A request's full payload, as `/_toolbar/requests/{id}` returns it in the page. */
  readonly fetchDetails: (id: string) => Promise<ToolbarData | null>;
  /** Opens `path` or `path:line` in the editor; absent when the files are not reachable. */
  readonly openSource?: ((target: string) => void) | undefined;
  /** Opens a query in the Database panel; absent where there is no thread to open it in. */
  readonly openQuery?: ((sql: string) => void) | undefined;
  /** The page's Orbit Instance; absent when Orbit is not set up for this thread. */
  readonly orbit?: OrbitSource | null | undefined;
}

interface ToolbarContextValue {
  readonly tabId: string;
  readonly source: ToolbarSource;
  readonly orbit: OrbitTool;
}

const ToolbarContext = createContext<ToolbarContextValue | null>(null);

export function ToolbarProvider({
  tabId,
  source,
  children,
}: {
  tabId: string;
  source: ToolbarSource;
  children: ReactNode;
}) {
  const orbit = useOrbit(source.orbit ?? null);
  const value = { tabId, source, orbit };
  return <ToolbarContext.Provider value={value}>{children}</ToolbarContext.Provider>;
}

/** The Orbit tool's state, shared by its bar item and panel. */
export function useOrbitTool(): OrbitTool {
  const context = useContext(ToolbarContext);
  if (!context) throw new Error("useOrbitTool outside ToolbarProvider");
  return context.orbit;
}

const EMPTY_TAB: TabToolbar = { currentId: null, history: [], details: {}, selectedId: null };

export function useToolbarTab() {
  const context = useContext(ToolbarContext);
  if (!context) throw new Error("useToolbarTab outside ToolbarProvider");
  const tab = useLaravelToolbarStore((state) => state.byTabId[context.tabId]) ?? EMPTY_TAB;
  const select = useLaravelToolbarStore((state) => state.select);
  const clearHistory = useLaravelToolbarStore((state) => state.clearHistory);
  const receiveDetails = useLaravelToolbarStore((state) => state.receiveDetails);
  const selectedId = tab.selectedId ?? tab.currentId;
  const selected = selectedId ? (tab.details[selectedId] ?? null) : null;

  // History rows arrive as summaries; load the full payload when one is selected.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches request details from the toolbar source for the selected request
  useEffect(() => {
    if (!selectedId || tab.details[selectedId]) return;
    let cancelled = false;
    void context.source.fetchDetails(selectedId).then((data) => {
      if (!cancelled && data) receiveDetails(context.tabId, selectedId, data);
    });
    return () => {
      cancelled = true;
    };
  }, [context.source, context.tabId, receiveDetails, selectedId, tab.details]);

  return {
    tab,
    selectedId,
    selected,
    viewingHistory: tab.selectedId !== null,
    select: (id: string | null) => select(context.tabId, id),
    clearHistory: () => clearHistory(context.tabId),
    openSource: context.source.openSource,
    openQuery: context.source.openQuery,
  };
}
