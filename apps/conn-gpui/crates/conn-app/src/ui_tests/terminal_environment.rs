//! The terminal belongs to the thread on screen: a thread on a linked environment gets its shell
//! on that machine, through that environment's connection and in the thread's folder; a local
//! thread keeps a local shell; switching threads switches sessions.

use std::time::Duration;

use conn_client::{ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig};
use conn_theme::Tokens;
use futures::StreamExt as _;
use gpui_kit::{AppContext as _, Entity, TestAppContext};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{linked_mini_shell, mount_two_thread_app, render_frames};
use crate::live::RT;
use crate::panels::terminal::TerminalPanel;
use crate::panels::terminal_target::{SessionKey, TerminalTarget};

type Requests = std::sync::mpsc::Receiver<(String, Value)>;

/// A loopback server that reports every `terminal.*` request it hears.
fn terminal_server() -> (
    Connection,
    Requests,
    tokio::sync::mpsc::Receiver<ClientEvent>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<(String, Value)>();
    let addr = RT.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a loopback listener");
        let addr = listener.local_addr().expect("listener address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            if let conn_wire::FromClient::Request(req) = frame
                                && req.tag.starts_with("terminal.")
                            {
                                let _ = tx.send((req.tag, req.payload));
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    let config = ServerConfig {
        http_base_url: url::Url::parse(&format!("http://{addr}")).expect("loopback URL"),
        credential: Credential::Bearer("test-token".to_owned()),
    };
    let (connection, mut events) = Connection::start(config, RT.handle());
    RT.block_on(async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                tokio::time::timeout(Duration::from_secs(1), events.recv()).await
            {
                return;
            }
        }
        panic!("the loopback server never connected");
    });
    (connection, rx, events)
}

/// The next request the server heard, once the app has run long enough to send it.
fn next_request(cx: &mut TestAppContext, requests: &Requests) -> Option<(String, Value)> {
    for _ in 0..100 {
        cx.run_until_parked();
        if let Ok(request) = requests.try_recv() {
            return Some(request);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

fn new_panel(cx: &mut TestAppContext) -> Entity<TerminalPanel> {
    let theme = conn_theme::theme_by_id("dark-ocean").expect("dark-ocean is built in");
    let tokens = Tokens::derive(&theme);
    cx.new(|cx| TerminalPanel::new(tokens, cx))
}

fn target(environment: Option<&str>, thread: &str, cwd: &str, remote: bool) -> TerminalTarget {
    TerminalTarget {
        key: SessionKey {
            environment: environment.map(str::to_owned),
            thread: Some(thread.to_owned()),
        },
        cwd: Some(cwd.to_owned()),
        label: environment.map(str::to_owned),
        remote,
    }
}

fn show(
    cx: &mut TestAppContext,
    panel: &Entity<TerminalPanel>,
    target: TerminalTarget,
    connection: Option<Connection>,
) {
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            panel.set_target(target, connection, cx);
            panel.ensure_started(cx);
        });
    });
}

fn sessions(
    cx: &mut TestAppContext,
    panel: &Entity<TerminalPanel>,
) -> Vec<(SessionKey, &'static str)> {
    cx.read(|cx| panel.read(cx).sessions_for_test())
}

// ------------------------------------------------ a connection that drops and comes back

/// What a test tells the scripted terminal server to do.
#[derive(Clone, Debug)]
enum Control {
    /// Close every open socket. The server keeps listening, so the client can reconnect.
    Drop,
    /// The shell prints `data`; every attached socket hears it.
    Output(String),
    /// The shell exits.
    Exit,
}

/// A loopback server that plays a terminal: it answers `terminal.attach` with a snapshot of the
/// shell's history, then streams what `Control::Output` prints. It reports each `terminal.*`
/// request with the number of the socket that sent it.
struct ScriptedServer {
    connection: Connection,
    control: tokio::sync::broadcast::Sender<Control>,
    heard: std::sync::mpsc::Receiver<(usize, String, Value)>,
    seen: Vec<(usize, String, Value)>,
    _events: tokio::sync::mpsc::Receiver<ClientEvent>,
}

