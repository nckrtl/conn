import type {
  DesktopTabBinding,
  DesktopTabReport,
  PreviewAutomationResponse,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "./atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import * as Option from "effect/Option";
import { previewEnvironment } from "~/state/preview";
import { previewBridge } from "~/components/preview/previewBridge";

interface SharedTab {
  readonly binding: DesktopTabBinding;
  readonly connectionId: string;
  readonly unsubscribe: () => void;
  readonly closed: Promise<void>;
  report: DesktopTabReport;
}
const tabs = new Map<string, SharedTab>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export const desktopTabSharing = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get(runtimeTabId: string) {
    return tabs.get(runtimeTabId)?.report ?? null;
  },
  async stop(runtimeTabId: string) {
    const tab = tabs.get(runtimeTabId);
    tabs.delete(runtimeTabId);
    tab?.unsubscribe();
    changed();
    await previewBridge?.stopSharingTab?.(runtimeTabId);
    await tab?.closed;
  },
  async share(binding: DesktopTabBinding, runtimeTabId: string) {
    if (!previewBridge?.handoverTab || !previewBridge.executeTabRequest)
      throw new Error("Desktop tab relay is unavailable.");
    await this.stop(runtimeTabId);
    binding = { ...binding, deviceName: (await previewBridge.getHostDeviceName?.()) ?? "desktop" };
    const registration = await runAtomCommand(appAtomRegistry, previewEnvironment.desktopRegister, {
      environmentId: binding.environmentId,
      input: binding,
    });
    if (!AsyncResult.isSuccess(registration)) return;
    const { connectionId } = registration.value;
    // Subscribe before setup, but deliver only after the local endpoint is ready.
    let ready = false;
    const requests: import("@t3tools/contracts").PreviewAutomationRequest[] = [];
    const deliver = async (request: import("@t3tools/contracts").PreviewAutomationRequest) => {
      if (tabs.get(runtimeTabId)?.connectionId !== connectionId) return;
      let response: PreviewAutomationResponse;
      try {
        response = await previewBridge!.executeTabRequest!(runtimeTabId, connectionId, request);
      } catch {
        response = {
          clientId: "desktop",
          connectionId,
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message: "Desktop tab is unavailable.",
          },
        };
      }
      if (tabs.get(runtimeTabId)?.connectionId !== connectionId) return;
      await runAtomCommand(appAtomRegistry, previewEnvironment.desktopRespond, {
        environmentId: binding.environmentId,
        input: response,
      });
    };
    const streamAbort = new AbortController();
    let finished!: () => void;
    const closed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const connectionAtom = environmentCatalog.stateAtom(binding.environmentId);
    const stopWatching = appAtomRegistry.subscribe(connectionAtom, () => {
      const connected = Option.exists(
        AsyncResult.value(appAtomRegistry.get(connectionAtom)),
        (state) => state.phase === "connected",
      );
      if (!connected) void this.stop(runtimeTabId);
    });
    tabs.set(runtimeTabId, {
      binding,
      connectionId,
      closed,
      unsubscribe: () => {
        streamAbort.abort();
        stopWatching();
      },
      report: {
        connectionId,
        shared: true,
        owner: "unclaimed",
        generation: 0,
        url: null,
        title: null,
      },
    });
    void runAtomCommand(appAtomRegistry, previewEnvironment.desktopRequests, {
      environmentId: binding.environmentId,
      input: {
        connectionId,
        signal: streamAbort.signal,
        onEvent: async (event) => {
          if (event.type !== "request" || event.connectionId !== connectionId) return;
          if (ready) await deliver(event.request);
          else requests.push(event.request);
        },
      },
    }).then(() => {
      finished();
      if (tabs.get(runtimeTabId)?.connectionId === connectionId) void this.stop(runtimeTabId);
    });
    try {
      await previewBridge.handoverTab({ binding, runtimeTabId, connectionId });
      if (tabs.get(runtimeTabId)?.connectionId !== connectionId) {
        await previewBridge.stopSharingTab?.(runtimeTabId);
        return;
      }
      ready = true;
      for (const request of requests) void deliver(request);
      changed();
    } catch (error) {
      await this.stop(runtimeTabId);
      throw error;
    }
  },
};

previewBridge?.onTabSharingChange?.((runtimeTabId, report) => {
  const tab = tabs.get(runtimeTabId);
  if (!tab || tab.connectionId !== report.connectionId) return;
  tab.report = report;
  changed();
  void runAtomCommand(appAtomRegistry, previewEnvironment.desktopReport, {
    environmentId: tab.binding.environmentId,
    input: report,
  }).then(() => {
    if (!report.shared && tabs.get(runtimeTabId) === tab) void desktopTabSharing.stop(runtimeTabId);
  });
});
