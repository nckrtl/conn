//! A server that drops the socket mid-request and comes back after a restart: the client
//! reconnects by itself, resends the send that was in flight, sends the one queued while the
//! server was away, and resumes the open thread from its cursor.

use std::time::Duration;

use conn_client::{
    ClientError, ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig,
};
use conn_contract::OrchestrationV2ThreadStreamItem as Item;
use conn_wire::{Exit, FromClient, FromServer, Request, encode_server_frame};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

const DISPATCH: &str = "orchestration.dispatchCommand";
const SUBSCRIBE_THREAD: &str = "orchestration.subscribeThread";

/// What the fake server saw, in order.
#[derive(Debug)]
enum Seen {
    Request {
        session: u8,
        tag: String,
        payload: Value,
    },
}

async fn send(ws: &mut WebSocketStream<TcpStream>, frame: &FromServer) -> bool {
    ws.send(Message::Text(encode_server_frame(frame).into()))
        .await
        .is_ok()
}

fn thread_event(request: &Request, sequence: i64) -> FromServer {
    FromServer::Chunk {
        request_id: request.id.clone(),
        values: vec![
            json!({
                "kind": "event",
                "sequence": sequence,
                "event": { "type": "custom.noop", "payload": null }
            }),
            json!({ "kind": "synchronized" }),
        ],
    }
}

fn dispatch_reply(request: &Request) -> FromServer {
    FromServer::Exit {
        request_id: request.id.clone(),
        exit: Exit::success(json!({
            "sequence": 7,
            "commandId": request.payload["commandId"].clone(),
        })),
    }
}

/// Session 1 serves the thread at sequence 5 and drops the socket when the first send arrives,
/// before it answers. Then, like a TCP forward to a server that is restarting, it accepts and
/// drops a few sockets. Session 2 answers every send and replays the thread from its cursor.
async fn fake_server(listener: TcpListener, seen: mpsc::UnboundedSender<Seen>) {
    // Session 1.
    let Ok((tcp, _)) = listener.accept().await else {
        return;
    };
    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
        return;
    };
    'session1: while let Some(Ok(Message::Text(text))) = ws.next().await {
        let Ok(frames) = conn_wire::decode_client_message(&text) else {
            continue;
        };
        for frame in frames {
            let FromClient::Request(req) = frame else {
                continue;
            };
            let _ = seen.send(Seen::Request {
                session: 1,
                tag: req.tag.clone(),
                payload: req.payload.clone(),
            });
            match req.tag.as_str() {
                SUBSCRIBE_THREAD => {
                    if !send(&mut ws, &thread_event(&req, 5)).await {
                        return;
                    }
                }
                // The server goes down with this send in flight.
                DISPATCH => break 'session1,
                _ => {}
            }
        }
    }
    drop(ws);

    // Down: the forward accepts and drops sockets until the server is back.
    for _ in 0..3 {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        drop(tcp);
    }

    // Session 2.
    let Ok((tcp, _)) = listener.accept().await else {
        return;
    };
    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
        return;
    };
    while let Some(Ok(Message::Text(text))) = ws.next().await {
        let Ok(frames) = conn_wire::decode_client_message(&text) else {
            continue;
        };
        for frame in frames {
            let reply = match frame {
                FromClient::Ping => Some(FromServer::Pong),
                FromClient::Request(req) => {
                    let _ = seen.send(Seen::Request {
                        session: 2,
                        tag: req.tag.clone(),
                        payload: req.payload.clone(),
                    });
                    match req.tag.as_str() {
                        SUBSCRIBE_THREAD => Some(thread_event(&req, 6)),
                        DISPATCH => Some(dispatch_reply(&req)),
                        _ => None,
                    }
                }
                _ => None,
            };
            if let Some(reply) = reply
                && !send(&mut ws, &reply).await
            {
                return;
            }
        }
    }
}

async fn wait_for_status(
    events: &mut mpsc::Receiver<ClientEvent>,
    want: impl Fn(&ConnectionStatus) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(1), events.recv()).await {
            Ok(Some(ClientEvent::Status(status))) if want(&status) => return true,
            Ok(None) => return false,
            _ => {}
        }
    }
    false
}

