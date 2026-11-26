//! The Thread Details card lists the thread's scheduled tasks (`Automations`): for a thread of
//! this environment and for a thread of a linked environment, whose tasks come from, and whose
//! pause/resume and run-now actions go to, that environment's own connection.

use conn_client::{Credential, ServerConfig};
use serde_json::Value;

use super::details_agents::{iso, now_secs};
use super::*;
use crate::header::details_card::{bound_tasks, task_last_run_text, task_schedule_line};

const LOCAL_THREAD: &str = "thread-selected";
const LINKED_THREAD: &str = "thread-mini";

type Requests = std::sync::mpsc::Receiver<(String, Value)>;

/// A scheduled task as the server lists it, bound to `thread`.
fn task(
    id: &str,
    title: &str,
    thread: &str,
    schedule: Value,
    enabled: bool,
    next_in_secs: Option<i64>,
    last: (&str, Option<i64>, Option<&str>),
) -> Value {
    let now = now_secs();
    json!({
        "id": id, "title": title, "prompt": format!("Do {title}"), "enabled": enabled,
        "schedule": schedule, "projectId": "proj-parity", "threadId": thread,
        "threadMode": "continue",
        "workspaceStrategy": {"type": "root"},
        "modelSelection": {"model": "claude-sonnet-4-6"},
        "runtimeMode": "full-access", "interactionMode": "default",
        "createdBy": "user", "creationSource": "web",
        "createdAt": iso(now - 86_400 * 3), "updatedAt": iso(now - 3_600),
        "nextRunAt": next_in_secs.map(|s| iso(now + s)),
        "lastRunAt": last.1.map(|s| iso(now - s)),
        "lastRunStatus": last.0, "lastRunError": last.2, "runCount": 4,
    })
}

/// The two tasks of `thread`, one paused, and one task of another thread.
fn tasks_for(thread: &str) -> Vec<Value> {
    vec![
        task(
            "task-digest",
            "Morning digest",
            thread,
            json!({"type": "fixed_time", "timeOfDay": "09:00"}),
            true,
            Some(3 * 3_600 - 5),
            ("succeeded", Some(2 * 3_600 + 5), None),
        ),
        task(
            "task-cleanup",
            "Weekly cleanup",
            thread,
            json!({"type": "interval", "everyMs": 3_600_000}),
            false,
            None,
            ("failed", Some(26 * 3_600), Some("Provider unavailable")),
        ),
        task(
            "task-other",
            "Another thread's task",
            "thread-elsewhere",
            json!({"type": "interval", "everyMs": 900_000}),
            true,
            Some(600),
            ("never", None, None),
        ),
    ]
}

/// A loopback `conn-server` that lists `tasks` on `scheduledTasks.subscribe`, applies
/// `setEnabled` and `runNow` to them, and reports each request's tag and payload.
fn spawn_schedule_server(tasks: Vec<Value>) -> (url::Url, Requests) {
    let (tx, rx) = std::sync::mpsc::channel();
    let addr = RT.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback listener");
        let addr = listener.local_addr().expect("a listener address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let tx = tx.clone();
                let mut tasks = tasks.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            let conn_wire::FromClient::Request(req) = frame else {
                                continue;
                            };
                            let _ = tx.send((req.tag.clone(), req.payload.clone()));
                            let reply = match req.tag.as_str() {
                                "scheduledTasks.subscribe" => Some(conn_wire::FromServer::Chunk {
                                    request_id: req.id,
                                    values: vec![json!({"tasks": tasks, "timeZone": "UTC"})],
                                }),
                                "scheduledTasks.setEnabled" | "scheduledTasks.runNow" => {
                                    let id = req.payload["id"].clone();
                                    let task = tasks.iter_mut().find(|t| t["id"] == id);
                                    task.map(|task| {
                                        if req.tag == "scheduledTasks.setEnabled" {
                                            task["enabled"] = req.payload["enabled"].clone();
                                        } else {
                                            task["lastRunStatus"] = json!("running");
                                        }
                                        conn_wire::FromServer::Exit {
                                            request_id: req.id.clone(),
                                            exit: conn_wire::Exit::success(json!({"task": task})),
                                        }
                                    })
                                }
                                _ => None,
                            };
                            if let Some(reply) = reply {
                                let _ = ws
                                    .send(Message::Text(
                                        conn_wire::encode_server_frame(&reply).into(),
                                    ))
                                    .await;
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    (
        url::Url::parse(&format!("http://{addr}")).expect("a loopback URL"),
        rx,
    )
}

fn startup(url: url::Url) -> crate::live::StartupServer {
    crate::live::StartupServer {
        config: ServerConfig {
            http_base_url: url,
            credential: Credential::Bearer("test-token".to_owned()),
        },
        label: Some("primary".to_owned()),
        orbit_server_id: Some("primary".to_owned()),
    }
}

fn labels_now(cx: &mut TestAppContext, window: AnyWindowHandle) -> Vec<String> {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window
            .elements()
            .into_iter()
            .filter_map(|e| e.label().map(str::to_owned))
            .collect()
    })
    .expect("a frame")
}

