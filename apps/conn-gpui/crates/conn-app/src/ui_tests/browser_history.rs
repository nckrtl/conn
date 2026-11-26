//! The Browser panel's history and "Recently used" new-tab page, through a real `BrowserPanel` in
//! the mounted app. The history is the app's own store, shared by the whole test process, so every
//! test names its project with a repository key of its own.

use gpui_kit::Context;

use super::*;
use crate::panels::BrowserPanelHandle;

type Page = gpui_kit::WeakEntity<BrowserPanelHandle>;

/// The shell of `mount_two_thread_app`, with both projects clones of the repository `key`.
fn mount_cloned_app(cx: &mut TestAppContext, key: &str) -> (AnyWindowHandle, Entity<ConnApp>) {
    let (window, app) = mount_app(cx);
    let mut shell = two_project_shell();
    for project in &mut shell.projects {
        let mut value = serde_json::to_value(&*project).expect("a project encodes");
        value["repositoryIdentity"] = json!({
            "canonicalKey": key,
            "locator": {
                "source": "git-remote",
                "remoteName": "origin",
                "remoteUrl": format!("git@github.com:{key}.git"),
            },
            "displayName": key,
            "name": "history",
        });
        *project = from_json(value).expect("a project with a repository decodes");
    }
    shell.threads.push(make_thread_shell(ThreadSeedSpec {
        id: "thread-other",
        project_id: "proj-other",
        title: "Other project thread",
        status: "completed",
        activity_run_status: None,
        pinned_at: None,
        settled_at: None,
        pending_kind: None,
    }));
    shell.synchronized = true;
    cx.update(|cx| app.update(cx, |app, cx| app.set_shell(shell, cx)));
    (window, app)
}

/// A browser tab on `url` for `thread`.
fn open_page(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
    thread: &str,
    url: &str,
) -> Page {
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread(thread, cx);
            app.open_browser_tab(url.into(), false, cx);
        })
    });
    render_frames(cx, window);
    let id = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
        .expect("a browser tab is open");
    cx.update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser")
}

