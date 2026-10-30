import { AgentPanelUnavailableError, type PreviewTabId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../../config.ts";
import * as AgentPanelBroker from "../../../panels/AgentPanelBroker.ts";
import * as Manager from "../../../preview/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PanelsToolkit } from "./tools.ts";

const HOSTED_TAB_TIMEOUT_MS = 20_000;
const HOSTED_TAB_POLL_MS = 250;

const invalid = (message: string) =>
  new AgentPanelUnavailableError({ reason: "invalid", message });

/** A desktop tab is drivable once the desktop that renders it registers as its host. */
const awaitHostedTab = Effect.fn("PanelsToolkit.awaitHostedTab")(function* (
  scope: McpInvocationContext.McpThreadInvocationScope,
  tabId: PreviewTabId,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const hosted = broker
    .desktopTabs(scope.environmentId, scope.thread.threadId)
    .pipe(Effect.map((tabs) => tabs.some((tab) => tab.tabId === tabId)));
  const deadline = (yield* Clock.currentTimeMillis) + HOSTED_TAB_TIMEOUT_MS;
  while (!(yield* hosted)) {
    if ((yield* Clock.currentTimeMillis) > deadline)
      return yield* new AgentPanelUnavailableError({
        reason: "tab_not_hosted",
        message: `The Conn desktop showed the browser panel, but tab ${tabId} did not connect within ${HOSTED_TAB_TIMEOUT_MS / 1000} s. Pass its tabId to preview_* tools once it loads.`,
      });
    yield* Effect.sleep(HOSTED_TAB_POLL_MS);
  }
  // Pins this thread's current tab, so preview_* calls without a tabId drive it.
  yield* broker.invoke({ scope, operation: "status", input: {}, tabId, timeoutMs: 5_000 });
});

export const layer = McpToolAccess.toLayer(PanelsToolkit, {
  panel_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(invocation, "panel_open");
      const panels = yield* AgentPanelBroker.AgentPanelBroker;
      const threadId = caller.thread.threadId;
      const focusWindow = input.focusWindow ?? true;
      const isBrowser = input.panel === "browser";
      if (!isBrowser && (input.url || input.tabId || input.profileId))
        return yield* invalid("url, tabId and profileId apply to the browser panel only.");
      if (input.panel !== "database" && input.sql !== undefined)
        return yield* invalid("sql applies to the database panel only.");
      if (input.url && input.tabId) return yield* invalid("Pass url or tabId, not both.");

      if (!isBrowser) {
        const { deviceName } = yield* panels.show({
          threadId,
          panel: input.panel,
          focusWindow,
          ...(input.sql === undefined ? {} : { sql: input.sql }),
        });
        return { panel: input.panel, shownOn: deviceName };
      }

      // Without a desktop the tab would never render; fail before creating it.
      if (!(yield* panels.hasDesktop))
        return yield* new AgentPanelUnavailableError({
          reason: "no_desktop",
          message:
            "No Conn desktop app is connected to this server, so nothing can show the browser. Ask the user to open Conn on their Mac.",
        });
      let tabId = input.tabId;
      const desktopHostsThisServer =
        (yield* ServerConfig.ServerConfig).desktopBrowserControlFd !== undefined;
      if (input.url && desktopHostsThisServer) {
        // The desktop bundling this server renders server tabs natively, and only those are
        // drivable here. The open pins this thread's current tab.
        const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
        const opened = yield* (yield* PreviewAutomationBroker.PreviewAutomationBroker).invoke<{
          readonly tabId?: PreviewTabId;
        }>({
          scope,
          operation: "open",
          input: {
            url: input.url,
            open: false,
            reuseExistingTab: false,
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
          },
        });
        const { deviceName } = yield* panels.show({
          threadId,
          panel: "browser",
          focusWindow,
          ...(opened.tabId === undefined ? {} : { tabId: opened.tabId }),
        });
        return {
          panel: input.panel,
          shownOn: deviceName,
          ...(opened.tabId === undefined ? {} : { tabId: opened.tabId }),
        };
      }
      if (input.url) {
        const manager = yield* Manager.PreviewManager;
        const snapshot = yield* manager
          .open({
            threadId,
            url: input.url,
            runtime: "desktop",
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
          })
          .pipe(Effect.mapError((error) => invalid(error.message)));
        tabId = snapshot.tabId;
      }
      const { deviceName } = yield* panels.show({
        threadId,
        panel: "browser",
        focusWindow,
        ...(tabId === undefined ? {} : { tabId }),
      });
      if (tabId === undefined) return { panel: input.panel, shownOn: deviceName };
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      yield* awaitHostedTab(scope, tabId);
      return { panel: input.panel, shownOn: deviceName, tabId };
    }),
  ),
});
