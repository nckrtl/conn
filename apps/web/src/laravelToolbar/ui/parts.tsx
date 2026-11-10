// Building blocks shared by the toolbar panels. Rules in the design notes
// (laravelToolbarPreview/DESIGN.md): 12 px text, 18 px stat values,
// medium weight, mono only for code, flush grid with thin dividers, no cards.
import type { LucideIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useContext } from "react";

import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

import { ToolbarPanelResizeContext } from "./panelResize";

/** Panels fill the flyout, sharing its resizable header and saved height. */
export function PanelShell({
  icon: Icon,
  title,
  meta,
  actions,
  flush = false,
  hasTabs = false,
  children,
}: {
  icon: LucideIcon | ComponentType<{ className?: string }>;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /** The body lays itself out (split panes, pinned tabs) instead of scrolling as one. */
  flush?: boolean;
  hasTabs?: boolean;
  children: ReactNode;
}) {
  const resize = useContext(ToolbarPanelResizeContext);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn(
          "relative flex h-11 shrink-0 touch-none cursor-row-resize select-none items-center gap-3 ps-3 pe-1.5",
          !hasTabs && "border-b",
        )}
        {...resize?.handlers}
      >
        {resize ? (
          <div
            role="separator"
            aria-label="Resize toolbar panel"
            aria-orientation="horizontal"
            aria-valuemin={resize.minHeight}
            aria-valuemax={resize.maxHeight}
            aria-valuenow={resize.height}
            tabIndex={0}
            onKeyDown={resize.onKeyDown}
            className="absolute inset-x-0 top-0 h-1 outline-none focus-visible:bg-ring"
          />
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-xs">{title}</span>
        </div>
        {meta ? (
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
            {meta}
          </div>
        ) : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {flush ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <ScrollArea radius="none" scrollFade hideScrollbars className="min-h-0 flex-1">
          <div className="flex min-h-full flex-col">{children}</div>
        </ScrollArea>
      )}
    </div>
  );
}

export function MetaDot() {
  return <span className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" />;
}

/** A titled block. Content runs edge to edge unless `inset`. */
export function Section({
  title,
  aside,
  inset = false,
  className,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  inset?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col border-b last:border-b-0", className)}>
      {title ? (
        <div className="flex items-center justify-between px-3 pt-3 pb-2 text-xs">
          <span className="font-medium text-muted-foreground">{title}</span>
          {aside ? <span className="text-muted-foreground">{aside}</span> : null}
        </div>
      ) : null}
      <div className={cn(inset && "px-3 pb-3")}>{children}</div>
    </section>
  );
}

/** One strip of stats split by thin dividers. */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="grid auto-cols-fr grid-flow-col divide-x border-b">{children}</div>;
}

export const secondaryLineClass = "mt-1 text-2xs leading-4 text-muted-foreground";

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  return (
    <div className="flex min-w-0 flex-col p-3">
      <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="truncate font-medium">{label}</span>
      </div>
      <div
        className={cn(
          "mt-0.5 truncate font-medium text-lg tabular-nums",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
          tone === "success" && "text-success-foreground",
        )}
      >
        {value}
      </div>
      <div className={cn("truncate", secondaryLineClass)}>{hint ?? " "}</div>
    </div>
  );
}

/** Label and value rows. Values are sans unless the row is code (a path, class or header). */
export function KeyValueRows({
  rows,
  mono = false,
}: {
  rows: ReadonlyArray<readonly [string, ReactNode] | readonly [string, ReactNode, "mono"]>;
  mono?: boolean;
}) {
  return (
    <dl className="divide-y text-xs">
      {rows.map(([key, value, kind]) => (
        <div key={key} className="flex items-center gap-6 px-3 py-3">
          <dt className="w-36 shrink-0 text-muted-foreground">{key}</dt>
          <dd className={cn("min-w-0 flex-1 truncate", (mono || kind === "mono") && "font-mono")}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-muted-foreground text-xs">{children}</div>;
}

export function StatusBadge({ status }: { status: number | null }) {
  if (status === null) return <span className="font-mono text-muted-foreground text-xs">–</span>;
  const variant =
    status >= 500 ? "error" : status >= 400 ? "warning" : status >= 300 ? "info" : "success";
  return (
    <Badge variant={variant}>
      <span className="font-mono">{status}</span>
    </Badge>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const variant =
    method === "GET"
      ? "info"
      : method === "POST"
        ? "success"
        : method === "DELETE"
          ? "error"
          : "warning";
  return (
    <Badge variant={variant}>
      <span className="font-mono">{method}</span>
    </Badge>
  );
}

/** A source file, opened in the editor: soft text with an underline, brighter on hover. */
export function SourceLink({
  children,
  onOpen,
  small = false,
}: {
  children: ReactNode;
  onOpen?: (() => void) | undefined;
  small?: boolean;
}) {
  if (!onOpen)
    return (
      <span
        className={cn(
          "truncate font-mono text-foreground/80",
          small ? "text-2xs leading-4" : "text-xs",
        )}
      >
        {children}
      </span>
    );
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={cn(
        "shrink-0 cursor-pointer truncate rounded-sm font-mono text-foreground/80 underline decoration-foreground/30 underline-offset-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring hover:text-foreground hover:decoration-foreground/70",
        small ? "text-2xs leading-4" : "text-xs",
      )}
    >
      {children}
    </button>
  );
}

/** A thin vertical bar in a status or stage color, the row marker everywhere. */
export function RowMarker({ className, color }: { className?: string; color?: string }) {
  return (
    <span
      className={cn("h-4 w-0.5 shrink-0 rounded-full", className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** One thin bar split into stage segments, each sized by its share and in its own color. */
export function StageBar({
  segments,
}: {
  segments: ReadonlyArray<{ key: string; color: string; share: number }>;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b px-3">
      <div className="flex w-full">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="flex min-w-4 px-1"
            style={{ width: `${segment.share * 100}%` }}
          >
            <div className="h-1 w-full rounded-full" style={{ backgroundColor: segment.color }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Underlined tabs inside a panel. */
export function UnderlineTabs<T extends string>({
  value,
  tabs,
  onChange,
  warnings,
}: {
  value: T;
  tabs: ReadonlyArray<readonly [T, string]>;
  onChange: (tab: T) => void;
  warnings?: Partial<Record<T, string>> | undefined;
}) {
  return (
    <div className="flex h-9 shrink-0 items-stretch gap-4 border-b px-3">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            "relative cursor-pointer rounded-sm font-medium text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            value === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
          {warnings?.[id] ? (
            <span
              role="img"
              aria-label={warnings[id]}
              className="absolute top-2.5 -right-1.5 size-1.5 rounded-full bg-warning"
            />
          ) : null}
          {value === id ? (
            <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

// Plain table pieces with the shadcn table rhythm: muted sentence-case headers, 12 px rows.
export const tableClass = "w-full table-fixed text-left text-xs";
export const headRowClass = "border-b";
export const headCellClass =
  "sticky top-0 z-10 h-9 bg-background px-3 font-medium text-muted-foreground";
export const rowClass = "border-b transition-colors hover:bg-foreground/4";
export const cellClass = "px-3 py-3 align-middle";
