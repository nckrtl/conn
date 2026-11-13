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

/** The profile key of a click that still waits for the page's profile read. */
const PENDING = "?";

const entryKey = (profile: string, instanceId: number) => `${profile}:${instanceId}`;

/** One removal: its row state, its one follow and the profile it runs (and is saved) under. */
export interface OrbitInstanceRemovalEntry {
  /** The Orbit profile key ("none" without one), or `?` while the click waits for the page read. */
  readonly profile: string;
  readonly instanceId: number;
  /** Changes on every new attempt; a late event of a replaced attempt does not touch the entry. */
  readonly token: symbol;
  /** The page opening a click was made in; null for a removal restored from this device's records. */
  readonly opening: symbol | null;
  readonly removal: OrbitInstanceRemoval;
  /** The running attempt or follow; null once it ended (a failure, or the removed tombstone). */
  readonly follow: Promise<unknown> | null;
}

/** One opening of the Instances page and its one profile read. */
export interface OrbitInstanceRemovalPage {
  readonly opening: symbol;
  /** Undefined while the read runs; null when it failed. */
  readonly profile: string | null | undefined;
  readonly read: Promise<string | null>;
  /** Settles when the follows this opening restored have ended. */
  readonly restored: Promise<void>;
}

/** Every removal of this window, keyed `profile:instanceId`, and the open Instances page. */
export const useOrbitInstanceRemovals = create<{
  readonly entries: Readonly<Record<string, OrbitInstanceRemovalEntry>>;
  readonly page: OrbitInstanceRemovalPage | null;
}>(() => ({ entries: {}, page: null }));

type RemovalStoreState = ReturnType<typeof useOrbitInstanceRemovals.getState>;

/**
 * The rows the page shows: after a good profile read, that profile's removals; before it (or
 * after a failed read) only this window's own running clicks. Always the clicks still waiting
 * for a read, and the refusals of this opening. Other profiles never show.
 */
export function shownOrbitInstanceRemovals(
  state: Pick<RemovalStoreState, "entries" | "page">,
): Readonly<Record<number, OrbitInstanceRemoval>> {
  const { page, entries } = state;
  if (page === null) return {};
  const shown: Record<number, OrbitInstanceRemoval> = {};
  const all = Object.values(entries);
  if (typeof page.profile === "string") {
    for (const entry of all) {
      if (entry.profile === page.profile) shown[entry.instanceId] = entry.removal;
    }
  }
  if (typeof page.profile !== "string") {
    // Before a good read: this window's own running clicks, whatever opening made them.
    for (const entry of all) {
      if (entry.opening !== null && entry.follow !== null && entry.profile !== PENDING) {
        shown[entry.instanceId] = entry.removal;
      }
    }
  }
  for (const entry of all) {
    if (
      entry.profile === PENDING &&
      (entry.removal.status === "removing" || entry.opening === page.opening)
    ) {
      shown[entry.instanceId] = entry.removal;
    }
  }
  return shown;
}

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

/** Applies `change` to the entry at `key` only while it is still the attempt `token`. */
function updateEntry(
  key: string,
  token: symbol,
  change: (entry: OrbitInstanceRemovalEntry) => OrbitInstanceRemovalEntry | null,
): boolean {
  let applied = false;
  useOrbitInstanceRemovals.setState(({ entries }) => {
    const entry = entries[key];
    if (entry?.token !== token) return {};
    applied = true;
    const next = change(entry);
    const { [key]: _previous, ...rest } = entries;
    return { entries: next === null ? rest : { ...rest, [key]: next } };
  });
  return applied;
}

const REMOVING_ALREADY: OrbitInstanceRemoveOutcome = {
  kind: "failed",
  code: "conn.remove_running",
  message: "Removing already.",
};

/** True when the entry blocks a new destroy: one runs, or Orbit removed the Instance. */
function blocksNewRemoval(entry: OrbitInstanceRemovalEntry | undefined): boolean {
  return entry !== undefined && entry.removal.status !== "failed";
}

interface Attempt {
  readonly key: string;
  readonly token: symbol;
  readonly profile: string;
  readonly instance: { readonly id: number; readonly environmentId: string | null };
  readonly row: OrbitInstanceRemovalRow;
  readonly acknowledgeUnsaved: boolean;
  readonly ports: OrbitInstanceRemovalPorts;
}

