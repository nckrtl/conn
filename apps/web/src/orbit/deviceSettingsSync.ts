import {
  DESKTOP_DEVICE_SECTION,
  mergeDeviceSection,
  PROFILE_LIMITS,
  PROFILE_SCHEMA_VERSION,
  parseProfileDeviceSection,
  type JsonObject,
  type ProfileSyncChannel,
} from "@t3tools/client-runtime/orbit-gateway";
import {
  ClientSettingsPatch,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The client settings that follow the user between desktops through the profile's
 * `devices.desktop` section: how the app looks and reads (fonts, sizes, chat width, glass,
 * motion, diffs, timestamps, environment identification). Appearance contrast travels with the
 * appearance section instead.
 *
 * Machine-bound settings stay out on purpose: browser defaults and profiles, the annotation
 * dictation URLs (they name services on one machine), snapshot shortcuts and sounds,
 * quit and notification behavior, onboarding state, model favorites, sidebar layout, and
 * anything that holds an id or path of one install.
 */
export const DESKTOP_SYNCED_SETTING_KEYS = [
  "fontFamilySans",
  "fontFamilyCode",
  "fontFamilyComposer",
  "fontFamilyTerminal",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "fontSizeTerminal",
  "lineHeightInterface",
  "lineHeightPrompt",
  "lineHeightCode",
  "lineHeightTerminal",
  "fontSmoothing",
  "chatWidth",
  "glassOpacity",
  "panelAnimationDurationMs",
  "diffColorScheme",
  "diffFilesCollapsed",
  "diffIgnoreWhitespace",
  "diffLayout",
  "wordWrap",
  "timestampFormat",
  "environmentIdentificationMode",
] as const satisfies readonly (keyof ClientSettings)[];

const decodeSettingsPatch = Schema.decodeOption(ClientSettingsPatch);

/** The `devices.desktop` section for these settings: only allowlisted keys, in a fixed order. */
export function readDesktopDeviceSection(settings: ClientSettings): JsonObject {
  const values: Record<string, string | number | boolean> = {};
  for (const key of DESKTOP_SYNCED_SETTING_KEYS) {
    values[key] = settings[key];
  }
  return { schema: PROFILE_SCHEMA_VERSION, values };
}

/**
 * The patch that applies a `devices.desktop` section: allowlisted keys whose value this build
 * accepts. A key from a newer build, or a value out of range, is skipped rather than failing the
 * rest.
 */
export function desktopSettingsPatch(section: JsonObject): ClientSettingsPatch {
  const values = parseProfileDeviceSection(section)?.values;
  if (!values) return {};
  const patch: Record<string, unknown> = {};
  for (const key of DESKTOP_SYNCED_SETTING_KEYS) {
    if (!(key in values)) continue;
    // The Gateway stores an empty string as null; for a text setting that is "unset".
    const stored =
      values[key] === null && typeof DEFAULT_CLIENT_SETTINGS[key] === "string" ? "" : values[key];
    const decoded = Option.getOrNull(
      // Values come from another device, so each is checked on its own.
      decodeSettingsPatch({ [key]: stored } as typeof ClientSettingsPatch.Encoded),
    );
    if (decoded !== null && key in decoded) patch[key] = (decoded as Record<string, unknown>)[key];
  }
  return patch as ClientSettingsPatch;
}

export interface DesktopDeviceHost {
  readonly read: () => ClientSettings;
  readonly update: (patch: ClientSettingsPatch) => void;
}

/** The sync channel for this desktop's settings. */
export function createDesktopDeviceChannel(host: DesktopDeviceHost): ProfileSyncChannel {
  return {
    name: DESKTOP_DEVICE_SECTION,
    readLocal: () => {
      const section = readDesktopDeviceSection(host.read());
      // The Gateway rejects an empty `values` map, so a section with nothing to send is not written.
      return Object.keys(parseProfileDeviceSection(section)?.values ?? {}).length > 0
        ? section
        : null;
    },
    applyRemote: (value) => {
      const patch = desktopSettingsPatch(value);
      const current = host.read();
      const changed = Object.entries(patch).filter(
        ([key, next]) => current[key as keyof ClientSettings] !== next,
      );
      if (changed.length > 0) host.update(Object.fromEntries(changed) as ClientSettingsPatch);
    },
    merge: (base, local, remote) => {
      const merged = mergeDeviceSection(base, local, remote);
      const values = parseProfileDeviceSection(merged)?.values;
      // The Gateway caps a device section at 128 keys; a profile past that is left as it is.
      return values && Object.keys(values).length > PROFILE_LIMITS.deviceKeys ? remote : merged;
    },
  };
}
