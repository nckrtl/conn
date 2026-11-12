import type { ProfileSyncChannel } from "@t3tools/client-runtime/orbit-gateway";

/**
 * The meeting point between the components that can read and write this device's appearance and
 * settings (they need React hooks) and the profile sync engine (which runs on a timer).
 * `OrbitAppearanceSync` registers the channels and announces local changes; `OrbitProfileSync`
 * reads the channels and schedules a sync after each announcement.
 */

let channels: readonly ProfileSyncChannel[] = [];
const changeListeners = new Set<() => void>();

export function getProfileSyncChannels(): readonly ProfileSyncChannel[] {
  return channels;
}

/** Returns the function that withdraws these channels. */
export function setProfileSyncChannels(next: readonly ProfileSyncChannel[]): () => void {
  channels = next;
  return () => {
    if (channels === next) channels = [];
  };
}

/** Something on this device that may be synced has changed; the sync debounces and decides. */
export function notifyLocalProfileChange(): void {
  for (const listener of changeListeners) listener();
}

export function onLocalProfileChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
