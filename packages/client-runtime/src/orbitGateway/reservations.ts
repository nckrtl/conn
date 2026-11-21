import * as Schema from "effect/Schema";

import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayReservation,
} from "./client.ts";

/**
 * Conn: a clone reserved while the prompt box of a new Instance is open, paired once ready, taken
 * by the send (which finalizes it) or released on close. Nothing shows on screen: a reservation
 * that is not usable at send leaves the start to the normal create.
 */

/** Poll a preparing reservation every 2 s, and read a ready one every 60 s so it stays held. */
export const RESERVATION_PREPARING_POLL_MS = 2_000;
export const RESERVATION_KEEPALIVE_MS = 60_000;
/** Orbit holds at most 3 per caller and releases the oldest for a fourth; Conn does it first. */
export const MAX_OPEN_RESERVATIONS = 3;

export type OrbitReservationClient = Pick<
  OrbitGatewayClient,
  "reserve" | "reservation" | "releaseReservation" | "pair"
>;

export interface OrbitReservationPorts {
  readonly client: OrbitReservationClient;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Whether the device saved this server already. */
  readonly isSaved: (environmentId: string) => boolean;
  /** Opens a one-time pairing link and saves the server, as for any clone. */
  readonly connect: (environmentId: string, pairingUrl: string) => Promise<void>;
  /** Removes a released clone's saved server from the device. */
  readonly forget: (environmentId: string) => Promise<void> | void;
  /** The ids of reservations this device holds, kept across an app restart so the next start releases them. */
  readonly load: () => readonly string[] | Promise<readonly string[]>;
  readonly store: (reservationIds: readonly string[]) => void;
  /** A new Idempotency-Key for a reserve. */
  readonly newKey: () => string;
}

/** A reservation the send hands to the start, which finalizes it. */
export interface TakenOrbitReservation {
  readonly reservationId: string;
  readonly instanceId: number | null;
  readonly environmentId: string | null;
}

type Phase = "reserving" | "preparing" | "ready" | "gone";

interface Entry {
  readonly projectId: number;
  readonly openedAt: number;
  phase: Phase;
  reservation: OrbitGatewayReservation | null;
  /** The device saved the clone's server for this reservation. */
  paired: boolean;
  /** Closed or taken: the loop stops; a reservation still being admitted is released when it arrives. */
  ended: "closed" | "taken" | null;
}

export interface OrbitReservations {
  /** The prompt box of a new Instance in the Project opened: reserve a clone (once per Project). */
  readonly open: (projectId: number) => void;
  /** The prompt box closed without a send: release the Project's reservation. */
  readonly close: (projectId: number) => void;
  /**
   * The send: hands over the Project's reservation, or null when it is not there (not admitted
   * yet, failed, expired, released by Orbit). The start then creates as before.
   */
  readonly take: (projectId: number) => TakenOrbitReservation | null;
  /** Releases what an earlier run of the app left open. */
  readonly releaseLeftovers: () => Promise<void>;
  /** The servers of reserved clones, which no list shows. */
  readonly hiddenEnvironmentIds: () => ReadonlySet<string>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Releases every open reservation (app quit). */
  readonly closeAll: () => void;
}

const isOrbitGatewayError = Schema.is(OrbitGatewayError);

/** The reservation is no longer there for this caller. */
function isGone(error: unknown): boolean {
  return (
    isOrbitGatewayError(error) &&
    (error.status === 404 || error.status === 410 || error.code.startsWith("reservation."))
  );
}

/** States a send can still finalize. */
const USABLE_STATES: ReadonlySet<OrbitGatewayReservation["state"]> = new Set([
  "preparing",
  "ready",
]);

