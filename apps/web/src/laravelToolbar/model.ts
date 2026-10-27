// Pure mapping from the toolbar payload to what the bar and panels show.
import type {
  SourceLocation,
  ToolbarData,
  ToolbarHistoryRow,
  ToolbarModel,
  ToolbarQuery,
} from "./types";

export type RequestKind = "page" | "inertia" | "xhr";

export interface RequestSummary {
  readonly id: string;
  readonly status: number | null;
  readonly method: string;
  readonly uri: string;
  readonly routeName: string | null;
  /** The route's name, or its URI pattern (such as `/`) when it has none. */
  readonly route: string;
  readonly action: string | null;
  readonly component: string | null;
  readonly kind: RequestKind;
  readonly duration: string | null;
  readonly size: string | null;
}

export interface Stage {
  readonly label: string;
  readonly color: string;
  readonly durationMs: number;
  readonly startMs: number;
  readonly memoryBytes: number;
}

export interface Query {
  readonly sql: string;
  readonly durationMs: number;
  readonly isDuplicate: boolean;
  readonly isSlow: boolean;
  /** Start and length as shares (0–1) of cumulative recorded query time. */
  readonly offset: number;
  readonly share: number;
  readonly file: string | null;
  readonly line: number | null;
  readonly bindings: readonly unknown[];
}

const FALLBACK_STAGE_COLOR = "#8D76FF";

export interface Framework {
  readonly name: string;
  readonly isLaravel: boolean;
  readonly version: string | null;
  readonly environment: string | null;
  readonly debug: string | boolean | null;
  readonly host: string | null;
  readonly timezone: string | null;
  readonly locale: string | null;
}

/** The app's framework: the bridge's `framework` section, else the package's `laravel` one. */
export function framework(data?: ToolbarData | null): Framework {
  const other = data?.framework;
  if (other?.name && other.name !== "Laravel") {
    return {
      name: other.name,
      isLaravel: false,
      version: other.version ?? null,
      environment: other.environment ?? null,
      debug: other.debug ?? null,
      host: other.host ?? null,
      timezone: null,
      locale: null,
    };
  }
  const laravel = data?.laravel;
  return {
    name: "Laravel",
    isLaravel: true,
    version: laravel?.version ?? other?.version ?? null,
    environment: laravel?.environment ?? other?.environment ?? null,
    debug: laravel?.debug ?? other?.debug ?? null,
    host: laravel?.host ?? other?.host ?? null,
    timezone: laravel?.timezone ?? null,
    locale: laravel?.locale ?? null,
  };
}

export function requestKind(row: Pick<ToolbarHistoryRow, "is_xhr" | "response_type">): RequestKind {
  if (!row.is_xhr) return "page";
  return row.response_type === "Inertia" ? "inertia" : "xhr";
}

/** The route's URI pattern with a leading slash; Laravel leaves it off except for `/`. */
export function routeUri(data?: ToolbarData | null): string | null {
  const uri = data?.request?.route_uri ?? data?.request?.uri;
  if (!uri) return null;
  return uri.startsWith("/") ? uri : `/${uri}`;
}

/** The package writes `-` for routes without a name. */
function named(value: string | null | undefined): string | null {
  return value && value !== "-" ? value : null;
}

/** A request as a history row shows it, completed by its full payload when loaded. */
export function summarize(row: ToolbarHistoryRow, data?: ToolbarData | null): RequestSummary {
  return {
    id: row.id,
    status: data?.response?.status_code ?? row.status_code ?? null,
    method: data?.request?.method ?? row.method,
    uri: data?.request?.uri ?? row.uri,
    routeName: named(data?.request?.route_name ?? row.name),
    route: named(data?.request?.route_name ?? row.name) ?? routeUri(data) ?? row.uri,
    action: data?.request?.controller_action ?? row.action ?? null,
    component: data?.request?.view_name ?? null,
    kind: requestKind(row),
    duration: data?.profiler?.total_wall_time?.formattedValue ?? row.duration ?? null,
    size: responseSize(data) ?? row.size ?? null,
  };
}

/** Newer package versions send the response size as a measurement, older ones as text. */
function responseSize(data?: ToolbarData | null): string | null {
  const size = data?.response?.size;
  if (size == null) return null;
  return typeof size === "string" ? size : (size.formattedValue ?? null);
}

