import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  type ConnectionRegistration,
  ConnectionCredential,
  ConnectionProfile,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  type ConnectionTarget,
  PersistedConnectionTarget,
} from "../connection/model.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { StoredPullRequestRoutingPermission } from "../connection/pullRequestRoutingPermissions.ts";

export const StoredConnectionCredential = Schema.Struct({
  connectionId: Schema.String,
  credential: ConnectionCredential,
  provisionalPairingId: Schema.optionalKey(Schema.String),
});
export type StoredConnectionCredential = typeof StoredConnectionCredential.Type;

export const ConnectionCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(TokenStore.RemoteDpopAccessToken),
  // Pull request routing grants. The field name predates the rename and stays, so older and
  // newer clients sharing this document keep reading and revoking the same grants.
  githubRoutingPermissions: Schema.optionalKey(Schema.Array(StoredPullRequestRoutingPermission)),
  disabledEnvironmentIds: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ConnectionCatalogDocument = typeof ConnectionCatalogDocument.Type;

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

export function replaceCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  next: A,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function removeCatalogValue<A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
  removedKey: string,
): ReadonlyArray<A> {
  return values.filter((value) => key(value) !== removedKey);
}

function connectionIdOf(target: ConnectionTarget): string | null {
  switch (target._tag) {
    case "PrimaryConnectionTarget":
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
    case "SshConnectionTarget":
      return target.connectionId;
  }
}

/** The nonsecret identity written with a reservation's provisional route. */
export function provisionalPairingId(target: ConnectionTarget): string | undefined {
  return target._tag === "BearerConnectionTarget" ? target.provisionalPairingId : undefined;
}

function routeKey(target: ConnectionTarget): string {
  return connectionIdOf(target) ?? target._tag;
}

function removeRouteMetadata(
  document: ConnectionCatalogDocument,
  removed: ReadonlyArray<ConnectionTarget>,
): ConnectionCatalogDocument {
  const connectionIds = new Set(removed.flatMap((target) => connectionIdOf(target) ?? []));
  const droppedById = new Map(removed.map((target) => [connectionIdOf(target), target]));
  const relayRemoved = removed.some((target) => target._tag === "RelayConnectionTarget");
  const environmentIds = new Set(removed.map((target) => target.environmentId));
  return {
    ...document,
    profiles: document.profiles.filter((value) => !connectionIds.has(value.connectionId)),
    credentials: document.credentials.filter((value) => {
      const target = droppedById.get(value.connectionId);
      if (!target) return true;
      const provisional = provisionalPairingId(target);
      return provisional !== undefined && value.provisionalPairingId !== provisional;
    }),
    remoteDpopTokens: relayRemoved
      ? document.remoteDpopTokens.filter((value) => !environmentIds.has(value.environmentId))
      : document.remoteDpopTokens,
  };
}

export function catalogRoutes(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ReadonlyArray<PersistedConnectionTarget> {
  return document.targets.filter((target) => target.environmentId === environmentId);
}

/**
 * Records owned by a dropped route go with it; the environment keeps its
 * position in the catalog. An empty list leaves the environment's other records
 * in place; use `removeConnectionFromCatalog` to forget the environment.
 */
export function setRoutesInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<PersistedConnectionTarget>,
): ConnectionCatalogDocument {
  const kept = new Set(routes.map(routeKey));
  const dropped = catalogRoutes(document, environmentId).filter(
    (target) => !kept.has(routeKey(target)),
  );
  const firstIndex = document.targets.findIndex((target) => target.environmentId === environmentId);
  const others = document.targets.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : document.targets.slice(0, firstIndex).filter((t) => t.environmentId !== environmentId)
          .length;
  return {
    ...removeRouteMetadata(document, dropped),
    targets: [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)],
  };
}

export function registerConnectionInCatalog(
  document: ConnectionCatalogDocument,
  registration: ConnectionRegistration,
  routes: ReadonlyArray<PersistedConnectionTarget> = [registration.target],
): ConnectionCatalogDocument {
  const provisional = provisionalPairingId(registration.target);
  // Check at the durable write, even if the client's registry has an older snapshot.
  if (
    provisional !== undefined &&
    catalogRoutes(document, registration.target.environmentId).length > 0
  ) {
    return document;
  }
  const next = setRoutesInCatalog(document, registration.target.environmentId, routes);

  switch (registration._tag) {
    case "RelayConnectionRegistration":
      return next;
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        ...next,
        profiles: replaceCatalogValue(
          next.profiles,
          (value) => value.connectionId,
          registration.profile,
        ),
        credentials: replaceCatalogValue(next.credentials, (value) => value.connectionId, {
          connectionId: registration.target.connectionId,
          credential: registration.credential,
          ...(provisional === undefined ? {} : { provisionalPairingId: provisional }),
        }),
      };
  }
}

/**
 * The markers are the recovery journal. Each part is matched independently so a partial write or
 * a subsequent replacement cannot turn conditional cleanup into an environment-wide deletion.
 */
