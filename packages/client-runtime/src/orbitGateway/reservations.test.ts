import { describe, expect, it } from "vite-plus/test";

import {
  OrbitGatewayError,
  createOrbitGatewayClient,
  type OrbitGatewayOperation,
  type OrbitGatewayRequest,
  type OrbitGatewayReservation,
} from "./client.ts";
import {
  MAX_OPEN_RESERVATIONS,
  RESERVATION_KEEPALIVE_MS,
  RESERVATION_PREPARING_POLL_MS,
  createOrbitReservations,
  type OrbitReservationClient,
} from "./reservations.ts";
import {
  newOrbitThreadStart,
  orbitThreadStartHiddenEnvironmentId,
  runOrbitThreadStart,
  type OrbitThreadStart,
} from "./threadStart.ts";

const reservation = (
  id: string,
  state: OrbitGatewayReservation["state"],
  extra: Partial<OrbitGatewayReservation> = {},
): OrbitGatewayReservation => ({
  id,
  projectId: 78,
  instanceId: 501,
  state,
  expiresAt: "2026-11-21T12:10:00Z",
  createOperationId: 300,
  environmentId: state === "preparing" ? null : `env-${id}`,
  finalizeOperationId: null,
  errorCode: null,
  ...extra,
});

const gone = () =>
  new OrbitGatewayError({
    code: "reservation.not_found",
    message: "gone",
    status: 404,
    details: {},
  });

