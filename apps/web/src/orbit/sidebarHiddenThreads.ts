import {
  createSidebarHiddenThreadsChannel,
  sidebarHiddenThreadKey,
  type SidebarHiddenIntent,
} from "@t3tools/client-runtime/orbit-gateway";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { create } from "zustand";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "../state/shell";
import { notifyLocalProfileChange } from "./profileSyncRegistry";
import {
  isSidebarHiddenThread,
  planSidebarPeek,
  sidebarHiddenMarks,
  type SidebarHiddenMarks,
} from "./sidebarHiddenThreads.logic";

/**
 * Conn: this device's copy of the profile's `sidebarHiddenThreads` and its unsent intents, per
 * profile. The main window's profile sync writes it to the Gateway; other windows follow through
 * the storage event. Kept on the device so the first paint already hides what the profile hides.
 */
const STORAGE_KEY = "t3code:sidebar-hidden-threads:v1";
/** Marks made outside Orbit mode, or before the device knows its profile. */
const NO_PROFILE = "none";

interface ProfileRecord {
  /** The set last agreed with the profile. */
  readonly agreed: readonly string[];
  readonly intents: ReadonlyMap<string, SidebarHiddenIntent>;
  /** Environments a peek surfaced, held until their threads arrive. */
  readonly held: ReadonlySet<string>;
}

interface SidebarHiddenState extends ProfileRecord {
  readonly profile: string;
  readonly marks: SidebarHiddenMarks;
}

const EMPTY_RECORD: ProfileRecord = { agreed: [], intents: new Map(), held: new Set() };

interface StoredFile {
  readonly active: string;
  readonly profiles: Readonly<Record<string, ProfileRecord>>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function readFile(): StoredFile {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return { active: NO_PROFILE, profiles: {} };
    const file = raw as { active?: unknown; profiles?: unknown };
    const profiles: Record<string, ProfileRecord> = {};
    if (typeof file.profiles === "object" && file.profiles !== null) {
      for (const [profile, value] of Object.entries(file.profiles)) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as { agreed?: unknown; intents?: unknown; held?: unknown };
        const intents = new Map<string, SidebarHiddenIntent>();
        if (Array.isArray(record.intents)) {
          for (const entry of record.intents) {
            if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
            if (entry[1] === "hide" || entry[1] === "show") intents.set(entry[0], entry[1]);
          }
        }
        profiles[profile] = {
          agreed: strings(record.agreed),
          intents,
          held: new Set(strings(record.held)),
        };
      }
    }
    return { active: typeof file.active === "string" ? file.active : NO_PROFILE, profiles };
  } catch {
    return { active: NO_PROFILE, profiles: {} };
  }
}

function writeRecord(profile: string, record: ProfileRecord): void {
  try {
    const file = readFile();
    const profiles: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...file.profiles, [profile]: record })) {
      profiles[key] = {
        agreed: value.agreed,
        intents: [...value.intents],
        held: [...value.held],
      };
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ active: profile, profiles }));
  } catch {
    // Storage full or blocked: the marks still hold in memory until the next restart.
  }
}

function stateFor(profile: string, record: ProfileRecord): SidebarHiddenState {
  return { profile, ...record, marks: sidebarHiddenMarks(record) };
}

function loadState(): SidebarHiddenState {
  const file = typeof window === "undefined" ? null : readFile();
  const profile = file?.active ?? NO_PROFILE;
  return stateFor(profile, file?.profiles[profile] ?? EMPTY_RECORD);
}

export const useSidebarHiddenThreads = create<SidebarHiddenState>(loadState);

function update(change: (record: ProfileRecord) => ProfileRecord, sync = true): void {
  const state = useSidebarHiddenThreads.getState();
  const next = change(state);
  if (next.agreed === state.agreed && next.intents === state.intents && next.held === state.held) {
    return;
  }
  useSidebarHiddenThreads.setState(stateFor(state.profile, next));
  writeRecord(state.profile, next);
  if (sync) notifyLocalProfileChange();
}

/** The profile the marks belong to; the profile sync calls it before each run. */
export function setSidebarHiddenProfile(profileId: number | null): void {
  const profile = profileId === null ? NO_PROFILE : String(profileId);
  if (useSidebarHiddenThreads.getState().profile === profile) return;
  const record = readFile().profiles[profile] ?? EMPTY_RECORD;
  useSidebarHiddenThreads.setState(stateFor(profile, record));
  writeRecord(profile, record);
  for (const environmentId of record.held) sweepWhenLive(environmentId);
}

function setIntent(key: string, intent: SidebarHiddenIntent | null): void {
  update((record) => {
    if ((record.intents.get(key) ?? null) === intent) return record;
    const intents = new Map(record.intents);
    // Re-inserting moves the key to the end, so a new hide is the newest mark.
    intents.delete(key);
    if (intent !== null) intents.set(key, intent);
    return { ...record, intents };
  });
}

export function hideSidebarThread(ref: { environmentId: string; threadId: string }): void {
  setIntent(sidebarHiddenThreadKey(ref.environmentId, ref.threadId), "hide");
}

