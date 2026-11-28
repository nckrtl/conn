import type { DesktopApiHeader, DesktopApiResponse } from "../../../lab-shared/contracts";

// Local fixtures for the API panel. Mirrors apps/web/src/api/apiRequestStore.ts (draft shapes)
// and the DesktopApiResponse contract; `respond` stands in for window.desktopBridge.apiSend.

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export const BASE_URL = "https://conn-app.test";

export interface ApiHeaderRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface ApiRequestDraft {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly ApiHeaderRow[];
  readonly body: string;
}

export interface ToolbarQuery {
  readonly sql: string;
  readonly ms: number;
}

/** What the Laravel Toolbar would load for a request that opted in with `X-Toolbar: 1`. */
export interface ToolbarFixture {
  readonly requestId: string;
  readonly route: string;
  readonly action: string;
  readonly middleware: readonly string[];
  readonly stages: readonly { readonly label: string; readonly ms: number }[];
  readonly memoryMb: number;
  readonly peakMb: number;
  readonly queries: readonly ToolbarQuery[];
  readonly models: readonly { readonly name: string; readonly count: number }[];
}

export interface ApiResponse extends DesktopApiResponse {
  readonly toolbar: ToolbarFixture | null;
}

export const newRowId = () => Math.random().toString(36).slice(2, 10);

export function row(name: string, value: string, enabled = true): ApiHeaderRow {
  return { id: newRowId(), name, value, enabled };
}

/** New requests ask JSON and opt in to the toolbar header, as in the app. */
export function newApiRequest(baseUrl: string | null = BASE_URL): ApiRequestDraft {
  return {
    id: newRowId(),
    method: "GET",
    url: baseUrl ? baseUrl.replace(/\/+$/, "") + "/" : "",
    headers: [row("Accept", "application/json"), row("X-Toolbar", "1")],
    body: "",
  };
}

/** `GET /api/users`: the method and the URL's path, for menus. */
export function apiRequestLabel(request: Pick<ApiRequestDraft, "method" | "url">): string {
  let path = request.url.trim();
  try {
    const url = new URL(path);
    path = `${url.pathname}${url.search}`;
  } catch {
    // Not a full URL yet; show what was typed.
  }
  return `${request.method} ${path || "New request"}`;
}

export function initialRequests(): ApiRequestDraft[] {
  const json = () => [row("Accept", "application/json"), row("X-Toolbar", "1")];
  return [
    {
      id: newRowId(),
      method: "GET",
      url: `${BASE_URL}/api/threads?limit=2`,
      headers: json(),
      body: "",
    },
    {
      id: newRowId(),
      method: "GET",
      url: `${BASE_URL}/api/me`,
      headers: [...json(), row("Authorization", "Bearer lab-token-7f3a", false)],
      body: "",
    },
    {
      id: newRowId(),
      method: "POST",
      url: `${BASE_URL}/api/threads`,
      headers: [...json(), row("Content-Type", "application/json")],
      body: '{\n  "title": "Check the API panel",\n  "project": "conn"\n}',
    },
    {
      id: newRowId(),
      method: "DELETE",
      url: `${BASE_URL}/api/threads/9d2f`,
      headers: json(),
      body: "",
    },
    {
      id: newRowId(),
      method: "GET",
      url: `${BASE_URL}/api/exports/orders.csv`,
      headers: [row("Accept", "text/csv")],
      body: "",
    },
    {
      id: newRowId(),
      method: "GET",
      url: `${BASE_URL}/storage/avatars/nick.png`,
      headers: [row("Accept", "image/png")],
      body: "",
    },
    {
      id: newRowId(),
      method: "GET",
      url: "https://offline.test/health",
      headers: [row("Accept", "application/json")],
      body: "",
    },
  ];
}

const threads = [
  {
    id: "9d2f",
    title: "Fix flaky queue test",
    project: "orbit-gateway",
    status: "running",
    updated_at: "2026-11-25T09:12:44Z",
  },
  {
    id: "41ab",
    title: "Port API panel to the GPUI lab",
    project: "conn",
    status: "idle",
    updated_at: "2026-11-25T08:51:03Z",
  },
  {
    id: "c07e",
    title: "Review PR #4153",
    project: "conn",
    status: "idle",
    updated_at: "2026-11-24T17:20:31Z",
  },
];

