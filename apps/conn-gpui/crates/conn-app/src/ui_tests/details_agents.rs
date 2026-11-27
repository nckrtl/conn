//! The Thread Details card lists the thread's child agents: native subagents, `delegate_task`
//! children, and children that run on another linked environment.

use super::*;
use crate::header::details_card::{AgentRow, AgentSources, AgentState, resolve_lineage};
use conn_state::{SubagentModel, TurnItemStatus};

const PARENT: &str = "thread-selected";
const LOCAL_CHILD: &str = "thread-child-local";
const REMOTE_TITLE: &str = "Set up executor v2 + Orbit MCP for conn machine";
const LOCAL_TITLE: &str = "Inspect sidebar card hover styles";

/// `2026-11-26T09:15:30.000Z` for a Unix time in seconds.
pub(super) fn iso(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from a day count (Howard Hinnant's `civil_from_days`).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

pub(super) fn now_secs() -> i64 {
    crate::sidebar::thread_list::current_unix_secs()
}

/// The kitchen-sink shell, plus a finished child of the parent thread when `local` is set.
pub(crate) fn shell(local: bool) -> ShellState {
    let mut shell = kitchen_sink_shell();
    if local {
        let mut child = make_thread_shell(ThreadSeedSpec {
            id: LOCAL_CHILD,
            project_id: "proj-parity",
            title: LOCAL_TITLE,
            status: "completed",
            activity_run_status: None,
            pinned_at: None,
            settled_at: None,
            pending_kind: None,
        });
        child.lineage.parent_thread_id = Some(PARENT.to_owned());
        shell.threads.push(child);
    }
    shell
}

/// The parent's timeline: a running child on environment `mini` (labelled `nick`) and a finished
/// one on this environment.
pub(crate) fn parent_thread(remote: bool, local: bool) -> ThreadState {
    let now = now_secs();
    let mut thread = ThreadState::new(PARENT);
    thread.synchronized = true;
    if remote {
        thread.entries.push(TimelineEntry::Subagent {
            id: "sub-remote".to_owned(),
            child_thread_id: None,
            title: REMOTE_TITLE.to_owned(),
            role: "claudeAgent".to_owned(),
            status: TurnItemStatus::Running,
            summary: None,
            remote_child: Some(
                from_json(json!({
                    "threadId": "thread-mini", "environmentId": "mini", "label": "nick"
                }))
                .expect("remote child"),
            ),
            created_at: Some(iso(now - 95)),
            started_at: Some(iso(now - 95)),
            completed_at: None,
        });
        thread
            .subagent_of_entry
            .insert("sub-remote".to_owned(), "subagent-remote".to_owned());
        thread.subagent_models.insert(
            "subagent-remote".to_owned(),
            SubagentModel {
                model: Some("claude-opus-5-5".to_owned()),
                instance_id: Some("claudeAgent".to_owned()),
                options: [("reasoningEffort".to_owned(), "medium".to_owned())].into(),
            },
        );
    }
    if local {
        thread.entries.push(TimelineEntry::Subagent {
            id: "sub-local".to_owned(),
            child_thread_id: Some(LOCAL_CHILD.to_owned()),
            title: LOCAL_TITLE.to_owned(),
            role: "claudeAgent".to_owned(),
            status: TurnItemStatus::Completed,
            summary: None,
            remote_child: None,
            created_at: Some(iso(now - 400)),
            started_at: Some(iso(now - 400)),
            completed_at: Some(iso(now - 358)),
        });
    }
    thread
}

/// Mounts the app on the parent thread with the linked environment `mini` loaded.
pub(crate) fn mount(
    cx: &mut TestAppContext,
    remote: bool,
    local: bool,
) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(shell(local), cx);
            app.add_linked_shell_for_test(
                "mini",
                "nick",
                linked_mini_shell("/work/mini", "Mini diagnostics"),
                cx,
            );
            app.set_thread_for_test(PARENT.to_owned(), parent_thread(remote, local), cx);
        });
    });
    (window, app)
}

