//! Sent pictures download once: a thread opened again paints them from memory in its first
//! frame, a restart decodes them from disk, and another environment never gets them. A picture
//! the user sends never downloads at all: the bytes that went up fill both caches.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use conn_client::{Credential, ServerConfig};
use conn_state::{ThreadState, TimelineEntry};
use futures::{SinkExt as _, StreamExt as _};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AnyWindowHandle, AppContext as _, Entity, TestAppContext};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{kitchen_sink_shell, kitchen_sink_thread, linked_mini_shell, mount_app_with_server};
use crate::app::ConnApp;
use crate::chat::image_store::ImageStore;

const IMAGES: usize = 3;

/// A thread whose first message carries [`IMAGES`] PNG attachments `image-0`, `image-1`, ….
fn image_thread() -> ThreadState {
    let mut thread = kitchen_sink_thread();
    thread.entries.truncate(1);
    let TimelineEntry::User { attachments, .. } = &mut thread.entries[0] else {
        panic!("expected the first user message");
    };
    attachments.clear();
    for index in 0..IMAGES {
        attachments.push(conn_contract::ChatAttachment::Image(
            conn_contract::ChatImageAttachment {
                r#type: conn_contract::lit::Image,
                id: format!("image-{index}"),
                name: format!("image-{index}.png"),
                mime_type: "image/png".into(),
                size_bytes: 100,
                source: None,
            },
        ));
    }
    thread
}

/// A screenshot-sized PNG (2880×1800, a busy pattern), like the pictures a thread collects.
fn screenshot_png() -> Vec<u8> {
    let picture = image::RgbaImage::from_fn(2880, 1800, |x, y| {
        let v = (x.wrapping_mul(31) ^ y.wrapping_mul(17)) as u8;
        image::Rgba([v, v.wrapping_add(x as u8), (y as u8) ^ v, 255])
    });
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(picture)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("the picture encodes as PNG");
    bytes
}

/// A loopback `conn-server`: `assets.createUrl` answers `/attachments/<id>`, and an HTTP `GET`
/// of that path returns `png`. It counts the downloads of each attachment.
///
/// It also takes uploads (`attachments.createUploadUrl`, then a `POST` of the bytes, kept as
/// they came, as conn-server does) and records `orchestration.dispatchCommand` payloads.
struct FakeServer {
    url: url::Url,
    state: Served,
}

/// What a [`FakeServer`] saw, shared with its connections.
#[derive(Clone, Default)]
struct Served {
    downloads: Arc<Mutex<HashMap<String, usize>>>,
    /// Upload bodies, in arrival order.
    uploads: Arc<Mutex<Vec<Vec<u8>>>>,
    dispatches: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl FakeServer {
    fn spawn(png: Arc<[u8]>) -> Self {
        let state = Served::default();
        let shared = state.clone();
        let addr = crate::live::RT.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("a loopback listener");
            let addr = listener.local_addr().expect("a listener address");
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    tokio::spawn(serve(tcp, png.clone(), shared.clone()));
                }
            });
            addr
        });
        Self {
            url: url::Url::parse(&format!("http://{addr}")).expect("a loopback URL"),
            state,
        }
    }

    fn total_downloads(&self) -> usize {
        self.state
            .downloads
            .lock()
            .expect("counts")
            .values()
            .sum::<usize>()
    }

    fn config(&self, token: &str) -> ServerConfig {
        ServerConfig {
            http_base_url: self.url.clone(),
            credential: Credential::Bearer(token.to_owned()),
        }
    }
}

async fn serve(tcp: tokio::net::TcpStream, png: Arc<[u8]>, state: Served) {
    let mut head = [0_u8; 2048];
    let Ok(len) = tcp.peek(&mut head).await else {
        return;
    };
    let text = String::from_utf8_lossy(&head[..len]).to_ascii_lowercase();
    if text.contains("upgrade: websocket") {
        serve_ws(tcp, state).await;
        return;
    }
    let mut tcp = tcp;
    let mut request = Vec::new();
    let mut buf = [0_u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        match tcp.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => request.extend_from_slice(&buf[..n]),
        }
    }
    let line = String::from_utf8_lossy(&request).into_owned();
    let path = line.split_whitespace().nth(1).unwrap_or_default();
    if path.starts_with("/api/attachments/upload/") {
        receive_upload(tcp, &line, request, &state).await;
        return;
    }
    let id = path.trim_start_matches("/attachments/").to_owned();
    *state
        .downloads
        .lock()
        .expect("counts")
        .entry(id)
        .or_default() += 1;
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        png.len()
    );
    let _ = tcp.write_all(header.as_bytes()).await;
    let _ = tcp.write_all(&png).await;
    let _ = tcp.shutdown().await;
}

