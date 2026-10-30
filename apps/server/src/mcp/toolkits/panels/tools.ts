import {
  AgentPanelUnavailableError,
  OrchestratorMcpFailure,
  PanelOpenToolInput,
  PanelOpenToolResult,
  PreviewAutomationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Manager from "../../../preview/Manager.ts";
import * as AgentPanelBroker from "../../../panels/AgentPanelBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const PanelOpenTool = Tool.make("panel_open", {
  description: [
    "Show a panel to the user in the Conn desktop app on their Mac, for this thread, from any server: browser, database, mcp, diff or files. Use it to show the user your work running.",
    "browser with url opens a desktop tab there; then every preview_* tool without a tabId drives that tab, including request_credentials and fill_credential to sign in.",
    "Fails when no Conn desktop is connected to this server. Never falls back to a hidden browser.",
  ].join(" "),
  parameters: PanelOpenToolInput,
  success: PanelOpenToolResult,
  failure: Schema.Union([AgentPanelUnavailableError, OrchestratorMcpFailure, PreviewAutomationError]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentPanelBroker.AgentPanelBroker,
    Manager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
})
  .annotate(Tool.Title, "Open panel")
  .annotate(Tool.Destructive, false);

export const PanelsToolkit = Toolkit.make(PanelOpenTool);
