// @effect-diagnostics nodeBuiltinImport:off -- The SDK's sessions live outside Effect; the folder check is a one-off sync stat.
// @effect-diagnostics globalTimers:off -- The connect deadline races an SDK promise outside any Effect fiber.
// @effect-diagnostics globalDate:off -- Log timestamps for the renderer, set at the IPC boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../DesktopIpc.ts";
import {
  MCP_CONNECT_CHANNEL,
  MCP_DISCONNECT_CHANNEL,
  MCP_EVENT_CHANNEL,
  MCP_REQUEST_CHANNEL,
} from "../channels.ts";

// The MCP panel's sessions. The main process holds each connection, so a stdio server runs on
// this machine with the login shell's PATH, and an HTTP server is reached through Chromium's
// network stack (no CORS, Orbit's local CA for `*.test`). Every JSON-RPC message and the
// server's stderr are pushed to the window that opened the session, for the panel's log.

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const MAX_LIST_PAGES = 50;
const STDERR_TAIL_BYTES = 2_000;

const Header = Schema.Struct({ name: Schema.String, value: Schema.String });

const Server = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMaxLength(4_096)),
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
    cwd: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    transport: Schema.Literals(["http", "sse"]),
    url: Schema.String.check(Schema.isMaxLength(16_384)),
    headers: Schema.Array(Header),
  }),
]);

const ConnectRequest = Schema.Struct({ sessionId: Schema.String, server: Server });

const ServerInfo = Schema.Struct({
  name: Schema.String,
  title: Schema.NullOr(Schema.String),
  version: Schema.String,
  protocolVersion: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  capabilities: Schema.Struct({
    tools: Schema.Boolean,
    resources: Schema.Boolean,
    prompts: Schema.Boolean,
    logging: Schema.Boolean,
  }),
});

const ConnectResponse = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  info: Schema.NullOr(ServerInfo),
  durationMs: Schema.Number,
});

const Method = Schema.Literals([
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
]);

const McpRequest = Schema.Struct({
  sessionId: Schema.String,
  method: Method,
  params: Schema.Unknown,
});

const McpResponse = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  result: Schema.Unknown,
  durationMs: Schema.Number,
});

type Server = typeof Server.Type;
type ServerInfo = typeof ServerInfo.Type;

interface Session {
  readonly client: Client;
  readonly transport: Transport;
  /** Set once the session is replaced or closed; its late events are dropped. */
  retired: boolean;
  stderrTail: string;
}

const sessions = new Map<string, Session>();
const watchedSenders = new Set<number>();
const sessionsBySender = new Map<number, Set<string>>();

function elapsedSince(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function push(senderId: number, event: Record<string, unknown>): void {
  const contents = Electron.webContents.fromId(senderId);
  if (!contents || contents.isDestroyed()) return;
  contents.send(MCP_EVENT_CHANNEL, { ...event, at: Date.now() });
}

/**
 * Taps a transport's traffic without replacing it, so the SDK still sees its own transport
 * class (stdio version probing depends on that).
 */
function tapTransport<T extends Transport>(
  transport: T,
  tap: (kind: "send" | "receive", message: unknown) => void,
): T {
  return new Proxy(transport, {
    get(target, property) {
      if (property === "send") {
        return (message: unknown, options?: unknown) => {
          tap("send", message);
          return (target.send as (message: unknown, options?: unknown) => Promise<void>)(
            message,
            options,
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" && property !== "constructor" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "onmessage" && typeof value === "function") {
        const receive = value as (message: unknown, extra?: unknown) => void;
        return Reflect.set(target, property, (message: unknown, extra?: unknown) => {
          tap("receive", message);
          receive(message, extra);
        });
      }
      return Reflect.set(target, property, value);
    },
  });
}

function shellEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[name] = value;
  }
  // The desktop app may itself run as Node; a server spawned through `node` must not.
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

function makeTransport(server: Server): Transport {
  if (server.transport === "stdio") {
    const cwd = server.cwd?.trim() || NodeOS.homedir();
    if (!NodeFS.existsSync(cwd)) {
      throw new Error(`The folder ${cwd} is not on this machine. Set the server's folder.`);
    }
    return new StdioClientTransport({
      command: server.command,
      args: [...server.args],
      env: shellEnvironment(server.env),
      cwd,
      stderr: "pipe",
    });
  }
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error("Enter a full URL, such as https://app.test/mcp.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be used.");
  }
  const headers = new Headers();
  for (const header of server.headers) {
    if (header.name.trim()) headers.append(header.name.trim(), header.value);
  }
  const options = {
    requestInit: { headers },
    fetch: (input: string | URL, init?: RequestInit) =>
      Electron.net.fetch(input.toString(), { ...init, bypassCustomProtocolHandlers: true }),
  };
  return server.transport === "sse"
    ? new SSEClientTransport(url, options)
    : new StreamableHTTPClientTransport(url, options);
}

function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve();
  session.retired = true;
  sessions.delete(sessionId);
  return session.client.close().catch(() => undefined);
}

function watchSender(senderId: number, sessionId: string): void {
  const owned = sessionsBySender.get(senderId) ?? new Set<string>();
  owned.add(sessionId);
  sessionsBySender.set(senderId, owned);
  if (watchedSenders.has(senderId)) return;
  const contents = Electron.webContents.fromId(senderId);
  if (!contents) return;
  watchedSenders.add(senderId);
  // A closed or reloaded window cannot see its sessions again; stop their servers.
  const closeOwned = () => {
    for (const id of sessionsBySender.get(senderId) ?? []) void closeSession(id);
    sessionsBySender.delete(senderId);
  };
  contents.once("destroyed", () => {
    watchedSenders.delete(senderId);
    closeOwned();
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeOwned();
  });
}

