import type {
  DesktopMcpEvent,
  DesktopMcpMethod,
  DesktopMcpResponse,
  DesktopMcpServer,
  DesktopMcpServerInfo,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import type { McpServerDraft } from "./mcpServers";

// The MCP panel's saved servers, per project (persisted), and its live sessions (this window
// only). A session belongs to one saved server of one project; the desktop main process holds
// the connection, and pushes every message for the log.

// ─── What servers list ──────────────────────────────────────────────────────

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: McpToolAnnotations;
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface McpResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface McpPrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly McpPromptArgument[];
}

// ─── Saved servers ──────────────────────────────────────────────────────────

export interface McpProjectServers {
  readonly servers: readonly McpServerDraft[];
  readonly selectedId: string | null;
}

const EMPTY_PROJECT: McpProjectServers = { servers: [], selectedId: null };

interface McpServerState {
  readonly byProjectKey: Readonly<Record<string, McpProjectServers>>;
  readonly add: (projectKey: string, server: McpServerDraft) => void;
  readonly change: (projectKey: string, id: string, patch: Partial<McpServerDraft>) => void;
  readonly select: (projectKey: string, id: string) => void;
  readonly remove: (projectKey: string, id: string) => void;
}

function updateProject(
  state: McpServerState,
  projectKey: string,
  change: (project: McpProjectServers) => McpProjectServers,
): Pick<McpServerState, "byProjectKey"> {
  return {
    byProjectKey: {
      ...state.byProjectKey,
      [projectKey]: change(state.byProjectKey[projectKey] ?? EMPTY_PROJECT),
    },
  };
}

