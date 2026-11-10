import { useEffect } from "react";

import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { createAppearanceChannel, pruneProfileThemeCopies } from "./appearanceProfileSync";
import { createDesktopDeviceChannel, readDesktopDeviceSection } from "./deviceSettingsSync";
import { notifyLocalProfileChange, setProfileSyncChannels } from "./profileSyncRegistry";

/**
 * Gives the profile sync this desktop's appearance and settings. It reads and writes them only
 * through the public theme and settings hooks, registers them as sync channels once the client
 * settings have loaded (before that they are schema defaults, which must never reach the
 * profile), and announces every local change so OrbitProfileSync can schedule a sync.
 */
export function OrbitAppearanceSync() {
  const settingsHydrated = useClientSettingsHydrated();
  const { theme, themeHalves, appearanceMode, setTheme, setThemeHalf, setAppearanceMode } =
    useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const contrast = useClientSettings((settings) => settings.appearanceContrast);
  const deviceValues = useClientSettings((settings) =>
    JSON.stringify(readDesktopDeviceSection(settings)),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the appearance and device channels with the profile sync engine while mounted
  useEffect(() => {
    if (!settingsHydrated) return;
    return setProfileSyncChannels([
      createAppearanceChannel({
        contrast: () => getClientSettings().appearanceContrast,
        setContrast: (appearanceContrast) => void updateClientSettings({ appearanceContrast }),
        setTheme,
        setThemeHalf,
        setAppearanceMode,
      }),
      createDesktopDeviceChannel({
        read: getClientSettings,
        update: (patch) => void updateClientSettings(patch),
      }),
    ]);
  }, [settingsHydrated, setTheme, setThemeHalf, setAppearanceMode]);

  // A copy of a theme from the profile gives way once the environment publishes it live.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops local profile theme copies once an environment publishes the live theme
  useEffect(() => {
    pruneProfileThemeCopies();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A newly published environment theme replaces its profile copy.
  }, [environmentThemes]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the profile sync engine that a synced setting changed
  useEffect(() => {
    if (settingsHydrated) notifyLocalProfileChange();
    /* oxlint-disable react/exhaustive-effect-dependencies -- Each listed setting is a trigger: a change to any of them is a local profile edit. */
  }, [
    settingsHydrated,
    theme,
    themeHalves?.light,
    themeHalves?.dark,
    appearanceMode,
    contrast,
    customThemes,
    environmentThemes,
    deviceValues,
  ]);
  /* oxlint-enable react/exhaustive-effect-dependencies */

  return null;
}
