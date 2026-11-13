import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayEnvironment } from "./client.ts";
import * as DateTime from "effect/DateTime";

import {
  ACCESS_PAIRING_RETRY_MS,
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  EXPIRED_RENEWAL_RETRY_MS,
  EXPIRING_RENEWAL_RETRY_MS,
  forgetOrbitEnvironment,
  forgetPairingRevoked,
  isPairingRevoked,
  PAIRING_RETRY_MS,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  recordPairingRevoked,
  recordRenewal,
  SESSION_RENEW_BEFORE_MS,
  sessionRenewalReason,
  type ManagedEnvironment,
  type OrbitEnvironmentState,
} from "./environmentProvider.ts";

const orbit = (
  id: string,
  status: OrbitGatewayEnvironment["status"] = "registered",
  instanceId: number | null = null,
) =>
  ({
    environmentId: id,
    label: id,
    url: `http://${id}`,
    serverVersion: null,
    registeredBy: null,
    registeredAt: "2026-11-09T14:48:58+00:00",
    status,
    instanceId,
    powerState: instanceId === null ? null : "running",
  }) as OrbitGatewayEnvironment;
const saved = (id: string, enabled = true): ManagedEnvironment => ({ environmentId: id, enabled });

/** Applies a plan to a saved list, the way a client does after pairing every requested server. */
function apply(list: ManagedEnvironment[], plan: ReturnType<typeof planEnvironmentProvider>) {
  let state = plan.state;
  const next = list.map((entry) =>
    plan.enable.includes(entry.environmentId)
      ? { ...entry, enabled: true }
      : plan.disable.includes(entry.environmentId)
        ? { ...entry, enabled: false }
        : entry,
  );
  for (const id of plan.pair) {
    next.push(saved(id));
    state = recordPaired(state, id);
  }
  return { list: next, state };
}

