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
    "checks environment, epoch, thread, and desktop runtime before registering a host",
    () =>
      Effect.gen(function* () {
        const manager = yield* Manager.PreviewManager;
        const relay = yield* Relay.DesktopTabRelay;
        const tab = yield* manager.open({
          threadId,
          runtime: "desktop",
          url: "https://fixture.test",
        });
        const listed = yield* manager.list({ threadId });
        const binding = {
          environmentId,
          threadId,
          serverEpoch: listed.serverEpoch,
          tabId: tab.tabId,
          deviceName: "Fixture Mac",
        };
        for (const invalid of [
          { ...binding, environmentId: EnvironmentId.make("other-environment") },
          { ...binding, serverEpoch: "old-epoch" },
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
          shared: true,
          controlOwner: "unclaimed",
        });
        expect(
          (yield* Stream.runDrain(relay.requests("other-session", registered.connectionId)).pipe(
            Effect.flip,
          )).reason,
        ).toBe("session");
      }),
  );
});
