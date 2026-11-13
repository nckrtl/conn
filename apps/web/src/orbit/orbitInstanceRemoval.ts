import {
  followOrbitInstanceRemoval,
  ORBIT_REMOVAL_LOST_TEXT,
  orbitInstanceRemoveKey,
  removeOrbitInstance,
  type OrbitInstanceGitState,
  type OrbitInstanceListRow,
  type OrbitInstanceRemoveOutcome,
  type OrbitInstanceRemovePorts,
  type OrbitInstanceRemoveProgress,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { forgetOrbitInstanceEnvironment, orbitInstanceEnvironmentIds } from "./environmentProvider";
import {
  loadOrbitInstanceList,
  useOrbitInstanceListStore,
  type OrbitInstanceListState,
} from "./orbitInstanceList";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import { dropOrbitInstanceStarts } from "./orbitThreadStartStore";

/** Conn: removing an Instance from the Orbit panel (DESIGN.md, "Orbit panel and Manage Instances"). */

export interface OrbitInstanceCleanupPorts {
  /** The Instance's saved servers the last Gateway sync knew. */
  readonly knownEnvironmentIds: (instanceId: number) => readonly string[];
  /** Removes a saved server: its stored pairing credential and its cached threads. */
  readonly removeEnvironment: (environmentId: string) => Promise<void>;
  /** Drops the Orbit provider's pairing records and Orbit facts of a server. */
  readonly forgetEnvironment: (environmentId: string) => void;
  /** Drops the saved thread-start records of the Instance. */
  readonly dropThreadStarts: (instanceId: number, environmentIds: readonly string[]) => void;
}

/**
 * Everything Conn keeps of an Instance Orbit removed. Every step runs even when one fails, so a
 * server that cannot be removed does not leave the others; the first failure is thrown after.
 */
export async function cleanUpRemovedOrbitInstance(
  instance: { readonly id: number; readonly environmentId: string | null },
  ports: OrbitInstanceCleanupPorts,
): Promise<void> {
  const environmentIds = [
    ...new Set([
      ...(instance.environmentId === null ? [] : [instance.environmentId]),
      ...ports.knownEnvironmentIds(instance.id),
    ]),
  ];
  // First, so the environment sync no longer holds the Instance for a thread start.
  ports.dropThreadStarts(instance.id, environmentIds);
  const failures: unknown[] = [];
  for (const environmentId of environmentIds) {
    try {
      await ports.removeEnvironment(environmentId);
    } catch (error) {
      failures.push(error);
    }
    ports.forgetEnvironment(environmentId);
  }
  if (failures.length > 0) throw failures[0];
}

export const webOrbitInstanceCleanupPorts: OrbitInstanceCleanupPorts = {
  knownEnvironmentIds: orbitInstanceEnvironmentIds,
  removeEnvironment: async (environmentId) => {
    const result = await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.remove,
      environmentId as EnvironmentId,
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw new Error(`Could not remove the server ${environmentId}.`);
  },
  forgetEnvironment: forgetOrbitInstanceEnvironment,
  dropThreadStarts: dropOrbitInstanceStarts,
};

/** The row facts a removal keeps, so a row whose Instance left the list can still show its failure. */
export type OrbitInstanceRemovalRow = Pick<
  OrbitInstanceListRow,
  | "id"
  | "name"
  | "projectId"
  | "projectSlug"
  | "projectName"
  | "nodeName"
  | "domain"
  | "instanceUrl"
  | "powerState"
  | "status"
  | "environmentId"
  | "branch"
>;

export type OrbitInstanceRemoval =
  | {
      readonly status: "removing";
      /** Null until Orbit admitted the destroy. */
      readonly progress: Exclude<OrbitInstanceRemoveProgress, { kind: "admitted" }> | null;
      readonly row: OrbitInstanceRemovalRow;
    }
  | {
      readonly status: "failed";
      /** Orbit refused the destroy before starting it ("Could not remove"); else it started and failed. */
      readonly refused: boolean;
      readonly message: string;
      readonly acknowledgeUnsaved: boolean;
      readonly row: OrbitInstanceRemovalRow;
    }
  /** Orbit removed it; the row stays hidden even if a list read still carries it. */
  | { readonly status: "removed" };

/** The row state of each Instance being removed, by Instance id, for the current Orbit profile. */
export const useOrbitInstanceRemovals = create<{
  readonly byInstance: Readonly<Record<number, OrbitInstanceRemoval>>;
  /**
   * The page opening whose profile check has run (`restoreOrbitInstanceRemovals`). Until then
   * the page shows only removals this window runs itself, never older saved ones.
   */
  readonly restoredFor: symbol | null;
}>(() => ({ byInstance: {}, restoredFor: null }));

/**
 * A removal saved on this device, so a restart or a reopened panel shows it again. Saved per Orbit
 * profile ("none" without one) and Instance id; dropped once the row is gone.
 */
export interface SavedOrbitInstanceRemoval {
  readonly operationId: number | null;
  readonly acknowledgeUnsaved: boolean;
  readonly status: "removing" | "failed";
  readonly message: string | null;
  readonly row: OrbitInstanceRemovalRow;
}

type SavedRemovals = Record<string, Record<string, SavedOrbitInstanceRemoval>>;

export interface OrbitInstanceRemovalStorage {
  readonly read: () => SavedRemovals;
  readonly write: (value: SavedRemovals) => void;
}

const REMOVALS_KEY = "conn:orbit-instance-removals:v1";

export const localOrbitInstanceRemovalStorage: OrbitInstanceRemovalStorage = {
  read: () => {
    try {
      const raw = window.localStorage.getItem(REMOVALS_KEY);
      const value: unknown = raw === null ? null : JSON.parse(raw);
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as SavedRemovals)
        : {};
    } catch {
      return {};
    }
  },
  write: (value) => {
    try {
      window.localStorage.setItem(REMOVALS_KEY, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the row still shows the removal until the app restarts.
    }
  },
};

function isSavedRemoval(value: unknown): value is SavedOrbitInstanceRemoval {
  if (value === null || typeof value !== "object") return false;
  const saved = value as Record<string, unknown>;
  const row = saved.row as Record<string, unknown> | null | undefined;
  return (
    (saved.status === "removing" || saved.status === "failed") &&
    (saved.operationId === null || typeof saved.operationId === "number") &&
    typeof saved.acknowledgeUnsaved === "boolean" &&
    typeof row === "object" &&
    row !== null &&
    typeof row.id === "number" &&
    typeof row.name === "string" &&
    typeof row.projectId === "number"
  );
}

function profileKey(profileId: number | null): string {
  return profileId === null ? "none" : String(profileId);
}

/** The profile the store shows now; a follow of another profile's removal does not touch it. */
let shownProfile: string | null = null;
/**
 * Instances this window works on now (a click waiting for its answer, or a followed Operation),
 * with the profile they run under; null while a click still reads the profile.
 */
const active = new Map<number, string | null>();
/** When a click started each running removal of this window (restored follows have none). */
const clickedAt = new Map<number, number>();

/**
 * True while a click in this window, made at or after `since`, removes the Instance. Before its
 * profile check the page shows only these, never a follow restored for another profile.
 */
export function isOrbitInstanceRemovalClickedSince(instanceId: number, since: number): boolean {
  const at = clickedAt.get(instanceId);
  return at !== undefined && at >= since;
}

function saveRemoval(
  storage: OrbitInstanceRemovalStorage,
  profile: string,
  instanceId: number,
  saved: SavedOrbitInstanceRemoval | null,
): void {
  const all = storage.read();
  const { [String(instanceId)]: _previous, ...rest } = all[profile] ?? {};
  const next = saved === null ? rest : { ...rest, [String(instanceId)]: saved };
  const { [profile]: _old, ...others } = all;
  storage.write(Object.keys(next).length === 0 ? others : { ...others, [profile]: next });
}

function showRemoval(
  profile: string,
  instanceId: number,
  removal: OrbitInstanceRemoval | null,
): void {
  // This window's own clicks always update their row; other follows only for the shown profile.
  if (shownProfile !== profile && !clickedAt.has(instanceId)) return;
  useOrbitInstanceRemovals.setState(({ byInstance }) => {
    const { [instanceId]: _previous, ...rest } = byInstance;
    return { byInstance: removal === null ? rest : { ...rest, [instanceId]: removal } };
  });
}

function toRemovalRow(row: OrbitInstanceRemovalRow): OrbitInstanceRemovalRow {
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    projectName: row.projectName,
    nodeName: row.nodeName,
    domain: row.domain,
    instanceUrl: row.instanceUrl,
    powerState: row.powerState,
    status: row.status,
    environmentId: row.environmentId,
    branch: row.branch,
  };
}

