//! The primary server restarts under a running app: the app reconnects by itself, a message sent
//! while the server was away goes through, the open thread loads again, and the offline cache's
//! watched threads resume from their cursors instead of all asking for a full snapshot again.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use conn_cache::MessageCache;
use conn_client::{ConnectionStatus, Credential, ServerConfig};
use conn_state::testkit::{SyntheticThread, synthetic_thread_snapshot_json};
use conn_wire::{Exit, FromClient, FromServer, Request, encode_server_frame};
use futures::{SinkExt, StreamExt};
use gpui_kit::{Entity, TestAppContext};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::ConnApp;
use crate::live::RT;
use crate::ui_tests::mount_app_with_server;

const OPEN: &str = "thread-open";
const WATCHED: [&str; 3] = [OPEN, "thread-a", "thread-b"];

/// One request the fake server saw, and the session (1 = before the restart) it came on.
#[derive(Clone, Debug)]
struct Seen {
    session: u8,
    tag: String,
    payload: Value,
}

struct FakeServer {
    url: url::Url,
    seen: std::sync::mpsc::Receiver<Seen>,
    /// While set, the server is "restarting": every socket is accepted and dropped at once.
    down: Arc<AtomicBool>,
    /// Bumping it drops every open session.
    restart: tokio::sync::watch::Sender<u64>,
}

fn thread_json(id: &str) -> Value {
    json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": id,
        "projectId": "proj-restart",
        "title": format!("Thread {id}"),
        "providerInstanceId": "claude-default",
        "modelSelection": { "provider": "claude", "model": "claude-sonnet-4-6" },
        "runtimeMode": "auto-accept-edits",
        "interactionMode": "default",
        "branch": "main",
        "worktreePath": null,
        "lineage": { "parentThreadId": null, "relationshipToParent": null, "rootThreadId": id },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": "run-1",
        "activeRunId": null,
        "activityRunStatus": null,
        "status": "completed",
        "pendingRuntimeRequest": null,
        "latestVisibleMessage": null,
        "latestUserMessageAt": "2026-11-26T22:00:00.000Z",
        "hasActionableProposedPlan": false,
        "itemCount": 2,
        "visibleItemCount": 2,
        "pinnedAt": null,
        "pinOrderKey": null,
        "settledOverride": null,
        "settledAt": null,
        "archivedAt": null,
        "lastVisitedAt": "2026-11-26T22:00:00.000Z",
        "createdAt": "2026-11-26T21:00:00.000Z",
        "updatedAt": "2026-11-26T22:00:00.000Z",
    })
}

fn shell_snapshot() -> Value {
    json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 10,
            "projects": [{
                "id": "proj-restart", "title": "restart", "workspaceRoot": "/tmp/restart",
                "defaultModelSelection": null, "scripts": [],
                "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-26T22:00:00.000Z"
            }],
            "threads": WATCHED.iter().map(|id| thread_json(id)).collect::<Vec<_>>(),
            "archivedThreads": []
        }
    })
}

/// A thread snapshot at `sequence` with `turns` user turns.
fn thread_snapshot(id: &str, sequence: i64, turns: usize) -> Value {
    let mut snapshot: Value =
        serde_json::from_str(&synthetic_thread_snapshot_json(SyntheticThread {
            turns,
            commands_per_turn: 0,
            command_output_bytes: 0,
            assistant_bytes: 40,
        }))
        .expect("synthetic snapshot");
    snapshot["snapshotSequence"] = json!(sequence);
    snapshot["projection"]["thread"]["id"] = json!(id);
    snapshot
}

fn reply(request: &Request, session: u8) -> Option<FromServer> {
    let chunk = |values: Vec<Value>| FromServer::Chunk {
        request_id: request.id.clone(),
        values,
    };
    match request.tag.as_str() {
        "orchestration.subscribeShell" => Some(chunk(vec![shell_snapshot()])),
        "orchestration.subscribeThread" => {
            let id = request.payload["threadId"].as_str().unwrap_or_default();
            // After the restart the open thread has a second turn.
            let turns = if session > 1 && id == OPEN { 2 } else { 1 };
            Some(chunk(vec![
                thread_snapshot(id, 20 + i64::from(session), turns),
                json!({ "kind": "synchronized" }),
            ]))
        }
        "orchestration.dispatchCommand" => Some(FromServer::Exit {
            request_id: request.id.clone(),
            exit: Exit::success(json!({ "sequence": 30 })),
        }),
        _ => None,
    }
}

