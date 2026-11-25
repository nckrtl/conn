use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use conn_contract::from_json;
use conn_engine::{Engine, EngineConfig, ManualClock, ProjectConfig};
use serde_json::{Value, json};

use super::*;
use crate::auth::{AuthStore, SESSION_TTL_MS, SessionRequest};

const ROOT: &str = "/tmp/conn-thread-push-project";
const T0: u64 = 1_795_000_000_000;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("conn-thread-push-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open(dir: &TempDir, clock: &Arc<ManualClock>) -> SqliteEngine {
    let mut config = EngineConfig::new(dir.0.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
        "claudeAgent",
    ))];
    config.clock = clock.clone();
    config.thread_push = true;
    SqliteEngine::open(config).unwrap()
}

async fn dispatch(engine: &SqliteEngine, command: Value) {
    engine
        .dispatch(from_json(command).unwrap())
        .await
        .ok()
        .unwrap();
}

/// Creates the thread and starts its first turn. The run's commit writes the outbox row.
async fn start_turn(engine: &SqliteEngine, thread: &str) {
    let signal = engine.thread_push_signal().unwrap();
    begin_turn(engine, thread).await;
    tokio::time::timeout(Duration::from_secs(5), signal.notified())
        .await
        .expect("the first run's commit writes a thread push row");
}

/// Creates the thread and starts its first turn, without waiting for the row. Use it where a
/// drain task already waits on the engine's signal.
async fn begin_turn(engine: &SqliteEngine, thread: &str) {
    dispatch(
        engine,
        json!({
            "type": "thread.create", "commandId": format!("{thread}:create"), "threadId": thread,
            "projectId": SqliteEngine::project_id_for(ROOT), "title": "Fix the build",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5"},
            "runtimeMode": "full-access", "interactionMode": "default",
            "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
        }),
    )
    .await;
    dispatch(
        engine,
        json!({
            "type": "message.dispatch", "commandId": format!("{thread}:send"), "threadId": thread,
            "messageId": format!("message:{thread}"), "text": "done", "attachments": [],
            "dispatchMode": {"type": "start_immediately"}, "createdBy": "user",
            "creationSource": "web",
        }),
    )
    .await;
}

/// A sender that records each thread and answers from a script, then with success.
#[derive(Default)]
struct FakeSender {
    sent: Mutex<Vec<NewThread>>,
    answers: Mutex<VecDeque<Result<(), SendError>>>,
    arrived: tokio::sync::Notify,
}

impl FakeSender {
    fn answering(answers: Vec<Result<(), SendError>>) -> Arc<Self> {
        Arc::new(Self {
            answers: Mutex::new(answers.into()),
            ..Self::default()
        })
    }

    fn sent(&self) -> Vec<NewThread> {
        self.sent.lock().unwrap().clone()
    }
}

impl ThreadSender for FakeSender {
    fn record(&self, thread: NewThread) -> BoxFuture<'static, Result<(), SendError>> {
        self.sent.lock().unwrap().push(thread);
        let answer = self.answers.lock().unwrap().pop_front().unwrap_or(Ok(()));
        self.arrived.notify_one();
        Box::pin(std::future::ready(answer))
    }
}

fn registered(yes: bool) -> Registered {
    Arc::new(move || yes)
}

fn transient() -> Result<(), SendError> {
    Err(SendError::RetryLater("the Gateway answered 503".into()))
}

