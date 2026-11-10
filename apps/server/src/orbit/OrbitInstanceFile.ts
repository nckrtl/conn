import type { OrbitInstanceDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Orbit writes this file when it creates an Instance container (Orbit `InstanceContainer.php`). */
const ORBIT_INSTANCE_FILE = "/etc/orbit/instance";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function readKeys(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function readId(value: string | undefined): number | undefined {
  if (value === undefined || !POSITIVE_INTEGER.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

function readUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Parses Orbit's `KEY=value` instance file; without both ids there is no descriptor. */
export function parseOrbitInstanceFile(text: string): OrbitInstanceDescriptor | undefined {
  const values = readKeys(text);
  const projectId = readId(values.get("ORBIT_PROJECT_ID"));
  const instanceId = readId(values.get("ORBIT_INSTANCE_ID"));
  if (projectId === undefined || instanceId === undefined) return undefined;

  const field = (key: string) => values.get(key) || undefined;
  const projectSlug = field("ORBIT_PROJECT");
  const projectName = field("ORBIT_PROJECT_NAME");
  const instanceName = field("ORBIT_INSTANCE");
  const nodeName = field("ORBIT_NODE");
  const url = readUrl(values.get("ORBIT_URL"));
  return {
    projectId,
    instanceId,
    ...(projectSlug ? { projectSlug } : {}),
    ...(projectName ? { projectName } : {}),
    ...(instanceName ? { instanceName } : {}),
    ...(nodeName ? { nodeName } : {}),
    ...(url ? { url } : {}),
  };
}

/** A missing or unreadable file means the server is not in an Orbit Instance; startup never fails on it. */
export const readOrbitInstanceDescriptor = Effect.fn("OrbitInstanceFile.read")(function* (
  path: string = ORBIT_INSTANCE_FILE,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.map(parseOrbitInstanceFile),
    Effect.catch((cause) =>
      cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
        ? Effect.undefined
        : Effect.logWarning("Could not read the Orbit instance file", { path, cause }).pipe(
            Effect.as(undefined),
          ),
    ),
  );
});
