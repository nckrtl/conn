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

/**
 * Complete palette for native and third-party APIs that cannot consume a
 * Uniwind className. Every palette shares the source that generates its
 * registered CSS theme.
 */
export function getMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  platform: string,
  publishedThemes: ReadonlyArray<PublishedMobileTheme> = [],
): MobileThemeVariables {
  const publishedColors = isPublishedMobileThemeId(themeId)
    ? findPublishedThemeColors(publishedThemes, themeId, appearance)
    : null;
  // A published theme that is offline or lacks this appearance falls back to
  // the default palette until its machine publishes it again.
  const usesDefaultPalette =
    themeId === DEFAULT_MOBILE_THEME_ID ||
    themeId === "material-you" ||
    (isPublishedMobileThemeId(themeId) && publishedColors === null);
  const variables = publishedColors
    ? (createMobileThemeVariables(
        publishedColors,
        appearance,
        shellHighlightColor(publishedColors, appearance),
      ) as MobileThemeVariables)
    : usesDefaultPalette
      ? defaults[appearance]
      : getMobileThemeVariables(
          themeId as Parameters<typeof getMobileThemeVariables>[0],
          appearance,
        );
  // Android's frame surrounds the sidebar and chat panes. Light iPad sidebars
  // reuse that stronger tonal fill; dark sidebars retain the shared black pane
  // beneath the near-black chat canvas. System colors replace these roles later.
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