function savedToRemoval(saved: SavedOrbitInstanceRemoval): OrbitInstanceRemoval {
  return saved.status === "failed"
    ? {
        status: "failed",
        refused: false,
        message: saved.message ?? ORBIT_REMOVAL_LOST_TEXT,
        acknowledgeUnsaved: saved.acknowledgeUnsaved,
        row: saved.row,
      }
    : { status: "removing", progress: null, row: saved.row };
}

export interface OrbitInstanceRemovalPorts {
  readonly gateway: OrbitInstanceRemovePorts | null;
  readonly cleanup: OrbitInstanceCleanupPorts;
  readonly reloadList: () => Promise<void>;
  readonly storage: OrbitInstanceRemovalStorage;
  /** The Orbit profile this device is linked to now, or null. */
  readonly profileId: () => Promise<number | null>;
  /** Whether the list read last holds the Instance; null when the list could not be read. */
  readonly isListed: (instanceId: number) => boolean | null;
}

export function webOrbitInstanceRemovalPorts(): OrbitInstanceRemovalPorts {
  const client = desktopOrbitGatewayClient();
  return {
    gateway:
      client === null
        ? null
        : {
            client,
            now: Date.now,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          },
    cleanup: webOrbitInstanceCleanupPorts,
    reloadList: loadOrbitInstanceList,
    storage: localOrbitInstanceRemovalStorage,
    profileId: async () => {
      if (client === null) return null;
      return (await client.me()).profile?.id ?? null;
    },
    isListed: (instanceId) => {
      const { state } = useOrbitInstanceListStore.getState();
      return state.status === "loaded" ? state.rows.some((row) => row.id === instanceId) : null;
    },
  };
}

