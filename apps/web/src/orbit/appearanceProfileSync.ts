import {
  APPEARANCE_SECTION,
  mergeAppearance,
  parseProfileAppearance,
  PROFILE_LIMITS,
  PROFILE_SCHEMA_VERSION,
  type JsonObject,
  type ProfileAppearance,
  type ProfileCustomTheme,
  type ProfileSyncChannel,
  type ProfileThemeSlot,
} from "@t3tools/client-runtime/orbit-gateway";
import { MAX_APPEARANCE_CONTRAST, MIN_APPEARANCE_CONTRAST } from "@t3tools/contracts/settings";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import { readAppearanceModePreference, readThemeHalvesRaw } from "../hooks/useTheme";
import {
  canonicalThemePreference,
  getCustomThemes,
  getDefaultThemeColors,
  getEnvironmentThemes,
  getThemeColorsForMode,
  getThemeDefinition,
  installCustomTheme,
  lenientThemeColorOverrides,
  removeCustomThemes,
  resolveThemeHalf,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
  type ThemePreferenceMode,
} from "../themePalette";

/**
 * The profile's `appearance` section: mode, contrast, one theme per appearance and the custom
 * library, read and applied through the public theme functions. Custom and published themes carry
 * their palette; missing ones install read-only in "From profile" and never sync back.
 */

export const PROFILE_THEME_COLLECTION = { id: "orbit-profile", label: "From profile" } as const;

const STOCK_SLOT: ProfileThemeSlot = { id: "t3-code", source: "stock" };
const APPEARANCES = ["light", "dark"] as const satisfies readonly ThemeAppearance[];

const builtInIds: ReadonlySet<string> = new Set(BUILT_IN_THEMES.map((theme) => theme.id));

function isProfileCopy(theme: ThemeDefinition): boolean {
  return theme.collection?.id === PROFILE_THEME_COLLECTION.id;
}

/** What this desktop does to the theme state. The component passes the `useTheme()` setters. */
export interface AppearanceHost {
  readonly contrast: () => number;
  readonly setContrast: (value: number) => void;
  readonly setTheme: (themeId: string) => boolean;
  readonly setThemeHalf: (appearance: ThemeAppearance, themeId: string | null) => boolean;
  readonly setAppearanceMode: (mode: ThemePreferenceMode) => boolean;
}

function colorsJson(colors: Readonly<Record<string, string>>): Record<string, string> {
  return { ...colors };
}

/** The base theme preference, as `useTheme` stores it (`t3code:theme`); read raw, see `slotFor`. */
const THEME_PREFERENCE_STORAGE_KEY = "t3code:theme";
const STOCK_THEME_IDS: ReadonlySet<string> = new Set(["system", "light", "dark"]);

type RawHalves = ReturnType<typeof readThemeHalvesRaw>;

function readRawTheme(): string {
  const raw = window.localStorage.getItem(THEME_PREFERENCE_STORAGE_KEY);
  return raw === null ? "system" : canonicalThemePreference(raw);
}

/**
 * The slot for one appearance, or null while its theme cannot resolve yet: sending "stock" for an
 * unstreamed published theme would overwrite the profile. `last`, the slot the profile last agreed
 * on, stands in for an unresolved theme it already names.
 */
function slotFor(
  appearance: ThemeAppearance,
  theme: string,
  halves: RawHalves,
  last: ProfileThemeSlot | null,
): ProfileThemeSlot | null {
  const id = resolveThemeHalf(theme, halves, appearance);
  const definition = getThemeDefinition(id);
  if (definition === null) {
    if (STOCK_THEME_IDS.has(id)) return STOCK_SLOT;
    return last !== null && last.id === id ? last : null;
  }
  // A theme that cannot render this appearance (a dark-only theme in the light slot) does not
  // belong in the slot: the profile would hand the other devices a dark palette to wear in
  // light mode. The slot reads as the stock look, as it does for a device that has no pick.
  const forSlot = getThemeColorsForMode(definition, appearance);
  if (forSlot === null) return STOCK_SLOT;
  if (builtInIds.has(definition.id)) return { id: definition.id, source: "builtin" };
  // The Gateway rejects an empty palette; a theme without colors reads as the stock look.
  if (Object.keys(forSlot).length === 0) return STOCK_SLOT;
  const inLibrary = getCustomThemes().some(
    (theme) => theme.id === definition.id && !isProfileCopy(theme),
  );
  return {
    id: definition.id,
    name: definition.label,
    source: inLibrary ? "custom" : "published",
    appearance,
    colors: colorsJson(forSlot),
  };
}

