//! A send the server has not taken yet: the tray shows it while it waits, it fails after
//! [`SEND_TIMEOUT`] and its draft comes back, and sending that draft again unchanged reuses its
//! `commandId`, so a message that did land is not posted twice.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_client::{ConnectionStatus, Credential, ServerConfig};
use conn_contract::ChatAttachment;
use conn_wire::{Exit, FromClient, FromServer, Request, encode_server_frame};
use futures::{SinkExt, StreamExt};
use gpui_kit::{AnyWindowHandle, AppContext as _, Entity, TestAppContext};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::ConnApp;
use super::reconnect_tests::{OPEN, shell_snapshot, thread_snapshot};
use super::send_pending::{SEND_TIMEOUT, SLOW_SEND_AFTER};
use crate::chat::SendDispatch;
use crate::live::RT;
use crate::ui_tests::mount_app_with_server;

/// Answer each `dispatchCommand`.
const ANSWER: u8 = 0;
/// Take the message, then drop the session before answering: it landed, but the app never
/// hears so.
const DROP_AFTER_LANDING: u8 = 1;
/// Take the message and never answer.
const NEVER_ANSWER: u8 = 2;

/// One `dispatchCommand` the server got.
#[derive(Clone, Debug)]
struct Dispatch {
    command_id: String,
    text: String,
}

/// What the server did with the commands it got. Like conn-server, it keeps a receipt per
/// `commandId` and answers a repeat from it without posting the message again.
#[derive(Debug, Default)]
struct Ledger {
    receipts: HashSet<String>,
    /// Every dispatch, repeats included.
    dispatches: Vec<Dispatch>,
    /// The messages that landed in the thread.
    posted: Vec<String>,
}

struct FakeServer {
    url: url::Url,
    ledger: Arc<Mutex<Ledger>>,
    mode: Arc<AtomicU8>,
    /// While set, every socket is accepted and dropped at once.
    down: Arc<AtomicBool>,
    /// Bumping it drops every open session.
    restart: tokio::sync::watch::Sender<u64>,
}

impl FakeServer {
    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger.lock().expect("ledger")
    }

    /// Restarts the server: open sessions drop, and new ones are refused until [`Self::up`].
    fn go_down(&self) {
        self.down.store(true, Ordering::Release);
        self.restart.send_modify(|generation| *generation += 1);
    }

    fn up(&self) {
        self.down.store(false, Ordering::Release);
    }
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
                thread_snapshot(id, 20, 1),
                json!({ "kind": "synchronized" }),
            ]))
        }
        _ => None,
    }
}

/// What the server does with one `dispatchCommand`: `None` drops the session.
fn dispatch(request: &Request, ledger: &Mutex<Ledger>, mode: u8) -> Option<Option<FromServer>> {
    let command_id = request.payload["commandId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let text = request.payload["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    {
        let mut ledger = ledger.lock().expect("ledger");
        ledger.dispatches.push(Dispatch {
            command_id: command_id.clone(),
            text: text.clone(),
        });
        if ledger.receipts.insert(command_id) {
            ledger.posted.push(text);
        }
    }
    match mode {
        DROP_AFTER_LANDING => None,
        NEVER_ANSWER => Some(None),
        _ => Some(Some(FromServer::Exit {
            request_id: request.id.clone(),
            exit: Exit::success(json!({ "sequence": 30 })),
        })),
    }
}

fn spawn_fake_server() -> FakeServer {
    let ledger = Arc::new(Mutex::new(Ledger::default()));
    let mode = Arc::new(AtomicU8::new(ANSWER));
    let down = Arc::new(AtomicBool::new(false));
    let (restart, restarts) = tokio::sync::watch::channel(0_u64);
    let (server_ledger, server_mode, accept_down) =
        (Arc::clone(&ledger), Arc::clone(&mode), Arc::clone(&down));
    let addr = RT.block_on(async move {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                if accept_down.load(Ordering::Acquire) {
                    drop(tcp);
                    continue;
                }
                let (ledger, mode) = (Arc::clone(&server_ledger), Arc::clone(&server_mode));
                let mut restarts = restarts.clone();
                restarts.mark_unchanged();
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
                                FromClient::Request(request)
                                    if request.tag == "orchestration.dispatchCommand" =>
                                {
                                    match dispatch(&request, &ledger, mode.load(Ordering::Acquire))
                                    {
                                        Some(answer) => answer,
                                        None => return,
                                    }
                                }
                                FromClient::Request(request) => reply(&request),
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
        ledger,
        mode,
        down,
        restart,
    }
}

/// Pumps the app until `done` holds, or fails after a while.
fn pump_until(
    cx: &mut TestAppContext,
    app: &Entity<ConnApp>,
    what: &str,
    mut done: impl FnMut(&ConnApp, &FakeServer, &gpui_kit::App) -> bool,
    server: &FakeServer,
) {
    for _ in 0..1000 {
        cx.run_until_parked();
        if cx.read(|cx| done(app.read(cx), server, cx)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!(
        "timed out waiting until {what}; server saw: {:#?}",
        server.ledger()
    );
}

/// Lets real time pass for the connection driver while the app runs.
fn settle(cx: &mut TestAppContext) {
    for _ in 0..30 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// The app, connected to `server` with [`OPEN`] selected.
fn open_app(cx: &mut TestAppContext, server: &FakeServer) -> (AnyWindowHandle, Entity<ConnApp>) {
    cx.executor().allow_parking();
    let (window, app) = mount_app_with_server(
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
    pump_until(
        cx,
        &app,
        "the shell lists the thread",
        |app, _, _| app.shell.find_thread(OPEN).is_some(),
        server,
    );
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread(OPEN, cx)));
    pump_until(
        cx,
        &app,
        "the thread loads",
        |app, _, _| {
            matches!(app.status, Some(ConnectionStatus::Connected))
                && app.thread(OPEN).is_some_and(|t| !t.entries.is_empty())
        },
        server,
    );
    (window, app)
}

/// Sends `text` and `attachments` to the open thread, as the composer does.
fn send(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    text: &str,
    attachments: Vec<ChatAttachment>,
) {
    let text = text.to_owned();
    cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.send_prompt_with_attachments(
                text,
                attachments,
                SendDispatch::Auto,
                Some(window),
                cx,
            );
        });
    })
    .expect("the window");
}

