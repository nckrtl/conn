// @vitest-environment jsdom

import { type JsonObject } from "@t3tools/client-runtime/orbit-gateway";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useTheme } from "../hooks/useTheme";
import {
  getCustomThemes,
  getDefaultThemeColors,
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  desktopLocalThemesAtom,
  toCanonicalThemeColor,
  type ThemeDefinition,
} from "../themePalette";
import {
  applyAppearanceSection,
  PROFILE_THEME_COLLECTION,
  pruneProfileThemeCopies,
  readLocalAppearance,
  serializeAppearance,
  type AppearanceHost,
} from "./appearanceProfileSync";
import type { EnvironmentTheme } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";

// The published palettes come from the server atom; tests stand in for it
// with the desktop's local themes, which take precedence.
const setEnvironmentThemes = (themes: ReadonlyArray<ThemeDefinition>) =>
  appAtomRegistry.set(
    desktopLocalThemesAtom,
    themes.length === 0
      ? null
      : themes.map((theme) => ({
          id: theme.id as EnvironmentTheme["id"],
          name: theme.label,
          appearance: theme.appearance,
          colors: theme.colors,
        })),
  );

// The latest `useTheme()` result, set after each render.
const handle: { current: ReturnType<typeof useTheme> | null } = { current: null };
const themeNow = () => handle.current!;
let contrast = 100;
let root: Root;
let container: HTMLDivElement;

function Harness() {
  const value = useTheme();
  useEffect(() => {
    handle.current = value;
  });
  return null;
}

const host: AppearanceHost = {
  contrast: () => contrast,
  setContrast: (value) => {
    contrast = value;
  },
  setTheme: (id) => themeNow().setTheme(id),
  setThemeHalf: (appearance, id) => themeNow().setThemeHalf(appearance, id),
  setAppearanceMode: (mode) => themeNow().setAppearanceMode(mode),
};

// Themes store colors in one canonical form, so the fixtures start there.
const canonical = (color: string) => toCanonicalThemeColor(color)!;
const darkColors = {
  ...getDefaultThemeColors("dark"),
  canvas: canonical("#0b1d2a"),
  accent: canonical("#2dd4bf"),
};
const customTheme = (id: string, label = id): ThemeDefinition => ({
  id,
  label,
  appearance: "dark",
  colors: darkColors,
});
const slotColors = (id: string): JsonObject => ({
  id,
  name: id,
  source: "published",
  appearance: "dark",
  colors: { ...darkColors },
});
const remoteAppearance = (overrides: Record<string, unknown> = {}): JsonObject =>
  ({
    schema: 1,
    mode: "dark",
    contrast: 110,
    themes: {
      light: { id: "t3-code", source: "stock" },
      dark: slotColors("dark-ocean"),
    },
    customThemes: [],
    ...overrides,
  }) as JsonObject;

const apply = (value: JsonObject, previous: JsonObject | null = null) =>
  act(async () => {
    applyAppearanceSection(value, previous, host);
  });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  invalidateCustomThemes();
  setEnvironmentThemes([]);
  contrast = 100;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Harness));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setEnvironmentThemes([]);
  vi.unstubAllGlobals();
});

