import { describe, expect, it, vi } from "vite-plus/test";

import { loadOrbitInstanceList, useOrbitInstanceListStore } from "./orbitInstanceList";

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./OrbitProfileSync", () => ({ desktopOrbitGatewayClient: () => mocks.client }));

const record = (instanceId: number, instanceName: string) => ({
  environmentId: `env-${instanceName}`,
  label: instanceName,
  url: "http://x",
  serverVersion: null,
  registeredBy: null,
  registeredAt: null,
  status: "registered" as const,
  instanceId,
  powerState: "running" as const,
  projectId: 5,
  projectName: "nckrtl",
  projectSlug: "nckrtl",
  instanceName,
  nodeName: "beast",
  instanceUrl: null,
});

describe("loadOrbitInstanceList", () => {
  it("keeps the newest read when an older one answers last, and the last good list on refresh", async () => {
    useOrbitInstanceListStore.setState({ state: { status: "loading" }, generation: 0 });
    const answers: Array<(value: unknown[]) => void> = [];
    mocks.client = {
      environments: () => new Promise((resolve) => answers.push(resolve)),
      projects: async () => [],
    };
    const first = loadOrbitInstanceList();
    const second = loadOrbitInstanceList();
    answers[1]!([record(2, "newer")]);
    await second;
    answers[0]!([record(1, "older")]);
    await first;
    const names = () => {
      const { state } = useOrbitInstanceListStore.getState();
      return state.status === "loaded" ? state.rows.map((row) => row.name) : state.status;
    };
    expect(names()).toEqual(["newer"]);

    const refresh = loadOrbitInstanceList();
    expect(names()).toEqual(["newer"]);
    answers[2]!([]);
    await refresh;
    expect(names()).toEqual([]);
  });
});
