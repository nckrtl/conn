import { gatewayApplicationLogs, type FollowApplicationLogs } from "./applicationLogs";
// The Orbit tool: the processes of the Orbit Instance that serves the page, and their logs.
// Calls go through the Gateway like T3's other Orbit features (see ~/orbit/orbitTransport.ts).
import { callOrbit, isOrbitApiError, listOrbitNodes } from "~/orbit/orbitApi";
import type { ToolbarDependency } from "./types";
import type { OrbitTransport } from "~/orbit/orbitTransport";

/** `unknown`: Orbit could not observe the runtime (container Instances, for now). */
export type ProcessStatus = "running" | "starting" | "crashed" | "stopped" | "unknown";
export type ProcessAction = "start" | "stop" | "restart";

export interface OrbitProcess {
  readonly id: number;
  readonly name: string;
  readonly command: string | null;
  readonly status: ProcessStatus;
  /** Percent of one core. */
  readonly cpu: number | null;
  readonly memoryBytes: number | null;
}

export function hasProcessWarning(processes: readonly OrbitProcess[]): boolean {
  return processes.some((process) => process.status === "crashed" || process.status === "stopped");
}

export interface OrbitPage {
  readonly domain: string;
  readonly instanceId: number;
  readonly nodeName: string | null;
}

export interface OrbitDependencies {
  readonly composer: readonly ToolbarDependency[] | null;
  readonly javascript: readonly ToolbarDependency[] | null;
  readonly package_manager: string | null;
  readonly errors?: Partial<Record<"composer" | "javascript", string>>;
}

export interface LogLine {
  /** Position in the tail. */
  readonly id: number;
  /** Local clock time, when the line carries a timestamp. */
  readonly time: string | null;
  readonly text: string;
}

/** What the toolbar asks of Orbit; the browser pane and the design page each provide one. */
export interface OrbitSource {
  readonly page: () => Promise<OrbitPage | null>;
  readonly applicationLogs: FollowApplicationLogs;
  readonly processes: (instanceId: number) => Promise<OrbitProcess[]>;
  readonly dependencies: (instanceId: number) => Promise<OrbitDependencies>;
  readonly logs: (processId: number, lines: number) => Promise<string>;
  readonly act: (processId: number, action: ProcessAction) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const RUNNING = new Set(["active", "running"]);
const STARTING = new Set(["activating", "reloading", "restarting", "created"]);

const UNOBSERVED = new Set(["", "unknown"]);

/**
 * systemd and Docker report different words. When the Gateway could not observe the
 * runtime, its own `status` decides; a missing answer is never shown as a crash.
 */
export function processStatus(data: Record<string, unknown> | null): ProcessStatus {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const runtime = text(data?.runtime_status);
  const wanted = data?.desired_state === "running";
  if (RUNNING.has(runtime)) return "running";
  if (STARTING.has(runtime)) return "starting";
  const failed =
    runtime === "failed" || text(data?.error_code) !== "" || text(data?.failed_step) !== "";
  if (failed) return "crashed";
  if (!UNOBSERVED.has(runtime)) return wanted ? "crashed" : "stopped";
  const status = text(data?.status);
  if (RUNNING.has(status)) return "running";
  if (STARTING.has(status)) return "starting";
  if (status === "failed") return wanted ? "crashed" : "stopped";
  return wanted ? "unknown" : "stopped";
}

export function parseProcess(value: unknown): OrbitProcess | null {
  const data = record(value);
  const id = finite(data?.id);
  const name = typeof data?.name === "string" ? data.name : null;
  if (id === null || !name) return null;
  const config = record(data?.runtime_config);
  const command = Array.isArray(config?.command)
    ? config.command.filter((part): part is string => typeof part === "string").join(" ")
    : null;
  return {
    id,
    name,
    command: command || (typeof config?.image === "string" ? config.image : null),
    status: processStatus(data),
    cpu: finite(data?.cpu),
    memoryBytes: finite(data?.memory_bytes),
  };
}

// journald's short-iso output: `2026-10-02T07:24:48+00:00 beast pi-server[3099520]: message`.
const JOURNAL_LINE =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[+-]\d\d:?\d\d|Z)?)\s+\S+\s+[^\s:]+:\s?(.*)$/;

/** Splits a log tail into lines, with the journal's host and unit prefix removed. */
export function parseLogLines(text: string): LogLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && line !== "-- No entries --")
    .map((line, id) => {
      const match = JOURNAL_LINE.exec(line);
      if (!match) return { id, time: null, text: line };
      const date = new Date(match[1]!);
      return {
        id,
        time: Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour12: false }),
        text: match[2]!,
      };
    });
}

const LEVEL = /\b(INFO|WARN(?:ING)?|ERROR|DONE|RUNNING|FAIL(?:ED)?)\b/;

/** A log line cut around its level words (INFO, ERROR, ...), so the panel can color them. */
export function splitLogLevels(
  text: string,
): { readonly offset: number; readonly text: string; readonly level: string | null }[] {
  let offset = 0;
  return text
    .split(LEVEL)
    .map((part, index) => {
      const piece = { offset, text: part, level: index % 2 === 1 ? part : null };
      offset += part.length;
      return piece;
    })
    .filter((piece) => piece.text !== "");
}

