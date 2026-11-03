import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type OrbitWorkspaceRegisterInput,
  type OrbitWorkspaceRegistration,
  type ScopedThreadRef,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { connectionAtomRuntime } from "../connection/runtime";
import { resolveStorage } from "../lib/storage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "../state/query";

/**
 * A thread's Orbit workspace. The server registers it with Orbit (see the server's
 * OrbitWorkspaceRegistrar), so this client only starts registrations and shows them.
 */
const orbitWorkspaceEnvironment = {
  live: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:orbit-workspaces:live",
    tag: WS_METHODS.orbitWorkspacesSubscribe,
  }),
  register: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-workspaces:register",
    tag: WS_METHODS.orbitWorkspacesRegister,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "orbit-workspaces:remove",
    tag: WS_METHODS.orbitWorkspacesRemove,
  }),
};

/** What the composer shows about a thread's Orbit workspace. */
export interface OrbitWorkspaceView {
  readonly phase: OrbitWorkspaceRegistration["phase"];
  readonly instanceName: string;
  readonly checkoutPath: string;
  readonly url: string | null;
  readonly failure: string | null;
  /** Hands the workspace to the server again; null while nothing can be retried. */
  readonly retryInput: OrbitWorkspaceRegisterInput | null;
}

function describeOrbitWorkspaceFailure(
  failure: OrbitWorkspaceRegistration["failure"],
): string | null {
  if (failure === null) return null;
  return `${failure.message} (${failure.code}${failure.step ? `, step ${failure.step}` : ""})`;
}

function registerInputOf(registration: OrbitWorkspaceRegistration): OrbitWorkspaceRegisterInput {
  return {
    threadId: registration.threadId,
    instanceName: registration.instanceName,
    orbitProjectId: registration.orbitProjectId,
    projectSlug: registration.projectSlug,
    tld: registration.tld,
    checkoutPath: registration.checkoutPath,
    temporaryBranch: registration.temporaryBranch,
    gatewayUrl: registration.gatewayUrl,
  };
}

function viewOf(registration: OrbitWorkspaceRegistration): OrbitWorkspaceView {
  return {
    phase: registration.phase,
    instanceName: registration.instanceName,
    checkoutPath: registration.checkoutPath,
    url: registration.url,
    failure: describeOrbitWorkspaceFailure(registration.failure),
    retryInput: registration.phase === "failed" ? registerInputOf(registration) : null,
  };
}

export function useOrbitWorkspaces(
  environmentId: string | null,
): ReadonlyArray<OrbitWorkspaceRegistration> | null {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : orbitWorkspaceEnvironment.live({
          environmentId: environmentId as EnvironmentId,
          input: {},
        }),
  );
  return query.data?.registrations ?? null;
}

/** The Orbit workspace whose checkout is this folder, for any thread that works in it. */
export function useOrbitCheckout(
  environmentId: string,
  worktreePath: string | null,
): OrbitWorkspaceView | null {
  const registrations = useOrbitWorkspaces(worktreePath === null ? null : environmentId);
  const legacy = useLegacyOrbitThreadStore((state) =>
    worktreePath === null
      ? null
      : findLegacyCheckout(state.byThreadKey, environmentId, worktreePath),
  );
  if (worktreePath === null) return null;
  const registration = registrations?.find((entry) => entry.checkoutPath === worktreePath);
  if (registration) return viewOf(registration);
  return legacy ? legacyViewOf(legacy) : null;
}

/** The Instance URL of the thread's Orbit workspace. */
export function useOrbitThreadUrl(threadRef: ScopedThreadRef | null): string | null {
  const registrations = useOrbitWorkspaces(threadRef?.environmentId ?? null);
  const legacyUrl = useLegacyOrbitThreadStore((state) =>
    threadRef ? (state.byThreadKey[scopedThreadKey(threadRef)]?.url ?? null) : null,
  );
  if (threadRef === null) return null;
  const registration = registrations?.find((entry) => entry.threadId === threadRef.threadId);
  return registration ? registration.url : legacyUrl;
}

