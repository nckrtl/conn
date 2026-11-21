import { catalogWithoutEnvironments } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "./catalog";

/** Conn: the servers of reserved Orbit clones (`orbit/orbitReservations.ts`), which no list shows. */
export const reservedEnvironmentIdsAtom = Atom.make<ReadonlyArray<string>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("orbit-reserved-environment-ids"),
);

/** The catalog the lists read: projects, threads and the environment settings. */
export const visibleCatalogValueAtom = catalogWithoutEnvironments(
  environmentCatalog.catalogValueAtom,
  reservedEnvironmentIdsAtom,
);
