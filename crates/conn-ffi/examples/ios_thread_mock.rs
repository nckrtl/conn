//! A scripted conn server for checking the iOS thread view in the simulator.
//!
//! `cargo run -p conn-ffi --example ios_thread_mock -- <port> [skew_ms]`
//!
//! Threads: `mock-long` (40 idle turns) and `mock-agents` (a running turn whose two agents exist
//! only as projection records). The server's clock runs `skew_ms` ahead of the Mac's.
//! Controls (HTTP GET):
//! - `/control/delays?ack=<ms>&echo=<ms>&fail=<0|1>&upload=<ms>`: how a reply is uploaded,
//!   acknowledged and echoed.
//! - `/control/stream?seconds=<s>&hz=<n>`: a turn on `mock-long`: tool, text streaming, tool.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use conn_wire::{
    Exit, FromClient, FromServer, RequestId, decode_client_message, encode_server_frame,
};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const LONG: &str = "mock-long";
const AGENTS: &str = "mock-agents";

struct Shared {
    out: Option<mpsc::UnboundedSender<FromServer>>,
    streams: HashMap<String, RequestId>,
    sequence: i64,
    ack_ms: u64,
    echo_ms: u64,
    upload_ms: u64,
    fail: bool,
    skew_ms: i64,
    templates: Value,
    runs: u64,
}

type State = Arc<Mutex<Shared>>;

