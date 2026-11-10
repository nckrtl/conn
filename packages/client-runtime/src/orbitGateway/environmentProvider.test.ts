import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayEnvironment } from "./client.ts";
import {
  ACCESS_PAIRING_RETRY_MS,
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  PAIRING_RETRY_MS,
  parseOrbitEnvironmentState,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
  recordPairingAttempt,
  recordPairingRefused,
  type ManagedEnvironment,
  type OrbitEnvironmentState,
} from "./environmentProvider.ts";

const orbit = (id: string, status: OrbitGatewayEnvironment["status"] = "registered") =>
  ({
    environmentId: id,
    label: id,
    url: `http://${id}`,
    serverVersion: null,
    registeredBy: null,
    registeredAt: "2026-11-09T14:48:58+00:00",
    status,
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

  it("changes nothing in Orbit mode while the Gateway cannot be read", () => {
    const state: OrbitEnvironmentState = { disabledByOrbit: ["laptop"], pairedByOrbit: ["mini"] };
    expect(
      planEnvironmentProvider({
        provider: "orbit",
        saved: [saved("laptop", false)],
        orbit: null,
        state,
      }),
    ).toEqual({ enable: [], disable: [], pair: [], state });
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
});