const DATE = "Wed, 25 Nov 2026 09:41:07 GMT";

function encode(text: string) {
  return new TextEncoder().encode(text).length;
}

function failed(url: string, error: string, durationMs: number): ApiResponse {
  return {
    error,
    status: 0,
    statusText: "",
    url,
    headers: [],
    body: "",
    bodyEncoding: "text",
    size: 0,
    truncated: false,
    durationMs,
    toolbar: null,
  };
}

interface Reply {
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly body: string;
  readonly bodyEncoding?: "text" | "base64";
  readonly size?: number;
  readonly truncated?: boolean;
  readonly durationMs: number;
  readonly extraHeaders?: readonly DesktopApiHeader[];
  readonly toolbar?: ToolbarFixture;
}

const json = (
  status: number,
  statusText: string,
  data: unknown,
  durationMs: number,
  toolbar?: ToolbarFixture,
): Reply => ({
  status,
  statusText,
  contentType: "application/json",
  body: JSON.stringify(data),
  durationMs,
  ...(toolbar ? { toolbar } : {}),
});

function toolbar(
  route: string,
  action: string,
  timeMs: number,
  queries: readonly ToolbarQuery[],
  models: ToolbarFixture["models"],
  middleware: readonly string[] = ["web", "api", "throttle:api"],
): ToolbarFixture {
  const boot = Math.round(timeMs * 0.22);
  const dbMs = Math.round(queries.reduce((sum, query) => sum + query.ms, 0));
  const render = Math.max(1, Math.round(timeMs * 0.12));
  const handler = Math.max(1, Math.round(timeMs - boot - dbMs - render));
  return {
    requestId: newRowId(),
    route,
    action,
    middleware,
    stages: [
      { label: "Bootstrap", ms: boot },
      { label: "Controller", ms: handler },
      { label: "Database", ms: dbMs },
      { label: "Response", ms: render },
    ],
    memoryMb: 18 + queries.length * 0.4,
    peakMb: 22 + queries.length * 0.6,
    queries,
    models,
  };
}

