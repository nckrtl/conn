/**
 * Conn: an Orbit Instance's Git state, as Orbit's Instances list sends it with `?include=git`
 * (handle B, not live yet). Shared by the desktop row, the remove dialog and the phone.
 */
export type OrbitInstanceGitState =
  | {
      readonly state: "known";
      readonly branch: string | null;
      readonly uncommitted: number;
      readonly unpushed: number;
      readonly hasUpstream: boolean;
      readonly readAt: string | null;
    }
  | {
      readonly state: "unknown";
      /** Orbit's reason; null when it sent none Conn knows. */
      readonly reason: "stopped" | "unreadable" | "timeout" | null;
    };

const UNKNOWN_REASONS: ReadonlySet<string> = new Set(["stopped", "unreadable", "timeout"]);

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
  const reason = data?.reason;
  return {
    state: "unknown",
    reason:
      typeof reason === "string" && UNKNOWN_REASONS.has(reason)
        ? (reason as "stopped" | "unreadable" | "timeout")
        : null,
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
  if (details.state !== "dirty") return { state: "unknown", reason: null };
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

/** The unsaved work in words, such as "3 uncommitted changes" and "1 commit not pushed". */
export function orbitInstanceGitParts(git: OrbitInstanceGitState | undefined): string[] {
  if (git?.state !== "known") return [];
  return [
    git.uncommitted > 0 ? plural(git.uncommitted, "uncommitted change") : null,
    git.unpushed > 0 ? `${plural(git.unpushed, "commit")} not pushed` : null,
  ].filter((part) => part !== null);
}

/** The row's Git line: "Clean", the unsaved work (shown as a warning), or "Git state unknown". */
export function orbitInstanceGitLine(git: OrbitInstanceGitState | undefined): {
  readonly tone: "clean" | "warning" | "unknown";
  readonly text: string;
} {
  if (git?.state !== "known") return { tone: "unknown", text: "Git state unknown" };
  const parts = orbitInstanceGitParts(git);
  return parts.length === 0
    ? { tone: "clean", text: "Clean" }
    : { tone: "warning", text: parts.join(" · ") };
}

/**
 * Whether removing needs the extra tick: unsaved work, a working thread, or a Git state Conn does
 * not know (unknown, or not sent at all).
 */
export function orbitInstanceRemoveNeedsAck(input: {
  readonly git: OrbitInstanceGitState | undefined;
  readonly workingCount: number;
}): boolean {
  return (
    input.git?.state !== "known" ||
    input.git.uncommitted > 0 ||
    input.git.unpushed > 0 ||
    input.workingCount > 0
  );
}
