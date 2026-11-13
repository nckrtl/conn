import type {
  OrbitGatewayOperation,
  OrbitInstanceRemovePorts,
} from "@t3tools/client-runtime/orbit-gateway";
import { OrbitGatewayError } from "@t3tools/client-runtime/orbit-gateway";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  cleanUpRemovedOrbitInstance,
  openOrbitInstanceRemovalPage,
  resetOrbitInstanceRemovalsForTest,
  restoreOrbitInstanceRemovals,
  runOrbitInstanceRemoval,
  shownOrbitInstanceRemovals,
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

/** The rows the page shows now. */
const shown = () => shownOrbitInstanceRemovals(useOrbitInstanceRemovals.getState());

const failing =
  (message = "Gateway down") =>
  async () => {
    throw new Error(message);
  };

/** A profile read the test answers by hand. */
function heldProfile() {
  let answer: (profile: number | null) => void = () => {};
  let fail: () => void = () => {};
  const read = new Promise<number | null>((resolve, reject) => {
    answer = resolve;
    fail = () => reject(new Error("Gateway down"));
  });
  return { read: () => read, answer, fail };
}

/**
 * A Gateway whose destroy is admitted as running and whose Operation reads wait for the test.
 * `destroys` counts the destroy requests.
 */
function heldGateway() {
  const pending: Array<(next: OrbitGatewayOperation | Error) => void> = [];
  const counts = { destroys: 0, reads: 0 };
  const ports: OrbitInstanceRemovePorts = {
    now: () => 0,
    sleep: async () => undefined,
    client: {
      destroyInstance: async () => {
        counts.destroys++;
        return operation("running", { pollAfterSeconds: 2 });
      },
      operation: () =>
        new Promise<OrbitGatewayOperation>((resolve, reject) => {
          counts.reads++;
          pending.push((next) => (next instanceof Error ? reject(next) : resolve(next)));
        }),
    },
  };
  const answer = (next: OrbitGatewayOperation | Error) => {
    const take = pending.shift();
    if (take === undefined) throw new Error("no Operation read waits");
    take(next);
  };
  return { ports, counts, answer, waiting: () => pending.length };
}

const savedRemoving = (extra: Record<string, unknown> = {}) => ({
  operationId: 77,
  acknowledgeUnsaved: true,
  status: "removing",
  message: null,
  row: ROW,
  ...extra,
});

const savedFailed = (extra: Record<string, unknown> = {}) =>
  savedRemoving({ status: "failed", operationId: null, message: "Old failure.", ...extra });

function heldPorts(
  held: ReturnType<typeof heldGateway>,
  storage = memoryStorage(),
  profileId: number | null | (() => Promise<number | null>) = 1,
  listed: ReadonlySet<number> = new Set([41]),
) {
  const base = removalPorts(
    gateway(async () => operation("succeeded")),
    device(),
    storage,
    profileId,
    listed,
  );
  return { ...base, ports: { ...base.ports, gateway: held.ports } };
}

/** Lets every queued promise step run (no clock involved). */
const settleAll = async () => {
  for (let step = 0; step < 50; step++) await Promise.resolve();
};

