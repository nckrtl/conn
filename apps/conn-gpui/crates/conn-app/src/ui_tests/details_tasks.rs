use super::*;

pub(crate) const THREAD: &str = "thread-selected";
pub(crate) const LINK: &str = "#482 · Older task";

pub(crate) fn receipt() -> serde_json::Value {
    json!({
        "position":0, "visibility":"local", "sourceThreadId":THREAD, "sourceItemId":"receipt",
        "item":{"id":"receipt", "type":"dynamic_tool","threadId":THREAD, "ordinal":0,
            "status":"completed","updatedAt":"2026-11-22T15:00:00Z",
            "toolName":"orbit.task-create","input":{}, "output":{"orbitTask":{
                "id":482,"title":"Older task","project":{"slug":"conn"},"subtask_counts":{}}}}
    })
}

pub(crate) fn snapshot(cursor: Option<&str>, include_task: bool) -> serde_json::Value {
    let mut snapshot: serde_json::Value =
        serde_json::from_str(&conn_state::testkit::synthetic_thread_snapshot_json(
            conn_state::testkit::SyntheticThread::sized(1),
        ))
        .expect("thread fixture");
    snapshot["projection"]["thread"]["id"] = json!(THREAD);
    if include_task {
        snapshot["projection"]["visibleTurnItems"]
            .as_array_mut()
            .expect("visible items")
            .insert(0, receipt());
    }
    snapshot["historyCursor"] = json!(cursor);
    snapshot["hasMoreHistory"] = json!(cursor.is_some());
    snapshot
}

#[gpui_kit::test]
async fn reopened_thread_opens_older_task_from_details(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let older = receipt();
    let addr = RT.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind history fixture");
        let addr = listener.local_addr().expect("fixture address");
        tokio::spawn(async move {
            loop {
                let (mut tcp, _) = listener.accept().await.expect("fixture request");
                let mut buf = [0; 4096];
                let n = tcp.peek(&mut buf).await.expect("request headers");
                let path = String::from_utf8_lossy(&buf[..n]);
                if path.starts_with("GET /ws") {
                    tokio::spawn(async move {
                        if let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await {
                            while ws.next().await.is_some() {}
                        }
                    });
                    continue;
                }
                let (items, next) = if path.starts_with("GET /api/orchestration/threads/thread-selected/history?cursor=recent ") {
                    (json!([]), Some("oldest"))
                } else if path.starts_with("GET /api/orchestration/threads/thread-selected/history?cursor=oldest ") {
                    (json!([older]), None)
                } else {
                    continue;
                };
                let body = json!({"snapshotSequence":42, "items":items, "nextCursor":next, "hasMoreHistory":next.is_some()}).to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                tcp.write_all(response.as_bytes()).await.expect("history response");
                if next.is_none() { break; }
            }
        });
        addr
    });
    let (window, app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: ServerConfig {
                http_base_url: url::Url::parse(&format!("http://{addr}")).expect("fixture URL"),
                credential: Credential::Bearer("test-token".into()),
            },
            label: None,
            orbit_server_id: None,
        }),
    );
    let snapshot = snapshot(Some("recent"), false);
    let event = |value| ClientEvent::Thread {
        thread_id: THREAD.to_owned(),
        item: from_json(value).expect("thread snapshot"),
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.select_thread(THREAD, cx);
            app.apply_event_for_test(event(snapshot.clone()), cx);
            app.select_thread("thread-failed", cx);
            app.select_thread(THREAD, cx);
            app.apply_event_for_test(event(snapshot), cx);
        })
    });
    let recent = cx.read(|cx| {
        app.read(cx)
            .selected_timeline()
            .expect("thread")
            .entries
            .clone()
    });
    assert!(
        !recent
            .iter()
            .any(|e| matches!(e, TimelineEntry::OrbitTask { .. }))
    );
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    cx.condition(&app, |app, _| {
        app.selected_timeline()
            .is_some_and(|state| state.task_links.links.contains_key(&482))
    })
    .await;
    click_row(cx, window, LINK, MouseButton::Left);
    cx.read(|cx| {
        let app = app.read(cx);
        assert_eq!(app.selected_timeline().expect("thread").entries, recent);
        assert!(app.layout().right_panel_open);
        assert_eq!(
            app.layout().right_panel_tab,
            conn_state::RightPanelTab::Tasks
        );
        assert_eq!(
            app.right_panel_for_test()
                .read(cx)
                .selected_task_for_test(cx),
            Some(482)
        );
    });
}
