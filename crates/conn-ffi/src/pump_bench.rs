//! Replays a burst of thread events against a long open thread and counts what the pump does:
//! events in, snapshots projected, snapshots published, bytes lowered across the FFI, and how long
//! an `OpenThread` waits while the burst drains. Run with
//! `cargo test -p conn-ffi pump_bench -- --ignored --nocapture`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use conn_client::{ClientEvent, Connection, Credential, ServerConfig};
use conn_contract::{OrchestrationV2ShellStreamItem, OrchestrationV2ThreadStreamItem, from_json};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use super::{
    CoreListener, FfiComposerLimits, FfiConnectionStatus, FfiSavedSession, FfiShellSnapshot,
    FfiThreadSnapshot, PumpControl, PumpStats, SessionIdentity, run_pump,
};
use crate::types::FfiTimelineEntry;

const LONG: &str = "bench-long";
const OTHER: &str = "bench-other";
const STREAM_ITEM: &str = "turn-item:bench-stream";

#[derive(Default)]
struct Seen {
    long: u64,
    other_at: Option<Instant>,
    bytes: u64,
    last_text_len: usize,
}

#[derive(Default)]
struct Recorder(Mutex<Seen>);

impl CoreListener for Recorder {
    fn on_status(&self, _status: FfiConnectionStatus) {}
    fn on_bearer_issued(&self, _session: FfiSavedSession) {}
    fn on_shell(&self, _snapshot: FfiShellSnapshot) {}
    fn on_thread(&self, snapshot: FfiThreadSnapshot) {
        let mut buf = Vec::new();
        let id = snapshot.thread_id.clone();
        let text_len = snapshot.entries.iter().rev().find_map(|entry| match entry {
            FfiTimelineEntry::Assistant { id, markdown, .. } if id == STREAM_ITEM => {
                Some(markdown.len())
            }
            _ => None,
        });
        <FfiThreadSnapshot as uniffi::Lower<crate::UniFfiTag>>::write(snapshot, &mut buf);
        let mut seen = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        seen.bytes += buf.len() as u64;
        if id == LONG {
            seen.long += 1;
            if let Some(len) = text_len {
                seen.last_text_len = len;
            }
        } else if id == OTHER && seen.other_at.is_none() {
            seen.other_at = Some(Instant::now());
        }
    }
    fn on_error(&self, _message: String) {}
    fn on_providers_changed(&self) {}
    fn on_thread_deleted(&self, _thread_id: String) {}
}

fn thread_shell(id: &str, minute: u32) -> Value {
    json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": id,
        "projectId": "p1",
        "title": format!("Thread {id}"),
        "providerInstanceId": "claudeAgent",
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": "main",
        "worktreePath": null,
        "lineage": { "rootThreadId": id, "parentThreadId": null, "relationshipToParent": null },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": null,
        "activeRunId": null,
        "status": "running",
        "pendingRuntimeRequest": null,
        "latestVisibleMessage": null,
        "latestUserMessageAt": null,
        "hasActionableProposedPlan": false,
        "itemCount": 0,
        "visibleItemCount": 0,
        "createdAt": "2026-11-13T09:00:00.000Z",
        "updatedAt": format!("2026-11-13T09:{:02}:{:02}.000Z", minute / 60 % 60, minute % 60),
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "deletedAt": null
    })
}

fn shell(item: Value) -> ClientEvent {
    ClientEvent::Shell(from_json::<OrchestrationV2ShellStreamItem>(item).expect("shell item"))
}

fn thread(id: &str, item: Value) -> ClientEvent {
    ClientEvent::Thread {
        thread_id: id.to_owned(),
        item: from_json::<OrchestrationV2ThreadStreamItem>(item).expect("thread item"),
    }
}

