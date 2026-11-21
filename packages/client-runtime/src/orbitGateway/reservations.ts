import * as Schema from "effect/Schema";

import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayPairing,
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
  /** Keeps a server hidden for its saved start. False if the start was dismissed. */
  readonly hideForTakenStart?: (reservationId: string, environmentId: string) => boolean;
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

type ReservationDetails = Omit<OrbitGatewayReservation, "pairing">;

interface Entry {
  readonly projectId: number;
  readonly openedAt: number;
  reservation: ReservationDetails | null;
  pending: Promise<void> | null;
  /** The device saved the clone's server for this reservation. */
  paired: boolean;
  /** A pairing runs: a close keeps the server hidden, and the pairing forgets it once saved. */
  connecting: boolean;
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
  /** Finishes a read or install already in flight when the start took the reservation. */
  readonly waitForPairing: (reservationId: string) => Promise<void> | undefined;
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
  const handedOff = new Map<string, Promise<void>>();
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

  const release = (reservation: ReservationDetails | null, paired: boolean) => {
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

  const pairOnce = async (
    entry: Entry,
    reservationId: string,
    environmentId: string,
    issued: OrbitGatewayPairing | null,
  ) => {
    const closed = () => entry.ended === "closed";
    if (entry.paired || closed() || (entry.ended === "taken" && issued === null)) return;
    if (ports.isSaved(environmentId)) {
      entry.paired = true;
      return;
    }
    entry.connecting = true;
    let saved = false;
    try {
      if (
        entry.ended === "taken" &&
        ports.hideForTakenStart?.(reservationId, environmentId) === false
      ) {
        return;
      }
      const pairing = issued ?? (await ports.client.pair(environmentId));
      if (!closed()) {
        await ports.connect(environmentId, pairing.pairingUrl);
        saved = true;
      }
    } catch {
      // The start can pair explicitly if this install fails.
    } finally {
      entry.connecting = false;
    }
    if (closed()) {
      if (saved || ports.isSaved(environmentId)) {
        await Promise.resolve(ports.forget(environmentId)).catch(() => {});
      }
      if (releasing.delete(environmentId)) changed();
      return;
    }
    if (saved) entry.paired = true;
  };

  const forgetReleased = (environmentId: string) => {
    releasing.add(environmentId);
    void Promise.resolve(ports.forget(environmentId))
      .catch(() => {})
      .finally(() => {
        releasing.delete(environmentId);
        changed();
      });
  };

  const refresh = async (entry: Entry, current: ReservationDetails) => {
    let response: OrbitGatewayReservation;
    try {
      response = await ports.client.reservation(current.id);
    } catch (error) {
      if (entry.ended === null && isGone(error)) {
        if (entry.paired && current.environmentId) forgetReleased(current.environmentId);
        drop(entry);
      }
      return;
    }
    if (
      entry.ended === "closed" ||
      response.id !== current.id ||
      response.projectId !== entry.projectId
    ) {
      return;
    }
    const { pairing, ...details } = response;
    if (!USABLE_STATES.has(details.state)) {
      if (entry.ended !== null) return;
      if (details.state === "failed") release(current, entry.paired);
      if ((details.state === "expired" || details.state === "released") && entry.paired) {
        if (current.environmentId) forgetReleased(current.environmentId);
      }
      drop(entry);
      return;
    }
    entry.reservation = details;
    if (entry.ended === null) changed();
    if (details.state === "ready" && details.environmentId !== null) {
      await pairOnce(entry, details.id, details.environmentId, pairing);
    }
  };

  const run = async (entry: Entry) => {
    let reservation: ReservationDetails;
    try {
      reservation = await ports.client.reserve(entry.projectId, ports.newKey());
    } catch {
      drop(entry);
      return;
    }
    if (reservation.projectId !== entry.projectId) {
      drop(entry);
      return;
    }
    if (entry.ended !== null) {
      release(reservation, false);
      drop(entry);
      return;
    }
    if (!USABLE_STATES.has(reservation.state)) {
      if (reservation.state === "failed") release(reservation, false);
      drop(entry);
      return;
    }
    entry.reservation = reservation;
    changed();
    // An already-ready POST still needs its first GET before pairing.
    let readNow = reservation.state === "ready";
    while (entries.get(entry.projectId) === entry) {
      const current = entry.reservation;
      if (!readNow) {
        const ready = current.state === "ready" && current.environmentId !== null;
        await ports.sleep(ready ? RESERVATION_KEEPALIVE_MS : RESERVATION_PREPARING_POLL_MS);
      }
      if (entry.ended !== null) return;
      readNow = false;
      const pending = refresh(entry, current);
      entry.pending = pending;
      await pending;
      entry.pending = null;
    }
  };

  const close = (projectId: number) => {
    const entry = entries.get(projectId);
    if (entry === undefined || entry.ended !== null) return;
    entry.ended = "closed";
    const environmentId = entry.reservation?.environmentId;
    // The pairing that runs forgets the server itself once it is saved.
    if (entry.connecting && environmentId) releasing.add(environmentId);
    release(entry.reservation, entry.paired && !entry.connecting);
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
        reservation: null,
        pending: null,
        paired: false,
        connecting: false,
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
      if (entry.pending !== null) {
        const pending = entry.pending;
        handedOff.set(reservation.id, pending);
        const clear = () => {
          if (handedOff.get(reservation.id) === pending) handedOff.delete(reservation.id);
        };
        void pending.then(clear, clear);
      }
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
    waitForPairing: (reservationId) => handedOff.get(reservationId),
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
