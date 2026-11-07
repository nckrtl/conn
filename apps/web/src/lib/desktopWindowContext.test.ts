import { describe, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge } from "@t3tools/contracts";

import {
  canOpenDesktopWindows,
  diffIncomingRecord,
  isAdditionalDesktopWindow,
  markChangedRecordKeys,
  openDesktopWorkspaceWindow,
  readDesktopWindowContext,
  RecentKeyChanges,
} from "./desktopWindowContext";

describe("preload windowContext bridge", () => {
  it("treats a missing desktopBridge as the main window", () => {
    vi.stubGlobal("window", {} as Window & typeof globalThis);
    try {
      expect(readDesktopWindowContext()).toEqual({ additional: false, workspace: null });
      expect(isAdditionalDesktopWindow()).toBe(false);
      expect(canOpenDesktopWindows()).toBe(false);
      openDesktopWorkspaceWindow("Alpha");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads extra-window context and opens a workspace through the preload keys", () => {
    const openWorkspaceWindow = vi.fn(async () => {});
    vi.stubGlobal("window", {
      desktopBridge: {
        windowContext: { additional: true, workspace: "Alpha 2" },
        openWorkspaceWindow,
      } as unknown as DesktopBridge,
    });
    try {
      expect(readDesktopWindowContext()).toEqual({ additional: true, workspace: "Alpha 2" });
      expect(isAdditionalDesktopWindow()).toBe(true);
      expect(canOpenDesktopWindows()).toBe(true);
      openDesktopWorkspaceWindow("Alpha 2");
      expect(openWorkspaceWindow).toHaveBeenCalledWith("Alpha 2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("RecentKeyChanges", () => {
  it("forgets a change after its window", () => {
    let now = 1_000;
    const changes = new RecentKeyChanges(2_000, () => now);
    changes.mark("a");
    expect(changes.has("a")).toBe(true);
    now += 2_001;
    expect(changes.has("a")).toBe(false);
    expect(changes.has("b")).toBe(false);
  });
});

describe("markChangedRecordKeys", () => {
  it("marks added, changed and removed keys with the prefix", () => {
    const changes = new RecentKeyChanges(2_000);
    const same = { text: "same" };
    markChangedRecordKeys(
      changes,
      "d:",
      { kept: same, changed: { text: "old" }, removed: { text: "x" } },
      { kept: same, changed: { text: "new" }, added: { text: "y" } },
    );
    expect(["kept", "changed", "removed", "added"].map((key) => changes.has(`d:${key}`))).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });
});

describe("diffIncomingRecord", () => {
  it("takes the other window's keys unless they changed here", () => {
    const diff = diffIncomingRecord(
      { same: 1, theirs: 1, mine: 1, gone: 1, mineGone: 1 },
      { same: 1, theirs: 2, mine: 2, added: 3 },
      (key) => key === "mine" || key === "mineGone",
    );
    expect(diff.replace).toEqual([
      ["theirs", 2],
      ["added", 3],
    ]);
    expect(diff.remove).toEqual(["gone"]);
    expect(diff.localAhead).toBe(true);
  });

  it("reports no work when both copies match", () => {
    const diff = diffIncomingRecord({ a: { x: 1 } }, { a: { x: 1 } }, () => true);
    expect(diff).toEqual({ replace: [], remove: [], localAhead: false });
  });
});
