import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayOperation } from "./client.ts";
import { orbitSetupReadyMs, orbitSetupStages } from "./orbitSetupStages.ts";
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

/** Each stage as `id:status`, with a failed stage's code. */
function summary(start: OrbitThreadStart, create: OrbitGatewayOperation | null = null): string[] {
  return orbitSetupStages({ start, create }).map((stage) =>
    [`${stage.id}:${stage.status}`, stage.errorCode].filter(Boolean).join(" "),
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
      "Conn's empty steps[] with failed_step",
      { ...creating, error: "Orbit could not create the clone.", errorCode: "instance.t3_unready" },
      createOp("failed", { steps: [], currentStep: null, failedStep: "clone-register" }),
      ["create:failed instance.t3_unready", "connect:pending", "agent:pending"],
    ],
    [
      "Conn's empty steps[] on a succeeded create, before the clone's server is found",
      creating,
      createOp("succeeded", { steps: [], currentStep: null }),
      ["create:done", "connect:pending", "agent:pending"],
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
      ["create:failed instance.t3_unready", "connect:pending", "agent:pending"],
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
        rows: null,
        error: null,
        errorCode: null,
      },
      {
        id: "connect",
        status: "done",
        startedAt: 41,
        finishedAt: 50,
        detail: null,
        rows: null,
        error: null,
        errorCode: null,
      },
      {
        id: "agent",
        status: "done",
        startedAt: 51,
        finishedAt: 60,
        detail: null,
        rows: null,
        error: null,
        errorCode: null,
      },
    ]);
  });

  it("shows the five create rows while the create runs or failed, and folds them once done", () => {
    const rows = (start: OrbitThreadStart) =>
      orbitSetupStages({ start })[0]!.rows?.map((row) => `${row.label}:${row.status}`) ?? null;
    const saved = {
      ...creating,
      createRows: {
        container: { status: "done", startedAt: 11, finishedAt: 20 },
        address: { status: "running", startedAt: 12, finishedAt: null },
      },
    } satisfies OrbitThreadStart;
    expect(rows(creating)).toEqual([
      "Copy the container:pending",
      "Publish the address:pending",
      "Copy the workspace:pending",
      "Start the T3 server:pending",
      "Register with Orbit:pending",
    ]);
    expect(rows(saved)).toEqual([
      "Copy the container:done",
      "Publish the address:running",
      "Copy the workspace:pending",
      "Start the T3 server:pending",
      "Register with Orbit:pending",
    ]);
    // A failure the Operation never placed, such as a timeout, stops the row that ran.
    expect(
      rows({ ...saved, error: "Orbit did not finish.", errorCode: "operation.timeout" }),
    ).toEqual([
      "Copy the container:done",
      "Publish the address:failed",
      "Copy the workspace:pending",
      "Start the T3 server:pending",
      "Register with Orbit:pending",
    ]);
    // A create refused before admission has no rows.
    expect(rows({ ...base, error: "The name is taken.", errorCode: "instance.name_taken" })).toBe(
      null,
    );
    expect(rows({ ...saved, environmentId: "env-41", createFinishedAt: 40 })).toBe(null);
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
    expect(summary(existing)).toEqual(["connect:pending", "agent:pending"]);
    expect(summary({ ...existing, connectStartedAt: 5 })).toEqual([
      "connect:running",
      "agent:pending",
    ]);
    expect(summary({ ...existing, connected: true })).toEqual(["connect:done", "agent:running"]);
    expect(
      summary({ ...existing, error: "Pairing expired.", errorCode: "operation.timeout" }),
    ).toEqual(["connect:failed operation.timeout", "agent:pending"]);
  });

  it("keeps Start agent pending for a start the plus made while it waits for its first message", () => {
    const waiting = { ...connected, message: "", agentStartedAt: null, readyWithoutPrompt: true };
    expect(summary(waiting)).toEqual(["create:done", "connect:done", "agent:pending"]);
    expect(summary({ ...waiting, message: "Fix it" })).toEqual([
      "create:done",
      "connect:done",
      "agent:running",
    ]);
  });

  it("keeps Connect pending after the create until the runner stamps it", () => {
    expect(summary(created)).toEqual(["create:done", "connect:pending", "agent:pending"]);
    expect(summary({ ...created, connectStartedAt: 41 })).toEqual([
      "create:done",
      "connect:running",
      "agent:pending",
    ]);
  });
});

describe("orbitSetupReadyMs", () => {
  it("adds up the stages", () => {
    // Create 10-40, Connect 41-50, Start agent 51-60.
    expect(orbitSetupReadyMs({ ...connected, sentAt: 60 })).toBe(30 + 9 + 9);
    expect(orbitSetupReadyMs(connected)).toBeNull();
    const existing = { ...connected, orbitInstanceKind: "existing" as const, sentAt: 60 };
    expect(orbitSetupReadyMs(existing)).toBe(9 + 9);
  });

  it("leaves out the time a failed stage waited for Retry", () => {
    // The send failed; Retry 1000 later stamped Start agent anew.
    expect(orbitSetupReadyMs({ ...connected, agentStartedAt: 1_051, sentAt: 1_060 })).toBe(
      30 + 9 + 9,
    );
  });
});