describe("planEnvironmentProvider", () => {
  it("turns default environments off and pairs the Orbit servers on a switch to Orbit", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("laptop"), saved("old", false), saved("beast")],
      orbit: [orbit("beast"), orbit("mini"), orbit("expired", "session_expired")],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
    });
    expect(plan.disable).toEqual(["laptop"]);
    expect(plan.enable).toEqual([]);
    expect(plan.pair).toEqual(["mini"]);
    // An environment the user had already switched off is not Orbit's to switch back on.
    expect(plan.state.disabledByOrbit).toEqual(["laptop"]);
  });

  it("leaves the server of an Instance that a thread start pairs with itself, and an asleep one", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [],
      orbit: [
        orbit("clone", "registered", 41),
        orbit("other-clone", "registered", 42),
        { ...orbit("asleep-clone", "registered", 43), powerState: "stopped" },
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      heldInstanceIds: [41],
      requestedEnvironmentIds: ["clone", "other-clone", "asleep-clone"],
    });
    // An asleep clone cannot mint a pairing link, so pairing it would only fail again on each run.
    expect(plan.pair).toEqual(["other-clone"]);
  });

  it("pairs a host server at once but a clone only when the user asks for it", () => {
    const input = {
      provider: "orbit" as const,
      saved: [saved("saved-clone")],
      orbit: [
        orbit("host"),
        orbit("clone", "registered", 41),
        orbit("requested-clone", "registered", 42),
        orbit("saved-clone", "registered", 43),
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      requestedEnvironmentIds: ["requested-clone"],
    };
    expect(planEnvironmentProvider(input).pair).toEqual(["host", "requested-clone"]);
    // A clone paired earlier still pairs again when its session cannot manage access.
    expect(planEnvironmentProvider({ ...input, lacksAccess: ["saved-clone"] }).pair).toEqual([
      "host",
      "requested-clone",
      "saved-clone",
    ]);
    // A clone this device started is paired by the start; the sync leaves it alone.
    expect(
      planEnvironmentProvider({
        ...input,
        heldInstanceIds: [42],
      }).pair,
    ).toEqual(["host"]);
  });

  it("changes nothing in Orbit mode while the Gateway cannot be read", () => {
    const state: OrbitEnvironmentState = { disabledByOrbit: ["laptop"], pairedByOrbit: ["mini"] };
    expect(
      planEnvironmentProvider({
        provider: "orbit",
        saved: [saved("laptop", false)],
        orbit: null,
        state,
      }),
    ).toEqual({ enable: [], disable: [], pair: [], renew: [], state });
  });

  it("restores exactly the earlier list on each switch, back and forth", () => {
    const servers = [orbit("beast"), orbit("mini")];
    let list = [saved("laptop"), saved("tunnel"), saved("old", false)];
    let state = EMPTY_ORBIT_ENVIRONMENT_STATE;

    ({ list, state } = apply(
      list,
      planEnvironmentProvider({ provider: "orbit", saved: list, orbit: servers, state }),
    ));
    expect(list.filter((entry) => entry.enabled).map((entry) => entry.environmentId)).toEqual([
      "beast",
      "mini",
    ]);

    ({ list, state } = apply(
      list,
      planEnvironmentProvider({ provider: "default", saved: list, orbit: servers, state }),
    ));
    expect(list.filter((entry) => entry.enabled).map((entry) => entry.environmentId)).toEqual([
      "laptop",
      "tunnel",
    ]);

    ({ list, state } = apply(
      list,
      planEnvironmentProvider({ provider: "orbit", saved: list, orbit: servers, state }),
    ));
    expect(list.filter((entry) => entry.enabled).map((entry) => entry.environmentId)).toEqual([
      "beast",
      "mini",
    ]);
    expect(list).toHaveLength(5);
  });

  it("keeps a server that left the Gateway as Orbit's, so Default does not turn it on", () => {
    const state: OrbitEnvironmentState = { disabledByOrbit: [], pairedByOrbit: ["gone"] };
    const orbitPlan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("gone")],
      orbit: [],
      state,
    });
    expect(orbitPlan.disable).toEqual(["gone"]);
    expect(orbitPlan.state.disabledByOrbit).toEqual([]);
    const defaultPlan = planEnvironmentProvider({
      provider: "default",
      saved: [saved("gone", false)],
      orbit: [],
      state: orbitPlan.state,
    });
    expect(defaultPlan.enable).toEqual([]);
  });

  it("leaves an environment that is both saved by hand and on the Gateway enabled", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("nick")],
      orbit: [orbit("nick")],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
    });
    expect(plan).toMatchObject({ enable: [], disable: [], pair: [] });
  });

  it("pairs a saved server again when its session cannot manage access, at most every few hours", () => {
    const now = 1_000_000_000;
    const input = {
      provider: "orbit" as const,
      saved: [saved("mini"), saved("beast")],
      orbit: [orbit("mini"), orbit("beast")],
      lacksAccess: ["mini"],
      now,
    };
    const first = planEnvironmentProvider({ ...input, state: EMPTY_ORBIT_ENVIRONMENT_STATE });
    expect(first.pair).toEqual(["mini"]);

    const tried = recordAccessPairing(first.state, "mini", now);
    expect(planEnvironmentProvider({ ...input, state: tried }).pair).toEqual([]);
    expect(
      planEnvironmentProvider({ ...input, state: tried, now: now + ACCESS_PAIRING_RETRY_MS }).pair,
    ).toEqual(["mini"]);
  });

  it("waits before pairing a new server again after an attempt that did not save it", () => {
    const now = 1_000_000_000;
    const input = { provider: "orbit" as const, saved: [], orbit: [orbit("spike")], now };
    const first = planEnvironmentProvider({ ...input, state: EMPTY_ORBIT_ENVIRONMENT_STATE });
    expect(first.pair).toEqual(["spike"]);

    const tried = recordPairingAttempt(first.state, "spike", now);
    expect(planEnvironmentProvider({ ...input, state: tried, now: now + 15_000 }).pair).toEqual([]);
    expect(
      planEnvironmentProvider({ ...input, state: tried, now: now + PAIRING_RETRY_MS }).pair,
    ).toEqual(["spike"]);
  });

  it("keeps pairing attempt times across a reload", () => {
    const state = recordPairingAttempt(EMPTY_ORBIT_ENVIRONMENT_STATE, "spike", 42);
    expect(parseOrbitEnvironmentState(JSON.parse(JSON.stringify(state))).pairAttemptedAt).toEqual({
      spike: 42,
    });
    expect(parseOrbitEnvironmentState({ pairAttemptedAt: { spike: "x" } }).pairAttemptedAt).toEqual(
      {},
    );
  });

  it("pairs a server T3 refused only after it registers again", () => {
    const now = 1_000_000_000;
    const input = { provider: "orbit" as const, saved: [], now: now + PAIRING_RETRY_MS };
    const refused = recordPairingRefused(
      recordPairingAttempt(EMPTY_ORBIT_ENVIRONMENT_STATE, "spike", now),
      orbit("spike"),
    );
    expect(
      planEnvironmentProvider({ ...input, orbit: [orbit("spike")], state: refused }).pair,
    ).toEqual([]);
    const registeredAgain = { ...orbit("spike"), registeredAt: "2026-11-10T08:00:00+00:00" };
    expect(
      planEnvironmentProvider({ ...input, orbit: [registeredAgain], state: refused }).pair,
    ).toEqual(["spike"]);
  });

  it("keeps the pairing backoff across a switch to Default and back", () => {
    const tried = recordPairingAttempt(EMPTY_ORBIT_ENVIRONMENT_STATE, "spike", 42);
    const toDefault = planEnvironmentProvider({
      provider: "default",
      saved: [],
      orbit: null,
      state: tried,
    });
    expect(toDefault.state.pairAttemptedAt).toEqual({ spike: 42 });
  });

  it("forgets a destroyed Instance's server everywhere and keeps the others' records", () => {
    const both = (state: OrbitEnvironmentState, id: string) =>
      recordPairingRefused(
        recordPairingAttempt(recordAccessPairing(recordPaired(state, id), id, 1), id, 2),
        { environmentId: id, registeredAt: "2026-11-12T08:00:00+00:00" },
      );
    const state = both(
      both({ ...EMPTY_ORBIT_ENVIRONMENT_STATE, disabledByOrbit: ["gone"] }, "gone"),
      "kept",
    );
    const forgotten = forgetOrbitEnvironment(state, "gone");
    expect(JSON.stringify(forgotten)).not.toContain("gone");
    expect(forgotten).toEqual({
      disabledByOrbit: [],
      pairedByOrbit: ["kept"],
      accessPairedAt: { kept: 1 },
      pairAttemptedAt: { kept: 2 },
      pairRefusedAt: { kept: "2026-11-12T08:00:00+00:00" },
    });
  });

  it("forgets a destroyed Instance's renewal and revoke records too", () => {
    const state = recordPairingRevoked(
      recordRenewal(recordPaired(EMPTY_ORBIT_ENVIRONMENT_STATE, "gone"), "gone", 1),
      "gone",
      2,
    );
    expect(JSON.stringify(forgetOrbitEnvironment(state, "gone"))).not.toContain("gone");
  });
});

