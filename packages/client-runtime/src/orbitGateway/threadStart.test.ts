import { describe, expect, it } from "vite-plus/test";

import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayEnvironment,
  type OrbitGatewayOperation,
} from "./client.ts";
import {
  newOrbitThreadStart,
  orbitThreadInstanceName,
  runOrbitThreadStart,
  type OrbitThreadStart,
} from "./threadStart.ts";

const project = { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" };

function op(
  id: number,
  targetId: number,
  status: OrbitGatewayOperation["status"],
  errorCode: string | null = null,
): OrbitGatewayOperation {
  return { id, kind: "x", status, targetId, errorCode, pollAfterSeconds: 2 };
}

function server(instanceId: number, powerState: "running" | "stopped" = "running") {
  return {
    environmentId: `env-${instanceId}`,
    label: "mealou / clone",
    url: "http://10.44.0.7:3800",
    serverVersion: null,
    registeredBy: "beast",
    registeredAt: "2026-11-10T08:00:00+00:00",
    status: "registered",
    instanceId,
    powerState,
  } satisfies OrbitGatewayEnvironment;
}

/** A Gateway whose Operations answer from scripted status lists, and that records every call. */
function gateway(script: {
  readonly create?: ReadonlyArray<OrbitGatewayOperation["status"]>;
  readonly pairing?: ReadonlyArray<OrbitGatewayOperation["status"]>;
  readonly readPairing?: () => Promise<{ pairingUrl: string }>;
  readonly servers?: ReadonlyArray<OrbitGatewayEnvironment>;
}) {
  const calls: string[] = [];
  const statuses = new Map<number, OrbitGatewayOperation["status"][]>([
    [100, [...(script.create ?? ["running", "succeeded"])]],
    [200, [...(script.pairing ?? ["queued", "succeeded"])]],
  ]);
  const client = {
    createThreadInstance: async (projectId: number, name: string) => {
      calls.push(`create ${projectId} ${name}`);
      statuses.set(100, [...(script.create ?? ["running", "succeeded"])]);
      return op(100, 41, "queued");
    },
    operation: async (id: number) => {
      calls.push(`operation ${id}`);
      const queue = statuses.get(id)!;
      const status = queue.length > 1 ? queue.shift()! : queue[0]!;
      return op(
        id,
        id === 100 ? 41 : 9,
        status,
        status === "failed" ? "instance.t3_unready" : null,
      );
    },
    environments: async () => {
      calls.push("environments");
      return script.servers ?? [server(41)];
    },
    startPairing: async (environmentId: string) => {
      calls.push(`pair ${environmentId}`);
      return op(200, 9, "queued");
    },
    readPairing: async (environmentId: string, pairingId: number) => {
      calls.push(`read ${environmentId} ${pairingId}`);
      return script.readPairing
        ? { environmentId, expiresAt: "", ...(await script.readPairing()) }
        : { environmentId, pairingUrl: "http://10.44.0.7:3800/pair#token=t", expiresAt: "" };
    },
  } as unknown as OrbitGatewayClient;
  return { client, calls };
}

function ports(
  client: OrbitGatewayClient,
  options: { saved?: boolean; sendFails?: boolean; stopped?: () => boolean } = {},
) {
  const saves: OrbitThreadStart[] = [];
  const connected: string[] = [];
  const sent: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  return {
    saves,
    connected,
    sent,
    sleeps,
    ports: {
      client,
      save: (start: OrbitThreadStart) => saves.push(start),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      stopped: options.stopped ?? (() => false),
      isSaved: () => options.saved ?? false,
      connect: async (_environmentId: string, url: string) => {
        connected.push(url);
      },
      send: async (start: OrbitThreadStart & { environmentId: string }) => {
        if (options.sendFails) throw new Error("The clone's workspace project did not appear.");
        sent.push(`${start.environmentId} ${start.threadId} ${start.message}`);
      },
    },
  };
}

const fresh = () =>
  newOrbitThreadStart({
    id: "s1",
    project,
    message: "Fix the login bug on iOS!",
    suffix: "k3j9",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
  });

describe("orbitThreadInstanceName", () => {
  it("makes an Instance name from the first words of the message", () => {
    expect(orbitThreadInstanceName("Fix the login bug on iOS!", "k3j9")).toBe(
      "fix-the-login-bug-on-ios-k3j9",
    );
    expect(orbitThreadInstanceName("Één   café — naïve", "a1b2")).toBe("een-cafe-naive-a1b2");
    expect(orbitThreadInstanceName("!!!", "a1b2")).toBe("thread-a1b2");
    const long = orbitThreadInstanceName("a".repeat(80), "a1b2");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("runOrbitThreadStart", () => {
  it("creates the clone, pairs with its server once and sends the first message there", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls).toEqual([
      "create 3 fix-the-login-bug-on-ios-k3j9",
      "operation 100",
      "operation 100",
      "environments",
      "pair env-41",
      "operation 200",
      "operation 200",
      "read env-41 9",
    ]);
    expect(run.connected).toEqual(["http://10.44.0.7:3800/pair#token=t"]);
    expect(run.sent).toEqual(["env-41 thread-1 Fix the login bug on iOS!"]);
    expect(run.saves.at(-1)).toMatchObject({
      createOperationId: 100,
      instanceId: 41,
      environmentId: "env-41",
      pairingOperationId: null,
      connected: true,
      error: null,
    });
  });

  it("resumes a saved start without a second create or pairing", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);
    const saved: OrbitThreadStart = {
      ...fresh(),
      createOperationId: 100,
      instanceId: 41,
      environmentId: "env-41",
      pairingOperationId: 200,
      pairingId: 9,
    };

    expect(await runOrbitThreadStart(saved, run.ports)).toBe(true);

    expect(calls.filter((call) => call.startsWith("create") || call.startsWith("pair"))).toEqual(
      [],
    );
    expect(run.connected).toHaveLength(1);
  });

  it("pairs not at all when the device saved the server already", async () => {
    const { client, calls } = gateway({});
    const run = ports(client, { saved: true });

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);

    expect(calls.some((call) => call.startsWith("pair") || call.startsWith("read"))).toBe(false);
    expect(run.sent).toHaveLength(1);
  });

  it("stops on a failed create, and a retry creates the same name again", async () => {
    const { client, calls } = gateway({ create: ["running", "failed"] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({
      createOperationId: null,
      error: expect.stringContaining("instance.t3_unready"),
    });

    const retry = gateway({});
    expect(await runOrbitThreadStart(stopped, ports(retry.client).ports)).toBe(true);
    expect(retry.calls[0]).toBe(`create 3 ${stopped.instanceName}`);
    expect(calls.filter((call) => call.startsWith("pair"))).toEqual([]);
  });

  it("stops without a second pairing when the link was already read", async () => {
    const { client, calls } = gateway({
      readPairing: async () => {
        throw new OrbitGatewayError({
          code: "http.409",
          message: "Conflict",
          status: 409,
          details: {},
        });
      },
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(calls.filter((call) => call.startsWith("pair"))).toEqual(["pair env-41"]);
    expect(run.connected).toEqual([]);
    expect(run.saves.at(-1)).toMatchObject({
      environmentId: "env-41",
      pairingOperationId: null,
      connected: false,
      error: "The pairing link was already used or expired.",
    });
  });

  it("drops a pairing whose link was read when the connect fails, so a retry pairs anew", async () => {
    const { client } = gateway({});
    const run = ports(client);
    run.ports.connect = async () => {
      throw new Error("The clone did not answer.");
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(run.saves.at(-1)).toMatchObject({
      environmentId: "env-41",
      pairingOperationId: null,
      pairingId: null,
      pairingLinkRead: false,
      connected: false,
      error: "The clone did not answer.",
    });
  });

  it("waits for Retry when a reload comes after the link was read and before the server was saved", async () => {
    const { client, calls } = gateway({});
    const run = ports(client);
    const reloaded: OrbitThreadStart = {
      ...fresh(),
      createOperationId: 100,
      instanceId: 41,
      environmentId: "env-41",
      pairingLinkRead: true,
    };

    expect(await runOrbitThreadStart(reloaded, run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(calls).toEqual([]);
    expect(stopped).toMatchObject({
      pairingLinkRead: false,
      error: expect.stringContaining("link"),
    });

    const retry = gateway({});
    expect(await runOrbitThreadStart(stopped, ports(retry.client).ports)).toBe(true);
    expect(retry.calls.filter((call) => call.startsWith("pair"))).toEqual(["pair env-41"]);
  });

  it("stops a pairing that does not finish within 60 s, and keeps a slow create for the retry", async () => {
    const pairing = gateway({ pairing: ["running"] });
    const run = ports(pairing.client);
    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(run.saves.at(-1)).toMatchObject({
      pairingOperationId: null,
      error: expect.stringContaining("operation.timeout"),
    });
    // One 2 s poll of the create, then the pairing's 60 s.
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(62_000);

    const create = gateway({ create: ["running"] });
    const slow = ports(create.client);
    expect(await runOrbitThreadStart(fresh(), slow.ports)).toBe(false);
    expect(slow.saves.at(-1)).toMatchObject({ createOperationId: 100, environmentId: null });
  });

  it("never polls faster than every 0.5 s", async () => {
    const { client } = gateway({});
    const operation = client.operation;
    const fast = {
      ...client,
      operation: async (id: number) => ({ ...(await operation(id)), pollAfterSeconds: 0 }),
    } as OrbitGatewayClient;
    const run = ports(fast);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);
    expect(run.sleeps.every((ms) => ms >= 500)).toBe(true);
  });

  it("ends a dismissed start at the next step without saving it", async () => {
    const { client, calls } = gateway({ create: ["running", "running", "succeeded"] });
    let dismissed = false;
    const run = ports(client, { stopped: () => dismissed });
    const original = run.ports.sleep;
    run.ports.sleep = async (ms: number) => {
      dismissed = true;
      await original(ms);
    };

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(calls.filter((call) => call.startsWith("operation"))).toEqual(["operation 100"]);
    expect(run.saves.every((start) => start.error === null)).toBe(true);
  });

  it("does not pair with a server whose registration expired", async () => {
    const { client, calls } = gateway({
      servers: [{ ...server(41), status: "session_expired" }],
    });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    expect(calls.some((call) => call.startsWith("pair"))).toBe(false);
    expect(run.saves.at(-1)?.error).toContain("expired");
  });

  it("rides out a short Gateway outage while it follows the create", async () => {
    const { client, calls } = gateway({});
    const operation = client.operation;
    let failures = 2;
    const flaky = {
      ...client,
      operation: async (id: number) => {
        if (id === 100 && failures-- > 0) {
          throw new OrbitGatewayError({
            code: "gateway.unreachable",
            message: "down",
            status: 0,
            details: {},
          });
        }
        return operation(id);
      },
    } as OrbitGatewayClient;
    const run = ports(flaky);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(true);
    expect(calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
  });

  it("keeps the pairing when the send fails, so a retry only sends", async () => {
    const { client } = gateway({});
    const run = ports(client, { sendFails: true });

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);
    const stopped = run.saves.at(-1)!;
    expect(stopped).toMatchObject({ connected: true, error: expect.stringContaining("workspace") });

    const retry = gateway({});
    const again = ports(retry.client);
    expect(await runOrbitThreadStart(stopped, again.ports)).toBe(true);
    expect(retry.calls).toEqual([]);
    expect(again.sent).toHaveLength(1);
  });

  it("stops on a clone whose container is asleep", async () => {
    const { client } = gateway({ servers: [server(41, "stopped")] });
    const run = ports(client);

    expect(await runOrbitThreadStart(fresh(), run.ports)).toBe(false);

    expect(run.saves.at(-1)).toMatchObject({
      environmentId: null,
      error: expect.stringContaining("asleep"),
    });
  });
});