describe("serializing the appearance", () => {
  it("describes the stock look on a fresh device", () => {
    expect(readLocalAppearance(host)).toEqual({
      schema: 1,
      mode: "system",
      contrast: 100,
      themes: {
        light: { id: "t3-code", source: "stock" },
        dark: { id: "t3-code", source: "stock" },
      },
      customThemes: [],
    });
  });

  it("names a built-in theme by id and carries the palette of a custom one", async () => {
    installCustomTheme(customTheme("mine"));
    await act(async () => {
      themeNow().setTheme("ocean");
      themeNow().setThemeHalf("dark", "mine");
    });
    const local = readLocalAppearance(host)!;
    expect(local.themes).toMatchObject({
      light: { id: "ocean", source: "builtin" },
      dark: { id: "mine", name: "mine", source: "custom", appearance: "dark" },
    });
    expect(((local.themes as JsonObject).dark as JsonObject).colors).toMatchObject({
      canvas: darkColors.canvas,
    });
    expect((local.customThemes as JsonObject[]).map((entry) => entry.id)).toEqual(["mine"]);
  });

  it("marks a theme the library lacks as published", async () => {
    setEnvironmentThemes([customTheme("dark-ocean", "Dark Ocean")]);
    await act(async () => {
      themeNow().setTheme("dark-ocean");
    });
    expect((readLocalAppearance(host)!.themes as JsonObject).dark).toMatchObject({
      id: "dark-ocean",
      name: "Dark Ocean",
      source: "published",
    });
  });

  it("keeps a dark-only theme out of the light slot", async () => {
    setEnvironmentThemes([customTheme("dark-ocean", "Dark Ocean")]);
    await act(async () => {
      themeNow().setTheme("dark-ocean");
      themeNow().setAppearanceMode("dark");
    });
    const local = readLocalAppearance(host)!;
    expect(local.themes).toMatchObject({
      light: { id: "t3-code", source: "stock" },
      dark: { id: "dark-ocean", source: "published", appearance: "dark" },
    });

    // The device already wears that: applying it back changes nothing, so the user's pick
    // is not rewritten into a different arrangement.
    const before = { ...window.localStorage };
    await apply(local, local);
    expect({ ...window.localStorage }).toEqual(before);
    expect(themeNow().theme).toBe("dark-ocean");
    expect(themeNow().themeHalves).toBeNull();
  });

  it("keeps a dark-only mix half out of the light slot too", async () => {
    installCustomTheme(customTheme("night"));
    await act(async () => {
      themeNow().setTheme("ocean");
      themeNow().setThemeHalf("dark", "night");
    });
    const themes = readLocalAppearance(host)!.themes as JsonObject;
    expect(themes.light).toMatchObject({ id: "ocean", source: "builtin" });
    expect(themes.dark).toMatchObject({ id: "night", source: "custom", appearance: "dark" });
  });

  it("leaves empty maps out, because the Gateway rejects them", async () => {
    const withoutColors = { ...customTheme("no-colors"), colors: {} } as unknown as ThemeDefinition;
    const withEmptyVariant = {
      ...customTheme("light-less"),
      variants: { light: {} },
    } as unknown as ThemeDefinition;
    const local = serializeAppearance({
      theme: "system",
      halves: {},
      mode: "system",
      contrast: 100,
      library: [withoutColors, withEmptyVariant, customTheme("fine")],
    })!;
    const library = local.customThemes as JsonObject[];
    expect(library.map((entry) => entry.id)).toEqual(["fine", "light-less"]);
    expect(library[1]).not.toHaveProperty("variants");
    const hasEmptyMap = (value: unknown): boolean =>
      typeof value === "object" &&
      value !== null &&
      (Array.isArray(value)
        ? value.some(hasEmptyMap)
        : Object.keys(value).length === 0 || Object.values(value).some(hasEmptyMap));
    expect(hasEmptyMap(local)).toBe(false);
  });

  it("waits for a published theme that has not arrived instead of reporting the stock look", () => {
    window.localStorage.setItem("t3code:theme", "dark-ocean");
    expect(readLocalAppearance(host)).toBeNull();

    // The profile's last agreed value stands in for it, so a restart does not rewrite the slot.
    const base = remoteAppearance({
      themes: { light: slotColors("dark-ocean"), dark: slotColors("dark-ocean") },
    });
    expect(readLocalAppearance(host, base)?.themes).toEqual(base.themes);
  });
});

