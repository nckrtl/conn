import {
  readOrbitThreadStarts,
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

export function updateStarts(change: (starts: OrbitThreadStart[]) => OrbitThreadStart[]): void {
  const next = change(readStored());
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
  return readStored().flatMap((start) => (start.instanceId === null ? [] : [start.instanceId]));
}
