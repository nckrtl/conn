import { Box, Database, ListIcon, MemoryStick, Timer } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { cn } from "~/lib/utils";
import { ToolbarGroup } from "~/components/ToolbarGroup";

import { useOrbitTool, useToolbarTab } from "../context";
import { formatMs, framework, hasQueryIssues, modelCount, summarize, wallTimeMs } from "../model";
import { LaravelIcon, PhpIcon, SymfonyIcon } from "./brandIcons";
import { DatabasePanel, EnvironmentPanel, MemoryPanel, ModelsPanel, TimingsPanel } from "./panels";
import { OrbitIcon, OrbitPanel } from "./orbit";
import {
  TOOLBAR_SHEET_INSET,
  ToolbarPanelResizeContext,
  useToolbarPanelResize,
} from "./panelResize";
import { MethodBadge, StatusBadge } from "./parts";
import { RequestPanel, RequestsPanel } from "./requests";

export const PANEL_IDS = [
  "requests",
  "request",
  "timings",
  "memory",
  "database",
  "models",
  "orbit",
  "environment",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

const PANELS: Record<PanelId, () => ReactNode> = {
  requests: () => <RequestsPanel />,
  request: () => <RequestPanel />,
  timings: () => <TimingsPanel />,
  memory: () => <MemoryPanel />,
  database: () => <DatabasePanel />,
  models: () => <ModelsPanel />,
  orbit: () => <OrbitPanel />,
  environment: () => <EnvironmentPanel />,
};

const OPEN_DELAY_MS = 75;
const CLOSE_DELAY_MS = 120;

/** Hover opens a panel, click pins it. A pinned panel stays until it is clicked again. */
function usePanels(initialPinned: PanelId | null) {
  const [pinned, setPinned] = useState<PanelId | null>(initialPinned);
  const [hovered, setHovered] = useState<PanelId | null>(null);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return {
    active: hovered ?? pinned,
    pinned,
    enter: (id: PanelId) => {
      clear();
      timer.current = window.setTimeout(() => setHovered(id), OPEN_DELAY_MS);
    },
    stay: clear,
    pin: () => {
      clear();
      setPinned(hovered ?? pinned);
      setHovered(null);
    },
    leave: () => {
      clear();
      timer.current = window.setTimeout(() => setHovered(null), CLOSE_DELAY_MS);
    },
    toggle: (id: PanelId) => {
      clear();
      setHovered(null);
      setPinned((current) => (current === id ? null : id));
    },
  };
}

/**
 * The bar's viewport rect while a flyout is open. The flyout is portaled to the body: the
 * browser page is a fixed layer above the app shell, and the shell's backdrop blur traps any
 * z-index set inside it, so an in-place flyout would sit under the page.
 */
function useHostRect(hostRef: RefObject<HTMLDivElement | null>, open: boolean) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!open || !host) {
      setRect(null);
      return;
    }
    const measure = () => setRect(host.getBoundingClientRect());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (host.parentElement) observer.observe(host.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hostRef, open]);
  return rect;
}

// Two stacked blurs with offset masks read as one blur that strengthens toward the bar.
const PROGRESSIVE_BLUR_LIGHT = "linear-gradient(to top, black 0%, black 40%, transparent 100%)";
const PROGRESSIVE_BLUR_HEAVY = "linear-gradient(to top, black 0%, transparent 55%)";

