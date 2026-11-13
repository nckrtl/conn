import type {
  OrbitGatewayOperation,
  OrbitInstanceRemovePorts,
} from "@t3tools/client-runtime/orbit-gateway";
import { OrbitGatewayError } from "@t3tools/client-runtime/orbit-gateway";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  cleanUpRemovedOrbitInstance,
  resetOrbitInstanceRemovalsForTest,
  restoreOrbitInstanceRemovals,
  runOrbitInstanceRemoval,
  useOrbitInstanceRemovals,
  type OrbitInstanceCleanupPorts,
  type OrbitInstanceRemovalStorage,
} from "./orbitInstanceRemoval";

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: vi.fn() }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { remove: {} } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./environmentProvider", () => ({
  forgetOrbitInstanceEnvironment: vi.fn(),
  orbitInstanceEnvironmentIds: vi.fn(),
}));
vi.mock("./orbitInstanceList", () => ({
  loadOrbitInstanceList: vi.fn(),
  useOrbitInstanceListStore: { getState: vi.fn() },
}));
vi.mock("./OrbitProfileSync", () => ({ desktopOrbitGatewayClient: () => null }));
vi.mock("./orbitThreadStartStore", () => ({ dropOrbitInstanceStarts: vi.fn() }));

/** A device's saved servers: env-a and env-b of Instance 41, env-c of Instance 7. */
function device(options: { failRemoving?: string } = {}) {
  const saved = new Set(["env-a", "env-b", "env-c"]);
  const paired = new Set(["env-a", "env-b", "env-c"]);
  const log: string[] = [];
  const ports: OrbitInstanceCleanupPorts = {
    knownEnvironmentIds: (instanceId) => (instanceId === 41 ? ["env-b", "env-a"] : ["env-c"]),
    removeEnvironment: async (environmentId) => {
      log.push(`remove ${environmentId}`);
      if (environmentId === options.failRemoving) throw new Error(`cannot remove ${environmentId}`);
      saved.delete(environmentId);
    },
    forgetEnvironment: (environmentId) => {
      log.push(`forget ${environmentId}`);
      paired.delete(environmentId);
    },
    dropThreadStarts: (instanceId, environmentIds) => {
      log.push(`starts ${instanceId} ${environmentIds.join(",")}`);
    },
  };
  return { ports, saved, paired, log };
}

describe("cleanUpRemovedOrbitInstance", () => {
  it("drops the pairing, servers and saved starts of the removed Instance only", async () => {
    const state = device();
    await cleanUpRemovedOrbitInstance({ id: 41, environmentId: "env-a" }, state.ports);
    expect([...state.saved]).toEqual(["env-c"]);
    expect([...state.paired]).toEqual(["env-c"]);
    // The starts go first, so a sync running meanwhile no longer holds the Instance.
    expect(state.log[0]).toBe("starts 41 env-a,env-b");
  });

  it("finishes every step when one server cannot be removed, then reports it", async () => {
    const state = device({ failRemoving: "env-a" });
    await expect(
      cleanUpRemovedOrbitInstance({ id: 41, environmentId: "env-a" }, state.ports),
    ).rejects.toThrow("cannot remove env-a");
    expect([...state.saved]).toEqual(["env-a", "env-c"]);
    expect([...state.paired]).toEqual(["env-c"]);
  });
});

const operation = (
  status: OrbitGatewayOperation["status"],
  extra: Partial<OrbitGatewayOperation> = {},
): OrbitGatewayOperation => ({
  id: 77,
  kind: "instance.destroy",
  status,
  targetId: 41,
  errorCode: status === "failed" ? "swamp.destroy_failed" : null,
  pollAfterSeconds: null,
  ...extra,
});

const ROW = {
  id: 41,
  name: "pricing-page",
  projectId: 5,
  projectSlug: "p5",
  projectName: "P5",
  nodeName: "beast",
  domain: "pricing-page.p5.test",
  instanceUrl: "https://pricing-page.p5.test",
  powerState: "running" as const,
  status: "registered" as const,
  environmentId: "env-a",
  branch: null,
};

function memoryStorage(initial: Record<string, Record<string, unknown>> = {}) {
  let value = structuredClone(initial) as never;
  const storage: OrbitInstanceRemovalStorage = {
    read: () => structuredClone(value),
    write: (next) => {
      value = structuredClone(next) as never;
    },
  };
  return { storage, saved: () => value as Record<string, Record<string, Record<string, unknown>>> };
}

