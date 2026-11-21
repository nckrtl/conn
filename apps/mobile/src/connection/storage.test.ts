import {
  BearerConnectionCredential,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  recoverProvisionalPairings,
  settleProvisionalPairingInCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replays an abandoned install after a failed secure-storage commit and restart", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("clone");
      const target = new BearerConnectionTarget({
        environmentId,
        label: "provisional",
        connectionId: "route",
        provisionalPairingId: "install",
      });
      const credential = new BearerConnectionCredential({ token: "stored-session" });
      const pending = {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        targets: [target],
        credentials: [{ connectionId: "route", credential, provisionalPairingId: "install" }],
      };
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: encodeCatalog(pending) });
      const failingStore = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        setItem: (key) =>
          Effect.fail(
            new MobileSecureStorage.MobileSecureStorageError({
              operation: "write",
              key,
              cause: new Error("secure-storage write interrupted"),
            }),
          ),
      });
      const old = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, failingStore),
      );
      yield* old
        .update((doc) => settleProvisionalPairingInCatalog(doc, "install", false))
        .pipe(Effect.flip);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(encodeCatalog(pending));

      const restarted = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      yield* recoverProvisionalPairings(restarted);
      expect(yield* restarted.read).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
      yield* recoverProvisionalPairings(restarted);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(
        encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT),
      );
    }),
  );

  it.effect(
    "keeps a promoted pairing across restart and ignores replay of the old install id",
    () =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("clone");
        const target = new BearerConnectionTarget({
          environmentId,
          label: "clone",
          connectionId: "route",
          provisionalPairingId: "install",
        });
        const credential = new BearerConnectionCredential({ token: "stored-session" });
        const memory = makeStorage({});
        const open = () =>
          make().pipe(
            Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
          );
        const store = yield* open();
        yield* store.update((doc) => ({
          ...doc,
          targets: [target],
          credentials: [{ connectionId: "route", credential, provisionalPairingId: "install" }],
        }));
        yield* store.update((doc) => settleProvisionalPairingInCatalog(doc, "install", true));

        const restarted = yield* open();
        yield* recoverProvisionalPairings(restarted);
        yield* restarted.update((doc) => settleProvisionalPairingInCatalog(doc, "install", false));
        const saved = yield* restarted.read;
        expect(saved.targets).toEqual([
          new BearerConnectionTarget({
            environmentId,
            label: "clone",
            connectionId: "route",
          }),
        ]);
        expect(saved.credentials).toEqual([{ connectionId: "route", credential }]);
      }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
