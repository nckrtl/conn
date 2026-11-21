#!/usr/bin/env node
// The small `server.*` and `provider.uploadFeedback` answers, on the T3 server and the Conn
// Server.
//
//   node crates/conn-server/tools/server-misc-diff.mjs <conn-server>
//
// Both servers (the T3 server from the monorepo, the Conn Server; temp homes, free ports,
// sealed environments) answer over `/ws`:
// - `server.getSettings`: equal on both sides, and equal to each side's `server.getConfig`
//   settings (T3's `redactServerSettingsForClient`).
// - `server.getTraceDiagnostics`: the Conn Server writes no trace, so its answer must equal
//   T3's own `TraceDiagnostics.readTraceDiagnostics` on a log folder without trace files
//   (paths and `readAt` normalized). The T3 server itself always writes traces, so its answer
//   is only checked for the same keys.
// - `server.getDatabaseStorage`: the Conn Server has no offline repair command, so it sends
//   T3's `null` (T3 sends `null` when `t3 doctor` does not target its database).
// - `server.reclaimDatabaseSpace`: both refuse with `DatabaseReclaimError`.
// - `provider.uploadFeedback` for an unknown thread: both refuse with
//   `ProviderUploadFeedbackError` for that thread.
// Only loopback connections; no model; every process is stopped by PID.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { pairBearer } from "../../conn-mcp/tools/mcp-client.mjs";
import { importSource, monorepo, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnv, sealedNodeEnv } from "../../../tools/sealed-env.mjs";
import { GUARD_ARG } from "../../../tools/no-outside-fetch.mjs";

const [binaryArg] = process.argv.slice(2);
if (binaryArg === undefined) {
  console.error("usage: server-misc-diff.mjs <conn-server>");
  process.exit(2);
}
const rustBinary = NodePath.resolve(binaryArg);
const MONOREPO = monorepo();
const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-server-misc-")));
const started = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
function stopAll() {
  for (const child of started) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}
process.on("exit", stopAll);

class Side {
  constructor(kind) {
    this.kind = kind;
    this.name = kind === "ts" ? "T3" : "Conn";
    this.dir = NodePath.join(root, kind);
    NodeFS.mkdirSync(this.dir, { recursive: true });
    this.out = NodePath.join(this.dir, "server.log");
    // The folder that holds `logs/`: T3's `<base>/userdata`, the Conn Server's state folder.
    this.state = kind === "ts" ? NodePath.join(this.dir, "base", "userdata") : NodePath.join(this.dir, "state");
  }

  async start() {
    this.port = await freePort();
    this.origin = `http://127.0.0.1:${this.port}`;
    const [command, args, env] =
      this.kind === "ts"
        ? [process.execPath, [GUARD_ARG, NodePath.join(MONOREPO, "apps/server/src/bin.ts"), "serve", "--no-browser", "--port", String(this.port), "--host", "127.0.0.1", "--base-dir", NodePath.join(this.dir, "base")],
            { ...sealedNodeEnv(this.dir), PATH: sealedEnv(this.dir).PATH, T3CODE_NO_BROWSER: "1", T3CODE_TELEMETRY_ENABLED: "false" }]
        : [rustBinary, ["serve", "--listen", `127.0.0.1:${this.port}`, "--state-dir", this.state], sealedEnv(this.dir)];
    env.SHELL = "/bin/sh";
    const out = NodeFS.openSync(this.out, "a");
    const child = NodeChildProcess.spawn(command, args, { cwd: this.dir, env, detached: true, stdio: ["ignore", out, out] });
    NodeFS.closeSync(out);
    started.add(child);
    for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(100)) {
      if (child.exitCode !== null) throw new Error(`${this.name} server exited; see ${this.out}`);
      const code = NodeFS.readFileSync(this.out, "utf8").match(/pair#token=([A-Za-z0-9]+)/)?.[1];
      if (code === undefined) continue;
      try {
        if ((await fetch(`${this.origin}/.well-known/t3/environment`)).ok) {
          this.bearer = await pairBearer(this.origin, code);
          return;
        }
      } catch {}
    }
    throw new Error(`${this.name} server did not start; see ${this.out}`);
  }

