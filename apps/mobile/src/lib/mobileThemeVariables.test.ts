import { describe, expect, it } from "vite-plus/test";

import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";
import {
  flattenThemeColor,
  getMobileThemeVariables,
  MOBILE_THEME_IDS,
  themeColorContrastRatio,
  themeColorWithAlpha,
  type MobileThemeVariables,
} from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

// Upstream's runtime guards own these roles: the selected row is lifted off the fork's
// sidebar-colored screen, and Android lifts dark cards and their text off the frame.
const SELECTION_ROLES = [
  "--color-thread-selected",
  "--color-thread-selected-foreground",
  "--color-thread-selected-foreground-muted",
];
const ANDROID_DARK_CARD_ROLES = [
  "--color-grouped-card",
  "--color-foreground-secondary",
  "--color-foreground-muted",
  "--color-placeholder",
  "--color-primary-text",
];

// The comparisons skip these roles, so check what the guards promise for them instead.
function expectVisibleSelection(variables: MobileThemeVariables) {
  const drawer = flattenThemeColor(variables["--color-drawer"], variables["--color-screen"]);
  const selected = variables["--color-thread-selected"];
  expect(themeColorContrastRatio(selected, drawer)).toBeGreaterThanOrEqual(1.2 - 0.01);
  for (const role of [
    "--color-thread-selected-foreground",
    "--color-thread-selected-foreground-muted",
  ] as const) {
    expect(themeColorContrastRatio(variables[role], selected)).toBeGreaterThanOrEqual(4.5 - 0.01);
  }
}

function expectReadableAndroidDarkCards(variables: MobileThemeVariables) {
  const screen = variables["--color-screen"];
  const card = variables["--color-grouped-card"];
  for (const surface of [screen, flattenThemeColor(variables["--color-header"], screen)]) {
    expect(themeColorContrastRatio(card, surface)).toBeGreaterThanOrEqual(1.2 - 0.01);
  }
  for (const role of ANDROID_DARK_CARD_ROLES.slice(1) as ReadonlyArray<
    keyof MobileThemeVariables
  >) {
    expect(themeColorContrastRatio(variables[role], card)).toBeGreaterThanOrEqual(4.5 - 0.01);
  }
}

function omitRoles(variables: Readonly<Record<string, string>>, roles: ReadonlyArray<string>) {
  return Object.fromEntries(Object.entries(variables).filter(([role]) => !roles.includes(role)));
}

describe("mobile theme runtime variables", () => {
  it("matches the standard base palette to the generated stylesheet", () => {
    for (const appearance of ["light", "dark"] as const) {
      const runtime = getMobileThemeRuntimeVariables("t3-code", appearance, "web");
      expect(omitRoles(runtime, SELECTION_ROLES)).toEqual(
        omitRoles(readDefaultMobileThemeVariables(appearance), SELECTION_ROLES),
      );
      expectVisibleSelection(runtime);
    }
  });

  it("uses the same shared palette source as generated custom themes", () => {
    expect(getMobileThemeRuntimeVariables("ocean", "light", "ios")).toEqual(
      getMobileThemeVariables("ocean", "light"),
    );
    expect(getMobileThemeRuntimeVariables("iris", "dark", "ios")).toEqual(
      getMobileThemeVariables("iris", "dark"),
    );
  });

  it.each(MOBILE_THEME_IDS)(
    "uses a screen-colored %s sidebar beneath an opaque Android frame",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const base = getMobileThemeVariables(
          themeId === "material-you" ? "t3-code" : themeId,
          appearance,
        );
        const android = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        expectVisibleSelection(android);
        if (appearance === "dark") expectReadableAndroidDarkCards(android);
        const ignored =
          appearance === "dark"
            ? [...SELECTION_ROLES, ...ANDROID_DARK_CARD_ROLES]
            : SELECTION_ROLES;
        expect(omitRoles(android, ignored)).toEqual({
          ...omitRoles(base, ignored),
          "--color-header": themeColorWithAlpha(
            base[
              themeId === "t3-code" || themeId === "material-you"
                ? "--color-grouped-card"
                : "--color-drawer"
            ],
            1,
          ),
          "--color-header-foreground": base["--color-drawer-foreground"],
          "--color-drawer": base["--color-screen"],
        });
        expect(android["--color-header"]).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
      }
    },
  );

  it.each(["t3-code", "material-you"] as const)(
    "keeps the %s default Material frame distinct in both appearances",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        expect(variables["--color-header"]).toBe(
          appearance === "light" ? "rgba(233, 233, 233, 1)" : "rgba(20, 20, 20, 1)",
        );
        for (const pane of ["--color-screen", "--color-sheet-solid", "--color-drawer"] as const) {
          expect(variables["--color-header"]).not.toBe(themeColorWithAlpha(variables[pane], 1));
        }
      }
    },
  );

  it.each(["t3-code", "material-you"] as const)(
    "adapts %s iPad chrome without reversing the dark desktop hierarchy",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const ios = getMobileThemeRuntimeVariables(themeId, appearance, "ios");
        const android = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        if (appearance === "light") {
          expect(ios["--color-drawer"]).toBe(android["--color-header"]);
          expect(ios["--color-header"]).toBe(android["--color-header"]);
          expect(ios["--color-header-foreground"]).toBe(ios["--color-drawer-foreground"]);
        } else {
          expect(ios).toEqual(getMobileThemeVariables("t3-code", appearance));
          expect(ios["--color-drawer"]).toBe("#000000");
          // nckrtl shell: the chat canvas shares the sidebar pane color.
          expect(ios["--color-thread-canvas"]).toBe("#000000");
        }
        expect(themeColorWithAlpha(ios["--color-thread-hover"], 1)).not.toBe(
          themeColorWithAlpha(ios["--color-drawer"], 1),
        );
        expect(themeColorWithAlpha(ios["--color-thread-hover"], 1)).not.toBe(
          themeColorWithAlpha(ios["--color-thread-selected"], 1),
        );
        for (const role of [
          "--color-screen",
          "--color-thread-canvas",
          "--color-card",
          "--color-composer-surface",
          ...(appearance === "light" ? (["--color-grouped-card"] as const) : []),
        ] as const) {
          expect(ios[role]).toBe(android[role]);
        }
      }
    },
  );
});
