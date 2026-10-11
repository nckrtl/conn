import { useAtomValue } from "@effect/atom-react";
import { hasUnseenCompletion } from "@t3tools/client-runtime/state/thread-status";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { Preferences } from "../persistence/mobile-preferences";
import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import { environmentThreadShells } from "./threads";

/**
 * Which threads finished while this phone was not looking: the Done label in
 * the thread list. It mirrors web's threadLastVisitedAtById semantics (see
 * apps/web/src/uiStateStore.ts), including that a thread this device never
 * opened counts as read.
 */

const NO_UNREAD_THREAD_KEYS: ReadonlySet<string> = new Set();

/** Thread keys (`environmentId:threadId`) whose latest completion is newer than the last visit. */
export const unreadThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const preferences = get(mobilePreferencesAtom);
  const visited = AsyncResult.isSuccess(preferences)
    ? preferences.value.threadLastVisitedAt
    : undefined;
  if (visited === undefined) return NO_UNREAD_THREAD_KEYS;
  const keys = new Set<string>();
  for (const thread of get(environmentThreadShells.threadShellsAtom)) {
    const threadKey = `${thread.environmentId}:${thread.id}`;
    if (hasUnseenCompletion({ latestTurn: thread.latestTurn, lastVisitedAt: visited[threadKey] })) {
      keys.add(threadKey);
    }
  }
  return keys;
}).pipe(Atom.withLabel("mobile:thread-visits:unread-thread-keys"));

export function useUnreadThreadKeys(): ReadonlySet<string> {
  return useAtomValue(unreadThreadKeysAtom);
}

function isNewerVisit(visited: Preferences["threadLastVisitedAt"], threadKey: string, at: number) {
  const previousMs = Date.parse(visited?.[threadKey] ?? "");
  return Number.isNaN(previousMs) || previousMs < at;
}

/**
 * Records that the user has seen the thread up to `visitedAt`. Callers pass the
 * latest turn's completion time (not now), so only that completion clears and a
 * later one still shows Done. The stamp never moves backwards.
 */
export function markThreadVisited(threadKey: string, visitedAt: string): void {
  const visitedAtMs = Date.parse(visitedAt);
  if (Number.isNaN(visitedAtMs)) return;
  const loaded = appAtomRegistry.get(mobilePreferencesAtom);
  if (
    AsyncResult.isSuccess(loaded) &&
    !isNewerVisit(loaded.value.threadLastVisitedAt, threadKey, visitedAtMs)
  ) {
    return;
  }
  appAtomRegistry.set(updateMobilePreferencesAtom, {
    transform: (current) =>
      isNewerVisit(current.threadLastVisitedAt, threadKey, visitedAtMs)
        ? { threadLastVisitedAt: { ...current.threadLastVisitedAt, [threadKey]: visitedAt } }
        : {},
  });
  // A command atom runs when read; reading it here runs it even when nothing has mounted it.
  appAtomRegistry.get(updateMobilePreferencesAtom);
}