export const useMcpServerStore = create<McpServerState>()(
  persist(
    (set) => ({
      byProjectKey: {},
      add: (projectKey, server) =>
        set((state) =>
          updateProject(state, projectKey, (project) => ({
            servers: [...project.servers.filter((candidate) => candidate.id !== server.id), server],
            selectedId: server.id,
          })),
        ),
      change: (projectKey, id, patch) =>
        set((state) =>
          updateProject(state, projectKey, (project) => ({
            ...project,
            servers: project.servers.map((server) =>
              server.id === id ? { ...server, ...patch, id } : server,
            ),
          })),
        ),
      select: (projectKey, id) =>
        set((state) =>
          updateProject(state, projectKey, (project) => ({ ...project, selectedId: id })),
        ),
      remove: (projectKey, id) =>
        set((state) =>
          updateProject(state, projectKey, (project) => {
            const index = project.servers.findIndex((server) => server.id === id);
            const servers = project.servers.filter((server) => server.id !== id);
            const neighbour = servers[Math.min(index, servers.length - 1)] ?? null;
            return {
              servers,
              selectedId: project.selectedId === id ? (neighbour?.id ?? null) : project.selectedId,
            };
          }),
        ),
    }),
    {
      name: "t3code:mcp-servers:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

// ─── Sessions ───────────────────────────────────────────────────────────────

export type McpStatus = "disconnected" | "connecting" | "connected";
export type McpListKind = "tools" | "resources" | "prompts";

export interface McpLogEntry {
  readonly id: number;
  readonly at: number;
  readonly kind: DesktopMcpEvent["kind"];
  /** The request's method, also on its response. */
  readonly method: string | null;
  readonly rpcId: string | number | null;
  readonly isError: boolean;
  readonly message: unknown;
  readonly text: string | null;
}

export interface McpCall {
  readonly response: DesktopMcpResponse | null;
  readonly running: boolean;
}

export interface McpSession {
  readonly status: McpStatus;
  readonly error: string | null;
  readonly info: DesktopMcpServerInfo | null;
  readonly tools: readonly McpTool[] | null;
  readonly resources: readonly McpResource[] | null;
  readonly templates: readonly McpResourceTemplate[] | null;
  readonly prompts: readonly McpPrompt[] | null;
  readonly listErrors: Readonly<Partial<Record<McpListKind, string | undefined>>>;
  readonly log: readonly McpLogEntry[];
  /** The last result per tool call, resource read, or prompt get, by the panel's key. */
  readonly calls: Readonly<Record<string, McpCall>>;
  /** Form text per call key, so arguments survive switching tools and tabs. */
  readonly forms: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const EMPTY_MCP_SESSION: McpSession = {
  status: "disconnected",
  error: null,
  info: null,
  tools: null,
  resources: null,
  templates: null,
  prompts: null,
  listErrors: {},
  log: [],
  calls: {},
  forms: {},
};

const MAX_LOG_ENTRIES = 1_000;

interface McpSessionState {
  readonly sessions: Readonly<Record<string, McpSession>>;
}

export const useMcpSessionStore = create<McpSessionState>()(() => ({ sessions: {} }));

/** One session per saved server of a project. */
export function mcpSessionKey(projectKey: string, serverId: string): string {
  return `${projectKey}\u0000${serverId}`;
}

function updateSession(key: string, change: (session: McpSession) => Partial<McpSession>): void {
  useMcpSessionStore.setState((state) => {
    const session = state.sessions[key] ?? EMPTY_MCP_SESSION;
    return { sessions: { ...state.sessions, [key]: { ...session, ...change(session) } } };
  });
}

function bridge() {
  return typeof window !== "undefined" ? window.desktopBridge : undefined;
}

/** Request ids to methods, per session, so a response's log row names its method. */
const pendingMethods = new Map<string, Map<string | number, string>>();
let nextLogId = 1;
let listening = false;

function field(message: unknown, name: string): unknown {
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>)[name]
    : undefined;
}

const LIST_CHANGED: Record<string, McpListKind> = {
  "notifications/tools/list_changed": "tools",
  "notifications/resources/list_changed": "resources",
  "notifications/prompts/list_changed": "prompts",
};

function receiveEvent(event: DesktopMcpEvent): void {
  const key = event.sessionId;
  if (!useMcpSessionStore.getState().sessions[key]) return;
  const pending = pendingMethods.get(key) ?? new Map<string | number, string>();
  pendingMethods.set(key, pending);
  const method = field(event.message, "method");
  const rawId = field(event.message, "id");
  const rpcId = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;
  let entryMethod = typeof method === "string" ? method : null;
  if (entryMethod && rpcId !== null && event.kind === "send") pending.set(rpcId, entryMethod);
  if (!entryMethod && rpcId !== null) {
    entryMethod = pending.get(rpcId) ?? null;
    pending.delete(rpcId);
  }
  const entry: McpLogEntry = {
    id: nextLogId++,
    at: event.at,
    kind: event.kind,
    method: entryMethod,
    rpcId,
    isError: field(event.message, "error") !== undefined,
    message: event.message ?? null,
    text: event.text ?? null,
  };
  updateSession(key, (session) => ({
    log: [...session.log.slice(-(MAX_LOG_ENTRIES - 1)), entry],
    ...(event.kind === "closed"
      ? { status: "disconnected" as const, error: "The server closed the connection." }
      : {}),
  }));
  if (event.kind === "closed") pendingMethods.delete(key);
  const changed = entryMethod && event.kind === "receive" ? LIST_CHANGED[entryMethod] : undefined;
  if (changed) void loadMcpLists(key, [changed]);
}

function listen(): void {
  const subscribe = bridge()?.onMcpEvent;
  if (listening || !subscribe) return;
  listening = true;
  subscribe(receiveEvent);
}

async function send(
  key: string,
  method: DesktopMcpMethod,
  params: unknown = {},
): Promise<DesktopMcpResponse> {
  const mcpRequest = bridge()?.mcpRequest;
  if (!mcpRequest) return { error: "Needs the desktop app.", result: null, durationMs: 0 };
  return mcpRequest({ sessionId: key, method, params }).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    result: null,
    durationMs: 0,
  }));
}

