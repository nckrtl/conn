import {
  ATTACHED_SERVERS_FLAG_KEY,
  ConnectionParkSeed,
  attachedServersEnabled,
  attachedServersParkSeed,
  parseStoredAttachedServers,
  type StoredAttachedServers,
} from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Conn (thread-index plan, C2): the `connAttachedServers` flag and the attached-set record this
 * device keeps, and the registry's starting reasons from them. Kept apart from `attachedServers.ts`
 * because the connection runtime imports it before the catalog exists.
 */

export const ATTACHED_SERVERS_RECORD_KEY = "t3code:conn-attached-servers-record:v1";

export function readAttachedServersFlag(): boolean {
  try {
    return attachedServersEnabled(window.localStorage.getItem(ATTACHED_SERVERS_FLAG_KEY));
  } catch {
    return attachedServersEnabled(null);
  }
}

export function loadAttachedServersRecord(): StoredAttachedServers | null {
  try {
    const raw = window.localStorage.getItem(ATTACHED_SERVERS_RECORD_KEY);
    return raw === null ? null : parseStoredAttachedServers(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveAttachedServersRecord(record: StoredAttachedServers | null): void {
  try {
    if (record === null) window.localStorage.removeItem(ATTACHED_SERVERS_RECORD_KEY);
    else window.localStorage.setItem(ATTACHED_SERVERS_RECORD_KEY, JSON.stringify(record));
  } catch {
    // Without storage the next launch starts as today; this window still applies the set.
  }
}

/**
 * The registry's starting reasons, read when the connection runtime is built: with the flag on,
 * the stored set's held-off servers never open a socket. Flag off: none, as today.
 */
export const attachedServersSeedLayer = Layer.succeed(ConnectionParkSeed, {
  load: Effect.sync(() =>
    typeof window === "undefined"
      ? new Map()
      : attachedServersParkSeed(readAttachedServersFlag(), loadAttachedServersRecord()),
  ),
});
