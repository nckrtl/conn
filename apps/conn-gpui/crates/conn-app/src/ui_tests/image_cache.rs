//! Sent pictures download once: a thread opened again paints them from memory in its first
//! frame, a restart decodes them from disk, and another environment never gets them.

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
struct FakeServer {
    url: url::Url,
    downloads: Arc<Mutex<HashMap<String, usize>>>,
}

impl FakeServer {
    fn spawn(png: Arc<[u8]>) -> Self {
        let downloads = Arc::new(Mutex::new(HashMap::new()));
        let counts = downloads.clone();
        let addr = crate::live::RT.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("a loopback listener");
            let addr = listener.local_addr().expect("a listener address");
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    let (png, counts) = (png.clone(), counts.clone());
                    tokio::spawn(serve(tcp, png, counts));
                }
            });
            addr
        });
        Self {
            url: url::Url::parse(&format!("http://{addr}")).expect("a loopback URL"),
            downloads,
        }
    }

    fn total_downloads(&self) -> usize {
        self.downloads
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

async fn serve(
    tcp: tokio::net::TcpStream,
    png: Arc<[u8]>,
    counts: Arc<Mutex<HashMap<String, usize>>>,
) {
    let mut head = [0_u8; 2048];
    let Ok(len) = tcp.peek(&mut head).await else {
        return;
    };
    let text = String::from_utf8_lossy(&head[..len]).to_ascii_lowercase();
    if text.contains("upgrade: websocket") {
        serve_ws(tcp).await;
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
    let line = String::from_utf8_lossy(&request);
    let path = line.split_whitespace().nth(1).unwrap_or_default();
    let id = path.trim_start_matches("/attachments/").to_owned();
    *counts.lock().expect("counts").entry(id).or_default() += 1;
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        png.len()
    );
    let _ = tcp.write_all(header.as_bytes()).await;
    let _ = tcp.write_all(&png).await;
    let _ = tcp.shutdown().await;
}

async fn serve_ws(tcp: tokio::net::TcpStream) {
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
