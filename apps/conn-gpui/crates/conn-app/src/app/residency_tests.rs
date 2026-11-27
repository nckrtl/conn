//! Thread timelines in memory (`app/residency.rs`): the open thread, the watched threads and the
//! last few opened stay; older ones are dropped and load again, from a fresh snapshot, when the
//! user opens them again. A linked environment that is switched off takes its state with it.

use std::time::Duration;

use conn_cache::MessageCache;
use conn_client::{Credential, ServerConfig};
use conn_wire::{FromClient, FromServer, Request, encode_server_frame};
use futures::{SinkExt, StreamExt};
use gpui_kit::{Entity, TestAppContext};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::reconnect_tests::thread_snapshot;
use super::residency::RECENT_THREADS;
use super::{ConnApp, ThreadState};
use crate::live::RT;
use crate::ui_tests::{mount_app, mount_app_with_server};

/// Settled threads, which the offline cache never watches.
const SETTLED: usize = RECENT_THREADS + 4;
/// Unsettled threads, which the offline cache watches while it is on.
const WATCHED: [&str; 2] = ["watched-0", "watched-1"];

fn settled_id(i: usize) -> String {
    format!("settled-{i:02}")
}

fn thread_json(id: &str, settled: bool) -> Value {
    json!({
        "createdBy": "user", "creationSource": "web", "id": id, "projectId": "proj-lru",
        "title": format!("Thread {id}"), "providerInstanceId": "claude-default",
        "modelSelection": { "provider": "claude", "model": "claude-sonnet-4-6" },
        "runtimeMode": "auto-accept-edits", "interactionMode": "default", "branch": "main",
        "worktreePath": null,
        "lineage": { "parentThreadId": null, "relationshipToParent": null, "rootThreadId": id },
        "forkedFrom": null, "activeProviderThreadId": null, "latestRunId": "run-1",
        "activeRunId": null, "activityRunStatus": null, "status": "completed",
        "pendingRuntimeRequest": null, "latestVisibleMessage": null,
        "latestUserMessageAt": "2026-11-26T22:00:00.000Z", "hasActionableProposedPlan": false,
        "itemCount": 2, "visibleItemCount": 2, "pinnedAt": null, "pinOrderKey": null,
        "settledOverride": null,
        // Settled in the future, so the cache's 24-hour retention never expires it here.
        "settledAt": settled.then_some("2099-01-01T00:00:00.000Z"),
        "archivedAt": null, "lastVisitedAt": "2026-11-26T22:00:00.000Z",
        "createdAt": "2026-11-26T21:00:00.000Z", "updatedAt": "2026-11-26T22:00:00.000Z",
    })
}

fn shell_snapshot() -> Value {
    let mut threads: Vec<Value> = (0..SETTLED)
        .map(|i| thread_json(&settled_id(i), true))
        .collect();
    threads.extend(WATCHED.iter().map(|id| thread_json(id, false)));
    json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1, "snapshotSequence": 10,
            "projects": [{
                "id": "proj-lru", "title": "lru", "workspaceRoot": "/tmp/lru",
                "defaultModelSelection": null, "scripts": [],
                "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-26T22:00:00.000Z"
            }],
            "threads": threads,
            "archivedThreads": []
        }
    })
}

fn reply(request: &Request) -> Option<FromServer> {
    let chunk = |values: Vec<Value>| FromServer::Chunk {
        request_id: request.id.clone(),
        values,
    };
    match request.tag.as_str() {
        "orchestration.subscribeShell" => Some(chunk(vec![shell_snapshot()])),
        "orchestration.subscribeThread" => {
            let id = request.payload["threadId"].as_str().unwrap_or_default();
            Some(chunk(vec![
                thread_snapshot(id, 20, 2),
                json!({ "kind": "synchronized" }),
            ]))
        }
        _ => None,
    }
}