describe("A. own click", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it("A1 shows Removing… before any Gateway call, then cleans up and reloads when Orbit destroyed it", async () => {
    const state = device();
    let during: unknown;
    const orbit = gateway(async () => {
      during = shown()[41];
      return operation("running");
    });
    const { ports, reloadList, storage } = removalPorts(orbit, state);
    const pending = runOrbitInstanceRemoval(ROW, false, ports);
    // Synchronous: the click answers before the profile read or the destroy request.
    expect(shown()[41]).toMatchObject({ status: "removing", progress: null });
    expect(await pending).toEqual({ kind: "removed" });
    expect(during).toMatchObject({ status: "removing" });
    expect(shown()[41]).toEqual({ status: "removed" });
    expect([...state.saved]).toEqual(["env-c"]);
    expect(reloadList).toHaveBeenCalledOnce();
    expect(storage.saved()).toEqual({});
  });

  it("A2 a click whose page cannot read the profile sends nothing, saves nothing and says so", async () => {
    const orbit = gateway(async () => operation("succeeded"));
    const { ports, storage } = removalPorts(orbit, device(), memoryStorage(), failing());
    const outcome = await runOrbitInstanceRemoval(ROW, true, ports);
    expect(outcome).toMatchObject({ kind: "failed", code: "gateway.unavailable" });
    expect(orbit.keys).toEqual([]);
    expect(shown()[41]).toMatchObject({
      status: "failed",
      refused: true,
      message: "The Orbit Gateway did not answer.",
    });
    expect(storage.saved()).toEqual({});
  });

  it("A3 saves the record under the page's profile before the destroy is sent", async () => {
    let savedAtDestroy: unknown;
    const storage = memoryStorage();
    const orbit = gateway(async () => {
      savedAtDestroy = storage.saved()["1"]?.["41"];
      return operation("succeeded");
    });
    await runOrbitInstanceRemoval(ROW, true, removalPorts(orbit, device(), storage).ports);
    expect(savedAtDestroy).toMatchObject({ status: "removing", operationId: null });
    expect(orbit.keys).toHaveLength(1);
  });

  it("A4 under a changed profile shows only that profile's rows; the earlier follow keeps saving", async () => {
    const held = heldGateway();
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
    void restoreOrbitInstanceRemovals(heldPorts(held, storage, 1).ports, new Set([41, 42]));
    await vi.waitFor(() => expect(held.counts.reads).toBe(1));
    expect(shown()[41]).toMatchObject({ status: "removing" });
    // The page opens under profile 2; a click there runs under profile 2.
    const { ports } = heldPorts(held, storage, 2);
    await restoreOrbitInstanceRemovals(ports, new Set([41, 42]), Symbol("p2")).catch(() => {});
    const click = runOrbitInstanceRemoval({ ...ROW, id: 42 }, true, ports);
    await vi.waitFor(() => expect(held.counts.destroys).toBe(1));
    expect(Object.keys(shown())).toEqual(["42"]);
    // Profile 1's follow ends failed: saved under profile 1, never shown.
    held.answer(operation("failed"));
    await vi.waitFor(() =>
      expect(storage.saved()["1"]?.["41"]).toMatchObject({ status: "failed" }),
    );
    expect(Object.keys(shown())).toEqual(["42"]);
    held.answer(operation("succeeded"));
    expect(await click).toEqual({ kind: "removed" });
  });

  it("A5 a second click on a row that is removing sends no second destroy", async () => {
    const held = heldGateway();
    const { ports } = heldPorts(held);
    const first = runOrbitInstanceRemoval(ROW, true, ports);
    await vi.waitFor(() => expect(held.counts.destroys).toBe(1));
    expect(await runOrbitInstanceRemoval(ROW, true, ports)).toMatchObject({
      code: "conn.remove_running",
    });
    held.answer(operation("succeeded"));
    expect(await first).toEqual({ kind: "removed" });
    // A click on a removed row sends nothing either.
    expect(await runOrbitInstanceRemoval(ROW, true, ports)).toMatchObject({
      code: "conn.remove_running",
    });
    expect(held.counts.destroys).toBe(1);
  });

  it("A7 a click before the page read, on an Instance whose saved removal that read restores, sends no destroy", async () => {
    const held = heldGateway();
    const profile = heldProfile();
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
    const { ports } = heldPorts(held, storage, profile.read);
    const page = openOrbitInstanceRemovalPage(ports);
    const click = runOrbitInstanceRemoval(ROW, true, ports);
    expect(shown()[41]).toMatchObject({ status: "removing" });
    profile.answer(1);
    await page.read;
    expect(await click).toMatchObject({ code: "conn.remove_running" });
    // The restored follow of Operation 77 runs; the row stays "Removing…".
    await vi.waitFor(() => expect(held.counts.reads).toBe(1));
    expect(shown()[41]).toMatchObject({ status: "removing" });
    held.answer(operation("succeeded"));
    await page.restored;
    expect(shown()[41]).toEqual({ status: "removed" });
    expect(held.counts.destroys).toBe(0);
  });

  it("A8 two clicks on one row while the page read is pending send one destroy", async () => {
    const held = heldGateway();
    const profile = heldProfile();
    const { ports } = heldPorts(held, memoryStorage(), profile.read);
    openOrbitInstanceRemovalPage(ports);
    const first = runOrbitInstanceRemoval(ROW, true, ports);
    expect(await runOrbitInstanceRemoval(ROW, true, ports)).toMatchObject({
      code: "conn.remove_running",
    });
    // The pending entry never sends: nothing goes out before the read.
    await settleAll();
    expect(held.counts.destroys).toBe(0);
    profile.answer(1);
    await vi.waitFor(() => expect(held.counts.destroys).toBe(1));
    held.answer(operation("succeeded"));
    expect(await first).toEqual({ kind: "removed" });
    expect(held.counts.destroys).toBe(1);
  });

  it("A9 a page closed and opened again while a click waits: the old read moves and sends nothing", async () => {
    const held = heldGateway();
    const read1 = heldProfile();
    const read2 = heldProfile();
    const storage = memoryStorage();
    const first = heldPorts(held, storage, read1.read).ports;
    openOrbitInstanceRemovalPage(first, Symbol("opening 1"));
    const click = runOrbitInstanceRemoval(ROW, true, first);
    openOrbitInstanceRemovalPage(heldPorts(held, storage, read2.read).ports, Symbol("opening 2"));
    // The old opening's read lands (profile 1): nothing moves, nothing is sent, nothing saved.
    read1.answer(1);
    await settleAll();
    expect(held.counts.destroys).toBe(0);
    expect(storage.saved()).toEqual({});
    expect(Object.keys(useOrbitInstanceRemovals.getState().entries)).toEqual(["?:41"]);
    expect(shown()[41]).toMatchObject({ status: "removing" });
    // The new opening's read decides: profile 2.
    read2.answer(2);
    await vi.waitFor(() => expect(held.counts.destroys).toBe(1));
    expect(Object.keys(useOrbitInstanceRemovals.getState().entries)).toEqual(["2:41"]);
    expect(storage.saved()["2"]?.["41"]).toBeDefined();
    held.answer(operation("succeeded"));
    expect(await click).toEqual({ kind: "removed" });
    expect(held.counts.destroys).toBe(1);
  });
});