/** A step-by-step clock: each `sleep` resolves only when the test calls `tick`. */
function scheduler() {
  const waiting: Array<{ ms: number; resolve: () => void }> = [];
  return {
    sleeps: waiting,
    sleep: (ms: number) => new Promise<void>((resolve) => waiting.push({ ms, resolve })),
    async tick() {
      const next = waiting.shift();
      next?.resolve();
      await flush();
      return next?.ms;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness(
  options: {
    reads?: Array<OrbitGatewayReservation | Error>;
    reserve?: (projectId: number) => Promise<OrbitGatewayReservation>;
    saved?: (environmentId: string) => boolean;
    stored?: string[];
  } = {},
) {
  const calls: string[] = [];
  const reads = [...(options.reads ?? [])];
  let stored: readonly string[] = options.stored ?? [];
  const clock = scheduler();
  const client: OrbitReservationClient = {
    reserve: async (projectId) => {
      calls.push(`reserve ${projectId}`);
      return options.reserve
        ? options.reserve(projectId)
        : reservation(`r${projectId}`, "preparing", { projectId });
    },
    reservation: async (id) => {
      calls.push(`read ${id}`);
      const next = reads.shift();
      if (next === undefined) return reservation(id, "ready");
      if (next instanceof Error) throw next;
      return next;
    },
    releaseReservation: async (id) => {
      calls.push(`release ${id}`);
      return null;
    },
    pair: async (environmentId) => {
      calls.push(`pair ${environmentId}`);
      return { environmentId, pairingUrl: `https://pair/${environmentId}`, expiresAt: "" };
    },
  };
  let now = 0;
  const reservations = createOrbitReservations({
    client,
    sleep: clock.sleep,
    now: () => now++,
    isSaved: options.saved ?? (() => false),
    connect: async (environmentId) => {
      calls.push(`connect ${environmentId}`);
    },
    forget: (environmentId) => {
      calls.push(`forget ${environmentId}`);
    },
    load: () => stored,
    store: (ids) => {
      stored = ids;
    },
    newKey: () => "key",
  });
  return { calls, clock, reservations, stored: () => stored };
}

describe("createOrbitReservations", () => {
  it("reserves on open, polls every 2 s while preparing, pairs once ready, then reads every 60 s", async () => {
    const { calls, clock, reservations, stored } = harness({
      reads: [reservation("r78", "preparing"), reservation("r78", "ready")],
    });
    reservations.open(78);
    reservations.open(78);
    await flush();
    expect(calls).toEqual(["reserve 78"]);
    expect(stored()).toEqual(["r78"]);
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    expect(await clock.tick()).toBe(RESERVATION_PREPARING_POLL_MS);
    expect(calls).toEqual([
      "reserve 78",
      "read r78",
      "read r78",
      "pair env-r78",
      "connect env-r78",
    ]);
    expect(reservations.hiddenEnvironmentIds()).toEqual(new Set(["env-r78"]));
    expect(clock.sleeps.map((entry) => entry.ms)).toEqual([RESERVATION_KEEPALIVE_MS]);
    await clock.tick();
    // Paired once; the keep-alive read only.
    expect(calls.slice(5)).toEqual(["read r78"]);
  });

  it("releases on close and forgets the paired server", async () => {
    const { calls, clock, reservations, stored } = harness({
      reads: [reservation("r78", "ready")],
    });
    reservations.open(78);
    await flush();
    await clock.tick();
    reservations.close(78);
    await flush();
    expect(calls.slice(-2)).toEqual(["release r78", "forget env-r78"]);
    expect(stored()).toEqual([]);
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
    await clock.tick();
    expect(calls.at(-1)).toBe("forget env-r78");
  });

  it("releases a reservation that Orbit admits after the prompt closed", async () => {
    let admit!: (value: OrbitGatewayReservation) => void;
    const { calls, reservations } = harness({
      reserve: () => new Promise((resolve) => (admit = resolve)),
    });
    reservations.open(78);
    reservations.close(78);
    admit(reservation("r78", "preparing"));
    await flush();
    expect(calls).toEqual(["reserve 78", "release r78"]);
  });

  it("hands a ready reservation to the send, and stops holding it", async () => {
    const { calls, clock, reservations, stored } = harness({
      reads: [reservation("r78", "ready")],
    });
    reservations.open(78);
    await flush();
    await clock.tick();
    expect(reservations.take(78)).toEqual({
      reservationId: "r78",
      instanceId: 501,
      environmentId: "env-r78",
    });
    expect(stored()).toEqual([]);
    await clock.tick();
    expect(calls).not.toContain("release r78");
    expect(calls.filter((call) => call === "read r78")).toHaveLength(1);
  });

  it("gives the send nothing while the reserve is unanswered, and releases it later", async () => {
    let admit!: (value: OrbitGatewayReservation) => void;
    const { calls, reservations } = harness({
      reserve: () => new Promise((resolve) => (admit = resolve)),
    });
    reservations.open(78);
    expect(reservations.take(78)).toBeNull();
    admit(reservation("r78", "preparing"));
    await flush();
    expect(calls).toEqual(["reserve 78", "release r78"]);
  });

  it("drops a reservation that failed, expired, or that Orbit released for a fourth", async () => {
    const failed = harness({ reads: [reservation("r78", "failed")] });
    failed.reservations.open(78);
    await flush();
    await failed.clock.tick();
    expect(failed.calls).toContain("release r78");
    expect(failed.reservations.take(78)).toBeNull();

    const released = harness({ reads: [reservation("r78", "ready"), gone()] });
    released.reservations.open(78);
    await flush();
    await released.clock.tick();
    await released.clock.tick();
    expect(released.calls.slice(-1)).toEqual(["forget env-r78"]);
    expect(released.reservations.take(78)).toBeNull();
  });

  it("keeps a reservation through a short Gateway outage", async () => {
    const outage = new OrbitGatewayError({
      code: "gateway.unreachable",
      message: "",
      status: 0,
      details: {},
    });
    const { clock, reservations } = harness({ reads: [outage, reservation("r78", "ready")] });
    reservations.open(78);
    await flush();
    await clock.tick();
    await clock.tick();
    expect(reservations.take(78)?.reservationId).toBe("r78");
  });

  it(`holds at most ${MAX_OPEN_RESERVATIONS}: a fourth Project releases the oldest`, async () => {
    const { calls, reservations } = harness();
    for (const projectId of [1, 2, 3]) reservations.open(projectId);
    await flush();
    reservations.open(4);
    await flush();
    expect(calls).toEqual(["reserve 1", "reserve 2", "reserve 3", "release r1", "reserve 4"]);
  });

  it("does not pair a server the device saved already", async () => {
    const { calls, clock, reservations } = harness({
      reads: [reservation("r78", "ready")],
      saved: () => true,
    });
    reservations.open(78);
    await flush();
    await clock.tick();
    expect(calls.some((call) => call.startsWith("pair"))).toBe(false);
  });

  it("keeps a server hidden that is being saved at close, then forgets it", async () => {
    let finishConnect!: () => void;
    const calls: string[] = [];
    const clock = scheduler();
    const reservations = createOrbitReservations({
      client: {
        reserve: async () => reservation("r78", "ready"),
        reservation: async (id) => reservation(id, "ready"),
        releaseReservation: async (id) => {
          calls.push(`release ${id}`);
          return null;
        },
        pair: async (environmentId) => ({ environmentId, pairingUrl: "u", expiresAt: "" }),
      },
      sleep: clock.sleep,
      now: () => 0,
      isSaved: () => false,
      connect: () => new Promise<void>((resolve) => (finishConnect = resolve)),
      forget: (environmentId) => {
        calls.push(`forget ${environmentId}`);
      },
      load: () => [],
      store: () => {},
      newKey: () => "key",
    });
    reservations.open(78);
    await flush();
    reservations.close(78);
    await flush();
    expect(reservations.hiddenEnvironmentIds()).toEqual(new Set(["env-r78"]));
    expect(calls).toEqual(["release r78"]);
    finishConnect();
    await flush();
    expect(calls).toEqual(["release r78", "forget env-r78"]);
    expect(reservations.hiddenEnvironmentIds().size).toBe(0);
  });

  it("releases what an earlier run of the app left open", async () => {
    const { calls, reservations, stored } = harness({ stored: ["old-1", "old-2"] });
    await reservations.releaseLeftovers();
    expect(calls).toEqual(["release old-1", "release old-2"]);
    expect(stored()).toEqual([]);
  });
});

describe("reservation calls", () => {
  function client(answers: Array<{ status: number; body: unknown }>) {
    const requests: OrbitGatewayRequest[] = [];
    const gatewayClient = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      const answer = answers.shift()!;
      return { status: answer.status, body: answer.body === "" ? "" : JSON.stringify(answer.body) };
    });
    return { requests, gatewayClient };
  }
  const wire = {
    id: "0b6c1c2e-5d7a-4a8e-9a39-1f1c0f6f6e01",
    project_id: 78,
    instance_id: 501,
    state: "ready",
    expires_at: "2026-11-21T12:10:00Z",
    create_operation_id: 300,
    environment_id: "env-1",
    finalize_operation_id: null,
    error_code: null,
  };

  it("reserves, reads, finalizes and releases with the contract's paths", async () => {
    const { requests, gatewayClient } = client([
      { status: 202, body: { data: { ...wire, state: "preparing", environment_id: null } } },
      { status: 200, body: { data: wire } },
      {
        status: 202,
        body: { data: { id: 900, kind: "instance.finalize", status: "queued", target_id: 501 } },
      },
      {
        status: 202,
        body: { data: { id: 901, kind: "instance.destroy", status: "queued", target_id: 501 } },
      },
      { status: 204, body: "" },
    ]);
    expect((await gatewayClient.reserve(78, "k1")).state).toBe("preparing");
    expect(await gatewayClient.reservation(wire.id)).toEqual({
      id: wire.id,
      projectId: 78,
      instanceId: 501,
      state: "ready",
      expiresAt: "2026-11-21T12:10:00Z",
      createOperationId: 300,
      environmentId: "env-1",
      finalizeOperationId: null,
      errorCode: null,
    });
    const finalize = await gatewayClient.finalizeReservation(wire.id, "fix-login", "k2", {
      mode: "new",
      from: "main",
    });
    expect(finalize.id).toBe(900);
    expect(await gatewayClient.releaseReservation(wire.id)).toBe(901);
    expect(await gatewayClient.releaseReservation(wire.id)).toBeNull();
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /projects/78/reservations",
      `GET /reservations/${wire.id}`,
      `POST /reservations/${wire.id}/finalize`,
      `DELETE /reservations/${wire.id}`,
      `DELETE /reservations/${wire.id}`,
    ]);
    expect(requests[0]).toMatchObject({ body: {}, idempotencyKey: "k1" });
    expect(requests[2]).toMatchObject({
      body: { name: "fix-login", branch: { mode: "new", from: "main" } },
      idempotencyKey: "k2",
    });
  });

  it("throws the Gateway's refusal code", async () => {
    const { gatewayClient } = client([
      { status: 410, body: { error: { code: "reservation.expired", message: "Expired." } } },
    ]);
    await expect(gatewayClient.finalizeReservation("r", "n", "k")).rejects.toMatchObject({
      code: "reservation.expired",
      status: 410,
    });
  });
});

