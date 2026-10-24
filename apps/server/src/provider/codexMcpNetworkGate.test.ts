import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeCodexMcpNetworkGate, orbitMcpHosts, waitForMcpHosts } from "./codexMcpNetworkGate.ts";

const listen = (port = 0) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.end());
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => server.close()),
  );

const freePort = Effect.scoped(
  listen().pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port)),
);

it("orbitMcpHosts keeps enabled *.orbit MCP URLs only", () => {
  const toml = [
    'base_url = "http://10.44.0.3:8317/v1"',
    "[mcp_servers.recall]",
    'url = "https://recall.orbit/mcp/recall"',
    'bearer_token_env_var = "RECALL_MCP_TOKEN"',
    "[mcp_servers.recall.env]",
    'url = "https://ignored.orbit/"',
    "[mcp_servers.executor]",
    'url = "https://executor.orbit/mcp"',
    "[mcp_servers.off]",
    'url = "https://off.orbit/mcp"',
    "enabled = false",
    "[mcp_servers.linear]",
    'url = "https://mcp.linear.app/mcp"',
    "[mcp_servers.local]",
    'url = "http://dev.orbit:8080/mcp"',
  ].join("\n");
  assert.deepStrictEqual(orbitMcpHosts(toml), [
    { host: "recall.orbit", port: 443 },
    { host: "executor.orbit", port: 443 },
    { host: "dev.orbit", port: 8080 },
  ]);
});

it.live("waitForMcpHosts passes once every host accepts a connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* listen();
      const port = (server.address() as NodeNet.AddressInfo).port;
      const result = yield* waitForMcpHosts([{ host: "127.0.0.1", port }], 5_000, 100);
      assert.isTrue(result.ready);
      assert.deepStrictEqual(result.pending, []);
    }),
  ),
);

it.live("waitForMcpHosts gives up after the budget and reports the pending host", () =>
  Effect.gen(function* () {
    const port = yield* freePort;
    const result = yield* waitForMcpHosts([{ host: "127.0.0.1", port }], 400, 100);
    assert.isFalse(result.ready);
    assert.deepStrictEqual(result.pending, [`127.0.0.1:${port}`]);
    assert.isBelow(result.waitedMs, 2_000);
  }),
);

it.live("the gate skips the wait when disabled or without Orbit MCP servers", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    yield* fileSystem.writeFileString(
      path.join(home, "config.toml"),
      '[mcp_servers.recall]\nurl = "https://recall.orbit/"\n',
    );
    const gate = yield* makeCodexMcpNetworkGate;
    const disabled = yield* gate({ CODEX_HOME: home, T3CODE_CODEX_MCP_WAIT_SECONDS: "0" });
    assert.deepStrictEqual(disabled, {
      hosts: ["recall.orbit:443"],
      ready: true,
      waitedMs: 0,
      pending: [],
    });
    const missing = yield* gate({ CODEX_HOME: path.join(home, "missing") });
    assert.deepStrictEqual(missing, { hosts: [], ready: true, waitedMs: 0, pending: [] });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
