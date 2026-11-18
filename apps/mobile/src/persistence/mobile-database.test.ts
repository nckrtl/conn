import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("mobile SQLite storage", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.gen(function* () {
      yield* Effect.promise(sqliteDatabase);
      const database = yield* MobileDatabase.make;
      yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
      yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
      expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
        Option.some('{"entries":[]}'),
      );
      yield* database.clearEnvironmentCache(environmentId);
      expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
        "None",
      );
      expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
        "Some",
      );
    }),
  );

  it.effect("keeps unresolved launch keys when rewriting the journal fails", () =>
    Effect.gen(function* () {
      const sqlite = yield* Effect.promise(sqliteDatabase);
      const database = yield* MobileDatabase.make;
      const pending = '[{"id":"other-unresolved-key"},{"id":"retry-key","validationRefused":true}]';
      const retrying = '[{"id":"other-unresolved-key"},{"id":"retry-key"}]';
      expect(yield* database.loadLaunchAdmissionsJson).toBeNull();
      yield* database.saveLaunchAdmissionsJson(pending);
      sqlite.exec(`CREATE TRIGGER interrupt_journal BEFORE UPDATE ON orbit_launch_admissions
                   BEGIN SELECT RAISE(ABORT, 'interrupted'); END;`);
      const interrupted = yield* Effect.result(database.saveLaunchAdmissionsJson(retrying));
      expect(interrupted).toMatchObject({
        _tag: "Failure",
        failure: { operation: "save-launch-admissions" },
      });
      expect(yield* database.loadLaunchAdmissionsJson).toBe(pending);
      sqlite.exec("DROP TRIGGER interrupt_journal");
      yield* database.clearAllCaches;
      expect(yield* database.loadLaunchAdmissionsJson).toBe(pending);
      yield* database.saveLaunchAdmissionsJson("[]");
      expect(yield* database.loadLaunchAdmissionsJson).toBe("[]");
    }),
  );
});
