// The removed worktree-based Orbit mode put checkouts beside a Project's `default` checkout:
// `<apps>/<project>/t3code-<8 hex>` (older: `t3-<8 hex>`). T3 names its own worktrees the same
// way but keeps them at `<T3 home>/worktrees/<repo>/<name>`, e.g. under `~/.t3/headless`.
const ORBIT_CHECKOUT_NAME = /^t3(?:code)?-[0-9a-f]{8}$/;

/** Orbit owns this folder, so T3 must never run `git worktree` commands on it. */
export function isOrbitCheckout(worktreePath: string | null): boolean {
  if (worktreePath === null) return false;
  const segments = worktreePath.split(/[\\/]+/).filter((segment) => segment !== "");
  const name = segments.at(-1);
  if (name === undefined || segments.length < 3 || !ORBIT_CHECKOUT_NAME.test(name)) return false;
  return segments.at(-3) !== "worktrees" && !segments.includes(".t3");
}
