import { describe, expect, it } from "vite-plus/test";

import { filterSidebarV2VisibleThreads } from "../components/Sidebar.logic";
import {
  isSidebarHiddenThread,
  NO_SIDEBAR_HIDDEN_MARKS,
  planSidebarPeek,
  sidebarHiddenMarks,
  withoutSidebarHiddenProjects,
} from "./sidebarHiddenThreads.logic";

const thread = (environmentId: string, id: string, projectId = "p1", archivedAt = null) => ({
  environmentId,
  id,
  projectId,
  archivedAt,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
});
type Row = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];
const visible = (threads: ReturnType<typeof thread>[], marks = NO_SIDEBAR_HIDDEN_MARKS) =>
  filterSidebarV2VisibleThreads(threads as unknown as Row[], null, new Set(), marks).map(
    (row) => `${row.environmentId}:${row.id}`,
  );
const group = (...members: [string, string][]) => ({
  memberProjects: members.map(([environmentId, id]) => ({ environmentId, id })),
});

describe("sidebar hidden marks", () => {
  it("hides a peeked target and its new environment's siblings, but not rows listed before", () => {
    // The local thread was listed before the peek; the clone environment is new on this device.
    expect(planSidebarPeek({ targetListed: false, environmentSurfaced: true })).toEqual({
      hideTarget: true,
      holdEnvironment: true,
    });
    const marks = sidebarHiddenMarks({
      agreed: [],
      intents: new Map([["clone:target", "hide"]]),
      held: new Set(["clone"]),
    });
    const threads = [
      thread("local", "mine"),
      thread("clone", "target"),
      thread("clone", "sibling"),
    ];
    expect(visible(threads, marks)).toEqual(["local:mine"]);
    // Its projects stay out of the list and the scope menu too, also an empty one.
    const groups = [group(["local", "p1"]), group(["clone", "p1"]), group(["clone", "empty"])];
    expect(withoutSidebarHiddenProjects(groups, threads, marks)).toEqual([groups[0]]);
  });

  it("leaves an already listed or paired target where it is", () => {
    expect(planSidebarPeek({ targetListed: true, environmentSurfaced: false })).toEqual({
      hideTarget: false,
      holdEnvironment: false,
    });
    // Paired and on, but this thread is not listed (not loaded yet): only it is hidden.
    expect(planSidebarPeek({ targetListed: false, environmentSurfaced: false })).toEqual({
      hideTarget: true,
      holdEnvironment: false,
    });
  });

  it("shows an explicitly opened thread while its hidden siblings stay hidden", () => {
    const marks = sidebarHiddenMarks({
      agreed: ["clone:target", "clone:sibling"],
      intents: new Map([["clone:target", "show"]]),
      held: new Set(["clone"]),
    });
    expect(isSidebarHiddenThread(marks, "clone", "target")).toBe(false);
    expect(isSidebarHiddenThread(marks, "clone", "sibling")).toBe(true);
    expect(isSidebarHiddenThread(marks, "clone", "arrives-later")).toBe(true);
    // The Orbit panel, the palette and rail badges filter without marks: they still find all three.
    expect(visible([thread("clone", "target"), thread("clone", "sibling")])).toEqual([
      "clone:target",
      "clone:sibling",
    ]);
  });

  it("drops a project once Disconnect hides its last row, and keeps empty projects elsewhere", () => {
    const threads = [thread("local", "a"), thread("clone", "b", "p2")];
    const groups = [group(["local", "p1"]), group(["clone", "p2"]), group(["local", "empty"])];
    const marks = sidebarHiddenMarks({
      agreed: [],
      intents: new Map([["clone:b", "hide"]]),
      held: new Set(),
    });
    expect(withoutSidebarHiddenProjects(groups, threads, marks)).toEqual([groups[0], groups[2]]);
    // Archived threads do not keep a project listed, and do not count as hidden either.
    expect(
      withoutSidebarHiddenProjects(
        [group(["local", "p1"])],
        [thread("local", "a"), { ...thread("local", "old"), archivedAt: "x" as never }],
        sidebarHiddenMarks({ agreed: ["local:a"], intents: new Map(), held: new Set() }),
      ),
    ).toEqual([]);
  });
});
