import { describe, expect, it } from "vite-plus/test";

import {
  orbitInstanceRemovingText,
  orbitRemoveWaitTextBehindCompletion,
} from "./OrbitInstanceRemove";

describe("orbitInstanceRemovingText", () => {
  it("keeps today's wait text while a removal waits for the Instance's setup (Q3 proposal)", () => {
    expect(orbitRemoveWaitTextBehindCompletion()).toBe("Waiting for another removal to finish");
    expect(orbitInstanceRemovingText({ kind: "waiting" }, true)).toBe(
      orbitRemoveWaitTextBehindCompletion(),
    );
    expect(orbitInstanceRemovingText({ kind: "waiting" })).toBe(
      "Waiting for another removal to finish",
    );
    expect(
      orbitInstanceRemovingText({ kind: "running", step: "Stopping its processes" }, true),
    ).toBe("Stopping its processes");
  });
});
