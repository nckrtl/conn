import {
  DesktopTabRelayError,
  type DesktopTabBinding,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type PreviewListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Manager from "./Manager.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export class DesktopTabRelay extends Context.Service<
  DesktopTabRelay,
  {
    readonly register: (
      sessionId: string,
      binding: DesktopTabBinding,
    ) => Effect.Effect<{ connectionId: string }, DesktopTabRelayError>;
    readonly requests: (
      sessionId: string,
      connectionId: string,
    ) => Stream.Stream<PreviewAutomationStreamEvent, DesktopTabRelayError>;
    readonly respond: (
      sessionId: string,
      response: PreviewAutomationResponse,
    ) => ReturnType<Broker.PreviewAutomationBroker["Service"]["respondDesktop"]>;
    readonly list: (
      sessionId: string,
      input: PreviewListInput,
    ) => ReturnType<Manager.PreviewManager["Service"]["list"]>;
  }
>()("t3/preview/DesktopTabRelay") {}

const make = Effect.gen(function* () {
  const broker = yield* Broker.PreviewAutomationBroker;
  const manager = yield* Manager.PreviewManager;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const register = Effect.fn("DesktopTabRelay.register")(function* (
    sessionId: string,
    binding: DesktopTabBinding,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    if (
      binding.environmentId !== environmentId ||
      binding.snapshot.threadId !== binding.threadId ||
      binding.snapshot.tabId !== binding.tabId ||
      !(yield* manager.restoreDesktop(binding.snapshot))
    )
      return yield* new DesktopTabRelayError({ reason: "binding" });
    return yield* broker.registerDesktop(sessionId, binding);
  });
  const list = Effect.fn("DesktopTabRelay.list")(function* (
    sessionId: string,
    input: PreviewListInput,
  ) {
    const listed = yield* manager.list(input);
    const hosted = yield* broker.desktopTabs(
      yield* environment.getEnvironmentId,
      input.threadId,
      sessionId,
    );
    return {
      ...listed,
      sessions: listed.sessions.map((tab) => {
        const host = hosted.find((candidate) => candidate.tabId === tab.tabId);
        return host
          ? {
              ...tab,
              host: host.host,
              hostedHere: host.hostedHere,
            }
          : tab.runtime === "desktop"
            ? { ...tab, host: undefined, hostedHere: true }
            : tab;
      }),
    };
  });
  return DesktopTabRelay.of({
    register,
    requests: broker.desktopRequests,
    respond: broker.respondDesktop,
    list,
  });
});
export const layer = Layer.effect(DesktopTabRelay, make);