describe("B. admission", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it("B1 treats a 404 on the destroy as already removed", async () => {
    const orbit = gateway(async () => {
      throw notFound();
    });
    const { ports, storage } = removalPorts(orbit, device());
    expect(await runOrbitInstanceRemoval(ROW, false, ports)).toEqual({ kind: "removed" });
    expect(shown()[41]).toEqual({ status: "removed" });
    expect(storage.saved()).toEqual({});
  });

  it("B2 shows a refusal as Could not remove, and keeps nothing for a restart", async () => {
    const orbit = gateway(async () => {
      throw new OrbitGatewayError({
        code: "instance.default_protected",
        message: "The default Instance cannot be removed from Conn.",
        status: 409,
        details: {},
      });
    });
    const { ports, storage } = removalPorts(orbit, device());
    await runOrbitInstanceRemoval(ROW, false, ports);
    expect(shown()[41]).toMatchObject({
      status: "failed",
      refused: true,
      message: "The default Instance cannot be removed from Conn.",
    });
    expect(storage.saved()).toEqual({});
  });

  it("B3 leaves everything in place when Orbit asks for the tick", async () => {
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
    expect(shown()[41]).toBeUndefined();
    expect(useOrbitInstanceRemovals.getState().entries).toEqual({});
    expect(state.log).toEqual([]);
    expect(storage.saved()).toEqual({});
  });

  it("B5 saves the admitted Operation id before the follow", async () => {
    const held = heldGateway();
    const { ports, storage } = heldPorts(held);
    const click = runOrbitInstanceRemoval(ROW, true, ports);
    await vi.waitFor(() => expect(held.counts.reads).toBe(1));
    expect(storage.saved()["1"]?.["41"]).toMatchObject({ status: "removing", operationId: 77 });
    held.answer(operation("succeeded"));
    await click;
  });
});

