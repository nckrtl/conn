import type { StoredAttachedServers } from "@t3tools/client-runtime/connection";
import type {
  OrbitGatewayEnvironment,
  OrbitGatewayNode,
  OrbitGatewaySettings,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { createAttachedServers } from "./attachedServers";

function server(environmentId: string, instanceId: number | null): OrbitGatewayEnvironment {
  return {
    environmentId,
    label: environmentId,
    url: "http://10.44.0.7:3800",
    serverVersion: null,
    registeredBy: "beast",
    registeredAt: "2026-11-14T08:00:00+00:00",
    status: "registered",
    instanceId,
    powerState: instanceId === null ? null : "running",
    projectId: null,
    projectName: null,
    projectSlug: null,
    instanceName: null,
    nodeName: null,
    instanceUrl: null,
  };
}

const LIST = [server("outer-mini", null), server("inner-a", 41), server("inner-b", 42)];

function me(settingsVersion: number | null): OrbitGatewayNode {
  return {
    id: 11,
    name: "mini",
    wireguardIp: "10.44.0.9",
    profile:
      settingsVersion === null
        ? null
        : { id: 2, name: "conn-lane-test", settingsVersion, updatedAt: "2026-11-14T08:00:00Z" },
  };
}

function settings(threads: { environmentId: string; threadId: string }[]): OrbitGatewaySettings {
  return {
    profileId: 2,
    version: 5,
    workspaces: [],
    updatedAt: "2026-11-14T08:00:00Z",
    document: { workspaces: [], attachedThreads: { schema: 1, threads } },
    sections: { attachedThreads: { version: 2, updatedAt: null, updatedBy: null } },
  };
}

function harness(enabled: boolean, initial: StoredAttachedServers | null = null) {
  const calls: string[] = [];
  let stored = initial;
  const held = new Set<string>();
  const servers = createAttachedServers({
    enabled: () => enabled,
    load: () => {
      calls.push("load");
      return stored;
    },
    save: (record) => {
      calls.push("save");
      stored = record;
    },
    heldNow: async () => {
      calls.push("heldNow");
      return new Set(held);
    },
    setHeld: async (environmentId, hold) => {
      calls.push(`${hold ? "hold" : "release"} ${environmentId}`);
      if (hold) held.add(environmentId);
      else held.delete(environmentId);
    },
  });
  const settingsReads: number[] = [];
  const client = {
    settings: async (profileId: number) => {
      settingsReads.push(profileId);
      return settings([{ environmentId: "inner-a", threadId: "thread-1" }]);
    },
  };
  return { servers, calls, held, settingsReads, client, stored: () => stored };
}

describe("attached servers (flag connAttachedServers)", () => {
  it("flag off: no storage, no Gateway call, no registry call", async () => {
    const test = harness(false);
    await test.servers.record(test.client, me(5), LIST);
    await test.servers.apply();
    await test.servers.clear();
    expect(test.calls).toEqual([]);
    expect(test.settingsReads).toEqual([]);
  });

  it("flag on: keeps the attached set and holds off only the other container servers", async () => {
    const test = harness(true);
    await test.servers.record(test.client, me(5), LIST);
    expect(test.settingsReads).toEqual([2]);
    expect(test.stored()).toEqual({
      schema: 1,
      profileId: 2,
      profileVersion: 5,
      version: 2,
      attached: ["inner-a"],
      containers: ["inner-a", "inner-b"],
    });
    expect(test.held).toEqual(new Set(["inner-b"]));

    // Same profile version: no settings read, no registry change.
    test.calls.length = 0;
    await test.servers.record(test.client, me(5), LIST);
    expect(test.settingsReads).toEqual([2]);
    expect(test.calls.filter((call) => /^(hold|release)/.test(call))).toEqual([]);
  });

  it("a newly attached server is released before others are held", async () => {
    const test = harness(true, {
      schema: 1,
      profileId: 2,
      profileVersion: 4,
      version: 1,
      attached: ["inner-b"],
      containers: ["inner-a", "inner-b"],
    });
    test.held.add("inner-a");
    await test.servers.record(test.client, me(5), LIST);
    expect(test.calls.filter((call) => /^(hold|release)/.test(call))).toEqual([
      "release inner-a",
      "hold inner-b",
    ]);
  });

  it("no profile, or leaving Orbit mode, holds nothing off", async () => {
    const test = harness(true);
    await test.servers.record(test.client, me(5), LIST);
    expect(test.held.size).toBe(1);
    await test.servers.record(test.client, me(null), LIST);
    expect(test.held.size).toBe(0);
    await test.servers.record(test.client, me(6), LIST);
    expect(test.held.size).toBe(1);
    await test.servers.clear();
    expect(test.stored()).toBeNull();
    expect(test.held.size).toBe(0);
  });

  it("two applies at once end on the newest record", async () => {
    const base = { schema: 1, profileId: 2, profileVersion: 5, containers: ["inner-x"] } as const;
    let stored: StoredAttachedServers = { ...base, version: 1, attached: [] };
    const held = new Set<string>();
    const servers = createAttachedServers({
      enabled: () => true,
      load: () => stored,
      save: () => {},
      // Slow read: without serialization the second run would plan from the same empty state.
      heldNow: async () => {
        for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
        return new Set(held);
      },
      setHeld: async (environmentId, hold) => {
        if (hold) held.add(environmentId);
        else held.delete(environmentId);
      },
    });
    const first = servers.apply();
    stored = { ...base, version: 2, attached: ["inner-x"] };
    const second = servers.apply();
    await Promise.all([first, second]);
    expect(held.size).toBe(0);
  });

  it("turning the flag off releases what this window held", async () => {
    let enabled = true;
    const held = new Set<string>(["inner-b"]);
    const servers = createAttachedServers({
      enabled: () => enabled,
      load: () => ({
        schema: 1,
        profileId: 2,
        profileVersion: 5,
        version: 1,
        attached: ["inner-a"],
        containers: ["inner-a", "inner-b"],
      }),
      save: () => {},
      heldNow: async () => new Set(held),
      setHeld: async (environmentId, hold) => {
        if (hold) held.add(environmentId);
        else held.delete(environmentId);
      },
    });
    await servers.apply();
    expect(servers.heldAnything()).toBe(true);
    enabled = false;
    await servers.releaseIfOff();
    expect(held.size).toBe(0);
    expect(servers.heldAnything()).toBe(false);
  });

  it("a profile that never wrote the section holds nothing off", async () => {
    const test = harness(true);
    const client = {
      settings: async () => ({
        ...settings([]),
        document: { workspaces: [] },
        sections: {},
      }),
    };
    await test.servers.record(client, me(5), LIST);
    expect(test.stored()?.version).toBe(0);
    expect(test.held.size).toBe(0);
  });
});
