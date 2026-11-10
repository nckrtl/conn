import { ChevronRight, CornerDownRight, Globe, ListIcon, Search, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ToolbarGroup } from "~/components/ToolbarGroup";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useToolbarTab } from "../context";
import { headerRows, type PropRow, propRows, routeUri, shortLocation, summarize } from "../model";
import {
  cellClass,
  EmptyRow,
  headRowClass,
  KeyValueRows,
  MethodBadge,
  PanelShell,
  rowClass,
  Section,
  SourceLink,
  Stat,
  StatStrip,
  StatusBadge,
  tableClass,
  UnderlineTabs,
} from "./parts";

import { SortHeader, sortTableRows, useTableSort } from "./tableSort";

const KIND_LABEL = { page: "page", inertia: "inertia", xhr: "xhr" } as const;

function clockTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

// ─── Requests: every request this page made ─────────────────────────────────

// Columns that only show when the browser is wide enough; the URI takes the rest.
const WIDE = {
  type: { col: "hidden @2xl:table-column", cell: "hidden @2xl:table-cell" },
  component: { col: "hidden @3xl:table-column", cell: "hidden @3xl:table-cell" },
  route: { col: "hidden @4xl:table-column", cell: "hidden @4xl:table-cell" },
} as const;

export function RequestsPanel() {
  const { tab, selectedId, select } = useToolbarTab();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchButtonRef.current?.focus();
  };
  const sorting = useTableSort();
  const needle = query.trim().toLowerCase();
  const filtered = tab.history
    .map((entry) => ({ entry, summary: summarize(entry.row, tab.details[entry.row.id]) }))
    .filter(
      ({ summary }) =>
        needle === "" ||
        summary.uri.toLowerCase().includes(needle) ||
        (summary.component ?? "").toLowerCase().includes(needle) ||
        summary.route.toLowerCase().includes(needle),
    );
  const rows = sortTableRows(filtered, sorting.sort, ({ entry, summary }, column) => {
    if (column === "duration") return summary.durationMs;
    if (column === "time") return entry.receivedAt;
    if (column === "status") return summary.status;
    if (column === "method") return summary.method;
    if (column === "uri") return summary.uri;
    if (column === "component") return summary.component;
    if (column === "route") return summary.route;
    return KIND_LABEL[summary.kind];
  });
  return (
    <PanelShell
      icon={ListIcon}
      title="Requests"
      actions={
        <div className="flex items-center gap-2">
          {searchOpen ? (
            <div className="w-40 sm:w-64">
              <Input
                autoFocus
                unstyled
                size="compact"
                aria-label="Search requests"
                placeholder="Search URL or component"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeSearch();
                  }
                }}
              />
            </div>
          ) : null}
          <ToolbarGroup>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    ref={searchButtonRef}
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    aria-label={searchOpen ? "Close search" : "Search requests"}
                    aria-expanded={searchOpen}
                    onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                  >
                    {searchOpen ? <X /> : <Search />}
                  </Button>
                }
              />
              <TooltipPopup>{searchOpen ? "Close search" : "Search requests"}</TooltipPopup>
            </Tooltip>
          </ToolbarGroup>
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyRow>{tab.history.length === 0 ? "No requests yet" : "No requests match"}</EmptyRow>
      ) : (
        <div className="@container">
          <table className={tableClass}>
            <colgroup>
              <col className="w-20" />
              <col className="w-18" />
              <col />
              <col className={cn("w-36", WIDE.component.col)} />
              <col className={cn("w-44", WIDE.route.col)} />
              <col className={cn("w-18", WIDE.type.col)} />
              <col className="w-24" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr className={headRowClass}>
                <SortHeader column="status" label="Status" {...sorting} />
                <SortHeader column="method" label="Method" {...sorting} />
                <SortHeader column="uri" label="URI" {...sorting} />
                <SortHeader
                  column="component"
                  label="Component"
                  {...sorting}
                  className={WIDE.component.cell}
                />
                <SortHeader column="route" label="Route" {...sorting} className={WIDE.route.cell} />
                <SortHeader column="type" label="Type" {...sorting} className={WIDE.type.cell} />
                <SortHeader column="duration" label="Duration" {...sorting} align="right" />
                <SortHeader column="time" label="Time" {...sorting} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, summary }) => (
                <tr
                  key={summary.id}
                  onClick={() => select(summary.id)}
                  className={cn(
                    rowClass,
                    "cursor-pointer",
                    summary.id === selectedId && "bg-(--shell-highlight)",
                  )}
                >
                  <td className={cellClass}>
                    {/* Follow-ups (a redirect's next hop, deferred props) sit under their page. */}
                    <span className="flex items-center gap-1.5">
                      {entry.row.follow_up ? (
                        <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                      ) : null}
                      <StatusBadge status={summary.status} />
                    </span>
                  </td>
                  <td className={cn(cellClass, "font-mono text-muted-foreground")}>
                    {summary.method}
                  </td>
                  <td className={cn(cellClass, "truncate font-mono")}>{summary.uri}</td>
                  <td className={cn(cellClass, "truncate font-mono", WIDE.component.cell)}>
                    {summary.component ?? <span className="text-muted-foreground">–</span>}
                  </td>
                  <td className={cn(cellClass, "truncate text-muted-foreground", WIDE.route.cell)}>
                    {summary.route}
                  </td>
                  <td className={cn(cellClass, "text-muted-foreground", WIDE.type.cell)}>
                    {KIND_LABEL[summary.kind]}
                  </td>
                  <td className={cn(cellClass, "text-right tabular-nums")}>
                    {summary.duration ?? "–"}
                  </td>
                  <td className={cn(cellClass, "text-right text-muted-foreground tabular-nums")}>
                    {clockTime(entry.receivedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelShell>
  );
}

// ─── Request: the selected request in detail ────────────────────────────────

function Scalar({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="text-success-foreground">"{value}"</span>;
  if (typeof value === "number") return <span className="text-info-foreground">{value}</span>;
  if (typeof value === "boolean")
    return <span className="text-warning-foreground">{String(value)}</span>;
  if (value === undefined) return <span className="text-muted-foreground">not loaded yet</span>;
  return <span className="text-muted-foreground">null</span>;
}

function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

const BADGE_VARIANT = {
  Shared: "info",
  Always: "success",
  Deferred: "warning",
  Optional: "outline",
  Merge: "outline",
  Scroll: "outline",
  Once: "outline",
} as const;

/** What Inertia knows about a top-level prop: its badges and where it is defined. */
function PropAside({
  prop,
  openSource,
}: {
  prop: PropRow;
  openSource: ((target: string) => void) | undefined;
}) {
  const { source } = prop;
  return (
    <>
      {prop.badges.map((badge) => (
        <Badge key={badge} variant={BADGE_VARIANT[badge]}>
          {badge}
        </Badge>
      ))}
      {source ? (
        <SourceLink
          onOpen={openSource ? () => openSource(`${source.file}:${source.line}`) : undefined}
        >
          {shortLocation(source.file, source.line)}
        </SourceLink>
      ) : null}
    </>
  );
}

/** One prop in the tree. Objects and arrays fold open with a chevron. */
function PropNode({
  name,
  value,
  depth,
  aside,
}: {
  name: string;
  value: unknown;
  depth: number;
  /** Badges and source link on the right of a top-level prop. */
  aside?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const branch = isBranch(value);
  const entries = branch ? Object.entries(value) : [];
  const count = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div className={cn(depth === 0 && "border-b")}>
      <div
        className={cn(
          "flex items-center gap-1.5 pr-3 font-mono text-xs",
          depth === 0 ? "py-2.5" : "py-1.5",
        )}
      >
        {branch && entries.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ChevronRight
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span>{name}</span>
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="size-3.5" />
            <span>
              {name}
              {branch ? null : <span className="text-muted-foreground">:</span>}
            </span>
          </span>
        )}
        {branch ? <span className="text-muted-foreground">{count}</span> : <Scalar value={value} />}
        {aside ? <span className="ml-auto flex shrink-0 items-center gap-1.5">{aside}</span> : null}
      </div>
      {branch && open ? (
        <div className="mb-1.5 ml-4 border-l pl-3">
          {entries.map(([key, child]) => (
            <PropNode key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type RequestTab = "route" | "props" | "request" | "response" | "cookies";

export function RequestPanel() {
  const { selected, tab: toolbarTab, selectedId, openSource } = useToolbarTab();
  const [tab, setTab] = useState<RequestTab>("route");
  const row = toolbarTab.history.find((entry) => entry.row.id === selectedId)?.row;
  const summary = row ? summarize(row, selected) : null;
  const props = propRows(selected);
  const componentPath = selected?.inertia?.component_path ?? null;
  const cookieSorting = useTableSort();
  const cookies = sortTableRows(
    selected?.response?.cookies ?? [],
    cookieSorting.sort,
    (cookie, column) => {
      if (column === "name") return cookie.name;
      if (column === "value") return cookie.value;
      if (column === "path") return cookie.path ?? "/";
      if (column === "sameSite") return cookie.same_site;
      return [cookie.secure ? "Secure" : "", cookie.http_only ? "HttpOnly" : ""]
        .filter(Boolean)
        .join(" ");
    },
  );
  const contentType = selected?.response?.content_type ?? "";
  const responseKind = selected?.request?.is_inertia
    ? "Inertia"
    : contentType.includes("json")
      ? "JSON"
      : contentType.includes("html")
        ? "HTML"
        : contentType || "–";

  const middleware = selected?.request?.middleware ?? [];
  // In the order they run, on one line with the other route values.
  const middlewareChain =
    middleware.length > 0 ? (
      <span className="flex flex-wrap items-center gap-1.5">
        {middleware.map((item, index) => (
          <span key={item.class} className="inline-flex items-center gap-1.5">
            {index > 0 ? <span className="text-muted-foreground">→</span> : null}
            <Badge variant="outline">
              <span className="font-mono">{item.class.split("\\").pop()}</span>
            </Badge>
          </span>
        ))}
      </span>
    ) : (
      "–"
    );

  let body: ReactNode;
  if (!selected) body = <EmptyRow>Loading request…</EmptyRow>;
  else if (tab === "route")
    body = (
      <>
        <StatStrip>
          <Stat
            label="Status"
            value={summary?.status ?? "–"}
            tone={
              (summary?.status ?? 0) >= 400
                ? "warning"
                : (summary?.status ?? 0) >= 300
                  ? "default"
                  : "success"
            }
            hint={
              <>
                <span className="font-mono">
                  {summary?.method ?? selected.request?.method ?? "–"}
                </span>
                {selected.response?.redirect_to
                  ? ` · Redirect to ${selected.response.redirect_to}`
                  : null}
              </>
            }
          />
          <Stat label="Duration" value={summary?.duration ?? "–"} hint="Wall time" />
          <Stat
            label="Memory"
            value={selected.profiler?.total_allocated_memory?.formattedValue ?? "–"}
            hint="Peak allocated"
          />
          <Stat label="Response" value={responseKind} hint={summary?.size ?? undefined} />
        </StatStrip>
        <Section>
          <KeyValueRows
            rows={[
              ["Name", summary?.routeName ?? "–", "mono"],
              ["URI", routeUri(selected) ?? "–", "mono"],
              ["Action", selected.request?.controller_action ?? "–", "mono"],
              ["Client IP", selected.request?.ip_address ?? "–", "mono"],
              ["Middleware", middlewareChain],
            ]}
          />
        </Section>
      </>
    );
  else if (tab === "props")
    body =
      props.length > 0 ? (
        <div className="pl-1.5">
          {props.map((prop) => (
            <PropNode
              key={prop.name}
              name={prop.name}
              value={prop.loaded ? prop.value : undefined}
              depth={0}
              aside={<PropAside prop={prop} openSource={openSource} />}
            />
          ))}
        </div>
      ) : (
        <EmptyRow>No page props in this request</EmptyRow>
      );
  else if (tab === "cookies")
    body =
      cookies.length === 0 ? (
        <EmptyRow>The response set no cookies</EmptyRow>
      ) : (
        <table className={tableClass}>
          <colgroup>
            <col className="w-[22%]" />
            <col />
            <col className="w-[8%]" />
            <col className="w-[10%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead>
            <tr className={headRowClass}>
              <SortHeader column="name" label="Name" {...cookieSorting} />
              <SortHeader column="value" label="Value" {...cookieSorting} />
              <SortHeader column="path" label="Path" {...cookieSorting} />
              <SortHeader column="sameSite" label="SameSite" {...cookieSorting} />
              <SortHeader column="flags" label="Flags" {...cookieSorting} />
            </tr>
          </thead>
          <tbody>
            {cookies.map((cookie) => (
              <tr key={cookie.name} className={rowClass}>
                <td className={cn(cellClass, "truncate font-mono")}>{cookie.name}</td>
                <td className={cn(cellClass, "truncate font-mono text-muted-foreground")}>
                  {cookie.value}
                </td>
                <td className={cn(cellClass, "font-mono text-muted-foreground")}>
                  {cookie.path ?? "/"}
                </td>
                <td className={cn(cellClass, "text-muted-foreground")}>
                  {cookie.same_site ?? "–"}
                </td>
                <td className={cellClass}>
                  <div className="flex gap-1">
                    {cookie.secure ? <Badge variant="outline">Secure</Badge> : null}
                    {cookie.http_only ? <Badge variant="outline">HttpOnly</Badge> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  else
    body = (
      <KeyValueRows
        mono
        rows={headerRows(
          tab === "request" ? selected.request?.headers : selected.response?.headers,
        )}
      />
    );

  return (
    <PanelShell
      icon={Globe}
      title="Request"
      hasTabs
      flush
      meta={
        summary ? (
          <>
            <StatusBadge status={summary.status} />
            <MethodBadge method={summary.method} />
            <span className="truncate font-mono text-foreground">{summary.uri}</span>
            {summary.component ? (
              <SourceLink
                onOpen={componentPath && openSource ? () => openSource(componentPath) : undefined}
              >
                {summary.component}
              </SourceLink>
            ) : null}
          </>
        ) : null
      }
      actions={
        summary ? (
          <span className="text-muted-foreground text-xs">{KIND_LABEL[summary.kind]}</span>
        ) : null
      }
    >
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          ["route", "Route"],
          ["props", "Props"],
          ["request", "Request headers"],
          ["response", "Response headers"],
          ["cookies", "Cookies"],
        ]}
      />
      <ScrollArea radius="none" scrollFade hideScrollbars className="min-h-0 flex-1">
        {body}
      </ScrollArea>
    </PanelShell>
  );
}
