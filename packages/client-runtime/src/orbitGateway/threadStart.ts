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
export function orbitThreadInstanceName(message: string, suffix: string): string {
  const slug = message
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word !== "")
    .slice(0, NAME_SLUG_WORDS)
    .join("-")
    .slice(0, NAME_SLUG_LENGTH)
    .replace(/-+$/, "");
  return `${slug || "thread"}-${suffix}`;
}