/// Reads a `POST` body to its `Content-Length`, keeps it, and answers `200`.
async fn receive_upload(
    mut tcp: tokio::net::TcpStream,
    head: &str,
    mut request: Vec<u8>,
    state: &Served,
) {
    let length: usize = head
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
        .unwrap_or_default();
    let start = request
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(request.len(), |at| at + 4);
    let mut body = request.split_off(start);
    let mut buf = vec![0_u8; 64 * 1024];
    while body.len() < length {
        match tcp.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => body.extend_from_slice(&buf[..n]),
        }
    }
    state.uploads.lock().expect("uploads").push(body);
    let _ = tcp
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await;
    let _ = tcp.shutdown().await;
}

async fn serve_ws(tcp: tokio::net::TcpStream, state: Served) {
    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
        return;
    };
    while let Some(Ok(Message::Text(text))) = ws.next().await {
        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
            let conn_wire::FromClient::Request(req) = frame else {
                continue;
            };
            let exit = if req.tag == "assets.createUrl" {
                let id = req.payload["resource"]["attachmentId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                conn_wire::Exit::success(serde_json::json!({
                    "relativeUrl": format!("/attachments/{id}"),
                    "expiresAt": 4_102_444_800_000_u64,
                }))
            } else if req.tag == "attachments.createUploadUrl" {
                let n = state.uploads.lock().expect("uploads").len();
                conn_wire::Exit::success(serde_json::json!({
                    "attachmentId": format!("pending-{n}.png"),
                    "relativeUrl": format!("/api/attachments/upload/{n}"),
                    "expiresAt": 4_102_444_800_000_u64,
                }))
            } else if req.tag == "orchestration.dispatchCommand" {
                state
                    .dispatches
                    .lock()
                    .expect("dispatches")
                    .push(req.payload.clone());
                conn_wire::Exit::success(serde_json::json!({ "sequence": 1 }))
            } else {
                conn_wire::Exit::die(conn_wire::error_defect("TestError", "not served"))
            };
            let reply = conn_wire::FromServer::Exit {
                request_id: req.id,
                exit,
            };
            let _ = ws
                .send(Message::Text(conn_wire::encode_server_frame(&reply).into()))
                .await;
        }
    }
}

fn mount(cx: &mut TestAppContext, server: &FakeServer) -> (AnyWindowHandle, Entity<ConnApp>) {
    cx.executor().allow_parking();
    let (window, app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: server.config("primary-token"),
            label: Some("primary".to_owned()),
            orbit_server_id: Some("primary".to_owned()),
        }),
    );
    cx.update(|cx| app.update(cx, |app, cx| app.set_shell(kitchen_sink_shell(), cx)));
    (window, app)
}

fn use_store(cx: &mut TestAppContext, app: &Entity<ConnApp>, store: &ImageStore) {
    let store = store.clone();
    cx.update(|cx| {
        let chat = app.read(cx).chat_for_test();
        chat.update(cx, |chat, _| chat.set_image_store_for_test(store));
    });
}

fn open_thread(cx: &mut TestAppContext, app: &Entity<ConnApp>, id: &str, thread: ThreadState) {
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_for_test(id.to_owned(), thread, cx)
        })
    });
}

/// Renders one frame and returns how many gallery tiles painted a picture in it.
fn frame(cx: &mut TestAppContext, window: AnyWindowHandle, app: &Entity<ConnApp>) -> usize {
    cx.update_window(window, |_, window, cx| {
        window.refresh();
        window.render_frame(cx);
        app.read(cx).chat_for_test().read(cx).ready_tiles_for_test()
    })
    .expect("mounted window")
}

/// Renders and runs the app's tasks until `want` tiles paint, and returns how long that took.
fn until_painted(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    want: usize,
) -> Duration {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        if frame(cx, window, app) == want {
            return start.elapsed();
        }
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!("{want} tiles never painted");
}