/// The synthetic snapshot with its one run marked running under `id`.
fn snapshot(id: &str, turns: usize) -> (Value, String, i64) {
    let raw =
        conn_state::testkit::synthetic_thread_snapshot_json(conn_state::testkit::SyntheticThread {
            turns,
            commands_per_turn: 3,
            command_output_bytes: 512,
            assistant_bytes: 1200,
        });
    let mut value: Value = serde_json::from_str(&raw).expect("snapshot json");
    value["projection"]["thread"]["id"] = json!(id);
    let run = value["projection"]["runs"][0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    value["projection"]["runs"][0]["status"] = json!("running");
    value["projection"]["runs"][0]["completedAt"] = Value::Null;
    let sequence = value["snapshotSequence"].as_i64().unwrap_or(0);
    (value, run, sequence)
}

/// One streamed assistant delta: the same item, its text `len` bytes long.
fn delta(run: &str, sequence: i64, len: usize) -> Value {
    let text: String = "lorem ipsum dolor sit amet "
        .chars()
        .cycle()
        .take(len)
        .collect();
    json!({
        "kind": "event",
        "sequence": sequence,
        "event": {
            "id": format!("event:bench:{sequence}"),
            "occurredAt": "2026-11-13T13:37:17.953Z",
            "runId": run,
            "threadId": LONG,
            "type": "turn-item.updated",
            "payload": {
                "completedAt": null,
                "id": STREAM_ITEM,
                "messageId": "message:bench-stream",
                "nativeItemRef": null,
                "nodeId": null,
                "ordinal": 9_000_000,
                "parentItemId": null,
                "providerThreadId": null,
                "providerTurnId": null,
                "runId": run,
                "startedAt": "2026-11-13T13:37:17.951Z",
                "status": "running",
                "streaming": true,
                "text": text,
                "threadId": LONG,
                "title": null,
                "type": "assistant_message",
                "updatedAt": "2026-11-13T13:37:17.952Z"
            }
        }
    })
}

#[derive(Debug)]
struct Report {
    events: u64,
    projections: u64,
    publications: u64,
    bytes: u64,
    drain_ms: f64,
    open_latency_ms: Option<f64>,
}

/// `pace` is the gap between events; `None` floods the channel at once.
fn run_burst(turns: usize, burst: usize, pace: Option<Duration>) -> Report {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");
    let config = ServerConfig {
        http_base_url: "http://127.0.0.1:9/".parse().expect("url"),
        credential: Credential::Bearer("bench".into()),
    };
    // A dead server: the pump gets its events from this test, not the socket.
    let (connection, _ignored) = Connection::start(config, rt.handle());
    let (events_tx, events_rx) = mpsc::channel::<ClientEvent>(burst + 64);
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
    let recorder = std::sync::Arc::new(Recorder::default());
    let listener: std::sync::Arc<dyn CoreListener> = recorder.clone();
    let (shell_tx, _shell_rx) = watch::channel(None);
    let (status_tx, _status_rx) = watch::channel(FfiConnectionStatus::Connecting);
    let (limits_tx, _limits_rx) = watch::channel(FfiComposerLimits::default());
    rt.spawn(run_pump(
        connection,
        events_rx,
        ctrl_rx,
        listener,
        std::sync::Arc::default(),
        (shell_tx, status_tx, limits_tx),
        SessionIdentity {
            server_url: "http://127.0.0.1:9/".into(),
            orbit_server_id: None,
            reused_session: None,
        },
    ));

    let (long, run, long_seq) = snapshot(LONG, turns);
    let (other, _, _) = snapshot(OTHER, 4);
    let _ = ctrl_tx.send(PumpControl::OpenThread(LONG.into()));
    let setup = vec![
        shell(json!({"kind": "snapshot", "snapshot": {
            "schemaVersion": 1, "snapshotSequence": 1, "projects": [],
            "threads": [thread_shell(LONG, 0), thread_shell(OTHER, 0)], "archivedThreads": []
        }})),
        shell(json!({"kind": "synchronized"})),
        thread(LONG, long),
        thread(LONG, json!({"kind": "synchronized"})),
        thread(OTHER, other),
        thread(OTHER, json!({"kind": "synchronized"})),
    ];
    rt.block_on(async {
        for event in setup {
            let _ = events_tx.send(event).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    });
    let before = stats(&rt, &ctrl_tx);
    let published_before = recorder
        .0
        .lock()
        .map(|s| (s.long, s.bytes))
        .unwrap_or_default();

    let started = Instant::now();
    let final_len = 40 + burst * 12;
    let mut open_sent = None;
    rt.block_on(async {
        for i in 0..burst {
            let sequence = long_seq + 1 + i as i64;
            let event = if i % 10 == 9 {
                // A shell row change for the open thread: header metadata does not change.
                shell(json!({"kind": "thread.updated", "sequence": 2 + i as i64,
                    "location": "active", "thread": thread_shell(LONG, i as u32)}))
            } else {
                thread(LONG, delta(&run, sequence, 40 + (i + 1) * 12))
            };
            let _ = events_tx.send(event).await;
            if i == burst / 4 {
                open_sent = Some(Instant::now());
                let _ = ctrl_tx.send(PumpControl::OpenThread(OTHER.into()));
            }
            if let Some(pace) = pace {
                tokio::time::sleep(pace).await;
            }
        }
        // The last event is a shell row; send one more delta so the final text is known.
        let _ = events_tx
            .send(thread(
                LONG,
                delta(&run, long_seq + 1 + burst as i64, final_len),
            ))
            .await;
        loop {
            let done = recorder
                .0
                .lock()
                .map(|s| s.last_text_len >= final_len)
                .unwrap_or(false);
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    });
    let drain_ms = started.elapsed().as_secs_f64() * 1000.0;
    let after = stats(&rt, &ctrl_tx);
    let seen = recorder
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let report = Report {
        events: after.events - before.events,
        projections: after.projections - before.projections,
        publications: seen.long - published_before.0,
        bytes: seen.bytes - published_before.1,
        drain_ms,
        open_latency_ms: seen
            .other_at
            .zip(open_sent)
            .map(|(at, sent)| at.saturating_duration_since(sent).as_secs_f64() * 1000.0),
    };
    drop(seen);
    let _ = ctrl_tx.send(PumpControl::Shutdown);
    rt.shutdown_timeout(Duration::from_millis(500));
    report
}

fn stats(rt: &tokio::runtime::Runtime, ctrl: &mpsc::UnboundedSender<PumpControl>) -> PumpStats {
    let (tx, rx) = oneshot::channel();
    let _ = ctrl.send(PumpControl::Stats(tx));
    rt.block_on(rx).unwrap_or_default()
}

#[test]
#[ignore = "benchmark: run with --ignored --nocapture"]
fn pump_bench() {
    for (label, pace) in [
        ("flood", None),
        ("paced 2ms", Some(Duration::from_millis(2))),
    ] {
        let report = run_burst(300, 2000, pace);
        println!(
            "pump_bench {label}: events={} projections={} publications={} ffi_bytes={} ({:.1} MB) drain_ms={:.0} open_latency_ms={}",
            report.events,
            report.projections,
            report.publications,
            report.bytes,
            report.bytes as f64 / 1_048_576.0,
            report.drain_ms,
            report
                .open_latency_ms
                .map_or_else(|| "n/a".to_owned(), |ms| format!("{ms:.1}")),
        );
    }
}
