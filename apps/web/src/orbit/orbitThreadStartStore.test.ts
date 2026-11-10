import { newOrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { heldOrbitInstanceIds, saveStart, updateStarts } from "./orbitThreadStartStore";

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const start = (id: string) =>
  newOrbitThreadStart({
    id,
    project: { id: 3, slug: "mealou", name: "Mealou", nodeId: 7, nodeName: "beast" },
    message: "Fix it",
    suffix: "k3j9",
    threadId: `thread-${id}`,
    messageId: `message-${id}`,
    commandId: `command-${id}`,
    now: 0,
  });

describe("orbitThreadStartStore", () => {
  beforeEach(() => {
    const storage = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("holds the Instance of each saved start, so the environment sync leaves its server alone", () => {
    updateStarts(() => [start("a"), start("b")]);
    expect(heldOrbitInstanceIds()).toEqual([]);

    saveStart({ ...start("a"), instanceId: 41 });

    expect(heldOrbitInstanceIds()).toEqual([41]);
  });

  it("does not bring a dismissed start back when its run saves", () => {
    updateStarts(() => [start("a")]);
    updateStarts(() => []);

    saveStart({ ...start("a"), instanceId: 41 });

    expect(heldOrbitInstanceIds()).toEqual([]);
  });
});