impl ScriptedServer {
    fn start() -> Self {
        let (control, _) = tokio::sync::broadcast::channel::<Control>(16);
        let (heard_tx, heard) = std::sync::mpsc::channel();
        let history = std::sync::Arc::new(std::sync::Mutex::new("agent$ ".to_owned()));
        let sockets = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let addr = RT.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind a loopback listener");
            let addr = listener.local_addr().expect("listener address");
            let control = control.clone();
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    let socket = sockets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::spawn(scripted_socket(
                        tcp,
                        socket,
                        control.subscribe(),
                        heard_tx.clone(),
                        history.clone(),
                    ));
                }
            });
            addr
        });
        let config = ServerConfig {
            http_base_url: url::Url::parse(&format!("http://{addr}")).expect("loopback URL"),
            credential: Credential::Bearer("test-token".to_owned()),
        };
        let (connection, mut events) = Connection::start(config, RT.handle());
        RT.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while tokio::time::Instant::now() < deadline {
                if let Ok(Some(ClientEvent::Status(ConnectionStatus::Connected))) =
                    tokio::time::timeout(Duration::from_secs(1), events.recv()).await
                {
                    return;
                }
            }
            panic!("the scripted server never connected");
        });
        Self {
            connection,
            control,
            heard,
            seen: Vec::new(),
            _events: events,
        }
    }

    fn tell(&self, control: Control) {
        self.control
            .send(control)
            .expect("a socket listens for the control message");
    }

    /// Every `terminal.*` request heard so far, as (socket number, tag, payload).
    fn requests(&mut self) -> &[(usize, String, Value)] {
        while let Ok(request) = self.heard.try_recv() {
            self.seen.push(request);
        }
        &self.seen
    }

    fn count(&mut self, tag: &str) -> usize {
        self.requests().iter().filter(|(_, t, _)| t == tag).count()
    }

    /// The highest socket number that sent a request, plus one: how many sockets spoke.
    fn sockets_heard(&mut self) -> usize {
        self.requests()
            .iter()
            .map(|(socket, _, _)| socket + 1)
            .max()
            .unwrap_or(0)
    }
}

fn terminal_event(kind: &str, extra: Value) -> Value {
    let mut event = serde_json::json!({
        "type": kind, "threadId": "thread-a", "terminalId": "term-1"
    });
    if let (Some(event), Some(extra)) = (event.as_object_mut(), extra.as_object()) {
        event.extend(extra.clone());
    }
    event
}

async fn scripted_socket(
    tcp: tokio::net::TcpStream,
    socket: usize,
    mut control: tokio::sync::broadcast::Receiver<Control>,
    heard: std::sync::mpsc::Sender<(usize, String, Value)>,
    history: std::sync::Arc<std::sync::Mutex<String>>,
) {
    use conn_wire::{Exit, FromClient, FromServer, encode_server_frame};
    use futures::SinkExt as _;

    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
        return;
    };
    let mut attach_id = None;
    loop {
        let chunk = |request_id, event| {
            Message::Text(
                encode_server_frame(&FromServer::Chunk {
                    request_id,
                    values: vec![event],
                })
                .into(),
            )
        };
        tokio::select! {
            message = ws.next() => {
                let Some(Ok(Message::Text(text))) = message else { return };
                for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                    let FromClient::Request(req) = frame else { continue };
                    if !req.tag.starts_with("terminal.") {
                        continue;
                    }
                    let _ = heard.send((socket, req.tag.clone(), req.payload.clone()));
                    if req.tag == "terminal.attach" {
                        attach_id = Some(req.id.clone());
                        let snapshot = serde_json::json!({
                            "type": "snapshot",
                            "snapshot": {
                                "threadId": "thread-a", "terminalId": "term-1",
                                "cwd": "/srv/a", "worktreePath": null, "status": "running",
                                "pid": 1, "history": history.lock().expect("history").clone(),
                                "exitCode": null, "exitSignal": null, "label": "zsh",
                                "updatedAt": "2026-11-26T10:00:00.000Z"
                            }
                        });
                        let _ = ws.send(chunk(req.id, snapshot)).await;
                    } else {
                        let reply = FromServer::Exit {
                            request_id: req.id,
                            exit: Exit::success(Value::Null),
                        };
                        let _ = ws.send(Message::Text(encode_server_frame(&reply).into())).await;
                    }
                }
            }
            told = control.recv() => match told {
                Ok(Control::Drop) => {
                    let _ = ws.close(None).await;
                    return;
                }
                Ok(Control::Output(data)) => {
                    history.lock().expect("history").push_str(&data);
                    if let Some(id) = attach_id.clone() {
                        let event = terminal_event("output", serde_json::json!({ "data": data }));
                        let _ = ws.send(chunk(id, event)).await;
                    }
                }
                Ok(Control::Exit) => {
                    if let Some(id) = attach_id.clone() {
                        let event = terminal_event(
                            "exited",
                            serde_json::json!({ "exitCode": 0, "exitSignal": null }),
                        );
                        let _ = ws.send(chunk(id, event)).await;
                    }
                }
                Err(_) => return,
            },
        }
    }
}

