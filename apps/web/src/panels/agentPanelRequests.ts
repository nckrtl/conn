import type {
  AgentPanelKind,
  AgentPanelRequest,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { previewBridge } from "~/components/preview/previewBridge";
import { openDatabaseQuery } from "~/database/databaseStore";
import type { AppRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSummaries } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";

const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * How each panel kind opens for an agent. Panel-specific actions grow here: a panel reads its
 * own fields from the request. Return an error message when this client cannot show it.
 */
const PANEL_OPENERS: Record<
  AgentPanelKind,
  (threadRef: ScopedThreadRef, request: AgentPanelRequest) => string | void
> = {
  browser: (threadRef, request) => {
    if (request.tabId === undefined) useRightPanelStore.getState().open(threadRef, "preview");
    else useRightPanelStore.getState().openBrowser(threadRef, request.tabId);
  },
  database: (threadRef, request) => {
    if (!window.desktopBridge?.databaseRun) return "This Conn has no Database panel.";
    if (request.sql === undefined) useRightPanelStore.getState().open(threadRef, "database");
    else openDatabaseQuery(threadRef, request.sql);
  },
  mcp: (threadRef) => {
    if (!window.desktopBridge?.mcpConnect) return "This Conn has no MCP panel.";
    useRightPanelStore.getState().open(threadRef, "mcp");
  },
  diff: (threadRef) => useRightPanelStore.getState().open(threadRef, "diff"),
  files: (threadRef) => useRightPanelStore.getState().open(threadRef, "files"),
};

async function showPanel(
  router: AppRouter,
  environmentId: EnvironmentId,
  request: AgentPanelRequest,
): Promise<string | undefined> {
  const threadRef = scopeThreadRef(environmentId, request.threadId);
  if (request.focusWindow) await window.desktopBridge?.revealWindow().catch(() => undefined);
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: request.threadId },
  });
  return PANEL_OPENERS[request.panel](threadRef, request) ?? undefined;
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
          let error: string | undefined;
          try {
            error = await showPanel(router, environmentId, request);
          } catch (cause) {
            error = cause instanceof Error ? cause.message : "Conn could not show the panel.";
          }
          await runAtomCommand(appAtomRegistry, previewEnvironment.agentPanelRespond, {
            environmentId,
            input: {
              requestId: request.requestId,
              ok: error === undefined,
              ...(deviceName === undefined ? {} : { deviceName }),
              ...(error === undefined ? {} : { error }),
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