fn pending_rows(app: &ConnApp, cx: &gpui_kit::App) -> Vec<crate::chat::PendingSendRow> {
    app.chat.read(cx).pending_sends_for_test()
}

fn error(app: &ConnApp, cx: &gpui_kit::App) -> Option<String> {
    app.chat.read(cx).error_for_test()
}

fn draft_text(app: &ConnApp, cx: &gpui_kit::App) -> String {
    app.chat
        .read(cx)
        .composer_for_test()
        .read(cx)
        .draft_text_for_test(cx)
}

fn draft_attachments(app: &ConnApp, cx: &gpui_kit::App) -> Vec<(String, String)> {
    app.chat
        .read(cx)
        .composer_for_test()
        .read(cx)
        .attachment_states_for_test()
}

fn notes_attachment() -> ChatAttachment {
    conn_contract::from_json(json!({
        "type": "file",
        "id": "att-notes",
        "name": "notes.txt",
        "mimeType": "text/plain",
        "sizeBytes": 12,
    }))
    .expect("a file attachment")
}

/// Sends `text` while the server takes every message but drops the session before it answers.
/// conn-client tries three sessions, then the send fails and its draft comes back. The message
/// landed once.
fn send_that_lands_without_an_answer(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    server: &FakeServer,
    text: &str,
    attachments: Vec<ChatAttachment>,
) {
    server.mode.store(DROP_AFTER_LANDING, Ordering::Release);
    send(cx, window, app, text, attachments);
    let expected = text.to_owned();
    pump_until(
        cx,
        app,
        "the send gives up and its draft comes back",
        |app, _, cx| app.sends.in_flight_for_test() == 0 && draft_text(app, cx) == expected,
        server,
    );
    server.mode.store(ANSWER, Ordering::Release);
    pump_until(
        cx,
        app,
        "the app reconnects",
        |app, _, _| matches!(app.status, Some(ConnectionStatus::Connected)),
        server,
    );
    let ledger = server.ledger();
    assert_eq!(
        ledger.posted,
        vec![text.to_owned()],
        "the message landed once"
    );
    assert!(
        ledger.dispatches.len() > 1,
        "conn-client sent it again after each drop: {:#?}",
        ledger.dispatches
    );
    let first = &ledger.dispatches[0].command_id;
    assert!(
        ledger.dispatches.iter().all(|d| &d.command_id == first),
        "every try had the same commandId: {:#?}",
        ledger.dispatches
    );
}