export function settleProvisionalPairingInCatalog(
  document: ConnectionCatalogDocument,
  installId: string,
  keep: boolean,
): ConnectionCatalogDocument {
  const owned = document.targets.filter((target) => provisionalPairingId(target) === installId);
  const ownedCredentials = document.credentials.some(
    (entry) => entry.provisionalPairingId === installId,
  );
  if (owned.length === 0 && !ownedCredentials) return document;

  if (keep) {
    return {
      ...document,
      targets: document.targets.map((target) => {
        if (target._tag !== "BearerConnectionTarget" || target.provisionalPairingId !== installId) {
          return target;
        }
        const { provisionalPairingId: _pending, ...committed } = target;
        return new BearerConnectionTarget(committed);
      }),
      credentials: document.credentials.map((entry) => {
        if (entry.provisionalPairingId !== installId) return entry;
        const { provisionalPairingId: _pending, ...committed } = entry;
        return committed;
      }),
    };
  }

  const targets = document.targets.filter((target) => provisionalPairingId(target) !== installId);
  const removedRoutes = new Set(owned.map(connectionIdOf));
  for (const target of targets) removedRoutes.delete(connectionIdOf(target));
  return {
    ...document,
    targets,
    profiles: document.profiles.filter((profile) => !removedRoutes.has(profile.connectionId)),
    credentials: document.credentials.filter((entry) => entry.provisionalPairingId !== installId),
  };
}

export function putConnectionCredentialInCatalog(
  document: ConnectionCatalogDocument,
  connectionId: string,
  credential: ConnectionCredential,
  expectedProvisionalPairingId?: string,
): ConnectionCatalogDocument {
  const target = document.targets.find((route) => connectionIdOf(route) === connectionId);
  // A refresh can complete after the reservation route and its credential were discarded.
  if (target === undefined && connectionId.startsWith("bearer:orbit-reservation:")) return document;
  const owner = target === undefined ? undefined : provisionalPairingId(target);
  if (owner !== expectedProvisionalPairingId) return document;
  const previous = document.credentials.find((entry) => entry.connectionId === connectionId);
  if (owner !== undefined && previous !== undefined && previous.provisionalPairingId !== owner) {
    return document;
  }
  return {
    ...document,
    credentials: replaceCatalogValue(document.credentials, (entry) => entry.connectionId, {
      connectionId,
      credential,
      ...(owner === undefined ? {} : { provisionalPairingId: owner }),
    }),
  };
}

function provisionalPairingsInCatalog(document: ConnectionCatalogDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const target of document.targets) {
    const id = provisionalPairingId(target);
    if (id !== undefined) ids.add(id);
  }
  for (const credential of document.credentials) {
    if (credential.provisionalPairingId !== undefined) ids.add(credential.provisionalPairingId);
  }
  return ids;
}

/** Replay only installs observed on startup, so a later retry cannot sweep a new install. */
export const recoverProvisionalPairings = Effect.fn("ConnectionCatalog.recoverProvisionalPairings")(
  function* <E>(store: {
    readonly read: Effect.Effect<ConnectionCatalogDocument, E>;
    readonly update: (
      transform: (document: ConnectionCatalogDocument) => ConnectionCatalogDocument,
    ) => Effect.Effect<void, E>;
  }) {
    const ids = provisionalPairingsInCatalog(yield* store.read);
    if (ids.size === 0) return;
    const remove = store.update((document) => {
      let next = document;
      for (const id of ids) next = settleProvisionalPairingInCatalog(next, id, false);
      return next;
    });
    yield* remove.pipe(
      Effect.catch(() =>
        Effect.forkScoped(
          remove.pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds") })),
        ).pipe(Effect.asVoid),
      ),
    );
  },
);

export function removeConnectionFromCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
): ConnectionCatalogDocument {
  const next = setRoutesInCatalog(document, environmentId, []);
  return {
    ...next,
    remoteDpopTokens: removeCatalogValue(
      next.remoteDpopTokens,
      (value) => value.environmentId,
      environmentId,
    ),
    disabledEnvironmentIds: removeCatalogValue(
      next.disabledEnvironmentIds,
      (value) => value,
      environmentId,
    ),
    ...(next.githubRoutingPermissions === undefined
      ? {}
      : {
          githubRoutingPermissions: next.githubRoutingPermissions.filter(
            (permission) => permission.environmentId !== environmentId,
          ),
        }),
  };
}

export function setConnectionEnabledInCatalog(
  document: ConnectionCatalogDocument,
  environmentId: EnvironmentId,
  enabled: boolean,
): ConnectionCatalogDocument {
  const registered = document.targets.some((target) => target.environmentId === environmentId);
  const without = removeCatalogValue(
    document.disabledEnvironmentIds,
    (value) => value,
    environmentId,
  );
  return {
    ...document,
    disabledEnvironmentIds: registered && !enabled ? [...without, environmentId] : without,
  };
}

export function putRemoteDpopTokenInCatalog(
  document: ConnectionCatalogDocument,
  token: TokenStore.RemoteDpopAccessToken,
): ConnectionCatalogDocument {
  const registered = document.targets.some(
    (target) =>
      target._tag === "RelayConnectionTarget" && target.environmentId === token.environmentId,
  );
  if (!registered) {
    return document;
  }
  return {
    ...document,
    remoteDpopTokens: replaceCatalogValue(
      document.remoteDpopTokens,
      (value) => value.environmentId,
      token,
    ),
  };
}