/// Waits for the thread event at `sequence` on `thread_id`.
async fn wait_for_thread_sequence(
    events: &mut mpsc::Receiver<ClientEvent>,
    thread_id: &str,
    sequence: i64,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(1), events.recv()).await {
            Ok(Some(ClientEvent::Thread {
                thread_id: id,
                item: Item::Event(event),
            })) if id == thread_id && event.sequence == sequence => return true,
            Ok(Some(ClientEvent::Thread {
                thread_id: id,
                item: Item::Event2(event),
            })) if id == thread_id && event.sequence == sequence => return true,
            Ok(None) => return false,
            _ => {}
        }
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test uses assert! for diffs while propagating setup errors with ?"
)]
async fn recovers_sends_and_thread_after_server_restart() -> Result<(), Box<dyn std::error::Error>>
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (seen_tx, mut seen_rx) = mpsc::unbounded_channel();
    let server = tokio::spawn(fake_server(listener, seen_tx));

    let config = ServerConfig {
        http_base_url: url::Url::parse(&format!("http://{addr}"))?,
        credential: Credential::Bearer("test-bearer".to_owned()),
    };
    let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());
    assert!(
        wait_for_status(&mut events, |s| matches!(s, ConnectionStatus::Connected)).await,
        "the client connects"
    );

    // The open thread loads.
    conn.subscribe_thread("thread-1");
    assert!(
        wait_for_thread_sequence(&mut events, "thread-1", 5).await,
        "the thread loads before the restart"
    );

    // A send goes out; the server drops the socket before it answers.
    let first = {
        let conn = conn.clone();
        tokio::spawn(async move {
            conn.call_json(
                DISPATCH,
                json!({ "type": "message.dispatch", "commandId": "cmd-in-flight" }),
            )
            .await
        })
    };
    assert!(
        wait_for_status(&mut events, |s| matches!(
            s,
            ConnectionStatus::Reconnecting { .. }
        ))
        .await,
        "the client notices the server is gone"
    );

    // A send while the server is away waits for it.
    let queued = {
        let conn = conn.clone();
        tokio::spawn(async move {
            conn.call_json(
                DISPATCH,
                json!({ "type": "message.dispatch", "commandId": "cmd-queued" }),
            )
            .await
        })
    };

    assert!(
        wait_for_status(&mut events, |s| matches!(s, ConnectionStatus::Connected)).await,
        "the client reconnects by itself once the server is back"
    );

    let first = tokio::time::timeout(Duration::from_secs(20), first).await??;
    assert_eq!(
        first?["commandId"],
        json!("cmd-in-flight"),
        "the send in flight when the server went down is resent and succeeds"
    );
    let queued = tokio::time::timeout(Duration::from_secs(20), queued).await??;
    assert_eq!(
        queued?["commandId"],
        json!("cmd-queued"),
        "the send made while the server was away succeeds"
    );

    // The open thread resumes from its cursor and loads what is new.
    assert!(
        wait_for_thread_sequence(&mut events, "thread-1", 6).await,
        "the thread loads again after the restart"
    );

    // A send after the restart works like any other.
    let after = conn
        .call_json(
            DISPATCH,
            json!({ "type": "message.dispatch", "commandId": "cmd-after" }),
        )
        .await?;
    assert_eq!(after["commandId"], json!("cmd-after"), "a later send works");

    let mut session2 = Vec::new();
    while let Ok(Seen::Request {
        session,
        tag,
        payload,
    }) = seen_rx.try_recv()
    {
        if session == 2 {
            session2.push((tag, payload));
        }
    }
    let resubscribe = session2
        .iter()
        .find(|(tag, payload)| tag == SUBSCRIBE_THREAD && payload["threadId"] == "thread-1")
        .ok_or("thread-1 is resubscribed on the new session")?;
    assert_eq!(
        resubscribe.1["afterSequence"],
        json!(5),
        "the resubscribe asks only for what changed since the cursor"
    );
    let first_dispatch = session2
        .iter()
        .position(|(tag, _)| tag == DISPATCH)
        .ok_or("the sends reach the new session")?;
    let first_subscribe = session2
        .iter()
        .position(|(tag, _)| tag == SUBSCRIBE_THREAD)
        .ok_or("the thread reaches the new session")?;
    assert!(
        first_dispatch < first_subscribe,
        "waiting sends go out before the resubscribes"
    );
    let resent = session2
        .iter()
        .filter(|(tag, payload)| tag == DISPATCH && payload["commandId"] == "cmd-in-flight")
        .count();
    assert_eq!(
        resent, 1,
        "the send in flight is resent once, with its commandId"
    );

    conn.close();
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
    Ok(())
}

/// A call that is not known to be safe to repeat still fails when its session drops: the server
/// may have done its work already.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test uses assert! for diffs while propagating setup errors with ?"
)]
async fn fails_a_call_that_is_unsafe_to_repeat_when_the_session_drops()
-> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let server = tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
            return;
        };
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(frames) = conn_wire::decode_client_message(&text) else {
                continue;
            };
            if frames
                .iter()
                .any(|f| matches!(f, FromClient::Request(r) if r.tag == "test.mutate"))
            {
                return;
            }
        }
    });

    let config = ServerConfig {
        http_base_url: url::Url::parse(&format!("http://{addr}"))?,
        credential: Credential::Bearer("test-bearer".to_owned()),
    };
    let (conn, mut events) = Connection::start(config, &tokio::runtime::Handle::current());
    assert!(
        wait_for_status(&mut events, |s| matches!(s, ConnectionStatus::Connected)).await,
        "the client connects"
    );
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        conn.call_json("test.mutate", json!({})),
    )
    .await?;
    assert!(
        matches!(result, Err(ClientError::Connection(_))),
        "an unsafe call fails with the connection error, got {result:?}"
    );
    conn.close();
    let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
    Ok(())
}
