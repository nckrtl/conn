//! The Thread Details card lists the thread's child agents: native subagents, `delegate_task`
//! children, and children that run on another linked environment.

use super::*;
use crate::header::details_card::{AgentRow, AgentState, resolve_lineage};
use conn_state::{SubagentModel, TurnItemStatus};

const PARENT: &str = "thread-selected";
const LOCAL_CHILD: &str = "thread-child-local";
const REMOTE_TITLE: &str = "Set up executor v2 + Orbit MCP for conn machine";
const LOCAL_TITLE: &str = "Inspect sidebar card hover styles";

/// `2026-11-26T09:15:30.000Z` for a Unix time in seconds.
fn iso(secs: i64) -> String {
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

fn now_secs() -> i64 {
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
            &conn_state::providers::ModelCatalog::default(),
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
