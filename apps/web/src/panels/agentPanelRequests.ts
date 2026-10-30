import type {
  AgentPanelDatabaseResult,
  AgentPanelKind,
  AgentPanelMcpResult,
  AgentPanelRequest,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { previewBridge } from "~/components/preview/previewBridge";
import { openDatabaseQuery, runAgentDatabaseQuery } from "~/database/databaseStore";
import { requestAgentMcpServer } from "~/mcp/mcpStore";
import type { AppRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSummaries } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";

const RESUBSCRIBE_DELAY_MS = 2_000;
// Under the server's own wait, so the agent hears the panel's reason rather than a timeout.
const PANEL_ACTION_TIMEOUT_MS = 80_000;

interface PanelOutcome {
  readonly error?: string;
  readonly database?: AgentPanelDatabaseResult;
  readonly mcp?: AgentPanelMcpResult;
}

const opened: PanelOutcome = {};

/**
 * How each panel kind opens for an agent. Panel-specific actions grow here: a panel reads its
 * own fields from the request, and may answer with a result or an error.
 */
const PANEL_OPENERS: Record<
  AgentPanelKind,
  (threadRef: ScopedThreadRef, request: AgentPanelRequest) => PanelOutcome | Promise<PanelOutcome>
> = {
  browser: (threadRef, request) => {
    if (request.tabId === undefined) useRightPanelStore.getState().open(threadRef, "preview");
    else useRightPanelStore.getState().openBrowser(threadRef, request.tabId);
    return opened;
  },
  database: async (threadRef, request) => {
    if (!window.desktopBridge?.databaseRun) return { error: "This Conn has no Database panel." };
    if (request.sql === undefined) {
      useRightPanelStore.getState().open(threadRef, "database");
      return opened;
    }
    if (!request.run) {
      openDatabaseQuery(threadRef, request.sql);
      return opened;
    }
    const outcome = await runAgentDatabaseQuery(
      threadRef,
      {
        sql: request.sql,
        ...(request.connection === undefined ? {} : { connection: request.connection }),
      },
      PANEL_ACTION_TIMEOUT_MS,
    );
    return "error" in outcome ? { error: outcome.error } : { database: outcome.result };
  },
  mcp: async (threadRef, request) => {
    if (!window.desktopBridge?.mcpConnect) return { error: "This Conn has no MCP panel." };
    if (request.mcpServer === undefined) {
      useRightPanelStore.getState().open(threadRef, "mcp");
      return opened;
    }
    const outcome = requestAgentMcpServer(
      scopedThreadKey(threadRef),
      request.mcpServer,
      PANEL_ACTION_TIMEOUT_MS,
    );
    useRightPanelStore.getState().open(threadRef, "mcp");
    const settled = await outcome;
    return "error" in settled ? { error: settled.error } : { mcp: settled.result };
  },
  diff: (threadRef) => {
    useRightPanelStore.getState().open(threadRef, "diff");
    return opened;
  },
  files: (threadRef) => {
    useRightPanelStore.getState().open(threadRef, "files");
    return opened;
  },
};

async function showPanel(
  router: AppRouter,
  environmentId: EnvironmentId,
  request: AgentPanelRequest,
): Promise<PanelOutcome> {
  const threadRef = scopeThreadRef(environmentId, request.threadId);
  if (request.focusWindow) await window.desktopBridge?.revealWindow().catch(() => undefined);
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: request.threadId },
  });
  return PANEL_OPENERS[request.panel](threadRef, request);
}

function followEnvironment(router: AppRouter, environmentId: EnvironmentId): () => void {
  let stopped = false;
  let abort: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const subscribe = async () => {
    abort = new AbortController();
    const deviceName = (await previewBridge?.getHostDeviceName?.()) ?? undefined;
    await runAtomCommand(appAtomRegistry, previewEnvironment.agentPanelRequests, {
      environmentId,
      input: {
        ...(deviceName === undefined ? {} : { deviceName }),
        signal: abort.signal,
        onRequest: async (request) => {
          let outcome: PanelOutcome;
          try {
            outcome = await showPanel(router, environmentId, request);
          } catch (cause) {
            outcome = {
              error: cause instanceof Error ? cause.message : "Conn could not show the panel.",
            };
          }
          await runAtomCommand(appAtomRegistry, previewEnvironment.agentPanelRespond, {
            environmentId,
            input: {
              requestId: request.requestId,
              ok: outcome.error === undefined,
              ...(deviceName === undefined ? {} : { deviceName }),
              ...outcome,
            },
          });
        },
      },
    });
    if (!stopped) retry = setTimeout(() => void subscribe(), RESUBSCRIBE_DELAY_MS);
  };
  void subscribe();
  return () => {
    stopped = true;
    clearTimeout(retry);
    abort?.abort();
  };
}

/**
 * Lets agents in any connected environment show a panel on this desktop: Conn comes to the
 * front, selects the agent's thread and opens the panel. Desktop only.
 */
export function startAgentPanelRequests(router: AppRouter): () => void {
  if (window.desktopBridge === undefined) return () => {};
  const followed = new Map<EnvironmentId, () => void>();
  const stop = appAtomRegistry.subscribe(
    environmentSummaries.connectedEnvironmentIdsAtom,
    (environmentIds) => {
      for (const [environmentId, unfollow] of followed) {
        if (environmentIds.includes(environmentId)) continue;
        unfollow();
        followed.delete(environmentId);
      }
      for (const environmentId of environmentIds) {
        if (!followed.has(environmentId))
          followed.set(environmentId, followEnvironment(router, environmentId));
      }
    },
    { immediate: true },
  );
  return () => {
    stop();
    for (const unfollow of followed.values()) unfollow();
  };
}