/** Starts the server's registration of a thread's new worktree, or retries a failed one. */
export async function registerOrbitWorkspace(
  environmentId: EnvironmentId,
  input: OrbitWorkspaceRegisterInput,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    orbitWorkspaceEnvironment.register,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error("Could not register the Orbit worktree.");
  }
  useLegacyOrbitThreadStore
    .getState()
    .remove(scopedThreadKey({ environmentId, threadId: input.threadId }));
}

/** Forgets a deleted thread's workspace; Orbit keeps its Instance. */
export function forgetOrbitWorkspace(threadRef: ScopedThreadRef): void {
  useLegacyOrbitThreadStore.getState().remove(scopedThreadKey(threadRef));
  void runAtomCommand(
    appAtomRegistry,
    orbitWorkspaceEnvironment.remove,
    { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } },
    { reportFailure: false },
  );
}

// T3's own worktrees live under its home (`.../.t3/worktrees/<repo>/t3-<hex>`); worktrees
// made for Orbit sit in Orbit's apps folder, named after their temporary branch.
const ORBIT_WORKTREE_FOLDER = /[\\/]t3(?:code)?-[0-9a-f]{8}$/;
const T3_WORKTREES_FOLDER = /[\\/]\.t3[\\/]worktrees[\\/]/;

/**
 * Orbit owns this folder; T3 must never run `git worktree` commands on it.
 * The folder name decides, so another client's Orbit threads stay safe too.
 */
export function isOrbitCheckout(worktreePath: string | null): boolean {
  if (worktreePath === null) return false;
  const path = worktreePath.replace(/[\\/]+$/, "");
  return ORBIT_WORKTREE_FOLDER.test(path) && !T3_WORKTREES_FOLDER.test(path);
}

/**
 * Registrations this client ran itself before the server took them over. Kept to show
 * older threads' Instances; unfinished ones are handed to the server once (see
 * OrbitRegistrationSync). Nothing writes new entries.
 */
export interface LegacyOrbitThreadInstance {
  readonly environmentId: string;
  readonly threadId: string;
  readonly phase: "registering" | "registered" | "failed";
  readonly instanceName: string;
  readonly projectId: number;
  readonly projectSlug: string;
  readonly tld: string;
  readonly checkoutPath: string;
  readonly temporaryBranch: string;
  readonly url: string | null;
  readonly failure: string | null;
}

interface LegacyOrbitThreadStoreState {
  byThreadKey: Record<string, LegacyOrbitThreadInstance>;
  remove: (key: string) => void;
}

export const useLegacyOrbitThreadStore = create<LegacyOrbitThreadStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      remove: (key) =>
        set((state) => {
          if (!(key in state.byThreadKey)) return state;
          const { [key]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: "t3code:orbit-thread-instances:v2",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

function findLegacyCheckout(
  byThreadKey: Record<string, LegacyOrbitThreadInstance>,
  environmentId: string,
  worktreePath: string,
): LegacyOrbitThreadInstance | null {
  for (const instance of Object.values(byThreadKey)) {
    if (instance.environmentId === environmentId && instance.checkoutPath === worktreePath) {
      return instance;
    }
  }
  return null;
}

export function legacyRegisterInput(
  instance: LegacyOrbitThreadInstance,
): OrbitWorkspaceRegisterInput {
  return {
    threadId: ThreadId.make(instance.threadId),
    instanceName: instance.instanceName,
    orbitProjectId: instance.projectId,
    projectSlug: instance.projectSlug,
    tld: instance.tld,
    checkoutPath: instance.checkoutPath,
    temporaryBranch: instance.temporaryBranch,
  };
}

function legacyViewOf(instance: LegacyOrbitThreadInstance): OrbitWorkspaceView {
  return {
    phase: instance.phase,
    instanceName: instance.instanceName,
    checkoutPath: instance.checkoutPath,
    url: instance.url,
    failure: instance.failure,
    retryInput: instance.phase === "failed" ? legacyRegisterInput(instance) : null,
  };
}
