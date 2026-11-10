import {
  newOrbitThreadStart,
  type OrbitGatewayClient,
  type OrbitGatewayOperation,
} from "@t3tools/client-runtime/orbit-gateway";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: vi.fn() }));

import {
  createOrbitThreadStartStore,
  dismissOrbitThreadStart,
  heldOrbitInstanceIds,
  orbitThreadStartRow,
  retryOrbitThreadStart,
  type OrbitThreadStartStorage,
} from "./orbitThreadStartStore";
import {
  beginOrbitThreadStart,
  runSavedOrbitThreadStart,
  type MobileOrbitThreadStartPorts,
} from "./orbitThreadStarts";

const project = {
  id: 66,
  slug: "create-bench",
  name: "Create bench",
  nodeId: 7,
  nodeName: "beast",
};

/** A file that keeps what was last written, as the app's documents folder does across restarts. */
function memoryFile(initial: string | null = null) {
  const file = { text: initial, writes: 0 };
  const storage: OrbitThreadStartStorage = {
    load: async () => file.text,
    save: async (text) => {
      file.writes += 1;
      file.text = text;
    },
  };
  return { file, storage };
}

function uuids() {
  let next = 0;
  return () => `id-${++next}`;
}

function op(id: number, targetId: number, status: OrbitGatewayOperation["status"]) {
  return { id, kind: "x", status, targetId, errorCode: null, pollAfterSeconds: 0 };
}

/** A Gateway that creates clone 41 with server env-41 and pairs it, recording each call. */
function gateway() {
  const calls: string[] = [];
  const client = {
    createThreadInstance: async (projectId: number) => {
      calls.push(`create ${projectId}`);
      return op(100, 41, "queued");
    },
    operation: async (id: number) => op(id, id === 100 ? 41 : 9, "succeeded"),
    environments: async () => [
      {
        environmentId: "env-41",
        label: "create-bench / clone",
        url: "http://10.44.0.7:3800",
        serverVersion: null,
        registeredBy: "beast",
        registeredAt: null,
        status: "registered",
        instanceId: 41,
        powerState: "running",
      },
    ],
    startPairing: async (environmentId: string) => {
      calls.push(`pair ${environmentId}`);
      return op(200, 9, "queued");
    },
    readPairing: async (environmentId: string) => ({
      environmentId,
      pairingUrl: "http://10.44.0.7:3800/pair#token=t",
      expiresAt: "",
    }),
  } as unknown as OrbitGatewayClient;
  return { client, calls };
}