fn server_now(state: &State) -> i64 {
    let skew = state.lock().map(|s| s.skew_ms).unwrap_or(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    now + skew
}

fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

fn shell_row(id: &str, title: &str, status: &str, now: &str) -> Value {
    json!({
        "createdBy": "user", "creationSource": "web", "id": id, "projectId": "p1",
        "title": title, "providerInstanceId": "claudeAgent",
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-opus-5-5" },
        "runtimeMode": "full-access", "interactionMode": "default", "branch": "main",
        "worktreePath": null,
        "lineage": { "rootThreadId": id, "parentThreadId": null, "relationshipToParent": null },
        "forkedFrom": null, "activeProviderThreadId": null, "latestRunId": null,
        "activeRunId": null, "status": status, "pendingRuntimeRequest": null,
        "latestVisibleMessage": null, "latestUserMessageAt": null,
        "hasActionableProposedPlan": false, "itemCount": 0, "visibleItemCount": 0,
        "createdAt": now, "updatedAt": now, "archivedAt": null, "settledOverride": null,
        "settledAt": null, "deletedAt": null
    })
}

fn synthetic(turns: usize) -> Value {
    let raw =
        conn_state::testkit::synthetic_thread_snapshot_json(conn_state::testkit::SyntheticThread {
            turns,
            commands_per_turn: 2,
            command_output_bytes: 400,
            assistant_bytes: 900,
        });
    serde_json::from_str(&raw).unwrap_or_default()
}

fn thread_snapshot(state: &State, id: &str) -> Option<Value> {
    let now = server_now(state);
    let mut snap = match id {
        LONG => {
            let mut snap = synthetic(40);
            // Idle until a control starts a turn.
            snap["projection"]["runs"][0]["status"] = json!("completed");
            snap["projection"]["runs"][0]["completedAt"] = json!(iso(now - 3_600_000));
            snap
        }
        AGENTS => {
            let mut snap = synthetic(2);
            let projection = &mut snap["projection"];
            let run = projection["runs"][0]["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            projection["runs"][0]["status"] = json!("running");
            projection["runs"][0]["completedAt"] = Value::Null;
            projection["runs"][0]["workStartedAt"] = json!(iso(now - 95_000));
            let agent = |sid: &str, title: &str, status: &str, started: i64| {
                json!({
                    "id": sid, "threadId": AGENTS, "runId": run, "parentNodeId": "node:parent",
                    "origin": "app_owned", "createdBy": "agent", "driver": "codex",
                    "providerInstanceId": "codex", "providerThreadId": null,
                    "childThreadId": format!("child-{sid}"), "remoteChild": null,
                    "nativeTaskRef": null, "prompt": "Review the feed", "title": title,
                    "model": "gpt-5.5", "modelSelection": null, "executedModel": null,
                    "completionWake": null, "completionDelivery": null, "cancelledRunId": null,
                    "status": status, "progress": null, "workflow": null, "result": null,
                    "startedAt": iso(started), "completedAt": null, "updatedAt": iso(started)
                })
            };
            projection["subagents"] = json!([
                agent("agent-a", "Scroll review", "running", now - 60_000),
                agent("agent-b", "Data review", "completed", now - 50_000),
            ]);
            snap
        }
        _ => return None,
    };
    snap["projection"]["thread"]["id"] = json!(id);
    if let Ok(mut s) = state.lock() {
        s.sequence = s
            .sequence
            .max(snap["snapshotSequence"].as_i64().unwrap_or(0));
    }
    Some(snap)
}

fn send(state: &State, frame: FromServer) {
    if let Some(out) = state.lock().ok().and_then(|s| s.out.clone()) {
        let _ = out.send(frame);
    }
}

/// Pushes one domain event to `thread`'s open stream.
fn push_event(state: &State, thread: &str, kind: &str, run: Option<&str>, payload: Value) {
    let now = iso(server_now(state));
    let (request, sequence) = {
        let Ok(mut s) = state.lock() else { return };
        s.sequence += 1;
        (s.streams.get(thread).cloned(), s.sequence)
    };
    let Some(request_id) = request else { return };
    let event = json!({"kind": "event", "sequence": sequence, "event": {
        "id": format!("event:mock:{sequence}"), "type": kind, "threadId": thread,
        "runId": run, "occurredAt": now, "payload": payload
    }});
    send(
        state,
        FromServer::Chunk {
            request_id,
            values: vec![event],
        },
    );
}

/// A turn item template: `user`, `tool` or `text`.
fn template(state: &State, kind: &str) -> Value {
    state
        .lock()
        .map(|s| s.templates[kind]["item"].clone())
        .unwrap_or(Value::Null)
}

fn item(state: &State, kind: &str, id: &str, run: &str, edit: impl FnOnce(&mut Value)) -> Value {
    let now = iso(server_now(state));
    let mut item = template(state, kind);
    item["id"] = json!(id);
    item["threadId"] = json!(LONG);
    item["runId"] = json!(run);
    item["startedAt"] = json!(now);
    item["updatedAt"] = json!(now);
    item["completedAt"] = Value::Null;
    if let Some(object) = item.as_object_mut() {
        object.remove("textOmitted");
    }
    edit(&mut item);
    item
}

fn run_object(state: &State, id: &str, status: &str, work_started: i64, ordinal: i64) -> Value {
    let mut run = state
        .lock()
        .map(|s| s.templates["run"].clone())
        .unwrap_or(Value::Null);
    run["id"] = json!(id);
    run["status"] = json!(status);
    run["ordinal"] = json!(ordinal);
    run["startedAt"] = json!(iso(work_started));
    run["workStartedAt"] = json!(iso(work_started));
    run["completedAt"] = if status == "completed" {
        json!(iso(server_now(state)))
    } else {
        Value::Null
    };
    run
}

/// A turn on `mock-long`: a tool, streamed text, another tool.
async fn stream_turn(state: State, seconds: u64, hz: u64) {
    let n = state.lock().map(|mut s| {
        s.runs += 1;
        s.runs
    });
    let n = n.unwrap_or(1);
    let run = format!("run:mock-live-{n}");
    let start = server_now(&state);
    let ordinal = 100 + n as i64;
    push_event(
        &state,
        LONG,
        "run.updated",
        Some(&run),
        run_object(&state, &run, "running", start, ordinal),
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let tool = |id: &str, status: &str| {
        item(&state, "tool", id, &run, |item| {
            item["status"] = json!(status);
            item["input"] = json!(format!("rg --files {id}"));
            item["ordinal"] = json!(9_000_000 + ordinal * 100 + id.len() as i64);
        })
    };
    let tool_a = format!("turn-item:mock-tool-a-{n}");
    push_event(
        &state,
        LONG,
        "turn-item.updated",
        Some(&run),
        tool(&tool_a, "running"),
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let mut done = tool(&tool_a, "completed");
    done["completedAt"] = json!(iso(server_now(&state)));
    push_event(&state, LONG, "turn-item.updated", Some(&run), done);
    let text_id = format!("turn-item:mock-text-{n}");
    let words = "The feed keeps the run's clock while **text streams** between tool batches, and the \
        `WorkingFold` row counts from the run's start.\n\n- The pump marks the thread changed.\n\
        - It builds one snapshot per window.\n- Equal snapshots stay home.\n\nThen `MarkdownView` \
        reuses the blocks it already parsed, so a long reply costs one paragraph per update.\n\n";
    let ticks = seconds * hz;
    for tick in 0..ticks {
        let text: String = words
            .chars()
            .cycle()
            .take(20 + tick as usize * 12)
            .collect();
        let mut text_item = item(&state, "text", &text_id, &run, |item| {
            item["text"] = json!(text);
            item["status"] = json!("running");
            item["streaming"] = json!(true);
            item["ordinal"] = json!(9_000_000 + ordinal * 100 + 50);
        });
        if tick + 1 == ticks {
            text_item["status"] = json!("completed");
            text_item["streaming"] = json!(false);
        }
        push_event(&state, LONG, "turn-item.updated", Some(&run), text_item);
        tokio::time::sleep(Duration::from_millis(1000 / hz.max(1))).await;
    }
    let tool_c = format!("turn-item:mock-tool-c-{n}");
    push_event(
        &state,
        LONG,
        "turn-item.updated",
        Some(&run),
        tool(&tool_c, "running"),
    );
    tokio::time::sleep(Duration::from_millis(3000)).await;
    let mut done = tool(&tool_c, "completed");
    done["completedAt"] = json!(iso(server_now(&state)));
    push_event(&state, LONG, "turn-item.updated", Some(&run), done);
    push_event(
        &state,
        LONG,
        "run.updated",
        Some(&run),
        run_object(&state, &run, "completed", start, ordinal),
    );
}

/// A reply: acknowledged after `ack_ms`, its row pushed after `echo_ms`, independently.
fn dispatch(state: &State, request_id: RequestId, command: Value) {
    let (ack_ms, echo_ms, fail) = state
        .lock()
        .map(|s| (s.ack_ms, s.echo_ms, s.fail))
        .unwrap_or((0, 0, false));
    println!(
        "dispatch {} ack={ack_ms}ms echo={echo_ms}ms fail={fail}",
        command["type"]
    );
    let ack_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ack_ms)).await;
        let exit = if fail {
            Exit::fail(
                json!({"_tag": "OrchestrationDispatchCommandError", "message": "Mock refused the message."}),
            )
        } else {
            Exit::success(json!({"sequence": 0}))
        };
        send(&ack_state, FromServer::Exit { request_id, exit });
    });
    if fail || command["type"] != "message.dispatch" {
        return;
    }
    let echo_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(echo_ms)).await;
        let thread = command["threadId"].as_str().unwrap_or(LONG).to_owned();
        let message = command["messageId"]
            .as_str()
            .unwrap_or("message-x")
            .to_owned();
        let now = iso(server_now(&echo_state));
        let mut row = template(&echo_state, "user");
        row["id"] = json!(format!("turn-item:{message}"));
        row["messageId"] = json!(message);
        row["threadId"] = json!(thread);
        row["text"] = command["text"].clone();
        row["attachments"] = command["attachments"].clone();
        row["createdBy"] = json!("user");
        row["creationSource"] = json!("mobile");
        row["ordinal"] = json!(9_900_000);
        row["startedAt"] = json!(now);
        row["updatedAt"] = json!(now);
        if let Some(object) = row.as_object_mut() {
            object.remove("textOmitted");
        }
        push_event(&echo_state, &thread, "turn-item.updated", None, row);
    });
}

