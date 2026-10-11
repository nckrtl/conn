/**
 * Thread status shared by the web sidebar and the mobile thread list, so the
 * two clients cannot drift on what a row says or which state wins.
 *
 * Six states, a few colors: color is reserved for "act now" (approval),
 * "in motion" (working), and "broken" (failed). Ready is the resting state:
 * the agent stopped and waits on the user, whether it finished, asked a
 * question, or proposed a plan. Unread completion ("Done") is tracked
 * separately by `hasUnseenCompletion`: it describes whether a ready thread
 * needs attention, not what the thread is currently doing.
 */
export type ThreadStatus = "approval" | "input" | "working" | "monitoring" | "failed" | "ready";

export interface ThreadStatusInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session: { readonly status: string } | null | undefined;
  /** Native background work alive after the turn settles. Absent on old servers. */
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
}

/**
 * Precedence: approval, input, a live session, a failed session, background
 * work, then ready. A failed session outranks lingering background liveness so
 * the user sees the failure, not a stale Working. Subagent and workflow fleets
 * read as working; monitoring means watch loops are the only live work.
 */
export function resolveThreadStatus(thread: ThreadStatusInput): ThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}

/**
 * True when the latest turn finished after this client last visited the thread.
 * A thread this client never visited counts as read, so a fresh install does not
 * light up every historical thread. `lastVisitedAt` is client-local state.
 */
export function hasUnseenCompletion(thread: {
  readonly latestTurn: { readonly completedAt: string | null } | null | undefined;
  readonly lastVisitedAt?: string | undefined;
}): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}
