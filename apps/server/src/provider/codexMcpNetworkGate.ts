// Codex never retries MCP servers that fail at startup. Wait once per config for enabled
// `*.orbit` endpoints before spawning, bounded by T3CODE_CODEX_MCP_WAIT_SECONDS
// (default 120; 0 disables). Spawn proceeds after timeout.
import * as NodeNet from "node:net";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const CODEX_MCP_WAIT_ENV = "T3CODE_CODEX_MCP_WAIT_SECONDS";
const DEFAULT_WAIT_SECONDS = 120;
const PROBE_TIMEOUT_MS = 3_000;
const RETRY_INTERVAL_MS = 2_000;

export interface McpHost {
  readonly host: string;
  readonly port: number;
}

export interface McpNetworkGateResult {
  readonly hosts: ReadonlyArray<string>;
  readonly ready: boolean;
  readonly waitedMs: number;
  readonly pending: ReadonlyArray<string>;
}

const hostLabel = (host: McpHost) => `${host.host}:${host.port}`;

/** Enabled `[mcp_servers.<name>]` URLs whose host ends in `.orbit`. */
export const orbitMcpHosts = (configToml: string): ReadonlyArray<McpHost> => {
  const servers = new Map<string, { url: string | undefined; enabled: boolean }>();
  let current: string | undefined;
  for (const line of configToml.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      current = /^mcp_servers\.("[^"]+"|[^.]+)$/.exec(header[1]!.trim())?.[1];
      if (current !== undefined && !servers.has(current)) {
        servers.set(current, { url: undefined, enabled: true });
      }
      continue;
    }
    const entry = current === undefined ? undefined : servers.get(current);
    if (entry === undefined) continue;
    const url = /^\s*url\s*=\s*["']([^"']+)["']/.exec(line);
    if (url) entry.url = url[1];
    if (/^\s*enabled\s*=\s*false\b/.test(line)) entry.enabled = false;
  }
  const hosts = new Map<string, McpHost>();
  for (const { url, enabled } of servers.values()) {
    if (!enabled || url === undefined || !URL.canParse(url)) continue;
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(".orbit")) continue;
    const host = {
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === "http:" ? 80 : 443),
    };
    hosts.set(hostLabel(host), host);
  }
  return [...hosts.values()];
};

/** Succeeds with true when `host` resolves and accepts a TCP connection on `port`. */
const probeTcp = (host: McpHost, timeoutMs = PROBE_TIMEOUT_MS) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host: host.host, port: host.port });
    const done = (ok: boolean) => {
      socket.destroy();
      resume(Effect.succeed(ok));
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    return Effect.sync(() => socket.destroy());
  });

export const waitForMcpHosts = Effect.fn("codexMcpNetworkGate.waitForMcpHosts")(function* (
  hosts: ReadonlyArray<McpHost>,
  budgetMs: number,
  intervalMs = RETRY_INTERVAL_MS,
) {
  const started = yield* Clock.currentTimeMillis;
  let pending = [...hosts];
  while (pending.length > 0) {
    const results = yield* Effect.forEach(
      pending,
      (host) => probeTcp(host, Math.min(PROBE_TIMEOUT_MS, budgetMs)),
      { concurrency: "unbounded" },
    );
    pending = pending.filter((_, index) => !results[index]);
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    if (pending.length === 0 || elapsed + intervalMs >= budgetMs) break;
    yield* Effect.sleep(Duration.millis(intervalMs));
  }
  return {
    hosts: hosts.map(hostLabel),
    ready: pending.length === 0,
    waitedMs: (yield* Clock.currentTimeMillis) - started,
    pending: pending.map(hostLabel),
  } satisfies McpNetworkGateResult;
});

/**
 * Returns a gate that waits once per Codex config for its Orbit MCP hosts.
 * The gate never fails: an unreadable config means no hosts and no wait.
 */
export const makeCodexMcpNetworkGate = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gates = new Map<string, Effect.Effect<McpNetworkGateResult>>();

  return Effect.fn("codexMcpNetworkGate.wait")(function* (environment: NodeJS.ProcessEnv) {
    const raw = environment[CODEX_MCP_WAIT_ENV]?.trim();
    const seconds = raw ? Number(raw) : DEFAULT_WAIT_SECONDS;
    const budgetMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
    const codexHome = environment.CODEX_HOME || path.join(environment.HOME ?? "", ".codex");
    const configPath = path.join(codexHome, "config.toml");
    let gate = gates.get(configPath);
    if (gate === undefined) {
      gate = yield* Effect.cached(
        fileSystem.readFileString(configPath).pipe(
          Effect.map(orbitMcpHosts),
          Effect.orElseSucceed((): ReadonlyArray<McpHost> => []),
          Effect.flatMap((hosts) =>
            budgetMs === 0 || hosts.length === 0
              ? Effect.succeed({
                  hosts: hosts.map(hostLabel),
                  ready: true,
                  waitedMs: 0,
                  pending: [],
                } satisfies McpNetworkGateResult)
              : waitForMcpHosts(hosts, budgetMs),
          ),
        ),
      );
      gates.set(configPath, gate);
    }
    return yield* gate;
  });
});