/// Runs the app (and its clock, which times the reattach delay) until `done` holds.
fn wait_until(
    cx: &mut TestAppContext,
    what: &str,
    mut done: impl FnMut(&mut TestAppContext) -> bool,
) {
    for _ in 0..400 {
        cx.run_until_parked();
        if done(cx) {
            return;
        }
        cx.executor().advance_clock(Duration::from_millis(300));
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

fn first_row(cx: &mut TestAppContext, panel: &Entity<TerminalPanel>) -> String {
    cx.read(|cx| panel.read(cx).first_row_for_test())
}

fn reconnecting(cx: &mut TestAppContext, panel: &Entity<TerminalPanel>) -> bool {
    cx.read(|cx| panel.read(cx).reconnecting_for_test())
}

fn type_into(cx: &mut TestAppContext, panel: &Entity<TerminalPanel>, text: &str) {
    cx.update(|cx| panel.update(cx, |panel, cx| panel.type_for_test(text, cx)));
}

#[gpui_kit::test]
fn a_dropped_connection_reattaches_the_same_terminal_and_never_restarts_it(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let mut server = ScriptedServer::start();
    let panel = new_panel(cx);
    show(
        cx,
        &panel,
        target(Some("agent"), "thread-a", "/srv/a", true),
        Some(server.connection.clone()),
    );
    wait_until(cx, "the first snapshot", |cx| {
        first_row(cx, &panel) == "agent$"
    });

    // Typing reaches the shell while the connection is up.
    type_into(cx, &panel, "ls");
    wait_until(cx, "the first write", |_| {
        server.count("terminal.write") == 1
    });
    server.tell(Control::Output("ls".to_owned()));
    wait_until(cx, "the echo", |cx| first_row(cx, &panel) == "agent$ ls");

    // The WebSocket drops (sleep, a network blip, a server restart) and comes back by itself.
    server.tell(Control::Drop);
    wait_until(cx, "the panel to notice the drop", |cx| {
        reconnecting(cx, &panel)
    });
    assert_eq!(
        first_row(cx, &panel),
        "agent$ ls",
        "the screen stays while it reconnects"
    );

    // Typing while disconnected is blocked, not queued: it never reaches the shell later.
    type_into(cx, &panel, "rm -rf nothing\r");

    wait_until(cx, "the second attach", |_| {
        server.count("terminal.attach") == 2
    });
    wait_until(cx, "the panel to be back", |cx| !reconnecting(cx, &panel));
    assert_eq!(
        server.sockets_heard(),
        2,
        "the second attach came on the new socket"
    );
    let attaches: Vec<Value> = server
        .requests()
        .iter()
        .filter(|(_, tag, _)| tag == "terminal.attach")
        .map(|(_, _, payload)| payload.clone())
        .collect();
    assert_eq!(attaches[0]["threadId"], attaches[1]["threadId"]);
    assert_eq!(attaches[1]["threadId"], "thread-a");
    assert_eq!(attaches[0]["terminalId"], "term-1");
    assert_eq!(
        attaches[1]["terminalId"], "term-1",
        "the same terminal id, so the server's shell and history stay"
    );

    // The server's replay replaces the screen: the scrollback is neither lost nor doubled.
    wait_until(cx, "the replay", |cx| first_row(cx, &panel) == "agent$ ls");

    // Output after the reconnect arrives, and typing works again.
    server.tell(Control::Output("x".to_owned()));
    wait_until(cx, "output after the reconnect", |cx| {
        first_row(cx, &panel) == "agent$ lsx"
    });
    type_into(cx, &panel, "q");
    wait_until(cx, "a write after the reconnect", |_| {
        server.count("terminal.write") == 2
    });

    assert_eq!(
        server.count("terminal.close"),
        0,
        "reconnecting never closes the shell"
    );
    let writes: Vec<String> = server
        .requests()
        .iter()
        .filter(|(_, tag, _)| tag == "terminal.write")
        .map(|(_, _, payload)| payload["data"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(
        writes,
        ["ls", "q"],
        "input typed while disconnected was dropped, not replayed"
    );
    assert!(
        !cx.read(|cx| panel.read(cx).exited_for_test()),
        "the terminal did not end"
    );
}

#[gpui_kit::test]
fn a_shell_that_exits_is_not_attached_again(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let mut server = ScriptedServer::start();
    let panel = new_panel(cx);
    show(
        cx,
        &panel,
        target(Some("agent"), "thread-a", "/srv/a", true),
        Some(server.connection.clone()),
    );
    wait_until(cx, "the first snapshot", |cx| {
        first_row(cx, &panel) == "agent$"
    });

    server.tell(Control::Exit);
    wait_until(cx, "the exit", |cx| {
        cx.read(|cx| panel.read(cx).exited_for_test())
    });
    for _ in 0..40 {
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(300));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        server.count("terminal.attach"),
        1,
        "an ended shell is not attached again"
    );
    assert!(!reconnecting(cx, &panel));
}

#[gpui_kit::test]
fn a_local_shell_ignores_a_dropped_connection(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let mut server = ScriptedServer::start();
    let panel = new_panel(cx);
    let folder = std::env::temp_dir().to_string_lossy().into_owned();
    show(
        cx,
        &panel,
        target(None, "thread-local", &folder, false),
        Some(server.connection.clone()),
    );

    // Drop the primary connection and let it come back: a local PTY does not care.
    server.tell(Control::Drop);
    let before = cx.read(|cx| sessions_len(&panel, cx));
    for _ in 0..40 {
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(300));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(before, 1);
    let kinds: Vec<&str> = sessions(cx, &panel).iter().map(|(_, kind)| *kind).collect();
    assert_eq!(kinds, ["local"]);
    assert!(!reconnecting(cx, &panel));
    assert!(!cx.read(|cx| panel.read(cx).exited_for_test()));
    assert!(
        server.requests().is_empty(),
        "a local shell sends no terminal request, before or after the drop"
    );
}

fn sessions_len(panel: &Entity<TerminalPanel>, cx: &gpui_kit::App) -> usize {
    panel.read(cx).sessions_for_test().len()
}

#[gpui_kit::test]
fn a_linked_thread_opens_its_terminal_through_its_own_connection(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (agent, agent_requests, _agent_events) = terminal_server();
    let (primary, primary_requests, _primary_events) = terminal_server();
    let panel = new_panel(cx);

    show(
        cx,
        &panel,
        target(Some("agent"), "thread-a", "/srv/agent/worktree", true),
        Some(agent),
    );

    let (tag, payload) = next_request(cx, &agent_requests).expect("the agent heard the attach");
    assert_eq!(tag, "terminal.attach");
    assert_eq!(payload["threadId"], "thread-a");
    assert_eq!(payload["terminalId"], "term-1");
    assert_eq!(payload["cwd"], "/srv/agent/worktree");
    assert!(
        next_request(cx, &primary_requests).is_none(),
        "the primary server never hears of a thread that lives on the agent"
    );
    assert_eq!(
        sessions(cx, &panel)
            .iter()
            .map(|(_, backend)| *backend)
            .collect::<Vec<_>>(),
        ["remote"],
        "no local shell starts for it"
    );
    assert_eq!(
        cx.read(|cx| panel.read(cx).machine_label().map(str::to_owned)),
        Some("agent".to_owned())
    );
    drop(primary);
}

#[gpui_kit::test]
fn a_remote_thread_waits_for_its_connection_instead_of_opening_on_this_mac(
    cx: &mut TestAppContext,
) {
    let panel = new_panel(cx);
    show(
        cx,
        &panel,
        target(Some("agent"), "thread-a", "/srv/agent/worktree", true),
        None,
    );
    assert!(sessions(cx, &panel).is_empty());
    assert!(cx.read(|cx| panel.read(cx).waiting_for_connection_for_test()));
}

#[gpui_kit::test]
fn a_local_thread_still_opens_a_local_shell_in_its_folder(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (primary, primary_requests, _events) = terminal_server();
    let panel = new_panel(cx);
    let folder = std::env::temp_dir();
    show(
        cx,
        &panel,
        target(None, "thread-local", &folder.to_string_lossy(), false),
        Some(primary),
    );
    let sessions = sessions(cx, &panel);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].1, "local");
    assert!(
        next_request(cx, &primary_requests).is_none(),
        "a local shell needs no terminal RPC"
    );
}

#[gpui_kit::test]
fn switching_threads_switches_terminal_sessions(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (agent, agent_requests, _events) = terminal_server();
    let panel = new_panel(cx);
    let folder = std::env::temp_dir().to_string_lossy().into_owned();

    let remote_a = target(Some("agent"), "thread-a", "/srv/a", true);
    let remote_b = target(Some("agent"), "thread-b", "/srv/b", true);
    let local = target(None, "thread-a", &folder, false);

    show(cx, &panel, remote_a.clone(), Some(agent.clone()));
    let (_, first) = next_request(cx, &agent_requests).expect("thread A attaches");
    assert_eq!(first["threadId"], "thread-a");

    // Thread B on the same machine has its own terminal, not A's.
    show(cx, &panel, remote_b.clone(), Some(agent.clone()));
    let (_, second) = next_request(cx, &agent_requests).expect("thread B attaches");
    assert_eq!(second["threadId"], "thread-b");
    assert_eq!(second["cwd"], "/srv/b");
    assert_eq!(
        cx.read(|cx| panel.read(cx).target_for_test().key.clone()),
        remote_b.key
    );

    // A local thread with the same id as A's is another session: the environment is part of the key.
    show(cx, &panel, local.clone(), Some(agent.clone()));
    assert_eq!(
        cx.read(|cx| panel.read(cx).target_for_test().key.clone()),
        local.key
    );
    assert_eq!(sessions(cx, &panel).len(), 3);

    // Back on A: its session is still there, so nothing attaches again.
    show(cx, &panel, remote_a.clone(), Some(agent));
    assert_eq!(
        cx.read(|cx| panel.read(cx).target_for_test().key.clone()),
        remote_a.key
    );
    assert_eq!(sessions(cx, &panel).len(), 3);
    assert!(next_request(cx, &agent_requests).is_none());
}

#[gpui_kit::test]
fn the_app_points_the_terminal_at_the_threads_machine_and_folder(cx: &mut TestAppContext) {
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/work/mini", "Mini diagnostics"),
                cx,
            );
            app.select_thread("thread-mini", cx);
        })
    });
    render_frames(cx, window);
    let terminal = cx.read(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .terminal_entity()
    });
    let shown = cx.read(|cx| terminal.read(cx).target_for_test().clone());
    assert_eq!(shown.key.environment.as_deref(), Some("mini"));
    assert_eq!(shown.key.thread.as_deref(), Some("thread-mini"));
    assert_eq!(shown.cwd.as_deref(), Some("/work/mini"));
    assert_eq!(shown.label.as_deref(), Some("mini"));
    assert!(shown.remote);

    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-selected", cx)));
    render_frames(cx, window);
    let shown = cx.read(|cx| terminal.read(cx).target_for_test().clone());
    assert_eq!(shown.key.environment, None);
    assert_eq!(shown.key.thread.as_deref(), Some("thread-selected"));
    assert!(
        !shown.remote,
        "a thread on this Mac's server keeps a local shell"
    );
    assert!(
        shown.cwd.is_some(),
        "and still opens in the thread's folder"
    );
}

