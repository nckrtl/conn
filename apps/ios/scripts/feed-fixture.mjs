// PORT=47941 bun apps/ios/scripts/feed-fixture.mjs .   (from the repo root)
// A disposable Conn server for the thread feed's scroll proofs (ConnUITests/FeedScrollUITests).
// Threads: "feed" (30 finished turns), "tall" (14 turns of long replies, with a tall image in
// every other question, the last one in view) and "stream" (20 finished turns, then a running turn whose reply
// streams), plus filler. The test drives the stream over HTTP, so growth is deterministic:
//   GET /grow?lines=N   appends N lines to the streaming reply and pushes a snapshot
//   GET /add            appends a new streaming reply after the current one (a new feed row)
//   GET /reset          starts over
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const root = process.argv[2];
const read = (p) => JSON.parse(readFileSync(root + "/crates/conn-state/tests/fixtures/" + p, "utf8"));
const base = read("shell_thread_updates.json")[0].thread;
const stream = read("thread_turn_stream.json")[0];
const marker = { kind: "synchronized" };

const projects = ["conn", "orbit"].map((name) => ({
  id: "project-" + name, title: name, workspaceRoot: "/tmp/" + name, scripts: [],
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
}));
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const threadDefs = [
  { id: "feed", title: "Feed: long finished thread", pairs: 30, running: false },
  { id: "stream", title: "Feed: streaming reply", pairs: 20, running: true },
  { id: "tall", title: "Feed: tall rows and images", pairs: 14, running: false, tall: true },
  ...Array.from({ length: 4 }, (_, i) => ({ id: "f" + i, title: "Filler thread " + i, pairs: 2, running: false })),
];
const threads = threadDefs.map((def, i) => {
  const at = iso(now - i * 7 * 60_000);
  return {
    ...base, id: def.id, title: def.title, projectId: projects[i % projects.length].id, branch: "feat/feed-" + i,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: def.id },
    createdAt: at, updatedAt: at, latestRunCompletedAt: at, settledAt: null,
    status: def.running ? "running" : "idle",
  };
});

const projections = new Map();
const sequences = new Map();
const subscribers = new Map();
let streamLines = 0;
let extraReplies = 0;

// A 300 x 900 PNG, so a loaded image is taller than the 4:3 tile it shows before it loads.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (y * 255 / height) | 0;
      raw[row + 2 + x * 3] = 90;
      raw[row + 3 + x * 3] = (x * 255 / width) | 0;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const tallImage = png(300, 900);
const imageAttachment = (id) => ({ type: "image", id, name: "tall-" + id + ".png", mimeType: "image/png", sizeBytes: tallImage.length });

function message(run, id, role, text, at, threadId, streaming = false, attachments = []) {
  return { attachments, createdAt: at, createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider", id, nodeId: run.rootNodeId, role, runId: run.id,
    streaming, text, threadId, updatedAt: at };
}

function turnItem(run, mid, role, text, at, threadId, ordinal, streaming = false, attachments = []) {
  return { attachments, completedAt: streaming ? null : at, createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider", id: "turn-item:" + mid,
    inputIntent: role === "user" ? "turn_start" : undefined, messageId: mid, nativeItemRef: null,
    nodeId: run.rootNodeId, ordinal, parentItemId: null, providerThreadId: null,
    providerTurnId: null, runId: run.id, startedAt: at, status: streaming ? "running" : "completed", streaming,
    text, threadId, title: null, type: role + "_message", updatedAt: at };
}

const paragraph = (n) => "Reply " + n + ". This paragraph is long on purpose so the feed fills the screen. "
  + "Rows of different heights test that measuring a row never moves what the reader sees.";

