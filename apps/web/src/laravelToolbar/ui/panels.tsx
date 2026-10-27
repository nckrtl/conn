import { Box, Database, MemoryStick, Server, Timer } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useToolbarTab } from "../context";
import {
  errorReportingLabel,
  formatBytes,
  formatMs,
  formatUptime,
  type Framework,
  framework as toFramework,
  iniSwitch,
  inlineBindings,
  phpLimit,
  queries as toQueries,
  shortLocation,
  stages as toStages,
  toolbarModels,
  wallTimeMs,
} from "../model";
import type { ToolbarData } from "../types";
import {
  cellClass,
  EmptyRow,
  headRowClass,
  KeyValueRows,
  MetaDot,
  PanelShell,
  RowMarker,
  Section,
  secondaryLineClass,
  SourceLink,
  StageBar,
  Stat,
  StatStrip,
  UnderlineTabs,
  rowClass,
  tableClass,
} from "./parts";

import { SortHeader, sortTableRows, useTableSort } from "./tableSort";

/** Shown while a history request's payload loads from the page. */
function Loading() {
  return <EmptyRow>Loading request…</EmptyRow>;
}

// ─── Timings ────────────────────────────────────────────────────────────────

export function TimingsPanel() {
  const { selected } = useToolbarTab();
  const total = selected ? wallTimeMs(selected) : 0;
  const stages = selected ? toStages(selected) : [];
  return (
    <PanelShell
      icon={Timer}
      title="Timings"
      actions={<span className="font-medium text-xs tabular-nums">{formatMs(total)}</span>}
    >
      {!selected ? (
        <Loading />
      ) : (
        <>
          <StageBar
            segments={stages.map((stage) => ({
              key: stage.label,
              color: stage.color,
              share: total ? stage.durationMs / total : 0,
            }))}
          />
          <div className="divide-y">
            {stages.map((stage) => (
              <div
                key={stage.label}
                className="flex items-center gap-3 px-3 py-3 text-xs hover:bg-foreground/4"
              >
                <div className="flex w-36 shrink-0 items-center gap-2">
                  <RowMarker color={stage.color} />
                  <span className="truncate font-medium">{stage.label}</span>
                </div>
                <div className="relative h-1 flex-1">
                  <div
                    className="absolute inset-y-0 rounded-full"
                    style={{
                      backgroundColor: stage.color,
                      left: `${total ? (stage.startMs / total) * 100 : 0}%`,
                      width: `${Math.max(total ? (stage.durationMs / total) * 100 : 0, 0.8)}%`,
                    }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right tabular-nums">
                  {formatMs(stage.durationMs)}
                </span>
                <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
                  {total ? Math.round((stage.durationMs / total) * 100) : 0}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </PanelShell>
  );
}

// ─── Memory ─────────────────────────────────────────────────────────────────

/** PHP's memory_limit ("128M", "1G", "-1") in bytes; null when unlimited or unknown. */
function limitBytes(limit: string | undefined): number | null {
  const match = /^(\d+)([KMG])?$/i.exec(limit ?? "");
  if (!match) return null;
  const units: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  return Number(match[1]) * (units[(match[2] ?? "").toUpperCase()] ?? 1);
}

export function MemoryPanel() {
  const { selected } = useToolbarTab();
  const stages = selected ? toStages(selected) : [];
  const allocated = selected?.profiler?.total_allocated_memory;
  const limit = selected?.php?.memory_limit;
  const limitValue = limitBytes(limit);
  const growth = stages.filter((stage) => stage.memoryBytes > 0);
  const totalGrowth = growth.reduce((sum, stage) => sum + stage.memoryBytes, 0);
  // Waterfall: each stage starts where memory stood after the stage before it.
  const steps = stages.reduce<Array<(typeof stages)[number] & { from: number; to: number }>>(
    (list, stage) => {
      const from = list.at(-1)?.to ?? 0;
      list.push({ ...stage, from, to: from + stage.memoryBytes });
      return list;
    },
    [],
  );
  const low = Math.min(0, ...steps.map((step) => step.to));
  const high = Math.max(0, ...steps.map((step) => step.to));
  const span = high - low || 1;
  return (
    <PanelShell
      icon={MemoryStick}
      title="Memory"
      actions={
        selected ? (
          <div className="flex items-center gap-4 text-xs">
            <span>
              <span className="text-muted-foreground">Allocated</span>{" "}
              <span className="font-medium tabular-nums">{allocated?.formattedValue ?? "–"}</span>
            </span>
            <span>
              <span className="text-muted-foreground">Real</span>{" "}
              <span className="font-medium tabular-nums">
                {selected.profiler?.total_real_memory?.formattedValue ?? "–"}
              </span>
            </span>
            {limit ? (
              <span>
                <span className="text-muted-foreground">Limit</span>{" "}
                <span className="font-medium tabular-nums">{limit}</span>
                {limitValue && allocated?.value ? (
                  <span className="text-muted-foreground">
                    {" "}
                    ({((allocated.value / limitValue) * 100).toFixed(1)}%)
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null
      }
    >
      {!selected ? (
        <Loading />
      ) : (
        <>
          <StageBar
            segments={growth.map((stage) => ({
              key: stage.label,
              color: stage.color,
              share: totalGrowth ? stage.memoryBytes / totalGrowth : 0,
            }))}
          />
          <div className="divide-y">
            {steps.map((stage) => (
              <div
                key={stage.label}
                className="flex items-center gap-3 px-3 py-3 text-xs hover:bg-foreground/4"
              >
                <div className="flex w-36 shrink-0 items-center gap-2">
                  <RowMarker color={stage.color} />
                  <span className="truncate font-medium">{stage.label}</span>
                </div>
                <div className="relative h-1 flex-1">
                  <div
                    className="absolute inset-y-0 rounded-full"
                    style={{
                      backgroundColor: stage.color,
                      left: `${((Math.min(stage.from, stage.to) - low) / span) * 100}%`,
                      width: `${Math.max((Math.abs(stage.memoryBytes) / span) * 100, 0.6)}%`,
                    }}
                  />
                </div>
                <span
                  className={cn(
                    "w-20 shrink-0 text-right tabular-nums",
                    stage.memoryBytes < 0 && "text-success-foreground",
                    stage.memoryBytes === 0 && "text-muted-foreground",
                  )}
                >
                  {stage.memoryBytes > 0 ? "+" : ""}
                  {formatBytes(stage.memoryBytes)}
                </span>
                <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
                  {stage.memoryBytes > 0 && totalGrowth
                    ? `${Math.round((stage.memoryBytes / totalGrowth) * 100)}%`
                    : "–"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </PanelShell>
  );
}

// ─── Database ───────────────────────────────────────────────────────────────

type QueryFilter = "all" | "duplicates" | "slow";

const SQL_TOKENS =
  /('(?:[^']|'')*'|`[^`]*`|"[^"]*"|\b\d+(?:\.\d+)?\b|\b(?:select|from|where|and|or|in|is|not|null|order|by|asc|desc|limit|offset|count|as|update|set|insert|into|values|delete|join|left|inner|on|group|having|exists|distinct)\b)/gi;

function tokenClass(token: string) {
  if (token.startsWith("'")) return "text-success-foreground";
  if (token.startsWith("`") || token.startsWith('"')) return "text-foreground";
  if (/^\d/.test(token)) return "text-info-foreground";
  return "text-muted-foreground";
}

/** SQL with keywords muted, identifiers plain, strings green and numbers blue. */
function SqlText({ sql }: { sql: string }) {
  // Keyed by character offset: the fragments of one statement never reorder.
  const fragments = sql
    .split(SQL_TOKENS)
    .reduce<Array<{ text: string; start: number; token: boolean }>>((list, text, index) => {
      const previous = list.at(-1);
      list.push({
        text,
        start: previous ? previous.start + previous.text.length : 0,
        token: index % 2 === 1,
      });
      return list;
    }, []);
  return (
    <span className="truncate font-mono text-foreground/80 text-xs">
      {fragments.map((fragment) =>
        fragment.token ? (
          <span key={fragment.start} className={tokenClass(fragment.text)}>
            {fragment.text}
          </span>
        ) : (
          fragment.text
        ),
      )}
    </span>
  );
}

export function DatabasePanel() {
  const { selected, openSource, openQuery } = useToolbarTab();
  const [filter, setFilter] = useState<QueryFilter>("all");
  const all = selected ? toQueries(selected) : [];
  const recordedQueryTime = all.reduce((sum, query) => sum + query.durationMs, 0);
  const duplicateCount = all.filter((query) => query.isDuplicate).length;
  const slowCount = all.filter((query) => query.isSlow).length;
  const sorting = useTableSort();
  const visible = sortTableRows(
    all.filter((query) =>
      filter === "duplicates" ? query.isDuplicate : filter === "slow" ? query.isSlow : true,
    ),
    sorting.sort,
    (query, column) => (column === "duration" ? query.durationMs : query.sql),
  );
  const duplicates = visible.filter((query) => query.isDuplicate).length;
  const slow = visible.filter((query) => query.isSlow).length;
  const totalTime = visible.reduce((sum, query) => sum + query.durationMs, 0);
  const wall = selected ? wallTimeMs(selected) : 0;
  const database = selected?.queries?.databases?.[0];
  return (
    <PanelShell
      icon={Database}
      title="Queries"
      hasTabs
      flush
      meta={
        database ? (
          <>
            {database.driver ? <span>{database.driver}</span> : null}
            {database.driver && database.name ? <MetaDot /> : null}
            {database.name ? (
              <span className="font-mono text-foreground">{database.name}</span>
            ) : null}
          </>
        ) : null
      }
    >
      <UnderlineTabs
        value={filter}
        onChange={setFilter}
        tabs={[
          ["all", "All"],
          ["duplicates", `Duplicates ${duplicateCount}`],
          ["slow", `Slow ${slowCount}`],
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {!selected ? (
          <Loading />
        ) : (
          <>
            <StatStrip>
              <Stat label="Queries" value={visible.length} />
              <Stat
                label="Query time"
                value={formatMs(totalTime)}
                hint={wall ? `${Math.round((totalTime / wall) * 100)}% of the request` : undefined}
              />
              <Stat
                label="Duplicates"
                value={duplicates}
                hint="Same SQL and bindings"
                tone={duplicates > 0 ? "warning" : "default"}
              />
              <Stat label="Slow" value={slow} />
            </StatStrip>
            {visible.length === 0 ? (
              <EmptyRow>
                {all.length === 0 ? "No queries in this request" : "No queries match"}
              </EmptyRow>
            ) : (
              <table className={tableClass}>
                <colgroup>
                  <col />
                  <col className="w-28" />
                </colgroup>
                <thead>
                  <tr className={headRowClass}>
                    <SortHeader column="query" label="Query" {...sorting} />
                    <SortHeader column="duration" label="Duration" {...sorting} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((query) => {
                    const location = shortLocation(query.file, query.line);
                    return (
                      <tr
                        key={`${query.offset}:${query.sql}`}
                        className="relative border-b text-xs hover:bg-foreground/4"
                      >
                        <td className="relative px-3 py-2.5 align-middle">
                          <RowMarker
                            className={cn(
                              "h-8",
                              query.isSlow
                                ? "bg-info"
                                : query.isDuplicate
                                  ? "bg-warning"
                                  : "bg-muted-foreground/30",
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <SqlText sql={query.sql} />
                            </div>
                            <div className={cn("flex items-center gap-2", secondaryLineClass)}>
                              {location ? (
                                <SourceLink
                                  small
                                  onOpen={
                                    openSource && query.file
                                      ? () => openSource(`${query.file}:${query.line ?? 1}`)
                                      : undefined
                                  }
                                >
                                  {location}
                                </SourceLink>
                              ) : null}
                              {openQuery ? (
                                <SourceLink
                                  small
                                  onOpen={() =>
                                    openQuery(inlineBindings(query.sql, query.bindings))
                                  }
                                >
                                  Open in Database
                                </SourceLink>
                              ) : null}
                              {query.isDuplicate ? (
                                <Badge variant="warning">Duplicate</Badge>
                              ) : null}
                              {query.isSlow ? <Badge variant="info">Slow</Badge> : null}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right align-middle font-mono tabular-nums">
                          <div>{formatMs(query.durationMs)}</div>
                          <Tooltip>
                            <TooltipTrigger
                              render={<div className={secondaryLineClass} tabIndex={0} />}
                            >
                              +{formatMs(query.offset * recordedQueryTime)}
                            </TooltipTrigger>
                            <TooltipPopup>Database time spent on earlier queries</TooltipPopup>
                          </Tooltip>
                          {/* Position within cumulative recorded query time, excluding time between queries.
                              Drawn on the row divider. */}
                          <div className="absolute inset-x-3 -bottom-px h-px">
                            <div
                              className="absolute inset-y-0 bg-primary/60"
                              style={{
                                left: `${query.offset * 100}%`,
                                width: `${Math.max(query.share * 100, 0.4)}%`,
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </PanelShell>
  );
}

// ─── Models ─────────────────────────────────────────────────────────────────

export function ModelsPanel() {
  const { selected } = useToolbarTab();
  const sorting = useTableSort();
  const models = sortTableRows(
    selected ? toolbarModels(selected) : [],
    sorting.sort,
    (model, column) => {
      if (column === "model") return model.model?.split("\\").pop();
      if (column === "retrieved") return model.retrieved ?? 0;
      if (column === "created") return model.created ?? 0;
      if (column === "updated") return model.updated ?? 0;
      return model.deleted ?? 0;
    },
  );
  const total = models.reduce((sum, model) => sum + (model.retrieved ?? 0), 0);
  const max = Math.max(1, ...models.map((model) => model.retrieved ?? 0));
  return (
    <PanelShell
      icon={Box}
      title="Models"
      actions={
        models.length ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span>{total} retrieved</span>
            <MetaDot />
            <span>{models.length} models</span>
          </div>
        ) : null
      }
    >
      {!selected ? (
        <Loading />
      ) : models.length === 0 ? (
        <EmptyRow>No model events recorded. Model tracking needs Laravel Telescope.</EmptyRow>
      ) : (
        <table className={tableClass}>
          <colgroup>
            <col className="w-[36%]" />
            <col className="w-[28%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead>
            <tr className={headRowClass}>
              <SortHeader column="model" label="Model" {...sorting} />
              <SortHeader column="retrieved" label="Retrieved" {...sorting} />
              <SortHeader column="created" label="Created" {...sorting} align="right" />
              <SortHeader column="updated" label="Updated" {...sorting} align="right" />
              <SortHeader column="deleted" label="Deleted" {...sorting} align="right" />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => {
              const fqcn = model.model ?? "";
              return (
                <tr key={fqcn} className={rowClass}>
                  <td className={cellClass}>
                    <div className="truncate font-medium">{fqcn.split("\\").pop()}</div>
                    <div className={cn("truncate font-mono", secondaryLineClass)}>{fqcn}</div>
                  </td>
                  <td className={cellClass}>
                    <div className="flex items-center gap-3">
                      <span className="w-6 text-right tabular-nums">{model.retrieved ?? 0}</span>
                      <span className="relative h-1 flex-1">
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-primary/70"
                          style={{ width: `${((model.retrieved ?? 0) / max) * 100}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  {(
                    [
                      ["created", model.created],
                      ["updated", model.updated],
                      ["deleted", model.deleted],
                    ] as const
                  ).map(([event, count]) => (
                    <td
                      key={event}
                      className={cn(
                        cellClass,
                        "text-right tabular-nums",
                        !count && "text-muted-foreground",
                      )}
                    >
                      {count ? count : "–"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </PanelShell>
  );
}

// ─── Framework & PHP ────────────────────────────────────────────────────────

function isDebug({ debug }: Framework): boolean {
  return debug === true || debug === "1" || debug === "true";
}

type EnvironmentTab = "framework" | "php" | "fpm";

/** Two titled columns of rows; the divider runs to the bottom of the panel. */
function RowColumns({ children }: { children: ReactNode }) {
  return <div className="grid flex-1 grid-cols-2 divide-x">{children}</div>;
}

function FrameworkTab({ selected }: { selected: ToolbarData }) {
  const app = toFramework(selected);
  return (
    <>
      <StatStrip>
        <Stat label={app.name} value={app.version ?? "–"} />
        <Stat label="Environment" value={app.environment ?? "–"} hint="APP_ENV" />
        <Stat
          label="Debug"
          value={isDebug(app) ? "On" : "Off"}
          hint="APP_DEBUG"
          tone={isDebug(app) ? "warning" : "default"}
        />
        {app.isLaravel ? (
          <Stat label="Inertia" value={selected.inertia?.version ?? "–"} hint="Client" />
        ) : null}
      </StatStrip>
      <KeyValueRows
        rows={[
          ...(app.isLaravel
            ? ([
                ["Timezone", app.timezone ?? "–"],
                ["Locale", app.locale ?? "–"],
              ] as const)
            : []),
          ["Host", app.host ?? "–", "mono"],
        ]}
      />
    </>
  );
}

function PhpTab({ php }: { php: NonNullable<ToolbarData["php"]> }) {
  const setting = (name: string) => php.settings?.[name] ?? "–";
  const opcache = php.opcache;
  const opcacheTotal =
    opcache?.memory_used != null && opcache.memory_free != null
      ? opcache.memory_used + opcache.memory_free
      : null;
  return (
    <>
      <StatStrip>
        <Stat label="PHP" value={php.version ?? "–"} hint={php.sapi ?? "Runtime"} />
        <Stat label="Memory limit" value={phpLimit(php.memory_limit)} hint="Per request" />
        <Stat
          label="Max execution"
          value={phpLimit(php.max_execution_time, "s")}
          hint="Per request"
        />
        <Stat
          label="OPcache"
          value={
            opcache?.enabled
              ? opcache.hit_rate != null
                ? `${opcache.hit_rate}%`
                : "On"
              : opcache
                ? "Off"
                : "–"
          }
          hint={opcache?.enabled ? "Hit rate" : "Not loaded"}
          tone={opcache && !opcache.enabled ? "warning" : "default"}
        />
      </StatStrip>
      <RowColumns>
        <Section title="Requests and uploads" className="border-b-0">
          <KeyValueRows
            rows={[
              ["Post max size", setting("post_max_size")],
              ["Upload max filesize", setting("upload_max_filesize")],
              ["Max file uploads", setting("max_file_uploads")],
              ["Max input vars", setting("max_input_vars")],
              ["Max input time", phpLimit(php.settings?.max_input_time, "s")],
              [
                "Socket timeout",
                php.settings?.default_socket_timeout
                  ? `${php.settings.default_socket_timeout}s`
                  : "–",
              ],
            ]}
          />
        </Section>
        <Section title="Errors and OPcache" className="border-b-0">
          <KeyValueRows
            rows={[
              ["Display errors", iniSwitch(php.settings?.display_errors)],
              [
                "Error reporting",
                errorReportingLabel(php.settings?.error_reporting, php.version),
                "mono",
              ],
              ["Log errors", iniSwitch(php.settings?.log_errors)],
              [
                "OPcache memory",
                opcache?.memory_used != null && opcacheTotal != null
                  ? `${formatBytes(opcache.memory_used)} of ${formatBytes(opcacheTotal)}`
                  : "–",
              ],
              ["Validate timestamps", iniSwitch(php.settings?.["opcache.validate_timestamps"])],
              ["JIT", setting("opcache.jit")],
            ]}
          />
        </Section>
      </RowColumns>
      {(php.extensions ?? []).length > 0 ? (
        <Section title="Extensions" aside={`${php.extensions?.length} loaded`} inset>
          <div className="flex flex-wrap gap-1.5">
            {(php.extensions ?? []).map((extension) => (
              <Badge key={extension} variant="outline">
                <span className="font-mono">{extension}</span>
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}

function FpmTab({ fpm }: { fpm: NonNullable<NonNullable<ToolbarData["php"]>["fpm"]> }) {
  const pool = fpm.settings ?? {};
  const maxChildren = pool["pm.max_children"];
  const reached = fpm.max_children_reached ?? 0;
  // Settings the pool file leaves out do not apply to its process manager (spare
  // servers under ondemand, for example), so they are left out here too.
  const poolRows = (
    [
      ["Name", fpm.pool ?? "–", "mono"],
      ["Process manager", pool.pm ?? fpm.process_manager ?? "–"],
      ["Max children", maxChildren ?? "–"],
      ["Start servers", pool["pm.start_servers"] ?? "–"],
      [
        "Spare servers",
        pool["pm.min_spare_servers"] || pool["pm.max_spare_servers"]
          ? `${pool["pm.min_spare_servers"] ?? "–"} to ${pool["pm.max_spare_servers"] ?? "–"}`
          : "–",
      ],
      ["Max requests", pool["pm.max_requests"] ?? "–"],
      ["Idle timeout", pool["pm.process_idle_timeout"] ?? "–"],
      ["Terminate timeout", pool.request_terminate_timeout ?? "–"],
      ["Slowlog timeout", pool.request_slowlog_timeout ?? "–"],
      ["Listen", pool.listen ?? "–", "mono"],
    ] as const
  ).filter(([key, value]) => value !== "–" || key === "Name" || key === "Process manager");
  return (
    <>
      <StatStrip>
        <Stat
          label="Active workers"
          value={fpm.active_processes ?? "–"}
          hint={maxChildren ? `of ${maxChildren} max children` : "Now"}
        />
        <Stat label="Idle workers" value={fpm.idle_processes ?? "–"} hint="Now" />
        <Stat
          label="Listen queue"
          value={fpm.listen_queue ?? "–"}
          hint={`Peak ${fpm.max_listen_queue ?? "–"}`}
          tone={(fpm.listen_queue ?? 0) > 0 ? "warning" : "default"}
        />
        <Stat
          label="Max children reached"
          value={reached}
          hint="Since start"
          tone={reached > 0 ? "warning" : "default"}
        />
      </StatStrip>
      <RowColumns>
        <Section title="Pool" className="border-b-0">
          <KeyValueRows rows={poolRows} />
        </Section>
        <Section title="Since start" className="border-b-0">
          <KeyValueRows
            rows={[
              ["Uptime", formatUptime(fpm.start_since)],
              ["Accepted connections", fpm.accepted_conn ?? "–"],
              ["Max active workers", fpm.max_active_processes ?? "–"],
              ["Total workers", fpm.total_processes ?? "–"],
              ["Slow requests", fpm.slow_requests ?? "–"],
            ]}
          />
        </Section>
      </RowColumns>
    </>
  );
}

export function EnvironmentPanel() {
  const { selected } = useToolbarTab();
  const [tab, setTab] = useState<EnvironmentTab>("framework");
  const app = toFramework(selected);
  const php = selected?.php;
  const fpm = php?.fpm ?? null;
  // The PHP-FPM tab exists only when the request ran under PHP-FPM.
  const current = tab === "fpm" && !fpm ? "framework" : tab;
  return (
    <PanelShell
      icon={Server}
      title={`${app.name} & PHP`}
      hasTabs
      flush
      actions={app.host ? <span className="text-muted-foreground text-xs">{app.host}</span> : null}
    >
      <UnderlineTabs
        value={current}
        onChange={setTab}
        tabs={[
          ["framework", app.name],
          ["php", "PHP"],
          ...(fpm ? ([["fpm", "PHP-FPM"]] as const) : []),
        ]}
      />
      <ScrollArea radius="none" scrollFade hideScrollbars className="min-h-0 flex-1">
        <div className="flex min-h-full flex-col">
          {!selected ? (
            <Loading />
          ) : current === "framework" ? (
            <FrameworkTab selected={selected} />
          ) : current === "php" && php ? (
            <PhpTab php={php} />
          ) : current === "fpm" && fpm ? (
            <FpmTab fpm={fpm} />
          ) : (
            <EmptyRow>No PHP details in this request</EmptyRow>
          )}
        </div>
      </ScrollArea>
    </PanelShell>
  );
}
