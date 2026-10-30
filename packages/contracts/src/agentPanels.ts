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

/** What a desktop receives: show `panel` for `threadId`, with the panel's own arguments. */
export const AgentPanelRequest = Schema.Struct({
  requestId: AgentPanelRequestId,
  threadId: ThreadId,
  panel: AgentPanelKind,
  /** Browser: the tab to show. */
  tabId: Schema.optional(PreviewTabId),
  /** Database: a query to put in the editor. */
  sql: Schema.optional(PanelSql),
  /** Bring the Conn window to the front. */
  focusWindow: Schema.Boolean,
});
export type AgentPanelRequest = typeof AgentPanelRequest.Type;

/** A desktop's answer. The first `ok` answer wins. */
export const AgentPanelResponse = Schema.Struct({
  requestId: AgentPanelRequestId,
  ok: Schema.Boolean,
  /** The desktop's name, for the agent's result. */
  deviceName: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
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

export class AgentPanelUnavailableError extends Schema.TaggedError<AgentPanelUnavailableError>()(
  "AgentPanelUnavailableError",
  {
    reason: Schema.Literals(["no_desktop", "timeout", "rejected", "tab_not_hosted", "invalid"]),
    message: Schema.String,
  },
) {}