function routeFor(
  method: string,
  url: URL,
  headers: Map<string, string>,
  body: string,
): Reply | null {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const id = /^\/api\/threads\/([^/]+)$/.exec(path)?.[1];

  if (path === "/api/threads" && (method === "GET" || method === "HEAD")) {
    const limit = Math.max(1, Math.min(3, Number(url.searchParams.get("limit")) || 3));
    const data = threads.slice(0, limit);
    return json(
      200,
      "OK",
      { data, meta: { total: threads.length, limit } },
      84,
      toolbar(
        "api.threads.index",
        "ThreadController@index",
        84,
        [
          { sql: "select * from `threads` order by `updated_at` desc limit 3", ms: 3.2 },
          { sql: "select * from `projects` where `projects`.`id` in (1, 4)", ms: 1.1 },
          { sql: "select * from `users` where `users`.`id` = 1 limit 1", ms: 0.6 },
          { sql: "select * from `users` where `users`.`id` = 1 limit 1", ms: 0.5 },
          { sql: "select * from `users` where `users`.`id` = 1 limit 1", ms: 0.5 },
          { sql: "select count(*) as aggregate from `threads`", ms: 1.4 },
        ],
        [
          { name: "App\\Models\\Thread", count: 3 },
          { name: "App\\Models\\Project", count: 2 },
          { name: "App\\Models\\User", count: 3 },
        ],
      ),
    );
  }

  if (path === "/api/threads" && method === "POST") {
    let payload: unknown;
    try {
      payload = JSON.parse(body || "null");
    } catch {
      return json(400, "Bad Request", { message: "Syntax error: the body is not valid JSON." }, 31);
    }
    const title =
      payload && typeof payload === "object" && "title" in payload
        ? String((payload as { title: unknown }).title).trim()
        : "";
    if (!title) {
      return json(
        422,
        "Unprocessable Content",
        {
          message: "The title field is required.",
          errors: { title: ["The title field is required."] },
        },
        46,
        toolbar("api.threads.store", "ThreadController@store", 46, [], []),
      );
    }
    const project =
      payload && typeof payload === "object" && "project" in payload
        ? String((payload as { project: unknown }).project)
        : "conn";
    return json(
      201,
      "Created",
      {
        data: { id: "e5a9", title, project, status: "idle", updated_at: "2026-11-25T09:41:07Z" },
      },
      132,
      toolbar(
        "api.threads.store",
        "ThreadController@store",
        132,
        [
          { sql: "select * from `projects` where `slug` = ? limit 1", ms: 0.9 },
          {
            sql: "insert into `threads` (`title`, `project_id`, `status`) values (?, ?, ?)",
            ms: 2.7,
          },
        ],
        [{ name: "App\\Models\\Thread", count: 1 }],
      ),
    );
  }

  if (id && (method === "GET" || method === "HEAD")) {
    const thread = threads.find((candidate) => candidate.id === id);
    if (!thread) {
      return json(
        404,
        "Not Found",
        { message: `No query results for model [App\\Models\\Thread] ${id}` },
        38,
        toolbar("api.threads.show", "ThreadController@show", 38, [], []),
      );
    }
    return json(
      200,
      "OK",
      { data: thread },
      52,
      toolbar(
        "api.threads.show",
        "ThreadController@show",
        52,
        [{ sql: "select * from `threads` where `threads`.`id` = ? limit 1", ms: 1.2 }],
        [{ name: "App\\Models\\Thread", count: 1 }],
      ),
    );
  }

  if (id && (method === "PUT" || method === "PATCH")) {
    const thread = threads.find((candidate) => candidate.id === id);
    if (!thread) return json(404, "Not Found", { message: "Thread not found." }, 33);
    let patch: object = {};
    try {
      const parsed: unknown = JSON.parse(body || "{}");
      if (parsed && typeof parsed === "object") patch = parsed;
    } catch {
      return json(400, "Bad Request", { message: "Syntax error: the body is not valid JSON." }, 29);
    }
    return json(
      200,
      "OK",
      { data: { ...thread, ...patch } },
      97,
      toolbar(
        "api.threads.update",
        "ThreadController@update",
        97,
        [
          { sql: "select * from `threads` where `threads`.`id` = ? limit 1", ms: 1 },
          { sql: "update `threads` set `title` = ?, `updated_at` = ? where `id` = ?", ms: 2.1 },
        ],
        [{ name: "App\\Models\\Thread", count: 1 }],
      ),
    );
  }

  if (id && method === "DELETE") {
    return {
      status: 204,
      statusText: "No Content",
      contentType: "application/json",
      body: "",
      durationMs: 61,
      toolbar: toolbar(
        "api.threads.destroy",
        "ThreadController@destroy",
        61,
        [{ sql: "delete from `threads` where `id` = ?", ms: 1.8 }],
        [{ name: "App\\Models\\Thread", count: 1 }],
      ),
    };
  }

  if (path === "/api/me" && method === "GET") {
    const auth = headers.get("authorization");
    if (!auth?.toLowerCase().startsWith("bearer ")) {
      return {
        ...json(
          401,
          "Unauthorized",
          { message: "Unauthenticated." },
          24,
          toolbar("api.me", "MeController", 24, [], [], ["api", "auth:sanctum"]),
        ),
        extraHeaders: [{ name: "www-authenticate", value: "Bearer" }],
      };
    }
    return json(
      200,
      "OK",
      {
        data: { id: 1, name: "Nick", email: "nick@conn-app.test", abilities: ["threads:write"] },
      },
      41,
      toolbar(
        "api.me",
        "MeController",
        41,
        [
          { sql: "select * from `personal_access_tokens` where `token` = ? limit 1", ms: 0.8 },
          { sql: "select * from `users` where `id` = ? limit 1", ms: 0.6 },
        ],
        [{ name: "App\\Models\\User", count: 1 }],
        ["api", "auth:sanctum"],
      ),
    );
  }

  if (path === "/api/exports/orders.csv" && (method === "GET" || method === "HEAD")) {
    const lines = ["id,customer,total,created_at"];
    for (let index = 1; index <= 24; index++) {
      lines.push(
        `${1000 + index},Customer ${index},${(index * 17.35).toFixed(2)},2026-11-${String((index % 25) + 1).padStart(2, "0")}`,
      );
    }
    return {
      status: 200,
      statusText: "OK",
      contentType: "text/csv; charset=utf-8",
      body: lines.join("\n"),
      size: 31_457_280,
      truncated: true,
      durationMs: 1840,
      extraHeaders: [{ name: "content-disposition", value: 'attachment; filename="orders.csv"' }],
    };
  }

  if (
    (method === "GET" || method === "HEAD") &&
    path.startsWith("/storage/") &&
    path.endsWith(".png")
  ) {
    return {
      status: 200,
      statusText: "OK",
      contentType: "image/png",
      // A short base64 prefix of a PNG; the panel only reports that the body is binary.
      body: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      bodyEncoding: "base64",
      size: 48_213,
      durationMs: 18,
      extraHeaders: [{ name: "cache-control", value: "public, max-age=31536000, immutable" }],
    };
  }

  return null;
}