/** Ends an attempt: shows it, saves it for a restart, or drops it once the row is gone. */
async function settle(
  attempt: Attempt,
  outcome: OrbitInstanceRemoveOutcome,
  admitted = true,
): Promise<void> {
  const { key, token, profile, instance, row, acknowledgeUnsaved, ports } = attempt;
  if (outcome.kind === "stopped") return;
  if (outcome.kind === "lost") {
    // Orbit no longer shows the Operation: a fresh list read tells whether the Instance went.
    await ports.reloadList();
    if (ports.isListed(instance.id) === false) return settle(attempt, { kind: "removed" });
  }
  if (outcome.kind === "failed" || outcome.kind === "lost") {
    // A refusal started nothing; it is shown here and not kept for a restart.
    const refused = outcome.kind === "failed" && !admitted;
    const message = outcome.kind === "failed" ? outcome.message : ORBIT_REMOVAL_LOST_TEXT;
    const current = updateEntry(key, token, (entry) => ({
      ...entry,
      follow: null,
      removal: { status: "failed", refused, message, acknowledgeUnsaved, row },
    }));
    if (current) {
      saveRemoval(
        ports.storage,
        profile,
        instance.id,
        refused ? null : { operationId: null, acknowledgeUnsaved, status: "failed", message, row },
      );
    }
    return;
  }
  if (outcome.kind === "unsaved_work") {
    if (updateEntry(key, token, () => null)) saveRemoval(ports.storage, profile, instance.id, null);
    return;
  }
  // Removed: the tombstone keeps the row hidden even if a list read still carries it.
  const current = updateEntry(key, token, (entry) => ({
    ...entry,
    follow: null,
    removal: { status: "removed" },
  }));
  if (!current) return;
  saveRemoval(ports.storage, profile, instance.id, null);
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

/** Follows a removal saved under `profile` again (the entry at `key` is already in the store). */
async function followSaved(
  attempt: Attempt,
  operationId: number | null,
  gateway: OrbitInstanceRemovePorts,
): Promise<void> {
  // The app ended before Orbit answered the destroy: its fate is unknown.
  if (operationId === null) return settle(attempt, { kind: "lost" });
  const outcome = await followOrbitInstanceRemoval(gateway, {
    operationId,
    onProgress: (progress) => {
      if (progress.kind === "admitted") return;
      updateEntry(attempt.key, attempt.token, (entry) => ({
        ...entry,
        removal: { status: "removing", progress, row: attempt.row },
      }));
    },
  });
  await settle(attempt, outcome);
}

/**
 * Puts the saved removals of `profile` into the store; a key the store already holds keeps its
 * entry (its follow already runs, or it ended in this window). Returns the follows it started.
 */
function restoreSaved(profile: string, ports: OrbitInstanceRemovalPorts): Promise<void>[] {
  const gateway = ports.gateway;
  if (gateway === null) return [];
  const follows: Promise<void>[] = [];
  for (const [id, value] of Object.entries(ports.storage.read()[profile] ?? {})) {
    const instanceId = Number(id);
    if (!Number.isInteger(instanceId) || !isSavedRemoval(value)) {
      saveRemoval(ports.storage, profile, instanceId, null);
      continue;
    }
    const key = entryKey(profile, instanceId);
    if (useOrbitInstanceRemovals.getState().entries[key] !== undefined) continue;
    const token = Symbol(key);
    const base = { profile, instanceId, token, opening: null };
    if (value.status === "failed") {
      useOrbitInstanceRemovals.setState(({ entries }) => ({
        entries: {
          ...entries,
          [key]: {
            ...base,
            follow: null,
            removal: {
              status: "failed",
              refused: false,
              message: value.message ?? ORBIT_REMOVAL_LOST_TEXT,
              acknowledgeUnsaved: value.acknowledgeUnsaved,
              row: value.row,
            },
          },
        },
      }));
      continue;
    }
    const attempt: Attempt = {
      key,
      token,
      profile,
      instance: { id: instanceId, environmentId: value.row.environmentId },
      row: value.row,
      acknowledgeUnsaved: value.acknowledgeUnsaved,
      ports,
    };
    // The async follow starts after this synchronous block, so the entry exists before it acts.
    const follow = Promise.resolve().then(() => followSaved(attempt, value.operationId, gateway));
    useOrbitInstanceRemovals.setState(({ entries }) => ({
      entries: {
        ...entries,
        [key]: { ...base, follow, removal: { status: "removing", progress: null, row: value.row } },
      },
    }));
    follows.push(follow);
  }
  return follows;
}

/**
 * Opens the Instances page: ONE profile read for this opening. A good read puts the profile's
 * saved removals into the store and follows them again; clicks of the page wait for this read.
 */
export function openOrbitInstanceRemovalPage(
  ports: OrbitInstanceRemovalPorts,
  opening: symbol = Symbol("orbit-instances-page"),
): OrbitInstanceRemovalPage {
  let restoredFollows: Promise<void>[] = [];
  let self: OrbitInstanceRemovalPage | null = null;
  const read = currentProfile(ports).then((profile) => {
    // A page opened since then owns the store's page; this read changes nothing for it.
    if (self === null || useOrbitInstanceRemovals.getState().page !== self) return profile;
    self = { ...self, profile };
    useOrbitInstanceRemovals.setState({ page: self });
    if (profile !== null) restoredFollows = restoreSaved(profile, ports);
    return profile;
  });
  const page: OrbitInstanceRemovalPage = {
    opening,
    profile: undefined,
    read,
    restored: read.then(() => Promise.all(restoredFollows)).then(() => undefined),
  };
  self = page;
  useOrbitInstanceRemovals.setState(({ entries }) => ({
    page,
    // Refusals belong to the opening that showed them.
    entries: Object.fromEntries(
      Object.entries(entries).filter(
        ([, entry]) => entry.profile !== PENDING || entry.removal.status === "removing",
      ),
    ),
  }));
  return page;
}

/**
 * One remove attempt (the dialog's Remove Instance, or the row's Retry). The row reads
 * "Removing…" at once, before any Gateway call; then it goes, or shows the failure with Retry.
 * `unsaved_work` clears the row; the caller opens the dialog again with Orbit's Git state.
 * Starts only when the store holds no running removal of this key; a failed one is replaced.
 */
export function runOrbitInstanceRemoval(
  instance: OrbitInstanceRemovalRow & { readonly git?: OrbitInstanceGitState },
  acknowledgeUnsaved: boolean,
  ports: OrbitInstanceRemovalPorts,
): Promise<OrbitInstanceRemoveOutcome> {
  const page = useOrbitInstanceRemovals.getState().page ?? openOrbitInstanceRemovalPage(ports);
  const profile = typeof page.profile === "string" ? page.profile : PENDING;
  const key = entryKey(profile, instance.id);
  const state = useOrbitInstanceRemovals.getState();
  const shown = shownOrbitInstanceRemovals(state)[instance.id];
  if (
    blocksNewRemoval(state.entries[key]) ||
    shown?.status === "removing" ||
    shown?.status === "removed"
  ) {
    return Promise.resolve(REMOVING_ALREADY);
  }
  const token = Symbol(key);
  const row = toRemovalRow(instance);
  // The body pauses at its first await, after the entry below is in the store.
  const follow = runAttempt(key, token, instance, row, acknowledgeUnsaved, ports);
  useOrbitInstanceRemovals.setState(({ entries }) => ({
    entries: {
      ...entries,
      [key]: {
        profile,
        instanceId: instance.id,
        token,
        opening: page.opening,
        follow,
        removal: { status: "removing", progress: null, row },
      },
    },
  }));
  return follow;
}

/** The profile read of the page open now; a reopened page's read replaces an earlier one. */
async function readOfCurrentPage(): Promise<string | null> {
  for (;;) {
    const page = useOrbitInstanceRemovals.getState().page;
    if (page === null) return null;
    const profile = await page.read;
    if (useOrbitInstanceRemovals.getState().page?.read === page.read) return profile;
  }
}

async function runAttempt(
  startKey: string,
  token: symbol,
  instance: OrbitInstanceRemovalRow & { readonly git?: OrbitInstanceGitState },
  row: OrbitInstanceRemovalRow,
  acknowledgeUnsaved: boolean,
  ports: OrbitInstanceRemovalPorts,
): Promise<OrbitInstanceRemoveOutcome> {
  await Promise.resolve();
  const profile = await readOfCurrentPage();
  if (profile === null || ports.gateway === null) {
    const message =
      ports.gateway === null
        ? "The Orbit Gateway is not available here."
        : "The Orbit Gateway did not answer.";
    updateEntry(startKey, token, (entry) => ({
      ...entry,
      follow: null,
      removal: { status: "failed", refused: true, message, acknowledgeUnsaved, row },
    }));
    return { kind: "failed", code: "gateway.unavailable", message };
  }
  const key = entryKey(profile, instance.id);
  if (key !== startKey) {
    // The click waited for the read: it moves to its profile's key, or yields to the removal
    // that key already runs (also one the same read restored), so no second destroy goes out.
    let moved = false;
    useOrbitInstanceRemovals.setState(({ entries }) => {
      const mine = entries[startKey];
      if (mine?.token !== token) return {};
      const { [startKey]: _pending, ...rest } = entries;
      if (blocksNewRemoval(rest[key])) return { entries: rest };
      moved = true;
      return { entries: { ...rest, [key]: { ...mine, profile } } };
    });
    if (!moved) return REMOVING_ALREADY;
  }
  const attempt: Attempt = {
    key,
    token,
    profile,
    instance,
    row,
    acknowledgeUnsaved,
    ports,
  };
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
        if (useOrbitInstanceRemovals.getState().entries[key]?.token === token) {
          saveRemoval(ports.storage, profile, instance.id, {
            operationId: progress.operationId,
            acknowledgeUnsaved,
            status: "removing",
            message: null,
            row,
          });
        }
        return;
      }
      updateEntry(key, token, (entry) => ({
        ...entry,
        removal: { status: "removing", progress, row },
      }));
    },
  });
  await settle(attempt, outcome, admitted);
  return outcome;
}