/// Waits for the primary connection, so a thumbnail load has a server to ask.
fn until_connected(cx: &mut TestAppContext, app: &Entity<ConnApp>) {
    for _ in 0..500 {
        cx.run_until_parked();
        if cx.read(|cx| app.read(cx).connected_for_test()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the primary never connected");
}

/// Lets the disk writes that follow downloads finish.
fn settle(cx: &mut TestAppContext) {
    for _ in 0..20 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[gpui_kit::test]
fn a_reopened_thread_paints_its_pictures_in_the_first_frame_without_a_download(
    cx: &mut TestAppContext,
) {
    let server = FakeServer::spawn(Arc::from(screenshot_png()));
    let (window, app) = mount(cx, &server);
    let dir = tempfile::tempdir().expect("temp dir");
    let store = ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024);
    use_store(cx, &app, &store);
    until_connected(cx, &app);

    open_thread(cx, &app, "thread-selected", image_thread());
    let cold = until_painted(cx, window, &app, IMAGES);
    assert_eq!(
        server.total_downloads(),
        IMAGES,
        "each picture downloads once"
    );
    settle(cx);

    open_thread(cx, &app, "thread-other", kitchen_sink_thread());
    for _ in 0..3 {
        frame(cx, window, &app);
    }
    let start = Instant::now();
    open_thread(cx, &app, "thread-selected", image_thread());
    assert_eq!(
        frame(cx, window, &app),
        IMAGES,
        "the first frame after reopening paints every picture"
    );
    let warm = start.elapsed();
    settle(cx);
    assert_eq!(
        server.total_downloads(),
        IMAGES,
        "reopening downloads nothing"
    );
    eprintln!(
        "image-cache timing: cold open {} ms, reopen (memory) {} ms",
        cold.as_millis(),
        warm.as_millis()
    );
}

#[gpui_kit::test]
fn after_a_restart_pictures_decode_from_disk_without_a_download(cx: &mut TestAppContext) {
    let server = FakeServer::spawn(Arc::from(screenshot_png()));
    let (window, app) = mount(cx, &server);
    let dir = tempfile::tempdir().expect("temp dir");
    use_store(
        cx,
        &app,
        &ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024),
    );
    until_connected(cx, &app);
    open_thread(cx, &app, "thread-selected", image_thread());
    until_painted(cx, window, &app, IMAGES);
    settle(cx);
    assert_eq!(server.total_downloads(), IMAGES);

    // A restart: memory is empty and the store opens again from what is on disk.
    open_thread(cx, &app, "thread-other", kitchen_sink_thread());
    cx.update(|cx| {
        let chat = app.read(cx).chat_for_test();
        chat.update(cx, |chat, cx| chat.drop_thumbs_for_test(cx));
    });
    use_store(
        cx,
        &app,
        &ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024),
    );
    open_thread(cx, &app, "thread-selected", image_thread());
    let from_disk = until_painted(cx, window, &app, IMAGES);
    settle(cx);
    assert_eq!(
        server.total_downloads(),
        IMAGES,
        "pictures on disk never download again"
    );
    eprintln!(
        "image-cache timing: reopen after restart (disk) {} ms",
        from_disk.as_millis()
    );
}

