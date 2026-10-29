import {
  isJsonObject,
  PROFILE_SCHEMA_VERSION,
  type JsonObject,
  type JsonValue,
} from "./profileDocument.ts";

/**
 * Three-way merge of profile sections, used when another device wrote a section while this one
 * had unsent edits (`conn.settings_version_conflict`), and to build a push that keeps the keys
 * this client does not know.
 *
 * `base` is the value both sides started from (null when this device never synced the section),
 * `local` holds this device's edits and `remote` is the profile's current value. Per key, a side
 * that did not change it since `base` takes the other side's value. When both changed the same
 * key, the local edit wins: it is the newer intent of the person in front of this device.
 *
 * A key `local` lacks is never deleted: this client only writes keys it understands, so a key it
 * cannot see belongs to another build and survives from `remote` (or `base`).
 */

/** Order-independent deep equality for JSON values. */
export function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  if (isJsonObject(left)) {
    if (!isJsonObject(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

type KeyMerge = (
  base: JsonValue | undefined,
  local: JsonValue,
  remote: JsonValue | undefined,
) => JsonValue;

/** Merges two JSON objects key by key; `special` handles keys that need more than the scalar rule. */
export function mergeKeyed(
  base: JsonObject | null,
  local: JsonObject,
  remote: JsonObject,
  special: Readonly<Record<string, KeyMerge>> = {},
): JsonObject {
  const merged: Record<string, JsonValue> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const mine = local[key];
    const theirs = remote[key];
    if (mine === undefined) {
      if (theirs !== undefined) merged[key] = theirs;
      continue;
    }
    const before = base?.[key];
    const chosen = special[key]
      ? special[key](before, mine, theirs)
      : theirs === undefined || jsonEqual(mine, before)
        ? // Untouched here: the profile's value, unless the profile dropped the key.
          (theirs ?? mine)
        : mine;
    merged[key] = chosen;
  }
  return merged;
}

/** Merges two lists of `{ id }` entries by id, with the workspace rules: an edit beats a delete. */
export function mergeById(
  base: readonly JsonValue[] | undefined,
  local: readonly JsonValue[],
  remote: readonly JsonValue[] | undefined,
): JsonValue[] {
  const index = (list: readonly JsonValue[] | undefined) =>
    new Map(
      (list ?? []).flatMap((entry) =>
        isJsonObject(entry) && typeof entry.id === "string" ? [[entry.id, entry] as const] : [],
      ),
    );
  const baseById = index(base);
  const localById = index(local);
  const remoteById = index(remote ?? local);
  const merged: JsonValue[] = [];
  for (const id of [
    ...new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]),
  ].sort()) {
    const before = baseById.get(id);
    const mine = localById.get(id);
    const theirs = remoteById.get(id);
    const chosen = jsonEqual(mine, before)
      ? theirs
      : jsonEqual(theirs, before)
        ? mine
        : (mine ?? theirs);
    if (chosen !== undefined) merged.push(chosen);
  }
  return merged;
}

/**
 * The appearance section: mode, contrast and each theme slot merge on their own, the custom
 * theme library merges by theme id. A section written by a newer schema is returned as is, so an
 * older client never downgrades it.
 */
export function mergeAppearance(
  base: JsonObject | null,
  local: JsonObject,
  remote: JsonObject,
): JsonObject {
  if (typeof remote.schema === "number" && remote.schema > PROFILE_SCHEMA_VERSION) return remote;
  return mergeKeyed(base, local, remote, {
    themes: (before, mine, theirs) =>
      isJsonObject(mine)
        ? mergeKeyed(isJsonObject(before) ? before : null, mine, isJsonObject(theirs) ? theirs : {})
        : mine,
    customThemes: (before, mine, theirs) =>
      Array.isArray(mine)
        ? mergeById(
            Array.isArray(before) ? before : undefined,
            mine,
            Array.isArray(theirs) ? theirs : undefined,
          )
        : mine,
  });
}

/** A device section: `values` merges per key and keeps the keys this build does not know. */
export function mergeDeviceSection(
  base: JsonObject | null,
  local: JsonObject,
  remote: JsonObject,
): JsonObject {
  if (typeof remote.schema === "number" && remote.schema > PROFILE_SCHEMA_VERSION) return remote;
  return mergeKeyed(base, local, remote, {
    values: (before, mine, theirs) =>
      isJsonObject(mine)
        ? mergeKeyed(isJsonObject(before) ? before : null, mine, isJsonObject(theirs) ? theirs : {})
        : mine,
  });
}

function gatewayForm(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (Array.isArray(value)) {
    return value.map(gatewayForm).filter((entry) => !isEmptyMap(entry));
  }
  if (isJsonObject(value)) {
    const form: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = gatewayForm(entry);
      if (!isEmptyMap(normalized)) form[key] = normalized;
    }
    return form;
  }
  return value;
}

function isEmptyMap(value: JsonValue): boolean {
  return isJsonObject(value) && Object.keys(value).length === 0;
}

/**
 * A section as the Gateway stores it. PHP cannot tell an empty map from an empty list, so the
 * Gateway rejects an empty object anywhere in a section (422); it also trims every string and
 * turns an empty one into null. A client compares and sends values in this form, so what it
 * wrote reads back equal and never counts as a change another device made.
 */
export function toGatewayForm(section: JsonObject): JsonObject {
  return gatewayForm(section) as JsonObject;
}