fn labels(cx: &mut TestAppContext, window: AnyWindowHandle) -> Vec<String> {
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

#[gpui_kit::test]
fn card_lists_a_remote_and_a_local_child(cx: &mut TestAppContext) {
    let (window, _app) = mount(cx, true, true);
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    let all = labels(cx, window);
    assert!(
        all.contains(&format!("Open thread {REMOTE_TITLE}")),
        "the remote child is listed: {all:?}"
    );
    // The finished local child sits in the collapsed `Previous agents` group.
    assert!(!all.contains(&format!("Open thread {LOCAL_TITLE}")));
    click_row(cx, window, "Previous agents", MouseButton::Left);
    assert!(
        labels(cx, window).contains(&format!("Open thread {LOCAL_TITLE}")),
        "the local child is listed once the group opens"
    );
}

#[gpui_kit::test]
fn rows_carry_environment_model_status_and_elapsed(cx: &mut TestAppContext) {
    let (_window, app) = mount(cx, true, true);
    let rows: Vec<AgentRow> = cx.read(|cx| {
        let app = app.read(cx);
        let thread = app.shell().find_thread(PARENT).expect("parent");
        let lineage = resolve_lineage(
            app.shell(),
            thread,
            app.selected_timeline(),
            &AgentSources {
                catalog: &conn_state::providers::ModelCatalog::default(),
                children: &std::collections::HashMap::new(),
            },
            now_secs(),
        );
        lineage
            .running
            .iter()
            .chain(&lineage.previous)
            .cloned()
            .collect()
    });
    assert_eq!(rows.len(), 2);
    let remote = &rows[0];
    assert_eq!(remote.title, REMOTE_TITLE);
    assert_eq!(remote.state, AgentState::Running);
    assert_eq!(remote.environment_id.as_deref(), Some("mini"));
    assert_eq!(remote.thread_id, "thread-mini");
    assert_eq!(
        remote.meta().as_deref(),
        Some("on nick · claude-opus-5-5 · medium")
    );
    assert!(
        remote.elapsed.as_deref().is_some_and(|e| e.ends_with('s')),
        "{:?}",
        remote.elapsed
    );
    let local = &rows[1];
    assert_eq!(local.title, LOCAL_TITLE);
    assert_eq!(local.state, AgentState::Done);
    assert_eq!(local.environment_id, None);
    assert_eq!(local.environment_label, None);
    assert_eq!(local.elapsed.as_deref(), Some("42s"));
    // No subagent record: the thread's own model.
    assert_eq!(local.model.as_deref(), Some("claude-sonnet-4-6"));
}

#[gpui_kit::test]
fn a_click_on_the_remote_row_opens_its_thread_on_its_environment(cx: &mut TestAppContext) {
    let (window, app) = mount(cx, true, true);
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    click_row(
        cx,
        window,
        &format!("Open thread {REMOTE_TITLE}"),
        MouseButton::Left,
    );
    assert_eq!(open_thread(cx, &app).as_deref(), Some("thread-mini"));
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test("thread-mini")),
        Some("mini".to_owned())
    );
}

#[gpui_kit::test]
fn a_click_on_the_local_row_opens_that_thread(cx: &mut TestAppContext) {
    let (window, app) = mount(cx, true, true);
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    click_row(cx, window, "Previous agents", MouseButton::Left);
    click_row(
        cx,
        window,
        &format!("Open thread {LOCAL_TITLE}"),
        MouseButton::Left,
    );
    assert_eq!(open_thread(cx, &app).as_deref(), Some(LOCAL_CHILD));
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test(LOCAL_CHILD)),
        None
    );
}

#[gpui_kit::test]
fn a_delegated_child_the_shell_does_not_link_to_its_parent_is_still_listed(
    cx: &mut TestAppContext,
) {
    // `delegate_task` on this environment: the shell child has no `parentThreadId`.
    let (window, app) = mount(cx, false, true);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let mut shell = shell(true);
            for t in &mut shell.threads {
                if t.id == LOCAL_CHILD {
                    t.lineage.parent_thread_id = None;
                }
            }
            app.set_shell(shell, cx);
        })
    });
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    click_row(cx, window, "Previous agents", MouseButton::Left);
    assert!(labels(cx, window).contains(&format!("Open thread {LOCAL_TITLE}")));
}

