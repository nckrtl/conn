import {
  isReservedOrbitEnvironment,
  orbitThreadStartHiddenEnvironmentId,
  type OrbitGatewayEnvironment,
} from "@t3tools/client-runtime/orbit-gateway";

import { reservedEnvironmentIdsAtom } from "../connection/visibleCatalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useOrbitThreadStarts } from "./orbitThreadStartStore";

/**
 * Conn: the servers of reserved Orbit clones, which no list shows until finalized. The main
 * window stores its reservations and the Gateway's reserved rows; every window adds the servers
 * its starts are finalizing.
 */
const HIDDEN_KEY = "conn:orbit-reserved-environments:v1";

export function readStoredIds(key: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeStoredIds(key: string, ids: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage off: the reservations stay held in memory; Orbit expires them after 10 minutes.
  }
}

let held: ReadonlySet<string> = new Set();
let listed: readonly string[] = [];

function store(): void {
  writeStoredIds(HIDDEN_KEY, [...new Set([...held, ...listed])]);
  applyHidden();
}

function applyHidden(): void {
  const next = new Set(readStoredIds(HIDDEN_KEY));
  for (const start of useOrbitThreadStarts.getState().starts) {
    const environmentId = orbitThreadStartHiddenEnvironmentId(start);
    if (environmentId) next.add(environmentId);
  }
  const current = appAtomRegistry.get(reservedEnvironmentIdsAtom);
  if (next.size === current.length && current.every((id) => next.has(id))) return;
  appAtomRegistry.set(reservedEnvironmentIdsAtom, [...next].toSorted());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === HIDDEN_KEY) applyHidden();
  });
  useOrbitThreadStarts.subscribe(applyHidden);
  applyHidden();
}

/** The main window's reservations: the servers of the clones it holds. */
export function setHeldReservedEnvironments(environmentIds: ReadonlySet<string>): void {
  held = environmentIds;
  store();
}

/** The main window's sync: the Gateway's reserved rows. */
export function noteOrbitReservedEnvironments(
  environments: readonly OrbitGatewayEnvironment[] | null,
): void {
  const next = (environments ?? [])
    .filter(isReservedOrbitEnvironment)
    .map((row) => row.environmentId);
  if (next.length === listed.length && next.every((id, index) => id === listed[index])) return;
  listed = next;
  store();
}