/// Runs the app until a label starting with `prefix` shows, or five seconds pass.
fn wait_for_label(cx: &mut TestAppContext, window: AnyWindowHandle, prefix: &str) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        if labels_now(cx, window).iter().any(|l| l.starts_with(prefix)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Runs the app until `requests` shows a request with `tag`; returns its payload.
fn wait_for_request(cx: &mut TestAppContext, requests: &Requests, tag: &str) -> Option<Value> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        while let Ok((seen, payload)) = requests.try_recv() {
            if seen == tag {
                return Some(payload);
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

/// Whether `requests` holds a request with `tag` now.
fn saw_request(requests: &Requests, tag: &str) -> bool {
    requests.try_iter().any(|(seen, _)| seen == tag)
}

fn open_card(cx: &mut TestAppContext, window: AnyWindowHandle) {
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
}

/// Mounts the app on the local thread, connected to `primary`.
fn mount_local(cx: &mut TestAppContext, primary: url::Url) -> (AnyWindowHandle, Entity<ConnApp>) {
    cx.executor().allow_parking();
    let (window, app) = mount_app_with_server(cx, Some(startup(primary)));
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(LOCAL_THREAD.to_owned(), ThreadState::new(LOCAL_THREAD), cx);
        });
    });
    (window, app)
}

/// Mounts the app on the linked thread of environment `mini`, which answers at `mini`.
fn mount_linked(
    cx: &mut TestAppContext,
    primary: url::Url,
    mini: url::Url,
) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_local(cx, primary);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.connect_linked_for_test(
                "mini",
                ServerConfig {
                    http_base_url: mini,
                    credential: Credential::Bearer("mini-token".to_owned()),
                },
                cx,
            );
            app.add_linked_shell_for_test(
                "mini",
                "mini",
                linked_mini_shell("/tmp/mini", "Mini diagnostics"),
                cx,
            );
            app.set_thread_for_test(
                LINKED_THREAD.to_owned(),
                ThreadState::new(LINKED_THREAD),
                cx,
            );
        });
    });
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test(LINKED_THREAD)),
        Some("mini".to_owned()),
        "the thread belongs to the linked environment"
    );
    (window, app)
}

#[gpui_kit::test]
fn the_card_lists_the_tasks_of_a_local_thread(cx: &mut TestAppContext) {
    let (url, requests) = spawn_schedule_server(tasks_for(LOCAL_THREAD));
    let (window, _app) = mount_local(cx, url);
    open_card(cx, window);
    assert!(
        wait_for_label(cx, window, "Scheduled task Morning digest"),
        "{:?}",
        labels_now(cx, window)
    );
    let all = labels_now(cx, window);
    assert!(all.iter().any(|l| l == "Automations"), "{all:?}");
    // Each row: the title, the schedule, the next run and the last run's status.
    assert!(
        all.contains(
            &"Scheduled task Morning digest, Daily at 09:00 · next in 3h, \
              Last run succeeded 2h ago"
                .to_owned()
        ),
        "{all:?}"
    );
    // A paused task says so, and its failed last run shows with its error.
    assert!(
        all.contains(
            &"Scheduled task Weekly cleanup, Every 60 min · paused, \
              Last run failed 1d ago: Provider unavailable"
                .to_owned()
        ),
        "{all:?}"
    );
    // The enabled switches say what a click does.
    assert!(all.contains(&"Pause Morning digest".to_owned()), "{all:?}");
    assert!(all.contains(&"Resume Weekly cleanup".to_owned()), "{all:?}");
    assert!(
        !all.iter().any(|l| l.contains("Another thread's task")),
        "only the thread's own tasks show: {all:?}"
    );
    assert!(saw_request(&requests, "scheduledTasks.subscribe"));
}

#[gpui_kit::test]
fn a_thread_without_tasks_has_no_automations_section(cx: &mut TestAppContext) {
    // The server lists a task of another thread only.
    let other = tasks_for("thread-elsewhere").split_off(2);
    let (url, _requests) = spawn_schedule_server(other);
    let (window, app) = mount_local(cx, url);
    open_card(cx, window);
    for _ in 0..200 {
        cx.run_until_parked();
        if cx.read(|cx| app.read(cx).details_tasks_for_test()) == 1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        cx.read(|cx| app.read(cx).details_tasks_for_test()),
        1,
        "the task list arrived"
    );
    let all = labels_now(cx, window);
    assert!(all.iter().any(|l| l == "Thread details"), "card is open");
    assert!(
        !all.iter().any(|l| l == "Automations"),
        "no Automations section without tasks: {all:?}"
    );
}

