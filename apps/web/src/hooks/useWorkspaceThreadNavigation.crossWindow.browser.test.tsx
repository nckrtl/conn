import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../test/render";

// Two desktop windows share the workspace store through localStorage. This
// window is the main one; the test plays the second window, which shows the
// same workspace on another thread and writes its own last thread back.
function otherWindow() {
  window.localStorage.clear();
  // Writes the other window makes skip the spy, so `writes` holds only this window's.
  const setItem = Storage.prototype.setItem;
  const writes: string[] = [];
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    writes.push(key);
    setItem.call(this, key, value);
  });
  const reportWorkspace = vi.fn(
    async (_workspace: { id: string | null; name: string | null }) => {},
  );
  const bridge = stubGlobal("desktopBridge", { reportWorkspace });
  /** Another window writes `key`: store it, then fire `storage` here. */
  const writeFromOtherWindow = (key: string, value: string) => {
    setItem.call(window.localStorage, key, value);
    window.dispatchEvent(
      new StorageEvent("storage", { storageArea: window.localStorage, key, newValue: value }),
    );
  };
  return {
    read: (key: string) => window.localStorage.getItem(key),
    writes,
    reportWorkspace,
    writeFromOtherWindow,
    [Symbol.dispose]() {
      bridge[Symbol.dispose]();
      spy.mockRestore();
      window.localStorage.clear();
    },
  };
}

const routerState = vi.hoisted(() => ({
  params: { environmentId: "local", threadId: "a1" } as Record<string, string>,
  threads: ["a1", "a2"].map((id) => ({
    environmentId: "local",
    id,
    projectId: "p1",
    archivedAt: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
  })),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<object>()),
  useNavigate: () => vi.fn(),
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) =>
    select(routerState.params),
}));
const NO_DELEGATED_TASKS: ReadonlySet<string> = new Set();

vi.mock("../state/entities", () => ({
  useThreadShells: () => routerState.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
  useDelegatedUnderParent: () => NO_DELEGATED_TASKS,
}));

import { useWorkspaceStore, WORKSPACE_STORAGE_KEY } from "../workspaceStore";
import { useWorkspaceThreadNavigation } from "./useWorkspaceThreadNavigation";

function Probe() {
  useWorkspaceThreadNavigation();
  return null;
}

const env = EnvironmentId.make("local");
const workspace = {
  id: "a",
  name: "Alpha",
  color: "blue" as const,
  icon: null,
  projectKeys: [],
  projectRefs: ["local:p1"],
};

/** Waits for the rehydrate a storage event started, and the effects it caused. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

describe("workspace store across windows", () => {
  it("reports the workspace once per real change while another window writes its last thread", async () => {
    using fake = otherWindow();
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "a" });
    // The hook's router reads are mocked above, so a real router has nothing to drive.
    await using _screen = await render(<Probe />, { router: false });
    await settle();
    fake.reportWorkspace.mockClear();
    fake.writes.length = 0;

    // The other window answers every write of ours with its own last thread,
    // as its navigation effect does. Bound the exchange so a loop ends the test.
    const otherThread = scopeThreadRef(env, ThreadId.make("a2"));
    let answers = 0;
    let handled = 0;
    const answer = () => {
      const stored = JSON.parse(fake.read(WORKSPACE_STORAGE_KEY)!) as {
        state: { lastThreadByWorkspace: Record<string, unknown> };
      };
      stored.state.lastThreadByWorkspace = { a: otherThread };
      answers += 1;
      fake.writeFromOtherWindow(WORKSPACE_STORAGE_KEY, JSON.stringify(stored));
    };
    answer();
    for (let round = 0; round < 50; round += 1) {
      await settle();
      const ours = fake.writes.filter((key) => key === WORKSPACE_STORAGE_KEY).length;
      if (ours === handled) break;
      handled = ours;
      answer();
    }

    // Nothing about the workspace changed, so nothing is reported, and this
    // window does not keep writing back.
    expect(fake.reportWorkspace).not.toHaveBeenCalled();
    expect(answers).toBeLessThanOrEqual(2);

    // A real change is reported exactly once.
    await act(() => {
      useWorkspaceStore.getState().updateWorkspace("a", { ...workspace, name: "Alpha 2" });
    });
    await settle();
    expect(fake.reportWorkspace).toHaveBeenCalledTimes(1);
    expect(fake.reportWorkspace).toHaveBeenLastCalledWith({ id: "a", name: "Alpha 2" });
  });

  it("does not report again when another window edits a workspace this window is not showing", async () => {
    using fake = otherWindow();
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "a" });
    // The hook's router reads are mocked above, so a real router has nothing to drive.
    await using _screen = await render(<Probe />, { router: false });
    await settle();
    fake.reportWorkspace.mockClear();

    const stored = JSON.parse(fake.read(WORKSPACE_STORAGE_KEY)!) as {
      state: { workspaces: unknown[] };
    };
    stored.state.workspaces = [...stored.state.workspaces, { ...workspace, id: "b", name: "Beta" }];
    fake.writeFromOtherWindow(WORKSPACE_STORAGE_KEY, JSON.stringify(stored));
    await settle();

    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(["a", "b"]);
    expect(fake.reportWorkspace).not.toHaveBeenCalled();
  });
});
