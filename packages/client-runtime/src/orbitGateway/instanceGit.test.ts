import { describe, expect, it } from "vite-plus/test";

import {
  orbitInstanceGitFromUnsavedWork,
  orbitInstanceGitLine,
  orbitInstanceRemoveNeedsAck,
  parseOrbitInstanceGit,
} from "./instanceGit.ts";

const known = (uncommitted: number, unpushed: number) =>
  parseOrbitInstanceGit({
    state: "known",
    branch: "pricing-page",
    uncommitted,
    unpushed,
    has_upstream: true,
    read_at: "2026-11-12T10:00:00Z",
  });

describe("parseOrbitInstanceGit", () => {
  it("reads a known state and never reads a malformed one as clean", () => {
    expect(known(3, 2)).toEqual({
      state: "known",
      branch: "pricing-page",
      uncommitted: 3,
      unpushed: 2,
      hasUpstream: true,
      readAt: "2026-11-12T10:00:00Z",
    });
    expect(parseOrbitInstanceGit(undefined)).toBeUndefined();
    expect(parseOrbitInstanceGit(null)).toBeUndefined();
    for (const value of [
      { state: "known", uncommitted: 0 },
      { state: "known", uncommitted: -1, unpushed: 0 },
      { state: "known", uncommitted: "0", unpushed: 0 },
      { state: "known", uncommitted: 0.5, unpushed: 0 },
      { state: "clean" },
      "known",
    ]) {
      expect(parseOrbitInstanceGit(value), JSON.stringify(value)).toEqual({
        state: "unknown",
        reason: null,
      });
    }
    expect(parseOrbitInstanceGit({ state: "unknown", reason: "stopped" })).toEqual({
      state: "unknown",
      reason: "stopped",
    });
    expect(parseOrbitInstanceGit({ state: "unknown", reason: "later" })).toEqual({
      state: "unknown",
      reason: null,
    });
  });
});

describe("orbitInstanceGitLine", () => {
  it.each([
    [known(0, 0), "clean", "Clean"],
    [known(1, 0), "warning", "1 uncommitted change"],
    [known(3, 2), "warning", "3 uncommitted changes · 2 commits not pushed"],
    [known(0, 1), "warning", "1 commit not pushed"],
    [
      parseOrbitInstanceGit({ state: "unknown", reason: "timeout" }),
      "unknown",
      "Git state unknown",
    ],
    [undefined, "unknown", "Git state unknown"],
  ] as const)("%j reads as %s: %s", (git, tone, text) => {
    expect(orbitInstanceGitLine(git)).toEqual({ tone, text });
  });
});

describe("orbitInstanceRemoveNeedsAck", () => {
  it("asks for the tick unless Orbit says clean and no thread works", () => {
    expect(orbitInstanceRemoveNeedsAck({ git: known(0, 0), workingCount: 0 })).toBe(false);
    expect(orbitInstanceRemoveNeedsAck({ git: known(0, 0), workingCount: 1 })).toBe(true);
    expect(orbitInstanceRemoveNeedsAck({ git: known(1, 0), workingCount: 0 })).toBe(true);
    expect(orbitInstanceRemoveNeedsAck({ git: known(0, 1), workingCount: 0 })).toBe(true);
    expect(
      orbitInstanceRemoveNeedsAck({ git: { state: "unknown", reason: null }, workingCount: 0 }),
    ).toBe(true);
    expect(orbitInstanceRemoveNeedsAck({ git: undefined, workingCount: 0 })).toBe(true);
  });
});

describe("orbitInstanceGitFromUnsavedWork", () => {
  it("turns Orbit's refusal into the state the dialog warns about", () => {
    expect(
      orbitInstanceGitFromUnsavedWork({ state: "dirty", uncommitted: 4, unpushed: 0 }, known(0, 0)),
    ).toMatchObject({ state: "known", branch: "pricing-page", uncommitted: 4, unpushed: 0 });
    // A count Orbit leaves out keeps the list's count.
    expect(
      orbitInstanceGitFromUnsavedWork(
        { state: "dirty", uncommitted: null, unpushed: 1 },
        known(2, 0),
      ),
    ).toMatchObject({ uncommitted: 2, unpushed: 1 });
    // Without any count, or with a refusal that names no work, Conn cannot say what is lost.
    expect(
      orbitInstanceGitFromUnsavedWork(
        { state: "dirty", uncommitted: null, unpushed: 1 },
        undefined,
      ),
    ).toEqual({ state: "unknown", reason: null });
    expect(
      orbitInstanceGitFromUnsavedWork({ state: "dirty", uncommitted: 0, unpushed: 0 }, known(0, 0)),
    ).toEqual({ state: "unknown", reason: null });
    expect(orbitInstanceGitFromUnsavedWork({ state: "unknown" }, known(0, 0))).toEqual({
      state: "unknown",
      reason: null,
    });
  });
});