/** An explicit open: this thread shows, wins over any hide still queued for it. */
export function showSidebarThread(ref: { environmentId: string; threadId: string }): void {
  setIntent(sidebarHiddenThreadKey(ref.environmentId, ref.threadId), "show");
}

/** Undoes what a peek that failed to connect did, unless something else changed it since. */
export function cancelSidebarPeek(
  ref: { environmentId: string; threadId: string },
  undo: { readonly hid: boolean; readonly held: boolean },
): void {
  const key = sidebarHiddenThreadKey(ref.environmentId, ref.threadId);
  update((record) => {
    const dropIntent = undo.hid && record.intents.get(key) === "hide";
    const dropHold = undo.held && record.held.has(ref.environmentId);
    if (!dropIntent && !dropHold) return record;
    const intents = new Map(record.intents);
    const held = new Set(record.held);
    if (dropIntent) intents.delete(key);
    if (dropHold) held.delete(ref.environmentId);
    return { ...record, intents, held };
  });
}

/** Holds an environment's threads hidden until they arrive, then marks each one hidden. */
export function holdSidebarEnvironment(environmentId: string): void {
  update((record) =>
    record.held.has(environmentId)
      ? record
      : { ...record, held: new Set([...record.held, environmentId]) },
  );
  sweepWhenLive(environmentId);
}

const sweeping = new Map<string, () => void>();

function sweepWhenLive(environmentId: string): void {
  if (sweeping.has(environmentId)) return;
  let unsubscribe: (() => void) | null = null;
  let done = false;
  const finish = () => {
    done = true;
    sweeping.delete(environmentId);
    unsubscribe?.();
  };
  sweeping.set(environmentId, finish);
  unsubscribe = appAtomRegistry.subscribe(
    environmentShell.stateValueAtom(environmentId as EnvironmentId),
    (shell) => {
      if (done || shell.status !== "live" || Option.isNone(shell.snapshot)) return;
      const threadIds = shell.snapshot.value.threads.map((thread) => String(thread.id));
      update((record) => {
        if (!record.held.has(environmentId)) return record;
        const intents = new Map(record.intents);
        for (const threadId of threadIds) {
          const key = sidebarHiddenThreadKey(environmentId, threadId);
          if (!intents.has(key)) intents.set(key, "hide");
        }
        const held = new Set(record.held);
        held.delete(environmentId);
        return { ...record, intents, held };
      });
      finish();
    },
    { immediate: true },
  );
  if (done) unsubscribe();
}

/** Whether the sidebar lists a thread now: a loaded, unarchived thread nothing hides. */
export function isSidebarListedNow(
  environmentId: string,
  thread: { readonly archivedAt: string | null; readonly id: string } | null,
): boolean {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    !isSidebarHiddenThread(useSidebarHiddenThreads.getState().marks, environmentId, thread.id)
  );
}

export const sidebarHiddenThreadsChannel = createSidebarHiddenThreadsChannel({
  read: () => useSidebarHiddenThreads.getState(),
  adopt: (agreed, intents) =>
    update((record) => {
      const sameAgreed =
        agreed.length === record.agreed.length &&
        agreed.every((key, index) => key === record.agreed[index]);
      const sameIntents = intents.size === record.intents.size;
      if (sameAgreed && sameIntents) return record;
      return {
        ...record,
        agreed: sameAgreed ? record.agreed : agreed,
        intents: sameIntents ? record.intents : intents,
      };
    }, false),
});

let storageWatched = false;
/** Another window changed the marks: take them, and let the main window's sync send them. */
export function watchSidebarHiddenThreads(): void {
  if (storageWatched || typeof window === "undefined") return;
  storageWatched = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const { profile } = useSidebarHiddenThreads.getState();
    useSidebarHiddenThreads.setState(
      stateFor(profile, readFile().profiles[profile] ?? EMPTY_RECORD),
    );
    notifyLocalProfileChange();
  });
  for (const environmentId of useSidebarHiddenThreads.getState().held) {
    sweepWhenLive(environmentId);
  }
}

/**
 * A Tasks agent click: opens the conversation without adding it to the sidebar. A thread the
 * sidebar lists stays listed; any other is hidden, and an environment the click surfaces (unpaired
 * or switched off here) is held so its other threads do not flash in. Returns the undo for a
 * click whose environment then fails to connect.
 */
export function beginSidebarPeek(
  target: { environmentId: string; threadId: string },
  facts: { readonly targetListed: boolean; readonly environmentSurfaced: boolean },
): () => void {
  const plan = planSidebarPeek(facts);
  const { intents, held } = useSidebarHiddenThreads.getState();
  const key = sidebarHiddenThreadKey(target.environmentId, target.threadId);
  const undo = {
    hid: plan.hideTarget && intents.get(key) !== "hide",
    held: plan.holdEnvironment && !held.has(target.environmentId),
  };
  if (plan.hideTarget) hideSidebarThread(target);
  if (plan.holdEnvironment) holdSidebarEnvironment(target.environmentId);
  return () => cancelSidebarPeek(target, undo);
}
