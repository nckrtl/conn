import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { type PreviewAutomationStreamEvent, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcStreamCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPreviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const statusScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    desktopRegister: createEnvironmentRpcCommand(runtime, {
      label: "preview:desktop-register",
      tag: WS_METHODS.desktopTabRegister,
    }),
    desktopReport: createEnvironmentRpcCommand(runtime, {
      label: "preview:desktop-report",
      tag: WS_METHODS.desktopTabReport,
    }),
    desktopRespond: createEnvironmentRpcCommand(runtime, {
      label: "preview:desktop-respond",
      tag: WS_METHODS.desktopTabRespond,
    }),
    // A relay lease ends with its stream. Durable subscriptions would silently
    // reconnect a tab after the user granted only one connection's access.
    desktopRequests: createEnvironmentRpcStreamCommand(runtime, {
      label: "preview:desktop-requests",
      tag: WS_METHODS.desktopTabRequests,
      payload: (input: {
        connectionId: string;
        onEvent: (event: PreviewAutomationStreamEvent) => Promise<void>;
        signal: AbortSignal;
      }) => ({ connectionId: input.connectionId }),
      consume: (stream, input) => {
        const stopped = Effect.callback<void>((resume) => {
          if (input.signal.aborted) return resume(Effect.void);
          const abort = () => resume(Effect.void);
          input.signal.addEventListener("abort", abort, { once: true });
          return Effect.sync(() => input.signal.removeEventListener("abort", abort));
        });
        return stream.pipe(
          Stream.interruptWhen(stopped),
          Stream.runForEach((event) => Effect.promise(() => input.onEvent(event))),
        );
      },
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: WS_METHODS.previewList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: WS_METHODS.subscribePreviewEvents,
    }),
    discoveredServers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:discovered-servers",
      tag: WS_METHODS.subscribeDiscoveredLocalServers,
      // Configured URLs are part of this atom's key. Dispose immediately so
      // unmounted projects stop contributing probe candidates on the server.
      idleTtlMs: 0,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: WS_METHODS.previewOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:navigate",
      tag: WS_METHODS.previewNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:resize",
      tag: WS_METHODS.previewResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    adjust: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:adjust",
      tag: WS_METHODS.previewAdjust,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:refresh",
      tag: WS_METHODS.previewRefresh,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: WS_METHODS.previewClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    clearProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:clear-profile",
      tag: WS_METHODS.previewClearProfile,
    }),
    reportProfiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-profiles",
      tag: WS_METHODS.previewReportProfiles,
      concurrency: { mode: "latest", key: ({ environmentId }) => environmentId },
    }),
    reportStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: WS_METHODS.previewReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
  };
}