/**
 * One library theme, or null when it has no colors to send. The Gateway rejects empty maps
 * (PHP cannot tell `{}` from `[]`), so an empty variant is left out and a theme without a base
 * palette is not synced at all.
 */
function customThemeJson(theme: ThemeDefinition): ProfileCustomTheme | null {
  if (Object.keys(theme.colors).length === 0) return null;
  const variants = Object.fromEntries(
    Object.entries(theme.variants ?? {})
      .filter(([, colors]) => Object.keys(colors).length > 0)
      .map(([appearance, colors]) => [appearance, colorsJson(colors)]),
  );
  return {
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: colorsJson(theme.colors),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(theme.collection ? { collection: { ...theme.collection } } : {}),
  };
}

/** The appearance section for this device's theme state, or null while a theme is unresolved. */
export function serializeAppearance(input: {
  readonly theme: string;
  readonly halves: RawHalves;
  readonly mode: ThemePreferenceMode;
  readonly contrast: number;
  readonly library: readonly ThemeDefinition[];
  readonly last?: ProfileAppearance | null;
}): JsonObject | null {
  const light = slotFor("light", input.theme, input.halves, input.last?.themes.light ?? null);
  const dark = slotFor("dark", input.theme, input.halves, input.last?.themes.dark ?? null);
  if (light === null || dark === null) return null;
  const customThemes = [...input.library]
    .filter((theme) => !isProfileCopy(theme))
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .flatMap((theme) => customThemeJson(theme) ?? [])
    .slice(0, PROFILE_LIMITS.customThemes);
  const section: ProfileAppearance = {
    schema: PROFILE_SCHEMA_VERSION,
    mode: input.mode,
    contrast: input.contrast,
    themes: { light, dark },
    customThemes,
  };
  return section as unknown as JsonObject;
}

/**
 * This device's appearance, or null while it cannot be read or names a theme that has not
 * arrived. `base` is the section last agreed with the profile.
 */
export function readLocalAppearance(
  host: Pick<AppearanceHost, "contrast">,
  base: JsonObject | null = null,
): JsonObject | null {
  try {
    const theme = readRawTheme();
    return serializeAppearance({
      theme,
      halves: readThemeHalvesRaw(),
      mode: readAppearanceModePreference(theme),
      contrast: host.contrast(),
      library: getCustomThemes(),
      last: parseProfileAppearance(base),
    });
  } catch {
    return null;
  }
}

function toThemeDefinition(
  theme: ProfileCustomTheme,
  collection?: ThemeDefinition["collection"],
): ThemeDefinition {
  const withDefaults = (appearance: ThemeAppearance, colors: Readonly<Record<string, string>>) =>
    ({
      ...getDefaultThemeColors(appearance),
      ...lenientThemeColorOverrides(colors),
    }) satisfies ThemeColors;
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const appearance of APPEARANCES) {
    const colors = theme.variants?.[appearance];
    if (colors && appearance !== theme.appearance)
      variants[appearance] = withDefaults(appearance, colors);
  }
  const itsCollection = collection ?? theme.collection;
  return {
    id: theme.id,
    label: theme.name.trim().slice(0, 48),
    appearance: theme.appearance,
    colors: withDefaults(theme.appearance, theme.colors),
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(itsCollection ? { collection: itsCollection } : {}),
  };
}

