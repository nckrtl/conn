import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentRegistry } from "./registry.ts";

/**
 * Conn: why the registry holds an enabled environment off; it connects only with no reason left.
 * Each owner changes only its own: `asleep` the desktop sleep controller, `not-attached` the
 * attached set (flag `connAttachedServers`).
 */
export type ParkReason = "asleep" | "not-attached";

export type ParkReasons = ReadonlyMap<EnvironmentId, ReadonlySet<ParkReason>>;

/**
 * The park reasons the registry holds from its first moment, before `start` creates a single
 * supervisor, so a server the device already knows to hold off never opens a socket. The default
 * is none: today's behaviour.
 */
export class ConnectionParkSeed extends Context.Reference<{
  readonly load: Effect.Effect<ParkReasons>;
}>("@t3tools/client-runtime/connection/ConnectionParkSeed", {
  defaultValue: () => ({ load: Effect.succeed(new Map()) }),
}) {}

/**
 * The one switch for "connect only attached container servers". Off by default: with it off no
 * `not-attached` reason is ever set and activity reports go to every saved server, as before.
 * A device may turn it on with the value "on" under `ATTACHED_SERVERS_FLAG_KEY` (desktop:
 * localStorage). C5 of the thread-index plan changes the default.
 */
export const ATTACHED_SERVERS_FLAG_KEY = "t3code:conn-attached-servers:v1";
export const ATTACHED_SERVERS_DEFAULT = false;

/** The flag's value from its stored text; anything but "on" or "off" is the default. */
export function attachedServersEnabled(stored: string | null | undefined): boolean {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return ATTACHED_SERVERS_DEFAULT;
}

/** What the device last learned about the profile's attached set, kept for the next launch. */
export interface StoredAttachedServers {
  readonly schema: 1;
  readonly profileId: number;
  /** The profile settings version this was read at, so an unchanged profile is not read again. */
  readonly profileVersion: number;
  /** The `attachedThreads` section version; 0 = the profile has never written the section. */
  readonly version: number;
  /** The environments of the attached threads, as the section lists them. */
  readonly attached: readonly string[];
  /** Container servers (Gateway rows with an Instance) this device may see, from the last list. */
  readonly containers: readonly string[];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;
}

/** Reads a stored record; null for anything that is not one (then nothing is held off). */
export function parseStoredAttachedServers(value: unknown): StoredAttachedServers | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const attached = strings(record.attached);
  const containers = strings(record.containers);
  if (
    record.schema !== 1 ||
    typeof record.profileId !== "number" ||
    typeof record.profileVersion !== "number" ||
    typeof record.version !== "number" ||
    attached === null ||
    containers === null
  ) {
    return null;
  }
  return {
    schema: 1,
    profileId: record.profileId,
    profileVersion: record.profileVersion,
    version: record.version,
    attached,
    containers,
  };
}

/**
 * Known container servers no attached thread lives on; host servers are never in it. A section
 * never written (version 0, or nothing stored) holds nothing off, so such a device keeps today's
 * connections. A written section, even an empty one, applies as it reads.
 */
export function notAttachedEnvironmentIds(
  stored: StoredAttachedServers | null,
): ReadonlySet<string> {
  if (stored === null || stored.version <= 0) return new Set();
  const attached = new Set(stored.attached);
  return new Set(stored.containers.filter((environmentId) => !attached.has(environmentId)));
}

/** The registry's starting reasons for a stored record; empty with the flag off. */
export function attachedServersParkSeed(
  enabled: boolean,
  stored: StoredAttachedServers | null,
): ParkReasons {
  const seed = new Map<EnvironmentId, ReadonlySet<ParkReason>>();
  if (!enabled) return seed;
  for (const environmentId of notAttachedEnvironmentIds(stored)) {
    seed.set(environmentId as EnvironmentId, new Set<ParkReason>(["not-attached"]));
  }
  return seed;
}

/**
 * The `not-attached` changes that bring the registry to `stored`: `hold` gets the reason, `release`
 * loses it. `current` is the set of environments that hold the reason now. With the flag off every
 * held reason is released and none is added.
 */
export function planAttachedServers(input: {
  readonly enabled: boolean;
  readonly stored: StoredAttachedServers | null;
  readonly current: ReadonlySet<string>;
}): { readonly hold: readonly string[]; readonly release: readonly string[] } {
  const wanted = input.enabled ? notAttachedEnvironmentIds(input.stored) : new Set<string>();
  return {
    hold: [...wanted].filter((environmentId) => !input.current.has(environmentId)),
    release: [...input.current].filter((environmentId) => !wanted.has(environmentId)),
  };
}

/** What the activity reporters read of the registry. */
export type ActivityReportRegistry = Pick<
  EnvironmentRegistry["Service"],
  "entries" | "connectedEnvironmentIds"
>;

/**
 * The servers an activity report goes to. Flag off: every saved server, as before. Flag on: only
 * connected ones, so a held-off server gets no report (a report would wait for a connection that
 * is not coming).
 */
export const activityReportTargets = Effect.fn("ConnectionParking.activityReportTargets")(
  function* (registry: ActivityReportRegistry, enabled: boolean) {
    const entries: ReadonlyArray<EnvironmentId> = [
      ...(yield* SubscriptionRef.get(registry.entries)).keys(),
    ];
    if (!enabled) return entries;
    const connected = yield* registry.connectedEnvironmentIds;
    return entries.filter((environmentId) => connected.has(environmentId));
  },
);
