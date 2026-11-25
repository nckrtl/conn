use std::path::PathBuf;
use std::sync::Mutex;

use conn_contract::from_json;
use conn_engine::{Engine, EngineConfig, ProjectConfig};

use super::*;

const ROOT: &str = "/tmp/conn-thread-push-project";

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

/// The host's own observer in these tests: it only says when a turn ends.
#[derive(Default)]
struct Ends(tokio::sync::Notify);

impl TurnObserver for Ends {
    fn turn_started(&self, _point: TurnPoint) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }

    fn turn_ended(&self, _point: TurnPoint, _status: String) -> BoxFuture<'_, ()> {
        self.0.notify_one();
        Box::pin(std::future::ready(()))
    }
}

/// A sender that records each thread and answers with a fixed result, or never answers.
struct FakeSender {
    sent: Mutex<Vec<NewThread>>,
    answer: Option<Result<(), String>>,
    arrived: tokio::sync::Notify,
}

impl FakeSender {
    fn answering(answer: Result<(), String>) -> Arc<Self> {
        Arc::new(Self {
            sent: Mutex::default(),
            answer: Some(answer),
            arrived: tokio::sync::Notify::new(),
        })
    }

    fn never_answering() -> Arc<Self> {
        Arc::new(Self {
            sent: Mutex::default(),
            answer: None,
            arrived: tokio::sync::Notify::new(),
        })
    }

    fn sent(&self) -> Vec<NewThread> {
        self.sent.lock().unwrap().clone()
    }
}

impl ThreadSender for FakeSender {
    fn record(&self, thread: NewThread) -> BoxFuture<'static, Result<(), String>> {
        self.sent.lock().unwrap().push(thread);
        self.arrived.notify_one();
        match self.answer.clone() {
            Some(answer) => Box::pin(std::future::ready(answer)),
            None => Box::pin(std::future::pending()),
        }
    }
}

fn open(dir: &TempDir, push: &Arc<ThreadPush>) -> Arc<SqliteEngine> {
    let mut config = EngineConfig::new(dir.0.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![Arc::new(conn_engine::fake::FakeProvider::new(
        "claudeAgent",
    ))];
    config.turn_observer = Some(push.clone());
    let engine = Arc::new(SqliteEngine::open(config).unwrap());
    push.attach(&engine);
    engine
}

async fn dispatch(engine: &SqliteEngine, command: Value) {
    engine
        .dispatch(from_json(command).unwrap())
        .await
        .ok()
        .unwrap();
}

async fn create(engine: &SqliteEngine, thread: &str) {
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
}

async fn send(engine: &SqliteEngine, thread: &str, message: &str) {
    dispatch(
        engine,
        json!({
            "type": "message.dispatch", "commandId": format!("{thread}:{message}"),
            "threadId": thread, "messageId": format!("{thread}:{message}"), "text": "done",
            "attachments": [], "dispatchMode": {"type": "start_immediately"},
            "createdBy": "user", "creationSource": "web",
        }),
    )
    .await;
}

async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
}

#[tokio::test(flavor = "current_thread")]
async fn the_first_turn_tells_the_gateway_once() {
    let dir = TempDir::new();
    let ends = Arc::new(Ends::default());
    let sender = FakeSender::answering(Ok(()));
    let push = ThreadPush::new(ends.clone(), sender.clone(), "env-1".into());
    let engine = open(&dir, &push);
    create(&engine, "t1").await;
    assert!(
        sender.sent().is_empty(),
        "a thread with no message is not announced"
    );
    send(&engine, "t1", "first").await;
    within("the push", sender.arrived.notified()).await;
    within("the first turn", ends.0.notified()).await;
    send(&engine, "t1", "second").await;
    within("the second turn", ends.0.notified()).await;
    assert_eq!(
        sender.sent(),
        [NewThread {
            environment_id: "env-1".into(),
            thread_id: "t1".into(),
            title: "Fix the build".into(),
        }]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_or_stuck_call_never_holds_the_turn() {
    for sender in [
        FakeSender::answering(Err("the Gateway answered 502".into())),
        FakeSender::never_answering(),
    ] {
        let dir = TempDir::new();
        let ends = Arc::new(Ends::default());
        let push = ThreadPush::new(ends.clone(), sender.clone(), "env-1".into());
        let engine = open(&dir, &push);
        create(&engine, "t1").await;
        send(&engine, "t1", "first").await;
        within("the push", sender.arrived.notified()).await;
        within("the turn to end", ends.0.notified()).await;
        assert_eq!(sender.sent().len(), 1);
    }
}

#[test]
fn only_a_titled_host_thread_is_announced() {
    let shell = |extra: Value| {
        let mut shell = json!({
            "id": "t1", "title": " Fix the build ", "lineage": {"relationshipToParent": null},
            "archivedAt": null, "deletedAt": null,
        });
        if let (Some(shell), Some(extra)) = (shell.as_object_mut(), extra.as_object()) {
            shell.extend(extra.clone());
        }
        shell
    };
    let cases = [
        (json!({}), Some("Fix the build")),
        (
            json!({"lineage": {"relationshipToParent": "subagent"}}),
            None,
        ),
        (json!({"lineage": {"sideChat": true}}), None),
        (json!({"delegatedFrom": {"environmentId": "env-2"}}), None),
        (json!({"archivedAt": "2026-11-25T10:00:00.000Z"}), None),
        (json!({"title": "  "}), None),
        (json!({"title": null}), None),
    ];
    for (extra, want) in cases {
        let row = shell(extra.clone());
        assert_eq!(title_to_announce(&row).as_deref(), want, "shell row {row}");
    }
}

#[test]
fn the_request_is_the_gateways_thread_record() {
    let thread = NewThread {
        environment_id: "80d960ee-87c0-4a13-8a79-96617f4a5173".into(),
        thread_id: "t/1".into(),
        title: "Fix \"it\"".into(),
    };
    let (url, body) = request("https://gateway.orbit", &thread);
    assert_eq!(
        url,
        "https://gateway.orbit/api/v1/conn/environments/80d960ee-87c0-4a13-8a79-96617f4a5173/threads"
    );
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body, json!({"thread_id": "t/1", "title": "Fix \"it\""}));
}

#[test]
fn the_gateway_variable_must_be_a_url() {
    assert_eq!(
        gateway_url(Some(" https://gateway.orbit ")).as_deref(),
        Some("https://gateway.orbit")
    );
    assert_eq!(
        gateway_url(Some("http://10.44.0.1:8080")).as_deref(),
        Some("http://10.44.0.1:8080")
    );
    for value in [
        None,
        Some(""),
        Some("  "),
        Some("gateway.orbit"),
        Some("ftp://x"),
    ] {
        assert_eq!(gateway_url(value), None, "value {value:?}");
    }
    assert_eq!(
        CurlSender::new("https://gateway.orbit/").base,
        "https://gateway.orbit"
    );
}

/// The system curl posts the JSON body from stdin to a stand-in Gateway on loopback.
#[tokio::test(flavor = "current_thread")]
async fn curl_posts_the_record_to_the_gateway() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let gateway = std::thread::spawn(move || {
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
            .write_all(b"HTTP/1.1 201 Created\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
            .unwrap();
        String::from_utf8(request).unwrap()
    });
    let sender = CurlSender::new(&base);
    let sent = sender
        .record(NewThread {
            environment_id: "env-1".into(),
            thread_id: "t1".into(),
            title: "Fix the build".into(),
        })
        .await;
    assert_eq!(sent, Ok(()));
    let request = gateway.join().unwrap();
    let (head, body) = request.split_once("\r\n\r\n").unwrap();
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
