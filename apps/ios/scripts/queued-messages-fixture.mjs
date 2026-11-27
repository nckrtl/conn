// PORT=47931 bun apps/ios/scripts/queued-messages-fixture.mjs .   (from the repo root)
// A disposable Conn server for the queued-messages proof. Based on the header-evidence fixture.
// Threads: "qbusy" (a running turn and four queued messages) and "qidle" (stopped, one held
// queued message), plus filler. It serves queued-run.cancel / .edit / .start and
// queued-message.promote-to-steer by changing the projection and pushing a new snapshot.
// GET /commands lists every dispatched command and GET /reset starts over. An edit whose text
// contains "[fail]" is refused.
import { readFileSync } from "node:fs";

const root = process.argv[2];
const read = (p) => JSON.parse(readFileSync(root + "/crates/conn-state/tests/fixtures/" + p, "utf8"));
const base = read("shell_thread_updates.json")[0].thread;
const stream = read("thread_turn_stream.json")[0];
const marker = { kind: "synchronized" };

const projects = ["conn", "orbit", "mealou"].map((name) => ({
  id: "project-" + name, title: name, workspaceRoot: "/tmp/" + name, scripts: [],
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
}));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const threadDefs = [
  { id: "qbusy", title: "Queued: running turn", running: true, queued: 4 },
  { id: "qidle", title: "Queued: stopped thread", running: false, queued: 1 },
  ...Array.from({ length: 6 }, (_, i) => ({ id: "t" + i, title: "Filler thread " + i, running: false, queued: 0 })),
];
const threads = threadDefs.map((def, i) => {
  const at = iso(now - i * 7 * 60_000);
  return {
    ...base, id: def.id, title: def.title, projectId: projects[i % projects.length].id, branch: "feat/queue-" + i,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: def.id },
    createdAt: at, updatedAt: at, latestRunCompletedAt: at, settledAt: null,
    status: def.running ? "running" : "idle",
  };
});

const queuedTexts = [
  "Check dark mode on Polar.",
  "Then run the simulator UI test and attach the screenshots.",
  "Rebase onto integrate when it's green.",
  "Push the branch and report the head SHA.",
];

const projections = new Map();
const sequences = new Map();
const subscribers = new Map(); // threadId -> [{ ws, requestId }]
const commands = [];

function message(p, run, id, role, text, at, threadId) {
  return { attachments: [], createdAt: at, createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider", id, nodeId: run.rootNodeId, role, runId: run.id,
    streaming: false, text, threadId, updatedAt: at };
}

function turnItem(run, mid, role, text, at, threadId, ordinal, status = "completed") {
  return { attachments: [], completedAt: status === "completed" ? at : null, createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider", id: "turn-item:" + mid,
    inputIntent: role === "user" ? "turn_start" : undefined, messageId: mid, nativeItemRef: null,
    nodeId: run.rootNodeId, ordinal, parentItemId: null, providerThreadId: null,
    providerTurnId: null, runId: run.id, startedAt: at, status, streaming: false, text, threadId,
    title: null, type: role + "_message", updatedAt: at };
}

function buildProjection(id) {
  const def = threadDefs.find((t) => t.id === id) ?? threadDefs[2];
  const thread = threads.find((t) => t.id === def.id);
  const p = structuredClone(stream.projection);
  const template = p.runs[0];
  Object.assign(p.thread, { id: def.id, title: thread.title, projectId: thread.projectId, branch: thread.branch });
  p.turnItems = [];
  p.messages = [];
  p.runs = [];
  p.subagents = [];
  const pairs = 3;
  let ordinal = 0;
  for (let n = 0; n < pairs; n++) {
    ordinal++;
    const runId = "run:" + id + ":" + n;
    const at = iso(now - (pairs - n) * 3 * 60_000);
    const last = n === pairs - 1;
    const running = last && def.running;
    const run = { ...template, id: runId, ordinal, status: running ? "running" : "completed",
      completedAt: running ? null : at, threadId: id, userMessageId: "u" + n, requestedAt: at, startedAt: at,
      queuePosition: null, rootNodeId: "node:" + runId + ":root" };
    p.runs.push(run);
    const user = n === 0 ? "Make queued messages on mobile look like desktop." : "Step " + (n + 1) + ": keep going.";
    p.messages.push(message(p, run, "u" + n, "user", user, at, id));
    p.turnItems.push(turnItem(run, "u" + n, "user", user, at, id, ordinal * 1000000 + 1));
    if (!running) {
      const reply = "Done with step " + (n + 1) + ". The queued rows now follow the desktop layout.";
      p.messages.push(message(p, run, "a" + n, "assistant", reply, at, id));
      p.turnItems.push(turnItem(run, "a" + n, "assistant", reply, at, id, ordinal * 1000000 + 2));
    }
  }
  for (let q = 0; q < def.queued; q++) {
    ordinal++;
    const runId = "run:" + id + ":q" + q;
    const at = iso(now - (def.queued - q) * 20_000);
    const run = { ...template, id: runId, ordinal, status: "queued", completedAt: null, startedAt: null,
      activeAttemptId: null, threadId: id, userMessageId: "qm" + q, requestedAt: at, queuePosition: q,
      queueHeld: def.running ? false : true, rootNodeId: "node:" + runId + ":root" };
    p.runs.push(run);
    p.messages.push(message(p, run, "qm" + q, "user", queuedTexts[q % queuedTexts.length], at, id));
  }
  p.visibleTurnItems = [];
  return p;
}

