import {
  mergeAppearance,
  parseProfileAppearance,
  type JsonObject,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import {
  mobileAppearancePatch,
  profileMobileThemes,
  serializeMobileAppearance,
  withProfileThemes,
} from "./orbitAppearance";

const darkOceanSlot = {
  id: "dark-ocean",
  name: "Dark Ocean",
  source: "published",
  appearance: "dark",
  colors: { canvas: "oklch(0.1676 0.0072 250)", sidebar: "oklch(0.2154 0.0096 250)" },
};

const profile = {
  schema: 1,
  mode: "dark",
  contrast: 120,
  themes: { light: { id: "t3-code", source: "stock" }, dark: darkOceanSlot },
  customThemes: [{ id: "mine", name: "Mine", appearance: "light", colors: { canvas: "#fff" } }],
} as unknown as JsonObject;

const themes = profileMobileThemes(parseProfileAppearance(profile));

describe("orbit appearance on mobile", () => {
  it("offers the profile's colored themes, its library first", () => {
    expect(themes.map((theme) => theme.id)).toEqual(["published:mine", "published:dark-ocean"]);
    expect(themes[1]?.colors.dark?.sidebar).toBe("oklch(0.2154 0.0096 250)");
  });

  it("lets a theme a machine publishes win over the profile copy", () => {
    const live = { ...themes[1]!, label: "Live" };
    const merged = withProfileThemes([live], themes);
    expect(merged.map((theme) => theme.label)).toEqual(["Live", "Mine"]);
  });

  it("applies the profile's mode and themes, then reads back what it applied", () => {
    const patch = mobileAppearancePatch(profile, { themeMode: "light" });
    expect(patch).toEqual({
      themeMode: "dark",
      lightThemeId: "t3-code",
      darkThemeId: "published:dark-ocean",
      themeId: "published:dark-ocean",
    });
    const local = serializeMobileAppearance(patch!, null, themes);
    expect(local).toMatchObject({ mode: "dark", themes: profile.themes });
    // Read back with the profile as base, nothing differs, so nothing is sent.
    expect(serializeMobileAppearance(patch!, profile, themes)).toEqual(profile);
    expect(mobileAppearancePatch(profile, patch!)).toBeNull();
  });

  it("sends a theme change without touching contrast or the desktop library", () => {
    const local = serializeMobileAppearance(
      { themeMode: "dark", lightThemeId: "t3-code", darkThemeId: "ocean" },
      profile,
      themes,
    )!;
    expect(local.themes).toEqual({
      light: { id: "t3-code", source: "stock" },
      dark: { id: "ocean", source: "builtin" },
    });
    const remote = { ...profile, contrast: 90 } as JsonObject;
    const merged = mergeAppearance(profile, local, remote);
    expect(merged.contrast).toBe(90);
    expect(merged.customThemes).toEqual(profile.customThemes);
  });

  it("waits while a published theme has no palette on this phone", () => {
    expect(
      serializeMobileAppearance({ darkThemeId: "published:elsewhere" }, profile, themes),
    ).toBeNull();
  });

  it("keeps the profile's slot while the phone wears Material You", () => {
    const local = serializeMobileAppearance(
      { themeMode: "dark", lightThemeId: "t3-code", darkThemeId: "material-you" },
      profile,
      themes,
    );
    expect(local).toEqual(profile);
  });
});