#[gpui_kit::test]
fn a_linked_threads_tasks_come_from_its_own_environment(cx: &mut TestAppContext) {
    let (primary_url, primary) = spawn_schedule_server(tasks_for(LOCAL_THREAD));
    let (mini_url, mini) = spawn_schedule_server(tasks_for(LINKED_THREAD));
    let (window, _app) = mount_linked(cx, primary_url, mini_url);
    open_card(cx, window);
    assert!(
        wait_for_label(cx, window, "Scheduled task Morning digest"),
        "{:?}",
        labels_now(cx, window)
    );
    assert!(
        wait_for_request(cx, &mini, "scheduledTasks.subscribe").is_some(),
        "the linked environment lists its tasks"
    );
    assert!(
        !saw_request(&primary, "scheduledTasks.subscribe"),
        "the primary server is not asked for the linked thread's tasks"
    );
}

#[gpui_kit::test]
fn pause_resume_and_run_now_go_to_the_threads_environment(cx: &mut TestAppContext) {
    let (primary_url, primary) = spawn_schedule_server(tasks_for(LOCAL_THREAD));
    let (mini_url, mini) = spawn_schedule_server(tasks_for(LINKED_THREAD));
    let (window, _app) = mount_linked(cx, primary_url, mini_url);
    open_card(cx, window);
    assert!(wait_for_label(cx, window, "Scheduled task Morning digest"));

    // Pause: the linked server gets `setEnabled`, and the row then offers `Resume`.
    click_row(cx, window, "Pause Morning digest", MouseButton::Left);
    assert_eq!(
        wait_for_request(cx, &mini, "scheduledTasks.setEnabled"),
        Some(json!({"id": "task-digest", "enabled": false}))
    );
    assert!(wait_for_label(cx, window, "Resume Morning digest"));
    assert!(
        labels_now(cx, window)
            .iter()
            .any(|l| l.starts_with("Scheduled task Morning digest, Daily at 09:00 · paused")),
        "the row shows the task paused"
    );

    // Resume: the same environment gets `enabled: true`.
    click_row(cx, window, "Resume Morning digest", MouseButton::Left);
    assert_eq!(
        wait_for_request(cx, &mini, "scheduledTasks.setEnabled"),
        Some(json!({"id": "task-digest", "enabled": true}))
    );
    assert!(wait_for_label(cx, window, "Pause Morning digest"));

    // Run now: the linked server gets `runNow`, and the row shows the task running.
    click_row(cx, window, "Run Morning digest now", MouseButton::Left);
    assert_eq!(
        wait_for_request(cx, &mini, "scheduledTasks.runNow"),
        Some(json!({"id": "task-digest"}))
    );
    assert!(wait_for_label(
        cx,
        window,
        "Scheduled task Morning digest, Daily at 09:00 · next in 3h, Running"
    ));
    assert!(
        !saw_request(&primary, "scheduledTasks.setEnabled")
            && !saw_request(&primary, "scheduledTasks.runNow"),
        "the primary server never receives the linked thread's task actions"
    );
}

#[gpui_kit::test]
fn another_thread_swaps_the_list_for_its_own_environments_tasks(cx: &mut TestAppContext) {
    let mut local_tasks = tasks_for(LOCAL_THREAD);
    local_tasks[0]["title"] = json!("Local digest");
    let (primary_url, _primary) = spawn_schedule_server(local_tasks);
    let (mini_url, _mini) = spawn_schedule_server(tasks_for(LINKED_THREAD));
    let (window, app) = mount_linked(cx, primary_url, mini_url);
    open_card(cx, window);
    assert!(wait_for_label(cx, window, "Scheduled task Morning digest"));
    // Open the local thread while the card is open: its tasks replace the linked ones.
    cx.update(|cx| {
        app.update(cx, |app, cx| app.select_thread(LOCAL_THREAD.to_owned(), cx));
    });
    assert!(wait_for_label(cx, window, "Scheduled task Local digest"));
    let all = labels_now(cx, window);
    assert!(
        !all.iter()
            .any(|l| l.starts_with("Scheduled task Morning digest")),
        "the linked thread's tasks are gone: {all:?}"
    );
    // Closing the card ends the stream.
    open_card(cx, window);
    cx.run_until_parked();
    assert!(!cx.read(|cx| app.read(cx).details_schedules_open_for_test()));
}

