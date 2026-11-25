// bun apps/ios/scripts/thread-inventory-fixture.mjs <task simulator UDID>
import { readFileSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixture = read("../../../crates/conn-state/tests/fixtures/sidebar_inventory.json");
const base = read("../../../crates/conn-state/tests/fixtures/shell_thread_updates.json")[0].thread;
const marker = { kind: "synchronized" };
const scenario = process.argv[3] ?? "inventory";
const childProjectTest = scenario === "child-project";
const sleepingTest = scenario === "sleeping";
let fleetState = "running";
const releaseDiscovery = Promise.withResolvers();
let sleepingConnectionAttempts = 0;
let wakeCount = 0;
let sleepingDriver;
const driverClosed = Promise.withResolvers();
const followUp = Promise.withResolvers();
const row = (fields) => ({
  ...base, title: fields.id, lineage: { rootThreadId: fields.id }, ...fields,
});

// The child deliberately belongs to a different project from its parent.
function childProjectRequest(ws, frame) {
  if (frame._tag !== "Request") return false;
  const parent = row({ id: "parent", projectId: "parent-project" });
  const child = row({
    id: "child", projectId: "child-project", title: "Artifact child", branch: "child-only-branch",
    delegatedFrom: { threadId: parent.id, environmentId: "primary", title: parent.title },
    lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationshipToParent: "subagent" },
  });
  const chunk = (value) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: frame.id, values: [value, marker] }));
  const reply = (value) => ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }));
  switch (frame.tag) {
    case "orchestration.subscribeShell": {
      const projects = [parent, child].map((t) => ({
        id: t.projectId, title: t === child ? "Child workspace" : "Parent workspace",
        workspaceRoot: "/tmp/" + t.projectId, scripts: [], createdAt: t.createdAt, updatedAt: t.updatedAt,
      }));
      chunk({ kind: "snapshot", snapshot: {
        schemaVersion: 1, snapshotSequence: 1, projects, threads: [parent, child], archivedThreads: [],
      } });
      return true;
    }
    case "orchestration.subscribeThread": {
      const id = frame.payload.threadId;
      if (id !== parent.id && id !== child.id) return false;
      const snap = read("../../../crates/conn-state/tests/fixtures/thread_turn_stream.json")[0];
      const projection = snap.projection;
      const thread = id === child.id ? child : parent;
      Object.assign(projection.thread, { id, title: thread.title, projectId: thread.projectId });
      const common = { id: "item-" + id, threadId: id, ordinal: 1, updatedAt: thread.updatedAt, status: "completed" };
      const item = id === parent.id ? {
        ...common, type: "subagent", subagentId: "worker", title: child.title, origin: "app_owned",
        driver: "codex", providerInstanceId: "codex", childThreadId: child.id, prompt: "Prepare a template",
      } : {
        ...common, type: "assistant_message", messageId: "template", streaming: false,
        text: '::artifact-template{skill_name="artifact-template-report" display_name="Report" skill_directory="/tmp/report" artifact_kind="document"}',
      };
      projection.messages = [];
      projection.turnItems = [item];
      projection.visibleTurnItems = [];
      chunk(snap);
      return true;
    }
    case "projects.ensureScratch": reply({ projectId: "general-project" }); return true;
    case "orchestration.launchThread":
      followUp.resolve(frame.payload.projectId);
      reply({ threadId: frame.payload.threadId });
      return true;
    default: return false;
  }
}