fn handle_request(state: &State, request: conn_wire::Request) {
    let id = request.id.clone();
    let chunk = |values: Vec<Value>| FromServer::Chunk {
        request_id: id.clone(),
        values,
    };
    match request.tag.as_str() {
        "subscribeServerConfig" => {
            let mut config: Value = serde_json::from_str(include_str!(
                "../../conn-state/tests/fixtures/server-config-snapshot.json"
            ))
            .unwrap_or_default();
            config["config"]["serverTime"] = json!(iso(server_now(state)));
            send(state, chunk(vec![config]));
        }
        "orchestration.subscribeShell" => {
            let now = iso(server_now(state));
            send(
                state,
                chunk(vec![
                    json!({"kind": "snapshot", "snapshot": {
                        "schemaVersion": 1, "snapshotSequence": 1,
                        "projects": [{"id": "p1", "title": "Mock", "workspaceRoot": "/tmp/mock",
                            "defaultModelSelection": {"instanceId": "claudeAgent", "model": "claude-opus-5-5"},
                            "scripts": [], "createdAt": now, "updatedAt": now, "archivedAt": null}],
                        "threads": [shell_row(LONG, "Long thread", "idle", &now),
                                    shell_row(AGENTS, "Agents at work", "running", &now)],
                        "archivedThreads": []
                    }}),
                    json!({"kind": "synchronized"}),
                ]),
            );
        }
        "orchestration.subscribeThread" => {
            let thread = request.payload["threadId"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            match thread_snapshot(state, &thread) {
                Some(snapshot) => {
                    if let Ok(mut s) = state.lock() {
                        s.streams.insert(thread.clone(), id.clone());
                    }
                    send(
                        state,
                        chunk(vec![snapshot, json!({"kind": "synchronized"})]),
                    );
                }
                None => send(
                    state,
                    FromServer::Exit {
                        request_id: id,
                        exit: Exit::fail(json!({"_tag": "NotFound", "message": "no such thread"})),
                    },
                ),
            }
        }
        "orchestration.dispatchCommand" => dispatch(state, id, request.payload),
        "attachments.createUploadUrl" => {
            let attachment = format!("att-{}", server_now(state));
            send(
                state,
                FromServer::Exit {
                    request_id: id,
                    exit: Exit::success(json!({
                        "attachmentId": attachment, "relativeUrl": format!("/upload/{attachment}"),
                        "expiresAt": server_now(state) + 600_000
                    })),
                },
            );
        }
        tag if tag.contains("subscribe") || tag.starts_with("subscribe") => {
            println!("stream left open: {tag}");
        }
        tag => {
            println!("unary answered with null: {tag}");
            send(
                state,
                FromServer::Exit {
                    request_id: id,
                    exit: Exit::success(Value::Null),
                },
            );
        }
    }
}

async fn websocket(state: State, stream: TcpStream) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<FromServer>();
    if let Ok(mut s) = state.lock() {
        s.out = Some(tx.clone());
        s.streams.clear();
    }
    println!("client connected");
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink
                .send(Message::Text(encode_server_frame(&frame).into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    while let Some(Ok(message)) = source.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(frames) = decode_client_message(&text) else {
            continue;
        };
        for frame in frames {
            match frame {
                FromClient::Request(request) => handle_request(&state, request),
                FromClient::Ping => {
                    let _ = tx.send(FromServer::Pong);
                }
                FromClient::Interrupt { request_id } => {
                    if let Ok(mut s) = state.lock() {
                        s.streams.retain(|_, id| *id != request_id);
                    }
                    let _ = tx.send(FromServer::Exit {
                        request_id,
                        exit: Exit::interrupt(),
                    });
                }
                _ => {}
            }
        }
    }
    println!("client disconnected");
}

fn query(path: &str, key: &str) -> Option<u64> {
    path.split(['?', '&'])
        .find_map(|pair| pair.strip_prefix(&format!("{key}=")))
        .and_then(|v| v.parse().ok())
}

async fn http(state: State, mut stream: TcpStream) {
    let mut buf = vec![0; 64 * 1024];
    let Ok(n) = stream.read(&mut buf).await else {
        return;
    };
    let head = String::from_utf8_lossy(&buf[..n]).to_string();
    let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
    if let Some(length) = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().to_owned())
        })
        .and_then(|v| v.parse::<usize>().ok())
    {
        let body_start = head.find("\r\n\r\n").map_or(n, |i| i + 4);
        let mut have = n.saturating_sub(body_start);
        while have < length {
            let Ok(more) = stream.read(&mut buf).await else {
                break;
            };
            if more == 0 {
                break;
            }
            have += more;
        }
    }
    if path.starts_with("/upload") {
        let wait = state.lock().map(|s| s.upload_ms).unwrap_or(0);
        tokio::time::sleep(Duration::from_millis(wait)).await;
    }
    let body = if path.starts_with("/.well-known/t3/environment") {
        json!({"environmentId": "mock-env", "label": "Mock"}).to_string()
    } else if path.starts_with("/oauth/token") {
        json!({"access_token": "mock-token", "token_type": "Bearer"}).to_string()
    } else if path.starts_with("/control/delays") {
        if let Ok(mut s) = state.lock() {
            s.ack_ms = query(&path, "ack").unwrap_or(s.ack_ms);
            s.echo_ms = query(&path, "echo").unwrap_or(s.echo_ms);
            s.fail = query(&path, "fail").map_or(s.fail, |v| v == 1);
            s.upload_ms = query(&path, "upload").unwrap_or(s.upload_ms);
        }
        "ok".to_owned()
    } else if path.starts_with("/control/stream") {
        let seconds = query(&path, "seconds").unwrap_or(10);
        let hz = query(&path, "hz").unwrap_or(20);
        tokio::spawn(stream_turn(state.clone(), seconds, hz));
        "streaming".to_owned()
    } else {
        String::new()
    };
    println!("http {path}");
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|p| p.parse().ok()).unwrap_or(39_471);
    let skew_ms: i64 = args.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let long = synthetic(1);
    let rows = &long["projection"]["visibleTurnItems"];
    let state: State = Arc::new(Mutex::new(Shared {
        out: None,
        streams: HashMap::new(),
        sequence: 1,
        ack_ms: 2500,
        echo_ms: 1200,
        upload_ms: 0,
        fail: false,
        skew_ms,
        // One turn of two commands: user, tool, tool, text.
        templates: json!({"user": rows[0], "tool": rows[1], "text": rows[3], "run": long["projection"]["runs"][0]}),
        runs: 0,
    }));
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("mock listening on http://127.0.0.1:{port} (server clock {skew_ms:+} ms)");
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let state = state.clone();
        tokio::spawn(async move {
            let mut peek = [0u8; 2048];
            let n = stream.peek(&mut peek).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&peek[..n]).to_ascii_lowercase();
            if head.contains("upgrade: websocket") {
                websocket(state, stream).await;
            } else {
                http(state, stream).await;
            }
        });
    }
}
