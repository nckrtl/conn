import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Two desktop windows share the workspace store through localStorage. This
// window is the main one; the test plays the second window, which shows the
// same workspace on another thread and writes its own last thread back.
const fake = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const items = new Map<string, string>();
  const listeners = new Set<(event: unknown) => void>();
  const writes: string[] = [];
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      items.set(key, value);
    },
    removeItem: (key: string) => void items.delete(key),
  };
  const reportWorkspace = vi.fn(
    async (_workspace: { id: string | null; name: string | null }) => {},
  );
  (globalThis as { window?: unknown }).window = {
    localStorage,
    desktopBridge: { reportWorkspace },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "storage") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "storage") listeners.delete(listener);
    },
  };
  /** Another window writes `key`: store it, then fire `storage` here. */
  const writeFromOtherWindow = (key: string, value: string) => {
    items.set(key, value);
    for (const listener of listeners) listener({ storageArea: localStorage, key, newValue: value });
  };
  return { items, writes, reportWorkspace, writeFromOtherWindow };
});

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
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) =>
    select(routerState.params),
}));
vi.mock("../state/entities", () => ({
  useThreadShells: () => routerState.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
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

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
});

describe("workspace store across windows", () => {
  it("reports the workspace once per real change while another window writes its last thread", async () => {
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: "a" });
    await act(() => {
      renderer = create(<Probe />);
    });
    await settle();
    fake.reportWorkspace.mockClear();
    fake.writes.length = 0;

    // The other window answers every write of ours with its own last thread,
    // as its navigation effect does. Bound the exchange so a loop ends the test.
    const otherThread = scopeThreadRef(env, ThreadId.make("a2"));
    let answers = 0;
    let handled = 0;
    const answer = () => {
      const stored = JSON.parse(fake.items.get(WORKSPACE_STORAGE_KEY)!) as {
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
});