function environment(name) {
  let socket, requestId, receiveSubscription, receiveAck;
  const threads = new Map();
  let pageRequest, expectedCursor, pageRequests = 0;
  const pageReady = Promise.withResolvers();
  let replay = false, seq = 0, socketId = 0;
  const rows = (fixture[name] ?? []).map(row);
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
      if (name === "linked" && sleepingTest && fleetState !== "running") {
        sleepingConnectionAttempts++;
        return new Response(null, { status: 503 });
      }
      if (sleepingTest && name === "witness" && fleetState === "removed" && path === "/.well-known/t3/environment") {
        return new Response(null, { status: 503 });
      }
      if (path === "/ws" && server.upgrade(req, { data: { id: ++socketId } })) return;
      if (path.endsWith("/outline")) return Response.json({ snapshotSequence: seq, markers: [] });
      if (path === "/api/auth/session") return Response.json({ authenticated: true });
      if (path === "/oauth/token") return Response.json({ access_token: "fixture" });
      if (path === "/.well-known/t3/environment") return Response.json({ environmentId: name });
      return new Response(null, { status: 404 });
    },
    websocket: {
      close(ws) {
        if (name === "linked" && ws.data.id === sleepingDriver) driverClosed.resolve();
      },
      message(ws, text) {
        for (const frame of [JSON.parse(text)].flat()) {
          if (childProjectTest && childProjectRequest(ws, frame)) continue;
          if (frame._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
          if (frame._tag === "Request" && frame.tag === "orchestration.subscribeShell") {
            console.log(name, replay ? "replay subscribed" : "initial subscription");
            socket = ws;
            requestId = frame.id;
            if (replay) {
              send([snapshot([row({ id: "transient-" + name })])]);
              receiveAck = receiveSubscription;
            } else {
              const id = name === "witness" ? "witness-" + fleetState : "old-" + name;
              const title = name === "linked" && wakeCount ? "Linked machine resumed " + wakeCount : id;
              send([snapshot([row({ id, title })]), marker]);
            }
          }
          if (frame.tag === "orchestration.getOlderSettledThreads") {
            pageRequest = { ws, id: frame.id, cursor: frame.payload.before.settledAt };
            pageRequests++;
            pageReady.resolve();
          }
          if (frame.tag === "orchestration.subscribeThread") {
            threads.set(frame.payload.threadId, { ws, id: frame.id });
            if (sleepingTest && name === "linked" && frame.payload.threadId === "old-linked") {
              const snap = read("../../../crates/conn-state/tests/fixtures/thread_turn_stream.json")[0];
              const data = JSON.stringify(snap).replaceAll(snap.projection.thread.id, "old-linked")
                .replaceAll(snap.projection.messages[0].text, "Saved linked message");
              ws.send(JSON.stringify({ _tag: "Chunk", requestId: frame.id, values: [JSON.parse(data), marker] }));
            }
          }
          if (frame._tag === "Ack" && frame.requestId === requestId && ws.data.id === socket?.data.id) {
            receiveAck?.();
            receiveAck = undefined;
          }
        }
      },
    },
  });
  return {
    url: server.url.href,
    closeSocket() { socket.close(); },
    socketId() { return socket.data.id; },
    hold() { replay = true; return ready(); },
    interrupt() { const next = ready(); socket.close(); return next; },
    commit() { send([snapshot(rows), marker]); },
    startPaging(before = "2026-11-24T00:00:00Z") {
      expectedCursor = before;
      const item = snapshot(rows.filter((t) => t.id === "b"));
      item.snapshot.olderSettled = {
        before, asOfSequence: seq,
        counts: [{ projectId: base.projectId, count: 2 }],
      };
      send([item, marker]);
    },
    async finishPage() {
      await pageReady.promise;
      if (pageRequests !== 1) throw new Error(name + " received " + pageRequests + " page requests");
      if (pageRequest.cursor !== expectedCursor) throw new Error(name + " paged from stale cursor " + pageRequest.cursor);
      const hours = name === "primary" ? ["10", "08"] : ["11", "09"];
      const threads = hours.map((hour) => row({
        id: "page-" + hour, settledAt: "2026-11-23T" + hour + ":00:00Z",
      }));
      pageRequest.ws.send(JSON.stringify({
        _tag: "Exit", requestId: pageRequest.id,
        exit: { _tag: "Success", value: { snapshotSequence: seq, threads, counts: [] } },
      }));
    },
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
const witness = sleepingTest ? environment("witness") : null;
let held;
function simulatorSupportDirectory() {
  const dir = execFileSync("xcrun", ["simctl", "get_app_container", device, "com.nckrtl.conn.ios", "data"], { encoding: "utf8" }).trim();
  return dir + "/Library/Application Support";
}

async function waitForSavedInventories() {
  const dir = simulatorSupportDirectory();
  const expected = new Set(["old-primary", "old-linked"]);
  const deadline = Date.now() + 10000;
  while (expected.size) {
    for (const name of readdirSync(dir).filter((name) => name === "thread-cache" || name.startsWith("thread-cache-"))) {
      try {
        const saved = JSON.parse(readFileSync(dir + "/" + name + "/shell.json", "utf8"));
        if (!saved.threads.some((t) => t.id === "old-" + saved.environmentId)) continue;
        if (sleepingTest && saved.environmentId === "linked") {
          const db = new Database(dir + "/" + name + "/messages.sqlite3", { readonly: true });
          try {
            if (!db.query("SELECT 1 FROM messages WHERE environment = 'linked' AND thread = 'old-linked' LIMIT 1").get()) continue;
          } finally { db.close(); }
        }
        expected.delete("old-" + saved.environmentId);
      } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
    if (!expected.size) return;
    if (Date.now() >= deadline) throw new Error("Missing cached rows: " + [...expected].join(", "));
    await Bun.sleep(25);
  }
}

const control = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 60,
  async fetch(req) {
    const step = new URL(req.url).pathname.slice(1);
    switch (step) {
      case "api/v1/conn/me":
        return Response.json({ data: { id: 1, name: "phone", wireguard_ip: "127.0.0.1" } });
      case "api/v1/conn/environments": {
        if (fleetState === "stopped") await releaseDiscovery.promise;
        const registration = (id, server) => ({
          environment_id: id, label: id, url: server.url, status: "registered", roles: [],
        });
        const data = [registration("primary", primary), registration("witness", witness)];
        if (fleetState === "removed") data.push(registration("witness-alias", witness));
        else data.push({
          ...registration("linked", linked), instance_id: 19, instance_name: "Linked instance", power_state: fleetState,
        });
        return Response.json({ data });
      }
      case "api/v1/conn/environments/linked/pairings":
      case "api/v1/conn/environments/witness/pairings": {
        const id = step.split("/").at(-2);
        if (id === "linked" && fleetState !== "running") {
          sleepingConnectionAttempts++;
          return new Response(null, { status: 403 });
        }
        return Response.json({ data: {
          pairing_url: (id === "linked" ? linked : witness).url + "#token=test", pairing: { environment_id: id },
        } });
      }
      case "saved": await waitForSavedInventories(); break;
      case "sleep": fleetState = "stopped"; break;
      case "discover-sleeping": releaseDiscovery.resolve(); break;
      case "wake-machine":
        wakeCount++;
        fleetState = "running";
        primary.closeSocket();
        break;
      case "sleep-live":
        sleepingDriver = linked.socketId();
        fleetState = "stopped";
        primary.closeSocket();
        break;
      case "driver-stopped": await driverClosed.promise; break;
      case "remove-machine":
        fleetState = "removed";
        primary.closeSocket();
        break;
      case "api/v1/instances/19/wake":
        sleepingConnectionAttempts++;
        return new Response(null, { status: 403 });
      case "sleeping-connection-attempts": return new Response(String(sleepingConnectionAttempts));
      case "follow-up-project": return new Response(await followUp.promise);
      case "hold": held = Promise.all([primary.hold(), linked.hold()]); break;
      case "staged": await held; break;
      case "primary": primary.commit(); break;
      case "interrupt": await linked.interrupt(); break;
      case "linked": linked.commit(); break;
      case "start-pages": primary.startPaging(); linked.startPaging(); break;
      case "interrupt-paging": await primary.interrupt(); break;
      case "resume-paging": primary.startPaging("2026-11-24T01:00:00Z"); break;
      case "primary-page": await primary.finishPage(); break;
      case "linked-page": await linked.finishPage(); break;
      case "backfill": {
        primary.backfill("d");
        const db = new Database(simulatorSupportDirectory() + "/thread-cache/messages.sqlite3", { readonly: true });
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
        pendingRuntimeRequest: { id: "approve", kind: "command", createdAt: "2026-11-25T11:00:00Z" } }); break;
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
const test = { inventory: "testAtomicThreadInventory", "child-project": "testChildArtifactFollowUpProject",
  sleeping: "testSavedSleepingMachineInventory" }[scenario];
if (!test) throw new Error("Unknown inventory scenario " + scenario);
const child = spawn("xcodebuild", ["test", "-project", "apps/ios/Conn.xcodeproj", "-scheme", "Conn",
  "-destination", "id=" + device, "-derivedDataPath", "apps/ios/build/DerivedData",
  "-parallel-testing-enabled", "NO",
  "-only-testing:ConnUITests/ConnSpikeUITests/" + test,
  "CODE_SIGN_IDENTITY=-"], { cwd: root, stdio: "inherit", env: { ...process.env,
    TEST_RUNNER_CONN_INVENTORY_FIXTURE: control.url.href,
    TEST_RUNNER_CONN_PAIRING_URL: primary.url + "#token=test",
    TEST_RUNNER_CONN_LINKED_PAIRING_URL: linked.url + "#token=test",
  } });
child.on("exit", (code) => process.exit(code ?? 1));
