import {
  createProfileSync,
  mergeDeviceSection,
  toGatewayForm,
  type JsonObject,
  type OrbitGatewayNode,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopDeviceChannel,
  DESKTOP_SYNCED_SETTING_KEYS,
  desktopSettingsPatch,
  readDesktopDeviceSection,
} from "./deviceSettingsSync";

const section = (values: Record<string, unknown>, schema = 1): JsonObject =>
  ({ schema, values }) as JsonObject;

describe("desktop device settings", () => {
  it("syncs how the app looks and reads, and leaves machine-bound settings out", () => {
    const keys: readonly string[] = DESKTOP_SYNCED_SETTING_KEYS;
    expect(keys).toEqual(
      expect.arrayContaining([
        "fontFamilySans",
        "fontSizeInterface",
        "chatWidth",
        "glassOpacity",
        "panelAnimationDurationMs",
        "diffLayout",
        "wordWrap",
        "timestampFormat",
        "environmentIdentificationMode",
        "fontSmoothing",
        "lineHeightInterface",
        "lineHeightPrompt",
        "lineHeightCode",
        "lineHeightTerminal",
      ]),
    );
    for (const machineBound of [
      "browserProfiles",
      "browserDefaultProfileId",
      "annotationDictationUrl",
      "annotationServerUrl",
      "deviceAnnotationsUrl",
      "snapShotShortcut",
      "confirmQuit",
      "notificationMode",
      "onboardingCompletedAt",
      "favorites",
      "appearanceContrast",
    ]) {
      expect(keys).not.toContain(machineBound);
    }
  });

  it("reads only the allowlisted keys", () => {
    const read = readDesktopDeviceSection({
      ...DEFAULT_CLIENT_SETTINGS,
      chatWidth: "wide",
      fontFamilySans: "Inter",
    });
    expect(Object.keys(read.values as JsonObject).toSorted()).toEqual(
      [...DESKTOP_SYNCED_SETTING_KEYS].toSorted(),
    );
    expect(read).toMatchObject({
      schema: 1,
      values: { chatWidth: "wide", fontFamilySans: "Inter" },
    });
  });

  it("applies valid values and skips unknown keys, machine-bound keys and out-of-range values", () => {
    expect(
      desktopSettingsPatch(
        section({
          chatWidth: "full",
          fontSizeInterface: 15,
          lineHeightCode: 1.8,
          lineHeightTerminal: 7,
          glassOpacity: 9_000,
          diffLayout: "sideways",
          futureSetting: true,
          browserDefaultProfileId: "evil",
          confirmQuit: "never",
        }),
      ),
    ).toEqual({ chatWidth: "full", fontSizeInterface: 15, lineHeightCode: 1.8 });
  });

  it("writes only the settings that differ", () => {
    const update = vi.fn();
    const current: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS, chatWidth: "wide" };
    const channel = createDesktopDeviceChannel({ read: () => current, update });
    channel.applyRemote(section({ chatWidth: "wide", wordWrap: !current.wordWrap }), null);
    expect(update).toHaveBeenCalledExactlyOnceWith({ wordWrap: !current.wordWrap });

    update.mockClear();
    channel.applyRemote(section({ chatWidth: "wide" }), null);
    expect(update).not.toHaveBeenCalled();
  });

  it("merges per key and keeps keys from a newer build", () => {
    const base = section({ chatWidth: "wide", wordWrap: true });
    const local = section({ chatWidth: "full", wordWrap: true });
    const remote = section({ chatWidth: "wide", wordWrap: false, iphoneOnly: 3 });
    expect(mergeDeviceSection(base, local, remote)).toEqual(
      section({ chatWidth: "full", wordWrap: false, iphoneOnly: 3 }),
    );
  });
});

describe("text settings and the Gateway's string handling", () => {
  it("reads null as an unset text setting, so a reset on another desktop arrives", () => {
    expect(desktopSettingsPatch(section({ fontFamilySans: null, chatWidth: null }))).toEqual({
      fontFamilySans: "",
    });
  });

  it("settles after one push when the Gateway trims text and stores an empty string as null", async () => {
    let settings: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      fontFamilySans: "  Inter ",
      fontFamilyCode: "",
    };
    const channel = createDesktopDeviceChannel({
      read: () => settings,
      update: (patch) => {
        settings = { ...settings, ...patch };
      },
    });
    const stored: { version: number; value: JsonObject | null } = { version: 0, value: null };
    const patches: Record<string, OrbitGatewaySectionPatch>[] = [];
    const gatewaySettings = (): OrbitGatewaySettings => ({
      profileId: 1,
      version: stored.version,
      workspaces: [],
      updatedAt: "",
      document: stored.value
        ? { workspaces: [], devices: { desktop: stored.value } }
        : { workspaces: [] },
      sections: stored.value
        ? { "devices.desktop": { version: stored.version, updatedAt: null, updatedBy: null } }
        : {},
    });
    let state: ProfileSyncState | null = null;
    const engine = createProfileSync({
      client: {
        settings: async () => gatewaySettings(),
        patchSections: async (_id, patch) => {
          patches.push(patch);
          stored.version += 1;
          // What the Gateway keeps: the form a client is expected to send.
          stored.value = toGatewayForm(patch["devices.desktop"]!.value as JsonObject);
          return gatewaySettings();
        },
      },
      channels: () => [channel],
      loadState: () => state,
      saveState: (next) => {
        state = next;
      },
    });
    const me = (): OrbitGatewayNode => ({
      id: 1,
      name: "mac",
      wireguardIp: "10.44.0.6",
      profile: { id: 1, name: "Nick", settingsVersion: stored.version, updatedAt: "" },
    });

    await engine.run(me());
    expect((patches[0]!["devices.desktop"]!.value as JsonObject).values).toMatchObject({
      fontFamilySans: "Inter",
      fontFamilyCode: null,
    });
    await engine.run(me());
    await engine.run(me());
    expect(patches).toHaveLength(1);
    // Nothing was rewritten locally either: the device keeps what the user typed.
    expect(settings.fontFamilySans).toBe("  Inter ");
  });
});
