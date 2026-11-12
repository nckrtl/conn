import { newOrbitThreadStart } from "@t3tools/client-runtime/orbit-gateway";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { heldOrbitInstanceIds, readStored, saveStart, updateStarts } from "./orbitThreadStartStore";

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
    project: { id: 3, slug: "mealou", nodeName: "beast" },
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

  it("drops a start saved without a launch command id, which could not resume safely", () => {
    const { commandId: _commandId, ...old } = start("old");
    window.localStorage.setItem("conn:orbit-thread-starts:v1", JSON.stringify([old, start("new")]));

    expect(readStored().map((entry) => entry.id)).toEqual(["new"]);
  });

  it("turns an unsent start of the old sidebar dialog into a pending thread, so it stays visible", () => {
    // A row as the removed dialog saved it before version 2: no pendingThread, no stage times.
    const dialogRow = {
      id: "dialog",
      projectId: 3,
      projectSlug: "mealou",
      nodeName: "beast",
      instanceName: "fix-it-k3j9",
      message: "Fix it",
      threadId: "thread-dialog",
      messageId: "message-dialog",
      commandId: "command-dialog",
      createdAt: 0,
      createKey: "key-1",
      createOperationId: 17,
      instanceId: null,
      environmentId: null,
      pairingKey: null,
      pairingOperationId: null,
      pairingId: null,
      pairingLinkRead: false,
      connected: false,
      error: "Orbit could not create the clone.",
    };
    const sentDialogRow = { ...dialogRow, id: "sent", environmentId: "clone", sentAt: 4 };
    window.localStorage.setItem(
      "conn:orbit-thread-starts:v1",
      JSON.stringify([dialogRow, sentDialogRow]),
    );

    expect(readStored()).toEqual([
      expect.objectContaining({
        id: "dialog",
        pendingThread: true,
        createOperationId: 17,
        error: "Orbit could not create the clone.",
        projectName: null,
      }),
      // Its send finished; the runner drops it rather than showing it.
      expect.objectContaining({ id: "sent", pendingThread: false }),
    ]);
  });

  it("does not bring a dismissed start back when its run saves", () => {
    updateStarts(() => [start("a")]);
    updateStarts(() => []);

    saveStart({ ...start("a"), instanceId: 41 });

    expect(heldOrbitInstanceIds()).toEqual([]);
  });
});