function gateway(
  destroy: () => Promise<OrbitGatewayOperation>,
  reads: Array<OrbitGatewayOperation | Error> = [],
) {
  const keys: string[] = [];
  const acks: boolean[] = [];
  let clock = 1000;
  const ports: OrbitInstanceRemovePorts = {
    client: {
      destroyInstance: async (_id, ack, key) => {
        keys.push(key);
        acks.push(ack);
        return destroy();
      },
      operation: async () => {
        const next = reads.shift() ?? operation("succeeded");
        if (next instanceof Error) throw next;
        return next;
      },
    },
    now: () => clock++,
    sleep: async () => undefined,
  };
  return { ports, keys, acks };
}

function removalPorts(
  orbit: ReturnType<typeof gateway>,
  state: ReturnType<typeof device>,
  storage = memoryStorage(),
  profileId: number | null | (() => Promise<number | null>) = 1,
  listed: ReadonlySet<number> = new Set([41]),
) {
  const reloadList = vi.fn(async () => undefined);
  return {
    ports: {
      gateway: orbit.ports,
      cleanup: state.ports,
      reloadList,
      storage: storage.storage,
      profileId: typeof profileId === "function" ? profileId : async () => profileId,
      isListed: (instanceId: number) => listed.has(instanceId),
    },
    reloadList,
    storage,
  };
}

const notFound = () =>
  new OrbitGatewayError({
    code: "http.404",
    message: "Resource not found.",
    status: 404,
    details: {},
  });

describe("runOrbitInstanceRemoval", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it("shows Removing… before any Gateway call, then cleans up and reloads when Orbit destroyed it", async () => {
    const state = device();
    let during: unknown;
    const orbit = gateway(async () => {
      during = useOrbitInstanceRemovals.getState().byInstance[41];
      return operation("running");
    });
    const { ports, reloadList, storage } = removalPorts(orbit, state);
    const pending = runOrbitInstanceRemoval(ROW, false, ports);
    // Synchronous: the click answers before the profile read or the destroy request.
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
      status: "removing",
      progress: null,
    });
    expect(await pending).toEqual({ kind: "removed" });
    expect(during).toMatchObject({ status: "removing" });
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toEqual({ status: "removed" });
    expect([...state.saved]).toEqual(["env-c"]);
    expect(reloadList).toHaveBeenCalledOnce();
    expect(storage.saved()).toEqual({});
  });

  it("shows the queue place and the plain step while Orbit works", async () => {
    const state = device();
    const seen: unknown[] = [];
    const unsubscribe = useOrbitInstanceRemovals.subscribe((store) =>
      seen.push(store.byInstance[41]),
    );
    const orbit = gateway(
      async () => operation("queued", { pollAfterSeconds: 2 }),
      [
        operation("running", { pollAfterSeconds: 2, currentStep: "Withdraw the Route" }),
        operation("succeeded"),
      ],
    );
    await runOrbitInstanceRemoval(ROW, true, removalPorts(orbit, state).ports);
    unsubscribe();
    expect(seen).toContainEqual(
      expect.objectContaining({ status: "removing", progress: { kind: "waiting" } }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        status: "removing",
        progress: { kind: "running", step: "Taking the address offline" },
      }),
    );
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "keeps a %s Operation as Removal failed, saved for a restart",
    async (status) => {
      const state = device();
      const orbit = gateway(async () => operation(status));
      const { ports, storage, reloadList } = removalPorts(orbit, state);
      await runOrbitInstanceRemoval(ROW, true, ports);
      expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
        status: "failed",
        refused: false,
        message: "Orbit did not finish removing the Instance.",
        acknowledgeUnsaved: true,
      });
      expect(storage.saved()["1"]?.["41"]).toMatchObject({
        status: "failed",
        acknowledgeUnsaved: true,
      });
      expect([...state.saved]).toEqual(["env-a", "env-b", "env-c"]);
      expect(reloadList).not.toHaveBeenCalled();
    },
  );

  it("treats a 404 on the destroy as already removed", async () => {
    const state = device();
    const orbit = gateway(async () => {
      throw notFound();
    });
    const { ports, storage } = removalPorts(orbit, state);
    expect(await runOrbitInstanceRemoval(ROW, false, ports)).toEqual({ kind: "removed" });
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toEqual({ status: "removed" });
    expect(storage.saved()).toEqual({});
  });

  it("Retry sends the destroy again with the same tick and a new key, and drops the saved record", async () => {
    const state = device();
    let answer = operation("failed");
    const orbit = gateway(async () => answer);
    const { ports, storage } = removalPorts(orbit, state);

    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(storage.saved()["1"]?.["41"]).toBeDefined();

    answer = operation("succeeded");
    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toEqual({ status: "removed" });
    expect(new Set(orbit.keys).size).toBe(2);
    expect(orbit.acks).toEqual([true, true]);
    expect(storage.saved()).toEqual({});
  });

  it("shows a refusal as Could not remove, and keeps nothing for a restart", async () => {
    const state = device();
    const orbit = gateway(async () => {
      throw new OrbitGatewayError({
        code: "instance.default_protected",
        message: "The default Instance cannot be removed from Conn.",
        status: 409,
        details: {},
      });
    });
    const { ports, storage } = removalPorts(orbit, state);
    await runOrbitInstanceRemoval(ROW, false, ports);
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
      status: "failed",
      refused: true,
      message: "The default Instance cannot be removed from Conn.",
    });
    expect(storage.saved()).toEqual({});
  });

  it("leaves everything in place when Orbit asks for the tick", async () => {
    const state = device();
    const orbit = gateway(async () => {
      throw new OrbitGatewayError({
        code: "instance.unsaved_work",
        message: "Unsaved work.",
        status: 409,
        details: { state: "unknown", uncommitted: null, unpushed: null },
      });
    });
    const { ports, storage } = removalPorts(orbit, state);
    const outcome = await runOrbitInstanceRemoval(ROW, false, ports);
    expect(outcome).toEqual({ kind: "unsaved_work", git: { state: "unknown", reason: null } });
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toBeUndefined();
    expect(state.log).toEqual([]);
    expect(storage.saved()).toEqual({});
  });
});