export function createOrbitReservations(ports: OrbitReservationPorts): OrbitReservations {
  const entries = new Map<number, Entry>();
  /** Released clones whose saved server is still being removed. */
  const releasing = new Set<string>();
  const listeners = new Set<() => void>();
  let hidden: ReadonlySet<string> = new Set();

  const changed = () => {
    const next = new Set<string>(releasing);
    for (const entry of entries.values()) {
      const environmentId = entry.reservation?.environmentId;
      if (environmentId) next.add(environmentId);
    }
    const persisted = [...entries.values()].flatMap((entry) =>
      entry.reservation === null ? [] : [entry.reservation.id],
    );
    ports.store(persisted);
    if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) return;
    hidden = next;
    for (const listener of listeners) listener();
  };

  const release = (reservation: OrbitGatewayReservation | null, paired: boolean) => {
    if (reservation === null) return;
    const environmentId = paired ? reservation.environmentId : null;
    if (environmentId) releasing.add(environmentId);
    void ports.client
      .releaseReservation(reservation.id)
      .catch(() => null)
      .then(async () => {
        if (environmentId) await ports.forget(environmentId);
      })
      .catch(() => {})
      .finally(() => {
        if (environmentId && releasing.delete(environmentId)) changed();
      });
  };

  const drop = (entry: Entry) => {
    if (entries.get(entry.projectId) === entry) entries.delete(entry.projectId);
    changed();
  };

  /** Pairs with a ready clone. A failure is left to the start, which pairs as before. */
  const pairOnce = async (entry: Entry, environmentId: string) => {
    if (entry.paired) return;
    if (ports.isSaved(environmentId)) {
      entry.paired = true;
      return;
    }
    try {
      const pairing = await ports.client.pair(environmentId);
      if (entry.ended !== null) {
        // Closed while pairing: the link stays unused and the release removes the clone.
        return;
      }
      await ports.connect(environmentId, pairing.pairingUrl);
      entry.paired = true;
    } catch {
      // Nothing on screen: the send pairs in the start's own step.
    }
  };

  const run = async (entry: Entry) => {
    let reservation: OrbitGatewayReservation;
    try {
      reservation = await ports.client.reserve(entry.projectId, ports.newKey());
    } catch {
      entry.phase = "gone";
      drop(entry);
      return;
    }
    if (entry.ended !== null) {
      // Closed, or the send went on without it, while Orbit admitted it.
      release(reservation, false);
      drop(entry);
      return;
    }
    entry.reservation = reservation;
    changed();
    for (;;) {
      const current = entry.reservation!;
      if (!USABLE_STATES.has(current.state)) {
        entry.phase = "gone";
        // A failed one may hold a clone; an expired one Orbit removes itself.
        if (current.state === "failed") release(current, entry.paired);
        drop(entry);
        return;
      }
      if (current.state === "ready" && current.environmentId !== null) {
        entry.phase = "ready";
        await pairOnce(entry, current.environmentId);
        if (entry.ended !== null) return;
      } else {
        entry.phase = "preparing";
      }
      await ports.sleep(
        entry.phase === "ready" ? RESERVATION_KEEPALIVE_MS : RESERVATION_PREPARING_POLL_MS,
      );
      if (entry.ended !== null) return;
      try {
        entry.reservation = await ports.client.reservation(current.id);
        changed();
      } catch (error) {
        if (isGone(error)) {
          entry.phase = "gone";
          if (entry.paired && current.environmentId) {
            // Orbit released it (a fourth reservation elsewhere): forget the saved server.
            releasing.add(current.environmentId);
            void Promise.resolve(ports.forget(current.environmentId))
              .catch(() => {})
              .finally(() => {
                releasing.delete(current.environmentId!);
                changed();
              });
          }
          drop(entry);
          return;
        }
        // A short Gateway outage: keep the last state and read again.
      }
    }
  };

  const close = (projectId: number) => {
    const entry = entries.get(projectId);
    if (entry === undefined || entry.ended !== null) return;
    entry.ended = "closed";
    release(entry.reservation, entry.paired);
    drop(entry);
  };

  return {
    open: (projectId) => {
      if (entries.has(projectId)) return;
      // Orbit would release the oldest for a fourth; release it here so Conn knows it is gone.
      const open = [...entries.values()].sort((a, b) => a.openedAt - b.openedAt);
      while (open.length >= MAX_OPEN_RESERVATIONS) close(open.shift()!.projectId);
      const entry: Entry = {
        projectId,
        openedAt: ports.now(),
        phase: "reserving",
        reservation: null,
        paired: false,
        ended: null,
      };
      entries.set(projectId, entry);
      void run(entry);
    },
    close,
    take: (projectId) => {
      const entry = entries.get(projectId);
      if (entry === undefined) return null;
      const reservation = entry.reservation;
      if (reservation === null || !USABLE_STATES.has(reservation.state)) {
        // Not admitted yet: the send creates as before, and the late reservation is released.
        entry.ended = "closed";
        release(reservation, entry.paired);
        drop(entry);
        return null;
      }
      entry.ended = "taken";
      // The start holds the id now and hides the clone's server until it is finalized
      // (`orbitThreadStartHiddenEnvironmentId`).
      if (entries.get(projectId) === entry) entries.delete(projectId);
      changed();
      return {
        reservationId: reservation.id,
        instanceId: reservation.instanceId,
        environmentId: reservation.environmentId,
      };
    },
    releaseLeftovers: async () => {
      const open = new Set(
        [...entries.values()].flatMap((entry) => (entry.reservation ? [entry.reservation.id] : [])),
      );
      const leftovers = (await ports.load()).filter((id) => !open.has(id));
      await Promise.all(
        leftovers.map((id) => ports.client.releaseReservation(id).catch(() => null)),
      );
      changed();
    },
    hiddenEnvironmentIds: () => hidden,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closeAll: () => {
      for (const projectId of Array.from(entries.keys())) close(projectId);
    },
  };
}
