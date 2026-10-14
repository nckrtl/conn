import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Manager from "./Manager.ts";
import * as Relay from "./DesktopTabRelay.ts";
import * as Environment from "../environment/ServerEnvironment.ts";

const environmentId = EnvironmentId.make("fixture-environment");
const threadId = ThreadId.make("fixture-thread");
const layer = Relay.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Broker.layer, Manager.layer)),
  Layer.provide(
    Layer.mock(Environment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
  ),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("desktop tab relay bindings", (it) => {
  it.effect(
    "checks environment, thread, snapshot, and desktop runtime before registering a host",
    () =>
      Effect.gen(function* () {
        const manager = yield* Manager.PreviewManager;
        const relay = yield* Relay.DesktopTabRelay;
        const tab = yield* manager.open({
          threadId,
          url: "https://fixture.test",
        });
        const binding = {
          environmentId,
          threadId,
          snapshot: tab,
          tabId: tab.tabId,
          deviceName: "Fixture Mac",
        };
        for (const invalid of [
          { ...binding, environmentId: EnvironmentId.make("other-environment") },
          { ...binding, snapshot: { ...tab, tabId: "different-tab" } },
          { ...binding, threadId: ThreadId.make("other-thread") },
        ])
          expect((yield* relay.register("session", invalid).pipe(Effect.flip))._tag).toBe(
            "DesktopTabRelayError",
          );
        const serverTab = yield* manager.open({
          threadId,
          runtime: "server",
          url: "https://fixture.test",
        });
        expect(
          (yield* relay
            .register("session", { ...binding, tabId: serverTab.tabId })
            .pipe(Effect.flip))._tag,
        ).toBe("DesktopTabRelayError");
        const registered = yield* relay.register("session", binding);
        expect(registered.connectionId).toBeTruthy();
        expect((yield* relay.register("other-session", binding).pipe(Effect.flip)).reason).toBe(
          "conflict",
        );
        const result = yield* relay.list("session", { threadId });
        expect(result.sessions.find((session) => session.tabId === tab.tabId)).toMatchObject({
          host: "Fixture Mac",
          hostedHere: true,
        });
        expect(
          (yield* Stream.runDrain(relay.requests("other-session", registered.connectionId)).pipe(
            Effect.flip,
          )).reason,
        ).toBe("session");
      }),
  );
  it.effect("re-registers the same client-owned tab after the server loses its preview index", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restart-thread");
      const oldManager = yield* Manager.make.pipe(Effect.provide(NodeServices.layer));
      const tab = yield* oldManager.open({ threadId, url: "https://fixture.test" });
      const oldEpoch = (yield* oldManager.list({ threadId })).serverEpoch;
      const manager = yield* Manager.PreviewManager;
      const relay = yield* Relay.DesktopTabRelay;
      expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      const binding = {
        environmentId,
        threadId,
        tabId: tab.tabId,
        snapshot: tab,
        deviceName: "Fixture Mac",
      };
      yield* relay.register("reconnected-session", binding);
      const restored = yield* relay.list("reconnected-session", { threadId });
      expect(restored.serverEpoch).not.toBe(oldEpoch);
      expect(restored.sessions).toEqual([{ ...tab, host: "Fixture Mac", hostedHere: true }]);
      expect((yield* manager.list({ threadId: ThreadId.make("other-thread") })).sessions).toEqual(
        [],
      );
      const newTab = yield* manager.open({ threadId });
      expect(newTab.tabId).not.toBe(tab.tabId);
      expect(
        (yield* relay
          .register("other-session", {
            ...binding,
            threadId: ThreadId.make("other-thread"),
            snapshot: { ...tab, threadId: ThreadId.make("other-thread") },
          })
          .pipe(Effect.flip)).reason,
      ).toBe("binding");
    }),
  );
});
