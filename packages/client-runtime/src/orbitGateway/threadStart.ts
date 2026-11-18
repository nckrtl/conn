import { msg } from "gt-i18n";

import type { OrbitGatewayClient } from "./client.ts";
import { OrbitLaunchCopyError } from "./launchCopy.ts";

/** A name whose address `<name>.<project domain>` Orbit refuses (check or create). */
export const ORBIT_NAME_DOMAIN_INVALID_TEXT =
  "This name makes the address too long. Use a shorter name.";

export type OrbitInstanceKind = "new" | "existing";

/** A clone the device knows already; a start in it skips the create. */
export interface OrbitExistingInstance {
  readonly instanceId: number;
  readonly environmentId: string;
  readonly name: string;
  readonly nodeName: string;
}

const NAME_SLUG_LENGTH = 40;
const NAME_SLUG_WORDS = 6;

/**
 * The clone's Instance name: the first words of the message as a slug, and a random suffix so two
 * threads with the same opening never name the same Instance.
 */
function orbitThreadInstanceName(message: string, suffix: string, length: number): string {
  const slug = message
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word !== "")
    .slice(0, NAME_SLUG_WORDS)
    .join("-")
    .slice(0, length)
    .replace(/-+$/, "");
  return `${slug || "thread"}-${suffix}`;
}

export async function fitOrbitThreadInstanceName(
  client: Pick<OrbitGatewayClient, "checkInstanceName">,
  projectId: number,
  message: string,
  suffix: string,
): Promise<string> {
  const names = new Set(
    [NAME_SLUG_LENGTH, 24, 12, 0].map((length) => orbitThreadInstanceName(message, suffix, length)),
  );
  let addressTooLong = false;
  for (const name of names) {
    const check = await client.checkInstanceName(projectId, name).catch(() => null);
    if (check === null && addressTooLong) break;
    if (check?.reason !== "domain_invalid") return name;
    addressTooLong = true;
  }
  throw OrbitLaunchCopyError.fromCopy(
    msg("Orbit could not find an Instance name short enough for this Project's address."),
  );
}