/**
 * After the page's list read: waits for this opening's profile read, then drops the failures
 * (and the removed tombstones) of that profile whose Instance left the list, since Orbit removed
 * it after all. `listedIds` are the Instances in the list just read, or null when it failed.
 * Resolves once the follows this opening restored have ended. Without `opening`, opens the page.
 */
export async function restoreOrbitInstanceRemovals(
  ports: OrbitInstanceRemovalPorts,
  listedIds: ReadonlySet<number> | null,
  opening: symbol | null = null,
): Promise<void> {
  const open = useOrbitInstanceRemovals.getState().page;
  const page =
    opening !== null && open?.opening === opening
      ? open
      : openOrbitInstanceRemovalPage(ports, opening ?? undefined);
  const profile = await page.read;
  if (profile !== null && listedIds !== null) {
    const gone = Object.values(useOrbitInstanceRemovals.getState().entries).filter(
      (entry) =>
        entry.profile === profile && entry.follow === null && !listedIds.has(entry.instanceId),
    );
    for (const entry of gone) {
      if (updateEntry(entryKey(profile, entry.instanceId), entry.token, () => null)) {
        saveRemoval(ports.storage, profile, entry.instanceId, null);
      }
    }
  }
  await page.restored;
}

const EMPTY_PAGE: OrbitInstanceRemovalPage = {
  opening: Symbol("no-page"),
  profile: undefined,
  read: Promise.resolve(null),
  restored: Promise.resolve(),
};