describe("applying the appearance", () => {
  it("sets slots, mode and contrast, and reads back what it applied", async () => {
    const remote = remoteAppearance();
    await apply(remote);
    expect(themeNow().appearanceMode).toBe("dark");
    expect(contrast).toBe(110);
    expect(themeNow().themeHalves).toEqual({ dark: "dark-ocean" });
    expect(readLocalAppearance(host)).toEqual(remote);
  });

  it("installs a palette the device lacks in the read-only From profile collection", async () => {
    await apply(remoteAppearance());
    const copy = getThemeDefinition("dark-ocean");
    expect(copy?.collection).toEqual(PROFILE_THEME_COLLECTION);
    expect(copy?.colors.canvas).toBe(darkColors.canvas);
    // The copy renders but is never part of the library the device syncs back.
    expect(readLocalAppearance(host)!.customThemes).toEqual([]);
  });

  it("gives way to the live published theme as soon as the environment publishes it", async () => {
    await apply(remoteAppearance());
    const live = {
      ...customTheme("dark-ocean", "Dark Ocean (live)"),
      colors: { ...darkColors, canvas: canonical("#000814") },
    };
    setEnvironmentThemes([live]);
    act(() => pruneProfileThemeCopies());
    expect(getCustomThemes().some((entry) => entry.id === "dark-ocean")).toBe(false);
    expect(getThemeDefinition("dark-ocean")?.label).toBe("Dark Ocean (live)");
  });

  it("drops copies no slot uses any more", async () => {
    await apply(remoteAppearance());
    await apply(
      remoteAppearance({
        themes: {
          light: { id: "t3-code", source: "stock" },
          dark: { id: "ocean", source: "builtin" },
        },
      }),
    );
    expect(getCustomThemes().some((entry) => entry.id === "dark-ocean")).toBe(false);
  });

  it("is quiet when the profile's value is already what the device wears", async () => {
    const remote = remoteAppearance();
    await apply(remote);
    const before = { ...window.localStorage };
    await apply(remote, remote);
    expect({ ...window.localStorage }).toEqual(before);
  });

  it("uses one whole theme when both slots agree, and a mix when they differ", async () => {
    await apply(
      remoteAppearance({
        themes: {
          light: { id: "ocean", source: "builtin" },
          dark: { id: "ocean", source: "builtin" },
        },
      }),
    );
    expect(themeNow().theme).toBe("ocean");
    expect(themeNow().themeHalves).toBeNull();

    await apply(
      remoteAppearance({
        themes: {
          light: { id: "grove", source: "builtin" },
          dark: { id: "ocean", source: "builtin" },
        },
      }),
    );
    expect(themeNow().themeHalves).toEqual({ light: "grove", dark: "ocean" });
  });

  it("falls back to the stock look for a built-in theme this build lacks", async () => {
    await apply(
      remoteAppearance({
        themes: {
          light: { id: "t3-code", source: "stock" },
          dark: { id: "from-the-phone", source: "builtin" },
        },
      }),
    );
    expect(themeNow().themeHalves).toBeNull();
    expect(themeNow().theme).toBe("system");
  });

  it("installs and updates the custom library, and removes what the profile dropped", async () => {
    installCustomTheme(customTheme("old"));
    installCustomTheme(customTheme("local-only"));
    const first = remoteAppearance({
      themes: {
        light: { id: "t3-code", source: "stock" },
        dark: { id: "t3-code", source: "stock" },
      },
      customThemes: [
        { id: "old", name: "old", appearance: "dark", colors: { ...darkColors } },
        {
          id: "fresh",
          name: "Fresh",
          appearance: "dark",
          colors: { ...darkColors, accent: canonical("#ff0066") },
        },
      ],
    });
    await apply(first, null);
    expect(
      getCustomThemes()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["fresh", "local-only", "old"]);

    // Another device deleted "old" and renamed "fresh".
    const second = remoteAppearance({
      themes: first.themes,
      customThemes: [
        {
          id: "fresh",
          name: "Fresher",
          appearance: "dark",
          colors: { ...darkColors, accent: canonical("#ff0066") },
        },
      ],
    });
    await apply(second, first);
    expect(
      getCustomThemes()
        .map((entry) => `${entry.id}:${entry.label}`)
        .sort(),
    ).toEqual(["fresh:Fresher", "local-only:local-only"]);
  });

  it("ignores a contrast outside the range this build accepts", async () => {
    await apply(remoteAppearance({ contrast: 900 }));
    expect(contrast).toBe(100);
  });
});
