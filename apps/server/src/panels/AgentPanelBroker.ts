import {
  AgentPanelUnavailableError,
  type AgentPanelDatabaseResult,
  type AgentPanelMcpResult,
  type AgentPanelRequest,
  type AgentPanelResponse,
  type AgentPanelSubscribeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const DEFAULT_SHOW_TIMEOUT_MS = 15_000;

interface Subscriber {
  readonly deviceName: string;
  readonly offer: (request: AgentPanelRequest) => Effect.Effect<boolean>;
}

interface Pending {
  readonly deferred: Deferred.Deferred<AgentPanelResponse>;
  remaining: number;
}

export interface AgentPanelShown {
  readonly deviceName: string;
  readonly database?: AgentPanelDatabaseResult;
  readonly mcp?: AgentPanelMcpResult;
}

/**
 * Delivers agent requests to show a panel to every Conn desktop connected to this
 * server. The first desktop that shows it answers the agent.
 */
export class AgentPanelBroker extends Context.Service<
  AgentPanelBroker,
  {
    readonly requests: (input: AgentPanelSubscribeInput) => Stream.Stream<AgentPanelRequest>;
    readonly respond: (response: AgentPanelResponse) => Effect.Effect<void>;
    readonly hasDesktop: Effect.Effect<boolean>;
    readonly show: (
      request: Omit<AgentPanelRequest, "requestId">,
      timeoutMs?: number,
    ) => Effect.Effect<AgentPanelShown, AgentPanelUnavailableError>;
  }
>()("t3/panels/AgentPanelBroker") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const subscribers = new Map<number, Subscriber>();
  const pending = new Map<string, Pending>();
  let nextSubscriberId = 0;

  // Registers when the stream starts, in the subscriber's fiber, so `show` sees it at once.
  const requests = (input: AgentPanelSubscribeInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<AgentPanelRequest>();
        const id = nextSubscriberId++;
        subscribers.set(id, {
          deviceName: input.deviceName ?? "Conn desktop",
          offer: (request) => Queue.offer(queue, request),
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => subscribers.delete(id)));
        return Stream.fromQueue(queue);
      }),
    );

  const respond = Effect.fn("AgentPanelBroker.respond")(function* (response: AgentPanelResponse) {
    const entry = pending.get(response.requestId);
    if (!entry) return;
    if (response.ok) {
      yield* Deferred.succeed(entry.deferred, response);
      return;
    }
    entry.remaining -= 1;
    if (entry.remaining <= 0) yield* Deferred.succeed(entry.deferred, response);
  });

  const show = Effect.fn("AgentPanelBroker.show")(function* (
    request: Omit<AgentPanelRequest, "requestId">,
    timeoutMs: number = DEFAULT_SHOW_TIMEOUT_MS,
  ): Effect.fn.Return<AgentPanelShown, AgentPanelUnavailableError> {
    const targets = [...subscribers.values()];
    if (targets.length === 0)
      return yield* new AgentPanelUnavailableError({
        reason: "no_desktop",
        message:
          "No Conn desktop app is connected to this server, so nothing can show the panel. Ask the user to open Conn on their Mac.",
      });
    const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const deferred = yield* Deferred.make<AgentPanelResponse>();
    pending.set(requestId, { deferred, remaining: targets.length });
    const answer = yield* Effect.gen(function* () {
      yield* Effect.forEach(targets, (target) => target.offer({ ...request, requestId }), {
        discard: true,
      });
      return yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
    if (Option.isNone(answer))
      return yield* new AgentPanelUnavailableError({
        reason: "timeout",
        message: `No Conn desktop showed the ${request.panel} panel within ${timeoutMs / 1000} s.`,
      });
    if (!answer.value.ok)
      return yield* new AgentPanelUnavailableError({
        reason: "rejected",
        message: answer.value.error ?? `Conn could not show the ${request.panel} panel.`,
      });
    const { database, mcp } = answer.value;
    return {
      deviceName: answer.value.deviceName ?? "Conn desktop",
      ...(database === undefined ? {} : { database }),
      ...(mcp === undefined ? {} : { mcp }),
    };
  });

  return AgentPanelBroker.of({
    requests,
    respond,
    hasDesktop: Effect.sync(() => subscribers.size > 0),
    show,
  });
});

export const layer = Layer.effect(AgentPanelBroker, make);
