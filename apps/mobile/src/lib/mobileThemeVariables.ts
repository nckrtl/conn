import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import {
  createMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
  flattenThemeColor,
  getMobileThemeVariables,
  shellHighlightColor,
  themeColorWithAlpha,
  themeColorWithContrast,
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

const CARD_TEXT_ROLES = [
  "--color-foreground-secondary",
  "--color-foreground-muted",
  "--color-placeholder",
  "--color-primary-text",
] as const;

// A selected row in a sidebar sits on the drawer, so it must stay visible there with its labels.
function withVisibleSelection(variables: MobileThemeVariables): MobileThemeVariables {
  const selected = themeColorWithContrast(
    flattenThemeColor(variables["--color-thread-selected"], variables["--color-drawer"]),
    flattenThemeColor(variables["--color-drawer"], variables["--color-screen"]),
    1.2,
  );
  return {
    ...variables,
    "--color-thread-selected": selected,
    "--color-thread-selected-foreground": themeColorWithContrast(
      variables["--color-thread-selected-foreground"],
      selected,
    ),
    "--color-thread-selected-foreground-muted": themeColorWithContrast(
      variables["--color-thread-selected-foreground-muted"],
      selected,
    ),
  };
}

export function getMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
  platform: string,
  publishedThemes: ReadonlyArray<PublishedMobileTheme> = [],
): MobileThemeVariables {
  return withVisibleSelection(
    platformThemeVariables(themeId, appearance, platform, publishedThemes),
  );
}

function platformThemeVariables(
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
    : usesDefaultPalette || isPublishedMobileThemeId(themeId)
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

  // Android paints the drawer as the page inside a lighter frame, so dark cards lift off both.
  const screen = variables["--color-screen"];
  const groupedCard =
    appearance === "dark"
      ? themeColorWithContrast(
          variables["--color-grouped-card"],
          [screen, flattenThemeColor(frame, screen)],
          1.2,
        )
      : variables["--color-grouped-card"];
  const readableOnCard = (role: (typeof CARD_TEXT_ROLES)[number]) =>
    [role, themeColorWithContrast(variables[role], groupedCard)] as const;
  return {
    ...variables,
    ...Object.fromEntries(CARD_TEXT_ROLES.map(readableOnCard)),
    "--color-header": frame,
    "--color-header-foreground": variables["--color-drawer-foreground"],
    "--color-drawer": screen,
    "--color-grouped-card": groupedCard,
  };
}
