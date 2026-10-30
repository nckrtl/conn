import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AgentPanelDatabaseResult, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { useRightPanelStore } from "../rightPanelStore";
import type { DatabaseConnection } from "./databaseApi";

// The Database panel's saved connections, picked connection and SQL per project (persisted
// in this app's local storage, passwords included), and queries handed over from the
// Laravel Toolbar or an agent (per thread, until the panel shows them in the editor).

export interface DatabaseProjectState {
  readonly connection: string | null;
  readonly connections: readonly DatabaseConnection[];
  readonly sqlByConnection: Readonly<Record<string, string>>;
}

export type AgentQueryOutcome =
  | { readonly result: AgentPanelDatabaseResult }
  | { readonly error: string };

export interface DatabaseQueryRequest {
  readonly sql: string;
  /** A connection's name or id to pick first. */
  readonly connection?: string;
  /** Run the query and report the outcome; only agents ask, and the panel runs read-only. */
  readonly onRun?: (outcome: AgentQueryOutcome) => void;
}

export interface PendingDatabaseQuery extends DatabaseQueryRequest {
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
  readonly setPending: (threadKey: string, request: DatabaseQueryRequest) => void;
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
      setPending: (threadKey, request) =>
        set((state) => {
          state.pendingByThreadKey[threadKey]?.onRun?.({
            error: "Another query replaced this one before it ran.",
          });
          return {
            pendingByThreadKey: {
              ...state.pendingByThreadKey,
              [threadKey]: { ...request, nonce: Date.now() },
            },
          };
        }),
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
  useDatabaseStore.getState().setPending(scopedThreadKey(threadRef), { sql });
  useRightPanelStore.getState().open(threadRef, "database");
}

/**
 * Opens the thread's Database panel, picks `connection`, and runs `sql` there for an agent,
 * so the user sees the rows. Settles with the result, or an error after `timeoutMs`.
 */
export function runAgentDatabaseQuery(
  threadRef: ScopedThreadRef,
  request: { readonly sql: string; readonly connection?: string },
  timeoutMs: number,
): Promise<AgentQueryOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () =>
        resolve({
          error:
            "The Database panel did not run the query in time. It needs a thread in a project folder.",
        }),
      timeoutMs,
    );
    const onRun = (outcome: AgentQueryOutcome) => {
      clearTimeout(timer);
      resolve(outcome);
    };
    useDatabaseStore.getState().setPending(scopedThreadKey(threadRef), { ...request, onRun });
    useRightPanelStore.getState().open(threadRef, "database");
  });
}
