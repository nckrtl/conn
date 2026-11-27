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
    FfiThreadSnapshot, PumpControl, PumpState, PumpStats, SessionIdentity, run_pump,
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
    skipped_equal: u64,
    publications: u64,
    bytes: u64,
    drain_ms: f64,
    open_latency_ms: Option<f64>,
}

/// `pace` is the gap between events; `None` floods the channel at once. Every `shell_every`th
/// event is a shell row change for the open thread that leaves its header as it was; the others
/// are streamed text.
fn run_burst(turns: usize, burst: usize, pace: Option<Duration>, shell_every: usize) -> Report {
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
    let dir = tempfile::tempdir().expect("dir");
    let engine = open_engine(&rt, dir.path(), &connection);
    let reader = crate::OfflineReader::new(engine.images(), connection.clone());
    let (events_tx, events_rx) = mpsc::channel::<ClientEvent>(burst + 64);
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
    let _ = ctrl_tx.send(PumpControl::EnableEngine(Box::new(engine), reader));
    let recorder = std::sync::Arc::new(Recorder::default());
    let listener: std::sync::Arc<dyn CoreListener> = recorder.clone();
    let (shell_tx, _shell_rx) = watch::channel(None);
    let (status_tx, _status_rx) = watch::channel(FfiConnectionStatus::Connecting);
    let (limits_tx, _limits_rx) = watch::channel(FfiComposerLimits::default());
    rt.spawn(run_pump(
        connection,
        events_rx,
        (ctrl_rx, ctrl_tx.clone()),
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
            let event = if i % shell_every == shell_every - 1 {
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
        skipped_equal: after.skipped_equal - before.skipped_equal,
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
    for (label, pace, burst, shell_every) in [
        ("flood", None, 2000, 10),
        ("paced 2ms", Some(Duration::from_millis(2)), 2000, 10),
        (
            "shell-only paced 2ms",
            Some(Duration::from_millis(2)),
            500,
            1,
        ),
    ] {
        let report = run_burst(300, burst, pace, shell_every);
        println!(
            "pump_bench {label}: events={} projections={} skipped_equal={} publications={} ffi_bytes={} ({:.1} MB) drain_ms={:.0} open_latency_ms={}",
            report.events,
            report.projections,
            report.skipped_equal,
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

fn open_engine(
    rt: &tokio::runtime::Runtime,
    dir: &std::path::Path,
    connection: &Connection,
) -> conn_cache::Engine {
    rt.block_on(conn_cache::Engine::open(
        &dir.join("local.sqlite3"),
        "env",
        connection.clone(),
        conn_cache::Settings::default(),
    ))
    .expect("engine")
}

type Ctrl = mpsc::UnboundedReceiver<PumpControl>;

/// A pump fed by hand, on a dead connection, its engine on the device database in `dir`. Its
/// device reads come back on the returned receiver; the caller keeps `rt` entered.
fn bare_pump(
    rt: &tokio::runtime::Runtime,
    dir: &std::path::Path,
) -> (PumpState, std::sync::Arc<Recorder>, Ctrl) {
    let config = ServerConfig {
        http_base_url: "http://127.0.0.1:9/".parse().expect("url"),
        credential: Credential::Bearer("test".into()),
    };
    let (connection, _ignored) = Connection::start(config, rt.handle());
    let engine = open_engine(rt, dir, &connection);
    let recorder = std::sync::Arc::new(Recorder::default());
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
    let mut state = PumpState::new(
        connection.clone(),
        ctrl_tx,
        recorder.clone(),
        std::sync::Arc::default(),
        (
            watch::channel(None).0,
            watch::channel(FfiConnectionStatus::Connecting).0,
            watch::channel(FfiComposerLimits::default()).0,
        ),
        SessionIdentity {
            server_url: "http://127.0.0.1:9/".into(),
            orbit_server_id: None,
            reused_session: None,
        },
    );
    state.reader = Some(crate::OfflineReader::new(engine.images(), connection));
    state.engine = Some(engine);
    (state, recorder, ctrl_rx)
}

/// Opens `id` and hands the pump its device read.
fn open(rt: &tokio::runtime::Runtime, state: &mut PumpState, ctrl: &mut Ctrl, id: &str) {
    let _ = state.handle_control(PumpControl::OpenThread(id.into()));
    let read = rt.block_on(ctrl.recv()).expect("device read");
    assert!(matches!(read, PumpControl::FinishOpen { .. }));
    let _ = state.handle_control(read);
}

/// Opens `LONG` with a short synchronized timeline and publishes it once at `at`.
fn open_long(
    rt: &tokio::runtime::Runtime,
    state: &mut PumpState,
    ctrl: &mut Ctrl,
    at: Instant,
) -> (Value, String, i64) {
    let (long, run, sequence) = snapshot(LONG, 3);
    state.handle_event(shell(json!({"kind": "snapshot", "snapshot": {
        "schemaVersion": 1, "snapshotSequence": 1, "projects": [],
        "threads": [thread_shell(LONG, 0)], "archivedThreads": []
    }})));
    state.handle_event(shell(json!({"kind": "synchronized"})));
    open(rt, state, ctrl, LONG);
    state.handle_event(thread(LONG, long.clone()));
    state.handle_event(thread(LONG, json!({"kind": "synchronized"})));
    state.flush_due_at(at);
    (long, run, sequence)
}

fn stream_text_len(snapshot: &FfiThreadSnapshot) -> Option<usize> {
    snapshot.entries.iter().find_map(|entry| match entry {
        FfiTimelineEntry::Assistant { id, markdown, .. } if id == STREAM_ITEM => {
            Some(markdown.len())
        }
        _ => None,
    })
}

/// A kept thread's changes reach the device while it is closed, with nothing in memory. Opening
/// it draws from the device although the server never answers (the connection is dead), and so
/// does a restart on the same database.
#[test]
fn a_kept_thread_opens_from_the_device_before_the_server_answers() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _rt = rt.enter();
    let dir = tempfile::tempdir().expect("dir");
    let (mut state, _, mut ctrl) = bare_pump(&rt, dir.path());
    let (long, run, sequence) = snapshot(LONG, 3);
    state.handle_event(thread(LONG, long));
    state.handle_event(thread(LONG, json!({"kind": "synchronized"})));
    state.handle_event(thread(LONG, delta(&run, sequence + 1, 64)));
    assert!(
        state.thread(LONG).is_none(),
        "a closed kept thread holds nothing in memory"
    );

    let open_from_device = |state: &mut PumpState, ctrl: &mut Ctrl| {
        open(&rt, state, ctrl, LONG);
        state.flush_due_at(Instant::now() + Duration::from_secs(1));
        state.published.get(LONG).cloned().expect("published")
    };
    let first = open_from_device(&mut state, &mut ctrl);
    assert!(
        !first.synchronized,
        "the device copy draws at once but is not caught up until the stream says so"
    );
    assert_eq!(stream_text_len(&first), Some(64), "with the latest change");
    drop(state);

    let (mut restarted, _, mut ctrl) = bare_pump(&rt, dir.path());
    let again = open_from_device(&mut restarted, &mut ctrl);
    assert_eq!(
        again.entries, first.entries,
        "a restart opens the same rows"
    );
}

/// The threads left last stay in memory: switching back publishes without a device read.
#[test]
fn switching_back_to_a_recent_thread_publishes_at_once() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _rt = rt.enter();
    let dir = tempfile::tempdir().expect("dir");
    let (mut state, recorder, mut ctrl) = bare_pump(&rt, dir.path());
    let t0 = Instant::now();
    open_long(&rt, &mut state, &mut ctrl, t0);
    let _ = state.handle_control(PumpControl::CloseThread(LONG.into()));
    open(&rt, &mut state, &mut ctrl, OTHER);
    let _ = state.handle_control(PumpControl::CloseThread(OTHER.into()));
    let published = |r: &Recorder| r.0.lock().map(|s| s.long).unwrap_or_default();
    let before = published(&recorder);

    let _ = state.handle_control(PumpControl::OpenThread(LONG.into()));
    assert!(ctrl.try_recv().is_err(), "no device read: it is in memory");
    state.flush_due_at(t0 + Duration::from_secs(5));
    assert_eq!(published(&recorder), before + 1, "published at once");
}

#[test]
fn a_burst_builds_one_snapshot_per_publication_and_shell_only_changes_publish_nothing() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _rt = rt.enter();
    let dir = tempfile::tempdir().expect("dir");
    let (mut state, recorder, mut ctrl) = bare_pump(&rt, dir.path());
    let t0 = Instant::now();
    let (_, run, sequence) = open_long(&rt, &mut state, &mut ctrl, t0);
    let published = |r: &Recorder| r.0.lock().map(|s| s.long).unwrap_or_default();
    assert_eq!(published(&recorder), 1);
    let base = state.stats;

    for minute in 1..=10 {
        state.handle_event(shell(
            json!({"kind": "thread.updated", "sequence": 1 + minute,
            "location": "active", "thread": thread_shell(LONG, minute as u32)}),
        ));
    }
    state.flush_due_at(t0 + Duration::from_secs(1));
    assert_eq!(
        state.stats.projections - base.projections,
        1,
        "ten row changes, one build"
    );
    assert_eq!(state.stats.skipped_equal - base.skipped_equal, 1);
    assert_eq!(
        published(&recorder),
        1,
        "the header did not change: nothing to publish"
    );

    for i in 0..200 {
        state.handle_event(thread(LONG, delta(&run, sequence + 1 + i, 40 + i as usize)));
    }
    state.flush_due_at(t0 + Duration::from_secs(2));
    assert_eq!(state.stats.events - base.events, 210);
    assert_eq!(
        state.stats.projections - base.projections,
        2,
        "200 deltas, one build"
    );
    assert_eq!(published(&recorder), 2);
    assert_eq!(
        recorder
            .0
            .lock()
            .map(|s| s.last_text_len)
            .unwrap_or_default(),
        40 + 199,
        "the publication carries the latest text"
    );
}

#[test]
fn a_drain_stops_at_its_bound_so_controls_are_serviced() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let dir = tempfile::tempdir().expect("dir");
    let (mut state, _, _ctrl) = bare_pump(&rt, dir.path());
    let (tx, mut rx) = mpsc::channel(512);
    for _ in 0..200 {
        tx.try_send(shell(json!({"kind": "synchronized"})))
            .expect("queued");
    }
    let first = rx.try_recv().expect("first");
    state.drain_events(first, &mut rx);
    assert_eq!(state.stats.events, super::MAX_EVENTS_PER_DRAIN as u64);
    assert_eq!(rx.len(), 200 - super::MAX_EVENTS_PER_DRAIN);
}

/// The server's row for the reply with idempotency `key`.
fn echo(long: &Value, sequence: i64, key: &str) -> Value {
    let mut item = long["projection"]["visibleTurnItems"][0]["item"].clone();
    item["id"] = json!(format!("turn-item:message-{key}"));
    item["messageId"] = json!(format!("message-{key}"));
    item["text"] = json!("hello from the phone");
    item["ordinal"] = json!(9_500_000);
    if let Some(object) = item.as_object_mut() {
        object.remove("textOmitted");
    }
    json!({"kind": "event", "sequence": sequence, "event": {
        "type": "turn-item.updated", "id": format!("event:echo:{sequence}"),
        "threadId": LONG, "occurredAt": item["updatedAt"], "payload": item
    }})
}

fn rows_for(snapshot: &FfiThreadSnapshot, key: &str) -> usize {
    let item = format!("turn-item:message-{key}");
    snapshot
        .entries
        .iter()
        .filter(|entry| match entry {
            FfiTimelineEntry::User { id, .. } | FfiTimelineEntry::QueuedUser { id, .. } => {
                *id == item
            }
            _ => false,
        })
        .count()
}

#[test]
fn a_reply_shows_at_once_and_its_echo_leaves_exactly_one_row_before_or_after_the_ack() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    let _rt = rt.enter();
    let dir = tempfile::tempdir().expect("dir");
    let (mut state, _, mut ctrl) = bare_pump(&rt, dir.path());
    let t0 = Instant::now();
    let (long, _, sequence) = open_long(&rt, &mut state, &mut ctrl, t0);
    let send = |key: &str| PumpControl::QueueSend {
        thread_id: LONG.into(),
        send: crate::outbox::PendingSend {
            key: key.into(),
            text: "hello from the phone".into(),
            attachments: Vec::new(),
            created_at: "2026-11-26T10:00:00.000Z".into(),
            acked: false,
            superseded: false,
        },
    };
    let settle = |key: &str, accepted: bool| PumpControl::SendSettled {
        thread_id: LONG.into(),
        key: key.into(),
        accepted,
    };
    let last = |state: &PumpState| state.published.get(LONG).cloned().expect("published");

    // Echo first, then the acknowledgement.
    let _ = state.handle_control(send("k1"));
    state.flush_due_at(t0 + Duration::from_millis(1));
    assert_eq!(
        rows_for(&last(&state), "k1"),
        1,
        "the reply shows before the server answers"
    );
    assert!(matches!(
        last(&state).entries.last(),
        Some(FfiTimelineEntry::QueuedUser { .. })
    ));
    state.handle_event(thread(LONG, echo(&long, sequence + 1, "k1")));
    state.flush_due_at(t0 + Duration::from_secs(1));
    assert_eq!(
        rows_for(&last(&state), "k1"),
        1,
        "the echo replaces the pending row"
    );
    assert!(matches!(
        last(&state).entries.last(),
        Some(FfiTimelineEntry::User { .. })
    ));
    let _ = state.handle_control(settle("k1", true));
    state.flush_due_at(t0 + Duration::from_secs(2));
    assert_eq!(rows_for(&last(&state), "k1"), 1);
    assert!(state.outbox.is_empty());

    // The acknowledgement first, then the echo.
    let _ = state.handle_control(send("k2"));
    let _ = state.handle_control(settle("k2", true));
    state.flush_due_at(t0 + Duration::from_secs(3));
    assert_eq!(rows_for(&last(&state), "k2"), 1);
    state.handle_event(thread(LONG, echo(&long, sequence + 2, "k2")));
    state.flush_due_at(t0 + Duration::from_secs(4));
    assert_eq!(rows_for(&last(&state), "k2"), 1);
    assert!(state.outbox.is_empty());

    // A refused reply loses its row; the app restores the draft.
    let _ = state.handle_control(send("k3"));
    state.flush_due_at(t0 + Duration::from_secs(5));
    assert_eq!(rows_for(&last(&state), "k3"), 1);
    let _ = state.handle_control(settle("k3", false));
    state.flush_due_at(t0 + Duration::from_secs(6));
    assert_eq!(rows_for(&last(&state), "k3"), 0);
}