function op(
  id: number,
  status: OrbitGatewayOperation["status"],
  targetId = 501,
): OrbitGatewayOperation {
  return {
    id,
    kind: "x",
    status,
    targetId,
    errorCode: status === "failed" ? "instance.finalize_failed" : null,
    pollAfterSeconds: 1,
  };
}

function startHarness(script: {
  reads?: Array<OrbitGatewayReservation | Error>;
  finalize?: () => Promise<OrbitGatewayOperation>;
  finalizeStatus?: OrbitGatewayOperation["status"];
  createReadyAfterMs?: number;
  nameLimit?: number;
}) {
  const calls: string[] = [];
  const reads = [...(script.reads ?? [])];
  let clock = 0;
  let createStartedAt = 0;
  const createWaits: number[] = [];
  const client = {
    reservation: async (id: string) => {
      calls.push(`read ${id}`);
      const next = reads.shift() ?? reservation(id, "ready");
      if (next instanceof Error) throw next;
      return next;
    },
    finalizeReservation: async (id: string, name: string, _key: string, branch?: unknown) => {
      calls.push(`finalize ${id} ${name}${branch ? " branch" : ""}`);
      return script.finalize ? script.finalize() : op(900, "queued");
    },
    releaseReservation: async (id: string) => {
      calls.push(`release ${id}`);
      return null;
    },
    createThreadInstance: async (_projectId: number, name: string) => {
      calls.push(`create ${name}`);
      createStartedAt = clock;
      return op(100, "queued", 41);
    },
    checkInstanceName: async (_projectId: number, name: string) => {
      const fits = script.nameLimit === undefined || name.length <= script.nameLimit;
      return { name, available: fits, reason: fits ? null : "domain_invalid", domain: null };
    },
    operation: async (id: number) => {
      calls.push(`operation ${id}`);
      if (id === 900) return op(900, script.finalizeStatus ?? "succeeded");
      if (id === 100 && script.createReadyAfterMs !== undefined) {
        if (clock - createStartedAt < script.createReadyAfterMs) {
          return op(id, "running", 41);
        }
        return { ...op(id, "succeeded", 41), result: { t3: { environment_id: "env-41" } } };
      }
      return op(id, "succeeded", 41);
    },
    environments: async () => {
      calls.push("environments");
      return [501, 41].map((instanceId) => ({
        environmentId: `env-${instanceId}`,
        label: "clone",
        url: "http://clone",
        serverVersion: null,
        registeredBy: null,
        registeredAt: null,
        status: "registered" as const,
        instanceId,
        powerState: "running" as const,
        projectId: 78,
        projectName: null,
        projectSlug: null,
        instanceName: null,
        nodeName: null,
        instanceUrl: null,
        reservationId: null,
      }));
    },
    startPairing: async (environmentId: string) => {
      calls.push(`pair ${environmentId}`);
      return op(200, "queued", 9);
    },
    readPairing: async (environmentId: string) => ({
      environmentId,
      pairingUrl: "u",
      expiresAt: "",
    }),
  };
  const saves: OrbitThreadStart[] = [];
  const sent: string[] = [];
  return {
    calls,
    createWaits,
    saves,
    sent,
    run: (start: OrbitThreadStart, saved: (environmentId: string) => boolean = () => false) =>
      runOrbitThreadStart(start, {
        client: client as never,
        save: (next) => saves.push(next),
        sleep: async (ms) => {
          if (calls.at(-1) === "operation 100") createWaits.push(ms);
          clock += ms;
        },
        now: () => clock,
        stopped: () => false,
        isSaved: saved,
        connect: async () => {},
        send: async (ready) => {
          sent.push(ready.environmentId);
        },
      }),
  };
}

