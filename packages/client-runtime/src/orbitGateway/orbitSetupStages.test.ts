import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation } from "./client.ts";
import { orbitSetupStages } from "./orbitSetupStages.ts";
import { newOrbitThreadStart, type OrbitThreadStart } from "./threadStart.ts";

const project = { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" };
const base = newOrbitThreadStart({
  id: "s1",
  project,
  message: "Fix the login bug",
  suffix: "k3j9",
  threadId: "thread-1",
  messageId: "message-1",
  commandId: "command-1",
  now: 0,
  instanceName: "fix-login",
});
const creating = { ...base, createStartedAt: 10, createOperationId: 100, instanceId: 41 };
const created = { ...creating, environmentId: "env-41", createFinishedAt: 40 };
const pairing = { ...created, connectStartedAt: 41, pairingOperationId: 200 };
const connected = { ...pairing, connected: true, connectFinishedAt: 50, agentStartedAt: 51 };

function createOp(
  status: OrbitGatewayOperation["status"],
  progress: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation {
  return {
    id: 100,
    kind: "instance.create",
    status,
    targetId: 41,
    errorCode: null,
    pollAfterSeconds: 2,
    ...progress,
  };
}

/** Each stage as `id:status`, with the create stage's sub-detail and a failed stage's code. */
function summary(start: OrbitThreadStart, create: OrbitGatewayOperation | null = null): string[] {
  return orbitSetupStages({ start, create }).map((stage) =>
    [`${stage.id}:${stage.status}`, stage.subDetail, stage.errorCode].filter(Boolean).join(" "),
  );
}

describe("orbitSetupStages", () => {
  it.each<[string, OrbitThreadStart, OrbitGatewayOperation | null, string[]]>([
    ["saved, not run yet", base, null, ["create:pending", "connect:pending", "agent:pending"]],
    [
      "create queued",
      creating,
      createOp("queued"),
      ["create:running", "connect:pending", "agent:pending"],
    ],
    [
      "clone-container",
      creating,
      createOp("running", { currentStep: "clone-container" }),
      ["create:running Copying the container", "connect:pending", "agent:pending"],
    ],
    [
      "clone-workspace",
      creating,
      createOp("running", { currentStep: "clone-workspace" }),
      ["create:running Copying the workspace", "connect:pending", "agent:pending"],
    ],
    [
      "clone-t3, from the running step when current_step is absent",
      creating,
      createOp("running", {
        steps: [
          {
            name: "clone-workspace",
            job: "clone",
            status: "succeeded",
            startedAt: null,
            finishedAt: null,
          },
          { name: "clone-t3", job: "clone", status: "running", startedAt: null, finishedAt: null },
        ],
      }),
      ["create:running Starting the T3 server", "connect:pending", "agent:pending"],
    ],
    [
      "clone-register",
      creating,
      createOp("running", { currentStep: "clone-register" }),
      ["create:running Registering with Orbit", "connect:pending", "agent:pending"],
    ],
    [
      "an unknown step",
      creating,
      createOp("running", { currentStep: "clone-sessions" }),
      ["create:running", "connect:pending", "agent:pending"],
    ],
    [
      "a prototype key as step name",
      creating,
      createOp("running", { currentStep: "constructor" }),
      ["create:running", "connect:pending", "agent:pending"],
    ],
    [
      "failed step",
      {
        ...base,
        createStartedAt: 10,
        error: "Orbit could not create the clone.",
        errorCode: "instance.t3_unready",
      },
      createOp("failed", { failedStep: "clone-t3", errorCode: "instance.t3_unready" }),
      [
        "create:failed Starting the T3 server instance.t3_unready",
        "connect:pending",
        "agent:pending",
      ],
    ],
    [
      "name taken",
      {
        ...base,
        createStartedAt: 10,
        error: "The name is taken.",
        errorCode: "instance.name_taken",
      },
      null,
      ["create:failed instance.name_taken", "connect:pending", "agent:pending"],
    ],
    [
      "a Retry while the last read still shows the failed create",
      creating,
      createOp("failed", { failedStep: "clone-t3" }),
      ["create:running", "connect:pending", "agent:pending"],
    ],
    [
      "pairing",
      pairing,
      createOp("succeeded"),
      ["create:done", "connect:running", "agent:pending"],
    ],
    [
      "pairing failed",
      { ...pairing, error: "Orbit could not pair.", errorCode: "conn.server_unreachable" },
      null,
      ["create:done", "connect:failed conn.server_unreachable", "agent:pending"],
    ],
    ["connected", connected, null, ["create:done", "connect:done", "agent:running"]],
    [
      "the launch failed",
      { ...connected, error: "The clone did not take the first message." },
      null,
      ["create:done", "connect:done", "agent:failed"],
    ],
    ["sent", { ...connected, sentAt: 60 }, null, ["create:done", "connect:done", "agent:done"]],
    [
      "an old row mid-create, without stage times",
      { ...base, createOperationId: 100, instanceId: 41 },
      null,
      ["create:running", "connect:pending", "agent:pending"],
    ],
  ])("maps %s", (_name, start, create, expected) => {
    expect(summary(start, create)).toEqual(expected);
  });

  it("gives the create stage its Node and every stage its times", () => {
    expect(orbitSetupStages({ start: { ...connected, sentAt: 60 } })).toEqual([
      {
        id: "create",
        status: "done",
        startedAt: 10,
        finishedAt: 40,
        detail: "beast",
        subDetail: null,
        error: null,
        errorCode: null,
      },
      {
        id: "connect",
        status: "done",
        startedAt: 41,
        finishedAt: 50,
        detail: null,
        subDetail: null,
        error: null,
        errorCode: null,
      },
      {
        id: "agent",
        status: "done",
        startedAt: 51,
        finishedAt: 60,
        detail: null,
        subDetail: null,
        error: null,
        errorCode: null,
      },
    ]);
  });

  it("shows only Connect and Start agent for an existing Instance", () => {
    const existing = newOrbitThreadStart({
      id: "s2",
      project,
      message: "Add a dark mode",
      suffix: "unused",
      threadId: "thread-2",
      messageId: "message-2",
      commandId: "command-2",
      now: 0,
      existing: { instanceId: 41, environmentId: "env-41", name: "dark-mode", nodeName: "beast" },
    });
    expect(summary(existing)).toEqual(["connect:running", "agent:pending"]);
    expect(summary({ ...existing, connected: true })).toEqual(["connect:done", "agent:running"]);
    expect(
      summary({ ...existing, error: "Pairing expired.", errorCode: "operation.timeout" }),
    ).toEqual(["connect:failed operation.timeout", "agent:pending"]);
  });
});