/** Installs or updates one theme in the library; a theme the library refuses is skipped. */
function upsertTheme(definition: ThemeDefinition): boolean {
  try {
    const existing = getCustomThemes().find((theme) => theme.id === definition.id);
    if (!existing) installCustomTheme(definition);
    else if (
      JSON.stringify(customThemeJson(existing)) !== JSON.stringify(customThemeJson(definition))
    ) {
      updateCustomTheme(definition);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The theme id a slot should wear on this device, or null for the stock look. A palette the
 * device lacks is installed in the "From profile" collection first.
 */
function resolveSlot(slot: ProfileThemeSlot): string | null {
  // Stock and built-in slots carry the id only.
  if (!("colors" in slot)) {
    return slot.source === "builtin" && builtInIds.has(slot.id) ? slot.id : null;
  }
  const local = getThemeDefinition(slot.id);
  // A theme the user owns, or the live published one, is used as it is.
  if (local !== null && !isProfileCopy(local)) return slot.id;
  const copy = toThemeDefinition(
    {
      id: slot.id,
      name: slot.name,
      appearance: slot.appearance,
      colors: slot.colors,
    },
    PROFILE_THEME_COLLECTION,
  );
  return upsertTheme(copy) ? slot.id : null;
}

/**
 * Removes "From profile" copies the environment now publishes live (the copy would shadow it)
 * and copies no slot uses any more.
 */
export function pruneProfileThemeCopies(inUse: ReadonlySet<string> | null = null): void {
  const published = new Set(getEnvironmentThemes().map((theme) => theme.id));
  const stale = getCustomThemes()
    .filter(
      (theme) =>
        isProfileCopy(theme) &&
        (published.has(theme.id) || (inUse !== null && !inUse.has(theme.id))),
    )
    .map((theme) => theme.id);
  if (stale.length > 0) removeCustomThemes(stale);
}

function localSlotIds(): readonly [string | null, string | null] | null {
  try {
    const theme = readRawTheme();
    const halves = readThemeHalvesRaw();
    const idOf = (appearance: ThemeAppearance) => {
      // The same reading as slotFor, so a device that already wears what the profile says is
      // left alone: a dark-only theme in the light slot is the stock slot there too.
      const id = resolveThemeHalf(theme, halves, appearance);
      const definition = getThemeDefinition(id);
      if (definition === null) return STOCK_THEME_IDS.has(id) ? null : id;
      return getThemeColorsForMode(definition, appearance) === null ? null : definition.id;
    };
    return [idOf("light"), idOf("dark")];
  } catch {
    return null;
  }
}

/**
 * Applies the profile's appearance to this device: the library first (so slots can find their
 * themes), then the slots, the mode and the contrast. `previous` is the last section agreed with
 * the profile; a library theme in it that the profile dropped is removed here too.
 */
export function applyAppearanceSection(
  value: JsonObject,
  previous: JsonObject | null,
  host: AppearanceHost,
): void {
  const section = parseProfileAppearance(value);
  if (section === null) return;

  const remoteIds = new Set(section.customThemes.map((theme) => theme.id));
  const dropped = (parseProfileAppearance(previous)?.customThemes ?? [])
    .map((theme) => theme.id)
    .filter((id) => !remoteIds.has(id));
  const removable = new Set(
    getCustomThemes()
      .filter((theme) => !isProfileCopy(theme))
      .map((theme) => theme.id),
  );
  removeCustomThemes(dropped.filter((id) => removable.has(id)));
  for (const theme of section.customThemes) upsertTheme(toThemeDefinition(theme));

  const light = resolveSlot(section.themes.light);
  const dark = resolveSlot(section.themes.dark);
  const current = localSlotIds();
  if (current === null || current[0] !== light || current[1] !== dark) {
    // Choosing a whole theme clears the per-appearance mix, so the mix is set after it.
    host.setTheme(
      light === dark ? (light ?? "system") : dark !== null && light !== null ? dark : "system",
    );
    if (light !== dark) {
      if (light !== null) host.setThemeHalf("light", light);
      if (dark !== null) host.setThemeHalf("dark", dark);
    }
  }
  pruneProfileThemeCopies(new Set([light, dark].filter((id): id is string => id !== null)));

  try {
    if (readAppearanceModePreference(readRawTheme()) !== section.mode) {
      host.setAppearanceMode(section.mode);
    }
  } catch {
    host.setAppearanceMode(section.mode);
  }
  const contrast = Math.round(section.contrast);
  if (
    contrast >= MIN_APPEARANCE_CONTRAST &&
    contrast <= MAX_APPEARANCE_CONTRAST &&
    contrast !== host.contrast()
  ) {
    host.setContrast(contrast);
  }
}

/** The sync channel for this device's appearance. */
export function createAppearanceChannel(host: AppearanceHost): ProfileSyncChannel {
  return {
    name: APPEARANCE_SECTION,
    readLocal: (base) => readLocalAppearance(host, base),
    applyRemote: (value, previous) => applyAppearanceSection(value, previous, host),
    merge: mergeAppearance,
  };
}
