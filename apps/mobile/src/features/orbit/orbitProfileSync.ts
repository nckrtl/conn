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
import { AsyncResult } from "effect/unstable/reactivity";

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
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { orbitGatewayClient } from "./orbitGatewayClient";

/**
 * Keeps the phone's theme and light/dark mode in step with its Orbit profile, through the same
 * engine the desktop uses (see profileSync.ts in client-runtime). Font sizes stay on the phone.
 * The engine's state lives in the preferences, so the profile's themes survive a restart.
 */

function readPreferences(): Preferences | null {
  const result = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** Applies the patch optimistically at once, so the engine reads it back in the same run. */
function writePreferences(patch: Partial<Preferences>): void {
  appAtomRegistry.set(updateMobilePreferencesAtom, patch);
  // A command atom runs when read; reading it here runs it even when nothing has mounted it.
  appAtomRegistry.get(updateMobilePreferencesAtom);
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

/** Syncs the appearance for a node the caller just read. Failures wait for the next run. */
export async function syncOrbitAppearance(node: OrbitGatewayNode): Promise<void> {
  try {
    await engine.run(node);
  } catch (error) {
    console.warn("[orbit] appearance sync failed", error);
  }
}
