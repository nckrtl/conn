import {
  APPEARANCE_SECTION,
  DESKTOP_DEVICE_SECTION,
  isJsonObject,
  type JsonObject,
  type ProfileSectionName,
  type ProfileSyncSectionState,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
/** The profile sync state this device keeps: per section, the versions and values last agreed on. */
const SECTION_STATE_KEY = "t3code:orbit-profile-sections:v1";
/** Per-device opt-outs and backups of builds that let the user switch sync off or restore. */
const REMOVED_KEYS = [
  "t3code:orbit-profile-sync-opt-out:v1",
  "t3code:orbit-profile-sync-backup:v1",
] as const;

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

export function forgetRemovedProfileSyncKeys(): void {
  try {
    for (const key of REMOVED_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the old keys are never read, so leaving them does no harm.
  }
}
