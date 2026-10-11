import type { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  List,
  Plug,
  TerminalSquare,
  Trash2,
  Unplug,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { HeaderRows } from "../api/ApiRequestEditor";
import { newRowId } from "../api/apiRequestStore";
import { ApiTabs } from "../api/ApiTabs";
import { APP_BASE_NAME } from "../branding";
import { ToolbarGroup } from "../components/ToolbarGroup";
import {
  EmptyState,
  McpPromptsView,
  McpResourcesView,
  McpToolsView,
  Notice,
} from "./McpCatalogViews";
import {
  MCP_TRANSPORT_LABELS,
  MCP_TRANSPORTS,
  type McpServerDraft,
  type McpTransport,
  mcpServerLabel,
  newMcpServer,
  serversFromMcpJson,
  toDesktopMcpServer,
} from "./mcpServers";
import {
  clearMcpLog,
  connectMcp,
  disconnectMcp,
  EMPTY_MCP_SESSION,
  loadMcpLists,
  type McpLogEntry,
  type McpSession,
  mcpSessionKey,
  useMcpServerStore,
  useMcpSessionStore,
} from "./mcpStore";

type PanelTab = "tools" | "resources" | "prompts" | "log" | "server";

const EMPTY_SERVERS: readonly McpServerDraft[] = [];

const fieldClass =
  "w-full min-w-0 rounded-(--control-radius) border border-(--shell-divider)! bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring";

function TransportMenu({
  transport,
  onChange,
}: {
  transport: McpTransport;
  onChange: (transport: McpTransport) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="xs" type="button" aria-label="Transport" />}
      >
        <span className="font-mono">{MCP_TRANSPORT_LABELS[transport]}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6}>
        <MenuRadioGroup
          value={transport}
          onValueChange={(value) => onChange(value as McpTransport)}
        >
          {MCP_TRANSPORTS.map((candidate) => (
            <MenuRadioItem key={candidate} value={candidate}>
              <span className="font-mono">{MCP_TRANSPORT_LABELS[candidate]}</span>
              <span className="ms-auto ps-3 text-muted-foreground">
                {candidate === "stdio"
                  ? "Local command"
                  : candidate === "http"
                    ? "Streamable HTTP"
                    : "Legacy SSE"}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function ServersMenu({
  projectKey,
  servers,
  selected,
  projectServers,
  baseUrl,
}: {
  projectKey: string;
  servers: readonly McpServerDraft[];
  selected: McpServerDraft;
  /** Servers in the project's `.mcp.json`. */
  projectServers: readonly McpServerDraft[];
  baseUrl: string | null;
}) {
  const store = useMcpServerStore.getState;
  const savedIds = new Set(servers.map((server) => server.id));
  const unsaved = projectServers.filter((server) => !savedIds.has(server.id));
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button variant="ghost" size="icon-xs" type="button" aria-label="Servers" />}
            />
          }
        >
          <List />
        </TooltipTrigger>
        <TooltipPopup>Servers</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" sideOffset={6}>
        <MenuRadioGroup
          value={selected.id}
          onValueChange={(id) => store().select(projectKey, String(id))}
        >
          {servers.map((server) => (
            <MenuRadioItem key={server.id} value={server.id}>
              <span className="truncate">{mcpServerLabel(server)}</span>
              <span className="ms-auto ps-3 font-mono text-muted-foreground text-xs">
                {MCP_TRANSPORT_LABELS[server.transport]}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {unsaved.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>From .mcp.json</MenuGroupLabel>
              {unsaved.map((server) => (
                <MenuItem key={server.id} onClick={() => store().add(projectKey, server)}>
                  <span className="truncate">{server.name}</span>
                  <span className="ms-auto ps-3 font-mono text-muted-foreground text-xs">
                    {MCP_TRANSPORT_LABELS[server.transport]}
                  </span>
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => store().add(projectKey, newMcpServer(baseUrl))}>
          New server
        </MenuItem>
        <MenuItem
          onClick={() =>
            store().add(projectKey, {
              ...selected,
              id: newRowId(),
              name: selected.name ? `${selected.name} copy` : "",
              headers: selected.headers.map((row) => ({ ...row, id: newRowId() })),
              env: selected.env.map((row) => ({ ...row, id: newRowId() })),
            })
          }
        >
          Duplicate
        </MenuItem>
        <MenuItem
          onClick={() => {
            void disconnectMcp(mcpSessionKey(projectKey, selected.id));
            store().remove(projectKey, selected.id);
          }}
        >
          Delete
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

// ─── Server tab ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}

function ServerTab({
  server,
  session,
  projectCwd,
  onChange,
}: {
  server: McpServerDraft;
  session: McpSession;
  projectCwd: string;
  onChange: (patch: Partial<McpServerDraft>) => void;
}) {
  const info = session.info;
  return (
    <div className="scrollbar-inset min-h-0 flex-1 overflow-y-auto pb-3">
      {info ? (
        <div className="flex flex-col gap-2 border-b border-(--shell-divider)! px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground text-ui">{info.title ?? info.name}</span>
            {info.version ? (
              <span className="font-mono text-muted-foreground text-xs">{info.version}</span>
            ) : null}
            {info.protocolVersion ? (
              <Badge variant="outline">
                <span className="font-mono">{info.protocolVersion}</span>
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["tools", "resources", "prompts", "logging"] as const)
              .filter((capability) => info.capabilities[capability])
              .map((capability) => (
                <Badge key={capability} variant="info">
                  {capability}
                </Badge>
              ))}
          </div>
          {info.instructions ? (
            <p className="whitespace-pre-wrap text-muted-foreground text-ui">{info.instructions}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-3 px-4 py-3">
        <Field label="Name">
          <input
            className={fieldClass}
            value={server.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder={mcpServerLabel({ ...server, name: "" })}
          />
        </Field>
        {server.transport === "stdio" ? (
          <Field label="Folder on this machine">
            <input
              className={fieldClass}
              value={server.cwd}
              onChange={(event) => onChange({ cwd: event.target.value })}
              placeholder={projectCwd}
              spellCheck={false}
            />
          </Field>
        ) : null}
      </div>
      <p className="px-4 pb-1 text-muted-foreground text-xs">
        {server.transport === "stdio" ? "Environment variables" : "Headers"}
      </p>
      {server.transport === "stdio" ? (
        <HeaderRows headers={server.env} onChange={(env) => onChange({ env })} noun="variable" />
      ) : (
        <HeaderRows headers={server.headers} onChange={(headers) => onChange({ headers })} />
      )}
    </div>
  );
}

// ─── Log tab ────────────────────────────────────────────────────────────────

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function LogIcon({ kind }: { kind: McpLogEntry["kind"] }) {
  switch (kind) {
    case "send":
      return <ArrowUpRight className="size-3.5 shrink-0 text-info" aria-label="Sent" />;
    case "receive":
      return <ArrowDownLeft className="size-3.5 shrink-0 text-success" aria-label="Received" />;
    case "stderr":
      return (
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-label="stderr" />
      );
    case "closed":
      return <Unplug className="size-3.5 shrink-0 text-warning" aria-label="Closed" />;
  }
}

function LogRow({ entry }: { entry: McpLogEntry }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.message !== null;
  const label =
    entry.kind === "stderr"
      ? entry.text?.trimEnd()
      : entry.kind === "closed"
        ? "Connection closed"
        : (entry.method ?? "response");
  const response = entry.kind === "receive" && entry.method !== null && entry.rpcId !== null;
  return (
    <div className="border-b border-(--shell-divider)!">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 cursor-pointer items-start gap-2 px-4 py-1.5 text-left font-mono text-xs outline-none hover:bg-foreground/4 focus-visible:bg-foreground/4 disabled:cursor-default"
      >
        <span className="w-3.5 shrink-0 pt-px text-muted-foreground">
          {expandable ? (
            open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )
          ) : null}
        </span>
        <LogIcon kind={entry.kind} />
        <span
          className={cn(
            "min-w-0 flex-1",
            entry.kind === "stderr"
              ? "whitespace-pre-wrap break-all text-muted-foreground"
              : "truncate text-foreground",
          )}
        >
          {label}
          {response ? <span className="text-muted-foreground"> result</span> : null}
        </span>
        {entry.isError ? <Badge variant="error">error</Badge> : null}
        {entry.rpcId !== null ? (
          <span className="shrink-0 text-muted-foreground">#{entry.rpcId}</span>
        ) : null}
        <span className="shrink-0 text-muted-foreground tabular-nums">{formatTime(entry.at)}</span>
      </button>
      {open ? (
        <pre className="whitespace-pre-wrap break-all bg-foreground/2 px-4 py-2 ps-10 font-mono text-xs text-foreground">
          {JSON.stringify(entry.message, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function LogTab({ log }: { log: readonly McpLogEntry[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // Follow new traffic while the view is scrolled to the end.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [log]);
  if (log.length === 0) {
    return <EmptyState>Messages between the panel and the server appear here.</EmptyState>;
  }
  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="scrollbar-gutter-both scrollbar-inset min-h-0 flex-1 overflow-auto"
    >
      {log.map((entry) => (
        <LogRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

/**
 * The MCP surface: connect to a server from the desktop app, browse and call its tools, read
 * its resources, get its prompts, and watch the JSON-RPC traffic, like the MCP Inspector.
 */
export function McpPanel({
  projectKey,
  environmentId,
  cwd,
  baseUrl,
}: {
  projectKey: string;
  environmentId: EnvironmentId;
  /** The project folder; stdio servers run there unless a server sets its own. */
  cwd: string;
  /** The project's app URL, for a new server's `/mcp` endpoint. */
  baseUrl: string | null;
}) {
  const project = useMcpServerStore((state) => state.byProjectKey[projectKey]);
  const servers = project?.servers ?? EMPTY_SERVERS;
  const selected =
    servers.find((server) => server.id === project?.selectedId) ?? servers[0] ?? null;
  const sessionKey = selected ? mcpSessionKey(projectKey, selected.id) : "";
  const session = useMcpSessionStore((state) => state.sessions[sessionKey]) ?? EMPTY_MCP_SESSION;
  const [tab, setTab] = useState<PanelTab>("tools");
  const available = typeof window !== "undefined" && window.desktopBridge?.mcpConnect !== undefined;

  const mcpJson = useProjectFileQuery(environmentId, cwd, ".mcp.json");
  const projectServers = mcpJson.data ? serversFromMcpJson(mcpJson.data.contents) : [];

  useEffect(() => {
    if (servers.length === 0) useMcpServerStore.getState().add(projectKey, newMcpServer(baseUrl));
  }, [baseUrl, projectKey, servers.length]);

  const change = useCallback(
    (patch: Partial<McpServerDraft>) => {
      if (selected) useMcpServerStore.getState().change(projectKey, selected.id, patch);
    },
    [projectKey, selected],
  );

  const connected = session.status === "connected";
  const connecting = session.status === "connecting";

  const toggle = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (!selected || !available) return;
      if (connected || connecting) {
        void disconnectMcp(sessionKey);
        return;
      }
      const server = toDesktopMcpServer(selected, cwd);
      if ("error" in server) {
        useMcpSessionStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [sessionKey]: {
              ...EMPTY_MCP_SESSION,
              ...state.sessions[sessionKey],
              error: server.error,
            },
          },
        }));
        return;
      }
      void connectMcp(sessionKey, server);
    },
    [available, connected, connecting, cwd, selected, sessionKey],
  );

  if (!selected) return null;
  const capabilities = session.info?.capabilities;
  const tabs = [
    ...(!connected || capabilities?.tools
      ? [{ id: "tools" as const, label: "Tools", count: session.tools?.length }]
      : []),
    ...(!connected || capabilities?.resources
      ? [
          {
            id: "resources" as const,
            label: "Resources",
            count:
              session.resources || session.templates
                ? (session.resources?.length ?? 0) + (session.templates?.length ?? 0)
                : undefined,
          },
        ]
      : []),
    ...(!connected || capabilities?.prompts
      ? [{ id: "prompts" as const, label: "Prompts", count: session.prompts?.length }]
      : []),
    { id: "log" as const, label: "Log", count: session.log.length },
    { id: "server" as const, label: "Server" },
  ];
  const activeTab = tabs.some((candidate) => candidate.id === tab) ? tab : "log";
  const catalogTab = activeTab === "tools" || activeTab === "resources" || activeTab === "prompts";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      onKeyDown={(event) => {
        // ⌘↵ in the toolbar connects; inside a form it runs that form instead.
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !(event.target as HTMLElement).closest("form[data-mcp-call]")
        ) {
          event.preventDefault();
          if (!connected) toggle();
        }
      }}
    >
      <form
        onSubmit={toggle}
        className="flex shrink-0 items-center gap-2 border-b border-(--shell-divider)! bg-background py-toolbar ps-2 pe-toolbar-end"
        data-surface-subheader
      >
        <ToolbarGroup role="group" aria-label="Servers">
          <ServersMenu
            projectKey={projectKey}
            servers={servers}
            selected={selected}
            projectServers={projectServers}
            baseUrl={baseUrl}
          />
        </ToolbarGroup>
        <InputGroup variant="soft" className="h-8 min-w-0 flex-1">
          <InputGroupAddon>
            <TransportMenu
              transport={selected.transport}
              onChange={(transport) => change({ transport })}
            />
          </InputGroupAddon>
          {selected.transport === "stdio" ? (
            <InputGroupInput
              value={selected.commandLine}
              onChange={(event) => change({ commandLine: event.target.value })}
              placeholder="npx -y @modelcontextprotocol/server-everything"
              aria-label="Server command"
              spellCheck={false}
            />
          ) : (
            <InputGroupInput
              value={selected.url}
              onChange={(event) => change({ url: event.target.value })}
              placeholder="https://app.test/mcp"
              aria-label="Server URL"
              spellCheck={false}
            />
          )}
        </InputGroup>
        <ToolbarGroup role="group" aria-label="Connection">
          {connected ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    aria-label="Reload lists"
                    onClick={() => void loadMcpLists(sessionKey)}
                  />
                }
              >
                <RefreshIcon />
              </TooltipTrigger>
              <TooltipPopup>Reload tools, resources and prompts</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="submit"
                  aria-label={connected || connecting ? "Disconnect" : "Connect"}
                  disabled={!available}
                />
              }
            >
              {connecting ? <Spinner className="size-4" /> : connected ? <Unplug /> : <Plug />}
            </TooltipTrigger>
            <TooltipPopup>
              {!available
                ? `Needs the ${APP_BASE_NAME} desktop app`
                : connected
                  ? "Disconnect"
                  : connecting
                    ? "Cancel"
                    : "Connect (⌘↵)"}
            </TooltipPopup>
          </Tooltip>
        </ToolbarGroup>
      </form>
      {session.error ? <Notice>{session.error}</Notice> : null}
      <ApiTabs
        value={activeTab}
        onChange={setTab}
        tabs={tabs}
        trailing={
          activeTab === "log" && session.log.length > 0 ? (
            <ToolbarGroup>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      type="button"
                      aria-label="Clear log"
                      onClick={() => clearMcpLog(sessionKey)}
                    />
                  }
                >
                  <Trash2 />
                </TooltipTrigger>
                <TooltipPopup>Clear log</TooltipPopup>
              </Tooltip>
            </ToolbarGroup>
          ) : session.info ? (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-ui">
              <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
              <span className="truncate">{session.info.title ?? session.info.name}</span>
            </span>
          ) : null
        }
      />
      {catalogTab && !connected ? (
        <EmptyState>
          {connecting ? (
            <>
              <Spinner className="me-2 size-4" />
              Connecting…
            </>
          ) : (
            `Connect to the server to see its ${activeTab}.`
          )}
        </EmptyState>
      ) : activeTab === "tools" ? (
        <McpToolsView session={session} sessionKey={sessionKey} />
      ) : activeTab === "resources" ? (
        <McpResourcesView session={session} sessionKey={sessionKey} />
      ) : activeTab === "prompts" ? (
        <McpPromptsView session={session} sessionKey={sessionKey} />
      ) : activeTab === "log" ? (
        <LogTab log={session.log} />
      ) : (
        <ServerTab
          key={selected.id}
          server={selected}
          session={session}
          projectCwd={cwd}
          onChange={change}
        />
      )}
    </div>
  );
}