/** Ends a removal: shows it, saves it for a restart, or drops it once the row is gone. */
async function settle(
  instance: { readonly id: number; readonly environmentId: string | null },
  row: OrbitInstanceRemovalRow,
  profile: string,
  acknowledgeUnsaved: boolean,
  outcome: OrbitInstanceRemoveOutcome,
  ports: OrbitInstanceRemovalPorts,
  admitted = true,
): Promise<void> {
  if (outcome.kind === "stopped") return;
  if (outcome.kind === "lost") {
    // Orbit no longer shows the Operation: a fresh list read tells whether the Instance went.
    await ports.reloadList();
    if (ports.isListed(instance.id) === false) {
      return settle(instance, row, profile, acknowledgeUnsaved, { kind: "removed" }, ports);
    }
  }
  if (outcome.kind === "failed" && !admitted) {
    // A refusal started nothing; it is shown here and not kept for a restart.
    saveRemoval(ports.storage, profile, instance.id, null);
    showRemoval(profile, instance.id, {
      status: "failed",
      refused: true,
      message: outcome.message,
      acknowledgeUnsaved,
      row,
    });
    return;
  }
  if (outcome.kind === "failed" || outcome.kind === "lost") {
    const message = outcome.kind === "failed" ? outcome.message : ORBIT_REMOVAL_LOST_TEXT;
    saveRemoval(ports.storage, profile, instance.id, {
      operationId: null,
      acknowledgeUnsaved,
      status: "failed",
      message,
      row,
    });
    showRemoval(profile, instance.id, {
      status: "failed",
      refused: false,
      message,
      acknowledgeUnsaved,
      row,
    });
    return;
  }
  if (outcome.kind === "unsaved_work") {
    saveRemoval(ports.storage, profile, instance.id, null);
    showRemoval(profile, instance.id, null);
    return;
  }
  saveRemoval(ports.storage, profile, instance.id, null);
  showRemoval(profile, instance.id, { status: "removed" });
  // Orbit removed it; a cleanup failure must not show the row as "Could not remove".
  await cleanUpRemovedOrbitInstance(instance, ports.cleanup).catch(() => undefined);
  await ports.reloadList();
}

async function currentProfile(ports: OrbitInstanceRemovalPorts): Promise<string | null> {
  try {
    return profileKey(await ports.profileId());
  } catch {
    return null;
  }
}

/**
 * One remove attempt (the dialog's Remove Instance, or the row's Retry). The row reads
 * "Removing…" at once, before any Gateway call; then it goes, or shows the failure with Retry.
 * `unsaved_work` clears the row; the caller opens the dialog again with Orbit's Git state.
 */