#[test]
fn only_a_threads_own_tasks_are_bound_to_it() {
    let tasks: Vec<conn_contract::ScheduledTask> = tasks_for("thread-a")
        .into_iter()
        .chain(tasks_for("thread-b"))
        .map(|t| conn_contract::from_json(t).expect("a scheduled task"))
        .collect();
    let ids = |thread: &str| -> Vec<&str> {
        bound_tasks(&tasks, thread)
            .into_iter()
            .map(|t| t.id.as_str())
            .collect()
    };
    assert_eq!(ids("thread-a"), ["task-digest", "task-cleanup"]);
    assert!(ids("thread-c").is_empty());
}

#[test]
fn rows_say_when_a_task_runs_next_and_how_its_last_run_went() {
    let now = now_secs();
    let at = |next: Option<i64>, enabled: bool| -> conn_contract::ScheduledTask {
        let mut value = task(
            "t",
            "T",
            "thread",
            json!({"type": "interval", "everyMs": 900_000}),
            enabled,
            next,
            ("never", None, None),
        );
        // Times come from `now_secs()`; pin them to the `now` of this check.
        if let Some(next) = next {
            value["nextRunAt"] = json!(iso(now + next));
        }
        conn_contract::from_json(value).expect("a scheduled task")
    };
    for (next, expect) in [
        (30, "Every 15 min · next in under a minute"),
        (600, "Every 15 min · next in 10m"),
        (3 * 3_600, "Every 15 min · next in 3h"),
        (3 * 86_400, "Every 15 min · next in 3d"),
        (-120, "Every 15 min · next 2m ago"),
    ] {
        assert_eq!(task_schedule_line(&at(Some(next), true), now), expect);
    }
    assert_eq!(
        task_schedule_line(&at(Some(600), false), now),
        "Every 15 min · paused"
    );
    assert_eq!(task_schedule_line(&at(None, true), now), "Every 15 min");
    let mut blocked = at(Some(600), true);
    blocked.blocked_by_policy = Some("Blocked by policy".to_owned());
    assert_eq!(
        task_schedule_line(&blocked, now),
        "Every 15 min · Blocked by policy"
    );
    assert_eq!(task_last_run_text(&at(None, true), now), "Never run");
    let mut running = at(None, true);
    running.last_run_status = conn_contract::ScheduledTaskRunStatus::Running;
    assert_eq!(task_last_run_text(&running, now), "Running");
}

/// Renders the details card offscreen with two scheduled tasks, one paused, in Dark Ocean and
/// Light.
///
/// `CONN_DETAILS_SCHEDULES_SHOTS_DIR=<dir> cargo test -p conn-app render_details_schedules_screenshots -- --ignored`
#[cfg(target_os = "macos")]
#[test]
#[ignore = "writes PNGs; set CONN_DETAILS_SCHEDULES_SHOTS_DIR"]
fn render_details_schedules_screenshots() {
    use gpui_kit::test::TestWindowExt as _;
    let Some(dir) = std::env::var_os("CONN_DETAILS_SCHEDULES_SHOTS_DIR") else {
        return;
    };
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let (url, _requests) = spawn_schedule_server(tasks_for(LOCAL_THREAD));
    let mut ctx = headless_shot_context();
    for (theme_id, theme_label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        let tokens = conn_theme::Tokens::derive(&theme);
        let server = startup(url.clone());
        let (window, app) = ctx.update(|cx| {
            gpui_kit::init(cx);
            crate::fonts::register(cx);
            crate::theme::apply_kit_theme(&tokens, cx);
            crate::app::register_keybindings(cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::default(),
                        size(px(1100.0), px(640.0)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    let tokens = tokens.clone();
                    cx.new(|cx| ConnApp::new(theme.id, tokens, Some(server), window, cx))
                },
            )
            .expect("a window")
        });
        ctx.update(|cx| {
            app.update(cx, |app, cx| {
                app.set_shell(kitchen_sink_shell(), cx);
                app.set_thread_for_test(
                    LOCAL_THREAD.to_owned(),
                    ThreadState::new(LOCAL_THREAD),
                    cx,
                );
            });
        });
        ctx.update_window(window, |_, w, cx| {
            app.update(cx, |app, cx| app.toggle_thread_details(w, cx));
        })
        .expect("a window");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline
            && ctx.update(|cx| app.read(cx).details_tasks_for_test()) == 0
        {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
            std::thread::sleep(Duration::from_millis(20));
        }
        for _ in 0..4 {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
        }
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("details-schedules-{theme_label}.png")))
            .expect("a saved PNG");
    }
}