fn with_page<R>(
    cx: &mut TestAppContext,
    page: &Page,
    f: impl FnOnce(&mut BrowserPanelHandle, &mut Context<'_, BrowserPanelHandle>) -> R,
) -> R {
    cx.update(|cx| page.upgrade().expect("the page is alive").update(cx, f))
}

fn context(cx: &mut TestAppContext, page: &Page) -> Option<String> {
    with_page(cx, page, |panel, _| panel.history_context_for_test())
}

fn urls(key: &str) -> Vec<String> {
    BrowserPanelHandle::history_for_test(key)
        .into_iter()
        .map(|(url, _)| url)
        .collect()
}

fn exists(cx: &mut TestAppContext, window: AnyWindowHandle, id: &str) -> bool {
    cx.update_window(window, |_, window, _| {
        window.try_find(id.to_owned()).is_some()
    })
    .expect("the window is open")
}

fn open_row(url: &str) -> String {
    format!("browser-recent-open:{url}")
}

fn remove_row(url: &str) -> String {
    format!("browser-recent-remove:{url}")
}

#[gpui_kit::test]
fn an_opened_address_is_remembered_and_a_revisit_moves_it_up(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/opened";
    let (window, app) = mount_cloned_app(cx, KEY);
    let page = open_page(
        cx,
        window,
        &app,
        "thread-selected",
        "https://one.opened.test/",
    );
    assert_eq!(urls(KEY), ["https://one.opened.test/"]);

    with_page(cx, &page, |panel, cx| {
        panel.navigate("https://two.opened.test/", cx)
    });
    assert_eq!(
        urls(KEY),
        ["https://two.opened.test/", "https://one.opened.test/"]
    );
    with_page(cx, &page, |panel, cx| {
        panel.navigate("https://one.opened.test/", cx)
    });
    assert_eq!(
        urls(KEY),
        ["https://one.opened.test/", "https://two.opened.test/"]
    );
    // A blank page is not a page to come back to.
    with_page(cx, &page, |panel, cx| panel.navigate("about:blank", cx));
    assert_eq!(urls(KEY).len(), 2);
}

#[gpui_kit::test]
fn clones_of_one_repository_share_a_history(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/clones";
    let (window, app) = mount_cloned_app(cx, KEY);
    let first = open_page(
        cx,
        window,
        &app,
        "thread-selected",
        "https://shared.clones.test/",
    );
    let second = open_page(
        cx,
        window,
        &app,
        "thread-other",
        "https://other.clones.test/",
    );
    assert_eq!(context(cx, &first).as_deref(), Some(KEY));
    assert_eq!(
        context(cx, &first),
        context(cx, &second),
        "two checkouts of one repository are one project"
    );
    assert_eq!(
        urls(KEY),
        ["https://other.clones.test/", "https://shared.clones.test/"]
    );
}

#[gpui_kit::test]
fn addresses_opened_before_the_project_is_known_are_recorded_once_it_is(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/late";
    let (window, app) = mount_cloned_app(cx, KEY);
    let page = open_page(
        cx,
        window,
        &app,
        "thread-selected",
        "https://first.late.test/",
    );
    with_page(cx, &page, |panel, cx| {
        panel.set_history_context(None, None, cx)
    });
    assert_eq!(context(cx, &page), None);
    with_page(cx, &page, |panel, cx| {
        panel.navigate("https://waiting.late.test/", cx)
    });
    assert_eq!(
        urls(KEY),
        ["https://first.late.test/"],
        "no project, nothing recorded yet"
    );
    with_page(cx, &page, |panel, cx| {
        panel.set_history_context(Some(KEY.to_owned()), None, cx);
    });
    assert_eq!(
        urls(KEY),
        ["https://waiting.late.test/", "https://first.late.test/"]
    );
}

#[gpui_kit::test]
fn the_new_tab_page_lists_the_recent_pages_and_a_row_opens_or_removes_its_page(
    cx: &mut TestAppContext,
) {
    const KEY: &str = "history-test/page";
    const ONE: &str = "https://one.page.test/";
    const TWO: &str = "https://two.page.test/docs";
    let (window, app) = mount_cloned_app(cx, KEY);
    let page = open_page(cx, window, &app, "thread-selected", ONE);
    with_page(cx, &page, |panel, cx| panel.navigate(TWO, cx));
    with_page(cx, &page, |panel, cx| panel.navigate("about:blank", cx));
    render_frames(cx, window);

    assert!(exists(cx, window, &open_row(ONE)));
    assert!(exists(cx, window, &open_row(TWO)));

    // A row opens its page the way the address bar does, so it moves to the top.
    let clicked = cx.update_window(window, |_, window, cx| window.click(open_row(ONE), cx));
    assert!(clicked.is_ok());
    assert_eq!(
        with_page(cx, &page, |panel, _| panel.target_url().to_owned()),
        ONE
    );
    assert_eq!(urls(KEY), [ONE, TWO]);

    // Back on the blank page, the remove button forgets one page and the row goes.
    with_page(cx, &page, |panel, cx| panel.navigate("about:blank", cx));
    render_frames(cx, window);
    let clicked = cx.update_window(window, |_, window, cx| window.click(remove_row(TWO), cx));
    assert!(clicked.is_ok());
    render_frames(cx, window);
    assert_eq!(urls(KEY), [ONE]);
    assert!(!exists(cx, window, &open_row(TWO)));
    assert!(exists(cx, window, &open_row(ONE)));
}

#[gpui_kit::test]
fn a_change_made_in_another_tab_shows_on_this_tabs_new_tab_page(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/other-tab";
    const SEEN: &str = "https://seen.other-tab.test/";
    let (window, app) = mount_cloned_app(cx, KEY);
    let blank = open_page(cx, window, &app, "thread-selected", "about:blank");
    render_frames(cx, window);
    assert!(!exists(cx, window, &open_row(SEEN)));

    let other = open_page(cx, window, &app, "thread-selected", SEEN);
    with_page(cx, &other, |panel, cx| panel.navigate("about:blank", cx));
    // Show the first tab again: its page draws what the other tab recorded.
    let id = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().next())
        .expect("the first tab is open");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_right_panel_surface(conn_state::PanelSurface::Browser(id), cx);
        });
    });
    render_frames(cx, window);
    assert_eq!(context(cx, &blank).as_deref(), Some(KEY));
    assert!(exists(cx, window, &open_row(SEEN)));
}