export async function runOrbitInstanceRemoval(
  instance: OrbitInstanceRemovalRow & { readonly git?: OrbitInstanceGitState },
  acknowledgeUnsaved: boolean,
  ports: OrbitInstanceRemovalPorts,
): Promise<OrbitInstanceRemoveOutcome> {
  const current = useOrbitInstanceRemovals.getState().byInstance[instance.id]?.status;
  if (current === "removing" || current === "removed") {
    return { kind: "failed", code: "conn.remove_running", message: "Removing already." };
  }
  const row = toRemovalRow(instance);
  // Shown in this window first, so the click answers at once; the profile read comes after.
  active.set(instance.id, null);
  clickedAt.set(instance.id, Date.now());
  useOrbitInstanceRemovals.setState(({ byInstance }) => ({
    byInstance: { ...byInstance, [instance.id]: { status: "removing", progress: null, row } },
  }));
  try {
    return await runAdmittedRemoval(instance, row, acknowledgeUnsaved, ports);
  } finally {
    active.delete(instance.id);
    clickedAt.delete(instance.id);
  }
}

async function runAdmittedRemoval(
  instance: OrbitInstanceRemovalRow & { readonly git?: OrbitInstanceGitState },
  row: OrbitInstanceRemovalRow,
  acknowledgeUnsaved: boolean,
  ports: OrbitInstanceRemovalPorts,
): Promise<OrbitInstanceRemoveOutcome> {
  const profile = await currentProfile(ports);
  if (profile === null || ports.gateway === null) {
    const message =
      ports.gateway === null
        ? "The Orbit Gateway is not available here."
        : "The Orbit Gateway did not answer.";
    useOrbitInstanceRemovals.setState(({ byInstance }) => ({
      byInstance: {
        ...byInstance,
        [instance.id]: { status: "failed", refused: true, message, acknowledgeUnsaved, row },
      },
    }));
    return { kind: "failed", code: "gateway.unavailable", message };
  }
  if (shownProfile !== profile) {
    // The device's profile changed since the page read its saved removals: show only this one.
    shownProfile = profile;
    useOrbitInstanceRemovals.setState({
      byInstance: { [instance.id]: { status: "removing", progress: null, row } },
    });
  }
  active.set(instance.id, profile);
  saveRemoval(ports.storage, profile, instance.id, {
    operationId: null,
    acknowledgeUnsaved,
    status: "removing",
    message: null,
    row,
  });
  const gateway = ports.gateway;
  let admitted = false;
  const outcome = await removeOrbitInstance(gateway, {
    instanceId: instance.id,
    acknowledgeUnsaved,
    idempotencyKey: orbitInstanceRemoveKey(instance.id, gateway.now()),
    ...(instance.git ? { git: instance.git } : {}),
    onProgress: (progress) => {
      if (progress.kind === "admitted") {
        admitted = true;
        saveRemoval(ports.storage, profile, instance.id, {
          operationId: progress.operationId,
          acknowledgeUnsaved,
          status: "removing",
          message: null,
          row,
        });
        return;
      }
      showRemoval(profile, instance.id, { status: "removing", progress, row });
    },
  });
  await settle(instance, row, profile, acknowledgeUnsaved, outcome, ports, admitted);
  return outcome;
}

/**
 * Rebuilds the rows from this device's saved removals of the current Orbit profile and follows
 * each saved Operation again. Runs when the Instances page opens (also the first time after a
 * restart). `listedIds` are the Instances in the list just read, or null when it failed.
 */