#[gpui_kit::test]
fn another_environment_downloads_its_own_pictures(cx: &mut TestAppContext) {
    let primary = FakeServer::spawn(Arc::from(screenshot_png()));
    let mini = FakeServer::spawn(Arc::from(screenshot_png()));
    let (window, app) = mount(cx, &primary);
    let dir = tempfile::tempdir().expect("temp dir");
    use_store(
        cx,
        &app,
        &ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024),
    );
    until_connected(cx, &app);
    open_thread(cx, &app, "thread-selected", image_thread());
    until_painted(cx, window, &app, IMAGES);
    settle(cx);
    assert_eq!(primary.total_downloads(), IMAGES);

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.connect_linked_for_test("mini", mini.config("mini-token"), cx);
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/tmp/mini", "Mini"),
                cx,
            );
        })
    });
    for _ in 0..500 {
        cx.run_until_parked();
        if cx.read(|cx| app.read(cx).linked_connected_for_test("mini")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // The same attachment ids on another server: its pictures are not the primary's.
    open_thread(cx, &app, "thread-mini", image_thread());
    until_painted(cx, window, &app, IMAGES);
    settle(cx);
    assert_eq!(
        mini.total_downloads(),
        IMAGES,
        "the linked server serves its own pictures"
    );
    assert_eq!(
        primary.total_downloads(),
        IMAGES,
        "the primary is not asked again"
    );

    // Back on the primary thread: still in memory, nothing downloads.
    open_thread(cx, &app, "thread-selected", image_thread());
    assert_eq!(frame(cx, window, &app), IMAGES);
    settle(cx);
    assert_eq!(
        primary.total_downloads() + mini.total_downloads(),
        2 * IMAGES
    );
}

/// The thread before the send: one user message with no attachments.
fn plain_thread() -> ThreadState {
    let mut thread = image_thread();
    let TimelineEntry::User { attachments, .. } = &mut thread.entries[0] else {
        panic!("expected the first user message");
    };
    attachments.clear();
    thread
}

/// The thread as the server echoes the send: message `sent.message_id` (its turn item is
/// `turn-item:<messageId>`) with the attachment as dispatched, under the id the server's claim
/// gave it.
fn echoed_thread(sent: &Sent, attachment_id: &str) -> ThreadState {
    let mut thread = image_thread();
    let TimelineEntry::User {
        id, attachments, ..
    } = &mut thread.entries[0]
    else {
        panic!("expected the first user message");
    };
    *id = format!("turn-item:{}", sent.message_id);
    let mut image = sent.image.clone();
    image.id = attachment_id.to_owned();
    *attachments = vec![conn_contract::ChatAttachment::Image(image)];
    thread
}

/// A message the composer sent: its id and its picture as the dispatch named it.
struct Sent {
    message_id: String,
    image: conn_contract::ChatImageAttachment,
}

/// The first value under `key` anywhere in `value`.
fn find_value<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    match value {
        serde_json::Value::Object(map) => map
            .get(key)
            .or_else(|| map.values().find_map(|v| find_value(v, key))),
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_value(v, key)),
        _ => None,
    }
}

/// The first string under `key` anywhere in `value`.
fn find_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    match value {
        serde_json::Value::Object(map) => map
            .get(key)
            .and_then(serde_json::Value::as_str)
            .or_else(|| map.values().find_map(|v| find_str(v, key))),
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_str(v, key)),
        _ => None,
    }
}

