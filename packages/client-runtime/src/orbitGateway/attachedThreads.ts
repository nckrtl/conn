import type { OrbitGatewayEnvironment, OrbitGatewaySettings } from "./client.ts";
import type { StoredAttachedServers } from "../connection/parking.ts";

/** The profile section that lists the attached threads. Read only here; never sent in a PUT. */
const ATTACHED_THREADS_SECTION = "attachedThreads";

/**
 * The attached set as the profile stores it: its section version (0 = never written; a missing
 * section or null is an empty set at version 0) and the environments its threads live on.
 * Entries that are not `{environmentId, threadId}` strings are skipped.
 */
export function readAttachedThreadsSection(settings: OrbitGatewaySettings): {
  readonly version: number;
  readonly environmentIds: readonly string[];
} {
  const version = settings.sections?.[ATTACHED_THREADS_SECTION]?.version ?? 0;
  const raw = settings.document[ATTACHED_THREADS_SECTION];
  const threads =
    typeof raw === "object" && raw !== null ? (raw as { threads?: unknown }).threads : undefined;
  const environmentIds = new Set<string>();
  if (Array.isArray(threads)) {
    for (const thread of threads) {
      if (typeof thread !== "object" || thread === null) continue;
      const { environmentId, threadId } = thread as Record<string, unknown>;
      if (typeof environmentId === "string" && typeof threadId === "string") {
        environmentIds.add(environmentId);
      }
    }
  }
  return { version, environmentIds: [...environmentIds] };
}

/** Container servers in a Gateway list: rows with an Instance. Host servers are never in it. */
function containerEnvironmentIds(
  environments: readonly Pick<OrbitGatewayEnvironment, "environmentId" | "instanceId">[],
): string[] {
  return environments
    .filter((environment) => environment.instanceId !== null)
    .map((environment) => environment.environmentId);
}

/**
 * The record a device stores after a Gateway read. `settings` null keeps the attached part of
 * `previous` (the profile did not change, so it was not read again); a different profile with no
 * settings read starts over at version 0, which holds nothing off.
 */
export function nextStoredAttachedServers(input: {
  readonly previous: StoredAttachedServers | null;
  readonly profileId: number;
  readonly profileVersion: number;
  readonly settings: OrbitGatewaySettings | null;
  readonly environments: readonly Pick<OrbitGatewayEnvironment, "environmentId" | "instanceId">[];
}): StoredAttachedServers {
  const containers = containerEnvironmentIds(input.environments);
  if (input.settings !== null) {
    const section = readAttachedThreadsSection(input.settings);
    return {
      schema: 1,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      version: section.version,
      attached: section.environmentIds,
      containers,
    };
  }
  const previous = input.previous?.profileId === input.profileId ? input.previous : null;
  return {
    schema: 1,
    profileId: input.profileId,
    profileVersion: previous?.profileVersion ?? -1,
    version: previous?.version ?? 0,
    attached: previous?.attached ?? [],
    containers,
  };
}

/** Whether the profile's settings must be read again to know its attached set. */
export function attachedServersNeedSettings(
  previous: StoredAttachedServers | null,
  profileId: number,
  profileVersion: number,
): boolean {
  return (
    previous === null ||
    previous.profileId !== profileId ||
    previous.profileVersion !== profileVersion
  );
}