/** Stands in for `window.desktopBridge.apiSend`: resolves a draft against local fixtures only. */
export function respond(request: ApiRequestDraft): ApiResponse {
  const raw = request.url.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return failed(raw, `Invalid URL: ${raw}`, 0);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failed(raw, `Unsupported protocol: ${url.protocol}`, 0);
  }
  if (url.hostname !== new URL(BASE_URL).hostname) {
    return failed(
      raw,
      `getaddrinfo ENOTFOUND ${url.hostname} (the lab serves ${new URL(BASE_URL).hostname} fixtures only)`,
      180,
    );
  }

  const sent = request.headers.filter((header) => header.enabled && header.name.trim());
  const headers = new Map(sent.map((header) => [header.name.trim().toLowerCase(), header.value]));
  const bodyless = request.method === "GET" || request.method === "HEAD";
  const body = bodyless ? "" : request.body;

  let reply: Reply | null;
  if (request.method === "OPTIONS") {
    reply = {
      status: 204,
      statusText: "No Content",
      contentType: "text/plain",
      body: "",
      durationMs: 9,
      extraHeaders: [
        { name: "allow", value: "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS" },
        { name: "access-control-allow-origin", value: "*" },
      ],
    };
  } else {
    reply =
      routeFor(request.method, url, headers, body) ??
      json(404, "Not Found", { message: "The route could not be found." }, 22);
  }

  const optedIn = (headers.get("x-toolbar") ?? "").trim() !== "";
  const attached = optedIn ? (reply.toolbar ?? null) : null;
  const encoding = request.method === "HEAD" ? "text" : (reply.bodyEncoding ?? "text");
  const shownBody = request.method === "HEAD" ? "" : reply.body;
  return {
    error: null,
    status: reply.status,
    statusText: reply.statusText,
    url: url.toString(),
    headers: [
      { name: "content-type", value: reply.contentType },
      ...(reply.extraHeaders?.some((header) => header.name === "cache-control")
        ? []
        : [{ name: "cache-control", value: "no-cache, private" }]),
      { name: "date", value: DATE },
      { name: "server", value: "nginx" },
      { name: "x-request-id", value: attached?.requestId ?? "01JD4X7N0A" },
      ...(attached ? [{ name: "x-laravel-toolbar-id", value: attached.requestId }] : []),
      ...(reply.extraHeaders ?? []),
    ],
    body: shownBody,
    bodyEncoding: encoding,
    size: request.method === "HEAD" ? 0 : (reply.size ?? encode(shownBody)),
    truncated: request.method !== "HEAD" && (reply.truncated ?? false),
    durationMs: reply.durationMs,
    toolbar: attached,
  };
}

function number(value: number, digits = 0) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatMs(value: number): string {
  if (value < 10) return `${number(value, 2)} ms`;
  if (value < 100) return `${number(value, 1)} ms`;
  if (value < 999.5) return `${number(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 9.995) return `${number(seconds, 2)} s`;
  return `${number(seconds, 1)} s`;
}

export function formatBytes(value: number): string {
  const size = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (size >= 1024 ** 3) return `${sign}${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 * 1024) return `${sign}${(size / 1024 / 1024).toFixed(2)} MB`;
  if (size >= 1024) return `${sign}${(size / 1024).toFixed(2)} KB`;
  return `${sign}${size} B`;
}