describe("C. follow running", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it("C1 shows the queue place and the plain step while Orbit works", async () => {
    const seen: unknown[] = [];
    const unsubscribe = useOrbitInstanceRemovals.subscribe(() => seen.push(shown()[41]));
    const orbit = gateway(
      async () => operation("queued", { pollAfterSeconds: 2 }),
      [
        operation("running", { pollAfterSeconds: 2, currentStep: "Withdraw the Route" }),
        operation("succeeded"),
      ],
    );
    await runOrbitInstanceRemoval(ROW, true, removalPorts(orbit, device()).ports);
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

  it.each([
    [
      "an expired session (401)",
      new OrbitGatewayError({
        code: "auth.unauthenticated",
        message: "Expired.",
        status: 401,
        details: {},
      }),
    ],
    [
      "a server error (5xx)",
      new OrbitGatewayError({ code: "http.503", message: "Down.", status: 503, details: {} }),
    ],
    [
      "a network loss",
      new OrbitGatewayError({
        code: "gateway.unreachable",
        message: "Offline.",
        status: 0,
        details: {},
      }),
    ],
  ])("C3 keeps the follow, the row and the record through %s", async (_name, error) => {
    const held = heldGateway();
    const { ports, storage } = heldPorts(held);
    const click = runOrbitInstanceRemoval(ROW, true, ports);
    await vi.waitFor(() => expect(held.waiting()).toBe(1));
    held.answer(error);
    await vi.waitFor(() => expect(held.waiting()).toBe(1));
    expect(shown()[41]).toMatchObject({ status: "removing" });
    expect(storage.saved()["1"]?.["41"]).toMatchObject({ status: "removing", operationId: 77 });
    held.answer(operation("succeeded"));
    expect(await click).toEqual({ kind: "removed" });
    expect(held.counts.destroys).toBe(1);
  });
});

describe("D. follow ended", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "D2 keeps a %s Operation as Removal failed, saved for a restart",
    async (status) => {
      const state = device();
      const orbit = gateway(async () => operation(status));
      const { ports, storage, reloadList } = removalPorts(orbit, state);
      await runOrbitInstanceRemoval(ROW, true, ports);
      expect(shown()[41]).toMatchObject({
        status: "failed",
        refused: false,
        message: "Orbit did not finish removing the Instance.",
        acknowledgeUnsaved: true,
      });
      expect(useOrbitInstanceRemovals.getState().entries["1:41"]?.follow).toBeNull();
      expect(storage.saved()["1"]?.["41"]).toMatchObject({
        status: "failed",
        acknowledgeUnsaved: true,
      });
      expect([...state.saved]).toEqual(["env-a", "env-b", "env-c"]);
      expect(reloadList).not.toHaveBeenCalled();
    },
  );

  it("D2 Retry replaces the failed entry in one step: same tick, new key, record dropped", async () => {
    let answer = operation("failed");
    const orbit = gateway(async () => answer);
    const { ports, storage } = removalPorts(orbit, device());
    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(storage.saved()["1"]?.["41"]).toBeDefined();
    answer = operation("succeeded");
    const seen: unknown[] = [];
    const unsubscribe = useOrbitInstanceRemovals.subscribe(() => seen.push(shown()[41]));
    await runOrbitInstanceRemoval(ROW, true, ports);
    unsubscribe();
    // The row went from failed straight to "Removing…", never through an empty state.
    expect(seen[0]).toMatchObject({ status: "removing" });
    expect(seen).not.toContainEqual(undefined);
    expect(shown()[41]).toEqual({ status: "removed" });
    expect(new Set(orbit.keys).size).toBe(2);
    expect(orbit.acks).toEqual([true, true]);
    expect(storage.saved()).toEqual({});
  });

  it("D3 calls a removal whose Operation Orbit no longer shows failed while the Instance is listed", async () => {
    const orbit = gateway(async () => operation("running", { pollAfterSeconds: 2 }), [notFound()]);
    const { ports, storage } = removalPorts(orbit, device(), memoryStorage(), 1, new Set([41]));
    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(shown()[41]).toMatchObject({
      status: "failed",
      message: "Conn lost track of this removal.",
    });
    expect(storage.saved()["1"]?.["41"]).toMatchObject({ status: "failed" });
  });

  it("D4 calls a removal whose Operation Orbit no longer shows removed once the list lacks it", async () => {
    const orbit = gateway(async () => operation("running", { pollAfterSeconds: 2 }), [notFound()]);
    const { ports, storage } = removalPorts(orbit, device(), memoryStorage(), 1, new Set());
    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(shown()[41]).toEqual({ status: "removed" });
    expect(storage.saved()).toEqual({});
  });
});

