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