function serverInfo(client: Client): ServerInfo {
  const version = client.getServerVersion();
  const capabilities = client.getServerCapabilities() ?? {};
  return {
    name: version?.name ?? "MCP server",
    title: version?.title ?? null,
    version: version?.version ?? "",
    protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
    instructions: client.getInstructions() ?? null,
    capabilities: {
      tools: capabilities.tools !== undefined,
      resources: capabilities.resources !== undefined,
      prompts: capabilities.prompts !== undefined,
      logging: capabilities.logging !== undefined,
    },
  };
}

async function connect(
  request: typeof ConnectRequest.Type,
  senderId: number,
): Promise<typeof ConnectResponse.Type> {
  const started = performance.now();
  await closeSession(request.sessionId);
  let session: Session | null = null;
  try {
    const inner = makeTransport(request.server);
    const client = new Client(
      { name: "t3code-mcp-panel", version: Electron.app.getVersion() },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = tapTransport(inner, (kind, message) => {
      if (!session?.retired) push(senderId, { sessionId: request.sessionId, kind, message });
    });
    session = { client, transport, retired: false, stderrTail: "" };
    const current = session;
    if (inner instanceof StdioClientTransport) {
      inner.stderr?.on("data", (chunk: Buffer | string) => {
        if (current.retired) return;
        const text = chunk.toString();
        current.stderrTail = (current.stderrTail + text).slice(-STDERR_TAIL_BYTES);
        push(senderId, { sessionId: request.sessionId, kind: "stderr", text });
      });
    }
    client.onclose = () => {
      if (current.retired) return;
      current.retired = true;
      sessions.delete(request.sessionId);
      push(senderId, { sessionId: request.sessionId, kind: "closed" });
    };
    sessions.set(request.sessionId, session);
    watchSender(senderId, request.sessionId);

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The server did not finish connecting within 30 seconds.")),
          CONNECT_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    return { error: null, info: serverInfo(client), durationMs: elapsedSince(started) };
  } catch (error) {
    const stderr = session?.stderrTail.trim() ?? "";
    await closeSession(request.sessionId);
    let message = errorMessage(error);
    if (request.server.transport === "stdio" && /\bENOENT\b/.test(message)) {
      message = `${request.server.command} was not found on this machine's PATH.`;
    }
    return {
      error: stderr ? `${message}\n\n${stderr}` : message,
      info: null,
      durationMs: elapsedSince(started),
    };
  }
}

type ListKey = "tools" | "resources" | "resourceTemplates" | "prompts";

/** Follows `nextCursor` so the panel gets the whole list in one result. */
async function listAll(
  list: (cursor: string | undefined) => Promise<Record<string, unknown>>,
  key: ListKey,
): Promise<Record<string, unknown>> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await list(cursor);
    const pageItems = result[key];
    if (Array.isArray(pageItems)) items.push(...pageItems);
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return { [key]: items };
}

async function call(client: Client, method: typeof Method.Type, params: unknown): Promise<unknown> {
  const options = { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true };
  switch (method) {
    case "ping":
      return client.ping();
    case "tools/list":
      return listAll((cursor) => client.listTools(cursor ? { cursor } : undefined), "tools");
    case "resources/list":
      return listAll(
        (cursor) => client.listResources(cursor ? { cursor } : undefined),
        "resources",
      );
    case "resources/templates/list":
      return listAll(
        (cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined),
        "resourceTemplates",
      );
    case "prompts/list":
      return listAll((cursor) => client.listPrompts(cursor ? { cursor } : undefined), "prompts");
    case "tools/call":
      return client.callTool(params as Parameters<Client["callTool"]>[0], options);
    case "resources/read":
      return client.readResource(params as Parameters<Client["readResource"]>[0], options);
    case "prompts/get":
      return client.getPrompt(params as Parameters<Client["getPrompt"]>[0], options);
  }
}

async function request(input: typeof McpRequest.Type): Promise<typeof McpResponse.Type> {
  const started = performance.now();
  const session = sessions.get(input.sessionId);
  if (!session) {
    return { error: "The server is not connected.", result: null, durationMs: 0 };
  }
  try {
    const result = await call(session.client, input.method, input.params);
    return { error: null, result, durationMs: elapsedSince(started) };
  } catch (error) {
    return { error: errorMessage(error), result: null, durationMs: elapsedSince(started) };
  }
}

export const mcpConnect = DesktopIpc.makeIpcMethod({
  channel: MCP_CONNECT_CHANNEL,
  payload: ConnectRequest,
  result: ConnectResponse,
  handler: Effect.fn("desktop.ipc.mcp.connect")(function* (input, event) {
    const senderId = event?.sender.id ?? -1;
    return yield* Effect.promise(() => connect(input, senderId));
  }),
});

export const mcpRequest = DesktopIpc.makeIpcMethod({
  channel: MCP_REQUEST_CHANNEL,
  payload: McpRequest,
  result: McpResponse,
  handler: Effect.fn("desktop.ipc.mcp.request")(function* (input) {
    return yield* Effect.promise(() => request(input));
  }),
});

export const mcpDisconnect = DesktopIpc.makeIpcMethod({
  channel: MCP_DISCONNECT_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.mcp.disconnect")(function* (sessionId) {
    yield* Effect.promise(() => closeSession(sessionId));
  }),
});
