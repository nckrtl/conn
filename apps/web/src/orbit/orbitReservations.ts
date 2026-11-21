import {
  createOrbitGatewayClient,
  createOrbitReservations,
  dismissedOrbitReservationIds,
  type OrbitReservations,
  type TakenOrbitReservation,
} from "@t3tools/client-runtime/orbit-gateway";
import { EnvironmentNotRegisteredError } from "@t3tools/client-runtime/connection";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isAdditionalDesktopWindow } from "../lib/desktopWindowContext";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { desktopOrbitGatewayTransport } from "./desktopOrbitGateway";
import { forgetOrbitInstanceEnvironment, useEnvironmentProvider } from "./environmentProvider";
import { readStored, saveStart, useOrbitThreadStarts } from "./orbitThreadStartStore";
import { connectOrbitClone, isOrbitServerSaved } from "./orbitThreadStarts";
import {
  readStoredIds,
  setHeldReservedEnvironments,
  writeStoredIds,
} from "./orbitReservedEnvironments";

/**
 * Conn: the main window reserves a clone while the prompt box of a new Instance is open
 * (`createOrbitReservations`); other windows start as before.
 */
const isEnvironmentNotRegistered = Schema.is(EnvironmentNotRegisteredError);
const OPEN_KEY = "conn:orbit-reservations:v1";

let manager: OrbitReservations | null = null;

export function getOrbitReservations(): OrbitReservations | null {
  if (manager !== null) return manager;
  const transport = isAdditionalDesktopWindow() ? null : desktopOrbitGatewayTransport();
  if (transport === null) return null;
  const created = createOrbitReservations({
    client: createOrbitGatewayClient(transport),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    isSaved: isOrbitServerSaved,
    connect: connectOrbitClone,
    hideForTakenStart: (reservationId, reservedEnvironmentId) => {
      const start = readStored().find(
        (row) => row.reservationId === reservationId && row.environmentId === null,
      );
      if (!start) return false;
      saveStart({ ...start, reservedEnvironmentId });
      return true;
    },
    forget: async (environmentId) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        environmentCatalog.remove,
        environmentId as EnvironmentId,
        { reportFailure: false },
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        if (!isEnvironmentNotRegistered(error)) throw error;
      }
      if (isOrbitServerSaved(environmentId))
        throw new Error("Reserved server is still in the catalog.");
      forgetOrbitInstanceEnvironment(environmentId);
    },
    load: () => readStoredIds(OPEN_KEY),
    store: (ids) => writeStoredIds(OPEN_KEY, ids),
    newKey: () => `conn-reservation:${randomUUID()}`,
  });
  manager = created;
  created.subscribe(() => setHeldReservedEnvironments(created.hiddenEnvironmentIds()));
  useOrbitThreadStarts.subscribe(({ starts }, previous) => {
    for (const id of dismissedOrbitReservationIds(previous.starts, starts)) {
      void created.abandon(id);
    }
  });
  // A restart leaves no prompt box open: release what the last run held.
  void created.releaseLeftovers();
  window.addEventListener("pagehide", () => created.closeAll());
  return created;
}

/** The send of a new Instance: the Project's reservation, or null to create as before. */
export function takeOrbitReservation(projectId: number): TakenOrbitReservation | null {
  return manager?.take(projectId) ?? null;
}

/**
 * Holds a reservation while the prompt box of a new Instance in the Project shows; null holds
 * none. Leaving the prompt box without a send releases it.
 */
export function useOrbitReservation(projectId: number | null): void {
  const orbit = useEnvironmentProvider((store) => store.provider === "orbit");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a Gateway reservation while the prompt box shows
  useEffect(() => {
    if (projectId === null || !orbit) return;
    const current = getOrbitReservations();
    if (current === null) return;
    current.open(projectId);
    return () => current.close(projectId);
  }, [orbit, projectId]);
}
