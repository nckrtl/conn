import { newOrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orbitFirstTurnInput } from "./orbitThreadTurn";

describe("orbitFirstTurnInput", () => {
  it("queues the first message in a new thread of the clone's workspace project", () => {
    const start = newOrbitThreadStart({
      id: "s1",
      project: { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" },
      message: "Fix the login bug",
      suffix: "k3j9",
      threadId: "thread-1",
      messageId: "message-1",
      now: 0,
    });
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

    const input = orbitFirstTurnInput({
      start,
      projectId: ProjectId.make("project-1"),
      modelSelection,
      createdAt: "2026-11-10T08:00:00.000Z",
    });

    expect(input).toMatchObject({
      threadId: "thread-1",
      message: { messageId: "message-1", role: "user", text: "Fix the login bug", attachments: [] },
      dispatchMode: "queue",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Fix the login bug",
          modelSelection,
          branch: null,
          worktreePath: null,
        },
      },
    });
  });
});
