import { describe, expect, it } from "vite-plus/test";

import {
  orbitInstanceGitFromUnsavedWork,
  orbitInstanceGitLine,
  orbitInstanceRemoveNeedsAck,
  parseOrbitInstanceGit,
  orbitInstanceGitParts,
  parseOrbitInstanceWork,
  readOrbitInstanceGit,
} from "./instanceGit.ts";
import { OrbitGatewayError } from "./client.ts";

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
  it("asks for the tick for unsaved work, a working thread or an unknown state Orbit sent", () => {
    expect(orbitInstanceRemoveNeedsAck({ git: known(0, 0), workingCount: 0 })).toBe(false);
    expect(orbitInstanceRemoveNeedsAck({ git: known(0, 0), workingCount: 1 })).toBe(true);
    expect(orbitInstanceRemoveNeedsAck({ git: known(1, 0), workingCount: 0 })).toBe(true);
    expect(orbitInstanceRemoveNeedsAck({ git: known(0, 1), workingCount: 0 })).toBe(true);
    expect(
      orbitInstanceRemoveNeedsAck({ git: { state: "unknown", reason: null }, workingCount: 0 }),
    ).toBe(true);
    // Without the list's Git state, Orbit's `instance.unsaved_work` asks for the tick.
    expect(orbitInstanceRemoveNeedsAck({ git: undefined, workingCount: 0 })).toBe(false);
    expect(orbitInstanceRemoveNeedsAck({ git: undefined, workingCount: 1 })).toBe(true);
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

const v2 = (fields: Record<string, unknown>) => ({
  state: "dirty",
  reason: null,
  read_at: "2026-11-13T20:31:02Z",
  head: "main",
  modified: { count: 0, names: [] },
  untracked: { count: 0, names: [] },
  commits: { count: 0, branch_count: 0, branches: [] },
  stashes: { count: 0, names: [] },
  ...fields,
});

describe("parseOrbitInstanceWork (contract v2)", () => {
  it("reads the four classes into one fact per line", () => {
    const git = parseOrbitInstanceWork(
      v2({
        modified: { count: 1, names: ["a"] },
        untracked: { count: 1, names: ["b"] },
        commits: {
          count: 3,
          branch_count: 2,
          branches: [
            { name: "x", count: 2 },
            { name: "y", count: 1 },
          ],
        },
        stashes: { count: 2, names: [] },
      }),
    );
    expect(orbitInstanceGitParts(git)).toEqual([
      "1 uncommitted change",
      "1 new file",
      "2 commits not pushed on branch x",
      "1 commit not pushed on branch y",
      "2 stashes",
    ]);
    expect(orbitInstanceRemoveNeedsAck({ git, workingCount: 0 })).toBe(true);
  });

  it("names at most three branches, then how many more", () => {
    const branches = ["a", "b", "c", "d", "e"].map((name) => ({ name, count: 1 }));
    const git = parseOrbitInstanceWork(v2({ commits: { count: 9, branch_count: 9, branches } }));
    expect(orbitInstanceGitParts(git).slice(3)).toEqual(["and 6 more branches"]);
  });

  it("a stash alone is work; clean is clean; v1's `work` and `unpushed` still read", () => {
    const stash = parseOrbitInstanceWork(v2({ stashes: { count: 1, names: [] } }));
    expect(orbitInstanceGitParts(stash)).toEqual(["1 stash"]);
    expect(orbitInstanceRemoveNeedsAck({ git: stash, workingCount: 0 })).toBe(true);
    const clean = parseOrbitInstanceWork(v2({ state: "clean" }));
    expect(orbitInstanceRemoveNeedsAck({ git: clean, workingCount: 0 })).toBe(false);
    const v1 = parseOrbitInstanceWork({
      ...v2({ state: "work" }),
      commits: undefined,
      unpushed: { count: 1, branch_count: 1, branches: [{ name: "x", count: 1 }] },
    });
    expect(orbitInstanceGitParts(v1)).toEqual(["1 commit not pushed on branch x"]);
  });

  it("never reads a broken or empty answer as clean", () => {
    expect(parseOrbitInstanceWork({ state: "unknown", reason: "asleep" })).toEqual({
      state: "unknown",
      reason: "asleep",
    });
    expect(parseOrbitInstanceWork(v2({ modified: null })).state).toBe("unknown");
    expect(parseOrbitInstanceWork(v2({})).state).toBe("unknown");
    expect(parseOrbitInstanceWork({ state: "fine" }).state).toBe("unknown");
    expect(parseOrbitInstanceWork(null).state).toBe("unknown");
  });

  it("reads the destroy refusal's full details, and today's integer-only details", () => {
    expect(
      orbitInstanceGitFromUnsavedWork(v2({ untracked: { count: 2, names: [] } }), undefined),
    ).toMatchObject({ state: "known", untracked: 2 });
    expect(
      orbitInstanceGitFromUnsavedWork({ state: "unknown", reason: "stopped" }, undefined),
    ).toEqual({ state: "unknown", reason: "stopped" });
  });
});

describe("readOrbitInstanceGit (the remove dialog's read on open)", () => {
  const client = (answer: () => Promise<unknown>) => ({ instanceGit: answer });

  it("reads Orbit's work state", async () => {
    expect(
      await readOrbitInstanceGit(
        client(async () => v2({ modified: { count: 1, names: [] } })),
        11,
      ),
    ).toMatchObject({ state: "known", uncommitted: 1 });
  });

  it("gives undefined (the old flow) for an older Gateway, a host Instance or any failure", async () => {
    for (const [status, code] of [
      [404, "http.404"],
      [409, "instance.not_container"],
    ] as const) {
      const error = new OrbitGatewayError({ code, message: "x", status, details: {} });
      expect(
        await readOrbitInstanceGit(
          client(async () => {
            throw error;
          }),
          11,
        ),
      ).toBeUndefined();
    }
    expect(
      await readOrbitInstanceGit(
        client(async () => null),
        11,
      ),
    ).toBeUndefined();
    expect(
      await readOrbitInstanceGit(
        { instanceGit: undefined as unknown as () => Promise<unknown> },
        11,
      ),
    ).toBeUndefined();
  });
});
