import {
  parseProfileAppearance,
  PROFILE_SCHEMA_VERSION,
  type JsonObject,
  type ProfileAppearance,
  type ProfileSyncState,
  type ProfileThemeSlot,
} from "@t3tools/client-runtime/orbit-gateway";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import type { Preferences } from "../persistence/mobile-preferences";
import {
  DEFAULT_MOBILE_THEME_ID,
  isMobileThemeId,
  normalizeMobileThemeMode,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "./mobileTheme";
import {
  isPublishedMobileThemeId,
  publishedMobileThemeId,
  toPublishedMobileTheme,
  type ColoredTheme,
  type PublishedMobileTheme,
} from "./publishedThemes";

/**
 * How the phone reads and applies the `appearance` section of its Orbit profile: the light/dark
 * mode and one theme per appearance. The phone has no contrast setting and no theme library of
 * its own, so it hands those back as the profile has them. A theme the profile carries with its
 * palette (a desktop custom or published theme) is offered as a `published:` theme, so the phone
 * can wear it without a connected machine publishing it.
 */

const STOCK_SLOT: ProfileThemeSlot = { id: DEFAULT_MOBILE_THEME_ID, source: "stock" };
const DEFAULT_CONTRAST = 100;

const builtInIds: ReadonlySet<string> = new Set(BUILT_IN_THEMES.map((theme) => theme.id));

/** The profile's appearance as this device last synced it, or null before the first sync. */
export function syncedProfileAppearance(
  state: ProfileSyncState | null | undefined,
): ProfileAppearance | null {
  return parseProfileAppearance(state?.sections.appearance?.remote ?? null);
}

/** Themes the profile carries with their palette: its library first, then the theme in each slot. */
export function profileMobileThemes(
  section: ProfileAppearance | null,
): ReadonlyArray<PublishedMobileTheme> {
  if (section === null) return [];
  const themes = new Map<string, PublishedMobileTheme>();
  const add = (theme: ColoredTheme) => {
    const published = toPublishedMobileTheme(theme);
    if (published && !themes.has(published.id)) themes.set(published.id, published);
  };
  for (const theme of section.customThemes) add(theme);
  for (const slot of [section.themes.dark, section.themes.light]) {
    if ("colors" in slot) add(slot);
  }
  return [...themes.values()];
}

/** Published themes plus the profile's; a theme a machine publishes live wins over the profile copy. */
export function withProfileThemes(
  published: ReadonlyArray<PublishedMobileTheme>,
  profile: ReadonlyArray<PublishedMobileTheme>,
): ReadonlyArray<PublishedMobileTheme> {
  if (profile.length === 0) return published;
  const ids = new Set(published.map((theme) => theme.id));
  return [...published, ...profile.filter((theme) => !ids.has(theme.id))];
}

/**
 * The slot for one appearance, or null while the theme it names has no palette on this device
 * yet (its machine has not connected). `last` is the slot the profile last agreed on.
 */
function slotFor(
  appearance: MobileThemeAppearance,
  themeId: MobileThemeId,
  last: ProfileThemeSlot | null,
  themes: ReadonlyArray<PublishedMobileTheme>,
): ProfileThemeSlot | null {
  if (themeId === DEFAULT_MOBILE_THEME_ID) return STOCK_SLOT;
  // Material You exists only on Android: the slot keeps what the profile says.
  if (themeId === "material-you") return last ?? STOCK_SLOT;
  if (!isPublishedMobileThemeId(themeId)) {
    return builtInIds.has(themeId) ? { id: themeId, source: "builtin" } : STOCK_SLOT;
  }
  const id = themeId.slice("published:".length);
  if (last !== null && "colors" in last && last.id === id) return last;
  const theme = themes.find((entry) => entry.id === themeId);
  if (theme === undefined) return null;
  // A theme without a palette for this appearance (a dark-only theme in the light slot) reads
  // as the stock look, as the desktop sends it.
  const colors = theme.colors[appearance];
  if (colors === undefined) return STOCK_SLOT;
  return { id, name: theme.label, source: "published", appearance, colors: { ...colors } };
}

/** The appearance section for this phone's preferences, or null while a theme is unresolved. */
export function serializeMobileAppearance(
  preferences: Preferences,
  base: JsonObject | null,
  themes: ReadonlyArray<PublishedMobileTheme>,
): JsonObject | null {
  const last = parseProfileAppearance(base);
  const ids = resolveMobileThemeIds(preferences);
  const light = slotFor("light", ids.light, last?.themes.light ?? null, themes);
  const dark = slotFor("dark", ids.dark, last?.themes.dark ?? null, themes);
  if (light === null || dark === null) return null;
  const section = {
    schema: PROFILE_SCHEMA_VERSION,
    mode: normalizeMobileThemeMode(preferences.themeMode),
    contrast: last?.contrast ?? DEFAULT_CONTRAST,
    themes: { light, dark },
    customThemes: Array.isArray(base?.customThemes) ? base.customThemes : [],
  };
  return section as unknown as JsonObject;
}

function mobileThemeIdFor(slot: ProfileThemeSlot): MobileThemeId {
  if ("colors" in slot) return publishedMobileThemeId(slot.id);
  return slot.source === "builtin" && builtInIds.has(slot.id) && isMobileThemeId(slot.id)
    ? slot.id
    : DEFAULT_MOBILE_THEME_ID;
}

/** The preference patch that makes this phone wear the profile's appearance, or null when it does. */
export function mobileAppearancePatch(
  value: JsonObject,
  preferences: Preferences,
): Partial<Preferences> | null {
  const section = parseProfileAppearance(value);
  if (section === null) return null;
  const ids = {
    light: mobileThemeIdFor(section.themes.light),
    dark: mobileThemeIdFor(section.themes.dark),
  };
  const current = resolveMobileThemeIds(preferences);
  if (
    current.light === ids.light &&
    current.dark === ids.dark &&
    normalizeMobileThemeMode(preferences.themeMode) === section.mode
  ) {
    return null;
  }
  return {
    themeMode: section.mode,
    lightThemeId: ids.light,
    darkThemeId: ids.dark,
    // Older OTA bundles read this one theme.
    themeId: section.mode === "light" ? ids.light : ids.dark,
  };
}
