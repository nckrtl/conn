import {
  createOrbitReservations,
  orbitThreadStartHiddenEnvironmentId,
  type OrbitReservations,
  type TakenOrbitReservation,
} from "@t3tools/client-runtime/orbit-gateway";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { reservedEnvironmentIdsAtom } from "../../connection/visibleCatalog";
import { writeFileAtomically } from "../../lib/atomic-file";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { orbitGatewayClient } from "./orbitGatewayClient";
import {
  listedOrbitReservedEnvironments,
  subscribeOrbitReservedEnvironments,
} from "./orbitReservedRows";
import { orbitThreadStartStore } from "./orbitThreadStartStore";

/**
 * Conn: the phone reserves a clone while the Orbit project screen is open (`createOrbitReservations`)
 * and hides the servers of reserved clones in every list until they are finalized.
 */
const RESERVATIONS_FILE = "orbit-reservations.json";

async function reservationsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, RESERVATIONS_FILE);
}

/** The file is written in order; a failed write only means Orbit expires the reservation itself. */
let writing: Promise<void> = Promise.resolve();

function applyHidden(): void {
  const next = new Set([
    ...reservations.hiddenEnvironmentIds(),
    ...listedOrbitReservedEnvironments(),
  ]);
  for (const start of orbitThreadStartStore.starts()) {
    const environmentId = orbitThreadStartHiddenEnvironmentId(start);
    if (environmentId) next.add(environmentId);
  }
  // A finalized clone shows at once, before the next Gateway list drops its reservation.
  for (const start of orbitThreadStartStore.starts()) {
    if (start.reservationId && start.environmentId !== null) next.delete(start.environmentId);
  }
  const current = appAtomRegistry.get(reservedEnvironmentIdsAtom);
  if (next.size === current.length && current.every((id) => next.has(id))) return;
  appAtomRegistry.set(reservedEnvironmentIdsAtom, [...next].sort());
}

/** Set by `connect` in the start runtime, which owns pairing on the phone. */
let connectClone: ((environmentId: string, pairingUrl: string) => Promise<void>) | null = null;

const reservations: OrbitReservations = createOrbitReservations({
  client: orbitGatewayClient,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  isSaved: (environmentId) =>
    appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.has(EnvironmentId.make(environmentId)),
  connect: async (environmentId, pairingUrl) => {
    if (connectClone === null) throw new Error("Pairing is not ready.");
    await connectClone(environmentId, pairingUrl);
  },
  hideForTakenStart: (reservationId, reservedEnvironmentId) => {
    const start = orbitThreadStartStore.starts().find((row) => row.reservationId === reservationId);
    if (!start) return false;
    orbitThreadStartStore.save({ ...start, reservedEnvironmentId });
    return true;
  },
  forget: async (environmentId) => {
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.remove,
      EnvironmentId.make(environmentId),
      { reportFailure: false },
    );
  },
  load: async () => {
    try {
      const file = await reservationsFile();
      const value: unknown = file.exists ? JSON.parse(await file.text()) : [];
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  },
  store: (ids) => {
    const text = JSON.stringify(ids);
    writing = writing
      .then(async () => writeFileAtomically(await reservationsFile(), text))
      .catch(() => {});
  },
  newKey: () => `conn-reservation:${uuidv4()}`,
});

/** Wires the reservations to the app: pairing, hidden servers, and a release of the last run's. */
export function installOrbitReservations(
  connect: (environmentId: string, pairingUrl: string) => Promise<void>,
): () => void {
  connectClone = connect;
  const disposers = [
    reservations.subscribe(applyHidden),
    subscribeOrbitReservedEnvironments(applyHidden),
    orbitThreadStartStore.subscribe(applyHidden),
  ];
  // A restart leaves no prompt open: release what the last run held.
  void reservations.releaseLeftovers();
  applyHidden();
  return () => {
    for (const dispose of disposers) dispose();
    reservations.closeAll();
  };
}

/** Start: the Project's reservation, or null to create as before. */
export function takeOrbitReservation(projectId: number): TakenOrbitReservation | null {
  return reservations.take(projectId);
}

export function waitForOrbitReservationPairing(reservationId: string): Promise<void> | undefined {
  return reservations.waitForPairing(reservationId);
}

/** Holds a reservation while the screen shows the Project; null holds none. */
export function useOrbitReservation(projectId: number | null, enabled: boolean): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a Gateway reservation while the screen shows the Project
  useEffect(() => {
    if (projectId === null || !enabled) return;
    reservations.open(projectId);
    return () => reservations.close(projectId);
  }, [enabled, projectId]);
}
