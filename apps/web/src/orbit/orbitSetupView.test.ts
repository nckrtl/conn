import {
  newOrbitThreadStart,
  type OrbitGatewayOperation,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { orbitReadyView, orbitSetupView } from "./orbitSetupView";

const fresh = newOrbitThreadStart({
  id: "s1",
  project: { id: 66, slug: "create-bench", nodeName: "beast" },
  message: "List the files",
  suffix: "x",
  threadId: "thread-1",
  messageId: "message-1",
  commandId: "command-1",
  now: 0,
  instanceName: "pricing-page",
  pendingThread: true,
});
const creating = {
  ...fresh,
  createStartedAt: 1_000,
  createKey: "k",
  createOperationId: 100,
  instanceId: 41,
};
const pairing = {
  ...creating,
  environmentId: "env-41",
  createFinishedAt: 9_000,
  connectStartedAt: 9_000,
};
const sent = {
  ...pairing,
  connected: true,
  connectFinishedAt: 11_000,
  agentStartedAt: 11_000,
  sentAt: 13_000,
};
const existing = {
  ...newOrbitThreadStart({
    id: "s2",
    project: { id: 66, slug: "create-bench", nodeName: "beast" },
    message: "List the files",
    suffix: "x",
    threadId: "thread-2",
    messageId: "message-2",
    commandId: "command-2",
    now: 0,
    existing: { instanceId: 7, environmentId: "env-7", name: "checkout", nodeName: "beast" },
  }),
};

const op = (progress: Partial<OrbitGatewayOperation>): OrbitGatewayOperation => ({
  id: 100,
  kind: "instance.create",
  status: "running",
  targetId: 41,
  errorCode: null,
  pollAfterSeconds: 2,
  ...progress,
});

/** Each card row as `label:status`, plus the Node and the clone step where shown. */
function rows(start: OrbitThreadStart, create: OrbitGatewayOperation | null = null) {
  return orbitSetupView(start, create).stages.map((stage) =>
    [`${stage.label}:${stage.status}`, stage.detail, stage.subDetail].filter(Boolean).join(" "),
  );
}

describe("orbitSetupView", () => {
  it.each<[string, OrbitThreadStart, OrbitGatewayOperation | null, string[]]>([
    [
      "new, saved",
      fresh,
      null,
      ["Create Instance:pending beast", "Connect:pending", "Start agent:pending"],
    ],
    [
      "new, create running with empty steps[]",
      creating,
      op({ steps: [], currentStep: "clone-workspace" }),
      [
        "Create Instance:running beast Copying the workspace",
        "Connect:pending",
        "Start agent:pending",
      ],
    ],
    [
      "new, create running with filled steps[] and no current step",
      creating,
      op({
        steps: [
          {
            name: "clone-container",
            job: "clone",
            status: "succeeded",
            startedAt: null,
            finishedAt: null,
          },
          { name: "clone-t3", job: "clone", status: "running", startedAt: null, finishedAt: null },
        ],
      }),
      [
        "Create Instance:running beast Starting the T3 server",
        "Connect:pending",
        "Start agent:pending",
      ],
    ],
    [
      "new, unknown step gives no sub-detail",
      creating,
      op({ currentStep: "clone-sessions" }),
      ["Create Instance:running beast", "Connect:pending", "Start agent:pending"],
    ],
    [
      "new, connecting",
      pairing,
      null,
      ["Create Instance:done beast", "Connect:running", "Start agent:pending"],
    ],
    ["new, done", sent, null, ["Create Instance:done beast", "Connect:done", "Start agent:done"]],
    [
      "new, create failed",
      { ...creating, error: "Orbit could not create the clone.", errorCode: "instance.t3_unready" },
      op({ status: "failed", failedStep: "clone-t3" }),
      [
        "Create Instance:failed beast Starting the T3 server",
        "Connect:pending",
        "Start agent:pending",
      ],
    ],
    ["existing, saved", existing, null, ["Connect:pending", "Start agent:pending"]],
    [
      "existing, done",
      { ...existing, connected: true, connectStartedAt: 1, sentAt: 2 },
      null,
      ["Connect:done", "Start agent:done"],
    ],
  ])("%s", (_name, start, create, expected) => {
    expect(rows(start, create)).toEqual(expected);
  });

  it("offers Change name only for a taken name, and says the Instance stays only when one was made", () => {
    const taken = {
      ...fresh,
      error: "The name is taken.",
      errorCode: "instance.name_taken",
      createStartedAt: 1,
    };
    expect(orbitSetupView(taken)).toMatchObject({
      phase: "failed",
      canChangeName: true,
      instanceStays: false,
    });
    const afterCreate = {
      ...pairing,
      error: "Orbit could not pair.",
      errorCode: "conn.unreachable",
    };
    expect(orbitSetupView(afterCreate)).toMatchObject({
      canChangeName: false,
      instanceStays: true,
    });
    const existingFailed = {
      ...existing,
      error: "Orbit could not pair.",
      errorCode: "instance.name_taken",
    };
    expect(orbitSetupView(existingFailed)).toMatchObject({
      canChangeName: false,
      instanceStays: false,
    });
  });
});

describe("orbitReadyView", () => {
  it("times the setup from the create to the sent message and builds Conn's ready line", () => {
    expect(orbitReadyView(sent, "https://pricing-page.nckrtl.test")).toEqual({
      readyMs: 12_000,
      instanceName: "pricing-page",
      nodeName: "beast",
      url: "https://pricing-page.nckrtl.test",
      readyLine:
        "Your Instance is ready. You can preview it at https://pricing-page.nckrtl.test while I work on your request.",
      modelFallbackLine: null,
    });
    expect(orbitReadyView(sent, null).readyLine).toBe("Your Instance is ready.");
  });

  it("says when the agent uses the clone's default model", () => {
    const fallback = {
      ...sent,
      modelFallback: { requestedModel: "claude-opus-5-5", usedModel: "gpt-5.5" },
    };
    expect(orbitReadyView(fallback, null).modelFallbackLine).toBe(
      "This Instance does not offer claude-opus-5-5, so the agent uses gpt-5.5.",
    );
  });
});
