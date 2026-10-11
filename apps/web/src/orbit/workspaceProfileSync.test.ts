import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import {
  parseWorkspaceProfileSyncState,
  syncWorkspaceProfile,
  type WorkspaceProfileSyncPorts,
  type WorkspaceProfileSyncState,
} from "./workspaceProfileSync";

const ws = (id: string, name = id): OrbitGatewayWorkspace => ({
  id,
  name,
  color: "sky",
  icon: null,
  image: null,
  projectRefs: [],
  projectKeys: [],
});
const names = (list: readonly OrbitGatewayWorkspace[]) => list.map((entry) => entry.name);

/** An in-memory Gateway with one profile, checking versions the way the real one does. */
function gateway(initial: {
  bound?: boolean;
  version?: number;
  workspaces?: OrbitGatewayWorkspace[];
}) {
  const profile = {
    bound: initial.bound ?? true,
    version: initial.version ?? 1,
    workspaces: initial.workspaces ?? [],
  };
  const writes: number[] = [];
  const settings = () => ({
    profileId: 1,
    version: profile.version,
    workspaces: profile.workspaces,
    updatedAt: "",
  });
  const client = {
    me: async () => ({
      id: 8,
      name: "nick",
      wireguardIp: "10.44.0.6",
      profile: profile.bound
        ? { id: 1, name: "Nick", settingsVersion: profile.version, updatedAt: "" }
        : null,
    }),
    settings: async () => settings(),
    replaceWorkspaces: async (
      _id: number,
      version: number,
      workspaces: readonly OrbitGatewayWorkspace[],
    ) => {
      if (version !== profile.version) {
        throw new OrbitGatewayError("conn.settings_version_conflict", "stale", 409, {
          current_version: profile.version,
        });
      }
      profile.version += 1;
      profile.workspaces = [...workspaces];
      writes.push(profile.version);
      return settings();
    },
  } as unknown as OrbitGatewayClient;
  return { client, profile, writes };
}

function device(
  client: OrbitGatewayClient,
  local: OrbitGatewayWorkspace[],
  state: WorkspaceProfileSyncState | null = null,
) {
  const memory = { local, state };
  const ports: WorkspaceProfileSyncPorts = {
    client,
    readLocal: () => memory.local,
    writeLocal: (workspaces) => {
      memory.local = [...workspaces];
    },
    loadState: () => memory.state,
    saveState: (next) => {
      memory.state = next;
    },
  };
  return { ports, memory };
}

describe("syncWorkspaceProfile", () => {
  it("does nothing while the device has no profile", async () => {
    const { client } = gateway({ bound: false });
    const { ports, memory } = device(client, [ws("a")]);
    await expect(syncWorkspaceProfile(ports)).resolves.toEqual({ kind: "unbound" });
    expect(names(memory.local)).toEqual(["a"]);
  });

  it("replaces local workspaces with the profile's on the first sync", async () => {
    const { client } = gateway({ version: 2, workspaces: [ws("p", "Orbit")] });
    const { ports, memory } = device(client, [ws("a", "old local")]);
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({
      kind: "pulled",
      profileName: "Nick",
    });
    expect(names(memory.local)).toEqual(["Orbit"]);
    expect(memory.state).toMatchObject({ profileId: 1, version: 2 });
  });

  it("seeds an empty profile from this device", async () => {
    const remote = gateway({ version: 1 });
    const { ports } = device(remote.client, [ws("a", "Apps")]);
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pushed" });
    expect(names(remote.profile.workspaces)).toEqual(["Apps"]);
  });

  it("sends a local edit and reads nothing when nobody else wrote", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a")] });
    const { ports, memory } = device(remote.client, [ws("a")], {
      profileId: 1,
      version: 2,
      base: [ws("a")],
    });
    memory.local = [ws("a", "renamed")];
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pushed" });
    expect(names(remote.profile.workspaces)).toEqual(["renamed"]);
    expect(memory.state?.version).toBe(3);
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "unchanged" });
    expect(remote.writes).toEqual([3]);
  });

  it("pulls another device's edit", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a")] });
    const { ports, memory } = device(remote.client, [ws("a")], {
      profileId: 1,
      version: 2,
      base: [ws("a")],
    });
    remote.profile.workspaces = [ws("a"), ws("b", "from phone")];
    remote.profile.version = 3;
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pulled" });
    expect(names(memory.local)).toEqual(["a", "from phone"]);
  });

  it("merges when both devices edited since the last sync", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a"), ws("b")] });
    const { ports, memory } = device(remote.client, [ws("a"), ws("b")], {
      profileId: 1,
      version: 2,
      base: [ws("a"), ws("b")],
    });
    remote.profile.workspaces = [ws("a"), ws("b", "B on phone")];
    remote.profile.version = 3;
    memory.local = [ws("a", "A on desktop"), ws("b")];
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "merged" });
    expect(names(remote.profile.workspaces)).toEqual(["A on desktop", "B on phone"]);
    expect(names(memory.local)).toEqual(["A on desktop", "B on phone"]);
    expect(memory.state?.version).toBe(4);
  });
});

describe("parseWorkspaceProfileSyncState", () => {
  it("accepts a stored snapshot", () => {
    const stored = JSON.parse(JSON.stringify({ profileId: 1, version: 2, base: [ws("a")] }));
    expect(parseWorkspaceProfileSyncState(stored)).toEqual({
      profileId: 1,
      version: 2,
      base: [ws("a")],
    });
    expect(parseWorkspaceProfileSyncState({ profileId: 1, version: 0, base: [] })).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "state"],
    ["a list", []],
    ["a missing profile id", { version: 1, base: [] }],
    ["a string version", { profileId: 1, version: "1", base: [] }],
    ["a missing base", { profileId: 1, version: 1 }],
    ["a base that is not a list", { profileId: 1, version: 1, base: {} }],
    ["a base entry without an id", { profileId: 1, version: 1, base: [{ name: "a" }] }],
    ["a base entry that is not an object", { profileId: 1, version: 1, base: ["a"] }],
    [
      "a base entry with bad project keys",
      { profileId: 1, version: 1, base: [{ ...ws("a"), projectKeys: [1] }] },
    ],
  ])("treats %s as no snapshot", (_name, value) => {
    expect(parseWorkspaceProfileSyncState(value)).toBeNull();
  });
});
