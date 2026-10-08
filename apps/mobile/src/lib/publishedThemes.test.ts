import type { EnvironmentId, EnvironmentTheme, ServerConfig } from "@t3tools/contracts";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import {
  collectPublishedMobileThemes,
  findPublishedThemeColors,
  isPublishedMobileThemeId,
  toPublishedMobileTheme,
} from "./publishedThemes";

const darkOcean = {
  id: "dark-ocean",
  name: "Dark Ocean",
  appearance: "dark",
  colors: { sidebar: "oklch(0.2154 0.0096 250)", notARole: "red" },
} as unknown as EnvironmentTheme;

describe("published mobile themes", () => {
  it("merges explicit colors over the stock palette for the published appearance only", () => {
    const theme = toPublishedMobileTheme(darkOcean);
    expect(theme?.id).toBe("published:dark-ocean");
    expect(theme?.colors.dark?.sidebar).toBe("oklch(0.2154 0.0096 250)");
    expect(theme?.colors.dark?.canvas).toBe(T3_CODE_DARK_THEME_COLORS.canvas);
    expect(theme?.colors.light).toBeUndefined();
    expect(theme?.colors.dark).not.toHaveProperty("notARole");
  });

  it("skips seed-only themes it cannot render", () => {
    const seedOnly = {
      id: "seeded",
      name: "Seeded",
      appearance: "dark",
      canvas: "#000000",
      accent: "#ffffff",
    } as unknown as EnvironmentTheme;
    expect(toPublishedMobileTheme(seedOnly)).toBeNull();
  });

  it("keeps the first publisher of an id across environments", () => {
    const config = (themes: ReadonlyArray<EnvironmentTheme>) =>
      ({ environmentThemes: themes }) as unknown as ServerConfig;
    const recolored = {
      ...darkOcean,
      colors: { sidebar: "oklch(0.3 0.01 250)" },
    } as unknown as EnvironmentTheme;
    const themes = collectPublishedMobileThemes(
      new Map([
        ["a" as EnvironmentId, config([darkOcean])],
        ["b" as EnvironmentId, config([recolored])],
      ]),
    );
    expect(themes).toHaveLength(1);
    expect(findPublishedThemeColors(themes, "published:dark-ocean", "dark")?.sidebar).toBe(
      "oklch(0.2154 0.0096 250)",
    );
    expect(findPublishedThemeColors(themes, "published:dark-ocean", "light")).toBeNull();
  });

  it("recognizes only prefixed ids with a name", () => {
    expect(isPublishedMobileThemeId("published:dark-ocean")).toBe(true);
    expect(isPublishedMobileThemeId("published:")).toBe(false);
    expect(isPublishedMobileThemeId("ocean")).toBe(false);
  });
});
