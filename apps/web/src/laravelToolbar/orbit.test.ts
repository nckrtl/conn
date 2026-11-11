import { describe, expect, it } from "vite-plus/test";

import type { OrbitHttpRequest, OrbitHttpResponse } from "~/orbit/orbitTransport";

import {
  gatewayOrbitSource,
  parseDependencies,
  parseLogLines,
  parseProcess,
  processStatus,
  splitLogLevels,
} from "./orbit";

describe("laravel toolbar orbit", () => {
  it("maps systemd and Docker states, and the Gateway status when the runtime is unobserved", () => {
    const status = (
      runtime_status: string | undefined,
      desired_state: string,
      extra: Record<string, unknown> = {},
    ) => processStatus({ runtime_status, desired_state, ...extra });
    expect(status("active", "running")).toBe("running");
    expect(status("running", "running")).toBe("running");
    expect(status("activating", "running")).toBe("starting");
    expect(status("inactive", "running")).toBe("crashed");
    expect(status("failed", "stopped")).toBe("crashed");
    expect(status("inactive", "stopped")).toBe("stopped");
    expect(status("exited", "stopped")).toBe("stopped");
    expect(status("unknown", "running", { status: "active" })).toBe("running");
    expect(status(undefined, "running", { status: "active" })).toBe("running");
    expect(status("unknown", "running")).toBe("unknown");
    expect(status("", "running", { status: null })).toBe("unknown");
    expect(status("unknown", "stopped")).toBe("stopped");
    expect(status("unknown", "running", { status: "failed" })).toBe("crashed");
    expect(status("unknown", "running", { error_code: "process.start_failed" })).toBe("crashed");
    expect(status("unknown", "running", { failed_step: "start" })).toBe("crashed");
    expect(processStatus(null)).toBe("stopped");
  });

  it("reads a process from the Gateway's process list", () => {
    expect(
      parseProcess({
        id: 7,
        name: "vite",
        runtime_config: { command: ["vp", "run", "dev"] },
        desired_state: "running",
        runtime_status: "active",
        cpu: 1.5,
        memory_bytes: 1024,
      }),
    ).toEqual({
      id: 7,
      name: "vite",
      command: "vp run dev",
      status: "running",
      cpu: 1.5,
      memoryBytes: 1024,
    });
    expect(
      parseProcess({ id: 9, name: "db", runtime_config: { image: "mysql:8.4" } })?.command,
    ).toBe("mysql:8.4");
    // A container Instance: the Gateway cannot observe the runtime yet.
    expect(
      parseProcess({
        id: 12,
        name: "vp-dev",
        runtime: "systemd",
        runtime_config: { command: ["vp", "dev"] },
        desired_state: "running",
        status: "active",
        runtime_status: "unknown",
        error_code: null,
        failed_step: null,
        cpu: 0.4,
        memory_bytes: 2048,
      })?.status,
    ).toBe("running");
    expect(parseProcess({ name: "no id" })).toBeNull();
  });

  it("strips the journal prefix from log lines", () => {
    const lines = parseLogLines(
      "2026-10-02T07:24:48+00:00 beast pi-server[3099520]: listening on 3774\nplain container line\n",
    );
    expect(lines.map((line) => line.text)).toEqual(["listening on 3774", "plain container line"]);
    expect(lines[0]?.time).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(lines[1]?.time).toBeNull();
    expect(parseLogLines("-- No entries --\n")).toEqual([]);
  });

  it("cuts level words out of a log line", () => {
    expect(splitLogLevels("worker ERROR failed job")).toEqual([
      { offset: 0, text: "worker ", level: null },
      { offset: 7, text: "ERROR", level: "ERROR" },
      { offset: 12, text: " failed job", level: null },
    ]);
  });

  it("resolves the page's Instance once and hides for domains Orbit does not serve", async () => {
    const requests: OrbitHttpRequest[] = [];
    const transport = async (request: OrbitHttpRequest): Promise<OrbitHttpResponse> => {
      requests.push(request);
      if (request.path === "/api/v1/instances/resolve") {
        return request.query?.domain === "dlf.test"
          ? { status: 200, body: { data: { instance_id: 27, node_id: 9 } } }
          : { status: 404, body: { error: { code: "dependencies.target_not_found" } } };
      }
      if (request.path === "/api/v1/nodes") {
        return { status: 200, body: { data: [{ id: 9, name: "beast" }] } };
      }
      return { status: 500, body: null };
    };

    const source = gatewayOrbitSource(transport, "dlf.test");
    expect(await source.page()).toEqual({ domain: "dlf.test", instanceId: 27, nodeName: "beast" });
    await source.page();
    expect(requests.filter((request) => request.path.endsWith("/resolve"))).toHaveLength(1);

    expect(await gatewayOrbitSource(transport, "example.com").page()).toBeNull();
  });
});

describe("Orbit dependency inventory", () => {
  it("keeps missing scans distinct from an empty inventory", () => {
    expect(
      parseDependencies({
        composer: { state: "unknown" },
        javascript: { error_code: "dependencies.read_failed" },
      }),
    ).toEqual({
      composer: null,
      javascript: null,
      package_manager: null,
      errors: { javascript: "dependencies.read_failed" },
    });
    expect(
      parseDependencies({ composer: { snapshot: { graph: { resolutions: [] } } } }).composer,
    ).toEqual([]);
  });
  it("matches root requirements by resolution ID and preserves multiple versions", () => {
    const data = parseDependencies({
      javascript: {
        snapshot: {
          source: { file_hashes: { "bun.lock": "hash", "package-lock.json": null } },
          graph: {
            resolutions: [
              { id: "vue", name: "vue", version: "3.5.22", regular: true, development: true },
              { id: "vue@3.4", name: "vue", version: "3.4.0", regular: false, development: true },
            ],
            requirements: [
              { from: null, to: "vue", constraint: "^3.5", kind: "dependency" },
              { from: "other", to: "vue@3.4", constraint: "^3.4", kind: "dependency" },
            ],
          },
        },
      },
    });
    expect(data.package_manager).toBe("bun");
    expect(data.javascript).toEqual([
      { id: "vue", name: "vue", version: "3.5.22", constraint: "^3.5", development: false },
      { id: "vue@3.4", name: "vue", version: "3.4.0", constraint: null, development: true },
    ]);
  });
});