describe("E. page open and restore", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it("E1 follows a saved removal again and shows its failure, with Retry", async () => {
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
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
    await restoreOrbitInstanceRemovals(removalPorts(orbit, device(), storage).ports, new Set([41]));
    expect(shown()[41]).toMatchObject({
      status: "failed",
      refused: false,
      message: "The native workflow start could not connect.",
      acknowledgeUnsaved: true,
    });
    expect(storage.saved()["1"]?.["41"]).toMatchObject({ status: "failed", operationId: null });
  });

  it("E1 drops the row of a removal that succeeded while the app was closed", async () => {
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
    const orbit = gateway(async () => operation("succeeded"), [operation("succeeded")]);
    const { ports, reloadList } = removalPorts(orbit, device(), storage);
    await restoreOrbitInstanceRemovals(ports, new Set([41]));
    expect(shown()[41]).toEqual({ status: "removed" });
    expect(storage.saved()).toEqual({});
    expect(reloadList).toHaveBeenCalledOnce();
  });

  it("E2 a saved removal without an Operation id: lost while listed, removed once unlisted", async () => {
    const storage = memoryStorage({
      "1": {
        "41": savedRemoving({ operationId: null }),
        "42": savedRemoving({ operationId: null, row: { ...ROW, id: 42 } }),
      },
    });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 1, new Set([41])).ports,
      new Set([41]),
    );
    expect(shown()[41]).toMatchObject({
      status: "failed",
      message: "Conn lost track of this removal.",
    });
    expect(shown()[42]).toEqual({ status: "removed" });
    expect(orbit.keys).toEqual([]);
  });

  it("D3/D4 on restore: a saved Operation Orbit no longer shows", async () => {
    const storage = memoryStorage({
      "1": { "41": savedRemoving(), "42": savedRemoving({ row: { ...ROW, id: 42 } }) },
    });
    const orbit = gateway(async () => operation("succeeded"), [notFound(), notFound()]);
    await restoreOrbitInstanceRemovals(removalPorts(orbit, device(), storage).ports, new Set([41]));
    expect(shown()[41]).toMatchObject({
      status: "failed",
      message: "Conn lost track of this removal.",
    });
    expect(shown()[42]).toEqual({ status: "removed" });
  });

  it("E3 shows a saved failure again and forgets one whose Instance left the list", async () => {
    const storage = memoryStorage({
      "1": {
        "41": savedFailed({ message: "Swamp lost the Node." }),
        "42": savedFailed({ message: "x", row: { ...ROW, id: 42 } }),
      },
    });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(removalPorts(orbit, device(), storage).ports, new Set([41]));
    expect(shown()).toEqual({
      41: expect.objectContaining({ status: "failed", message: "Swamp lost the Node." }),
    });
    expect(Object.keys(storage.saved()["1"] ?? {})).toEqual(["41"]);
  });

  it("E4 never shows or follows a saved removal of another Orbit profile", async () => {
    const storage = memoryStorage({ "2": { "41": savedRemoving() } });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 1).ports,
      new Set([41]),
    );
    expect(shown()).toEqual({});
    expect(useOrbitInstanceRemovals.getState().entries).toEqual({});
    expect(storage.saved()["2"]?.["41"]).toBeDefined();
  });

  it("E5 a failed profile read shows no saved removal and follows none", async () => {
    const storage = memoryStorage({
      none: { "41": savedFailed() },
      "1": { "42": savedRemoving() },
    });
    const held = heldGateway();
    await restoreOrbitInstanceRemovals(
      heldPorts(held, storage, failing()).ports,
      new Set([41, 42]),
    );
    expect(shown()).toEqual({});
    expect(useOrbitInstanceRemovals.getState().entries).toEqual({});
    expect(held.counts.reads).toBe(0);
  });

  it("E6 under a new profile the earlier profile's rows stay hidden but stay in the store", async () => {
    const storage = memoryStorage({ "1": { "41": savedFailed() } });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 1).ports,
      new Set([41]),
    );
    expect(shown()[41]).toBeDefined();
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 2).ports,
      new Set([41]),
    );
    expect(shown()).toEqual({});
    expect(Object.keys(useOrbitInstanceRemovals.getState().entries)).toEqual(["1:41"]);
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 1).ports,
      new Set([41]),
    );
    expect(shown()[41]).toMatchObject({ status: "failed" });
  });

  it("E8 a reopened page does not start a second follow of a running removal", async () => {
    const held = heldGateway();
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
    void restoreOrbitInstanceRemovals(heldPorts(held, storage).ports, new Set([41]));
    await vi.waitFor(() => expect(held.counts.reads).toBe(1));
    const reopen = restoreOrbitInstanceRemovals(
      heldPorts(held, storage).ports,
      new Set([41]),
      Symbol("again"),
    );
    await settleAll();
    expect(held.counts.reads).toBe(1);
    expect(shown()[41]).toMatchObject({ status: "removing" });
    await reopen;
    held.answer(operation("succeeded"));
    await vi.waitFor(() => expect(shown()[41]).toEqual({ status: "removed" }));
    expect(held.counts.reads).toBe(1);
  });

  it("E9 before the page's profile read: only this window's own clicks, no saved row", async () => {
    const profile = heldProfile();
    const held = heldGateway();
    const storage = memoryStorage({ "1": { "41": savedFailed() } });
    const { ports } = heldPorts(held, storage, profile.read, new Set([41, 42]));
    const page = openOrbitInstanceRemovalPage(ports);
    expect(shown()).toEqual({});
    void runOrbitInstanceRemoval({ ...ROW, id: 42 }, true, ports);
    expect(Object.keys(shown())).toEqual(["42"]);
    profile.answer(1);
    await page.read;
    expect(Object.keys(shown()).sort()).toEqual(["41", "42"]);
  });

  it("E10 after an app restart the rows come back from the saved records", async () => {
    const storage = memoryStorage();
    const orbit = gateway(async () => operation("failed"));
    await runOrbitInstanceRemoval(ROW, true, removalPorts(orbit, device(), storage).ports);
    // Restart: the store is gone, localStorage stays.
    resetOrbitInstanceRemovalsForTest();
    expect(shown()).toEqual({});
    await restoreOrbitInstanceRemovals(removalPorts(orbit, device(), storage).ports, new Set([41]));
    expect(shown()[41]).toMatchObject({ status: "failed", refused: false });
  });

  it("E11 a refusal is shown only in the opening that made it", async () => {
    const orbit = gateway(async () => operation("succeeded"));
    const { ports } = removalPorts(orbit, device(), memoryStorage(), failing());
    await runOrbitInstanceRemoval(ROW, true, ports);
    expect(shown()[41]).toMatchObject({ refused: true });
    await restoreOrbitInstanceRemovals(removalPorts(orbit, device()).ports, new Set([41]));
    expect(shown()).toEqual({});
  });
});

