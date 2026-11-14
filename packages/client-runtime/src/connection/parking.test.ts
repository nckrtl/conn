import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  ATTACHED_SERVERS_DEFAULT,
  type ActivityReportRegistry,
  type StoredAttachedServers,
  activityReportTargets,
  attachedServersEnabled,
  attachedServersParkSeed,
  notAttachedEnvironmentIds,
  parseStoredAttachedServers,
  planAttachedServers,
} from "./parking.ts";

const record = (overrides: Partial<StoredAttachedServers> = {}): StoredAttachedServers => ({
  schema: 1,
  profileId: 2,
  profileVersion: 7,
  version: 3,
  attached: ["inner-a"],
  containers: ["inner-a", "inner-b", "inner-c"],
  ...overrides,
});

describe("connAttachedServers flag", () => {
  it("is off by default and on only when stored as on", () => {
    expect(ATTACHED_SERVERS_DEFAULT).toBe(false);
    expect(attachedServersEnabled(null)).toBe(false);
    expect(attachedServersEnabled(undefined)).toBe(false);
    expect(attachedServersEnabled("true")).toBe(false);
    expect(attachedServersEnabled("off")).toBe(false);
    expect(attachedServersEnabled("on")).toBe(true);
  });
});

describe("attached set", () => {
  it("holds off every known container server no attached thread lives on", () => {
    expect(notAttachedEnvironmentIds(record())).toEqual(new Set(["inner-b", "inner-c"]));
  });

  it("holds nothing off for a section never written (version 0) or nothing stored", () => {
    expect(notAttachedEnvironmentIds(null)).toEqual(new Set());
    expect(notAttachedEnvironmentIds(record({ version: 0, attached: [] }))).toEqual(new Set());
  });

  it("applies a written empty set: every container server is held off", () => {
    expect(notAttachedEnvironmentIds(record({ attached: [] }))).toEqual(
      new Set(["inner-a", "inner-b", "inner-c"]),
    );
  });

  it("seeds the registry only with the flag on", () => {
    expect(attachedServersParkSeed(false, record()).size).toBe(0);
    const seed = attachedServersParkSeed(true, record());
    expect([...seed.keys()].toSorted()).toEqual(["inner-b", "inner-c"]);
    expect(seed.get(EnvironmentId.make("inner-b"))).toEqual(new Set(["not-attached"]));
  });

  it("plans only the changes: hold the new ones, release the attached ones", () => {
    expect(
      planAttachedServers({
        enabled: true,
        stored: record(),
        current: new Set(["inner-a", "inner-b"]),
      }),
    ).toEqual({ hold: ["inner-c"], release: ["inner-a"] });
    // Flag off: nothing is held, anything held is released.
    expect(
      planAttachedServers({ enabled: false, stored: record(), current: new Set(["inner-b"]) }),
    ).toEqual({ hold: [], release: ["inner-b"] });
  });

  it("reads back only a valid stored record", () => {
    expect(parseStoredAttachedServers(JSON.parse(JSON.stringify(record())))).toEqual(record());
    expect(parseStoredAttachedServers({ ...record(), schema: 2 })).toBeNull();
    expect(parseStoredAttachedServers({ ...record(), attached: [1] })).toBeNull();
    expect(parseStoredAttachedServers("x")).toBeNull();
  });
});

describe("activityReportTargets", () => {
  const registryWith = Effect.fn(function* (connected: ReadonlySet<EnvironmentId> | null) {
    const entry = {} as ConnectionCatalogEntry;
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [EnvironmentId.make("outer"), entry],
        [EnvironmentId.make("inner-a"), entry],
        [EnvironmentId.make("inner-b"), entry],
      ]),
    );
    return {
      entries,
      // Null: the flag-off path must not ask which servers are connected.
      connectedEnvironmentIds:
        connected === null
          ? Effect.die(new Error("flag off must report to every saved server"))
          : Effect.succeed(connected),
    } satisfies ActivityReportRegistry;
  });

  it.effect("flag off: every saved server, connected or not (today's calls)", () =>
    Effect.gen(function* () {
      const registry = yield* registryWith(null);
      expect(yield* activityReportTargets(registry, false)).toEqual([
        "outer",
        "inner-a",
        "inner-b",
      ]);
    }),
  );

  it.effect("flag on: only connected servers", () =>
    Effect.gen(function* () {
      const registry = yield* registryWith(
        new Set([EnvironmentId.make("outer"), EnvironmentId.make("inner-a")]),
      );
      expect(yield* activityReportTargets(registry, true)).toEqual(["outer", "inner-a"]);
    }),
  );
});