function projection(id) {
  if (!projections.has(id)) {
    projections.set(id, buildProjection(id));
    sequences.set(id, 1);
  }
  return projections.get(id);
}

function snapshot(id) {
  return { kind: "snapshot", snapshotSequence: sequences.get(id) ?? 1, projection: projection(id) };
}

function push(id) {
  sequences.set(id, (sequences.get(id) ?? 1) + 1);
  for (const sub of subscribers.get(id) ?? []) {
    try {
      sub.ws.send(JSON.stringify({ _tag: "Chunk", requestId: sub.requestId, values: [snapshot(id)] }));
    } catch {}
  }
}

/// Moves the queued run's message into `targetRun` as a started user message.
function startMessage(p, queued, targetRun, at) {
  const msg = p.messages.find((m) => m.id === queued.userMessageId);
  const maxOrdinal = Math.max(0, ...p.turnItems.map((t) => t.ordinal));
  msg.runId = targetRun.id;
  p.turnItems.push(turnItem(targetRun, msg.id, "user", msg.text, at, p.thread.id, maxOrdinal + 1, "completed"));
}

function apply(cmd) {
  const id = cmd.threadId;
  const p = projection(id);
  const at = iso(Date.now());
  switch (cmd.type) {
    case "queued-run.cancel": {
      const run = p.runs.find((r) => r.id === cmd.runId && r.status === "queued");
      if (!run) return "Queued run " + cmd.runId + " does not exist.";
      run.status = "cancelled";
      run.completedAt = at;
      p.messages = p.messages.filter((m) => m.id !== run.userMessageId);
      return null;
    }
    case "queued-run.edit": {
      if (String(cmd.text).includes("[fail]")) return "Fixture refused the edit.";
      const run = p.runs.find((r) => r.id === cmd.runId && r.status === "queued");
      if (!run) return "Queued run " + cmd.runId + " does not exist.";
      const msg = p.messages.find((m) => m.id === run.userMessageId);
      msg.text = cmd.text;
      if (cmd.attachments) msg.attachments = cmd.attachments;
      msg.updatedAt = at;
      return null;
    }
    case "queued-run.start": {
      const run = p.runs.find((r) => r.id === cmd.runId && r.status === "queued");
      if (!run) return "Queued run " + cmd.runId + " does not exist.";
      run.status = "running";
      run.startedAt = at;
      run.queuePosition = null;
      run.queueHeld = false;
      startMessage(p, run, run, at);
      return null;
    }
    case "queued-message.promote-to-steer": {
      const queued = p.runs.find((r) => r.id === cmd.queuedRunId && r.status === "queued");
      const target = p.runs.find((r) => r.id === cmd.targetRunId && r.status === "running");
      if (!queued || !target) return "Nothing to promote.";
      queued.status = "cancelled";
      queued.completedAt = at;
      startMessage(p, queued, target, at);
      return null;
    }
    default:
      return null;
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 0),
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/ws" && server.upgrade(req)) return;
    if (path === "/commands") return Response.json(commands);
    if (path === "/reset") {
      projections.clear();
      sequences.clear();
      commands.length = 0;
      return Response.json({ ok: true });
    }
    if (path.endsWith("/outline")) return Response.json({ snapshotSequence: 1, markers: [] });
    if (path === "/api/auth/session") return Response.json({ authenticated: true });
    if (path === "/oauth/token") return Response.json({ access_token: "fixture" });
    if (path === "/.well-known/t3/environment") return Response.json({ environmentId: "primary" });
    if (path === "/api/v1/conn/me") return Response.json({ data: { id: 1, name: "phone", wireguard_ip: "127.0.0.1" } });
    if (path === "/api/v1/conn/environments") return Response.json({ data: [] });
    console.log("404", path);
    return new Response(null, { status: 404 });
  },
  websocket: {
    message(ws, text) {
      for (const frame of [JSON.parse(text)].flat()) {
        if (frame._tag === "Ping") { ws.send(JSON.stringify({ _tag: "Pong" })); continue; }
        if (frame._tag !== "Request") continue;
        const chunk = (value) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: frame.id, values: [value, marker] }));
        const exit = (exit) => ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit }));
        if (frame.tag === "orchestration.subscribeShell") {
          chunk({ kind: "snapshot", snapshot: { schemaVersion: 1, snapshotSequence: 1, projects, threads, archivedThreads: [] } });
        } else if (frame.tag === "orchestration.subscribeThread") {
          const id = frame.payload.threadId;
          const list = (subscribers.get(id) ?? []).filter((s) => s.ws !== ws);
          list.push({ ws, requestId: frame.id });
          subscribers.set(id, list);
          chunk(snapshot(id));
        } else if (frame.tag === "orchestration.dispatchCommand") {
          const cmd = frame.payload;
          commands.push(cmd);
          console.log("command", cmd.type, JSON.stringify(cmd));
          const refused = apply(cmd);
          if (refused) {
            exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationDispatchCommandError", message: refused } }] });
          } else {
            exit({ _tag: "Success", value: { sequence: (sequences.get(cmd.threadId) ?? 1) + 1 } });
            push(cmd.threadId);
          }
        } else {
          console.log("unhandled", frame.tag);
        }
      }
    },
    close(ws) {
      for (const [id, list] of subscribers) subscribers.set(id, list.filter((s) => s.ws !== ws));
    },
  },
});
console.log("fixture", server.url.href);
