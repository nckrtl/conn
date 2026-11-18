import {
  createSidebarHiddenThreadsChannel,
  sidebarHiddenThreadKey,
  type ProfileSyncChannel,
  type SidebarHiddenIntent,
  type SidebarHiddenOp,
} from "@t3tools/client-runtime/orbit-gateway";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { create } from "zustand";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "../state/shell";
import { useEnvironmentProvider } from "./environmentProvider";
import { notifyLocalProfileChange } from "./profileSyncRegistry";
import {
  NO_SIDEBAR_HIDDEN_MARKS,
  planSidebarPeek,
  sidebarHiddenMarks,
  type SidebarHiddenMarks,
  type SidebarPeekAttempt,
  type SidebarPeekedEnvironment,
} from "./sidebarHiddenThreads.logic";

/**
 * Conn: this device's sidebar marks, one localStorage entry per thread intent, peek attempt and
 * peeked environment, so two windows that edit different threads never overwrite each other. The
 * main window's profile sync alone writes `active` and each profile's `agreed` set; every window
 * follows them through the storage event.
 */
const PREFIX = "t3code:sidebar-hidden-threads:v2:";
const ACTIVE_KEY = `${PREFIX}active`;
/** Marks made with no profile bound, also before the first bind; the first bind takes them. */
const NO_PROFILE = "none";

const agreedKey = (profile: string) => `${PREFIX}agreed:${profile}`;
const opKey = (profile: string, key: string) => `${PREFIX}op:${profile}:${key}`;
const attemptKey = (id: string) => `${PREFIX}attempt:${id}`;
const peekedKey = (profile: string, environmentId: string) =>
  `${PREFIX}env:${profile}:${environmentId}`;

