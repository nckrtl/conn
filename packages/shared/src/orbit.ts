import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "./git.ts";

/** `t3/login-redirect` (or legacy `t3code/…`) → `login-redirect`, as a DNS label; null while temporary. */
export function orbitRouteSlugForBranch(branch: string): string | null {
  if (isTemporaryWorktreeBranch(branch)) return null;
  const prefix = [`${WORKTREE_BRANCH_PREFIX}/`, "t3code/"].find((p) => branch.startsWith(p));
  const name = prefix ? branch.slice(prefix.length) : branch;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug === "" ? null : slug;
}

// Names a model sometimes returns instead of describing the work.
const PLACEHOLDER_ROUTE_SLUGS = new Set([
  "unknown",
  "update",
  "branch",
  "feature",
  "change",
  "task",
  "work",
  "new",
]);

function slugify(text: string, maxLength: number): string | null {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return null;
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > maxLength / 2 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, "");
}

/**
 * The route's first label: T3's generated branch name, or the thread title
 * when the branch is still temporary or got a placeholder name such as
 * `t3/unknown`, or else the Instance name.
 */
export function orbitRouteSlug(input: {
  readonly branch: string;
  readonly title: string | null;
  readonly instanceName: string;
}): string {
  const fromBranch = orbitRouteSlugForBranch(input.branch);
  if (fromBranch !== null && !PLACEHOLDER_ROUTE_SLUGS.has(fromBranch)) return fromBranch;
  const fromTitle = input.title ? slugify(input.title, 40) : null;
  if (fromTitle !== null && !PLACEHOLDER_ROUTE_SLUGS.has(fromTitle) && fromTitle !== "new-thread") {
    return fromTitle;
  }
  return fromBranch ?? input.instanceName;
}

/** `login-redirect` → `login-redirect-2` for the second try at a taken domain. */
export function orbitRouteSlugAttempt(slug: string, attempt: number): string {
  return attempt === 1 ? slug : `${slug.slice(0, 60)}-${attempt}`;
}