/**
 * The Instances page's list: read each time the page opens, then the saved removals of the current
 * Orbit profile on top of it, so a removal from before a restart shows again.
 */
export function useOrbitInstanceListWithRemovals(): {
  readonly list: OrbitInstanceListState;
  /** The removals the page may show (`shownOrbitInstanceRemovals`). */
  readonly removals: Readonly<Record<number, OrbitInstanceRemoval>>;
} {
  const [opening] = useState(() => Symbol("orbit-instances-page"));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the profile, the Gateway list and the saved removals each time the Instances page opens
  useEffect(() => {
    const ports = webOrbitInstanceRemovalPorts();
    openOrbitInstanceRemovalPage(ports, opening);
    void (async () => {
      await loadOrbitInstanceList();
      const { state } = useOrbitInstanceListStore.getState();
      await restoreOrbitInstanceRemovals(
        ports,
        state.status === "loaded" ? new Set(state.rows.map((row) => row.id)) : null,
        opening,
      );
    })();
  }, [opening]);
  const list = useOrbitInstanceListStore((store) => store.state);
  const entries = useOrbitInstanceRemovals((store) => store.entries);
  const page = useOrbitInstanceRemovals((store) => store.page);
  // Until this opening's page is in the store, an earlier opening's profile does not count.
  const removals = shownOrbitInstanceRemovals({
    entries,
    page: page?.opening === opening ? page : { ...EMPTY_PAGE, opening },
  });
  return { list, removals };
}

/** Tests only: forget every removal and the open page. */
export function resetOrbitInstanceRemovalsForTest(): void {
  useOrbitInstanceRemovals.setState({ entries: {}, page: null });
}