/** Decode saved lockfile inventory; root constraints are absent for transitive packages. */
export function parseDependencies(value: unknown): OrbitDependencies {
  const data = record(value);
  const errors: Partial<Record<"composer" | "javascript", string>> = {};
  const read = (ecosystem: "composer" | "javascript"): readonly ToolbarDependency[] | null => {
    const inventory = record(data?.[ecosystem]);
    if (typeof inventory?.error_code === "string") errors[ecosystem] = inventory.error_code;
    const graph = record(record(inventory?.snapshot)?.graph);
    if (!Array.isArray(graph?.resolutions)) return null;
    const requirements = Array.isArray(graph?.requirements) ? graph.requirements : [];
    const roots = new Map(
      requirements.flatMap((value) => {
        const requirement = record(value);
        return requirement?.from === null &&
          typeof requirement.to === "string" &&
          requirement.kind === "dependency"
          ? [[requirement.to, requirement] as const]
          : [];
      }),
    );
    return graph.resolutions.flatMap((value) => {
      const resolution = record(value);
      if (typeof resolution?.name !== "string" || typeof resolution.version !== "string") return [];
      const root = typeof resolution.id === "string" ? roots.get(resolution.id) : undefined;
      return [
        {
          id:
            typeof resolution.id === "string"
              ? resolution.id
              : `${resolution.name}@${resolution.version}`,
          name: resolution.name,
          version: resolution.version,
          constraint: typeof root?.constraint === "string" ? root.constraint : null,
          development: resolution.development === true && resolution.regular !== true,
        },
      ];
    });
  };
  const hashes = record(record(record(record(data?.javascript)?.snapshot)?.source)?.file_hashes);
  const manager = hashes?.["pnpm-lock.yaml"]
    ? "pnpm"
    : hashes?.["bun.lock"] || hashes?.["bun.lockb"]
      ? "bun"
      : hashes?.["yarn.lock"]
        ? "yarn"
        : hashes?.["package-lock.json"] || hashes?.["npm-shrinkwrap.json"]
          ? "npm"
          : null;
  return {
    composer: read("composer"),
    javascript: read("javascript"),
    package_manager: manager,
    errors,
  };
}

/** How long the Gateway may take to return a Process log tail. */
export const LOG_TIMEOUT_SECONDS = 30;

let nodeNames: Promise<Map<number, string>> | null = null;

/** Orbit for the page on `domain`, through `transport` (which runs on an Orbit Node). */
export function gatewayOrbitSource(transport: OrbitTransport, domain: string): OrbitSource {
  const resolvePage = async (): Promise<OrbitPage | null> => {
    let resolved: Record<string, unknown> | null;
    try {
      resolved = record(
        await callOrbit(transport, {
          method: "GET",
          path: "/api/v1/instances/resolve",
          query: { domain },
        }),
      );
    } catch (error) {
      // Domains Orbit does not serve are not an error; the tool just stays hidden.
      if (isOrbitApiError(error) && error.status === 404) return null;
      throw error;
    }
    const instanceId = finite(resolved?.instance_id);
    if (instanceId === null) return null;
    nodeNames ??= listOrbitNodes(transport)
      .then((nodes) => new Map(nodes.map((node) => [node.id, node.name])))
      .catch(() => {
        nodeNames = null;
        return new Map<number, string>();
      });
    const nodeId = finite(resolved?.node_id);
    return {
      domain,
      instanceId,
      nodeName: nodeId === null ? null : ((await nodeNames).get(nodeId) ?? null),
    };
  };
  // The domain's Instance does not change while the page is open; ask once, retry on errors.
  let page: Promise<OrbitPage | null> | null = null;
  return {
    applicationLogs: gatewayApplicationLogs(transport),
    page: () =>
      (page ??= resolvePage().catch((error: unknown) => {
        page = null;
        throw error;
      })),
    processes: async (instanceId) => {
      const data = await callOrbit(transport, {
        method: "GET",
        path: "/api/v1/processes",
        query: { target_type: "instance", target_id: String(instanceId) },
      });
      return Array.isArray(data)
        ? data.flatMap((value) => {
            const process = parseProcess(value);
            return process ? [process] : [];
          })
        : [];
    },
    dependencies: async (instanceId) =>
      parseDependencies(
        await callOrbit(transport, {
          method: "GET",
          path: `/api/v1/instances/${instanceId}/dependencies`,
        }),
      ),
    logs: async (processId, lines) => {
      const data = record(
        await callOrbit(transport, {
          method: "GET",
          path: `/api/v1/processes/${processId}/logs`,
          query: { lines: String(lines) },
          // Container Processes answer in about 8 s today.
          timeoutSeconds: LOG_TIMEOUT_SECONDS,
        }),
      );
      return typeof data?.logs === "string" ? data.logs : "";
    },
    act: async (processId, action) => {
      await callOrbit(transport, {
        method: "POST",
        path: `/api/v1/processes/${processId}/${action}`,
        timeoutSeconds: 120,
      });
    },
  };
}
