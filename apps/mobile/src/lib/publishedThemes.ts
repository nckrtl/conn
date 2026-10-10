import type { EnvironmentId, EnvironmentTheme, ServerConfig } from "@t3tools/contracts";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";

import { isPublishedMobileThemeId, type PublishedMobileThemeId } from "./mobileTheme";

export { isPublishedMobileThemeId, type PublishedMobileThemeId };

export function publishedMobileThemeId(themeId: string): PublishedMobileThemeId {
  return `published:${themeId}`;
}

export interface PublishedMobileTheme {
  readonly id: PublishedMobileThemeId;
  readonly label: string;
  readonly colors: Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
}

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

function stockColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
}

function overrideColors(
  appearance: ThemeAppearance,
  colors: Readonly<Record<string, string>> | undefined,
): ThemeColors | null {
  const overrides = Object.entries(colors ?? {}).filter(
    ([role, value]) => THEME_COLOR_ROLE_SET.has(role) && typeof value === "string",
  );
  // Seed-only themes (canvas + accent) need the desktop's palette generator.
  // Mobile lists only themes that carry explicit colors.
  if (overrides.length === 0) return null;
  return { ...stockColors(appearance), ...Object.fromEntries(overrides) } as ThemeColors;
}

export function toPublishedMobileTheme(theme: EnvironmentTheme): PublishedMobileTheme | null {
  const colors: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  const primary = overrideColors(theme.appearance, theme.colors);
  if (primary) colors[theme.appearance] = primary;
  for (const [appearance, variantColors] of Object.entries(theme.variants ?? {})) {
    if (appearance !== "light" && appearance !== "dark") continue;
    if (appearance === theme.appearance) continue;
    const variant = overrideColors(appearance, variantColors);
    if (variant) colors[appearance] = variant;
  }
  if (Object.keys(colors).length === 0) return null;
  return { id: publishedMobileThemeId(theme.id), label: theme.name, colors };
}

/** Published themes across every connected environment, first publisher wins per id. */
export function collectPublishedMobileThemes(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyArray<PublishedMobileTheme> {
  const themes = new Map<PublishedMobileThemeId, PublishedMobileTheme>();
  for (const config of configs.values()) {
    for (const theme of config.environmentThemes ?? []) {
      const published = toPublishedMobileTheme(theme);
      if (published && !themes.has(published.id)) themes.set(published.id, published);
    }
  }
  return [...themes.values()];
}

export function findPublishedThemeColors(
  themes: ReadonlyArray<PublishedMobileTheme>,
  themeId: string,
  appearance: ThemeAppearance,
): ThemeColors | null {
  return themes.find((theme) => theme.id === themeId)?.colors[appearance] ?? null;
}
