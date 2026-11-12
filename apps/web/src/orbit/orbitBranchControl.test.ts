import {
  OrbitGatewayError,
  type OrbitGatewayBranches,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ORBIT_BRANCHES_DEFAULT_MISSING,
  ORBIT_BRANCHES_EMPTY,
  ORBIT_BRANCHES_LOADING,
  ORBIT_BRANCHES_NO_MATCH,
  ORBIT_BRANCHES_READ_FAILED,
  createOrbitBranchSearch,
  orbitBranchControlLabel,
  orbitBranchListFailure,
  orbitBranchListStatus,
  orbitBranchMenuRows,
  orbitBranchQuery,
  type OrbitBranchListState,
} from "./orbitBranchControl";
import { readOrbitDraftTarget, type OrbitDraftTarget } from "./orbitDraft";

const list = (pullRequestsUnavailable = false): OrbitGatewayBranches => ({
  pullRequestsUnavailable,
  branches: [
    {
      name: "main",
      default: true,
      pullRequest: null,
      instance: { id: 1, name: "default" },
    },
    {
      name: "feature/login",
      default: false,
      pullRequest: { number: 482, title: "Login", url: null },
      instance: { id: 42, name: "pricing-page" },
    },
    {
      name: "fix/typo",
      default: false,
      pullRequest: { number: 7, title: null, url: null },
      instance: null,
    },
  ],
});

const summary = (rows: ReturnType<typeof orbitBranchMenuRows>) =>
  rows.map((row) => [row.name, row.pullRequestLabel, row.note, row.action.kind, row.selected]);

describe("orbitBranchMenuRows", () => {
  it("New branch from: every branch is a base, and the default means no choice", () => {
    const rows = orbitBranchMenuRows({ list: list(), mode: "new", current: null });
    expect(summary(rows)).toEqual([
      ["main", null, "default", "branch", true],
      ["feature/login", "PR #482", null, "branch", false],
      ["fix/typo", "PR #7", null, "branch", false],
    ]);
    expect(rows.map((row) => row.action)).toEqual([
      { kind: "branch", selection: null },
      { kind: "branch", selection: { mode: "new", from: "feature/login" } },
      { kind: "branch", selection: { mode: "new", from: "fix/typo" } },
    ]);
  });

  it("Work on branch: the default is disabled and another Instance's branch picks that Instance", () => {
    const rows = orbitBranchMenuRows({
      list: list(),
      mode: "existing",
      current: { mode: "existing", name: "fix/typo" },
    });
    expect(summary(rows)).toEqual([
      ["main", null, "default · the default Instance works on it", "disabled", false],
      ["feature/login", "PR #482", "in instance pricing-page", "instance", false],
      ["fix/typo", "PR #7", null, "branch", true],
    ]);
    expect(rows[1]!.action).toEqual({
      kind: "instance",
      instance: { id: 42, name: "pricing-page" },
    });
  });

  it("shows no PR badge when Orbit has no PR data for the repository", () => {
    for (const mode of ["new", "existing"] as const) {
      const rows = orbitBranchMenuRows({ list: list(true), mode, current: null });
      expect(rows.map((row) => row.pullRequestLabel)).toEqual([null, null, null]);
    }
  });
});

describe("orbitBranchControlLabel", () => {
  it("reads From main until the list named the default, then the real names", () => {
    expect(orbitBranchControlLabel({})).toBe("From main");
    expect(orbitBranchControlLabel({ defaultBranch: "trunk", branch: null })).toBe("From trunk");
    expect(orbitBranchControlLabel({ branch: { mode: "new", from: "develop" } })).toBe(
      "From develop",
    );
    expect(orbitBranchControlLabel({ branch: { mode: "existing", name: "feature/login" } })).toBe(
      "On feature/login",
    );
  });
});

