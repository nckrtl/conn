import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import { PreviewTabId } from "./preview.ts";

// Fork patch: agents open Conn desktop panels. A thread on any linked server asks the
// desktops connected to that server to bring Conn forward, select the thread and show a
// panel. Each panel kind may carry its own arguments (the browser a URL, the database
// panel a query), so panel-specific actions grow from here.

const AGENT_PANEL_KINDS = ["browser", "database", "mcp", "diff", "files"] as const;
export const AgentPanelKind = Schema.Literals(AGENT_PANEL_KINDS);
export type AgentPanelKind = typeof AgentPanelKind.Type;

const AgentPanelRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const PanelSql = Schema.String.check(Schema.isMaxLength(64_000));
const PanelUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(8192));

const PanelName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const PanelText = Schema.String.check(Schema.isMaxLength(8192));
const PanelPairs = Schema.Record(Schema.String, PanelText);

/** MCP: the server to add or update in the panel, then connect to. */
export const AgentPanelMcpServer = Schema.Struct({
  /** Finds a saved server with this name to update, or names the new one. */
  name: Schema.optional(PanelName).annotate({
    description: "Server name in the panel; an existing server with this name is updated.",
  }),
  url: Schema.optional(PanelUrl).annotate({
    description: "HTTP or SSE server URL. Pass url or command.",
  }),
  transport: Schema.optional(Schema.Literals(["http", "sse"])).annotate({
    description: "For url: http (default) or sse.",
  }),
  command: Schema.optional(PanelUrl).annotate({
    description: "stdio server: the command line that starts it, run in the project folder.",
  }),
  headers: Schema.optional(PanelPairs).annotate({
    description: "HTTP headers, such as Authorization. Saved in the panel.",
  }),
  env: Schema.optional(PanelPairs).annotate({
    description: "stdio environment variables. Saved in the panel.",
  }),
});
export type AgentPanelMcpServer = typeof AgentPanelMcpServer.Type;

const McpToolArguments = Schema.Record(Schema.String, Schema.Unknown);

/** MCP: the tool to open in the panel and call, on the panel's server or a saved one by name. */
export const AgentPanelMcpCall = Schema.Struct({
  tool: PanelName,
  arguments: McpToolArguments,
  server: Schema.optional(PanelName),
});
export type AgentPanelMcpCall = typeof AgentPanelMcpCall.Type;

/** What a desktop receives: show `panel` for `threadId`, with the panel's own arguments. */
export const AgentPanelRequest = Schema.Struct({
  requestId: AgentPanelRequestId,
  threadId: ThreadId,
  panel: AgentPanelKind,
  /** Browser: the tab to show. */
  tabId: Schema.optional(PreviewTabId),
  /** Database: a query to put in the editor. */
  sql: Schema.optional(PanelSql),
  /** Database: the connection to pick, by name. */
  connection: Schema.optional(PanelName),
  /** Database: run `sql` and answer with the result. */
  run: Schema.optional(Schema.Boolean),
  /** MCP: add or update this server, connect, and answer with its tools. */
  mcpServer: Schema.optional(AgentPanelMcpServer),
  /** MCP: open this tool with its arguments in the form, call it, and answer with the result. */
  mcpCall: Schema.optional(AgentPanelMcpCall),
  /** Bring the Conn window to the front. */
  focusWindow: Schema.Boolean,
});
export type AgentPanelRequest = typeof AgentPanelRequest.Type;

export const AgentPanelDatabaseResult = Schema.Struct({
  connection: Schema.String,
  columns: Schema.Array(Schema.String),
  rowCount: Schema.Number,
  /** The first rows only; long values are cut. */
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  truncated: Schema.Boolean,
});
export type AgentPanelDatabaseResult = typeof AgentPanelDatabaseResult.Type;

export const AgentPanelMcpResult = Schema.Struct({
  server: Schema.String,
  serverInfo: Schema.optional(Schema.String),
  tools: Schema.Array(
    Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
  ),
  resourceCount: Schema.optional(Schema.Number),
  promptCount: Schema.optional(Schema.Number),
});
export type AgentPanelMcpResult = typeof AgentPanelMcpResult.Type;

export const AgentPanelMcpCallResult = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  /** The tool reported an error; its content says what. */
  isError: Schema.Boolean,
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(Schema.Unknown),
  /** Long text was cut and images left out; the panel shows all of it. */
  truncated: Schema.Boolean,
  durationMs: Schema.Number,
});
export type AgentPanelMcpCallResult = typeof AgentPanelMcpCallResult.Type;

