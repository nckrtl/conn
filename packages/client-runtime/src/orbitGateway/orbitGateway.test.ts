import { describe, expect, it } from "vite-plus/test";
import {
  createOrbitGatewayClient,
  isFinalPairingError,
  OrbitGatewayError,
  type OrbitGatewayRequest,
  type OrbitGatewayWorkspace,
} from "./client.ts";
import { mergeWorkspaces, sameWorkspaces } from "./workspaceMerge.ts";

const workspace = (id: string, name = id, extra: Partial<OrbitGatewayWorkspace> = {}) =>
  ({
    id,
    name,
    color: "sky",
    icon: null,
    image: null,
    projectRefs: [],
    projectKeys: [],
    ...extra,
  }) as OrbitGatewayWorkspace;
const ids = (list: readonly OrbitGatewayWorkspace[]) =>
  list.map((entry) => `${entry.id}:${entry.name}`);

describe("mergeWorkspaces", () => {
  const base = [workspace("a"), workspace("b"), workspace("c")];

  it("keeps edits from both devices to different workspaces", () => {
    const local = [workspace("a", "A local"), workspace("b"), workspace("c")];
    const remote = [workspace("a"), workspace("b", "B remote"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:A local", "b:B remote", "c:c"]);
  });

  it("lets the local edit win when both devices changed the same workspace", () => {
    const local = [workspace("a", "mine"), workspace("b"), workspace("c")];
    const remote = [workspace("a", "theirs"), workspace("b"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:mine", "b:b", "c:c"]);
  });

  it("removes a workspace deleted on one side and untouched on the other", () => {
    expect(ids(mergeWorkspaces(base, [workspace("a"), workspace("c")], base))).toEqual([
      "a:a",
      "c:c",
    ]);
    expect(ids(mergeWorkspaces(base, base, [workspace("b"), workspace("c")]))).toEqual([
      "b:b",
      "c:c",
    ]);
  });

  it("keeps a workspace one side deleted while the other edited it", () => {
    const local = [workspace("a"), workspace("b", "edited"), workspace("c")];
    const remote = [workspace("a"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:a", "b:edited", "c:c"]);
  });

  it("keeps a workspace another device edited while this one deleted it", () => {
    const local = [workspace("a"), workspace("c")];
    const remote = [workspace("a"), workspace("b", "edited"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:a", "b:edited", "c:c"]);
  });

  it("keeps new workspaces from both sides next to their neighbours", () => {
    const local = [workspace("a"), workspace("x"), workspace("b"), workspace("c")];
    const remote = [workspace("a"), workspace("b"), workspace("c"), workspace("y")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["a:a", "x:x", "b:b", "c:c", "y:y"]);
  });

  it("uses the local order when only this device reordered", () => {
    const local = [workspace("c"), workspace("a"), workspace("b")];
    const remote = [workspace("a"), workspace("b", "B remote"), workspace("c")];
    expect(ids(mergeWorkspaces(base, local, remote))).toEqual(["c:c", "a:a", "b:B remote"]);
  });

  it("compares strings as the Gateway stores them", () => {
    const stored = workspace("a", "Work", { icon: null, image: null, projectRefs: ["env:p"] });
    const sent = workspace("a", " Work ", { icon: "  ", image: "", projectRefs: [" env:p ", ""] });
    expect(sameWorkspaces([stored], [sent])).toBe(true);
    expect(sameWorkspaces([stored], [workspace("a", "Work", { icon: "folder" })])).toBe(false);
  });

  it("compares content, not identity", () => {
    expect(
      sameWorkspaces(
        base,
        base.map((entry) => ({ ...entry })),
      ),
    ).toBe(true);
    expect(
      sameWorkspaces(base, [workspace("a", "a", { projectRefs: ["env:p"] }), base[1]!, base[2]!]),
    ).toBe(false);
  });
});

describe("createOrbitGatewayClient", () => {
  const respond = (status: number, body: unknown) => async () => ({
    status,
    body: JSON.stringify(body),
  });

  it("reads the calling node and its profile", async () => {
    const client = createOrbitGatewayClient(
      respond(200, {
        data: {
          id: 8,
          name: "nick",
          wireguard_ip: "10.44.0.6",
          profile: {
            id: 1,
            name: "Nick",
            settings_version: 2,
            updated_at: "2026-10-10T00:00:00+00:00",
          },
        },
      }),
    );
    await expect(client.me()).resolves.toEqual({
      id: 8,
      name: "nick",
      wireguardIp: "10.44.0.6",
      profile: { id: 1, name: "Nick", settingsVersion: 2, updatedAt: "2026-10-10T00:00:00+00:00" },
    });
  });

  it("sends the read version with a workspace replace and only the keys the Gateway accepts", async () => {
    const sent: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      sent.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: { profile_id: 1, version: 3, settings: { workspaces: [] }, updated_at: "now" },
        }),
      };
    });
    const extra = { ...workspace("a"), lastThread: "x" } as OrbitGatewayWorkspace;
    await client.replaceWorkspaces(1, 2, [extra]);
    expect(sent[0]).toEqual({
      method: "PUT",
      path: "/profiles/1/settings",
      body: { version: 2, settings: { workspaces: [workspace("a")] } },
    });
  });

  it("reads the section versions and who changed them, and tolerates a Gateway without them", async () => {
    const withSections = createOrbitGatewayClient(
      respond(200, {
        data: {
          profile_id: 1,
          version: 4,
          updated_at: "now",
          settings: { workspaces: [], appearance: { schema: 1 } },
          sections: {
            appearance: { version: 3, updated_at: "2026-10-10T10:00:00Z", updated_by: "phone" },
            "devices.desktop": { version: 1, updated_at: "later", updated_by: { name: "mac" } },
          },
        },
      }),
    );
    const read = await withSections.settings(1);
    expect(read.document.appearance).toEqual({ schema: 1 });
    expect(read.sections).toEqual({
      appearance: { version: 3, updatedAt: "2026-10-10T10:00:00Z", updatedBy: "phone" },
      "devices.desktop": { version: 1, updatedAt: "later", updatedBy: "mac" },
    });

    const legacy = createOrbitGatewayClient(
      respond(200, {
        data: { profile_id: 1, version: 4, updated_at: "now", settings: { workspaces: [] } },
      }),
    );
    expect((await legacy.settings(1)).sections).toBeNull();
  });

  it("patches sections with the versions it read and reports a stale one as a conflict", async () => {
    const sent: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      sent.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: {
            profile_id: 1,
            version: 5,
            settings: { workspaces: [] },
            updated_at: "now",
            sections: {},
          },
        }),
      };
    });
    await client.patchSections(1, {
      appearance: { version: 2, value: { schema: 1 } },
      "devices.desktop": { version: 0, value: null },
    });
    expect(sent[0]).toEqual({
      method: "PATCH",
      path: "/profiles/1/settings",
      body: {
        sections: {
          appearance: { version: 2, value: { schema: 1 } },
          "devices.desktop": { version: 0, value: null },
        },
      },
    });

    const stale = createOrbitGatewayClient(
      respond(409, {
        error: {
          code: "conn.settings_version_conflict",
          message: "stale",
          details: { current_version: 6, sections: { appearance: 3 } },
        },
      }),
    );
    await expect(stale.patchSections(1, {})).rejects.toMatchObject({
      status: 409,
      details: { sections: { appearance: 3 } },
    });
  });

  it("sends workspaces the way the Gateway stores them and never the other sections", async () => {
    const sent: OrbitGatewayRequest[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      sent.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: { profile_id: 1, version: 3, settings: { workspaces: [] }, updated_at: "now" },
        }),
      };
    });
    await client.replaceWorkspaces(1, 2, [
      workspace("a", "  Work ", { icon: " ", image: "", projectRefs: [" env:p ", " "] }),
    ]);
    await client.replaceWorkspaces(1, 3, []);
    // A PUT replaces every device type, so devices are only ever written by PATCH.
    expect(sent[0]!.body).toEqual({
      version: 2,
      settings: { workspaces: [workspace("a", "Work", { projectRefs: ["env:p"] })] },
    });
    expect(sent[1]!.body).toEqual({ version: 3, settings: { workspaces: [] } });
  });

  it("turns the Gateway's error envelope into an OrbitGatewayError", async () => {
    const client = createOrbitGatewayClient(
      respond(409, {
        error: {
          code: "conn.settings_version_conflict",
          message: "stale",
          details: { current_version: 5 },
        },
      }),
    );
    const error = await client.settings(1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrbitGatewayError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      _tag: "OrbitGatewayError",
      code: "conn.settings_version_conflict",
      status: 409,
      details: { current_version: 5 },
    });
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      _tag: "OrbitGatewayError",
      code: "conn.settings_version_conflict",
      status: 409,
      details: { current_version: 5 },
    });
  });

  it("reports a transport failure as unreachable", async () => {
    const client = createOrbitGatewayClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    const error = await client.environments().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(OrbitGatewayError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "gateway.unreachable", status: 0 });
  });

  describe("pair", () => {
    const pairing = {
      id: 1851,
      environment_id: "env-spike",
      node_id: 8,
      node_name: "nick",
      client_label: "nick via Orbit vfkeru69",
      issued_at: "2026-11-10T06:45:00+00:00",
      expires_at: "2026-11-10T06:50:04+00:00",
      revoked_at: null,
    };
    const operation = (status: string, extra: Record<string, unknown> = {}) => ({
      id: 16044,
      kind: "conn.pairing_create",
      status,
      error_code: null,
      result: null,
      poll_after_seconds: status === "running" ? 2 : null,
      ...extra,
    });
    /** Answers each request with the next scripted reply and records what was asked. */
    const scripted = (replies: ReadonlyArray<readonly [number, unknown]>) => {
      const requests: OrbitGatewayRequest[] = [];
      let next = 0;
      const transport = async (request: OrbitGatewayRequest) => {
        requests.push(request);
        const reply = replies[next++];
        if (!reply) throw new Error(`unexpected ${request.method} ${request.path}`);
        return { status: reply[0], body: JSON.stringify({ data: reply[1] }) };
      };
      return { requests, transport };
    };

    it("follows the Gateway's Operation and reads the link once it succeeded", async () => {
      const { requests, transport } = scripted([
        [202, operation("running")],
        [200, operation("running")],
        [200, operation("succeeded", { result: { backend: "issued", pairing_id: 1851 } })],
        [200, { pairing, pairing_url: "http://10.44.0.7:3801/pair#token=ABC" }],
      ]);
      const waits: number[] = [];
      const client = createOrbitGatewayClient(transport, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      });

      await expect(client.pair("env-spike")).resolves.toEqual({
        environmentId: "env-spike",
        pairingUrl: "http://10.44.0.7:3801/pair#token=ABC",
        expiresAt: "2026-11-10T06:50:04+00:00",
      });
      expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "POST /environments/env-spike/pairings",
        "GET /operations/16044",
        "GET /operations/16044",
        "GET /environments/env-spike/pairings/1851",
      ]);
      expect(waits).toEqual([2000, 2000]);
      expect(requests[0]?.timeoutMs).toBe(60_000);
    });

    it("still accepts a Gateway that answers with the link at once", async () => {
      const { requests, transport } = scripted([
        [201, { pairing, pairing_url: "http://10.44.0.7:3801/pair#token=ABC" }],
      ]);
      const client = createOrbitGatewayClient(transport);
      await expect(client.pair("env-spike")).resolves.toMatchObject({
        pairingUrl: "http://10.44.0.7:3801/pair#token=ABC",
      });
      expect(requests).toHaveLength(1);
    });

    it("reports a failed Operation with its error code and reads no link", async () => {
      const { requests, transport } = scripted([
        [202, operation("failed", { error_code: "conn.server_unreachable" })],
      ]);
      const client = createOrbitGatewayClient(transport, { sleep: async () => {} });
      await expect(client.pair("env-spike")).rejects.toMatchObject({
        code: "conn.server_unreachable",
        details: { operation_id: 16044 },
      });
      expect(requests).toHaveLength(1);
    });

    it("ends on an interrupted Operation without polling again", async () => {
      const { requests, transport } = scripted([
        [202, operation("running", { poll_after_seconds: null })],
        [200, operation("interrupted")],
      ]);
      const waits: number[] = [];
      const client = createOrbitGatewayClient(transport, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      await expect(client.pair("env-spike")).rejects.toMatchObject({ code: "operation.failed" });
      expect(requests).toHaveLength(2);
      expect(waits).toEqual([500]);
    });

    it("marks only the codes the Gateway calls final", () => {
      const error = (code: string) =>
        new OrbitGatewayError({ code, message: code, status: 0, details: {} });
      expect(isFinalPairingError(error("conn.session_rejected"))).toBe(true);
      expect(isFinalPairingError(error("conn.request_refused"))).toBe(true);
      expect(isFinalPairingError(error("conn.response_invalid"))).toBe(true);
      expect(isFinalPairingError(error("conn.pairing_outcome_unknown"))).toBe(false);
      expect(isFinalPairingError(error("gateway.unreachable"))).toBe(false);
      expect(isFinalPairingError(new Error("conn.session_rejected"))).toBe(false);
    });

    it("gives up on an Operation that does not end in time", async () => {
      let clock = 0;
      const client = createOrbitGatewayClient(
        async () => ({ status: 200, body: JSON.stringify({ data: operation("running") }) }),
        {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      );
      await expect(client.pair("env-spike")).rejects.toMatchObject({ code: "operation.timeout" });
      expect(clock).toBeGreaterThanOrEqual(60_000);
    });

    it("rejects a succeeded Operation without a pairing id", async () => {
      const { transport } = scripted([[202, operation("succeeded", { result: {} })]]);
      const client = createOrbitGatewayClient(transport);
      await expect(client.pair("env-spike")).rejects.toMatchObject({
        code: "gateway.response_invalid",
      });
    });
  });

  it("reads a server's Instance and power state, the thread Projects, and an Operation", async () => {
    const requests: OrbitGatewayRequest[] = [];
    const bodies: Record<string, unknown> = {
      "GET /environments": [
        {
          environment_id: "env-clone",
          label: "mealou / fix",
          url: "http://10.44.0.7:3800",
          status: "registered",
          instance_id: 41,
          power_state: "stopped",
        },
        { environment_id: "env-beast", label: "beast", url: "http://x", status: "registered" },
      ],
      "GET /projects": [{ id: 3, slug: "mealou", name: "Mealou", node_id: 7, node_name: "beast" }],
      "POST /projects/3/instances": {
        id: 100,
        kind: "instance.create",
        status: "queued",
        target_id: 41,
        error_code: null,
        poll_after_seconds: 2,
      },
    };
    const client = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      return {
        status: 200,
        body: JSON.stringify({ data: bodies[`${request.method} ${request.path}`] }),
      };
    });

    const servers = await client.environments();
    expect(servers.map(({ instanceId, powerState }) => ({ instanceId, powerState }))).toEqual([
      { instanceId: 41, powerState: "stopped" },
      { instanceId: null, powerState: null },
    ]);
    await expect(client.projects()).resolves.toEqual([
      { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" },
    ]);
    await expect(client.createThreadInstance(3, "fix-k3j9", "key-1")).resolves.toEqual({
      id: 100,
      kind: "instance.create",
      status: "queued",
      targetId: 41,
      errorCode: null,
      pollAfterSeconds: 2,
    });
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: "/projects/3/instances",
      body: { name: "fix-k3j9" },
      timeoutMs: 60_000,
      idempotencyKey: "key-1",
    });
  });
});