describe("branch list states", () => {
  const error = (code: string, status: number) =>
    new OrbitGatewayError({ code, message: "x", status, details: {} });

  it("reads an unreadable source as a failed read, but as no match during a search", () => {
    expect(orbitBranchListFailure(error("source.head_unavailable", 502), "")).toEqual({
      status: "failed",
      message: ORBIT_BRANCHES_READ_FAILED,
      retry: true,
    });
    expect(orbitBranchListFailure(error("source.head_unavailable", 502), "a..b")).toEqual({
      status: "failed",
      message: ORBIT_BRANCHES_NO_MATCH,
      retry: true,
    });
    expect(orbitBranchListFailure(error("gateway.unreachable", 0), "x").message).toBe(
      ORBIT_BRANCHES_READ_FAILED,
    );
    expect(orbitBranchListFailure(error("instance.default_missing", 409), "")).toEqual({
      status: "failed",
      message: ORBIT_BRANCHES_DEFAULT_MISSING,
      retry: false,
    });
  });

  it("says loading, empty, no match, or nothing when rows show", () => {
    const empty: OrbitBranchListState = {
      status: "loaded",
      list: { branches: [], pullRequestsUnavailable: false },
    };
    expect(orbitBranchListStatus({ status: "loading" }, "")).toBe(ORBIT_BRANCHES_LOADING);
    expect(orbitBranchListStatus(empty, "")).toBe(ORBIT_BRANCHES_EMPTY);
    expect(orbitBranchListStatus(empty, "zzz")).toBe(ORBIT_BRANCHES_NO_MATCH);
    expect(orbitBranchListStatus({ status: "loaded", list: list() }, "")).toBeNull();
  });

  it("trims a search and cuts it to what the desktop IPC lets through", () => {
    expect(orbitBranchQuery("  login ")).toBe("login");
    expect(orbitBranchQuery("a".repeat(250))).toHaveLength(200);
  });
});

describe("createOrbitBranchSearch", () => {
  it("reads once after the typing pauses, and only the latest answer counts", async () => {
    vi.useFakeTimers();
    try {
      await debounced();
    } finally {
      vi.useRealTimers();
    }
  });

  async function debounced() {
    const answers = new Map<string, (value: OrbitGatewayBranches) => void>();
    const read = vi.fn(
      (query: string) =>
        new Promise<OrbitGatewayBranches>((resolve) => {
          answers.set(query, resolve);
        }),
    );
    const states: Array<[string, string]> = [];
    const defaults: string[] = [];
    const search = createOrbitBranchSearch({
      read,
      onState: (state, query) => states.push([state.status, query]),
      onDefaultBranch: (name) => defaults.push(name),
    });

    search.search("l");
    search.search("lo");
    search.search("log");
    vi.advanceTimersByTime(299);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read.mock.calls).toEqual([["log"]]);

    search.readNow("");
    answers.get("log")!(list());
    answers.get("")!(list());
    await vi.runAllTimersAsync();
    expect(states).toEqual([
      ["loading", "log"],
      ["loading", ""],
      ["loaded", ""],
    ]);
    expect(defaults).toEqual(["main"]);

    search.search("x");
    search.dispose();
    vi.advanceTimersByTime(1_000);
    expect(read).toHaveBeenCalledTimes(2);
  }

  it("turns a failed read into the failed state for its query", async () => {
    const search = createOrbitBranchSearch({
      read: () =>
        Promise.reject(
          new OrbitGatewayError({
            code: "source.head_unavailable",
            message: "x",
            status: 502,
            details: {},
          }),
        ),
      onState: (state) => states.push(state),
    });
    const states: OrbitBranchListState[] = [];
    search.readNow("bad..ref");
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("failed"));
    expect(states.at(-1)).toMatchObject({ message: ORBIT_BRANCHES_NO_MATCH });
  });
});

describe("readOrbitDraftTarget with a branch", () => {
  const target: OrbitDraftTarget = {
    projectId: 66,
    projectSlug: "create-bench",
    projectName: "create-bench",
    nodeName: "beast",
    instanceKind: "new",
    instanceName: "pricing-page",
    existing: null,
    domainSuffix: null,
  };

  it("round-trips each choice and reads an old target as no choice", () => {
    for (const branch of [
      null,
      { mode: "new", from: "develop" },
      { mode: "existing", name: "feature/login" },
    ] as const) {
      const saved = JSON.parse(JSON.stringify({ ...target, branch, defaultBranch: "main" }));
      expect(readOrbitDraftTarget(saved)).toEqual({ ...target, branch, defaultBranch: "main" });
    }
    expect(readOrbitDraftTarget(target)).toEqual(target);
  });

  it("drops a broken choice, or one on an existing Instance, and keeps the target", () => {
    const existing = {
      ...target,
      instanceKind: "existing",
      existing: { instanceId: 7, environmentId: "env-7" },
    };
    expect(readOrbitDraftTarget({ ...existing, branch: { mode: "new", from: "main" } })).toEqual(
      existing,
    );
    expect(readOrbitDraftTarget({ ...target, branch: { mode: "existing", name: "" } })).toEqual(
      target,
    );
    expect(readOrbitDraftTarget({ ...target, branch: { mode: "later" } })).toEqual(target);
  });
});