#[gpui_kit::test]
fn the_section_is_hidden_when_the_thread_has_no_children(cx: &mut TestAppContext) {
    let (window, _app) = mount(cx, false, false);
    click_row(cx, window, "Toggle thread details panel", MouseButton::Left);
    let all = labels(cx, window);
    assert!(all.iter().any(|l| l == "Thread details"), "card is open");
    assert!(
        !all.iter().any(|l| l.starts_with("Subagents")),
        "no Subagents section without children: {all:?}"
    );
}

/// Renders the details card offscreen with a running remote child and a finished local child, in
/// Dark Ocean and Light.
///
/// `CONN_DETAILS_AGENTS_SHOTS_DIR=<dir> cargo test -p conn-app render_details_agents_screenshots -- --ignored`
#[cfg(target_os = "macos")]
#[test]
#[ignore = "writes PNGs; set CONN_DETAILS_AGENTS_SHOTS_DIR"]
fn render_details_agents_screenshots() {
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};
    let Some(dir) = std::env::var_os("CONN_DETAILS_AGENTS_SHOTS_DIR") else {
        return;
    };
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = headless_shot_context();
    for (theme_id, theme_label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        let tokens = conn_theme::Tokens::derive(&theme);
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
                    cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
                },
            )
            .expect("a window")
        });
        ctx.update(|cx| {
            app.update(cx, |app, cx| {
                app.set_shell(shell(true), cx);
                app.add_linked_shell_for_test(
                    "mini",
                    "nick",
                    linked_mini_shell("/work/mini", "Mini diagnostics"),
                    cx,
                );
                app.set_thread_for_test(PARENT.to_owned(), parent_thread(true, true), cx);
            });
        });
        ctx.update_window(window, |_, w, cx| {
            app.update(cx, |app, cx| {
                app.toggle_thread_details(w, cx);
                // The finished child shows beside the running one.
                app.toggle_details_previous_agents(cx);
            });
        })
        .expect("a window");
        for _ in 0..4 {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
        }
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("details-agents-{theme_label}.png")))
            .expect("a saved PNG");
    }
}

/// A server config of environment `environment` that lists provider `instance` (driver `driver`)
/// with one model `slug`.
fn config_listing(
    environment: &str,
    instance: &str,
    driver: &str,
    slug: &str,
) -> std::sync::Arc<conn_state::providers::ServerConfigState> {
    let mut snapshot: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
    ))
    .expect("the server config fixture is JSON");
    snapshot["config"]["environment"]["environmentId"] = json!(environment);
    snapshot["config"]["providers"] = json!([{
        "instanceId": instance, "driver": driver, "displayName": instance, "enabled": true,
        "installed": true, "status": "ready", "auth": {"status": "authenticated"},
        "checkedAt": "2026-11-27T00:00:00Z",
        "models": [{ "slug": slug, "name": slug, "isCustom": false }],
    }]);
    let event: conn_contract::ServerConfigStreamEvent =
        conn_contract::from_json(snapshot).expect("the server config fixture decodes");
    let mut state = conn_state::providers::ServerConfigState::new();
    state.apply(event);
    std::sync::Arc::new(state)
}

/// The remote child of [`parent_thread`] with role `role` and parent record `record`, its thread
/// on `mini` running `child` (`(instance, model)`), and `mini` listing `catalog`
/// (`(instance, driver, model)`).
struct RemoteCase<'a> {
    role: &'a str,
    record: Option<SubagentModel>,
    child: Option<(&'a str, &'a str)>,
    catalog: Option<(&'a str, &'a str, &'a str)>,
}

