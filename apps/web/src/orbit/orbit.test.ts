// @effect-diagnostics nodeBuiltinImport:off - runs the generated shell scripts with real sh and curl.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { isOrbitCheckout } from "./orbitCheckout";
import {
  buildHiddenShellLine,
  buildOrbitCurlScript,
  buildOrbitRequestUrl,
  type OrbitHttpRequest,
  parseHiddenShellOutput,
  parseOrbitCurlOutput,
} from "./orbitTransport";

/** Runs a hidden-shell line the way the terminal does, through a real `sh`. */
function runLine(line: string): Promise<string> {
  const command = line.replace(/; exit\r$/, "").trim();
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile("sh", ["-c", command], (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

/** Runs a script through a real `sh`, through the same line and parser. */
const realShell = async (script: string, _timeoutSeconds: number) => {
  const output = await runLine(buildHiddenShellLine({ requestId: "t1", script }));
  const parsed = parseHiddenShellOutput(output, "t1");
  if (parsed._tag !== "done") throw new Error(`shell output: ${parsed._tag}`);
  return parsed;
};

describe("isOrbitCheckout", () => {
  it("recognizes checkouts the old Orbit mode made beside a Project's default checkout", () => {
    expect(isOrbitCheckout("/fast/apps/acme/t3-7234a69d")).toBe(true);
    expect(isOrbitCheckout("/fast/apps/acme/t3code-1a2b3c4d")).toBe(true);
    expect(isOrbitCheckout("/fast/apps/acme/t3code-1a2b3c4d/")).toBe(true);
    expect(isOrbitCheckout("/home/orbit/apps/acme-site/t3code-0f9e8d7c")).toBe(true);
  });

  it("leaves T3's own worktrees and other folders alone", () => {
    expect(isOrbitCheckout("/home/nick/.t3/worktrees/acme/t3-1a2b3c4d")).toBe(false);
    expect(isOrbitCheckout("/Users/nick/.t3/headless/worktrees/acme/t3-ea0f3c11")).toBe(false);
    expect(isOrbitCheckout("/Users/nick/.t3/userdata/worktrees/acme/t3code-1a2b3c4d")).toBe(false);
    expect(isOrbitCheckout("/srv/t3home/worktrees/acme/t3code-1a2b3c4d")).toBe(false);
    expect(isOrbitCheckout("/fast/apps/acme/default")).toBe(false);
    expect(isOrbitCheckout("/fast/apps/acme/t3code-feature")).toBe(false);
    expect(isOrbitCheckout(null)).toBe(false);
  });
});

describe("hidden shell transport", () => {
  let server: NodeHttp.Server;
  let gatewayUrl: string;
  const received: Array<{ method: string; url: string; body: string; type: string | null }> = [];

  beforeAll(async () => {
    server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body,
          type: request.headers["content-type"] ?? null,
        });
        if (request.url?.startsWith("/api/v1/missing")) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "http.404", message: "Not found" } }));
          return;
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { echoed: body ? JSON.parse(body) : null } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  async function call(gateway: string, request: OrbitHttpRequest) {
    const result = await realShell(
      buildOrbitCurlScript(buildOrbitRequestUrl(gateway, request), request),
      60,
    );
    return parseOrbitCurlOutput(result.exitCode, result.output);
  }

  it("never echoes a complete marker and prefers the system curl", () => {
    const line = buildHiddenShellLine({ requestId: "abc123", script: "echo hi" });
    expect(line).not.toContain("__T3ORBIT_abc123_BEGIN__");
    expect(
      buildOrbitCurlScript("https://gateway.orbit/x", { method: "GET", path: "/x" }),
    ).toContain("k=/usr/bin/curl");
  });

  it("round-trips a JSON request through curl and the markers", async () => {
    const body = { name: "t3code-1a2b3c4d", note: "quotes ' \" and $HOME stay literal ✓" };
    await expect(
      call(gatewayUrl, { method: "POST", path: "/api/v1/instances", body }),
    ).resolves.toEqual({
      status: 201,
      body: { data: { echoed: body } },
    });
    expect(received.at(-1)).toMatchObject({ method: "POST", type: "application/json" });
  });

  it("passes query strings and reports HTTP errors", async () => {
    await expect(
      call(gatewayUrl, {
        method: "GET",
        path: "/api/v1/missing",
        query: { directory: "/fast/apps/dlf/main" },
      }),
    ).resolves.toEqual({
      status: 404,
      body: { error: { code: "http.404", message: "Not found" } },
    });
    expect(received.at(-1)?.url).toBe("/api/v1/missing?directory=%2Ffast%2Fapps%2Fdlf%2Fmain");
  });

  it("reports an unreachable Gateway", async () => {
    await expect(
      call("http://127.0.0.1:9", { method: "GET", path: "/api/v1/nodes/9" }),
    ).rejects.toThrow(/not reachable from this machine/);
  });

  it("returns a failing script's exit code and output", async () => {
    await expect(realShell("echo nope; exit 3", 10)).resolves.toEqual({
      _tag: "done",
      exitCode: 3,
      output: "nope",
    });
  });

  it("waits until both markers arrived", () => {
    expect(parseHiddenShellOutput("noise __T3ORBIT_x_BEGIN__\r\nMA==", "x")).toEqual({
      _tag: "pending",
    });
  });
});
