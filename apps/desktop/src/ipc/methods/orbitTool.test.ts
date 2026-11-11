import { describe, expect, it } from "vite-plus/test";

import {
  type GatewayFetch,
  makeOrbitToolSender,
  matchOrbitToolRequest,
  type OrbitToolRequest,
} from "./orbitTool.ts";

type Call = Pick<OrbitToolRequest, "method" | "path" | "query" | "body">;

const get = (path: string, query: Record<string, string> = {}): Call => ({
  method: "GET",
  path,
  query,
  body: null,
});

describe("matchOrbitToolRequest", () => {
  it.each<[string, Call, string]>([
    [
      "resolve",
      get("/api/v1/instances/resolve", { domain: "dlf.test" }),
      "/api/v1/instances/resolve?domain=dlf.test",
    ],
    ["nodes", get("/api/v1/nodes"), "/api/v1/nodes"],
    [
      "processes",
      get("/api/v1/processes", { target_type: "instance", target_id: "12" }),
      "/api/v1/processes?target_type=instance&target_id=12",
    ],
    [
      "process logs",
      get("/api/v1/processes/7/logs", { lines: "200" }),
      "/api/v1/processes/7/logs?lines=200",
    ],
    [
      "process start",
      { method: "POST", path: "/api/v1/processes/7/start", query: {}, body: null },
      "/api/v1/processes/7/start",
    ],
    [
      "process stop",
      { method: "POST", path: "/api/v1/processes/7/stop", query: {}, body: null },
      "/api/v1/processes/7/stop",
    ],
    [
      "process restart",
      { method: "POST", path: "/api/v1/processes/7/restart", query: {}, body: null },
      "/api/v1/processes/7/restart",
    ],
    ["dependencies", get("/api/v1/instances/12/dependencies"), "/api/v1/instances/12/dependencies"],
    [
      "application logs",
      get("/api/v1/instances/12/logs", { lines: "200" }),
      "/api/v1/instances/12/logs?lines=200",
    ],
    [
      "log stream open",
      { method: "POST", path: "/api/v1/instances/12/log-streams", query: {}, body: "{}" },
      "/api/v1/instances/12/log-streams",
    ],
    [
      "log stream renew",
      { method: "PUT", path: "/api/v1/instances/12/log-streams/01hx-ab", query: {}, body: "{}" },
      "/api/v1/instances/12/log-streams/01hx-ab",
    ],
    [
      "log stream close",
      { method: "DELETE", path: "/api/v1/instances/12/log-streams/01hx-ab", query: {}, body: null },
      "/api/v1/instances/12/log-streams/01hx-ab",
    ],
    ["realtime", get("/api/v1/realtime"), "/api/v1/realtime"],
  ])("allows %s", (_name, call, expected) => {
    const match = matchOrbitToolRequest(call);
    expect(match.ok && `${match.url.pathname}${match.url.search}`).toBe(expected);
  });

  it.each<[string, Call]>([
    ["a path outside the list", get("/api/v1/conn/environments")],
    ["another Gateway path", get("/api/v1/instances")],
    ["a parent segment", get("/api/v1/processes/7/../../nodes")],
    ["an encoded parent segment", get("/api/v1/processes/7/%2e%2e/logs", { lines: "1" })],
    ["an encoded slash", get("/api/v1/instances%2f12/dependencies")],
    ["a non-integer process id", get("/api/v1/processes/abc/logs", { lines: "1" })],
    ["a zero id", get("/api/v1/instances/0/dependencies")],
    ["a negative id", get("/api/v1/instances/-1/dependencies")],
    ["a fractional id", get("/api/v1/instances/1.5/dependencies")],
    ["a query in the path", get("/api/v1/nodes?x=1")],
    ["an unknown query key", get("/api/v1/nodes", { all: "1" })],
    ["an extra query key", get("/api/v1/processes/7/logs", { lines: "1", follow: "1" })],
    ["a missing query key", get("/api/v1/processes", { target_type: "instance" })],
    ["a non-integer target", get("/api/v1/processes", { target_type: "instance", target_id: "x" })],
    ["another target type", get("/api/v1/processes", { target_type: "node", target_id: "1" })],
    ["too many lines", get("/api/v1/instances/12/logs", { lines: "100000" })],
    ["a bad domain", get("/api/v1/instances/resolve", { domain: "a b/c" })],
    ["a body on a read", { ...get("/api/v1/nodes"), body: "{}" }],
    [
      "a body on an action",
      { method: "POST", path: "/api/v1/processes/7/start", query: {}, body: "{}" },
    ],
    ["another action", { method: "POST", path: "/api/v1/processes/7/kill", query: {}, body: null }],
  ])("refuses %s", (_name, call) => {
    expect(matchOrbitToolRequest(call).ok).toBe(false);
  });

  it.each<Call>([
    { method: "POST", path: "/api/v1/nodes", query: {}, body: null },
    { method: "DELETE", path: "/api/v1/processes/7/logs", query: { lines: "1" }, body: null },
    { method: "GET", path: "/api/v1/processes/7/restart", query: {}, body: null },
    { method: "PUT", path: "/api/v1/instances/12/log-streams", query: {}, body: "{}" },
  ])("refuses $method on an allowed path $path", (call) => {
    const match = matchOrbitToolRequest(call);
    expect(match.ok ? null : match.error).toBe(
      `${call.method} is not allowed on that Gateway path.`,
    );
  });
});