#[gpui_kit::test]
fn a_send_while_the_server_is_away_shows_as_waiting_then_goes_through(cx: &mut TestAppContext) {
    let server = spawn_fake_server();
    let (window, app) = open_app(cx, &server);

    server.go_down();
    pump_until(
        cx,
        &app,
        "the app notices the server is gone",
        |app, _, _| matches!(app.status, Some(ConnectionStatus::Reconnecting { .. })),
        &server,
    );
    send(
        cx,
        window,
        &app,
        "sent while the server is away",
        Vec::new(),
    );
    settle(cx);
    let rows = cx.read(|cx| pending_rows(app.read(cx), cx));
    assert_eq!(rows.len(), 1, "the tray shows the waiting send: {rows:#?}");
    assert_eq!(rows[0].preview, "sent while the server is away");
    assert!(rows[0].waiting);
    assert_eq!(rows[0].status(), "Waiting for connection");
    assert_eq!(cx.read(|cx| draft_text(app.read(cx), cx)), "");

    server.up();
    pump_until(
        cx,
        &app,
        "the send goes through after the reconnect",
        |app, server, cx| {
            !server.ledger().posted.is_empty()
                && app.sends.in_flight_for_test() == 0
                && pending_rows(app, cx).is_empty()
        },
        &server,
    );
    assert_eq!(
        server.ledger().posted,
        vec!["sent while the server is away".to_owned()]
    );
    cx.read(|cx| {
        let app = app.read(cx);
        assert_eq!(error(app, cx), None, "the send shows no error");
        assert_eq!(draft_text(app, cx), "", "the draft stays sent");
    });
}

#[gpui_kit::test]
fn a_send_that_waits_too_long_fails_and_its_draft_comes_back(cx: &mut TestAppContext) {
    let server = spawn_fake_server();
    let (window, app) = open_app(cx, &server);

    server.go_down();
    pump_until(
        cx,
        &app,
        "the app notices the server is gone",
        |app, _, _| matches!(app.status, Some(ConnectionStatus::Reconnecting { .. })),
        &server,
    );
    send(
        cx,
        window,
        &app,
        "never reaches the server",
        vec![notes_attachment()],
    );
    settle(cx);
    assert_eq!(cx.read(|cx| pending_rows(app.read(cx), cx)).len(), 1);

    cx.executor().advance_clock(SEND_TIMEOUT);
    settle(cx);
    cx.read(|cx| {
        let app = app.read(cx);
        assert!(pending_rows(app, cx).is_empty(), "the row goes");
        let shown = error(app, cx).unwrap_or_default();
        assert!(
            shown.contains("No answer"),
            "the send fails visibly: {shown:?}"
        );
        assert_eq!(draft_text(app, cx), "never reaches the server");
        assert_eq!(
            draft_attachments(app, cx),
            vec![("notes.txt".to_owned(), "ready:att-notes".to_owned())],
            "the attachment comes back too"
        );
    });

    // The app gave up on it, so the reconnect does not send it after all.
    server.up();
    pump_until(
        cx,
        &app,
        "the app reconnects",
        |app, _, _| matches!(app.status, Some(ConnectionStatus::Connected)),
        &server,
    );
    settle(cx);
    assert!(
        server.ledger().dispatches.is_empty(),
        "the dropped send never went: {:#?}",
        server.ledger()
    );
}

#[gpui_kit::test]
fn an_unchanged_resend_reuses_the_command_id_and_posts_once(cx: &mut TestAppContext) {
    let server = spawn_fake_server();
    let (window, app) = open_app(cx, &server);

    send_that_lands_without_an_answer(
        cx,
        window,
        &app,
        &server,
        "landed but unconfirmed",
        vec![notes_attachment()],
    );
    cx.read(|cx| {
        let app = app.read(cx);
        assert!(error(app, cx).is_some(), "the send failed visibly");
        assert_eq!(
            draft_attachments(app, cx),
            vec![("notes.txt".to_owned(), "ready:att-notes".to_owned())]
        );
    });
    let first_id = server.ledger().dispatches[0].command_id.clone();
    let tries = server.ledger().dispatches.len();

    // The user sends the returned draft again as it is.
    send(
        cx,
        window,
        &app,
        "landed but unconfirmed",
        vec![notes_attachment()],
    );
    pump_until(
        cx,
        &app,
        "the resend is answered",
        |app, server, _| {
            app.sends.in_flight_for_test() == 0 && server.ledger().dispatches.len() > tries
        },
        &server,
    );
    let ledger = server.ledger();
    assert_eq!(
        ledger.dispatches.last().map(|d| d.command_id.as_str()),
        Some(first_id.as_str()),
        "the resend reuses the first commandId"
    );
    assert_eq!(
        ledger.posted,
        vec!["landed but unconfirmed".to_owned()],
        "the server posted the message once"
    );
    drop(ledger);
    assert_eq!(
        cx.read(|cx| error(app.read(cx), cx)),
        None,
        "the resend succeeds"
    );
}

