// bun apps/ios/scripts/thread-inventory-fixture.mjs <task simulator UDID>
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixture = read("../../../crates/conn-state/tests/fixtures/sidebar_inventory.json");
const base = read("../../../crates/conn-state/tests/fixtures/shell_thread_updates.json")[0].thread;
const marker = { kind: "synchronized" };
const row = (fields) => ({
  ...base, title: fields.id, lineage: { rootThreadId: fields.id }, ...fields,
});

function environment(name) {
  let socket, requestId, receiveSubscription, receiveAck;
  const threads = new Map();
  let replay = false, seq = 0;
  const rows = fixture[name].map(row);
  const ready = () => new Promise((resolve) => { receiveSubscription = resolve; });
  function send(values) {
    socket.send(JSON.stringify({ _tag: "Chunk", requestId, values }));
  }
  function snapshot(threads) {
    return { kind: "snapshot", snapshot: {
      schemaVersion: 1, snapshotSequence: ++seq, projects: [], threads, archivedThreads: [],
    } };
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === "/ws" && server.upgrade(req)) return;
      if (path.endsWith("/outline")) return Response.json({ snapshotSequence: seq, markers: [] });
      if (path === "/oauth/token") return Response.json({ access_token: "fixture" });
      if (path === "/.well-known/t3/environment") return Response.json({ environmentId: name });
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(ws, text) {
        for (const frame of [JSON.parse(text)].flat()) {
          if (frame._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
          if (frame._tag === "Request" && frame.tag === "orchestration.subscribeShell") {
            console.log(name, replay ? "replay subscribed" : "initial subscription");
            socket = ws;
            requestId = frame.id;
            if (replay) {
              send([snapshot([row({ id: "transient-" + name })])]);
              receiveAck = receiveSubscription;
            } else {
              send([snapshot([row({ id: "old-" + name })]), marker]);
            }
          }
          if (frame.tag === "orchestration.subscribeThread") {
            threads.set(frame.payload.threadId, { ws, id: frame.id });
          }
          if (frame._tag === "Ack" && frame.requestId === requestId && ws === socket) {
            receiveAck?.();
            receiveAck = undefined;
          }
        }
      },
    },
  });
  return {
    url: server.url.href,
    hold() { replay = true; return ready(); },
    interrupt() { const next = ready(); socket.close(); return next; },
    commit() { send([snapshot(rows), marker]); },
    backfill(id) {
      const sub = threads.get(id);
      if (!sub) throw new Error("No background subscription for " + id);
      const snapshot = read("../../../crates/conn-state/tests/fixtures/thread_turn_stream.json")[0];
      snapshot.projection.thread.id = id;
      sub.ws.send(JSON.stringify({ _tag: "Chunk", requestId: sub.id, values: [snapshot, marker] }));
    },
    update(id, patch) {
      const thread = rows.find((t) => t.id === id);
      Object.assign(thread, patch);
      send([{ kind: "thread.updated", sequence: ++seq, location: "active", thread }]);
    },
  };
}

const primary = environment("primary"), linked = environment("linked");
let held;
const control = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 60,
  async fetch(req) {
    const step = new URL(req.url).pathname.slice(1);
    switch (step) {
      case "hold": held = Promise.all([primary.hold(), linked.hold()]); break;
      case "staged": await held; break;
      case "primary": primary.commit(); break;
      case "interrupt": await linked.interrupt(); break;
      case "linked": linked.commit(); break;
      case "backfill": {
        primary.backfill("d");
        const dir = execFileSync("xcrun", ["simctl", "get_app_container", device, "com.nckrtl.conn.ios", "data"], { encoding: "utf8" }).trim();
        const db = new Database(dir + "/Library/Application Support/thread-cache/messages.sqlite3", { readonly: true });
        try {
          const deadline = Date.now() + 10000;
          const query = db.query("SELECT count(*) AS n FROM messages WHERE environment = 'primary' AND thread = 'd'");
          while (!query.get().n) {
            if (Date.now() >= deadline) throw new Error("Background message never reached the cache");
            await Bun.sleep(25);
          }
        } finally { db.close(); }
        break;
      }
      case "approval": primary.update("b", { title: "Primary b approval", updatedAt: "2026-11-25T11:00:00Z",
        pendingRuntimeRequest: { id: "approve", kind: "approval", createdAt: "2026-11-25T11:00:00Z" } }); break;
      case "complete": primary.update("b", { title: "Primary b complete", status: "completed", pendingRuntimeRequest: null,
        updatedAt: "2026-11-25T11:01:00Z", latestRunCompletedAt: "2026-11-25T11:01:00Z" }); break;
      case "settle": linked.update("a", { settledAt: "2026-11-25T11:05:00Z" }); break;
      case "unsettle": primary.update("s", { settledAt: null, unsettledAt: "2026-11-25T11:06:00Z" }); break;
      default: return new Response(null, { status: 404 });
    }
    console.log(step);
    return new Response("ok");
  },
});

const device = process.argv[2];
if (!device) throw new Error("Pass the task simulator UDID");
const child = spawn("xcodebuild", ["test", "-project", "apps/ios/Conn.xcodeproj", "-scheme", "Conn",
  "-destination", "id=" + device, "-derivedDataPath", "apps/ios/build/DerivedData",
  "-parallel-testing-enabled", "NO", "-only-testing:ConnUITests/ConnSpikeUITests/testAtomicThreadInventory",
  "CODE_SIGN_IDENTITY=-"], { cwd: root, stdio: "inherit", env: { ...process.env,
    TEST_RUNNER_CONN_INVENTORY_FIXTURE: control.url.href,
    TEST_RUNNER_CONN_PAIRING_URL: primary.url + "#token=test",
    TEST_RUNNER_CONN_LINKED_PAIRING_URL: linked.url + "#token=test",
  } });
child.on("exit", (code) => process.exit(code ?? 1));
