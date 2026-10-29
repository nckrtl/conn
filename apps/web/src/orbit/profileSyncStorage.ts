import {
  APPEARANCE_SECTION,
  DESKTOP_DEVICE_SECTION,
  isJsonObject,
  withoutSection,
  type JsonObject,
  type ProfileSectionName,
  type ProfileSyncSectionState,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
import { create } from "zustand";

/**
 * What the profile sync keeps in this device's localStorage: the sync state (versions and the
 * values last agreed on), the opt-outs, and the backup a first sync leaves behind. All of it is
 * local on purpose: another device must not be able to switch this one's sync off.
 */

const SECTION_STATE_KEY = "t3code:orbit-profile-sections:v1";
const OPT_OUT_KEY = "t3code:orbit-profile-sync-opt-out:v1";
const BACKUP_KEY = "t3code:orbit-profile-sync-backup:v1";

/** The two things the Settings block lets the user turn off. */
export const SYNC_GROUPS = {
  appearance: APPEARANCE_SECTION,
  device: DESKTOP_DEVICE_SECTION,
} as const satisfies Record<string, ProfileSectionName>;
export type SyncGroup = keyof typeof SYNC_GROUPS;

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the sync still works in memory until the next restart.
  }
}

function sectionStates(value: unknown): ProfileSyncState["sections"] {
  const sections: Partial<Record<ProfileSectionName, ProfileSyncSectionState>> = {};
  if (!isJsonObject(value)) return sections;
  for (const name of [APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION] as const) {
    const entry = value[name];
    if (!isJsonObject(entry) || typeof entry.version !== "number") continue;
    sections[name] = {
      version: entry.version,
      base: isJsonObject(entry.base) ? entry.base : null,
      remote: isJsonObject(entry.remote) ? entry.remote : null,
    };
  }
  return sections;
}

function ignoredValues(value: unknown): ProfileSyncState["ignored"] {
  const ignored: Partial<Record<ProfileSectionName, JsonObject>> = {};
  if (!isJsonObject(value)) return ignored;
  for (const name of [APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION] as const) {
    const entry = value[name];
    if (isJsonObject(entry)) ignored[name] = entry;
  }
  return ignored;
}

export function loadSectionState(): ProfileSyncState | null {
  const raw = readJson(SECTION_STATE_KEY);
  if (!isJsonObject(raw) || typeof raw.profileId !== "number") return null;
  return {
    profileId: raw.profileId,
    profileVersion: typeof raw.profileVersion === "number" ? raw.profileVersion : -1,
    sections: sectionStates(raw.sections),
    ignored: ignoredValues(raw.ignored),
  };
}

export function saveSectionState(state: ProfileSyncState): void {
  writeJson(SECTION_STATE_KEY, state);
}

/** Forgets one section's sync state, so turning it on again is a first sync. */
export function forgetSectionState(name: ProfileSectionName): void {
  const state = loadSectionState();
  if (state) saveSectionState(withoutSection(state, name));
}

type OptOuts = Readonly<Record<SyncGroup, boolean>>;

function loadOptOuts(): OptOuts {
  const raw = readJson(OPT_OUT_KEY);
  const flags = isJsonObject(raw) ? raw : {};
  return { appearance: flags.appearance === true, device: flags.device === true };
}

/** Which groups the user turned off on this device. */
export const useProfileSyncOptOuts = create<OptOuts>(() => loadOptOuts());

export function isSectionSyncEnabled(name: ProfileSectionName): boolean {
  const optOuts = useProfileSyncOptOuts.getState();
  if (name === APPEARANCE_SECTION) return !optOuts.appearance;
  if (name === DESKTOP_DEVICE_SECTION) return !optOuts.device;
  return true;
}

export function setGroupSyncEnabled(group: SyncGroup, enabled: boolean): void {
  const next = { ...useProfileSyncOptOuts.getState(), [group]: !enabled };
  writeJson(OPT_OUT_KEY, next);
  useProfileSyncOptOuts.setState(next);
  // Off keeps nothing of the old agreement: back on, the profile wins again (with a backup).
  if (!enabled) forgetSectionState(SYNC_GROUPS[group]);
}

export interface SectionBackup {
  readonly savedAt: number;
  readonly value: JsonObject;
}
type Backups = Readonly<Partial<Record<ProfileSectionName, SectionBackup>>>;

function loadBackups(): Backups {
  const raw = readJson(BACKUP_KEY);
  const backups: Partial<Record<ProfileSectionName, SectionBackup>> = {};
  if (!isJsonObject(raw)) return backups;
  for (const name of [APPEARANCE_SECTION, DESKTOP_DEVICE_SECTION] as const) {
    const entry = raw[name];
    if (isJsonObject(entry) && typeof entry.savedAt === "number" && isJsonObject(entry.value)) {
      backups[name] = { savedAt: entry.savedAt, value: entry.value };
    }
  }
  return backups;
}

/** What this device had before the profile's values replaced them, per section. */
export const useProfileSyncBackups = create<Backups>(() => loadBackups());

export function saveSectionBackup(name: ProfileSectionName, value: JsonObject): void {
  const next = { ...useProfileSyncBackups.getState(), [name]: { savedAt: Date.now(), value } };
  writeJson(BACKUP_KEY, next);
  useProfileSyncBackups.setState(next);
}
