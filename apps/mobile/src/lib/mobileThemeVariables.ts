import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import {
  createMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  shellHighlightColor,
  themeColorWithAlpha,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";
import {
  findPublishedThemeColors,
  isPublishedMobileThemeId,
  type PublishedMobileTheme,
} from "./publishedThemes";

const defaults = defaultThemeVariables as Readonly<
  Record<MobileThemeAppearance, MobileThemeVariables>
>;

export function getMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  platform: string,
  publishedThemes: ReadonlyArray<PublishedMobileTheme> = [],
): MobileThemeVariables {
  const usesDefaultPalette = themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you";
  const variables = usesDefaultPalette
    ? defaults[appearance]
    : getMobileThemeVariables(themeId, appearance);
  const frame = themeColorWithAlpha(
    // nckrtl shell: the screen is the sidebar color, so the frame steps up to
    // the shell highlight to stay distinct from it.
    variables[usesDefaultPalette ? "--color-grouped-card" : "--color-drawer"],
    1,
  );
  if (platform === "ios" && usesDefaultPalette && appearance === "light") {
    return {
      ...variables,
      "--color-header": frame,
      "--color-header-foreground": variables["--color-drawer-foreground"],
      "--color-drawer": frame,
      "--color-drawer-foreground-muted": variables["--color-foreground-muted"],
    };
  }
  if (platform !== "android") return variables;

  return {
    ...variables,
    "--color-header": frame,
    "--color-header-foreground": variables["--color-drawer-foreground"],
    "--color-drawer": variables["--color-screen"],
  };
}
