import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  pathname: "/local/a1",
  threads: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useMatches: ({ select }: { select: (matches: Array<{ pathname: string }>) => unknown }) =>
    select([{ pathname: state.pathname }]),
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) =>
    select(state.params),
}));
const NO_DELEGATED_TASKS: ReadonlySet<string> = new Set();

vi.mock("../state/entities", () => ({
  useThreadShells: () => state.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
  useDelegatedUnderParent: () => NO_DELEGATED_TASKS,
}));

import { useUiStateStore } from "../uiStateStore";
import { useWorkspaceStore } from "../workspaceStore";
import { useWorkspaceThreadNavigation } from "./useWorkspaceThreadNavigation";

function Probe() {
  useWorkspaceThreadNavigation();
  return null;
}
let renderer: ReactTestRenderer | undefined;
const env = EnvironmentId.make("local");
const ref = (id: string) => scopeThreadRef(env, ThreadId.make(id));
const workspace = (id: string) => ({
  id,
  name: id,
  color: "blue" as const,
  icon: null,
  projectKeys: [],
  projectRefs: ["local:p1"],
});
beforeEach(() => {
  state.navigate.mockClear();
  state.params = { environmentId: "local", threadId: "a1" };
  state.pathname = "/local/a1";
  state.threads = ["a1", "b1"].map((id) => ({
    environmentId: "local",
    id,
    projectId: "p1",
    archivedAt: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
  }));
  useWorkspaceStore.setState({
    workspaces: [workspace("a"), workspace("b")],
    activeWorkspaceId: "a",
    lastThreadByWorkspace: { b: ref("b1") },
    availableProjects: [],
  });
  useUiStateStore.getState().setSidebarProjectScopeKeys(["old-project-filter"]);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

describe("workspace navigation", () => {
  it("restores each workspace without saving the outgoing route into the incoming workspace", async () => {
    await act(() => {
      renderer = create(<Probe />);
    });
    expect(useWorkspaceStore.getState().lastThreadByWorkspace.a).toEqual(ref("a1"));
    await act(() => {
      useWorkspaceStore.getState().selectWorkspace("b");
    });
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "b1" },
    });
    expect(useWorkspaceStore.getState().lastThreadByWorkspace.b).toEqual(ref("b1"));
    expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);
    state.params = { environmentId: "local", threadId: "b1" };
    await act(() => {
      renderer?.update(<Probe />);
    });
    await act(() => {
      useWorkspaceStore.getState().selectWorkspace("a");
    });
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local", threadId: "a1" },
    });
    expect(useWorkspaceStore.getState().lastThreadByWorkspace.a).toEqual(ref("a1"));
  });
  it("leaves the outgoing thread when the new workspace has no previous thread", async () => {
    useWorkspaceStore.setState({ lastThreadByWorkspace: {} });
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => {
      useWorkspaceStore.getState().selectWorkspaceByName("b");
    });
    expect(state.navigate).toHaveBeenLastCalledWith({ to: "/" });
    expect(useWorkspaceStore.getState().lastThreadByWorkspace.b).toBeUndefined();
  });
  // First sync: the profile lacks this device's selection. Later sync: another device removed it.
  it.each([
    ["Settings, first sync", "/settings/connections"],
    ["Usage, later sync", "/usage"],
  ])(
    "waits for %s to close when the selected workspace goes away under it",
    async (_, pathname) => {
      await act(() => {
        renderer = create(<Probe />);
      });
      state.params = {};
      state.pathname = pathname;
      await act(() => {
        renderer?.update(<Probe />);
      });
      await act(() => {
        useWorkspaceStore.setState({ workspaces: [workspace("b")], activeWorkspaceId: null });
      });
      expect(state.navigate).not.toHaveBeenCalled();
      state.params = { environmentId: "local", threadId: "a1" };
      state.pathname = "/local/a1";
      await act(() => {
        renderer?.update(<Probe />);
      });
      expect(state.navigate).toHaveBeenCalledTimes(1);
      expect(state.navigate).toHaveBeenLastCalledWith({ to: "/" });
    },
  );
});
