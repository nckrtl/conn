import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { useRightPanelStore } from "../rightPanelStore";
import type { DatabaseConnection } from "./databaseApi";

// The Database panel's saved connections, picked connection and SQL per project (persisted
// in this app's local storage, passwords included), and queries handed over from the
// Laravel Toolbar (per thread, until the panel shows them in the editor).

export interface DatabaseProjectState {
  readonly connection: string | null;
  readonly connections: readonly DatabaseConnection[];
  readonly sqlByConnection: Readonly<Record<string, string>>;
}

export interface PendingDatabaseQuery {
  readonly sql: string;
  readonly nonce: number;
}

interface DatabaseState {
  readonly byProjectKey: Readonly<Record<string, DatabaseProjectState>>;
  readonly pendingByThreadKey: Readonly<Record<string, PendingDatabaseQuery>>;
  readonly setConnection: (projectKey: string, id: string) => void;
  /** Adds the connection, or replaces the saved one with its id; it becomes the picked one. */
  readonly saveConnection: (projectKey: string, connection: DatabaseConnection) => void;
  readonly removeConnection: (projectKey: string, id: string) => void;
  readonly setSql: (projectKey: string, connectionId: string, sql: string) => void;
  readonly setPending: (threadKey: string, sql: string) => void;
  readonly clearPending: (threadKey: string, nonce: number) => void;
}

const EMPTY_PROJECT: DatabaseProjectState = {
  connection: null,
  connections: [],
  sqlByConnection: {},
};

function updateProject(
  state: DatabaseState,
  projectKey: string,
  change: (project: DatabaseProjectState) => DatabaseProjectState,
): Pick<DatabaseState, "byProjectKey"> {
  const project = { ...EMPTY_PROJECT, ...state.byProjectKey[projectKey] };
  return { byProjectKey: { ...state.byProjectKey, [projectKey]: change(project) } };
}

export const useDatabaseStore = create<DatabaseState>()(
  persist(
    (set) => ({
      byProjectKey: {},
      pendingByThreadKey: {},
      setConnection: (projectKey, id) =>
        set((state) =>
          updateProject(state, projectKey, (project) => ({ ...project, connection: id })),
        ),
      saveConnection: (projectKey, connection) =>
        set((state) =>
          updateProject(state, projectKey, (project) => ({
            ...project,
            connection: connection.id,
            connections: project.connections.some((saved) => saved.id === connection.id)
              ? project.connections.map((saved) =>
                  saved.id === connection.id ? connection : saved,
                )
              : [...project.connections, connection],
          })),
        ),
      removeConnection: (projectKey, id) =>
        set((state) =>
          updateProject(state, projectKey, (project) => {
            const { [id]: _removed, ...sqlByConnection } = project.sqlByConnection;
            return {
              connection: project.connection === id ? null : project.connection,
              connections: project.connections.filter((saved) => saved.id !== id),
              sqlByConnection,
            };
          }),
        ),
      setSql: (projectKey, connectionId, sql) =>
        set((state) =>
          updateProject(state, projectKey, (project) => ({
            ...project,
            sqlByConnection: { ...project.sqlByConnection, [connectionId]: sql },
          })),
        ),
      setPending: (threadKey, sql) =>
        set((state) => ({
          pendingByThreadKey: {
            ...state.pendingByThreadKey,
            [threadKey]: { sql, nonce: Date.now() },
          },
        })),
      clearPending: (threadKey, nonce) =>
        set((state) => {
          if (state.pendingByThreadKey[threadKey]?.nonce !== nonce) return state;
          const { [threadKey]: _removed, ...rest } = state.pendingByThreadKey;
          return { pendingByThreadKey: rest };
        }),
    }),
    {
      name: "t3code:database-panel:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byProjectKey: state.byProjectKey }),
    },
  ),
);

/**
 * Opens the thread's Database panel with `sql` in the editor (from the Laravel Toolbar). It
 * never runs: the SQL comes from a web page, so the user reads it and presses Run.
 */
export function openDatabaseQuery(threadRef: ScopedThreadRef, sql: string): void {
  useDatabaseStore.getState().setPending(scopedThreadKey(threadRef), sql);
  useRightPanelStore.getState().open(threadRef, "database");
}