const ENV = "env-clone";

function gateway(options: { readonly environments: unknown[]; readonly processes?: unknown[] }) {
  const calls: { method: string; url: string }[] = [];
  const fetch: GatewayFetch = async (url, init) => {
    calls.push({ method: init.method, url });
    const { pathname, searchParams } = new URL(url);
    const data =
      pathname === "/api/v1/conn/environments"
        ? options.environments
        : pathname === "/api/v1/processes" && searchParams.get("target_id") === "12"
          ? (options.processes ?? [])
          : pathname === "/api/v1/processes"
            ? [{ id: 99 }]
            : { ok: true };
    return { status: 200, text: async () => JSON.stringify({ data }) };
  };
  return { calls, send: makeOrbitToolSender(fetch, () => 0) };
}

const request = (method: OrbitToolRequest["method"], path: string, body: string | null = null) => ({
  environmentId: ENV,
  method,
  path,
  query: {},
  body,
});

describe("makeOrbitToolSender", () => {
  const bound = [
    { environment_id: "env-host", instance_id: null },
    { environment_id: ENV, instance_id: 12 },
  ];

  it("restarts a Process of the thread's own Instance", async () => {
    const { calls, send } = gateway({ environments: bound, processes: [{ id: 7 }] });
    const response = await send(request("POST", "/api/v1/processes/7/restart"));
    expect(response.error).toBeNull();
    expect(calls.at(-1)).toEqual({
      method: "POST",
      url: "https://gateway.orbit/api/v1/processes/7/restart",
    });
  });

  it("refuses a Process of another Instance without calling the write", async () => {
    const { calls, send } = gateway({ environments: bound, processes: [{ id: 7 }] });
    const response = await send(request("POST", "/api/v1/processes/99/stop"));
    expect(response.error).toBe("Conn only changes Processes of this thread's own Orbit Instance.");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses writes for an environment with no Orbit Instance", async () => {
    for (const environmentId of ["env-host", "env-unknown"]) {
      const { calls, send } = gateway({ environments: bound, processes: [{ id: 7 }] });
      const response = await send({
        ...request("POST", "/api/v1/processes/7/start"),
        environmentId,
      });
      expect(response.error).toBe(
        "This thread's environment has no Orbit Instance, so Conn changes nothing.",
      );
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    }
  });

  it("opens and closes log streams only on the thread's own Instance", async () => {
    const { calls, send } = gateway({ environments: bound });
    expect(
      (await send(request("POST", "/api/v1/instances/12/log-streams", "{}"))).error,
    ).toBeNull();
    expect((await send(request("DELETE", "/api/v1/instances/12/log-streams/ab"))).error).toBeNull();
    const foreign = await send(request("POST", "/api/v1/instances/13/log-streams", "{}"));
    expect(foreign.error).toBe("Conn only changes this thread's own Orbit Instance.");
    expect(calls.filter((call) => call.url.includes("/instances/13/"))).toEqual([]);
  });

  it("lets reads follow the page's Instance and refuses a path outside the list", async () => {
    const { calls, send } = gateway({ environments: [] });
    expect((await send(request("GET", "/api/v1/instances/13/dependencies"))).error).toBeNull();
    const refused = await send(request("GET", "/api/v1/conn/me"));
    expect(refused.error).toBe("That Gateway path is not allowed.");
    expect(calls.map((call) => call.url)).toEqual([
      "https://gateway.orbit/api/v1/instances/13/dependencies",
    ]);
  });
});