/** The bar under the browser page, with its flyout panels. */
export function ToolbarBar({ initialPanel = null }: { initialPanel?: PanelId | null }) {
  const panels = usePanels(initialPanel);
  const hostRef = useRef<HTMLDivElement>(null);
  const resize = useToolbarPanelResize(hostRef, panels.pin);
  const hostRect = useHostRect(hostRef, panels.active !== null);
  const { tab, selectedId, selected } = useToolbarTab();
  const app = framework(selected);
  const orbit = useOrbitTool();
  const row = tab.history.find((entry) => entry.row.id === selectedId);
  const summary = row ? summarize(row.row, selected) : null;

  // Bar items are flat inside their ToolbarGroup: a light fill on hover, a stronger one while open.
  const item = (id: PanelId, label: string, children: ReactNode, shrink = false) => (
    <button
      type="button"
      aria-label={label}
      data-pressed={panels.active === id ? "" : undefined}
      onMouseEnter={() => panels.enter(id)}
      onMouseLeave={panels.leave}
      onClick={() => panels.toggle(id)}
      className={cn(
        "inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-(--control-radius) pr-2 font-medium text-foreground text-ui outline-none hover:bg-foreground/6 focus-visible:ring-1 focus-visible:ring-ring data-pressed:bg-foreground/10 [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
        id === "request" ? "pl-1" : "pl-2",
        shrink ? "shrink" : "shrink-0",
      )}
    >
      {children}
    </button>
  );

  return (
    <div ref={hostRef} className="relative shrink-0">
      {/* The flyout is a floating sheet over the page: inset like the bar's groups, with a gap
          above the bar so the page shows around it. */}
      {panels.active && hostRect
        ? createPortal(
            // A click-through band the sheet's height, inset around it: the page behind blurs
            // progressively, fully at the bar and clear at the sheet's top edge.
            <div
              className="pointer-events-none fixed z-40"
              style={{
                left: hostRect.left,
                width: hostRect.width,
                top: hostRect.top - resize.height - 2 * TOOLBAR_SHEET_INSET,
                height: resize.height + 2 * TOOLBAR_SHEET_INSET,
              }}
            >
              <div
                aria-hidden
                className="absolute inset-0 backdrop-blur-sm"
                style={{
                  maskImage: PROGRESSIVE_BLUR_LIGHT,
                  WebkitMaskImage: PROGRESSIVE_BLUR_LIGHT,
                }}
              />
              <div
                aria-hidden
                className="absolute inset-0 backdrop-blur-lg"
                style={{
                  maskImage: PROGRESSIVE_BLUR_HEAVY,
                  WebkitMaskImage: PROGRESSIVE_BLUR_HEAVY,
                }}
              />
              <div
                className="pointer-events-auto absolute overflow-hidden rounded-xl border border-(--shell-divider-header)! bg-(--shell-card) text-foreground shadow-lg [--background:var(--shell-card)] [--contrast-border:var(--shell-divider-raised)] [--toolbar-group-border:var(--shell-control-raised-border)] [--toolbar-group-fill:var(--shell-control-raised)] dark:border-(--shell-divider)! dark:[--contrast-border:var(--shell-divider)] dark:[--contrast-input:var(--shell-divider)] dark:[--toolbar-group-border:var(--shell-divider)] dark:[--toolbar-group-fill:var(--shell-control)]"
                style={{
                  inset: TOOLBAR_SHEET_INSET,
                }}
                onMouseEnter={panels.stay}
                onMouseLeave={() => {
                  if (panels.pinned === null) panels.leave();
                }}
              >
                <RenderErrorBoundary
                  fallback={
                    <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                      This panel cannot show this request's data.
                    </div>
                  }
                  resetKeys={[panels.active, selected]}
                >
                  <ToolbarPanelResizeContext value={resize}>
                    {PANELS[panels.active]()}
                  </ToolbarPanelResizeContext>
                </RenderErrorBoundary>
              </div>
            </div>,
            document.body,
          )
        : null}
      {/* Narrow browsers drop the versions; the route name truncates. */}
      <div className="@container flex items-center gap-2 overflow-hidden border-t border-(--shell-divider)! bg-(--shell-card) px-1.5 py-toolbar">
        <ToolbarGroup className="min-w-0 shrink">
          {item(
            "requests",
            "Requests on this page",
            <>
              <ListIcon />
              <span className="tabular-nums">{tab.history.length}</span>
            </>,
          )}
          {summary
            ? item(
                "request",
                "Request details",
                <>
                  <StatusBadge status={summary.status} />
                  <MethodBadge method={summary.method} />
                  <span className="truncate text-muted-foreground">
                    {summary.routeName ?? "Unnamed route"}
                  </span>
                </>,
                true,
              )
            : null}
        </ToolbarGroup>
        {selected ? (
          <ToolbarGroup className="shrink-0">
            {item(
              "timings",
              "Timings",
              <>
                <Timer />
                <span className="tabular-nums">{formatMs(wallTimeMs(selected))}</span>
              </>,
            )}
            {item(
              "memory",
              "Memory",
              <>
                <MemoryStick />
                <span className="tabular-nums">
                  {selected.profiler?.total_allocated_memory?.formattedValue ?? "–"}
                </span>
              </>,
            )}
            {item(
              "database",
              "Database queries",
              <>
                <span className="relative">
                  <Database />
                  {/* Amber on the icon when this request ran duplicate or slow queries. */}
                  {hasQueryIssues(selected) ? (
                    <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning" />
                  ) : null}
                </span>
                <span className="tabular-nums">{selected.queries?.queries?.length ?? 0}</span>
              </>,
            )}
            {item(
              "models",
              "Eloquent models",
              <>
                <Box />
                <span className="tabular-nums">{modelCount(selected)}</span>
              </>,
            )}
          </ToolbarGroup>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {orbit.state.status === "ready" ? (
            <ToolbarGroup>
              {item(
                "orbit",
                "Orbit",
                <span className="relative">
                  <OrbitIcon />
                  {Object.values(orbit.warnings).some(Boolean) ? (
                    <span
                      role="img"
                      aria-label={Object.values(orbit.warnings).filter(Boolean).join(". ")}
                      className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning"
                    />
                  ) : null}
                </span>,
              )}
            </ToolbarGroup>
          ) : null}
          {selected ? (
            <ToolbarGroup className="hidden @2xl:flex">
              {item(
                "environment",
                `${app.name} and PHP`,
                <>
                  {app.name === "Symfony" ? (
                    <SymfonyIcon />
                  ) : app.isLaravel ? (
                    <LaravelIcon />
                  ) : null}
                  <span className="text-muted-foreground">
                    {app.version?.split(".").slice(0, 2).join(".") ?? "–"}
                  </span>
                  <span className="text-muted-foreground" aria-hidden="true">
                    ·
                  </span>
                  <PhpIcon />
                  <span className="text-muted-foreground">
                    {selected.php?.version?.split(".").slice(0, 2).join(".") ?? "–"}
                  </span>
                </>,
              )}
            </ToolbarGroup>
          ) : null}
        </div>
      </div>
    </div>
  );
}
