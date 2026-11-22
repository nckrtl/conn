import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FIRST_MESSAGE_ATTEMPT_MS,
  FIRST_MESSAGE_PHASE_MS,
  orbitFirstTurnInput,
  sendOrbitFirstMessage,
  type OrbitFirstMessageAttempt,
  type OrbitFirstMessagePorts,
} from "./threadTurn.ts";
import { newOrbitThreadStart } from "./threadStart.ts";

const start = {
  ...newOrbitThreadStart({
    id: "s1",
    project: { id: 3, slug: "mealou", nodeName: "beast" },
    message: "Fix the login bug",
    suffix: "k3j9",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
  }),
  environmentId: "env-41",
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const projectId = ProjectId.make("project-1");

function ports(results: Array<{ ok: true } | { ok: false; error: unknown }>) {
  const launches: Array<ReturnType<typeof orbitFirstTurnInput>> = [];
  const value: OrbitFirstMessagePorts = {
    waitForClone: async () => ({ projectId, modelSelection }),
    startTurn: async (_environmentId, input, _deadline) => {
      launches.push(input);
      return results.shift() ?? { ok: true };
    },
    now: () => "2026-11-10T08:00:00.000Z",
    stopped: () => false,
  };
  return { launches, ports: value };
}

describe("orbitFirstTurnInput", () => {
  it("launches a new thread with the first message in the clone's workspace project", () => {
    expect(
      orbitFirstTurnInput({ start, projectId, modelSelection, createdAt: "2026-11-10T08:00:00Z" }),
    ).toMatchObject({
      commandId: "command-1",
      threadId: "thread-1",
      message: { messageId: "message-1", role: "user", text: "Fix the login bug", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Fix the login bug",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      },
    });
  });

  it("uses the model and modes the start carries over the clone's defaults", async () => {
    const carried = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
    const v2 = {
      ...start,
      modelSelection: carried,
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const { launches, ports: run } = ports([]);
    // The carried model is enough even when the clone's server names none yet.
    const noDefault = { ...run, waitForClone: async () => ({ projectId, modelSelection: null }) };

    await expect(sendOrbitFirstMessage(v2, noDefault)).resolves.toBe(projectId);
    expect(launches[0]).toMatchObject({
      modelSelection: carried,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      bootstrap: {
        createThread: {
          modelSelection: carried,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      },
    });
  });
});

describe("sendOrbitFirstMessage", () => {
  it("repeats the same launch command after a dispatch that failed, so the server finishes it", async () => {
    // The thread is created, then the message dispatch fails: the launch is not sent yet.
    const { launches, ports: run } = ports([
      { ok: false, error: new Error("socket closed") },
      { ok: true },
    ]);

    await expect(sendOrbitFirstMessage(start, run)).rejects.toThrow("socket closed");
    // Retry, or a resume after a reload.
    await expect(sendOrbitFirstMessage(start, run)).resolves.toBe(projectId);

    expect(launches.map((launch) => launch.commandId)).toEqual(["command-1", "command-1"]);
  });

  /**
   * A clone server for the resend cases: `send` answers each send in turn, and the connection
   * moves as the test says. Every wait records the session generation it asked for.
   */
  function reloading(options: {
    readonly connection: { connected: boolean; generation: number };
    readonly send: (attempt: number) => OrbitFirstMessageAttempt;
    readonly reconnectTo?: { connected: boolean; generation: number };
    readonly clock?: () => number;
  }) {
    let connection = options.connection;
    const { launches, ports: base } = ports([]);
    const asked: number[] = [];
    const limits: number[] = [];
    const run: OrbitFirstMessagePorts = {
      ...base,
      startTurn: async (environmentId, input, deadline) => {
        limits.push(deadline - (options.clock?.() ?? 0));
        await base.startTurn(environmentId, input, deadline);
        return options.send(launches.length);
      },
      connection: () => connection,
      waitForConnection: async (_environmentId, minGeneration) => {
        asked.push(minGeneration);
        connection = options.reconnectTo ?? { connected: true, generation: minGeneration };
        return connection.connected && connection.generation >= minGeneration;
      },
      clock: options.clock ?? (() => 0),
    };
    return { launches, asked, limits, run };
  }
  const notConnected = { _tag: "EnvironmentRpcUnavailableError", message: "not connected" };

  it("resends a launch lost while its session is torn down, though it still reads connected", async () => {
    // The supervisor drops the RPC session before it publishes the disconnect.
    const { launches, asked, limits, run } = reloading({
      connection: { connected: true, generation: 1 },
      send: (attempt) => (attempt > 1 ? { ok: true } : { ok: false, error: notConnected }),
    });

    await expect(sendOrbitFirstMessage(start, run)).resolves.toBe(projectId);
    expect(launches.map((launch) => launch.commandId)).toEqual(["command-1", "command-1"]);
    // Only a session newer than the one that lost the send takes the resend.
    expect(asked).toEqual([2]);
    expect(limits).toEqual([FIRST_MESSAGE_ATTEMPT_MS, FIRST_MESSAGE_ATTEMPT_MS]);
  });

  it("resends a launch made during a reconnect on the session that reconnect brings up", async () => {
    // Session 1 is closed and the supervisor connects session 2: a send now has no session.
    const { launches, asked, run } = reloading({
      connection: { connected: false, generation: 2 },
      send: (attempt) => (attempt > 1 ? { ok: true } : { ok: false, error: notConnected }),
      reconnectTo: { connected: true, generation: 2 },
    });

    await expect(sendOrbitFirstMessage(start, run)).resolves.toBe(projectId);
    expect(launches).toHaveLength(2);
    expect(asked).toEqual([0]);
  });

  it("sends again after a send that was cancelled at its limit, on any session", async () => {
    const { launches, asked, run } = reloading({
      connection: { connected: true, generation: 1 },
      send: (attempt) =>
        attempt > 1 ? { ok: true } : { ok: false, error: new Error("timed out"), unanswered: true },
    });

    await expect(sendOrbitFirstMessage(start, run)).resolves.toBe(projectId);
    expect(launches.map((launch) => launch.commandId)).toEqual(["command-1", "command-1"]);
    expect(asked).toEqual([0]);
  });

  it("fails once the start's deadline passes, with no send left waiting, and claims no refusal", async () => {
    let now = 0;
    const { launches, limits, run } = reloading({
      connection: { connected: true, generation: 1 },
      clock: () => now,
      send: () => {
        // Each send is cancelled at its deadline.
        now += FIRST_MESSAGE_ATTEMPT_MS;
        return { ok: false, error: new Error("timed out"), unanswered: true };
      },
    });

    const failed = sendOrbitFirstMessage(start, run);
    await expect(failed).rejects.toThrow("did not confirm the first message in time");
    await expect(failed).rejects.not.toThrow("did not take");
    // Six sends of 20 s fill the 120 s of the start.
    expect(limits).toEqual(Array.from({ length: 6 }, () => FIRST_MESSAGE_ATTEMPT_MS));
    expect(launches).toHaveLength(6);
  });

  it("gives the send only what the clone's readiness left of the start's time", async () => {
    let now = 0;
    const deadlines: number[] = [];
    const { ports: base } = ports([]);
    const run: OrbitFirstMessagePorts = {
      ...base,
      clock: () => now,
      waitForClone: async (_environmentId, timeoutMs) => {
        expect(timeoutMs).toBe(FIRST_MESSAGE_PHASE_MS);
        now += 110_000;
        return { projectId, modelSelection };
      },
      startTurn: async (_environmentId, _input, deadline) => {
        deadlines.push(deadline);
        return { ok: true };
      },
    };

    await expect(sendOrbitFirstMessage(start, run)).resolves.toBe(projectId);
    expect(deadlines).toEqual([FIRST_MESSAGE_PHASE_MS]);
  });

  it("never counts a refused launch as sent, and does not resend it on a steady session", async () => {
    const { launches, ports: run } = ports([
      { ok: false, error: new Error("Thread thread-1 already exists") },
    ]);
    const steady = {
      ...run,
      connection: () => ({ connected: true, generation: 1 }),
      waitForConnection: async () => true,
    };

    await expect(sendOrbitFirstMessage(start, steady)).rejects.toThrow("did not take");
    expect(launches).toHaveLength(1);
  });

  it("sends nothing once the start was dismissed", async () => {
    const { launches, ports: run } = ports([]);

    await expect(sendOrbitFirstMessage(start, { ...run, stopped: () => true })).rejects.toThrow(
      "stopped",
    );
    expect(launches).toEqual([]);
  });

  it("stops when the clone's workspace project does not appear", async () => {
    const { launches, ports: run } = ports([]);
    const missing = { ...run, waitForClone: async () => null };

    await expect(sendOrbitFirstMessage(start, missing)).rejects.toThrow("/srv/workspace");
    expect(launches).toEqual([]);
  });

  it("falls back to the clone's default when the clone lacks the start's provider", async () => {
    const carried = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
    const { launches, ports: run } = ports([]);
    const fallbacks: unknown[] = [];
    const lacking = {
      ...run,
      waitForClone: async () => ({
        projectId,
        modelSelection,
        offers: (selection: { instanceId: string }) => selection.instanceId === "codex",
      }),
      onModelFallback: (fallback: unknown) => fallbacks.push(fallback),
    };

    await expect(
      sendOrbitFirstMessage({ ...start, modelSelection: carried }, lacking),
    ).resolves.toBe(projectId);
    expect(launches[0]).toMatchObject({
      modelSelection,
      bootstrap: { createThread: { modelSelection } },
    });
    expect(fallbacks).toEqual([{ requestedModel: "opus", usedModel: "gpt-5" }]);
  });

  it("keeps the start's model when the clone offers it", async () => {
    const carried = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
    const { launches, ports: run } = ports([]);
    const fallbacks: unknown[] = [];
    const offering = {
      ...run,
      waitForClone: async () => ({ projectId, modelSelection, offers: () => true }),
      onModelFallback: (fallback: unknown) => fallbacks.push(fallback),
    };
    await sendOrbitFirstMessage({ ...start, modelSelection: carried }, offering);
    expect(launches[0]).toMatchObject({ modelSelection: carried });
    expect(fallbacks).toEqual([]);
  });
});