describe("restoreOrbitInstanceRemovals", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  const saved = (extra: Record<string, unknown>) => ({
    operationId: 77,
    acknowledgeUnsaved: true,
    status: "removing",
    message: null,
    row: ROW,
    ...extra,
  });

  it("shows a removal that failed while the app was closed, with Retry", async () => {
    const state = device();
    const storage = memoryStorage({ "1": { "41": saved({}) } });
    const orbit = gateway(
      async () => operation("succeeded"),
      [
        operation("failed", {
          error: {
            code: "swamp.start_unavailable",
            message: null,
            detail: "The native workflow start could not connect.",
          },
        }),
      ],
    );
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
      status: "failed",
      refused: false,
      message: "The native workflow start could not connect.",
      acknowledgeUnsaved: true,
    });
    expect(storage.saved()["1"]?.["41"]).toMatchObject({ status: "failed", operationId: null });
  });

  it("drops the row of a removal that succeeded while the app was closed", async () => {
    const state = device();
    const storage = memoryStorage({ "1": { "41": saved({}) } });
    const orbit = gateway(async () => operation("succeeded"), [operation("succeeded")]);
    const { ports, reloadList } = removalPorts(orbit, state, storage);
    await restoreOrbitInstanceRemovals(ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toEqual({ status: "removed" });
    expect(storage.saved()).toEqual({});
    expect(reloadList).toHaveBeenCalledOnce();
  });

  it("calls a saved removal whose Operation Orbit no longer shows failed while the Instance is listed", async () => {
    const state = device();
    const storage = memoryStorage({
      "1": { "41": saved({}), "42": saved({ row: { ...ROW, id: 42 } }) },
    });
    const orbit = gateway(async () => operation("succeeded"), [notFound(), notFound()]);
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
      status: "failed",
      message: "Conn lost track of this removal.",
    });
    // Not listed and unknown to Orbit: it is gone.
    expect(useOrbitInstanceRemovals.getState().byInstance[42]).toEqual({ status: "removed" });
  });

  it("shows a saved failure again and forgets one whose Instance left the list", async () => {
    const state = device();
    const storage = memoryStorage({
      "1": {
        "41": saved({ status: "failed", operationId: null, message: "Swamp lost the Node." }),
        "42": saved({ status: "failed", operationId: null, message: "x", row: { ...ROW, id: 42 } }),
      },
    });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance).toEqual({
      41: expect.objectContaining({ status: "failed", message: "Swamp lost the Node." }),
    });
    expect(Object.keys(storage.saved()["1"] ?? {})).toEqual(["41"]);
  });

  it("never shows a saved removal of another Orbit profile", async () => {
    const state = device();
    const storage = memoryStorage({
      "2": { "41": saved({ status: "failed", operationId: null, message: "Other profile." }) },
    });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage, 1).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance).toEqual({});
    expect(storage.saved()["2"]?.["41"]).toBeDefined();
  });
});