/** The history row for a full payload, when the page sent none (an initial page load). */
export function rowFromData(data: ToolbarData): ToolbarHistoryRow | null {
  if (data.history_row) return data.history_row;
  if (!data.request_id) return null;
  return {
    id: data.request_id,
    is_xhr: false,
    method: data.request?.method ?? "GET",
    uri: data.request?.uri ?? "/",
    name: data.request?.route_name ?? null,
    action: data.request?.controller_action ?? null,
    status_code: data.response?.status_code ?? null,
    size: responseSize(data),
    duration: data.profiler?.total_wall_time?.formattedValue ?? null,
    response_type: data.request?.is_inertia ? "Inertia" : null,
  };
}

/** Request stages laid end to end, so each starts where the previous one ended. */
export function stages(data: ToolbarData): Stage[] {
  let cursor = 0;
  return (data.profiler?.stages ?? []).map((stage) => {
    const durationMs = stage.wall_time?.measurement?.value ?? 0;
    const result: Stage = {
      label: stage.label,
      color: stage.color ?? FALLBACK_STAGE_COLOR,
      durationMs,
      startMs: cursor,
      memoryBytes: stage.memory_real_delta?.measurement?.value ?? 0,
    };
    cursor += durationMs;
    return result;
  });
}

export function wallTimeMs(data: ToolbarData): number {
  return (
    data.profiler?.total_wall_time?.value ??
    stages(data).reduce((total, stage) => total + stage.durationMs, 0)
  );
}

function toQuery(query: ToolbarQuery): Query {
  return {
    sql: query.sql,
    durationMs: query.duration,
    isDuplicate: query.is_duplicate ?? false,
    isSlow: query.is_slow ?? false,
    offset: query.offset ?? 0,
    share: query.percentage ?? 0,
    file: query.file ?? null,
    line: query.line ?? null,
    bindings: query.bindings ?? [],
  };
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The query with its bindings written in, so it can run on its own. Placeholders inside
 * quoted strings and identifiers stay; extra placeholders stay `?`.
 */
export function inlineBindings(sql: string, bindings: readonly unknown[]): string {
  let next = 0;
  let quote: string | null = null;
  let out = "";
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = null;
      out += char;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out += char;
    } else if (char === "?" && next < bindings.length) {
      out += sqlLiteral(bindings[next++]);
    } else {
      out += char;
    }
  }
  return out;
}

export function queries(data: ToolbarData): Query[] {
  return (data.queries?.queries ?? []).map(toQuery);
}

export function hasQueryIssues(data: ToolbarData): boolean {
  return (data.queries?.queries ?? []).some((query) => query.is_duplicate || query.is_slow);
}

const MODEL_ACTIONS = ["retrieved", "created", "updated", "deleted"] as const;

// Array.isArray does not narrow a readonly array out of a union.
function isModelList(
  models: NonNullable<ToolbarData["models"]>,
): models is readonly ToolbarModel[] {
  return Array.isArray(models);
}

/** One row per model class, from either payload shape (see `ToolbarData.models`). */
export function toolbarModels(data: ToolbarData): readonly ToolbarModel[] {
  const models = data.models;
  if (!models) return [];
  if (isModelList(models)) return models;
  const rows = new Map<string, { -readonly [K in keyof ToolbarModel]: ToolbarModel[K] }>();
  for (const [key, entry] of Object.entries(models)) {
    const name = entry.model ?? key;
    const action = MODEL_ACTIONS.find((candidate) => candidate === entry.action);
    const row = rows.get(name) ?? { model: name };
    if (action) row[action] = (row[action] ?? 0) + (entry.count ?? 0);
    rows.set(name, row);
  }
  return [...rows.values()];
}

export function modelCount(data: ToolbarData): number {
  return toolbarModels(data).reduce((total, model) => total + (model.retrieved ?? 0), 0);
}

export function formatMs(value: number): string {
  return value >= 100 ? `${Math.round(value)}ms` : `${value.toFixed(value >= 10 ? 1 : 2)}ms`;
}

export function formatBytes(value: number): string {
  const size = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (size >= 1024 ** 3) return `${sign}${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${sign}${(size / 1024 / 1024).toFixed(2)} MB`;
  if (size >= 1024) return `${sign}${(size / 1024).toFixed(2)} KB`;
  return `${sign}${size} B`;
}