export async function restoreOrbitInstanceRemovals(
  ports: OrbitInstanceRemovalPorts,
  listedIds: ReadonlySet<number> | null,
  opening: symbol | null = null,
): Promise<void> {
  const profile = await currentProfile(ports);
  const sameProfile = profile !== null && shownProfile === profile;
  /**
   * This window's own rows under `profile`: running ones, clicks still reading their profile,
   * and a refusal it showed (refusals are not saved).
   */
  const ownRows = (byInstance: Readonly<Record<number, OrbitInstanceRemoval>>) =>
    Object.fromEntries(
      Object.entries(byInstance).filter(([id, removal]) => {
        const runsUnder = active.get(Number(id));
        // A click of this window stays, whatever profile it resolved to: it is the user's own act.
        if (clickedAt.has(Number(id))) return true;
        if (active.has(Number(id))) {
          return runsUnder === null || (profile !== null && runsUnder === profile);
        }
        return sameProfile && removal.status === "failed" && removal.refused;
      }),
    );
  if (profile === null) {
    // Profile unknown: show no saved removal, only clicks of this window that still read theirs.
    // No profile is shown, so a follow of an earlier profile cannot put its row back.
    shownProfile = null;
    useOrbitInstanceRemovals.setState(({ byInstance }) => ({
      byInstance: ownRows(byInstance),
      restoredFor: opening,
    }));
    return;
  }
  const saved = ports.storage.read()[profile] ?? {};
  const restored: Record<number, OrbitInstanceRemoval> = {};
  const toFollow: Array<[number, SavedOrbitInstanceRemoval]> = [];
  for (const [key, value] of Object.entries(saved)) {
    const instanceId = Number(key);
    if (!Number.isInteger(instanceId) || !isSavedRemoval(value)) {
      saveRemoval(ports.storage, profile, instanceId, null);
      continue;
    }
    // A failure whose Instance is no longer listed: Orbit removed it after all.
    if (value.status === "failed" && listedIds !== null && !listedIds.has(instanceId)) {
      saveRemoval(ports.storage, profile, instanceId, null);
      continue;
    }
    restored[instanceId] = savedToRemoval(value);
    if (value.status === "removing") toFollow.push([instanceId, value]);
  }
  shownProfile = profile;
  // This window's live states win: their progress is fresher than the saved record.
  useOrbitInstanceRemovals.setState(({ byInstance }) => ({
    byInstance: { ...restored, ...ownRows(byInstance) },
    restoredFor: opening,
  }));
  const gateway = ports.gateway;
  if (gateway === null) return;
  await Promise.all(
    toFollow.map(async ([instanceId, value]) => {
      if (active.has(instanceId)) return;
      active.set(instanceId, profile);
      try {
        const instance = { id: instanceId, environmentId: value.row.environmentId };
        if (value.operationId === null) {
          // The app ended before Orbit answered the destroy: its fate is unknown.
          await settle(
            instance,
            value.row,
            profile,
            value.acknowledgeUnsaved,
            { kind: "lost" },
            ports,
          );
          return;
        }
        const outcome = await followOrbitInstanceRemoval(gateway, {
          operationId: value.operationId,
          onProgress: (progress) => {
            if (progress.kind === "admitted") return;
            showRemoval(profile, instanceId, { status: "removing", progress, row: value.row });
          },
        });
        await settle(instance, value.row, profile, value.acknowledgeUnsaved, outcome, ports);
      } finally {
        active.delete(instanceId);
      }
    }),
  );
}

/**
 * The Instances page's list: read each time the page opens, then the saved removals of the current
 * Orbit profile on top of it, so a removal from before a restart shows again.
 */
export function useOrbitInstanceListWithRemovals(): {
  readonly list: OrbitInstanceListState;
  /** The removals the page may show: all once this opening's profile check ran, else own ones. */
  readonly removals: Readonly<Record<number, OrbitInstanceRemoval>>;
} {
  const [opening] = useState(() => Symbol("orbit-instances-page"));
  const [openedAt] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Gateway and the saved removals each time the Instances page opens
  useEffect(() => {
    void (async () => {
      await loadOrbitInstanceList();
      const { state } = useOrbitInstanceListStore.getState();
      await restoreOrbitInstanceRemovals(
        webOrbitInstanceRemovalPorts(),
        state.status === "loaded" ? new Set(state.rows.map((row) => row.id)) : null,
        opening,
      );
    })();
  }, [opening]);
  const list = useOrbitInstanceListStore((store) => store.state);
  const byInstance = useOrbitInstanceRemovals((store) => store.byInstance);
  const checked = useOrbitInstanceRemovals((store) => store.restoredFor === opening);
  return {
    list,
    removals: checked
      ? byInstance
      : Object.fromEntries(
          Object.entries(byInstance).filter(([id]) =>
            isOrbitInstanceRemovalClickedSince(Number(id), openedAt),
          ),
        ),
  };
}

/** Tests only: forget which profile is shown and which removals this window follows. */
export function resetOrbitInstanceRemovalsForTest(): void {
  shownProfile = null;
  active.clear();
  clickedAt.clear();
  useOrbitInstanceRemovals.setState({ byInstance: {}, restoredFor: null });
}
