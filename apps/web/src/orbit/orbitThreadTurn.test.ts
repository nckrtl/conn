import { newOrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orbitFirstTurnInput,
  sendOrbitFirstMessage,
  type OrbitFirstMessagePorts,
} from "./orbitThreadTurn";

const start = {
  ...newOrbitThreadStart({
    id: "s1",
    project: { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" },
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
    startTurn: async (_environmentId, input) => {
      launches.push(input);
      return results.shift() ?? { ok: true };
    },
    now: () => "2026-11-10T08:00:00.000Z",
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
      bootstrap: {
        createThread: { projectId: "project-1", title: "Fix the login bug", modelSelection },
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
    await sendOrbitFirstMessage(start, run);

    expect(launches.map((launch) => launch.commandId)).toEqual(["command-1", "command-1"]);
  });

  it("never counts a refused launch as sent", async () => {
    const { ports: run } = ports([
      { ok: false, error: new Error("Thread thread-1 already exists") },
    ]);

    await expect(sendOrbitFirstMessage(start, run)).rejects.toThrow("did not take");
  });

  it("stops when the clone's workspace project does not appear", async () => {
    const { launches, ports: run } = ports([]);
    const missing = { ...run, waitForClone: async () => null };

    await expect(sendOrbitFirstMessage(start, missing)).rejects.toThrow("/srv/workspace");
    expect(launches).toEqual([]);
  });
});