#[gpui_kit::test]
fn an_edited_resend_is_a_new_message(cx: &mut TestAppContext) {
    let server = spawn_fake_server();
    let (window, app) = open_app(cx, &server);

    send_that_lands_without_an_answer(cx, window, &app, &server, "first wording", Vec::new());
    let first_id = server.ledger().dispatches[0].command_id.clone();

    send(cx, window, &app, "second wording", Vec::new());
    pump_until(
        cx,
        &app,
        "the edited message is answered",
        |app, server, _| {
            app.sends.in_flight_for_test() == 0
                && server
                    .ledger()
                    .dispatches
                    .last()
                    .is_some_and(|d| d.text == "second wording")
        },
        &server,
    );
    let ledger = server.ledger();
    assert_ne!(
        ledger.dispatches.last().map(|d| d.command_id.as_str()),
        Some(first_id.as_str()),
        "an edited draft gets a new commandId"
    );
    assert_eq!(
        ledger.posted,
        vec!["first wording".to_owned(), "second wording".to_owned()]
    );
}

#[gpui_kit::test]
fn a_slow_send_shows_sending_and_a_timed_out_one_resends_with_its_id(cx: &mut TestAppContext) {
    let server = spawn_fake_server();
    let (window, app) = open_app(cx, &server);

    server.mode.store(NEVER_ANSWER, Ordering::Release);
    send(cx, window, &app, "the server is slow", Vec::new());
    pump_until(
        cx,
        &app,
        "the server gets the message",
        |_, server, _| !server.ledger().dispatches.is_empty(),
        &server,
    );
    assert!(
        cx.read(|cx| pending_rows(app.read(cx), cx)).is_empty(),
        "a send on a live connection shows no row at first"
    );
    cx.executor().advance_clock(SLOW_SEND_AFTER);
    settle(cx);
    let rows = cx.read(|cx| pending_rows(app.read(cx), cx));
    assert_eq!(rows.len(), 1, "a slow send shows: {rows:#?}");
    assert!(!rows[0].waiting);
    assert_eq!(rows[0].status(), "Sending…");

    cx.executor().advance_clock(SEND_TIMEOUT);
    settle(cx);
    cx.read(|cx| {
        let app = app.read(cx);
        assert!(pending_rows(app, cx).is_empty());
        assert_eq!(draft_text(app, cx), "the server is slow");
    });

    server.mode.store(ANSWER, Ordering::Release);
    send(cx, window, &app, "the server is slow", Vec::new());
    pump_until(
        cx,
        &app,
        "the resend is answered",
        |app, server, _| {
            app.sends.in_flight_for_test() == 0 && server.ledger().dispatches.len() == 2
        },
        &server,
    );
    let ledger = server.ledger();
    assert_eq!(
        ledger.dispatches[0].command_id, ledger.dispatches[1].command_id,
        "the resend after a timeout reuses the commandId"
    );
    assert_eq!(ledger.posted, vec!["the server is slow".to_owned()]);
}

#[gpui_kit::test]
fn a_send_that_comes_back_keeps_what_the_user_typed_meanwhile(cx: &mut TestAppContext) {
    let server = spawn_fake_server();
    let (window, app) = open_app(cx, &server);

    server.go_down();
    pump_until(
        cx,
        &app,
        "the app notices the server is gone",
        |app, _, _| matches!(app.status, Some(ConnectionStatus::Reconnecting { .. })),
        &server,
    );
    send(cx, window, &app, "first message", Vec::new());
    send(cx, window, &app, "second message", Vec::new());
    settle(cx);
    // The user keeps typing while both wait.
    cx.update_window(window, |_, window, cx| {
        let chat = app.read(cx).chat.clone();
        chat.update(cx, |chat, cx| {
            chat.set_draft_text("typed while waiting".to_owned(), window, cx);
        });
    })
    .expect("the window");

    cx.executor().advance_clock(SEND_TIMEOUT);
    settle(cx);
    let draft = cx.read(|cx| draft_text(app.read(cx), cx));
    for text in ["first message", "second message", "typed while waiting"] {
        assert!(draft.contains(text), "{text:?} is kept: {draft:?}");
    }
    assert!(
        draft.ends_with("typed while waiting"),
        "the returned messages go before what was typed: {draft:?}"
    );
}
