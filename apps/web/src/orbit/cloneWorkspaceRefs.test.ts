import { describe, expect, it } from "vite-plus/test";

import type { Workspace } from "../workspaces.logic";
import { pruneGoneCloneRefs } from "./cloneWorkspaceRefs";

const workspace = (projectRefs: readonly string[]): Workspace => ({
  id: "w1",
  name: "Work",
  projectKeys: [],
  projectRefs,
  color: "blue",
  icon: null,
});

const host = { environmentId: "host", instanceId: null };
const liveClone = { environmentId: "clone-live", instanceId: 7 };
const refs = ["host:p1", "clone-live:p2", "clone-gone:p3", "manual:p4"];

describe("pruneGoneCloneRefs", () => {
  it("drops refs of remembered clones the Gateway no longer lists, and keeps the rest", () => {
    const result = pruneGoneCloneRefs({
      provider: "orbit",
      workspaces: [workspace(refs)],
      listed: [host, liveClone],
      cloneEnvironmentIds: ["clone-gone"],
    });
    expect(result.workspaces[0]?.projectRefs).toEqual(["host:p1", "clone-live:p2", "manual:p4"]);
    // The gone id stays remembered, so a ref a merge brings back is dropped again.
    expect(result.cloneEnvironmentIds).toEqual(["clone-gone", "clone-live"]);
  });

  it("drops a listed clone's ref on the run after it leaves the list", () => {
    const first = pruneGoneCloneRefs({
      provider: "orbit",
      workspaces: [workspace(refs)],
      listed: [host, liveClone],
      cloneEnvironmentIds: [],
    });
    expect(first.workspaces[0]?.projectRefs).toEqual(refs);
    const second = pruneGoneCloneRefs({
      provider: "orbit",
      workspaces: first.workspaces,
      listed: [host],
      cloneEnvironmentIds: first.cloneEnvironmentIds,
    });
    expect(second.workspaces[0]?.projectRefs).toEqual(["host:p1", "clone-gone:p3", "manual:p4"]);
  });

  it("keeps the ref of a clone no list has shown yet, such as one started after the list was read", () => {
    const workspaces = [workspace(["host:p1", "clone-new:p5"])];
    const result = pruneGoneCloneRefs({
      provider: "orbit",
      workspaces,
      listed: [host],
      cloneEnvironmentIds: [],
    });
    expect(result.workspaces).toBe(workspaces);
  });

  it.each([
    ["no list (Gateway error)", "orbit", null],
    ["an empty list", "orbit", []],
    ["Default mode", "default", [host]],
  ] as const)("changes nothing with %s", (_case, provider, listed) => {
    const workspaces = [workspace(refs)];
    const result = pruneGoneCloneRefs({
      provider,
      workspaces,
      listed,
      cloneEnvironmentIds: ["clone-gone", "clone-live"],
    });
    expect(result.workspaces).toBe(workspaces);
    expect(result.cloneEnvironmentIds).toEqual(["clone-gone", "clone-live"]);
  });
});
