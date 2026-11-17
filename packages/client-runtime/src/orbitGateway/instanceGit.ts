/**
 * Conn: an Orbit Instance's Git state. Read per Instance when the remove sheet opens
 * (`GET /conn/instances/{id}/work`, contract v2) and named again in the destroy refusal; the list's
 * `?include=git` (handle B) shape is still read. Shared by the desktop and the phone.
 */
export type OrbitInstanceGitState =
  | {
      readonly state: "known";
      readonly branch: string | null;
      /** Changed tracked files (`modified`); the old shape's whole `uncommitted` count. */
      readonly uncommitted: number;
      /** Distinct commits not pushed. */
      readonly unpushed: number;
      readonly hasUpstream: boolean;
      readonly readAt: string | null;
      /** New files (`untracked`); absent in the old shape. */
      readonly untracked?: number;
      readonly stashes?: number;
      /** The first branches with commits not pushed, each with its count. */
      readonly branches?: ReadonlyArray<{ readonly name: string; readonly count: number }>;
      /** All branches with commits not pushed. */
      readonly branchCount?: number;
    }
  | {
      readonly state: "unknown";
      /** Orbit's reason; null when it sent none Conn knows. Not shown in words. */
      readonly reason: OrbitInstanceGitUnknownReason | null;
    };

export type OrbitInstanceGitUnknownReason =
  | "stopped"
  | "asleep"
  | "timeout"
  | "not_a_repository"
  | "unreachable"
  | "unreadable";

const UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  "stopped",
  "asleep",
  "timeout",
  "not_a_repository",
  "unreachable",
  "unreadable",
]);

const unknownReason = (reason: unknown): OrbitInstanceGitUnknownReason | null =>
  typeof reason === "string" && UNKNOWN_REASONS.has(reason)
    ? (reason as OrbitInstanceGitUnknownReason)
    : null;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Reads one Instance's `git` field. Absent (an older Gateway, or a list read without
 * `include=git`) gives undefined; anything Conn cannot read counts as unknown, never as clean.
 */
export function parseOrbitInstanceGit(value: unknown): OrbitInstanceGitState | undefined {
  if (value === undefined || value === null) return undefined;
  const data = typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (data?.state === "known") {
    const uncommitted = count(data.uncommitted);
    const unpushed = count(data.unpushed);
    if (uncommitted !== null && unpushed !== null) {
      return {
        state: "known",
        branch: typeof data.branch === "string" && data.branch !== "" ? data.branch : null,
        uncommitted,
        unpushed,
        hasUpstream: data.has_upstream !== false,
        readAt: typeof data.read_at === "string" ? data.read_at : null,
      };
    }
  }
  return { state: "unknown", reason: unknownReason(data?.reason) };
}

const classCount = (value: unknown): number | null =>
  typeof value === "object" && value !== null
    ? count((value as Record<string, unknown>).count)
    : null;

/**
 * Reads Orbit's work state (contract v2: the `/work` read and the destroy refusal's details).
 * `clean` and `dirty` need every class count; anything Conn cannot read is unknown, never clean.
 * Names are untrusted text: Conn shows only counts and branch names, as plain text.
 */
export function parseOrbitInstanceWork(value: unknown): OrbitInstanceGitState {
  const data =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const state = data?.state;
  if (data === null || (state !== "clean" && state !== "dirty" && state !== "work")) {
    return { state: "unknown", reason: unknownReason(data?.reason) };
  }
  const modified = classCount(data.modified);
  const untracked = classCount(data.untracked);
  const commitsClass = data.commits ?? data.unpushed;
  const unpushed = classCount(commitsClass);
  const stashes = classCount(data.stashes);
  if (modified === null || untracked === null || unpushed === null || stashes === null) {
    return { state: "unknown", reason: null };
  }
  const commits = commitsClass as Record<string, unknown>;
  const branches = (Array.isArray(commits.branches) ? commits.branches : []).flatMap(
    (entry: unknown) => {
      const branch =
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
      const n = count(branch?.count);
      return typeof branch?.name === "string" && branch.name !== "" && n !== null && n > 0
        ? [{ name: branch.name, count: n }]
        : [];
    },
  );
  // Orbit says dirty but names nothing: Conn cannot say what is lost.
  if (state !== "clean" && modified + untracked + unpushed + stashes === 0) {
    return { state: "unknown", reason: null };
  }
  return {
    state: "known",
    branch: typeof data.head === "string" && data.head !== "" ? data.head : null,
    uncommitted: modified,
    untracked,
    unpushed,
    stashes,
    branches,
    branchCount: Math.max(count(commits.branch_count) ?? 0, branches.length),
    hasUpstream: true,
    readAt: typeof data.read_at === "string" ? data.read_at : null,
  };
}

/**
 * The Git state Orbit's refusal `instance.unsaved_work` names (`details`), on top of what the list
 * said before. A count Orbit leaves null keeps the list's count.
 */
