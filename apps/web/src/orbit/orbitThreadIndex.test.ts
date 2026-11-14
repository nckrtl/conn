import type { OrbitThreadIndex } from "@t3tools/client-runtime/orbit-gateway";
import { EMPTY_ORBIT_THREAD_INDEX_STATE } from "@t3tools/client-runtime/orbit-gateway";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createOrbitThreadIndex, useOrbitThreadIndexStore } from "./orbitThreadIndex";

const ANSWER: OrbitThreadIndex = {
  rows: [
    {
      environmentId: "inner-a",
      instanceId: 41,
      projectId: 3,
      threadId: "t-1",
      title: "From the index",
      state: "idle",
      needsInput: false,
      lastUserMessageAt: null,
      lastRunCompletedAt: null,
      seenAt: "2026-11-14T14:00:00Z",
    },
  ],
  environments: [
    {
      environmentId: "inner-a",
      instanceId: 41,
      powerState: "running",
      readAt: "2026-11-14T14:00:00Z",
      readError: null,
    },
  ],
};

function harness(enabled: boolean, held: string[]) {
  const calls = { heldNow: 0, threads: 0 };
  const index = createOrbitThreadIndex({
    enabled: () => enabled,
    heldNow: async () => {
      calls.heldNow += 1;
      return new Set(held);
    },
  });
  const client = {
    threads: async () => {
      calls.threads += 1;
      return ANSWER;
    },
  };
  return { index, client, calls };
}

describe("createOrbitThreadIndex", () => {
  beforeEach(() => {
    useOrbitThreadIndexStore.setState({ index: EMPTY_ORBIT_THREAD_INDEX_STATE, held: new Set() });
  });

  it("flag off: no registry read, no Gateway call, the store stays empty", async () => {
    const { index, client, calls } = harness(false, ["inner-a"]);
    await index.load(client);
    await index.refreshHeld();
    expect(calls).toEqual({ heldNow: 0, threads: 0 });
    expect(useOrbitThreadIndexStore.getState().index).toBe(EMPTY_ORBIT_THREAD_INDEX_STATE);
    expect(useOrbitThreadIndexStore.getState().held.size).toBe(0);
  });

  it("flag on, nothing held: no Gateway call", async () => {
    const { index, client, calls } = harness(true, []);
    await index.load(client);
    expect(calls).toEqual({ heldNow: 1, threads: 0 });
  });

  it("flag on with a held-off server: one index read, kept in the store", async () => {
    const { index, client, calls } = harness(true, ["inner-a"]);
    await index.load(client);
    expect(calls.threads).toBe(1);
    const state = useOrbitThreadIndexStore.getState();
    expect([...state.held]).toEqual(["inner-a"]);
    expect(state.index.servers.get("inner-a")?.rows.map((row) => row.title)).toEqual([
      "From the index",
    ]);
  });

  it("a failed read keeps the last rows", async () => {
    const { index, client } = harness(true, ["inner-a"]);
    await index.load(client);
    const kept = useOrbitThreadIndexStore.getState().index;
    await index.load({
      threads: async () => {
        throw new Error("gateway down");
      },
    });
    expect(useOrbitThreadIndexStore.getState().index).toBe(kept);
  });
});
