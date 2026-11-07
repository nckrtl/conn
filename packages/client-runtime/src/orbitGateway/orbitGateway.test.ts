import { describe, expect, it } from "vite-plus/test";
import {
  createOrbitGatewayClient,
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
});
