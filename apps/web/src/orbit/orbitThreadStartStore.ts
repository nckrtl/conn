import {
  readOrbitThreadStarts,
  type OrbitGatewayOperation,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";
import { create } from "zustand";

/**
 * Conn: the threads started in an Orbit Project, kept in localStorage until their first message is
 * sent, so a reload resumes them. Every window reads the list fresh before it writes; two writes in
 * the same moment from two windows can still lose one.
 */

const STORAGE_KEY = "conn:orbit-thread-starts:v1";
export function readStored(): OrbitThreadStart[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return readOrbitThreadStarts(raw === null ? [] : JSON.parse(raw));
  } catch {
    return [];
  }
}

export const useOrbitThreadStarts = create<{ readonly starts: readonly OrbitThreadStart[] }>(
  () => ({ starts: readStored() }),
);

/** Sent starts kept for their thread's "Instance ready" row; the oldest go first. */
const KEPT_SENT_STARTS = 50;

function pruneSent(starts: OrbitThreadStart[]): OrbitThreadStart[] {
  const sent = starts.filter((start) => start.sentAt != null);
  if (sent.length <= KEPT_SENT_STARTS) return starts;
  const drop = new Set(
    sent
      .toSorted((left, right) => left.sentAt! - right.sentAt!)
      .slice(0, sent.length - KEPT_SENT_STARTS)
      .map((start) => start.id),
  );
  return starts.filter((start) => !drop.has(start.id));
}

export function updateStarts(change: (starts: OrbitThreadStart[]) => OrbitThreadStart[]): void {
  const next = pruneSent(change(readStored()));
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  useOrbitThreadStarts.setState({ starts: next });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) useOrbitThreadStarts.setState({ starts: readStored() });
  });
}

export function saveStart(start: OrbitThreadStart): void {
  updateStarts((starts) => starts.map((entry) => (entry.id === start.id ? start : entry)));
}

/** Instances whose server a start pairs with itself; the environment sync leaves them alone. */
export function heldOrbitInstanceIds(): number[] {
  return readStored().flatMap((start) =>
    start.instanceId === null || start.sentAt != null ? [] : [start.instanceId],
  );
}

/** The sent start of a thread, for its "Instance ready" row. */
export function useSentOrbitThreadStart(threadId: string | null): OrbitThreadStart | null {
  return useOrbitThreadStarts(
    (state) =>
      state.starts.find(
        (start) => start.threadId === threadId && start.pendingThread && start.sentAt != null,
      ) ?? null,
  );
}

/** The latest read of each running create Operation, by start id; this window only. */
export const useOrbitCreateOperations = create<{
  readonly byStart: Readonly<Record<string, OrbitGatewayOperation>>;
}>(() => ({ byStart: {} }));

export function recordCreateOperation(startId: string, operation: OrbitGatewayOperation): void {
  useOrbitCreateOperations.setState(({ byStart }) => ({
    byStart: { ...byStart, [startId]: operation },
  }));
}