interface Stored {
  /** null until the main window binds a profile for the first time. */
  readonly active: string | null;
  readonly agreed: Map<string, string[]>;
  readonly ops: Map<string, Map<string, SidebarHiddenOp>>;
  readonly attempts: Map<string, SidebarPeekAttempt>;
  readonly peeked: Map<string, Map<string, SidebarPeekedEnvironment>>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function parse(raw: string | null): unknown {
  try {
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** `<profile>:<rest>`; profiles never hold a ":". */
function split(rest: string): [string, string] | null {
  const separator = rest.indexOf(":");
  return separator <= 0 ? null : [rest.slice(0, separator), rest.slice(separator + 1)];
}

function inner<V>(map: Map<string, Map<string, V>>, profile: string): Map<string, V> {
  let entry = map.get(profile);
  if (!entry) map.set(profile, (entry = new Map()));
  return entry;
}

function readStored(): Stored {
  const stored: Stored = {
    active: null,
    agreed: new Map(),
    ops: new Map(),
    attempts: new Map(),
    peeked: new Map(),
  };
  if (typeof window === "undefined") return stored;
  const storage = window.localStorage;
  let active: string | null = null;
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index);
    if (name === null || !name.startsWith(PREFIX)) continue;
    const value = parse(storage.getItem(name));
    const rest = name.slice(PREFIX.length);
    if (name === ACTIVE_KEY) {
      if (typeof value === "string") active = value;
    } else if (rest.startsWith("agreed:")) {
      stored.agreed.set(rest.slice("agreed:".length), strings(value));
    } else if (rest.startsWith("op:")) {
      const parts = split(rest.slice("op:".length));
      const op = value as Partial<SidebarHiddenOp> | null;
      if (!parts || typeof op !== "object" || op === null || typeof op.id !== "string") continue;
      if (op.intent !== "hide" && op.intent !== "show") continue;
      inner(stored.ops, parts[0]).set(parts[1], { intent: op.intent, id: op.id });
    } else if (rest.startsWith("attempt:")) {
      const attempt = value as Partial<SidebarPeekAttempt> | null;
      if (typeof attempt !== "object" || attempt === null) continue;
      if (typeof attempt.profile !== "string" || typeof attempt.environmentId !== "string")
        continue;
      stored.attempts.set(rest.slice("attempt:".length), {
        profile: attempt.profile,
        environmentId: attempt.environmentId,
        target: typeof attempt.target === "string" ? attempt.target : null,
        hold: attempt.hold === true,
        committed: attempt.committed === true,
        shown: strings(attempt.shown),
      });
    } else if (rest.startsWith("env:")) {
      const parts = split(rest.slice("env:".length));
      const entry = value as Partial<SidebarPeekedEnvironment> | null;
      if (!parts || typeof entry !== "object" || entry === null) continue;
      if (typeof entry.cutoff !== "string") continue;
      inner(stored.peeked, parts[0]).set(parts[1], {
        cutoff: entry.cutoff,
        shown: strings(entry.shown),
      });
    }
  }
  return { ...stored, active };
}

function write(name: string, value: unknown): void {
  try {
    if (value === undefined) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the marks hold until the next read.
  }
}

const bucket = (active: string | null) => active ?? NO_PROFILE;

/** Environments Orbit provides on this device: their rows wait for the profile's marks. */
function orbitEnvironmentIds(): string[] {
  const { provider, state, orbitInstances } = useEnvironmentProvider.getState();
  if (provider !== "orbit") return [];
  return [
    ...state.pairedByOrbit,
    ...Object.keys(state.pairAttemptedAt ?? {}),
    ...Object.keys(orbitInstances),
  ];
}

interface SidebarHiddenState {
  /** The profile the marks belong to; null before the main window's first bind. */
  readonly active: string | null;
  readonly marks: SidebarHiddenMarks;
}

let lastSignature = "";

function compute(): SidebarHiddenState {
  const stored = readStored();
  const profile = bucket(stored.active);
  // Not read yet: before the first bind, or a bound profile whose section never loaded.
  const hydrated =
    stored.active === NO_PROFILE || (stored.active !== null && stored.agreed.has(stored.active));
  const input = {
    agreed: stored.agreed.get(profile) ?? [],
    ops: stored.ops.get(profile) ?? new Map<string, SidebarHiddenOp>(),
    attempts: [...stored.attempts.values()].filter((attempt) => attempt.profile === profile),
    peeked: stored.peeked.get(profile) ?? new Map<string, SidebarPeekedEnvironment>(),
    unhydrated: hydrated ? [] : orbitEnvironmentIds(),
  };
  lastSignature = JSON.stringify([
    stored.active,
    input.agreed,
    [...input.ops].map(([key, op]) => [key, op.intent]),
    input.attempts,
    [...input.peeked],
    input.unhydrated,
  ]);
  return { active: stored.active, marks: sidebarHiddenMarks(input) };
}

export const useSidebarHiddenThreads = create<SidebarHiddenState>(() =>
  typeof window === "undefined" ? { active: null, marks: NO_SIDEBAR_HIDDEN_MARKS } : compute(),
);

function refresh(): void {
  const previous = lastSignature;
  const next = compute();
  if (lastSignature !== previous) useSidebarHiddenThreads.setState(next);
}

function setOp(profile: string, key: string, intent: SidebarHiddenIntent): void {
  write(opKey(profile, key), { intent, id: randomUUID() });
}

/**
 * The main window's profile sync names the profile before each run; `null` unbinds (no profile,
 * or Orbit mode off). Marks made before the first bind, or while unbound, move to the profile.
 */
export function bindSidebarHiddenProfile(profileId: number | null): void {
  const stored = readStored();
  const next = profileId === null ? NO_PROFILE : String(profileId);
  if (stored.active === next) return;
  if (next !== NO_PROFILE && bucket(stored.active) === NO_PROFILE) {
    for (const [key, op] of stored.ops.get(NO_PROFILE) ?? []) {
      write(opKey(next, key), op);
      write(opKey(NO_PROFILE, key), undefined);
    }
    for (const [environmentId, entry] of stored.peeked.get(NO_PROFILE) ?? []) {
      write(peekedKey(next, environmentId), entry);
      write(peekedKey(NO_PROFILE, environmentId), undefined);
    }
    for (const [id, attempt] of stored.attempts) {
      if (attempt.profile === NO_PROFILE) write(attemptKey(id), { ...attempt, profile: next });
    }
  } else if (next === NO_PROFILE && stored.active !== null) {
    // Leaving a profile: what an earlier unbound spell left is not this one's to carry over.
    for (const key of stored.ops.get(NO_PROFILE)?.keys() ?? []) {
      write(opKey(NO_PROFILE, key), undefined);
    }
  }
  write(ACTIVE_KEY, next);
  refresh();
  resumeSweeps();
}

export function hideSidebarThread(ref: { environmentId: string; threadId: string }): void {
  setOp(
    bucket(readStored().active),
    sidebarHiddenThreadKey(ref.environmentId, ref.threadId),
    "hide",
  );
  refresh();
  notifyLocalProfileChange();
}

/**
 * An explicit open: this thread shows, wins over any hide still queued for it, and stays out of
 * any sweep of its environment's threads, also after the profile acknowledges the show.
 */
export function showSidebarThread(ref: { environmentId: string; threadId: string }): void {
  const stored = readStored();
  const profile = bucket(stored.active);
  const key = sidebarHiddenThreadKey(ref.environmentId, ref.threadId);
  setOp(profile, key, "show");
  const peeked = stored.peeked.get(profile)?.get(ref.environmentId);
  if (peeked && !peeked.shown.includes(key)) {
    write(peekedKey(profile, ref.environmentId), { ...peeked, shown: [...peeked.shown, key] });
  }
  for (const [id, attempt] of stored.attempts) {
    if (attempt.profile !== profile || attempt.environmentId !== ref.environmentId) continue;
    if (!attempt.shown.includes(key)) {
      write(attemptKey(id), { ...attempt, shown: [...attempt.shown, key] });
    }
  }
  refresh();
  notifyLocalProfileChange();
}

const sweeping = new Map<string, () => void>();

/** Once a held environment's threads arrive, each one nobody showed is marked hidden. */
function sweepWhenLive(profile: string, environmentId: string): void {
  const id = `${profile}|${environmentId}`;
  if (sweeping.has(id)) return;
  let unsubscribe: (() => void) | null = null;
  let done = false;
  const finish = () => {
    done = true;
    sweeping.delete(id);
    unsubscribe?.();
  };
  sweeping.set(id, finish);
  unsubscribe = appAtomRegistry.subscribe(
    environmentShell.stateValueAtom(environmentId as EnvironmentId),
    (shell) => {
      if (done || shell.status !== "live" || Option.isNone(shell.snapshot)) return;
      finish();
      sweep(
        profile,
        environmentId,
        shell.snapshot.value.threads.map((thread) => ({
          id: String(thread.id),
          createdAt: DateTime.formatIso(thread.createdAt),
        })),
      );
    },
    { immediate: true },
  );
  if (done) unsubscribe();
}

function sweep(
  profile: string,
  environmentId: string,
  threads: ReadonlyArray<{ readonly id: string; readonly createdAt: string }>,
): void {
  const stored = readStored();
  const holds = [...stored.attempts].filter(
    ([, attempt]) =>
      attempt.profile === profile &&
      attempt.environmentId === environmentId &&
      attempt.hold &&
      attempt.committed,
  );
  if (holds.length === 0) return;
  const previous = stored.peeked.get(profile)?.get(environmentId);
  const shown = new Set(previous?.shown ?? []);
  for (const [, attempt] of holds) for (const key of attempt.shown) shown.add(key);
  const ops = stored.ops.get(profile);
  const agreed = new Set(stored.agreed.get(profile) ?? []);
  // The server's own clock: what it created up to the newest thread it sent is the inventory.
  let cutoff = previous?.cutoff ?? "";
  for (const thread of threads) {
    const key = sidebarHiddenThreadKey(environmentId, String(thread.id));
    if (thread.createdAt > cutoff) cutoff = thread.createdAt;
    if (shown.has(key) || ops?.has(key) || agreed.has(key)) continue;
    setOp(profile, key, "hide");
  }
  write(peekedKey(profile, environmentId), {
    cutoff: cutoff === "" ? new Date().toISOString() : cutoff,
    shown: [...shown],
  });
  for (const [attemptId] of holds) write(attemptKey(attemptId), undefined);
  refresh();
  notifyLocalProfileChange();
}

function resumeSweeps(): void {
  const stored = readStored();
  const profile = bucket(stored.active);
  for (const attempt of stored.attempts.values()) {
    if (attempt.profile === profile && attempt.hold && attempt.committed) {
      sweepWhenLive(profile, attempt.environmentId);
    }
  }
}

/** The thread keys the sidebar of this window lists now, under its scope. */
let listedThreadKeys: ReadonlySet<string> = new Set();

export function publishSidebarListedThreads(keys: ReadonlySet<string>): void {
  listedThreadKeys = keys;
}

/** Whether this window's sidebar lists the thread now: a row under the current scope. */
export function isSidebarListedNow(environmentId: string, threadId: string): boolean {
  return listedThreadKeys.has(sidebarHiddenThreadKey(environmentId, threadId));
}

/** The sync channel for one profile; its reads and acknowledgements never touch another one. */
export function sidebarHiddenThreadsChannel(profileId: number): ProfileSyncChannel {
  const profile = String(profileId);
  return createSidebarHiddenThreadsChannel({
    read: () => {
      const stored = readStored();
      return {
        agreed: stored.agreed.get(profile) ?? [],
        ops: stored.ops.get(profile) ?? new Map(),
      };
    },
    adopt: (agreed, done) => {
      write(agreedKey(profile), agreed);
      for (const [key, id] of done) {
        // Retired only while the op is the one the write carried; a newer edit stays.
        const current = parse(window.localStorage.getItem(opKey(profile, key))) as {
          id?: unknown;
        } | null;
        if (current?.id === id) write(opKey(profile, key), undefined);
      }
      refresh();
    },
  });
}

let watched = false;
/** Follows the marks other windows and the main window's sync write. */
export function watchSidebarHiddenThreads(): void {
  if (watched || typeof window === "undefined") return;
  watched = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== null && !event.key.startsWith(PREFIX)) return;
    const before = useSidebarHiddenThreads.getState().active;
    refresh();
    if (useSidebarHiddenThreads.getState().active !== before) resumeSweeps();
    // Another window's edit: the main window's sync sends it.
    if (event.key?.startsWith(`${PREFIX}op:`)) notifyLocalProfileChange();
  });
  useEnvironmentProvider.subscribe(refresh);
  resumeSweeps();
}

