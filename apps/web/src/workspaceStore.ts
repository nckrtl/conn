import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import {
  isAdditionalDesktopWindow,
  onOtherWindowStorageChange,
  readDesktopWindowContext,
} from "./lib/desktopWindowContext";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  findWorkspace,
  reorderWorkspaces,
  meansAllProjects,
  validateWorkspaceDraft,
  workspaceNameKey,
  workspaceProjectRefs,
  type Workspace,
  type WorkspaceProject,
} from "./workspaces.logic";

export type WorkspaceDraft = Omit<Workspace, "id">;

interface WorkspaceStoreState {
  workspaces: Workspace[];
  /** The selected workspace; null shows every project. */
  activeWorkspaceId: string | null;
  lastThreadByWorkspace: Record<string, ScopedThreadRef>;
  rememberThread: (workspaceId: string | null, thread: ScopedThreadRef) => void;
  /** The sidebar's projects, published by the thread sidebar (not persisted). */
  availableProjects: readonly WorkspaceProject[];
  publishProjects: (projects: readonly WorkspaceProject[]) => void;
  selectWorkspace: (id: string | null) => void;
  /** Selects by id or name ("all" clears); returns the workspace, or null for all projects. */
  selectWorkspaceByName: (idOrName: string) => { found: boolean; workspace: Workspace | null };
  createWorkspace: (draft: WorkspaceDraft) => Workspace;
  updateWorkspace: (id: string, draft: WorkspaceDraft) => void;
  deleteWorkspace: (id: string) => void;
  /** Adds a project ref ("<environmentId>:<projectId>") to the selected workspace, if any. */
  addProjectToActiveWorkspace: (projectRef: string) => void;
  moveWorkspace: (id: string, targetId: string) => void;
}

function assertUniqueName(workspaces: readonly Workspace[], name: string, exceptId?: string) {
  const key = workspaceNameKey(name);
  if (workspaces.some((w) => w.id !== exceptId && workspaceNameKey(w.name) === key)) {
    throw new Error(`A workspace named "${name}" already exists.`);
  }
}

function newWorkspaceId(): string {
  return `ws-${randomUUID()}`;
}

export const WORKSPACE_STORAGE_KEY = "t3code:workspaces:v1";

/**
 * The stored workspaces, reusing this window's objects for the ones that did
 * not change. Another window's write rehydrates this store; fresh objects for
 * unchanged workspaces would re-run every effect that depends on them, and
 * those effects write the store back, which rehydrates the other window.
 */
function keepUnchangedWorkspaces(current: Workspace[], stored: Workspace[]): Workspace[] {
  const byId = new Map(current.map((workspace) => [workspace.id, workspace]));
  const next = stored.map((workspace) => {
    const existing = byId.get(workspace.id);
    return existing !== undefined && JSON.stringify(existing) === JSON.stringify(workspace)
      ? existing
      : workspace;
  });
  return next.length === current.length && next.every((workspace, i) => workspace === current[i])
    ? current
    : next;
}

/**
 * The stored selection belongs to the main window. An extra window keeps its
 * selection in memory and writes back the stored one unchanged.
 */
export function keepStoredSelection(stored: string | null, next: string): string {
  try {
    const nextValue = JSON.parse(next) as { state?: Record<string, unknown> };
    const storedValue = stored === null ? null : (JSON.parse(stored) as typeof nextValue);
    if (nextValue.state === undefined) return next;
    nextValue.state.activeWorkspaceId = storedValue?.state?.activeWorkspaceId ?? null;
    return JSON.stringify(nextValue);
  } catch {
    return next;
  }
}

function workspaceStorage(): StateStorage {
  const base = resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
  if (!isAdditionalDesktopWindow()) return base;
  return {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      const stored = base.getItem(name);
      return base.setItem(
        name,
        keepStoredSelection(typeof stored === "string" ? stored : null, value),
      );
    },
    removeItem: (name) => base.removeItem(name),
  };
}