/**
 * The blocks of the earlier review rounds. These use only the API head 682ed4e also had
 * (`runOrbitInstanceRemoval`, `restoreOrbitInstanceRemovals` and the rows shown), so they can run
 * there too.
 */
describe("earlier review blocks", () => {
  beforeEach(() => resetOrbitInstanceRemovalsForTest());

  it("profile leak: a page under profile 2 never shows profile 1's saved rows", async () => {
    const storage = memoryStorage({ "1": { "41": savedFailed() } });
    const orbit = gateway(async () => operation("succeeded"));
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 1).ports,
      new Set([41]),
    );
    await restoreOrbitInstanceRemovals(
      removalPorts(orbit, device(), storage, 2).ports,
      new Set([41]),
    );
    expect(shown()).toEqual({});
  });

  it("an earlier profile's follow never comes back after a failed profile read", async () => {
    const held = heldGateway();
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
    void restoreOrbitInstanceRemovals(heldPorts(held, storage, 1).ports, new Set([41]));
    await vi.waitFor(() => expect(held.counts.reads).toBe(1));
    await restoreOrbitInstanceRemovals(
      heldPorts(held, storage, failing()).ports,
      new Set([41]),
      Symbol("reopen"),
    );
    expect(shown()).toEqual({});
    held.answer(operation("running", { pollAfterSeconds: 2, currentStep: "Withdraw the Route" }));
    await vi.waitFor(() => expect(held.counts.reads).toBe(2));
    expect(shown()).toEqual({});
  });

  it("an own click is not dropped when another click runs after a failed profile read", async () => {
    const held = heldGateway();
    const storage = memoryStorage();
    const good = heldPorts(held, storage, 1, new Set([41, 42])).ports;
    await restoreOrbitInstanceRemovals(good, new Set([41, 42]), Symbol("open"));
    const clickX = runOrbitInstanceRemoval(ROW, true, good);
    await vi.waitFor(() => expect(held.counts.destroys).toBe(1));
    // Reopened page, failed profile read; then the user removes Y.
    const bad = heldPorts(held, storage, failing(), new Set([41, 42])).ports;
    await restoreOrbitInstanceRemovals(bad, new Set([41, 42]), Symbol("reopen"));
    await runOrbitInstanceRemoval({ ...ROW, id: 42 }, true, bad);
    expect(shown()[41]).toMatchObject({ status: "removing" });
    // A click on X still sends nothing.
    expect(await runOrbitInstanceRemoval(ROW, true, bad)).toMatchObject({ kind: "failed" });
    await restoreOrbitInstanceRemovals(good, new Set([41, 42]), Symbol("good again"));
    expect(shown()[41]).toMatchObject({ status: "removing" });
    expect(await runOrbitInstanceRemoval(ROW, true, good)).toMatchObject({
      code: "conn.remove_running",
    });
    held.answer(operation("succeeded"));
    expect(await clickX).toEqual({ kind: "removed" });
    expect(held.counts.destroys).toBe(1);
  });

  it("double destroy 1: a restored follow, a reopen with a failed profile read, then a click", async () => {
    const held = heldGateway();
    const storage = memoryStorage({ "1": { "41": savedRemoving() } });
    void restoreOrbitInstanceRemovals(heldPorts(held, storage, 1).ports, new Set([41]));
    await vi.waitFor(() => expect(held.counts.reads).toBe(1));
    const bad = heldPorts(held, storage, failing()).ports;
    await restoreOrbitInstanceRemovals(bad, new Set([41]), Symbol("reopen"));
    await runOrbitInstanceRemoval(ROW, true, bad);
    const good = heldPorts(held, storage, 1).ports;
    await restoreOrbitInstanceRemovals(good, new Set([41]), Symbol("good again"));
    await runOrbitInstanceRemoval(ROW, true, good);
    expect(held.counts.destroys).toBe(0);
    held.answer(operation("succeeded"));
    await vi.waitFor(() => expect(shown()[41]).toEqual({ status: "removed" }));
  });

  it("double destroy 2: an own click X, a failed-read reopen, a click on Y, then a click on X", async () => {
    const held = heldGateway();
    const storage = memoryStorage();
    const good = heldPorts(held, storage, 1, new Set([41, 42])).ports;
    await restoreOrbitInstanceRemovals(good, new Set([41, 42]), Symbol("open"));
    const clickX = runOrbitInstanceRemoval(ROW, true, good);
    await vi.waitFor(() => expect(held.counts.destroys).toBe(1));
    const bad = heldPorts(held, storage, failing(), new Set([41, 42])).ports;
    await restoreOrbitInstanceRemovals(bad, new Set([41, 42]), Symbol("reopen"));
    void runOrbitInstanceRemoval({ ...ROW, id: 42 }, true, good);
    await settleAll();
    void runOrbitInstanceRemoval(ROW, true, good);
    await settleAll();
    expect(held.counts.destroys).toBe(1);
    held.answer(operation("succeeded"));
    expect(await clickX).toEqual({ kind: "removed" });
  });
});
