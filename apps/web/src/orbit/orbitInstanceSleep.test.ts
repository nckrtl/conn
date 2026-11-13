import type {
  OrbitGatewayClient,
  OrbitGatewayEnvironment,
  OrbitInstanceWakeOutcome,
} from "@t3tools/client-runtime/orbit-gateway";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createOrbitInstanceSleepController, useOrbitInstanceSleep } from "./orbitInstanceSleep";

function server(
  instanceId: number,
  powerState: "running" | "stopped",
  environmentId = `env-${instanceId}`,
): OrbitGatewayEnvironment {
  return {
    environmentId,
    label: "mealou / clone",
    url: "http://10.44.0.7:3800",
    serverVersion: null,
    registeredBy: "beast",
    registeredAt: "2026-11-13T08:00:00+00:00",
    status: "registered",
    instanceId,
    powerState,
    projectId: 3,
    projectName: "Mealou",
    projectSlug: "mealou",
    instanceName: `clone-${instanceId}`,
    nodeName: "beast",
    instanceUrl: null,
  };
}

/** The controller over fake ports that record what Conn did to each connection. */
function harness(outcome: () => Promise<OrbitInstanceWakeOutcome>) {
  let clock = 1_000_000;
  const log: string[] = [];
  const waiters: Array<{ entry: string; times: number; resolve: () => void }> = [];
  const count = (entry: string) => log.filter((item) => item === entry).length;
  const record = (entry: string) => {
    log.push(entry);
    for (const waiter of waiters) if (count(waiter.entry) >= waiter.times) waiter.resolve();
  };
  /** Resolves once the controller logged this entry `times` times (now or later). */
  const logged = (entry: string, times = 1) =>
    count(entry) >= times
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ entry, times, resolve }));
  let listing: OrbitGatewayEnvironment[] = [];
  const client = {
    environments: async () => {
      record("list");
      return listing;
    },
  } as unknown as OrbitGatewayClient;
  const controller = createOrbitInstanceSleepController({
    isSaved: () => true,
    setParked: async (environmentId, parked) => {
      record(`${parked ? "park" : "release"} ${environmentId}`);
    },
    retryNow: async (environmentId) => {
      record(`retry ${environmentId}`);
    },
    wake: async (_client, instanceId) => {
      record(`wake ${instanceId}`);
      return outcome();
    },
    now: () => clock,
    later: (run) => run(),
  });
  return {
    controller,
    client,
    log,
    logged,
    list: (next: OrbitGatewayEnvironment[]) => {
      listing = next;
      return controller.observe(client, next);
    },
    setListing: (next: OrbitGatewayEnvironment[]) => {
      listing = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const awake = async (): Promise<OrbitInstanceWakeOutcome> => ({ kind: "awake" });

beforeEach(() => {
  useOrbitInstanceSleep.setState({ parked: new Set(), unsupportedAt: null });
});

describe("createOrbitInstanceSleepController", () => {
  it("parks an asleep Instance that nobody uses: a list read wakes nothing", async () => {
    const { list, log } = harness(awake);
    await list([server(41, "stopped"), server(42, "running")]);
    await list([server(41, "stopped"), server(42, "running")]);

    expect(log).toEqual(["park env-41"]);
    expect(useOrbitInstanceSleep.getState().parked).toEqual(new Set(["env-41"]));
  });

  it("wakes an asleep Instance in use once, then connects it", async () => {
    const { controller, list, log } = harness(awake);
    await list([server(41, "stopped")]);
    const release = controller.hold("env-41");
    const second = controller.hold("env-41");
    await Promise.all([
      controller.ensureAwake("env-41", "available"),
      controller.ensureAwake("env-41", "available"),
    ]);

    expect(log).toEqual(["park env-41", "release env-41", "wake 41", "retry env-41"]);
    release();
    second();
  });

  it("does not park an Instance whose view remounts while it wakes", async () => {
    let finish: (outcome: OrbitInstanceWakeOutcome) => void = () => {};
    const { controller, list, log, logged } = harness(
      () => new Promise((resolve) => (finish = resolve)),
    );
    await list([server(41, "stopped")]);
    const first = controller.hold("env-41");
    void controller.ensureAwake("env-41", "available");
    await logged("wake 41");
    // A route swap: the old view lets go and the new one holds it.
    first();
    const second = controller.hold("env-41");
    finish({ kind: "awake" });
    await logged("retry env-41");

    expect(log).toEqual(["park env-41", "release env-41", "wake 41", "retry env-41"]);
    expect(useOrbitInstanceSleep.getState().parked).toEqual(new Set());
    second();
  });

  it("sends no wake for an awake, connected Instance", async () => {
    const { controller, list, log } = harness(awake);
    await list([server(41, "running")]);
    const release = controller.hold("env-41");
    await controller.ensureAwake("env-41", "connected");
    await controller.ensureAwake("env-41", "connecting");

    expect(log).toEqual([]);
    release();
  });

  it("leaves a failed wake to today's connection display and does not repeat it at once", async () => {
    const { controller, list, log, advance } = harness(async () => ({
      kind: "failed",
      code: "instance.t3_unready",
      message: "T3 was slow.",
    }));
    await list([server(41, "stopped")]);
    const release = controller.hold("env-41");
    await controller.ensureAwake("env-41", "available");
    await controller.ensureAwake("env-41", "reconnecting");
    advance(31_000);
    await controller.ensureAwake("env-41", "reconnecting");

    expect(log).toEqual(["park env-41", "release env-41", "wake 41", "wake 41"]);
    expect(useOrbitInstanceSleep.getState().parked).toEqual(new Set());
    release();
  });

  it("behaves as before on an older Gateway without the wake route", async () => {
    const { controller, list, log } = harness(async () => ({ kind: "unsupported" }));
    await list([server(41, "stopped"), server(43, "stopped")]);
    const release = controller.hold("env-41");
    await controller.ensureAwake("env-41", "available");
    expect(useOrbitInstanceSleep.getState().unsupportedAt).not.toBeNull();
    expect(useOrbitInstanceSleep.getState().parked).toEqual(new Set());

    log.length = 0;
    await list([server(41, "stopped"), server(43, "stopped")]);
    await controller.ensureAwake("env-41", "reconnecting");
    expect(log).toEqual([]);
    release();
  });

  it("connects an Instance another device woke, and parks one that fell asleep", async () => {
    const { list, log } = harness(awake);
    await list([server(41, "stopped"), server(42, "running")]);
    await list([server(41, "running"), server(42, "stopped")]);

    expect(log).toEqual(["park env-41", "release env-41", "park env-42"]);
  });

  it("wakes an Instance in view that fell asleep under a connected client", async () => {
    const { controller, list, setListing, log, logged } = harness(awake);
    await list([server(41, "running")]);
    const release = controller.hold("env-41");
    await controller.ensureAwake("env-41", "connected");
    // Frozen: the socket goes silent and the connection reconnects; a fresh read says asleep.
    setListing([server(41, "stopped")]);
    await controller.ensureAwake("env-41", "reconnecting");
    await logged("retry env-41");

    expect(log).toEqual(["list", "wake 41", "retry env-41"]);
    release();
  });

  it("parks an asleep Instance again once no window shows it", async () => {
    const { controller, list, log, logged } = harness(async () => ({
      kind: "failed",
      code: "gateway.unreachable",
      message: "down",
    }));
    await list([server(41, "stopped")]);
    const release = controller.hold("env-41");
    await controller.ensureAwake("env-41", "available");
    release();
    await logged("park env-41", 2);

    expect(log).toEqual(["park env-41", "release env-41", "wake 41", "park env-41"]);
  });
});