export const useWorkspaceStore = create<WorkspaceStoreState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      activeWorkspaceId: null,
      availableProjects: [],
      lastThreadByWorkspace: {},
      rememberThread: (workspaceId, thread) => {
        const key = workspaceId ?? "all";
        const previous = get().lastThreadByWorkspace[key];
        if (
          previous?.environmentId === thread.environmentId &&
          previous.threadId === thread.threadId
        )
          return;
        set((state) => ({
          lastThreadByWorkspace: { ...state.lastThreadByWorkspace, [key]: thread },
        }));
      },
      publishProjects: (projects) => {
        const current = get().availableProjects;
        const same =
          current.length === projects.length &&
          current.every(
            (project, index) =>
              project.projectKey === projects[index]!.projectKey &&
              project.displayName === projects[index]!.displayName &&
              project.refs.join() === projects[index]!.refs.join() &&
              JSON.stringify(project.connections) === JSON.stringify(projects[index]!.connections),
          );
        if (!same) set({ availableProjects: projects });
      },
      selectWorkspace: (id) =>
        set((state) => ({
          activeWorkspaceId:
            id !== null && state.workspaces.some((workspace) => workspace.id === id) ? id : null,
        })),
      selectWorkspaceByName: (idOrName) => {
        if (meansAllProjects(idOrName)) {
          set({ activeWorkspaceId: null });
          return { found: true, workspace: null };
        }
        const workspace = findWorkspace(get().workspaces, idOrName);
        if (workspace === null) return { found: false, workspace: null };
        set({ activeWorkspaceId: workspace.id });
        return { found: true, workspace };
      },
      createWorkspace: (draft) => {
        const valid = validateWorkspaceDraft(draft);
        assertUniqueName(get().workspaces, valid.name);
        const workspace: Workspace = { id: newWorkspaceId(), ...valid };
        set((state) => ({ workspaces: [...state.workspaces, workspace] }));
        return workspace;
      },
      updateWorkspace: (id, draft) => {
        const valid = validateWorkspaceDraft(draft);
        assertUniqueName(get().workspaces, valid.name, id);
        set((state) => ({
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === id ? { ...workspace, ...valid } : workspace,
          ),
        }));
      },
      moveWorkspace: (id, targetId) => {
        const current = get().workspaces;
        const next = reorderWorkspaces(current, id, targetId);
        if (next !== current) set({ workspaces: [...next] });
      },
      addProjectToActiveWorkspace: (projectRef) =>
        set((state) => {
          const active = state.workspaces.find(
            (workspace) => workspace.id === state.activeWorkspaceId,
          );
          if (!active || active.projectRefs?.includes(projectRef)) return state;
          return {
            workspaces: state.workspaces.map((workspace) =>
              workspace === active
                ? { ...workspace, projectRefs: [...(workspace.projectRefs ?? []), projectRef] }
                : workspace,
            ),
          };
        }),
      deleteWorkspace: (id) =>
        set((state) => ({
          workspaces: state.workspaces.filter((workspace) => workspace.id !== id),
          activeWorkspaceId: state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
        })),
    }),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(workspaceStorage),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<
          Pick<WorkspaceStoreState, "workspaces" | "activeWorkspaceId" | "lastThreadByWorkspace">
        >;
        const workspaces = Array.isArray(stored.workspaces)
          ? keepUnchangedWorkspaces(current.workspaces, stored.workspaces)
          : current.workspaces;
        const activeWorkspaceId = isAdditionalDesktopWindow()
          ? current.activeWorkspaceId
          : (stored.activeWorkspaceId ?? null);
        return {
          ...current,
          workspaces,
          lastThreadByWorkspace: stored.lastThreadByWorkspace ?? current.lastThreadByWorkspace,
          activeWorkspaceId: workspaces.some((workspace) => workspace.id === activeWorkspaceId)
            ? activeWorkspaceId
            : null,
        };
      },
      partialize: (state) => ({
        workspaces: state.workspaces,
        activeWorkspaceId: state.activeWorkspaceId,
        lastThreadByWorkspace: state.lastThreadByWorkspace,
      }),
    },
  ),
);

/** The last workspace this window reported, as "<id>\n<name>". */
let reportedWorkspace: string | null = null;

function publishActiveWorkspace(): void {
  if (typeof window === "undefined") return;
  const report = window.desktopBridge?.reportWorkspace;
  if (report === undefined) return;
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
  const active = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const id = active?.id ?? null;
  const name = active?.name ?? null;
  // Any workspace edit lands here; the shell only needs to hear when this
  // window's id or name changes.
  const key = `${id}\n${name}`;
  if (key === reportedWorkspace) return;
  reportedWorkspace = key;
  void report({ id, name }).catch(() => undefined);
}

// Hold reports until the extra window has applied its launch workspace, so a
// link never sees the empty selection from before hydration.
let publishWorkspaceReports = false;
useWorkspaceStore.subscribe((state, previous) => {
  if (!publishWorkspaceReports) return;
  if (
    state.activeWorkspaceId === previous.activeWorkspaceId &&
    state.workspaces === previous.workspaces
  ) {
    return;
  }
  publishActiveWorkspace();
});

// rooms-patches: an extra window starts on the workspace it was opened for,
// and every window tells the shell which workspace it is showing.
{
  const context = readDesktopWindowContext();
  if (context.additional && context.workspace !== null) {
    useWorkspaceStore.getState().selectWorkspaceByName(context.workspace);
  }
  publishWorkspaceReports = true;
  publishActiveWorkspace();
  onOtherWindowStorageChange(WORKSPACE_STORAGE_KEY, () => {
    void useWorkspaceStore.persist.rehydrate();
  });
}

/** The selected workspace, or null for all projects. */
export function useActiveWorkspace(): Workspace | null {
  return useWorkspaceStore(
    (state) =>
      state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null,
  );
}

/**
 * The project refs ("<environmentId>:<projectId>") new threads may use while a
 * workspace is selected; null means every project.
 */
export function useActiveWorkspaceProjectRefs(): ReadonlySet<string> | null {
  const workspace = useActiveWorkspace();
  const projects = useWorkspaceStore((state) => state.availableProjects);
  return workspaceProjectRefs(workspace, projects);
}
