import type { OrbitThreadStart } from "./threadStart.ts";

/**
 * Conn: edge states of the create's completion that the owner has not decided yet (spec Q4-Q7;
 * Q3 is `orbitRemoveWaitTextBehindCompletion` in the web app). Each returns the spec's proposal,
 * so the owner's answer is a one-line change here.
 */

/** Q4: a completion cancelled outside a removal (Orbit offers a Retry) shows the failed card. */
export function orbitCancelledCompletionShowsFailure(): boolean {
  return true;
}

/** Q5: a start with no message (the palette's plus) does not follow its completion. */
export function orbitPlusStartFollowsCompletion(): boolean {
  return false;
}

/** Q6: the phone app keeps today's behaviour and drops its start after the send. */
export function orbitPhoneFollowsCompletion(): boolean {
  return false;
}

/**
 * Q7: a Project process that did not start in the completion. Orbit takes a plain Retry there,
 * so the card says "…then retry" whenever Orbit offers one, not only with `requires`.
 */
export function orbitCompletionProcessFailureCanRetry(start: OrbitThreadStart): boolean {
  return start.completionRetryable === true;
}