describe("session renewal", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const at = (ms: number) => DateTime.makeUnsafe(ms);

  describe("sessionRenewalReason", () => {
    it("renews a session that ends within seven days, or has ended", () => {
      const reason = (session: Parameters<typeof sessionRenewalReason>[0]["session"]) =>
        sessionRenewalReason({ authenticationRefused: false, session, now });
      expect(reason({ authenticated: true, expiresAt: at(now + 30 * day) })).toBeNull();
      expect(reason({ authenticated: true, expiresAt: at(now + SESSION_RENEW_BEFORE_MS) })).toBe(
        null,
      );
      expect(reason({ authenticated: true, expiresAt: at(now + 6 * day) })).toBe("expiring");
      expect(reason({ authenticated: true, expiresAt: at(now - 1) })).toBe("expired");
      expect(reason({ authenticated: false })).toBe("expired");
      // A session without an end (a cookie session) or not read yet needs nothing.
      expect(reason({ authenticated: true })).toBeNull();
      expect(reason(null)).toBeNull();
    });

    it("counts a connection blocked on its credential as an ended session", () => {
      expect(sessionRenewalReason({ authenticationRefused: true, session: null, now })).toBe(
        "expired",
      );
    });
  });

  const input = (state: OrbitEnvironmentState, extra: Record<string, unknown> = {}) => ({
    provider: "orbit" as const,
    saved: [saved("beast"), saved("mini"), saved("shark"), saved("nick")],
    orbit: [orbit("beast"), orbit("mini"), orbit("shark"), orbit("nick")],
    state,
    renew: [
      { environmentId: "beast", reason: "expired" as const },
      { environmentId: "mini", reason: "expired" as const },
      { environmentId: "shark", reason: "expiring" as const },
    ],
    now,
    ...extra,
  });

  it("renews every saved server whose session ends soon or has ended, in one plan", () => {
    const plan = planEnvironmentProvider(input(EMPTY_ORBIT_ENVIRONMENT_STATE));
    expect(plan.pair).toEqual(["beast", "mini", "shark"]);
    expect(plan.renew).toEqual(["beast", "mini", "shark"]);
  });

  it("backs off 5 minutes after renewing an ended session, 6 hours for one that ends soon", () => {
    let state = EMPTY_ORBIT_ENVIRONMENT_STATE;
    for (const id of ["beast", "mini", "shark"]) state = recordRenewal(state, id, now);
    expect(planEnvironmentProvider(input(state, { now: now + 60_000 })).pair).toEqual([]);
    expect(
      planEnvironmentProvider(input(state, { now: now + EXPIRED_RENEWAL_RETRY_MS })).renew,
    ).toEqual(["beast", "mini"]);
    expect(
      planEnvironmentProvider(input(state, { now: now + EXPIRING_RENEWAL_RETRY_MS })).renew,
    ).toEqual(["beast", "mini", "shark"]);
  });

  it("never renews a server whose pairing Orbit revoked, until an explicit Connect", () => {
    const revoked = recordPairingRevoked(EMPTY_ORBIT_ENVIRONMENT_STATE, "beast", now);
    expect(isPairingRevoked(revoked, "beast")).toBe(true);
    const later = input(revoked, { now: now + 365 * day });
    expect(planEnvironmentProvider(later).renew).toEqual(["mini", "shark"]);
    // Nor does the access re-pair bring it back.
    expect(planEnvironmentProvider({ ...later, renew: [], lacksAccess: ["beast"] }).pair).toEqual(
      [],
    );
    const connected = forgetPairingRevoked(revoked, "beast");
    expect(isPairingRevoked(connected, "beast")).toBe(false);
    expect(planEnvironmentProvider(input(connected)).renew).toEqual(["beast", "mini", "shark"]);
  });

  it("keeps the revoked state across a reload and a switch to Default", () => {
    const revoked = recordRenewal(
      recordPairingRevoked(EMPTY_ORBIT_ENVIRONMENT_STATE, "beast", 7),
      "mini",
      9,
    );
    const reloaded = parseOrbitEnvironmentState(JSON.parse(JSON.stringify(revoked)));
    expect(reloaded.revokedAt).toEqual({ beast: 7 });
    expect(reloaded.renewedAt).toEqual({ mini: 9 });
    const toDefault = planEnvironmentProvider({
      provider: "default",
      saved: [],
      orbit: null,
      state: reloaded,
    });
    expect(isPairingRevoked(toDefault.state, "beast")).toBe(true);
  });

  it("never renews a removed Instance's server, and waits for a stopped one", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("removed-clone"), saved("asleep-clone"), saved("expired-admin")],
      // A removed Instance's server has left the Gateway's list.
      orbit: [
        { ...orbit("asleep-clone", "registered", 43), powerState: "stopped" },
        orbit("expired-admin", "session_expired", 44),
      ],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      renew: ["removed-clone", "asleep-clone", "expired-admin"].map((environmentId) => ({
        environmentId,
        reason: "expired" as const,
      })),
      now,
    });
    expect(plan.pair).toEqual([]);
    expect(plan.disable).toEqual(["removed-clone"]);
  });

  it("renews a server T3 refused for good only after it registers again", () => {
    const refused = recordPairingRefused(
      recordRenewal(EMPTY_ORBIT_ENVIRONMENT_STATE, "beast", now),
      orbit("beast"),
    );
    const later = input(refused, { now: now + day });
    expect(planEnvironmentProvider(later).renew).toEqual(["mini", "shark"]);
    const registeredAgain = { ...orbit("beast"), registeredAt: "2026-11-13T08:00:00+00:00" };
    expect(
      planEnvironmentProvider({
        ...later,
        orbit: [registeredAgain, orbit("mini"), orbit("shark")],
      }).renew,
    ).toEqual(["beast", "mini", "shark"]);
  });

  it("leaves the clone a thread start pairs itself", () => {
    const plan = planEnvironmentProvider({
      provider: "orbit",
      saved: [saved("clone")],
      orbit: [orbit("clone", "registered", 41)],
      state: EMPTY_ORBIT_ENVIRONMENT_STATE,
      renew: [{ environmentId: "clone", reason: "expired" }],
      heldInstanceIds: [41],
      now,
    });
    expect(plan.pair).toEqual([]);
  });
});
