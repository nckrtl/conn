import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DEFAULT_ORBIT_GATEWAY_URL } from "@t3tools/client-runtime/orbit-gateway";

import * as DesktopIpc from "../DesktopIpc.ts";
import { ORBIT_TOOL_SEND_CHANNEL } from "../channels.ts";
import { hasUnsafeSegment } from "./orbitGateway.ts";

// The Laravel toolbar's Orbit tool, for a thread in an Orbit Instance container. The Node's proxy
// refuses `.orbit` names from containers, so these calls run here. Only the exact calls the tool
// makes are sent, and a write must target the Instance the thread's environment is bound to.

const DEFAULT_TIMEOUT_MS = 60_000;
const ENVIRONMENTS_TTL_MS = 10_000;

const OrbitToolRequest = Schema.Struct({
  /** The thread's T3 environment; writes are limited to its Orbit Instance. */
  environmentId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:._-]{1,128}$/)),
  method: Schema.Literals(["GET", "POST", "PUT", "DELETE"]),
  path: Schema.String.check(Schema.isMaxLength(256)),
  query: Schema.Record(Schema.String, Schema.String),
  body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65_536))),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000), Schema.isLessThanOrEqualTo(120_000)),
  ),
});
export type OrbitToolRequest = typeof OrbitToolRequest.Type;

const OrbitToolResponse = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  status: Schema.Int,
  body: Schema.String,
});
export type OrbitToolResponse = typeof OrbitToolResponse.Type;

type Route =
  | { readonly kind: "read" }
  | { readonly kind: "process-write"; readonly processId: number }
  | { readonly kind: "instance-write"; readonly instanceId: number };

const INT = /^[1-9][0-9]{0,14}$/;
const isInt = (value: string) => INT.test(value);
const isDomain = (value: string) => /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value);
const isLines = (value: string) => isInt(value) && Number(value) <= 5_000;

const ID = "([1-9][0-9]{0,14})";
const STREAM = "([A-Za-z0-9-]{1,64})";

interface RouteSpec {
  readonly method: OrbitToolRequest["method"];
  readonly pattern: RegExp;
  readonly query: Readonly<Record<string, (value: string) => boolean>>;
  readonly body: boolean;
  readonly route: (match: RegExpExecArray) => Route;
}

const read = (): Route => ({ kind: "read" });
const instanceWrite = (match: RegExpExecArray): Route => ({
  kind: "instance-write",
  instanceId: Number(match[1]),
});

/** Every call the Orbit tool makes (`laravelToolbar/orbit.ts`, `applicationLogs.ts`). */
const ROUTES: readonly RouteSpec[] = [
  {
    method: "GET",
    pattern: /^\/api\/v1\/instances\/resolve$/,
    query: { domain: isDomain },
    body: false,
    route: read,
  },
  { method: "GET", pattern: /^\/api\/v1\/nodes$/, query: {}, body: false, route: read },
  {
    method: "GET",
    pattern: /^\/api\/v1\/processes$/,
    query: { target_type: (value) => value === "instance", target_id: isInt },
    body: false,
    route: read,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/v1/processes/${ID}/logs$`),
    query: { lines: isLines },
    body: false,
    route: read,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/v1/processes/${ID}/(?:start|stop|restart)$`),
    query: {},
    body: false,
    route: (match) => ({ kind: "process-write", processId: Number(match[1]) }),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/v1/instances/${ID}/dependencies$`),
    query: {},
    body: false,
    route: read,
  },
  {
    method: "GET",
    pattern: new RegExp(`^/api/v1/instances/${ID}/logs$`),
    query: { lines: isLines },
    body: false,
    route: read,
  },
  {
    method: "POST",
    pattern: new RegExp(`^/api/v1/instances/${ID}/log-streams$`),
    query: {},
    body: true,
    route: instanceWrite,
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/api/v1/instances/${ID}/log-streams/${STREAM}$`),
    query: {},
    body: true,
    route: instanceWrite,
  },
  {
    method: "DELETE",
    pattern: new RegExp(`^/api/v1/instances/${ID}/log-streams/${STREAM}$`),
    query: {},
    body: false,
    route: instanceWrite,
  },
  { method: "GET", pattern: /^\/api\/v1\/realtime$/, query: {}, body: false, route: read },
];

export type OrbitToolMatch =
  | { readonly ok: true; readonly url: URL; readonly route: Route }
  | { readonly ok: false; readonly error: string };