export function orbitInstanceGitFromUnsavedWork(
  details: Readonly<Record<string, unknown>>,
  previous: OrbitInstanceGitState | undefined,
): OrbitInstanceGitState {
  // Contract v2: the refusal carries the full read with its classes.
  if ("modified" in details || "commits" in details) return parseOrbitInstanceWork(details);
  if (details.state !== "dirty") return { state: "unknown", reason: unknownReason(details.reason) };
  const known = previous?.state === "known" ? previous : null;
  const uncommitted = count(details.uncommitted) ?? known?.uncommitted ?? null;
  const unpushed = count(details.unpushed) ?? known?.unpushed ?? null;
  if (uncommitted === null || unpushed === null || uncommitted + unpushed === 0) {
    return { state: "unknown", reason: null };
  }
  return {
    state: "known",
    branch: known?.branch ?? null,
    uncommitted,
    unpushed,
    hasUpstream: known?.hasUpstream ?? true,
    readAt: known?.readAt ?? null,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** At most this many "not pushed on branch" lines; the rest is one "and N more branches". */
const BRANCH_LINES = 3;

/**
 * The unsaved work in words, one fact per item: "3 uncommitted changes", "2 new files",
 * "2 commits not pushed on branch feature-x" (per branch), "and 4 more branches", "1 stash".
 */
export function orbitInstanceGitParts(
  git: OrbitInstanceGitState | undefined,
  /** The row's short line counts commits once, without branches. */
  options: { readonly perBranch?: boolean } = {},
): string[] {
  if (git?.state !== "known") return [];
  const perBranch = options.perBranch ?? true;
  const parts: string[] = [];
  if (git.uncommitted > 0) parts.push(plural(git.uncommitted, "uncommitted change"));
  if ((git.untracked ?? 0) > 0) parts.push(plural(git.untracked!, "new file"));
  const branches = git.branches ?? [];
  if (perBranch && branches.length > 0) {
    for (const branch of branches.slice(0, BRANCH_LINES)) {
      parts.push(`${plural(branch.count, "commit")} not pushed on branch ${branch.name}`);
    }
    const more = Math.max(git.branchCount ?? 0, branches.length) - BRANCH_LINES;
    if (more > 0) parts.push(`and ${more} more ${more === 1 ? "branch" : "branches"}`);
  } else if (git.unpushed > 0) {
    parts.push(
      // The old list shape names the checked-out branch; v2 sends `branches`, so an empty list
      // leaves the commits' branch unknown.
      `${plural(git.unpushed, "commit")} not pushed${perBranch && git.branches === undefined && git.branch !== null ? ` on branch ${git.branch}` : ""}`,
    );
  }
  const stashes = git.stashes ?? 0;
  if (stashes > 0) parts.push(`${stashes} ${stashes === 1 ? "stash" : "stashes"}`);
  return parts;
}

/** The row's Git line: "Clean", the unsaved work (shown as a warning), or "Git state unknown". */
export function orbitInstanceGitLine(git: OrbitInstanceGitState | undefined): {
  readonly tone: "clean" | "warning" | "unknown";
  readonly text: string;
} {
  if (git?.state !== "known") return { tone: "unknown", text: "Git state unknown" };
  const parts = orbitInstanceGitParts(git, { perBranch: false });
  return parts.length === 0
    ? { tone: "clean", text: "Clean" }
    : { tone: "warning", text: parts.join(" · ") };
}

/**
 * Whether removing needs the extra tick: unsaved work, a working thread, or a Git state Orbit
 * reports as unknown. Without any Git state (no handle B yet) only Orbit's refusal asks for it.
 */
export function orbitInstanceRemoveNeedsAck(input: {
  readonly git: OrbitInstanceGitState | undefined;
  readonly workingCount: number;
}): boolean {
  if (input.workingCount > 0) return true;
  if (input.git === undefined) return false;
  return input.git.state !== "known" || orbitInstanceGitParts(input.git).length > 0;
}

/**
 * Whether the tick covers Git work: the dialog named Orbit's facts or said Orbit cannot tell. Only
 * then may the destroy skip Orbit's own read (`acknowledge_unsaved: true`); a tick that only stops
 * working threads never does.
 */
export function orbitInstanceRemoveAcknowledgesGit(
  git: OrbitInstanceGitState | undefined,
): boolean {
  return git !== undefined && (git.state !== "known" || orbitInstanceGitParts(git).length > 0);
}

/** How long a Git read before a remove may take at most; the sheet waits only `…_WAIT_MS`. */
const ORBIT_INSTANCE_GIT_READ_TIMEOUT_MS = 10_000;
/** The remove sheet keeps its button off this long while the Git read runs, then acts as before. */
export const ORBIT_INSTANCE_GIT_READ_WAIT_MS = 1_000;

/**
 * Reads one Instance's work state when the remove sheet opens. Undefined when Orbit gives no
 * answer (an older Gateway without the read: 404; a host Instance: 409; any error): the sheet
 * then works as before and Orbit's refusal at the click names the state.
 */
export async function readOrbitInstanceGit(
  client: { readonly instanceGit: (instanceId: number, timeoutMs: number) => Promise<unknown> },
  instanceId: number,
): Promise<OrbitInstanceGitState | undefined> {
  try {
    const data = await client.instanceGit(instanceId, ORBIT_INSTANCE_GIT_READ_TIMEOUT_MS);
    return typeof data === "object" && data !== null ? parseOrbitInstanceWork(data) : undefined;
  } catch {
    return undefined;
  }
}