function streamText(lines) {
  return Array.from({ length: lines }, (_, i) => "Streamed line " + (i + 1) + ": the agent keeps writing.").join("\n\n");
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
  let ordinal = 0;
  const total = def.pairs + (def.running ? 1 : 0);
  for (let n = 0; n < total; n++) {
    ordinal++;
    const runId = "run:" + id + ":" + n;
    const running = def.running && n === total - 1;
    // The running turn started 75 s ago, so "Working for" reads more than a minute.
    const at = running ? iso(Date.now() - 75_000) : iso(now - (total - n) * 3 * 60_000);
    const run = { ...template, id: runId, ordinal, status: running ? "running" : "completed",
      completedAt: running ? null : at, threadId: id, userMessageId: "u" + n, requestedAt: at, startedAt: at,
      queuePosition: null, rootNodeId: "node:" + runId + ":root" };
    p.runs.push(run);
    const user = "Question " + (n + 1) + (n % 3 === 0 ? ": how does the feed keep its place when rows above it change height and new rows land below?" : ": keep going.");
    const files = def.tall && n % 2 === 1 ? [imageAttachment("img" + n)] : [];
    p.messages.push(message(run, "u" + n, "user", user, at, id, false, files));
    p.turnItems.push(turnItem(run, "u" + n, "user", user, at, id, ordinal * 1000000 + 1, false, files));
    if (running) {
      const text = streamText(Math.max(1, streamLines));
      p.messages.push(message(run, "a" + n, "assistant", text, at, id, true));
      p.turnItems.push(turnItem(run, "a" + n, "assistant", text, at, id, ordinal * 1000000 + 2, true));
      for (let x = 0; x < extraReplies; x++) {
        const mid = "a" + n + "x" + x;
        const extra = "Extra reply " + (x + 1) + ": a new row under the streaming one.";
        p.messages.push(message(run, mid, "assistant", extra, at, id, true));
        p.turnItems.push(turnItem(run, mid, "assistant", extra, at, id, ordinal * 1000000 + 3 + x, true));
      }
    } else {
      // The last reply is short, so the last question and its image open in view.
      const tall = def.tall && n < total - 1;
      const points = tall ? 8 + (n % 5) * 3 : 1 + (n % 4);
      const body = tall ? [paragraph(n + 1), "", paragraph(n + 1), "", "```", ...Array.from({ length: 6 }, (_, k) => "line " + k + " of the code block"), "```", ""] : [paragraph(n + 1), ""];
      const reply = [...body, ...Array.from({ length: points }, (_, k) => "- Point " + (k + 1) + " of reply " + (n + 1) + ".")].join("\n");
      p.messages.push(message(run, "a" + n, "assistant", reply, at, id));
      p.turnItems.push(turnItem(run, "a" + n, "assistant", reply, at, id, ordinal * 1000000 + 2));
    }
  }
  p.visibleTurnItems = [];
  return p;
}

function snapshot(id) {
  if (!projections.has(id)) {
    projections.set(id, buildProjection(id));
    sequences.set(id, sequences.get(id) ?? 1);
  }
  return { kind: "snapshot", snapshotSequence: sequences.get(id), projection: projections.get(id) };
}

function push(id) {
  projections.delete(id);
  sequences.set(id, (sequences.get(id) ?? 1) + 1);
  for (const sub of subscribers.get(id) ?? []) {
    try {
      sub.ws.send(JSON.stringify({ _tag: "Chunk", requestId: sub.requestId, values: [snapshot(id)] }));
    } catch {}
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT ?? 0),
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/ws" && server.upgrade(req)) return;
    if (path === "/reset") {
      projections.clear();
      streamLines = 0;
      extraReplies = 0;
      return Response.json({ ok: true });
    }
    if (path === "/grow") {
      streamLines += Number(url.searchParams.get("lines") ?? 1);
      push("stream");
      return Response.json({ lines: streamLines });
    }
    if (path === "/add") {
      extraReplies += 1;
      push("stream");
      return Response.json({ extra: extraReplies });
    }
    if (path.startsWith("/assets/")) return new Response(tallImage, { headers: { "content-type": "image/png" } });
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
        if (frame.tag === "orchestration.subscribeShell") {
          chunk({ kind: "snapshot", snapshot: { schemaVersion: 1, snapshotSequence: 1, projects, threads, archivedThreads: [] } });
        } else if (frame.tag === "orchestration.subscribeThread") {
          const id = frame.payload.threadId;
          const list = (subscribers.get(id) ?? []).filter((s) => s.ws !== ws);
          list.push({ ws, requestId: frame.id });
          subscribers.set(id, list);
          chunk(snapshot(id));
        } else if (frame.tag === "assets.createUrl") {
          const value = { relativeUrl: "/assets/" + frame.payload.resource.attachmentId, expiresAt: Date.now() + 3_600_000 };
          ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value } }));
        } else if (frame.tag === "orchestration.dispatchCommand") {
          ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: 1 } } }));
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
