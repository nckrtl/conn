import {
  APPEARANCE_SECTION,
  createProfileSync,
  mergeAppearance,
  parseProfileAppearance,
  type JsonObject,
  type OrbitGatewayNode,
  type ProfileSyncChannel,
  type ProfileSyncState,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  mobileAppearancePatch,
  profileMobileThemes,
  serializeMobileAppearance,
  syncedProfileAppearance,
  withProfileThemes,
} from "../../lib/orbitAppearance";
import { collectPublishedMobileThemes } from "../../lib/publishedThemes";
import type { Preferences } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { orbitGatewayClient } from "./orbitGatewayClient";

/**
 * Keeps the phone's theme and light/dark mode in step with its Orbit profile, through the same
 * engine the desktop uses (see profileSync.ts in client-runtime). Font sizes stay on the phone.
 * The engine's state lives in the preferences, so the profile's themes survive a restart.
 */

// Written values not yet staged by the save command. The command may start after this run, so
// reads overlay them until it settles.
let unsettled: Partial<Preferences> = {};

function readPreferences(): Preferences | null {
  const result = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? { ...result.value, ...unsettled } : null;
}

/** Applies the patch optimistically at once, so the engine reads it back in the same run. */
function writePreferences(patch: Partial<Preferences>): void {
  unsettled = { ...unsettled, ...patch };
  void runAtomCommand(appAtomRegistry, saveMobilePreferences, patch).then(() => {
    const next: Record<string, unknown> = { ...unsettled };
    for (const key of Object.keys(patch) as Array<keyof Preferences>) {
      if (next[key] === patch[key]) delete next[key];
    }
    unsettled = next as Partial<Preferences>;
  });
}

/** Set while a run applies the profile, before the engine saves it, so the readback finds its themes. */
let appliedRemote: JsonObject | null = null;

function loadState(): ProfileSyncState | null {
  return readPreferences()?.orbitProfileSync ?? null;
}

function saveState(state: ProfileSyncState): void {
  appliedRemote = null;
  writePreferences({ orbitProfileSync: state });
}

const appearanceChannel: ProfileSyncChannel = {
  name: APPEARANCE_SECTION,
  readLocal: (base) => {
    const preferences = readPreferences();
    if (preferences === null) return null;
    const profile =
      appliedRemote === null
        ? syncedProfileAppearance(preferences.orbitProfileSync)
        : parseProfileAppearance(appliedRemote);
    const themes = withProfileThemes(
      collectPublishedMobileThemes(appAtomRegistry.get(environmentServerConfigsAtom)),
      profileMobileThemes(profile),
    );
    return serializeMobileAppearance(preferences, base, themes);
  },
  applyRemote: (value) => {
    const preferences = readPreferences();
    if (preferences === null) return;
    appliedRemote = value;
    const patch = mobileAppearancePatch(value, preferences);
    if (patch !== null) writePreferences(patch);
  },
  merge: mergeAppearance,
};

const engine = createProfileSync({
  client: orbitGatewayClient,
  channels: () => [appearanceChannel],
  loadState,
  saveState,
});

/**
 * Syncs the appearance for a node a profile read just took; nothing applies once `isCurrent()`
 * is false. Resolves false when it applied nothing (the preferences are not readable yet) and
 * throws the Gateway's error, so the read can tell a refusal from a passing failure.
 */
export async function runOrbitAppearance(
  node: OrbitGatewayNode,
  isCurrent: () => boolean,
): Promise<boolean> {
  return (await engine.run(node, isCurrent)).kind !== "idle";
}
