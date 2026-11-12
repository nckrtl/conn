import type {
  OrbitGatewayOperation,
  OrbitInstanceRemovePorts,
} from "@t3tools/client-runtime/orbit-gateway";
import { OrbitGatewayError } from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  cleanUpRemovedOrbitInstance,
  runOrbitInstanceRemoval,
  useOrbitInstanceRemovals,
  type OrbitInstanceCleanupPorts,
} from "./orbitInstanceRemoval";

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: vi.fn() }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { remove: {} } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./environmentProvider", () => ({
  forgetOrbitInstanceEnvironment: vi.fn(),
  orbitInstanceEnvironmentIds: vi.fn(),
}));
vi.mock("./orbitInstanceList", () => ({ loadOrbitInstanceList: vi.fn() }));
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

const operation = (status: OrbitGatewayOperation["status"]): OrbitGatewayOperation => ({
  id: 77,
  kind: "instance.destroy",
  status,
  targetId: 41,
  errorCode: status === "failed" ? "swamp.destroy_failed" : null,
  pollAfterSeconds: null,
});

function gateway(destroy: () => Promise<OrbitGatewayOperation>) {
  const keys: string[] = [];
  let clock = 1000;
  const ports: OrbitInstanceRemovePorts = {
    client: {
      destroyInstance: async (_id, _ack, key) => {
        keys.push(key);
        return destroy();
      },
      operation: async () => operation("succeeded"),
    },
    now: () => clock++,
    sleep: async () => undefined,
  };
  return { ports, keys };
}

describe("runOrbitInstanceRemoval", () => {
  it("shows Removing…, then cleans up and reloads the list when Orbit destroyed it", async () => {
    const state = device();
    const reloadList = vi.fn(async () => undefined);
    let during: unknown;
    const orbit = gateway(async () => {
      during = useOrbitInstanceRemovals.getState().byInstance[41];
      return operation("running");
    });
    const outcome = await runOrbitInstanceRemoval({ id: 41, environmentId: "env-a" }, false, {
      gateway: orbit.ports,
      cleanup: state.ports,
      reloadList,
    });
    expect(outcome).toEqual({ kind: "removed" });
    expect(during).toEqual({ status: "removing" });
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toBeUndefined();
    expect([...state.saved]).toEqual(["env-c"]);
    expect(reloadList).toHaveBeenCalledOnce();
  });

  it("keeps a failure on the row, and a Retry is a new attempt with a new key", async () => {
    const state = device();
    const reloadList = vi.fn(async () => undefined);
    let answer = operation("failed");
    const orbit = gateway(async () => answer);
    const ports = { gateway: orbit.ports, cleanup: state.ports, reloadList };

    await runOrbitInstanceRemoval({ id: 41, environmentId: "env-a" }, true, ports);
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toEqual({
      status: "failed",
      message: "Orbit did not finish removing the Instance.",
    });
    expect([...state.saved]).toEqual(["env-a", "env-b", "env-c"]);
    expect(reloadList).not.toHaveBeenCalled();

    answer = operation("succeeded");
    await runOrbitInstanceRemoval({ id: 41, environmentId: "env-a" }, true, ports);
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toBeUndefined();
    expect(new Set(orbit.keys).size).toBe(2);
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
    const outcome = await runOrbitInstanceRemoval({ id: 41, environmentId: "env-a" }, false, {
      gateway: orbit.ports,
      cleanup: state.ports,
      reloadList: async () => undefined,
    });
    expect(outcome).toEqual({ kind: "unsaved_work", git: { state: "unknown", reason: null } });
    expect(useOrbitInstanceRemovals.getState().byInstance[41]).toBeUndefined();
    expect(state.log).toEqual([]);
  });
});