/** A desktop's answer. The first `ok` answer wins. */
export const AgentPanelResponse = Schema.Struct({
  requestId: AgentPanelRequestId,
  ok: Schema.Boolean,
  /** The desktop's name, for the agent's result. */
  deviceName: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  database: Schema.optional(AgentPanelDatabaseResult),
  mcp: Schema.optional(AgentPanelMcpResult),
  mcpCall: Schema.optional(AgentPanelMcpCallResult),
});
export type AgentPanelResponse = typeof AgentPanelResponse.Type;

export const AgentPanelSubscribeInput = Schema.Struct({
  deviceName: Schema.optional(Schema.String),
});
export type AgentPanelSubscribeInput = typeof AgentPanelSubscribeInput.Type;

export const PanelOpenToolInput = Schema.Struct({
  panel: AgentPanelKind.annotate({
    description:
      "browser, database, mcp, diff or files. Shows it in the Conn desktop app on the user's Mac.",
  }),
  url: Schema.optional(PanelUrl).annotate({
    description: "browser only: open this page in a new desktop tab.",
  }),
  tabId: Schema.optional(PreviewTabId).annotate({
    description: "browser only: show this existing tab instead.",
  }),
  profileId: Schema.optional(BrowserProfileId).annotate({
    description: "browser only: profile for a new tab. Default: the user's.",
  }),
  sql: Schema.optional(PanelSql).annotate({
    description: "database only: put this query in the editor.",
  }),
  focusWindow: Schema.optional(Schema.Boolean).annotate({
    description: "Bring Conn to the front. Default true.",
  }),
});
export type PanelOpenToolInput = typeof PanelOpenToolInput.Type;

export const PanelOpenToolResult = Schema.Struct({
  panel: AgentPanelKind,
  shownOn: Schema.String,
  /** Browser: the desktop tab. `preview_*` calls without a tabId now drive it. */
  tabId: Schema.optional(PreviewTabId),
});
export type PanelOpenToolResult = typeof PanelOpenToolResult.Type;

const FocusWindow = Schema.optional(Schema.Boolean).annotate({
  description: "Bring Conn to the front. Default true.",
});

export const DatabaseQueryToolInput = Schema.Struct({
  sql: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)).annotate({
    description: "One read-only statement. The panel runs queries read-only.",
  }),
  connection: Schema.optional(PanelName).annotate({
    description:
      "Connection name as the Database panel lists it. Default: the panel's current one. An unknown name fails with the names it has.",
  }),
  focusWindow: FocusWindow,
});
export type DatabaseQueryToolInput = typeof DatabaseQueryToolInput.Type;

export const DatabaseQueryToolResult = Schema.Struct({
  ...AgentPanelDatabaseResult.fields,
  shownOn: Schema.String,
});
export type DatabaseQueryToolResult = typeof DatabaseQueryToolResult.Type;

export const McpConnectToolInput = Schema.Struct({
  ...AgentPanelMcpServer.fields,
  focusWindow: FocusWindow,
});
export type McpConnectToolInput = typeof McpConnectToolInput.Type;

export const McpConnectToolResult = Schema.Struct({
  ...AgentPanelMcpResult.fields,
  shownOn: Schema.String,
});
export type McpConnectToolResult = typeof McpConnectToolResult.Type;

export const McpCallToolInput = Schema.Struct({
  tool: PanelName.annotate({ description: "The tool's name, as tools/list gives it." }),
  arguments: Schema.optional(McpToolArguments).annotate({
    description: "The tool's arguments. Default {}.",
  }),
  server: Schema.optional(PanelName).annotate({
    description:
      "Saved MCP panel server, by name or URL. Default: the panel's current one. mcp_connect adds one.",
  }),
  focusWindow: FocusWindow,
});
export type McpCallToolInput = typeof McpCallToolInput.Type;

export const McpCallToolResult = Schema.Struct({
  ...AgentPanelMcpCallResult.fields,
  shownOn: Schema.String,
});
export type McpCallToolResult = typeof McpCallToolResult.Type;

export class AgentPanelUnavailableError extends Schema.TaggedError<AgentPanelUnavailableError>()(
  "AgentPanelUnavailableError",
  {
    reason: Schema.Literals(["no_desktop", "timeout", "rejected", "tab_not_hosted", "invalid"]),
    message: Schema.String,
  },
) {}