fn thread(id: &str, title: &str) -> NewThread {
    NewThread {
        environment_id: "env-1".into(),
        thread_id: id.into(),
        title: title.into(),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_first_turn_reaches_the_gateway_once() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    start_turn(&engine, "t1").await;
    let sender = FakeSender::answering(vec![]);
    let pass = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    assert_eq!((pass.sent, pass.next_due), (1, None));
    assert_eq!(sender.sent(), [thread("t1", "Fix the build")]);
    let again = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    assert_eq!(again, Pass::default());
    assert_eq!(sender.sent().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_push_is_retried_until_the_gateway_answers() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    start_turn(&engine, "t1").await;
    let sender = FakeSender::answering(vec![transient(), transient(), transient(), transient()]);
    let mut waits = vec![];
    for _ in 0..4 {
        let now = engine.now_millis();
        let pass = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
            .await
            .unwrap();
        assert_eq!(pass.retried, 1);
        let wait = pass.next_due.unwrap() - now;
        // Not sent again before it is due.
        clock.advance(Duration::from_millis(wait - 1));
        let early = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
            .await
            .unwrap();
        assert_eq!(early.retried + early.sent, 0);
        clock.advance(Duration::from_millis(1));
        waits.push(wait / 1000);
    }
    assert_eq!(waits, [1, 5, 30, 300]);
    let pass = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    assert_eq!((pass.sent, pass.next_due), (1, None));
    assert_eq!(sender.sent().len(), 5);
}

#[tokio::test(flavor = "current_thread")]
async fn a_push_survives_a_restart() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    start_turn(&engine, "t1").await;
    let failing = FakeSender::answering(vec![transient()]);
    drain_once(&engine, failing.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    engine.shutdown().await;
    drop(engine);
    clock.advance(Duration::from_secs(1));
    let engine = open(&dir, &clock);
    let sender = FakeSender::answering(vec![]);
    let pass = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    assert_eq!(pass.sent, 1);
    assert_eq!(sender.sent(), failing.sent());
}

#[tokio::test(flavor = "current_thread")]
async fn a_final_refusal_drops_the_thread() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    start_turn(&engine, "t1").await;
    let sender = FakeSender::answering(vec![Err(classify(422))]);
    let pass = drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    assert_eq!((pass.rejected, pass.next_due), (1, None));
}

#[tokio::test(flavor = "current_thread")]
async fn a_server_orbit_has_not_registered_calls_nothing() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    start_turn(&engine, "t1").await;
    let sender = FakeSender::answering(vec![]);
    let pass = drain_once(&engine, sender.as_ref(), &registered(false), "env-1")
        .await
        .unwrap();
    assert_eq!((pass.unregistered, pass.sent, pass.next_due), (1, 0, None));
    assert!(sender.sent().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn a_new_title_is_pushed_again() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = open(&dir, &clock);
    start_turn(&engine, "t1").await;
    let sender = FakeSender::answering(vec![]);
    drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    dispatch(
        &engine,
        json!({
            "type": "thread.metadata.update", "commandId": "t1:rename", "threadId": "t1",
            "title": "Speed up the build",
        }),
    )
    .await;
    drain_once(&engine, sender.as_ref(), &registered(true), "env-1")
        .await
        .unwrap();
    assert_eq!(
        sender.sent(),
        [
            thread("t1", "Fix the build"),
            thread("t1", "Speed up the build")
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_drain_task_wakes_on_a_new_thread() {
    let dir = TempDir::new();
    let clock = Arc::new(ManualClock::at(T0));
    let engine = Arc::new(open(&dir, &clock));
    let sender = FakeSender::answering(vec![]);
    let task = spawn(
        engine.clone(),
        sender.clone(),
        registered(true),
        "env-1".into(),
    )
    .unwrap();
    let arrived = sender.arrived.notified();
    // Only the drain task waits on the engine's signal, as in the server.
    begin_turn(&engine, "t1").await;
    tokio::time::timeout(Duration::from_secs(5), arrived)
        .await
        .expect("the drain task sends the new thread");
    assert_eq!(sender.sent(), [thread("t1", "Fix the build")]);
    task.abort();
}

#[test]
fn the_gateway_is_the_override_then_the_saved_address_then_the_default() {
    let cases = [
        (None, None, "https://gateway.orbit"),
        (Some(" "), Some("garbage"), "https://gateway.orbit"),
        (
            None,
            Some("http://10.44.0.1:8080/\n"),
            "http://10.44.0.1:8080",
        ),
        (
            Some("https://other.orbit/"),
            Some("http://10.44.0.1:8080"),
            "https://other.orbit",
        ),
        (
            Some("ftp://x"),
            Some("https://saved.orbit"),
            "https://saved.orbit",
        ),
    ];
    for (env, file, want) in cases {
        assert_eq!(pick_gateway(env, file), want, "env {env:?}, file {file:?}");
    }
}

#[test]
fn link_orbit_saves_the_gateway_it_used() {
    let dir = TempDir::new();
    remember_gateway(&dir.0, "not a url");
    assert!(!dir.0.join(GATEWAY_FILE).exists());
    remember_gateway(&dir.0, "http://10.44.0.1:8080/");
    let saved = std::fs::read_to_string(dir.0.join(GATEWAY_FILE)).unwrap();
    assert_eq!(pick_gateway(None, Some(&saved)), "http://10.44.0.1:8080");
}

#[test]
fn a_registration_is_a_live_session_labeled_for_the_gateway() {
    let store = AuthStore::in_memory();
    let check = registered_by(store.clone());
    let issue = |label: Option<&str>| {
        store
            .issue_session(SessionRequest {
                scopes: vec!["orchestration:read".into()],
                label: label.map(str::to_owned),
                subject: None,
                ttl_ms: SESSION_TTL_MS,
            })
            .unwrap()
    };
    assert!(!check());
    issue(None);
    issue(Some("Some phone"));
    assert!(!check(), "only the Gateway's label counts");
    let gateway = issue(Some(REGISTRATION_LABEL));
    assert!(check());
    store
        .revoke_session(None, &gateway.principal.session_id)
        .unwrap()
        .unwrap();
    assert!(!check(), "a revoked session no longer counts");
}

#[test]
fn only_a_passing_refusal_is_retried() {
    for status in [401, 403, 404, 408, 409, 423, 425, 429, 500, 502, 503] {
        assert!(
            matches!(classify(status), SendError::RetryLater(_)),
            "{status}"
        );
    }
    for status in [400, 405, 410, 413, 422] {
        assert!(
            matches!(classify(status), SendError::Rejected(_)),
            "{status}"
        );
    }
}

#[test]
fn the_request_is_the_gateways_thread_record() {
    let (url, body) = request(
        "https://gateway.orbit",
        &NewThread {
            environment_id: "80d960ee-87c0-4a13-8a79-96617f4a5173".into(),
            thread_id: "t/1".into(),
            title: "Fix \"it\"".into(),
        },
    );
    assert_eq!(
        url,
        "https://gateway.orbit/api/v1/conn/environments/80d960ee-87c0-4a13-8a79-96617f4a5173/threads"
    );
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body, json!({"thread_id": "t/1", "title": "Fix \"it\""}));
}

/// The system curl posts the JSON body from stdin to a stand-in Gateway on loopback, whose
/// address comes from the saved state file; a refusal that may pass is a retry.
#[tokio::test(flavor = "current_thread")]
async fn curl_posts_the_record_to_the_saved_gateway() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let gateway = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for status in ["404 Not Found", "201 Created"] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request).into_owned();
                let length = text
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length: ")?
                            .parse()
                            .ok()
                    })
                    .unwrap_or(0_usize);
                if text
                    .split_once("\r\n\r\n")
                    .is_some_and(|(_, body)| body.len() >= length)
                {
                    break;
                }
            }
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}"
                    )
                    .as_bytes(),
                )
                .unwrap();
            requests.push(String::from_utf8(request).unwrap());
        }
        requests
    });
    let dir = TempDir::new();
    remember_gateway(&dir.0, &base);
    let sender = CurlSender::new(dir.0.clone());
    assert!(matches!(
        sender.record(thread("t1", "Fix the build")).await,
        Err(SendError::RetryLater(_))
    ));
    assert_eq!(sender.record(thread("t1", "Fix the build")).await, Ok(()));
    let requests = gateway.join().unwrap();
    let (head, body) = requests[1].split_once("\r\n\r\n").unwrap();
    assert!(
        head.starts_with("POST /api/v1/conn/environments/env-1/threads HTTP/1.1"),
        "{head}"
    );
    assert!(
        head.to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    assert_eq!(
        serde_json::from_str::<Value>(body).unwrap(),
        json!({"thread_id": "t1", "title": "Fix the build"})
    );
}