fn spawn_fake_server() -> FakeServer {
    let (seen_tx, seen) = std::sync::mpsc::channel();
    let down = Arc::new(AtomicBool::new(false));
    let (restart, restarts) = tokio::sync::watch::channel(0_u64);
    let sessions = Arc::new(AtomicU8::new(0));
    let accept_down = Arc::clone(&down);
    let addr = RT.block_on(async move {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                if accept_down.load(Ordering::Acquire) {
                    drop(tcp);
                    continue;
                }
                let seen_tx = seen_tx.clone();
                let mut restarts = restarts.clone();
                restarts.mark_unchanged();
                let session = sessions.fetch_add(1, Ordering::AcqRel) + 1;
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    loop {
                        let text = tokio::select! {
                            _ = restarts.changed() => return,
                            message = ws.next() => match message {
                                Some(Ok(Message::Text(text))) => text,
                                Some(Ok(_)) => continue,
                                _ => return,
                            },
                        };
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            let answer = match frame {
                                FromClient::Ping => Some(FromServer::Pong),
                                FromClient::Request(request) => {
                                    let _ = seen_tx.send(Seen {
                                        session,
                                        tag: request.tag.clone(),
                                        payload: request.payload.clone(),
                                    });
                                    reply(&request, session)
                                }
                                _ => None,
                            };
                            if let Some(answer) = answer
                                && ws
                                    .send(Message::Text(encode_server_frame(&answer).into()))
                                    .await
                                    .is_err()
                            {
                                return;
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    FakeServer {
        url: url::Url::parse(&format!("http://{addr}")).expect("server URL"),
        seen,
        down,
        restart,
    }
}

/// Pumps the app until `done` holds, or fails after a while.
fn pump_until(
    cx: &mut TestAppContext,
    app: &Entity<ConnApp>,
    what: &str,
    mut done: impl FnMut(&ConnApp, &[Seen]) -> bool,
    seen: &mut Vec<Seen>,
    server: &FakeServer,
) {
    for _ in 0..1000 {
        cx.run_until_parked();
        seen.extend(server.seen.try_iter());
        if cx.read(|cx| done(app.read(cx), seen)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting until {what}; requests seen: {seen:#?}");
}

fn subscribes<'a>(seen: &'a [Seen], session: u8, thread: &str) -> Vec<&'a Seen> {
    seen.iter()
        .filter(|s| {
            s.session == session
                && s.tag == "orchestration.subscribeThread"
                && s.payload["threadId"] == thread
        })
        .collect()
}

fn entries(app: &ConnApp, thread: &str) -> usize {
    app.threads
        .get(thread)
        .map_or(0, |state| state.entries.len())
}

#[gpui_kit::test]
fn the_app_recovers_after_the_primary_server_restarts(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let server = spawn_fake_server();
    let (_window, app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: ServerConfig {
                http_base_url: server.url.clone(),
                credential: Credential::Bearer("test-token".to_owned()),
            },
            label: None,
            orbit_server_id: None,
        }),
    );
    // The offline cache watches every unsettled thread, as in the live app.
    let cache = tempfile::tempdir().expect("cache directory");
    let db = RT
        .block_on(MessageCache::open(&cache.path().join("messages.sqlite3")))
        .expect("cache");
    cx.update(|cx| {
        app.update(cx, |app, _| {
            app.offline.enable_for_test(cache.path().to_owned(), db);
        });
    });

    let mut seen = Vec::new();
    pump_until(
        cx,
        &app,
        "the shell lists the threads",
        |app, _| app.shell.find_thread(OPEN).is_some(),
        &mut seen,
        &server,
    );
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread(OPEN, cx)));
    pump_until(
        cx,
        &app,
        "every watched thread and the open one load",
        |app, seen| {
            WATCHED.iter().all(|id| !subscribes(seen, 1, id).is_empty()) && entries(app, OPEN) > 0
        },
        &mut seen,
        &server,
    );
    let before = cx.read(|cx| entries(app.read(cx), OPEN));

    // The server restarts: open sessions drop, and new sockets are refused for a while.
    server.down.store(true, Ordering::Release);
    server.restart.send_modify(|generation| *generation += 1);
    pump_until(
        cx,
        &app,
        "the app notices the server is gone",
        |app, _| matches!(app.status, Some(ConnectionStatus::Reconnecting { .. })),
        &mut seen,
        &server,
    );

    // A message sent while the server is away waits for it.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.send_prompt("sent while the server restarts".into(), cx);
        });
    });
    for _ in 0..30 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(10));
    }
    server.down.store(false, Ordering::Release);

    pump_until(
        cx,
        &app,
        "the app reconnects, the send goes through and the open thread loads again",
        |app, seen| {
            matches!(app.status, Some(ConnectionStatus::Connected))
                && seen.iter().any(|s| {
                    s.session > 1
                        && s.tag == "orchestration.dispatchCommand"
                        && s.payload
                            .to_string()
                            .contains("sent while the server restarts")
                })
                && entries(app, OPEN) > before
        },
        &mut seen,
        &server,
    );
    // Let the new session's shell reach the offline cache, which reconciles its watches.
    for _ in 0..50 {
        cx.run_until_parked();
        seen.extend(server.seen.try_iter());
        std::thread::sleep(Duration::from_millis(10));
    }

    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    assert_eq!(
        cx.read(|cx| chat.read(cx).error_for_test()),
        None,
        "the send shows no error"
    );
    let session = seen.iter().map(|s| s.session).max().unwrap_or(0);
    assert!(session > 1, "the app reconnected");
    for id in WATCHED {
        let resubscribes = subscribes(&seen, session, id);
        assert_eq!(
            resubscribes.len(),
            1,
            "{id} is resubscribed once after the restart, not refreshed again: {resubscribes:#?}"
        );
        assert!(
            resubscribes[0].payload.get("afterSequence").is_some(),
            "{id} resumes from its cursor: {:#?}",
            resubscribes[0]
        );
    }
}
