import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type AgentPanelRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AgentPanelBroker from "./AgentPanelBroker.ts";

const request = { threadId: ThreadId.make("thread-1"), panel: "mcp", focusWindow: true } as const;

/** A desktop that answers every request with `answer`. */
const desktop = (
  broker: AgentPanelBroker.AgentPanelBroker["Service"],
  deviceName: string,
  answer: (request: AgentPanelRequest) => { ok: boolean; error?: string } | null,
) =>
  broker.requests({ deviceName }).pipe(
    Stream.runForEach((received) => {
      const response = answer(received);
      return response === null
        ? Effect.void
        : broker.respond({ requestId: received.requestId, deviceName, ...response });
    }),
    Effect.forkChild({ startImmediately: true }),
  );

const layer = AgentPanelBroker.layer.pipe(Layer.provide(NodeServices.layer));

describe("AgentPanelBroker", () => {
  it.effect("fails at once when no desktop is connected", () =>
    Effect.gen(function* () {
      const broker = yield* AgentPanelBroker.AgentPanelBroker;
      const error = yield* Effect.flip(broker.show(request));
      assert.strictEqual(error.reason, "no_desktop");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers with the first desktop that shows the panel", () =>
    Effect.gen(function* () {
      const broker = yield* AgentPanelBroker.AgentPanelBroker;
      const seen: Array<AgentPanelRequest> = [];
      const old = yield* desktop(broker, "Old Conn", () => ({ ok: false, error: "No MCP panel." }));
      const mac = yield* desktop(broker, "Nick's Mac", (received) => {
        seen.push(received);
        return { ok: true };
      });
      assert.deepStrictEqual(yield* broker.show(request), { deviceName: "Nick's Mac" });
      assert.strictEqual(seen[0]?.panel, "mcp");
      yield* Fiber.interrupt(old);
      yield* Fiber.interrupt(mac);
      assert.isFalse(yield* broker.hasDesktop);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports the refusal when every desktop refuses", () =>
    Effect.gen(function* () {
      const broker = yield* AgentPanelBroker.AgentPanelBroker;
      yield* desktop(broker, "Old Conn", () => ({ ok: false, error: "No MCP panel." }));
      const error = yield* Effect.flip(broker.show(request));
      assert.deepStrictEqual([error.reason, error.message], ["rejected", "No MCP panel."]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("times out when no desktop answers", () =>
    Effect.gen(function* () {
      const broker = yield* AgentPanelBroker.AgentPanelBroker;
      yield* desktop(broker, "Silent", () => null);
      const shown = yield* broker.show(request, 1_000).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(1_000);
      assert.strictEqual((yield* Fiber.join(shown)).reason, "timeout");
    }).pipe(Effect.provide(layer)),
  );
});