/** Matches a request against the allowlist and builds its Gateway URL. */
export function matchOrbitToolRequest(
  request: Pick<OrbitToolRequest, "method" | "path" | "query" | "body">,
): OrbitToolMatch {
  const refused = (error: string): OrbitToolMatch => ({ ok: false, error });
  if (hasUnsafeSegment(request.path)) return refused("That Gateway path is not allowed.");
  const specs = ROUTES.filter((spec) => spec.pattern.test(request.path));
  if (specs.length === 0) return refused("That Gateway path is not allowed.");
  const spec = specs.find((candidate) => candidate.method === request.method);
  if (!spec) return refused(`${request.method} is not allowed on that Gateway path.`);
  const keys = Object.keys(request.query);
  const wanted = Object.keys(spec.query);
  if (keys.length !== wanted.length || !keys.every((key) => wanted.includes(key))) {
    return refused("That Gateway query is not allowed.");
  }
  for (const [key, valid] of Object.entries(spec.query)) {
    if (!valid(request.query[key]!))
      return refused(`The Gateway query value of ${key} is invalid.`);
  }
  if (!spec.body && request.body !== null) return refused("That Gateway call takes no body.");
  const url = new URL(`${DEFAULT_ORBIT_GATEWAY_URL}${request.path}`);
  if (url.pathname !== request.path || url.origin !== new URL(DEFAULT_ORBIT_GATEWAY_URL).origin) {
    return refused("That Gateway path is not allowed.");
  }
  for (const key of wanted) url.searchParams.set(key, request.query[key]!);
  return { ok: true, url, route: spec.route(spec.pattern.exec(request.path)!) };
}

export type GatewayFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string | null;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dataList(text: string): unknown[] | null {
  try {
    const data = record(JSON.parse(text))?.data;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** The sender for the Orbit tool, with the Gateway call injected for tests. */
export function makeOrbitToolSender(fetch: GatewayFetch, now: () => number = Date.now) {
  const gateway = new URL(DEFAULT_ORBIT_GATEWAY_URL).origin;

  const call = async (input: {
    readonly method: string;
    readonly url: string;
    readonly body: string | null;
    readonly timeoutMs: number;
  }) => {
    const response = await fetch(input.url, {
      method: input.method,
      headers: {
        Accept: "application/json",
        ...(input.body === null ? {} : { "Content-Type": "application/json" }),
      },
      body: input.body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };

  const readList = async (path: string): Promise<unknown[]> => {
    const response = await call({
      method: "GET",
      url: `${gateway}${path}`,
      body: null,
      timeoutMs: 15_000,
    });
    const list = response.status === 200 ? dataList(response.body) : null;
    if (!list) throw new Error(`The Gateway answered ${response.status} for ${path}.`);
    return list;
  };

  let environments: { readonly at: number; readonly list: Promise<unknown[]> } | null = null;
  const environmentList = (fresh: boolean) => {
    if (!environments || fresh || now() - environments.at > ENVIRONMENTS_TTL_MS) {
      const list = readList("/api/v1/conn/environments");
      const entry = { at: now(), list };
      environments = entry;
      list.catch(() => {
        if (environments === entry) environments = null;
      });
    }
    return environments.list;
  };

  /** The Instance the Gateway's environment record binds this environment to, or null. */
  const boundInstance = async (environmentId: string): Promise<number | null> => {
    const find = (list: unknown[]) => {
      const entry = list.map(record).find((item) => item?.environment_id === environmentId);
      return entry === undefined ? undefined : entry?.instance_id;
    };
    let found = find(await environmentList(false));
    // A clone started in the last few seconds may be missing from the cached list.
    if (found === undefined) found = find(await environmentList(true));
    return typeof found === "number" && Number.isInteger(found) && found > 0 ? found : null;
  };

  const authorize = async (environmentId: string, route: Route): Promise<void> => {
    if (route.kind === "read") return;
    const instanceId = await boundInstance(environmentId);
    if (instanceId === null) {
      throw new Error("This thread's environment has no Orbit Instance, so Conn changes nothing.");
    }
    if (route.kind === "instance-write") {
      if (route.instanceId !== instanceId) {
        throw new Error("Conn only changes this thread's own Orbit Instance.");
      }
      return;
    }
    const processes = await readList(
      `/api/v1/processes?target_type=instance&target_id=${instanceId}`,
    );
    if (!processes.some((process) => record(process)?.id === route.processId)) {
      throw new Error("Conn only changes Processes of this thread's own Orbit Instance.");
    }
  };

  return async (request: OrbitToolRequest): Promise<OrbitToolResponse> => {
    const match = matchOrbitToolRequest(request);
    if (!match.ok) return { error: match.error, status: 0, body: "" };
    try {
      await authorize(request.environmentId, match.route);
      return {
        error: null,
        ...(await call({
          method: request.method,
          url: match.url.toString(),
          body: request.body,
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })),
      };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "The Orbit Gateway did not answer in time."
            : error instanceof Error
              ? error.message
              : String(error),
        status: 0,
        body: "",
      };
    }
  };
}

let sender: ReturnType<typeof makeOrbitToolSender> | null = null;

export const orbitToolSend = DesktopIpc.makeIpcMethod({
  channel: ORBIT_TOOL_SEND_CHANNEL,
  payload: OrbitToolRequest,
  result: OrbitToolResponse,
  handler: Effect.fn("desktop.ipc.orbitTool.send")(function* (request) {
    sender ??= makeOrbitToolSender((url, init) =>
      Electron.net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }),
    );
    const send = sender;
    return yield* Effect.promise(() => send(request));
  }),
});