/// A loopback server that lists the threads above, answers every `subscribeThread` with a
/// snapshot, and reports each request's tag and payload.
fn spawn_server() -> (url::Url, std::sync::mpsc::Receiver<(String, Value)>) {
    let (seen_tx, seen) = std::sync::mpsc::channel();
    let addr = RT.block_on(async move {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let seen_tx = seen_tx.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(message)) = ws.next().await {
                        let Message::Text(text) = message else {
                            continue;
                        };
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            let answer = match frame {
                                FromClient::Ping => Some(FromServer::Pong),
                                FromClient::Request(request) => {
                                    let _ = seen_tx
                                        .send((request.tag.clone(), request.payload.clone()));
                                    reply(&request)
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
    (
        url::Url::parse(&format!("http://{addr}")).expect("server URL"),
        seen,
    )
}

fn mount(cx: &mut TestAppContext, url: &url::Url) -> Entity<ConnApp> {
    let (_window, app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: ServerConfig {
                http_base_url: url.clone(),
                credential: Credential::Bearer("test-token".to_owned()),
            },
            label: None,
            orbit_server_id: None,
        }),
    );
    app
}

/// Pumps the app until `done` holds, or fails after a while.
fn pump_until(
    cx: &mut TestAppContext,
    app: &Entity<ConnApp>,
    what: &str,
    seen_rx: &std::sync::mpsc::Receiver<(String, Value)>,
    seen: &mut Vec<(String, Value)>,
    mut done: impl FnMut(&ConnApp, &[(String, Value)]) -> bool,
) {
    for _ in 0..1000 {
        cx.run_until_parked();
        seen.extend(seen_rx.try_iter());
        if cx.read(|cx| done(app.read(cx), seen)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting until {what}; requests seen: {seen:#?}");
}

fn subscribes<'a>(seen: &'a [(String, Value)], thread: &str) -> Vec<&'a Value> {
    seen.iter()
        .filter(|(tag, payload)| {
            tag == "orchestration.subscribeThread" && payload["threadId"] == thread
        })
        .map(|(_, payload)| payload)
        .collect()
}

fn entries(app: &ConnApp, thread: &str) -> usize {
    app.threads
        .get(thread)
        .map_or(0, |state| state.entries.len())
}

fn open_and_load(
    cx: &mut TestAppContext,
    app: &Entity<ConnApp>,
    seen_rx: &std::sync::mpsc::Receiver<(String, Value)>,
    seen: &mut Vec<(String, Value)>,
    thread: &str,
) {
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread(thread, cx)));
    pump_until(
        cx,
        app,
        &format!("{thread} loads"),
        seen_rx,
        seen,
        |app, _| entries(app, thread) > 0,
    );
}

/// Opening more threads than the recent list holds drops the oldest timelines, never the open
/// one. Opening a dropped thread again asks for a fresh snapshot (no `afterSequence`: the client
/// forgot the old cursor with the reducer) and shows it.
#[gpui_kit::test]
fn old_timelines_are_dropped_and_reload_when_opened_again(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (url, seen_rx) = spawn_server();
    let app = mount(cx, &url);
    let mut seen = Vec::new();
    pump_until(
        cx,
        &app,
        "the shell lists the threads",
        &seen_rx,
        &mut seen,
        |app, _| app.shell.find_thread(&settled_id(SETTLED - 1)).is_some(),
    );

    for i in 0..SETTLED {
        open_and_load(cx, &app, &seen_rx, &mut seen, &settled_id(i));
        let resident = cx.read(|cx| app.read(cx).resident_threads_for_test());
        assert!(
            resident.contains(&settled_id(i)),
            "the open thread stays: {resident:?}"
        );
        assert!(
            resident.len() <= RECENT_THREADS,
            "at most {RECENT_THREADS} timelines stay: {resident:?}"
        );
    }
    let expected: Vec<String> = (SETTLED - RECENT_THREADS..SETTLED)
        .map(settled_id)
        .collect();
    assert_eq!(
        cx.read(|cx| app.read(cx).resident_threads_for_test()),
        expected,
        "the last {RECENT_THREADS} opened stay; the older ones went"
    );

    // The first thread went. Opening it again loads it from a new snapshot.
    let first = settled_id(0);
    open_and_load(cx, &app, &seen_rx, &mut seen, &first);
    let asks = subscribes(&seen, &first);
    assert_eq!(asks.len(), 2, "opened twice: {asks:#?}");
    assert!(
        asks[1].get("afterSequence").is_none(),
        "a dropped thread asks for a snapshot, not a replay: {:#?}",
        asks[1]
    );
    let resident = cx.read(|cx| app.read(cx).resident_threads_for_test());
    assert!(resident.contains(&first), "{resident:?}");
    assert!(
        !resident.contains(&settled_id(SETTLED - RECENT_THREADS)),
        "reopening pushed the next oldest out: {resident:?}"
    );
    assert!(
        cx.read(|cx| app.read(cx).selected_timeline().is_some()),
        "the reopened thread shows"
    );
}

/// The offline cache's watched threads keep their timelines however many other threads open.
#[gpui_kit::test]
fn watched_threads_keep_their_timelines(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (url, seen_rx) = spawn_server();
    let app = mount(cx, &url);
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
        "the watched threads load",
        &seen_rx,
        &mut seen,
        |app, _| WATCHED.iter().all(|id| entries(app, id) > 0),
    );

    for i in 0..SETTLED {
        open_and_load(cx, &app, &seen_rx, &mut seen, &settled_id(i));
        // The cache writes what the thread loaded (every 300 ms in the app); a thread leaves
        // memory only once its rows are written.
        for _ in 0..200 {
            cx.executor().advance_clock(Duration::from_millis(400));
            cx.run_until_parked();
            if cx.read(|cx| app.read(cx).offline_writes_idle_for_test()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let resident = cx.read(|cx| app.read(cx).resident_threads_for_test());
    for id in WATCHED {
        assert!(resident.iter().any(|r| r == id), "{id} stays: {resident:?}");
    }
    assert!(
        !resident.contains(&settled_id(0)),
        "an unwatched old thread went: {resident:?}"
    );
    assert!(resident.contains(&settled_id(SETTLED - 1)));
}

/// The open thread stays even when nothing else would keep it, and a thread with a cache write
/// still to go stays until that write has taken its rows.
#[gpui_kit::test]
fn the_open_thread_and_unsaved_threads_are_never_dropped(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().expect("cache directory");
    let db = RT
        .block_on(MessageCache::open(&dir.path().join("messages.sqlite3")))
        .expect("cache");
    let env = "http://test.local";
    let (_, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.offline
                .enable_for_test(dir.path().to_owned(), db.clone());
            app.server_url = Some(env.into());
            app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
            // Selected without going through the recent list.
            app.set_thread_for_test(
                "thread-pinned".into(),
                ThreadState::new("thread-pinned"),
                cx,
            );
            // A thread nobody opened, whose snapshot the cache still has to write.
            app.apply_cache_stream(
                env,
                "thread-waiting",
                conn_contract::from_json(thread_snapshot("thread-waiting", 5, 1))
                    .expect("snapshot"),
            );
            app.evict_cold_threads_for_test();
            assert_eq!(
                app.resident_threads_for_test(),
                ["thread-pinned", "thread-waiting"],
                "the open thread and the unsaved one stay"
            );
            // The save takes the rows; then nothing keeps the unopened thread.
            let _ = app.pending_saves_for_test();
            app.evict_cold_threads_for_test();
            assert_eq!(app.resident_threads_for_test(), ["thread-pinned"]);
        });
    });
}