function listOf<T>(response: DesktopMcpResponse, name: string): readonly T[] {
  const items = field(response.result, name);
  return Array.isArray(items) ? (items as T[]) : [];
}

/** Loads the lists the server offers; `kinds` limits it to what changed. */
export async function loadMcpLists(
  key: string,
  kinds: readonly McpListKind[] = ["tools", "resources", "prompts"],
): Promise<void> {
  const capabilities = useMcpSessionStore.getState().sessions[key]?.info?.capabilities;
  if (!capabilities) return;
  await Promise.all(
    kinds
      .filter((kind) => capabilities[kind])
      .map(async (kind) => {
        if (kind === "resources") {
          const [resources, templates] = await Promise.all([
            send(key, "resources/list"),
            send(key, "resources/templates/list"),
          ]);
          updateSession(key, (session) => ({
            resources: listOf<McpResource>(resources, "resources"),
            // Templates are optional; a server without them may answer with an error.
            templates: templates.error
              ? []
              : listOf<McpResourceTemplate>(templates, "resourceTemplates"),
            listErrors: { ...session.listErrors, resources: resources.error ?? undefined },
          }));
          return;
        }
        const response = await send(key, kind === "tools" ? "tools/list" : "prompts/list");
        updateSession(key, (session) => ({
          ...(kind === "tools"
            ? { tools: listOf<McpTool>(response, "tools") }
            : { prompts: listOf<McpPrompt>(response, "prompts") }),
          listErrors: { ...session.listErrors, [kind]: response.error ?? undefined },
        }));
      }),
  );
}

export async function connectMcp(key: string, server: DesktopMcpServer): Promise<void> {
  const mcpConnect = bridge()?.mcpConnect;
  if (!mcpConnect) return;
  listen();
  // Keep typed arguments across reconnects; everything else starts over.
  updateSession(key, (session) => ({
    ...EMPTY_MCP_SESSION,
    status: "connecting",
    forms: session.forms,
  }));
  pendingMethods.delete(key);
  const response = await mcpConnect({ sessionId: key, server }).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    info: null,
    durationMs: 0,
  }));
  if (useMcpSessionStore.getState().sessions[key]?.status !== "connecting") return;
  if (response.error || !response.info) {
    updateSession(key, () => ({ status: "disconnected", error: response.error }));
    return;
  }
  updateSession(key, () => ({ status: "connected", error: null, info: response.info }));
  await loadMcpLists(key);
}

export async function disconnectMcp(key: string): Promise<void> {
  updateSession(key, () => ({ status: "disconnected", error: null }));
  pendingMethods.delete(key);
  await bridge()?.mcpDisconnect?.(key);
}

/** Runs one call and keeps its result under `callKey` (for example `tool:search`). */
export async function runMcpCall(
  key: string,
  callKey: string,
  method: DesktopMcpMethod,
  params: unknown,
): Promise<void> {
  updateSession(key, (session) => ({
    calls: {
      ...session.calls,
      [callKey]: { response: session.calls[callKey]?.response ?? null, running: true },
    },
  }));
  const response = await send(key, method, params);
  updateSession(key, (session) => ({
    calls: { ...session.calls, [callKey]: { response, running: false } },
  }));
}

/** Shows a validation problem in the result area, as a failed call would. */
export function failMcpCall(key: string, callKey: string, error: string): void {
  updateSession(key, (session) => ({
    calls: {
      ...session.calls,
      [callKey]: { response: { error, result: null, durationMs: 0 }, running: false },
    },
  }));
}

export function setMcpForm(
  key: string,
  callKey: string,
  values: Readonly<Record<string, string>>,
): void {
  updateSession(key, (session) => ({ forms: { ...session.forms, [callKey]: values } }));
}

export function clearMcpLog(key: string): void {
  updateSession(key, () => ({ log: [] }));
}