  async socket() {
    const ticket = await fetch(`${this.origin}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${this.bearer}` } });
    const url = `${this.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent((await ticket.json()).ticket)}`;
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`${this.name}: socket failed`));
    });
    return socket;
  }

  /** One RPC: `{ ok }`, `{ failure }` (the typed error), or `{ item }` (a stream's first item). */
  async rpc(tag, payload) {
    const socket = await this.socket();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.name}: ${tag} did not answer`)), 30_000);
        socket.onmessage = (event) => {
          for (const line of String(event.data).split("\n").filter(Boolean)) {
            const frame = JSON.parse(line);
            if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
            if (String(frame.requestId) !== "1") continue;
            if (frame._tag === "Chunk" && frame.values?.length > 0) {
              clearTimeout(timer);
              resolve({ item: frame.values[0] });
            } else if (frame._tag === "Exit") {
              clearTimeout(timer);
              if (frame.exit._tag === "Success") resolve({ ok: frame.exit.value ?? null });
              else {
                const cause = Array.isArray(frame.exit.cause) ? frame.exit.cause : [];
                resolve({ failure: cause.find((c) => c._tag === "Fail")?.error ?? frame.exit });
              }
            }
          }
        };
        socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
      });
    } finally {
      socket.close();
    }
  }
}

const failures = [];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).toSorted().map((k) => [k, canonical(value[k])]))
      : value;
const same = (label, a, b) => {
  const [x, y] = [JSON.stringify(canonical(a)), JSON.stringify(canonical(b))];
  if (x === y) console.log(`ok   ${label}`);
  else failures.push(`${label}\n  T3:   ${x.slice(0, 1500)}\n  Conn: ${y.slice(0, 1500)}`);
};
const truth = (label, ok, detail) => {
  if (ok) console.log(`ok   ${label}`);
  else failures.push(`${label}: ${detail}`);
};

/** T3's own trace read on a log folder without trace files, as the server would answer. */
async function t3EmptyTrace(state) {
  const fromServer = packageImporter("apps/server");
  const Effect = await fromServer("effect/Effect");
  const Schema = await fromServer("effect/Schema");
  const NodeServices = await fromServer("@effect/platform-node/NodeServices");
  const TraceDiagnostics = await importSource("apps/server/src/diagnostics/TraceDiagnostics.ts");
  const { ServerTraceDiagnosticsResult } = await importSource("packages/contracts/src/index.ts");
  const result = await Effect.runPromise(
    TraceDiagnostics.readTraceDiagnostics({
      traceFilePath: NodePath.join(state, "logs", "server.trace.ndjson"),
      maxFiles: 10,
    }).pipe(Effect.provide(TraceDiagnostics.layer), Effect.provide(NodeServices.layer)),
  );
  return Schema.encodeSync(ServerTraceDiagnosticsResult)(result);
}

const sides = [new Side("ts"), new Side("rust")];
try {
  await Promise.all(sides.map((s) => s.start()));
  const [ts, rust] = sides;
  const answers = {};
  for (const side of sides) {
    answers[side.kind] = {
      settings: await side.rpc("server.getSettings", {}),
      config: await side.rpc("server.getConfig", {}),
      trace: await side.rpc("server.getTraceDiagnostics", {}),
      storage: await side.rpc("server.getDatabaseStorage", {}),
      reclaim: await side.rpc("server.reclaimDatabaseSpace", {}),
      feedback: await side.rpc("provider.uploadFeedback", { threadId: "server-misc-missing" }),
    };
  }
  const [a, b] = [answers.ts, answers.rust];

  // The Conn Server sends only stored keys; the client's decode fills the defaults.
  const { ServerSettings } = await importSource("packages/contracts/src/index.ts");
  const Schema = await packageImporter("packages/contracts")("effect/Schema");
  const decoded = (value) => Schema.encodeSync(ServerSettings)(Schema.decodeUnknownSync(ServerSettings)(value));
  same("server.getSettings, as the client decodes it", decoded(a.settings.ok), decoded(b.settings.ok));
  for (const side of sides) {
    const { settings, config } = answers[side.kind];
    truth(`${side.name}: server.getSettings equals server.getConfig's settings`, JSON.stringify(canonical(settings.ok)) === JSON.stringify(canonical(config.ok?.settings)), JSON.stringify(settings).slice(0, 300));
  }

  // An Option goes on the wire as `{ _tag, value }`, without the `_id` of its JSON form.
  const normal = (side, value) =>
    JSON.parse(
      JSON.stringify({ ...value, readAt: "<readAt>" }, (key, v) => (key === "_id" ? undefined : v)).replaceAll(side.state, "<state>"),
    );
  const empty = { state: NodePath.join(root, "no-traces") };
  same("server.getTraceDiagnostics without trace files (T3's readTraceDiagnostics)", normal(empty, await t3EmptyTrace(empty.state)), normal(rust, b.trace.ok));
  same("server.getTraceDiagnostics keys", Object.keys(a.trace.ok ?? {}).toSorted(), Object.keys(b.trace.ok ?? {}).toSorted());

  truth("server.getDatabaseStorage: T3 targets its own database and sends a status", a.storage.item !== undefined && a.storage.item !== null && typeof a.storage.item.compactCommand === "string", JSON.stringify(a.storage));
  truth("server.getDatabaseStorage: the Conn Server sends null", b.storage.item === null, JSON.stringify(b.storage));

  same("server.reclaimDatabaseSpace refusal", a.reclaim.failure?._tag, b.reclaim.failure?._tag);
  truth("server.reclaimDatabaseSpace is DatabaseReclaimError", b.reclaim.failure?._tag === "DatabaseReclaimError", JSON.stringify(b.reclaim));

  same("provider.uploadFeedback for an unknown thread", { tag: a.feedback.failure?._tag, threadId: a.feedback.failure?.threadId }, { tag: b.feedback.failure?._tag, threadId: b.feedback.failure?.threadId });
  console.log(`     T3 cause:   ${JSON.stringify(a.feedback.failure?.cause ?? null).slice(0, 200)}`);
  console.log(`     Conn cause: ${JSON.stringify(b.feedback.failure?.cause ?? null).slice(0, 200)}`);
} catch (error) {
  failures.push(String(error?.stack ?? error));
} finally {
  stopAll();
}
if (failures.length > 0) {
  console.error(`server-misc-diff: ${failures.length} failure(s)\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("server-misc-diff: all equal");
NodeFS.rmSync(root, { recursive: true, force: true });
process.exit(0);