describe("review fixes (conn#73)", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  const saved = (extra: Record<string, unknown>) => ({
    operationId: 77,
    acknowledgeUnsaved: true,
    status: "failed",
    message: "Old failure.",
    row: ROW,
    ...extra,
  });

  it("shows no saved removal when the profile cannot be read, only this window's own", async () => {
    const state = device();
    const storage = memoryStorage({ none: { "41": saved({ operationId: null }) } });
    const orbit = gateway(async () => operation("succeeded"));
    useOrbitInstanceRemovals.setState({
      byInstance: {
        41: { status: "failed", refused: false, message: "x", acknowledgeUnsaved: true, row: ROW },
      },
      restoredFor: null,
    });
    const opening = Symbol("open");
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, state, storage, async () => {
        throw new Error("Gateway down");
      }).ports,
      new Set([41]),
      opening,
    );
    expect(useOrbitInstanceRemovals.getState()).toEqual({ byInstance: {}, restoredFor: opening });
  });

  it("drops another profile's rows from the store when the page opens under a new profile", async () => {
    const state = device();
    const storage = memoryStorage({ "1": { "41": saved({ operationId: null }) } });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage, 1).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toBeDefined();
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage, 2).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance).toEqual({});
  });

  it("keeps a click's row when a restore runs while the click still reads the profile", async () => {
    const state = device();
    let release: () => void = () => {};
    const profileRead = new Promise<number>((resolve) => {
      release = () => resolve(1);
    });
    let destroys = 0;
    const orbit = gateway(async () => {
      destroys++;
      return operation("running", { pollAfterSeconds: 2 });
    }, [operation("succeeded")]);
    const storage = memoryStorage();
    const click = runOrbitInstanceRemoval(
      ROW,
      true,
      removalPorts(orbit, state, storage, () => profileRead).ports,
    );
    await restoreOrbitInstanceRemovals(removalPorts(orbit, state, storage, 1).ports, new Set([41]));
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
      status: "removing",
    });
    // The bin stays replaced: a second click does not send a second destroy.
    expect(
      await runOrbitInstanceRemoval(ROW, true, removalPorts(orbit, state, storage).ports),
    ).toMatchObject({
      code: "conn.remove_running",
    });
    release();
    expect(await click).toEqual({ kind: "removed" });
    expect(destroys).toBe(1);
  });

  it("calls a live removal whose Operation Orbit no longer shows removed once the list lacks it", async () => {
    const state = device();
    const orbit = gateway(async () => operation("running", { pollAfterSeconds: 2 }), [notFound()]);
    const { ports, storage } = removalPorts(orbit, state, memoryStorage(), 1, new Set());
    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toEqual({ status: "removed" });
    expect(storage.saved()).toEqual({});
  });

  it("keeps following through an expired session or a server error", async () => {
    const state = device();
    const orbit = gateway(
      async () => operation("running", { pollAfterSeconds: 2 }),
      [
        new OrbitGatewayError({
          code: "auth.unauthenticated",
          message: "Expired.",
          status: 401,
          details: {},
        }),
        new OrbitGatewayError({ code: "http.503", message: "Down.", status: 503, details: {} }),
        operation("succeeded"),
      ],
    );
    const { ports } = removalPorts(orbit, state);
    expect(await runOrbitInstanceRemoval(ROW, true, ports)).toEqual({ kind: "removed" });
  });

  it("never brings back a follow of an earlier profile after a failed profile read", async () => {
    const state = device();
    let tick: (next: OrbitGatewayOperation) => void = () => {};
    let slept: () => void = () => {};
    const afterProgress = new Promise<void>((resolve) => {
      slept = resolve;
    });
    let reads = 0;
    const orbit = gateway(async () => operation("succeeded"));
    // Profile 1 follows a saved removal whose Operation is still running.
    const ports = {
      ...removalPorts(orbit, state, memoryStorage(), 1).ports,
      gateway: {
        now: () => 0,
        // The follow sleeps right after it reported progress.
        sleep: async () => {
          slept();
          await new Promise<void>(() => {});
        },
        client: {
          destroyInstance: async () => operation("succeeded"),
          operation: () =>
            new Promise<OrbitGatewayOperation>((resolve) => {
              reads++;
              tick = resolve;
            }),
        },
      },
    };
    const storage = memoryStorage({
      "1": {
        "41": {
          operationId: 77,
          acknowledgeUnsaved: true,
          status: "removing",
          message: null,
          row: ROW,
        },
      },
    });
    void restoreOrbitInstanceRemovals({ ...ports, storage: storage.storage }, new Set([41]));
    await vi.waitFor(() => expect(reads).toBe(1));
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toMatchObject({
      status: "removing",
    });
    // The page opens again; the profile read fails.
    const opening = Symbol("reopen");
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, state, storage, async () => {
        throw new Error("Gateway down");
      }).ports,
      new Set([41]),
      opening,
    );
    expect(useOrbitInstanceRemovals.getState().byInstance).toEqual({});
    // Profile 1's follow reports progress: the row must stay hidden.
    tick(operation("running", { pollAfterSeconds: 2, currentStep: "Withdraw the Route" }));
    await afterProgress;
    expect(useOrbitInstanceRemovals.getState().byInstance).toEqual({});
  });
});