// ------------------------------------------------ sessions that go

fn key(environment: Option<&str>, thread: &str) -> SessionKey {
    SessionKey {
        environment: environment.map(str::to_owned),
        thread: Some(thread.to_owned()),
    }
}

fn session_keys(cx: &mut TestAppContext, panel: &Entity<TerminalPanel>) -> Vec<SessionKey> {
    sessions(cx, panel)
        .into_iter()
        .map(|(key, _)| key)
        .collect()
}

/// Deleting a thread frees its terminal session, emulator and scrollback, and only its own: the
/// same thread id on another environment and other threads keep theirs.
#[gpui_kit::test]
fn deleting_a_thread_frees_its_terminal(cx: &mut TestAppContext) {
    let (_window, app) = super::mount_app(cx);
    let panel = cx.read(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .terminal_entity()
    });
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            panel.insert_session_for_test(key(None, "doomed"), false, cx);
            panel.insert_session_for_test(key(Some("mini"), "doomed"), false, cx);
            panel.insert_session_for_test(key(None, "other"), true, cx);
        });
        app.update(cx, |app, cx| app.forget_thread_terminal(None, "doomed", cx));
    });
    let left = session_keys(cx, &panel);
    assert!(!left.contains(&key(None, "doomed")), "{left:?}");
    assert!(left.contains(&key(Some("mini"), "doomed")), "{left:?}");
    assert!(left.contains(&key(None, "other")), "{left:?}");
}