export interface SidebarPeek {
  /** Preparation succeeded: the target's hide becomes a mark and a hold waits for the threads. */
  readonly commit: () => void;
  /** Preparation failed: only this attempt's effects go. */
  readonly cancel: () => void;
}

const NO_PEEK: SidebarPeek = { commit: () => {}, cancel: () => {} };

/**
 * A Tasks agent click: opens the conversation without adding it to the sidebar. A thread the
 * sidebar lists stays listed; any other is hidden, and an environment the click surfaces (unpaired
 * or switched off here) is held so its other threads do not flash in. Until `commit`, both are
 * this attempt's own, so an overlapping peek or a profile switch never takes them over.
 */
export function beginSidebarPeek(
  target: { environmentId: string; threadId: string },
  facts: { readonly targetListed: boolean; readonly environmentSurfaced: boolean },
): SidebarPeek {
  const plan = planSidebarPeek(facts);
  if (!plan.hideTarget && !plan.holdEnvironment) return NO_PEEK;
  const id = randomUUID();
  const key = sidebarHiddenThreadKey(target.environmentId, target.threadId);
  const attempt: SidebarPeekAttempt = {
    profile: bucket(readStored().active),
    environmentId: target.environmentId,
    target: plan.hideTarget ? key : null,
    hold: plan.holdEnvironment,
    committed: false,
    shown: [],
  };
  write(attemptKey(id), attempt);
  refresh();
  return {
    commit: () => {
      const stored = readStored();
      const current = stored.attempts.get(id);
      if (!current) return;
      if (current.profile !== bucket(stored.active)) {
        write(attemptKey(id), undefined);
      } else {
        if (current.target !== null && !current.shown.includes(current.target)) {
          setOp(current.profile, current.target, "hide");
        }
        if (current.hold) {
          write(attemptKey(id), { ...current, target: null, committed: true });
          sweepWhenLive(current.profile, current.environmentId);
        } else {
          write(attemptKey(id), undefined);
        }
        notifyLocalProfileChange();
      }
      refresh();
    },
    cancel: () => {
      write(attemptKey(id), undefined);
      refresh();
    },
  };
}