function ports(
  store: MobileOrbitThreadStartPorts["store"],
  overrides: Partial<MobileOrbitThreadStartPorts> = {},
) {
  const saved = new Set<string>();
  const kept: Array<[string | null, string]> = [];
  const launches: string[] = [];
  const { client, calls } = gateway();
  const value: MobileOrbitThreadStartPorts = {
    store,
    gateway: client,
    orbitMode: () => true,
    catalogReady: async () => true,
    isSaved: (environmentId) => saved.has(environmentId),
    connect: async (environmentId) => {
      calls.push(`connect ${environmentId}`);
      saved.add(environmentId);
    },
    firstMessage: {
      waitForClone: async () => ({
        projectId: ProjectId.make("workspace"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
      startTurn: async (environmentId, input) => {
        launches.push(`${environmentId} ${input.threadId} ${input.message.text}`);
        return { ok: true };
      },
      now: () => "2026-11-10T12:00:00.000Z",
    },
    keepInWorkspace: async (workspaceId, ref) => {
      kept.push([workspaceId, ref]);
    },
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  };
  return { ports: value, calls, kept, launches };
}

describe("Orbit thread starts on the phone", () => {
  it("creates one clone, pairs once, sends the first message and adds the ref to the workspace", async () => {
    const { storage } = memoryFile();
    const store = createOrbitThreadStartStore(storage);
    await store.load();
    const start = beginOrbitThreadStart(store, {
      project,
      message: "List the files in this folder",
      workspaceId: "work",
      uuid: uuids(),
      now: 0,
    });
    const run = ports(store);

    expect(await runSavedOrbitThreadStart(start.id, run.ports)).toEqual({
      environmentId: "env-41",
      threadId: start.threadId,
    });
    expect(run.calls).toEqual(["create 66", "pair env-41", "connect env-41"]);
    expect(run.launches).toEqual([`env-41 ${start.threadId} List the files in this folder`]);
    expect(run.kept).toEqual([["work", "env-41:workspace"]]);
    expect(store.starts()).toEqual([]);
  });

  it("resumes a start saved mid-pairing after a restart without a second create", async () => {
    const { storage } = memoryFile();
    const before = createOrbitThreadStartStore(storage);
    await before.load();
    const start = beginOrbitThreadStart(before, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    before.save({ ...start, createOperationId: 100, instanceId: 41, environmentId: "env-41" });
    await before.flush();

    const after = createOrbitThreadStartStore(storage);
    await after.load();
    expect(heldOrbitInstanceIds(after)).toEqual([41]);
    expect(orbitThreadStartRow(after.starts()[0]!)).toMatchObject({ stage: "pairing" });
    const run = ports(after);
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).not.toBeNull();
    expect(run.calls).toEqual(["pair env-41", "connect env-41"]);
  });

  it("shows a stopped start with its error; Retry runs it again and Dismiss removes it", async () => {
    const store = createOrbitThreadStartStore(memoryFile().storage);
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const refused = ports(store, {
      connect: async () => {
        throw new Error("Could not pair with the clone: refused");
      },
    });
    expect(await runSavedOrbitThreadStart(start.id, refused.ports)).toBeNull();
    const stopped = store.starts()[0]!;
    expect(orbitThreadStartRow(stopped)).toEqual({
      stage: "stopped",
      label: "Stopped",
      detail: "Could not pair with the clone: refused",
    });
    // A stopped start does not run again on its own.
    expect(await runSavedOrbitThreadStart(start.id, ports(store).ports)).toBeNull();

    retryOrbitThreadStart(start.id, store);
    expect(orbitThreadStartRow(store.starts()[0]!).stage).toBe("pairing");
    dismissOrbitThreadStart(start.id, store);
    expect(store.starts()).toEqual([]);
  });

  it("puts each key on disk before the Gateway call that uses it", async () => {
    const file: { text: string | null } = { text: null };
    // The write lands a tick after it starts, as a file write does; a call that does not wait
    // for it sees the old file.
    const slow: OrbitThreadStartStorage = {
      load: async () => file.text,
      save: async (text) => {
        await Promise.resolve();
        file.text = text;
      },
    };
    const store = createOrbitThreadStartStore(slow);
    await store.load();
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const onDisk: string[] = [];
    const run = ports(store);
    const gatewayCalls = run.ports.gateway;
    run.ports = {
      ...run.ports,
      gateway: {
        ...gatewayCalls,
        createThreadInstance: async (...args) => {
          onDisk.push(
            `create key saved: ${file.text?.includes('"createKey":"conn-thread-start') ?? false}`,
          );
          return gatewayCalls.createThreadInstance(...args);
        },
        startPairing: async (...args) => {
          onDisk.push(
            `pairing key saved: ${file.text?.includes('"pairingKey":"conn-thread-start') ?? false}`,
          );
          return gatewayCalls.startPairing(...args);
        },
      },
    };
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).not.toBeNull();
    expect(onDisk).toEqual(["create key saved: true", "pairing key saved: true"]);
  });

  it("stops the start when the phone cannot save a step", async () => {
    const store = createOrbitThreadStartStore({
      load: async () => null,
      save: async () => {
        throw new Error("disk full");
      },
    });
    const start = beginOrbitThreadStart(store, {
      project,
      message: "Fix it",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    const run = ports(store);
    expect(await runSavedOrbitThreadStart(start.id, run.ports)).toBeNull();
    expect(run.calls).toEqual([]);
    expect(store.starts()[0]!.error).toBe("Conn could not save the thread start on this phone.");
  });

  it("maps each saved step to its stage", () => {
    const start = newOrbitThreadStart({
      id: "s",
      project,
      message: "Hi",
      suffix: "abc",
      threadId: "t",
      messageId: "m",
      commandId: "c",
      now: 0,
    });
    expect(orbitThreadStartRow(start).label).toBe("Creating the clone…");
    expect(orbitThreadStartRow({ ...start, environmentId: "e" }).label).toBe("Pairing…");
    expect(orbitThreadStartRow({ ...start, environmentId: "e", connected: true }).label).toBe(
      "Sending the first message…",
    );
  });

  it("keeps starts added before the file loaded and drops rows without a launch command id", async () => {
    const saved = JSON.stringify([
      { id: "old", commandId: "c", threadId: "t", projectId: 1 },
      { id: "legacy", threadId: "t", projectId: 1 },
    ]);
    const store = createOrbitThreadStartStore(memoryFile(saved).storage);
    beginOrbitThreadStart(store, {
      project,
      message: "x",
      workspaceId: null,
      uuid: uuids(),
      now: 0,
    });
    await store.load();
    expect(store.starts().map((start) => start.id)).toEqual(["old", "id-1"]);
  });
});
