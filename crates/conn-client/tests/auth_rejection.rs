//! A server that refuses the WebSocket handshake with 401: the default keeps retrying, and
//! `stop_on_auth_rejection` ends the connection with `Failed`.
#![expect(
    clippy::expect_used,
    reason = "test setup panics when the local socket can't be set up"
)]

use std::time::Duration;

use conn_client::{
    ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig, StartOptions,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

async fn refusing_server() -> url::Url {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let mut buf = [0u8; 4096];
            let _ = tcp.read(&mut buf).await;
            let _ = tcp
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
        }
    });
    url::Url::parse(&format!("http://{addr}")).expect("url")
}

async fn next_status(events: &mut mpsc::Receiver<ClientEvent>) -> ConnectionStatus {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("a status arrives")
            .expect("events stay open");
        if let ClientEvent::Status(status) = event
            && status != ConnectionStatus::Connecting
        {
            return status;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_401_stops_only_when_asked() {
    let rt = tokio::runtime::Handle::current();
    let config = |url: url::Url| ServerConfig {
        http_base_url: url,
        credential: Credential::Bearer("revoked".to_owned()),
    };

    let (default, mut events) = Connection::start(config(refusing_server().await), &rt);
    assert!(
        matches!(
            next_status(&mut events).await,
            ConnectionStatus::Reconnecting { .. }
        ),
        "by default a 401 is retried"
    );
    assert!(default.auth_rejected(), "the rejection is still recorded");
    default.close();

    let (stopping, mut events) = Connection::start_with_options(
        config(refusing_server().await),
        &rt,
        StartOptions {
            stop_on_auth_rejection: true,
        },
    );
    assert!(
        matches!(next_status(&mut events).await, ConnectionStatus::Failed(_)),
        "with the option a 401 ends the connection"
    );
    assert!(stopping.auth_rejected(), "the rejection is recorded");
}