#[gpui_kit::test]
fn a_blank_tab_with_no_history_shows_the_empty_page(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/empty";
    let (window, app) = mount_cloned_app(cx, KEY);
    open_page(cx, window, &app, "thread-selected", "about:blank");
    render_frames(cx, window);
    assert!(urls(KEY).is_empty());
    assert!(exists(cx, window, "browser-recent-page"));
    assert!(!exists(cx, window, "browser-recent-list"));
}

#[gpui_kit::test]
fn a_restored_load_records_nothing_and_a_user_navigation_does(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/restore-live";
    const OPENED: &str = "https://opened.restore-live.test/";
    const FINAL: &str = "https://final.restore-live.test/auth/callback";
    const TYPED: &str = "https://typed.restore-live.test/";
    let (window, app) = mount_cloned_app(cx, KEY);
    let page = open_page(cx, window, &app, "thread-selected", OPENED);
    assert_eq!(urls(KEY), [OPENED]);

    // A tab that comes back on where its page ended up: not a visit, so the order stays.
    with_page(cx, &page, |panel, cx| panel.restore(FINAL, cx));
    assert_eq!(
        with_page(cx, &page, |panel, _| panel.target_url().to_owned()),
        FINAL,
        "the restored address still loads"
    );
    assert_eq!(urls(KEY), [OPENED]);

    with_page(cx, &page, |panel, cx| panel.navigate(TYPED, cx));
    assert_eq!(urls(KEY), [TYPED, OPENED]);
}

/// Tabs restored at startup (and, through the same pending load, tabs made again after their
/// browser was closed) load their saved address without touching Recently used.
#[gpui_kit::test]
fn restored_tabs_do_not_move_up_recently_used_at_startup(cx: &mut TestAppContext) {
    const KEY: &str = "history-test/restore-startup";
    const FIRST: &str = "https://first.restore-startup.test/";
    const SECOND: &str = "https://second.restore-startup.test/auth/callback";
    const TYPED: &str = "https://typed.restore-startup.test/";
    let dir = std::env::temp_dir().join(format!(
        "conn-restore-history-{}",
        crate::commands::new_thread_id()
    ));
    let path = dir.join("thread-panels.json");

    let (window, app) = mount_cloned_app(cx, KEY);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
        })
    });
    open_page(cx, window, &app, "thread-selected", FIRST);
    open_page(cx, window, &app, "thread-selected", SECOND);
    assert_eq!(urls(KEY), [SECOND, FIRST]);
    cx.update(|cx| app.update(cx, |app, cx| app.save_thread_panels_for_test(cx)));
    cx.run_until_parked();
    assert!(path.exists());

    // A restart: a new window reads the saved tabs and shows them.
    let (window, restarted) = mount_cloned_app(cx, KEY);
    cx.update(|cx| {
        restarted.update(cx, |app, cx| {
            app.set_thread_panels_path_for_test(path.clone(), cx);
            app.learn_primary_environment_for_test("env-a", cx);
            app.select_thread("thread-selected", cx);
        })
    });
    render_frames(cx, window);
    let id = cx
        .update(|cx| restarted.read(cx).right_panel_tabs().browser_ids().last())
        .expect("the saved tab came back");
    let page = cx
        .update(|cx| restarted.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser");
    assert_eq!(
        with_page(cx, &page, |panel, _| panel.target_url().to_owned()),
        SECOND,
        "the saved address loads"
    );
    assert_eq!(
        urls(KEY),
        [SECOND, FIRST],
        "restoring recorded nothing and moved nothing"
    );

    // The user then opens something: that is recorded.
    with_page(cx, &page, |panel, cx| panel.navigate(TYPED, cx));
    assert_eq!(urls(KEY), [TYPED, SECOND, FIRST]);
    let _ = std::fs::remove_dir_all(dir);
}