/// Pastes `png` into the composer, waits for its upload, sends it, and returns what the
/// dispatch named.
fn send_picture(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    server: &FakeServer,
    png: Vec<u8>,
) -> Sent {
    let composer = cx.read(|cx| app.read(cx).chat_for_test().read(cx).composer_for_test());
    cx.update_window(window, |_, window, cx| {
        composer.update(cx, |composer, cx| {
            composer.upload_image_for_test("shot.png", "image/png", png, window, cx);
        });
    })
    .expect("mounted window");
    let uploaded = (0..3000).any(|_| {
        cx.run_until_parked();
        let states = cx.read(|cx| composer.read(cx).attachment_states_for_test());
        if states.iter().all(|(_, state)| state.starts_with("ready:")) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
        false
    });
    assert!(uploaded, "the upload never finished");
    cx.update_window(window, |_, window, cx| {
        composer.update(cx, |composer, cx| composer.submit(window, cx));
    })
    .expect("mounted window");
    for _ in 0..1000 {
        cx.run_until_parked();
        if let Some(command) = server.state.dispatches.lock().expect("dispatches").first() {
            let message_id = find_str(command, "messageId")
                .expect("the dispatch names its message")
                .to_owned();
            let attachment = find_value(command, "attachments")
                .and_then(|list| list.get(0))
                .cloned()
                .expect("the dispatch carries the picture");
            let image = serde_json::from_value(attachment).expect("an image attachment");
            return Sent { message_id, image };
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the send never reached the server");
}

/// The server's id for the sent picture: a new one, as `AttachmentStore::claim` gives.
const CLAIMED_ID: &str = "thread-0b5f-2d6e1c0a-3c1e-4c55-9d1a-7f2c3b4a5d6e.png";

#[gpui_kit::test]
fn a_sent_picture_paints_in_the_echos_first_frame_without_a_download(cx: &mut TestAppContext) {
    let server = FakeServer::spawn(Arc::from(screenshot_png()));
    let (window, app) = mount(cx, &server);
    let dir = tempfile::tempdir().expect("temp dir");
    use_store(
        cx,
        &app,
        &ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024),
    );
    until_connected(cx, &app);
    open_thread(cx, &app, "thread-selected", plain_thread());
    frame(cx, window, &app);

    let start = Instant::now();
    let sent = send_picture(cx, window, &app, &server, screenshot_png());
    let chat = cx.read(|cx| app.read(cx).chat_for_test());
    let decoded = (0..3000).any(|_| {
        cx.run_until_parked();
        if cx.read(|cx| chat.read(cx).sent_images_decoded_for_test(&sent.message_id)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
        false
    });
    assert!(decoded, "the sent picture never decoded");
    let ready = start.elapsed();

    // The echo: the same message, its picture under the id the server's claim gave it.
    open_thread(
        cx,
        &app,
        "thread-selected",
        echoed_thread(&sent, CLAIMED_ID),
    );
    assert_eq!(
        frame(cx, window, &app),
        1,
        "the echoed bubble's first frame paints the picture"
    );
    settle(cx);
    assert_eq!(
        server.total_downloads(),
        0,
        "the sent picture never downloads"
    );

    // The bytes on disk are the ones the server stored (the upload scaled the screenshot).
    let environment = cx
        .read(|cx| chat.read(cx).environment_key_for_test())
        .expect("the primary has an environment key");
    let uploaded = server.state.uploads.lock().expect("uploads")[0].clone();
    assert_ne!(uploaded, screenshot_png(), "the upload re-encoded it");
    let reopened = ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024);
    assert_eq!(
        reopened.get(&environment, CLAIMED_ID).as_deref(),
        Some(uploaded.as_slice()),
        "the store keeps what the server serves, under the server's id"
    );

    // The full-image viewer reads the same bytes.
    cx.update_window(window, |_, window, cx| {
        app.update(cx, |app, cx| {
            app.open_image_viewer_for_test(
                vec![crate::chat::image_viewer::ViewerItem::new(
                    CLAIMED_ID,
                    "shot.png",
                    "image/png",
                )],
                0,
                window,
                cx,
            );
        });
        window.render_frame(cx);
    })
    .expect("mounted window");
    let viewer = cx.read(|cx| app.read(cx).image_viewer_for_test().expect("open"));
    let shown = (0..3000).any(|_| {
        cx.run_until_parked();
        if cx.read(|cx| viewer.read(cx).ready_for_test()) == [true] {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
        false
    });
    assert!(shown, "the viewer never showed the picture");
    assert_eq!(server.total_downloads(), 0, "the viewer downloads nothing");
    eprintln!(
        "sent-image timing: send to decoded thumbnail {} ms",
        ready.as_millis()
    );
}

#[gpui_kit::test]
fn a_sent_picture_echoed_at_once_never_downloads_and_survives_a_restart(cx: &mut TestAppContext) {
    let server = FakeServer::spawn(Arc::from(screenshot_png()));
    let (window, app) = mount(cx, &server);
    let dir = tempfile::tempdir().expect("temp dir");
    use_store(
        cx,
        &app,
        &ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024),
    );
    until_connected(cx, &app);
    open_thread(cx, &app, "thread-selected", plain_thread());
    frame(cx, window, &app);

    // The echo lands before the picture decodes: the tile waits for that decode.
    let sent = send_picture(cx, window, &app, &server, screenshot_png());
    open_thread(
        cx,
        &app,
        "thread-selected",
        echoed_thread(&sent, CLAIMED_ID),
    );
    until_painted(cx, window, &app, 1);
    settle(cx);
    assert_eq!(server.total_downloads(), 0);

    // A restart: memory is empty and the store opens again from what is on disk.
    open_thread(cx, &app, "thread-other", kitchen_sink_thread());
    cx.update(|cx| {
        let chat = app.read(cx).chat_for_test();
        chat.update(cx, |chat, cx| chat.drop_thumbs_for_test(cx));
    });
    use_store(
        cx,
        &app,
        &ImageStore::at(dir.path().to_path_buf(), 256 * 1024 * 1024),
    );
    open_thread(
        cx,
        &app,
        "thread-selected",
        echoed_thread(&sent, CLAIMED_ID),
    );
    until_painted(cx, window, &app, 1);
    settle(cx);
    assert_eq!(
        server.total_downloads(),
        0,
        "after a restart the sent picture comes from disk"
    );
}