const reservedStart = (branch = false) =>
  newOrbitThreadStart({
    id: "s1",
    project: { id: 78, slug: "orbit", nodeName: "beast" },
    message: "Fix login",
    suffix: "k3j9",
    threadId: "t1",
    messageId: "m1",
    commandId: "c1",
    now: 0,
    instanceName: "fix-login",
    reservation: { reservationId: "r1", instanceId: 501, environmentId: "env-501" },
    ...(branch ? { branch: { mode: "existing" as const, name: "feature" } } : {}),
  });

describe("runOrbitThreadStart with a reservation", () => {
  it("finalizes the pre-paired clone and sends the first message without a create or pairing", async () => {
    const harness = startHarness({});
    const start = reservedStart(true);
    expect(orbitThreadStartHiddenEnvironmentId(start)).toBe("env-501");
    expect(await harness.run(start, (id) => id === "env-501")).toBe(true);
    expect(harness.calls).toEqual([
      "read r1",
      "finalize r1 fix-login branch",
      "operation 900",
      "environments",
    ]);
    expect(harness.sent).toEqual(["env-501"]);
    const last = harness.saves.at(-1)!;
    expect(last).toMatchObject({
      environmentId: "env-501",
      instanceId: 501,
      connected: true,
      error: null,
    });
    expect(orbitThreadStartHiddenEnvironmentId(last)).toBeNull();
  });

  it("waits for a preparing reservation to become ready", async () => {
    const harness = startHarness({
      reads: [reservation("r1", "preparing"), reservation("r1", "ready")],
    });
    expect(await harness.run(reservedStart(), () => true)).toBe(true);
    expect(harness.calls.slice(0, 3)).toEqual(["read r1", "read r1", "finalize r1 fix-login"]);
  });

  it("uses ordinary pairing when the finalized server was not saved", async () => {
    const harness = startHarness({});
    expect(await harness.run(reservedStart())).toBe(true);
    expect(harness.calls).toContain("pair env-501");
    expect(harness.calls).not.toContain("create fix-login");
    expect(harness.sent).toEqual(["env-501"]);
  });

  it("fits the name derived from the prompt before finalizing", async () => {
    const harness = startHarness({ nameLimit: 20 });
    const start = {
      ...reservedStart(),
      message: "Please refactor the checkout payment flow handlers",
      nameSuffix: "k3j9",
    };
    expect(await harness.run(start)).toBe(true);
    expect(harness.calls).toContain("finalize r1 please-refac-k3j9");
    expect(harness.saves.at(-1)?.instanceName).toBe("please-refac-k3j9");
  });

  const fallbacks: ReadonlyArray<readonly [string, Parameters<typeof startHarness>[0]]> = [
    ["expired", { reads: [reservation("r1", "expired")] }],
    ["failed", { reads: [reservation("r1", "failed")] }],
    ["released (404)", { reads: [gone()] }],
    [
      "refused at finalize (410)",
      {
        finalize: async () => {
          throw new OrbitGatewayError({
            code: "reservation.expired",
            message: "",
            status: 410,
            details: {},
          });
        },
      },
    ],
    ["whose finalize failed", { finalizeStatus: "failed" }],
  ];

  it.each(fallbacks)(
    "falls back to a normal create, with no error, when the reservation is %s",
    async (_label, script) => {
      const harness = startHarness(script);
      expect(await harness.run(reservedStart())).toBe(true);
      expect(harness.calls).toContain("release r1");
      expect(harness.calls).toContain("create fix-login");
      expect(harness.sent).toEqual(["env-41"]);
      expect(harness.saves.every((save) => save.error === null)).toBe(true);
      expect(harness.saves.at(-1)).toMatchObject({ reservationId: null, instanceId: 41 });
    },
  );

  it("creates with its full time when the reservation stays preparing", async () => {
    const harness = startHarness({
      reads: Array.from({ length: 200 }, () => reservation("r1", "preparing")),
      createReadyAfterMs: 29 * 60_000,
    });
    expect(await harness.run(reservedStart())).toBe(true);
    expect(harness.calls.filter((call) => call === "read r1")).toHaveLength(61);
    expect(harness.calls).toContain("create fix-login");
    expect(harness.createWaits[0]).toBe(500);
    expect(harness.calls).not.toContain("environments");
    expect(harness.calls).toContain("pair env-41");
    expect(harness.saves.every((save) => save.error === null)).toBe(true);
  });

  it("stops on a taken name as a create would, keeping the reservation for Retry", async () => {
    const harness = startHarness({
      finalize: async () => {
        throw new OrbitGatewayError({
          code: "instance.name_taken",
          message: "Taken.",
          status: 409,
          details: {},
        });
      },
    });
    expect(await harness.run(reservedStart())).toBe(false);
    expect(harness.saves.at(-1)).toMatchObject({
      errorCode: "instance.name_taken",
      reservationId: "r1",
      createKey: null,
    });
    expect(harness.calls).not.toContain("create fix-login");
  });
});