/// The provider mark the details card draws for the remote child of `case`.
fn remote_row_brand(
    cx: &mut TestAppContext,
    case: &RemoteCase<'_>,
) -> Option<crate::icons::ProviderBrand> {
    let (_window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(shell(false), cx);
            let mut mini = linked_mini_shell("/work/mini", "Mini diagnostics");
            if let Some((instance, model)) = case.child {
                for thread in &mut mini.threads {
                    thread.provider_instance_id = instance.to_owned();
                    thread.model_selection.model = serde_json::Value::String(model.to_owned());
                }
            }
            app.add_linked_shell_for_test("mini", "nick", mini, cx);
            if let Some((instance, driver, model)) = case.catalog {
                app.set_linked_config_for_test(
                    "mini",
                    config_listing("mini", instance, driver, model),
                );
            }
            let mut thread = parent_thread(true, false);
            for entry in &mut thread.entries {
                if let TimelineEntry::Subagent { role, .. } = entry {
                    case.role.clone_into(role);
                }
            }
            thread.subagent_models.clear();
            if let Some(record) = case.record.clone() {
                thread
                    .subagent_models
                    .insert("subagent-remote".to_owned(), record);
            }
            app.set_thread_for_test(PARENT.to_owned(), thread, cx);
        });
    });
    let provider = cx.read(|cx| {
        let app = app.read(cx);
        let thread = app.shell().find_thread(PARENT).expect("parent");
        let timeline = app.selected_timeline();
        let children = timeline
            .map(|t| app.subagent_children(t, Some(PARENT)))
            .unwrap_or_default();
        let lineage = resolve_lineage(
            app.shell(),
            thread,
            timeline,
            &AgentSources {
                catalog: &conn_state::providers::ModelCatalog::default(),
                children: &children,
            },
            now_secs(),
        );
        let row = lineage
            .running
            .iter()
            .find(|row| row.thread_id == "thread-mini")
            .expect("the remote row");
        row.provider.clone()
    });
    crate::icons::provider_brand(&provider)
}

fn record(instance: &str, model: &str) -> SubagentModel {
    SubagentModel {
        model: Some(model.to_owned()),
        instance_id: Some(instance.to_owned()),
        options: std::collections::HashMap::new(),
    }
}

#[gpui_kit::test]
fn a_remote_child_takes_its_mark_from_its_own_environments_catalog(cx: &mut TestAppContext) {
    // The parent's catalog knows neither the instance nor the model; mini's lists the instance as
    // Claude.
    let brand = remote_row_brand(
        cx,
        &RemoteCase {
            role: "remote",
            record: Some(record("box-a", "frontier-1")),
            child: Some(("box-a", "frontier-1")),
            catalog: Some(("box-a", "claudeAgent", "frontier-1")),
        },
    );
    assert_eq!(brand, Some(crate::icons::ProviderBrand::Claude));
}

#[gpui_kit::test]
fn an_unknown_instance_with_a_claude_model_shows_claude(cx: &mut TestAppContext) {
    let brand = remote_row_brand(
        cx,
        &RemoteCase {
            role: "remote",
            record: Some(record("mystery", "claude-opus-5-5")),
            child: None,
            catalog: None,
        },
    );
    assert_eq!(brand, Some(crate::icons::ProviderBrand::Claude));
}

#[gpui_kit::test]
fn a_codex_child_on_a_linked_environment_shows_codex(cx: &mut TestAppContext) {
    let brand = remote_row_brand(
        cx,
        &RemoteCase {
            role: "remote",
            record: None,
            child: Some(("work", "sol-1")),
            catalog: Some(("work", "codex", "sol-1")),
        },
    );
    assert_eq!(brand, Some(crate::icons::ProviderBrand::OpenAi));
}

#[gpui_kit::test]
fn a_remote_child_nothing_names_keeps_the_robot(cx: &mut TestAppContext) {
    // No record, no catalog, and a child whose instance and model name no brand.
    let brand = remote_row_brand(
        cx,
        &RemoteCase {
            role: "remote",
            record: None,
            child: Some(("mystery", "mystery-1")),
            catalog: None,
        },
    );
    assert_eq!(brand, None);
}