/// Past the cap, the least recently shown ended sessions go. Live local shells and the session on
/// screen stay whatever the count.
#[gpui_kit::test]
fn parked_terminals_are_capped_without_ending_live_local_shells(cx: &mut TestAppContext) {
    use crate::panels::terminal::MAX_PARKED_SESSIONS;

    let panel = new_panel(cx);
    let ended = MAX_PARKED_SESSIONS + 3;
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            for i in 0..2 {
                panel.insert_session_for_test(key(None, &format!("live-{i}")), false, cx);
            }
            for i in 0..ended {
                let id = format!("ended-{i:02}");
                // Show each, oldest first, so the cap knows which was on screen last.
                panel.set_target(target(None, &id, "/tmp", false), None, cx);
                panel.insert_session_for_test(key(None, &id), true, cx);
            }
            panel.set_target(target(None, "current", "/tmp", false), None, cx);
        });
    });
    let left = session_keys(cx, &panel);
    assert_eq!(left.len(), MAX_PARKED_SESSIONS, "{left:?}");
    for i in 0..2 {
        assert!(left.contains(&key(None, &format!("live-{i}"))), "{left:?}");
    }
    for i in 0..ended - (MAX_PARKED_SESSIONS - 2) {
        assert!(
            !left.contains(&key(None, &format!("ended-{i:02}"))),
            "the oldest ended sessions went: {left:?}"
        );
    }
    assert!(left.contains(&key(None, &format!("ended-{:02}", ended - 1))));
}

/// Switching threads frees the parked ended terminals of threads that left the lists. A live
/// local shell of such a thread stays, and so do listed threads' sessions.
#[gpui_kit::test]
fn switching_threads_frees_terminals_of_threads_that_are_gone(cx: &mut TestAppContext) {
    let (_window, app) = super::mount_app(cx);
    let panel = cx.read(|cx| {
        app.read(cx)
            .right_panel_for_test()
            .read(cx)
            .terminal_entity()
    });
    cx.update(|cx| {
        app.update(cx, |app, cx| app.set_shell(super::kitchen_sink_shell(), cx));
        panel.update(cx, |panel, cx| {
            panel.insert_session_for_test(key(None, "gone-ended"), true, cx);
            panel.insert_session_for_test(key(None, "gone-live"), false, cx);
            panel.insert_session_for_test(key(None, "thread-pinned"), true, cx);
        });
        app.update(cx, |app, cx| app.select_thread("thread-failed", cx));
    });
    let left = session_keys(cx, &panel);
    assert!(!left.contains(&key(None, "gone-ended")), "{left:?}");
    assert!(left.contains(&key(None, "gone-live")), "{left:?}");
    assert!(left.contains(&key(None, "thread-pinned")), "{left:?}");
}