/// Switching a linked environment off frees its reducers, shadow reducers, outlines and watches.
/// The open thread stays.
#[gpui_kit::test]
fn switching_a_linked_environment_off_frees_its_state(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().expect("cache directory");
    let db = RT
        .block_on(MessageCache::open(&dir.path().join("messages.sqlite3")))
        .expect("cache");
    let primary = "http://primary.local";
    let (_, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.offline
                .enable_for_test(dir.path().to_owned(), db.clone());
            app.server_url = Some(primary.into());
            app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
            let project: conn_state::ProjectShell = conn_contract::from_json(json!({
                "id": "proj-lru", "title": "lru", "workspaceRoot": "/tmp/lru",
                "defaultModelSelection": null, "scripts": [],
                "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-26T22:00:00.000Z"
            }))
            .expect("project decodes");
            let threads = ["mini-a", "mini-b", "mini-open"]
                .map(|id| conn_contract::from_json(thread_json(id, false)).expect("thread decodes"))
                .to_vec();
            let mut mini =
                conn_state::ShellState::from_parts(vec![project], threads, Vec::new(), Some(3));
            mini.synchronized = true;
            app.add_linked_shell_for_test("mini", "mini", mini, cx);
            for id in ["mini-a", "mini-b", "mini-open"] {
                app.apply_cache_stream(
                    "mini",
                    id,
                    conn_contract::from_json(thread_snapshot(id, 5, 1)).expect("snapshot"),
                );
            }
            // `thread-pinned` lives on the primary, so mini's copy waits in the shadow.
            app.apply_cache_stream(
                "mini",
                "thread-pinned",
                conn_contract::from_json(thread_snapshot("thread-pinned", 5, 1)).expect("snapshot"),
            );
            app.offline.insert_outline_for_test("mini", "mini-a");
            let _ = app.pending_saves_for_test();
            app.layout.selected_thread_id = Some("mini-open".into());
            assert_eq!(app.offline.memory_counts_for_test("mini"), (3, 1, 1, 0));

            app.set_linked_environment_enabled("mini", false, cx);

            let (owners, shadow, outlines, watches) = app.offline.memory_counts_for_test("mini");
            assert_eq!((shadow, outlines, watches), (0, 0, 0));
            assert_eq!(owners, 0);
            let resident = app.resident_threads_for_test();
            assert!(!resident.iter().any(|id| id == "mini-a" || id == "mini-b"));
            assert!(
                resident.iter().any(|id| id == "mini-open"),
                "the open thread stays: {resident:?}"
            );
        });
    });
}
