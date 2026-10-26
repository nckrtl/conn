// @vitest-environment jsdom

import {
  createProfileSync,
  type JsonObject,
  type OrbitGatewayNode,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useTheme } from "../hooks/useTheme";
import useDefaultThemeSource from "../hooks/useDefaultTheme.ts?raw";
import {
  desktopLocalThemesAtom,
  invalidateCustomThemes,
  type ThemeDefinition,
} from "../themePalette";
import { createAppearanceChannel, type AppearanceHost } from "./appearanceProfileSync";
import { asDefaultThemeAdoption, trackNonUserThemeChanges } from "./themeOrigin";
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
  contrast: () => 100,
  setContrast: () => {},
  setTheme: (id) => themeNow().setTheme(id),
  setThemeHalf: (appearance, id) => themeNow().setThemeHalf(appearance, id),
  setAppearanceMode: (mode) => themeNow().setAppearanceMode(mode),
};

/** A one-section Gateway: just enough to see whether the appearance reaches the profile. */
function gateway() {
  const profile = { version: 1, section: null as { version: number; value: JsonObject } | null };
  const settings = (): OrbitGatewaySettings => ({
    profileId: 1,
    version: profile.version,
    workspaces: [],
    updatedAt: "",
    document: { workspaces: [], ...(profile.section ? { appearance: profile.section.value } : {}) },
    sections: profile.section
      ? { appearance: { version: profile.section.version, updatedAt: null, updatedBy: null } }
      : {},
  });
  const patches: Record<string, OrbitGatewaySectionPatch>[] = [];
  const client = {
    settings: async () => settings(),
    patchSections: async (_id: number, patch: Record<string, OrbitGatewaySectionPatch>) => {
      patches.push(patch);
      const next = patch.appearance;
      if (next?.value) {
        profile.section = {
          version: (profile.section?.version ?? 0) + 1,
          value: next.value as JsonObject,
        };
        profile.version += 1;
      }
      return settings();
    },
  };
  const me = (): OrbitGatewayNode => ({
    id: 8,
    name: "mac",
    wireguardIp: "10.44.0.6",
    profile: { id: 1, name: "Nick", settingsVersion: profile.version, updatedAt: "" },
  });
  return { profile, patches, client, me };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  invalidateCustomThemes();
  setEnvironmentThemes([]);
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
  vi.unstubAllGlobals();
});

function syncing(fake: ReturnType<typeof gateway>) {
  let saved: ProfileSyncState | null = null;
  const channel = createAppearanceChannel(host);
  const engine = createProfileSync({
    client: fake.client,
    channels: () => [channel],
    loadState: () => saved,
    saveState: (state) => {
      saved = state;
    },
  });
  // The wiring OrbitProfileSync does.
  const stop = trackNonUserThemeChanges(() => engine.beginNonUserChange("appearance"));
  return { engine, stop };
}

describe("a theme the environment pushed (t3 theme set)", () => {
  it("stays on this device, while the user's own pick spreads", async () => {
    const fake = gateway();
    const { engine, stop } = syncing(fake);
    await engine.run(fake.me());
    expect(fake.profile.section?.value.mode).toBe("system");

    await act(async () => {
      asDefaultThemeAdoption(() => themeNow().setTheme("ocean"));
    });
    await engine.run(fake.me());
    expect(fake.patches).toHaveLength(1);
    expect(fake.profile.section?.value.themes).toMatchObject({ dark: { id: "t3-code" } });

    // The user picks a theme afterwards: that one is theirs and goes out.
    await act(async () => {
      themeNow().setTheme("grove");
    });
    await engine.run(fake.me());
    expect(fake.profile.section?.value.themes).toMatchObject({ dark: { id: "grove" } });
    stop();
  });

  it("does not seed an empty profile", async () => {
    const fake = gateway();
    const { engine, stop } = syncing(fake);
    await act(async () => {
      asDefaultThemeAdoption(() => themeNow().setTheme("ocean"));
    });
    await engine.run(fake.me());
    expect(fake.profile.section).toBeNull();
    stop();
  });

  it("tells the sync before and after the change, even when the change throws", () => {
    const calls: string[] = [];
    const stop = trackNonUserThemeChanges(() => {
      calls.push("before");
      return () => calls.push("after");
    });
    expect(() =>
      asDefaultThemeAdoption(() => {
        calls.push("change");
        throw new Error("storage failed");
      }),
    ).toThrow("storage failed");
    expect(calls).toEqual(["before", "change", "after"]);
    stop();
  });

  it("is how startDefaultThemeAdoption applies it (guards the upstream merge)", () => {
    expect(useDefaultThemeSource).toContain("asDefaultThemeAdoption(() => setTheme(defaultTheme))");
    expect(useDefaultThemeSource).toContain(
      "asDefaultThemeAdoption(() => setAppearanceMode(half))",
    );
  });
});
