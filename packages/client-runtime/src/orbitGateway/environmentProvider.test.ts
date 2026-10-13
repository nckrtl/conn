import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayEnvironment } from "./client.ts";
import {
  ACCESS_PAIRING_RETRY_MS,
  EMPTY_ORBIT_ENVIRONMENT_STATE,
  planEnvironmentProvider,
  recordAccessPairing,
  recordPaired,
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
});