/** The file name and line of a source path, for a compact link label. */
export function shortLocation(file: string | null, line: number | null): string | null {
  if (!file) return null;
  const name = file.split("/").pop() ?? file;
  return line ? `${name}:${line}` : name;
}

/** Header maps arrive as arrays per name; show them joined. */
export function headerRows(
  headers: Readonly<Record<string, readonly string[]>> | undefined,
): Array<[string, string]> {
  return Object.entries(headers ?? {}).map(([name, values]) => [name, values.join(", ")]);
}

export type PropBadge = "Shared" | "Always" | "Deferred" | "Optional" | "Merge" | "Scroll" | "Once";

const TYPE_BADGE: Record<string, PropBadge> = {
  always: "Always",
  defer: "Deferred",
  optional: "Optional",
  merge: "Merge",
  scroll: "Scroll",
  once: "Once",
};

export interface PropRow {
  readonly name: string;
  readonly value: unknown;
  /** False for a deferred prop this response left out. */
  readonly loaded: boolean;
  readonly badges: readonly PropBadge[];
  readonly source: SourceLocation | null;
}

/** The page's top-level props with what Inertia knows about them; deferred props come last. */
export function propRows(data: ToolbarData | null): PropRow[] {
  const viewData = data?.request?.view_data;
  // php-data-bridge sends the string "[redacted]" unless view data collection is enabled.
  const values = typeof viewData === "object" && viewData !== null ? viewData : {};
  const meta = data?.inertia?.props ?? {};
  const row = (name: string, loaded: boolean): PropRow => {
    const info = meta[name];
    const badges: PropBadge[] = [];
    if (info?.shared) badges.push("Shared");
    const typeBadge = info?.type ? TYPE_BADGE[info.type] : undefined;
    if (typeBadge) badges.push(typeBadge);
    return { name, value: values[name], loaded, badges, source: info?.source ?? null };
  };
  return [
    ...Object.keys(values).map((name) => row(name, true)),
    ...Object.keys(meta)
      .filter((name) => !(name in values) && meta[name]?.loaded === false)
      .map((name) => row(name, false)),
  ];
}

/** An ini switch as On or Off; empty, "0" and "off" are off. */
export function iniSwitch(value: string | null | undefined): string {
  if (value == null) return "–";
  return ["", "0", "off", "false", "no"].includes(value.toLowerCase()) ? "Off" : "On";
}

const ERROR_LEVELS: ReadonlyArray<readonly [string, number]> = [
  ["E_DEPRECATED", 8192],
  ["E_USER_DEPRECATED", 16384],
  ["E_STRICT", 2048],
  ["E_NOTICE", 8],
  ["E_USER_NOTICE", 1024],
  ["E_WARNING", 2],
  ["E_USER_WARNING", 512],
];

/**
 * `error_reporting` as constants, such as `E_ALL & ~E_DEPRECATED` for 22527 on PHP 8.4+.
 * PHP 8.4 dropped E_STRICT, so E_ALL is 30719 there and 32767 before.
 */
export function errorReportingLabel(
  value: string | null | undefined,
  phpVersion: string | null | undefined,
): string {
  if (value == null || value === "") return "–";
  const level = Number(value);
  if (!Number.isInteger(level)) return value;
  if (level === 0) return "None";
  if (level === -1) return "E_ALL";
  const [major = 0, minor = 0] = (phpVersion ?? "").split(".").map(Number);
  const modern = major > 8 || (major === 8 && minor >= 4);
  const all = modern ? 30719 : 32767;
  const levels = ERROR_LEVELS.filter(([name]) => !(modern && name === "E_STRICT"));
  if ((level & all) !== level) return String(level);
  const missing = levels.filter(([, bit]) => (level & bit) === 0);
  if (missing.reduce((sum, [, bit]) => sum + bit, 0) !== all - level) return String(level);
  return ["E_ALL", ...missing.map(([name]) => `~${name}`)].join(" & ");
}

/** A PHP limit, where -1 (memory) or 0 (time) means no limit. */
export function phpLimit(value: string | number | null | undefined, unit = ""): string {
  if (value == null || value === "") return "–";
  const text = String(value);
  if (text === "-1" || (unit === "s" && text === "0")) return "Unlimited";
  return `${text}${unit}`;
}

/** A duration in seconds as `3d 4h`, `16h 4m` or `5m`. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