#[gpui_kit::test]
fn a_linked_parents_child_on_this_environment_takes_this_environments_catalog(
    cx: &mut TestAppContext,
) {
    // The screenshot case: the parent runs on a linked environment, the child on this one.
    let (_window, app) = mount_app(cx);
    let provider = cx.update(|cx| {
        app.update(cx, |app, cx| {
            let mut primary = shell(true);
            for thread in &mut primary.threads {
                if thread.id == LOCAL_CHILD {
                    thread.provider_instance_id = "box-b".to_owned();
                    thread.model_selection.model =
                        serde_json::Value::String("frontier-2".to_owned());
                    thread.lineage.parent_thread_id = None;
                }
            }
            app.set_shell(primary, cx);
            app.set_server_config_for_test(
                config_listing("primary", "box-b", "claudeAgent", "frontier-2"),
                cx,
            );
            app.add_linked_shell_for_test(
                "mini",
                "agent",
                linked_mini_shell("/work/mini", "Mini parent"),
                cx,
            );
            let here = app.primary_environment_id_for_test();
            let mut parent = ThreadState::new("thread-mini");
            parent.synchronized = true;
            parent.entries.push(TimelineEntry::Subagent {
                id: "sub-here".to_owned(),
                child_thread_id: None,
                title: LOCAL_TITLE.to_owned(),
                role: "remote".to_owned(),
                status: TurnItemStatus::Running,
                summary: None,
                remote_child: Some(
                    from_json(json!({
                        "threadId": LOCAL_CHILD, "environmentId": here, "label": "nick"
                    }))
                    .expect("remote child"),
                ),
                created_at: None,
                started_at: None,
                completed_at: None,
            });
            app.set_thread_for_test("thread-mini".to_owned(), parent, cx);
            let timeline = app.selected_timeline().expect("the parent's timeline");
            let children = app.subagent_children(timeline, Some("thread-mini"));
            let thread = app.shell().find_thread("thread-mini").expect("parent");
            let lineage = resolve_lineage(
                app.shell(),
                thread,
                Some(timeline),
                &AgentSources {
                    catalog: &conn_state::providers::ModelCatalog::default(),
                    children: &children,
                },
                now_secs(),
            );
            lineage
                .running
                .iter()
                .find(|row| row.thread_id == LOCAL_CHILD)
                .expect("the child row")
                .provider
                .clone()
        })
    });
    assert_eq!(
        crate::icons::provider_brand(&provider),
        Some(crate::icons::ProviderBrand::Claude)
    );
}

/// Renders the details card offscreen, dark, with a running child on another machine whose parent
/// record names it only as `remote`.
///
/// `CONN_REMOTE_SUBAGENT_SHOT=<file.png> cargo test -p conn-app render_remote_subagent_icon_screenshot -- --ignored`
#[cfg(target_os = "macos")]
#[test]
#[ignore = "writes a PNG; set CONN_REMOTE_SUBAGENT_SHOT"]
fn render_remote_subagent_icon_screenshot() {
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{AppContext as _, Bounds, Point, WindowBounds, WindowOptions, px, size};
    let Some(path) = std::env::var_os("CONN_REMOTE_SUBAGENT_SHOT") else {
        return;
    };
    let path = std::path::Path::new(&path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("an output folder");
    }
    let mut ctx = headless_shot_context();
    let theme = conn_theme::theme_by_id("dark-ocean").expect("a built-in theme");
    let tokens = conn_theme::Tokens::derive(&theme);
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
                cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
            },
        )
        .expect("a window")
    });
    ctx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(shell(false), cx);
            app.add_linked_shell_for_test(
                "mini",
                "nick",
                linked_mini_shell("/work/mini", "Mini diagnostics"),
                cx,
            );
            let mut thread = parent_thread(true, false);
            for entry in &mut thread.entries {
                if let TimelineEntry::Subagent { role, title, .. } = entry {
                    "remote".clone_into(role);
                    "Verify Conn #469 child→parent wakeup".clone_into(title);
                }
            }
            app.set_thread_for_test(PARENT.to_owned(), thread, cx);
        });
    });
    ctx.update_window(window, |_, w, cx| {
        app.update(cx, |app, cx| app.toggle_thread_details(w, cx));
    })
    .expect("a window");
    for _ in 0..4 {
        ctx.update_window(window, |_, w, c| w.render_frame(c))
            .expect("a frame");
        ctx.run_until_parked();
    }
    ctx.capture_screenshot(window)
        .expect("a screenshot")
        .save(path)
        .expect("a saved PNG");
}
