//! Inline Vault login suggestions in the Browser panel, through a real `BrowserPanel` in the
//! mounted app. The page's watcher message is fed in as the console bridge would deliver it.
//! Vault is stubbed in test builds, so no test reaches the real one.

use conn_desktop::vault::VaultLoginField;
use gpui_kit::Context;

use super::*;
use crate::panels::BrowserPanelHandle;

type Page = gpui_kit::WeakEntity<BrowserPanelHandle>;

/// The mounted app with a browser tab on `url`.
fn open_page(cx: &mut TestAppContext, url: &str) -> (AnyWindowHandle, Entity<ConnApp>, Page) {
    // The Vault lookup runs on a Tokio thread and comes back to the panel.
    cx.executor().allow_parking();
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected", cx);
            app.open_browser_tab(url.into(), false, cx);
        })
    });
    render_frames(cx, window);
    let id = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
        .expect("a browser tab is open");
    let page = cx
        .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser");
    with_page(cx, &page, |panel, cx| panel.commit_url_for_test(url, cx));
    (window, app, page)
}

/// The page commits a new address; its picker starts clean, as on any new document.
fn goto(cx: &mut TestAppContext, page: &Page, url: &str) {
    with_page(cx, page, |panel, cx| {
        panel.load_start_for_test(cx);
        panel.commit_url_for_test(url, cx);
    });
}

fn with_page<R>(
    cx: &mut TestAppContext,
    page: &Page,
    f: impl FnOnce(&mut BrowserPanelHandle, &mut Context<'_, BrowserPanelHandle>) -> R,
) -> R {
    cx.update(|cx| page.upgrade().expect("the page is alive").update(cx, f))
}

/// What the page's watcher says for the focused field `field` (a username next to a password).
fn field_event(kind: &str, field: &str) -> serde_json::Value {
    json!({
        "revision": 1,
        "kind": kind,
        "anchor": {
            "field": field,
            "page": {"username": true, "password": true, "otp": false},
            "x": 40.0, "y": 60.0, "width": 220.0, "height": 28.0,
            "viewportWidth": 400.0, "viewportHeight": 500.0,
        },
    })
}

fn send(cx: &mut TestAppContext, page: &Page, event: &serde_json::Value) {
    with_page(cx, page, |panel, cx| panel.inline_event_for_test(event, cx));
}

fn key(cx: &mut TestAppContext, page: &Page, key: &str) -> bool {
    with_page(cx, page, |panel, cx| panel.inline_key_for_test(key, cx))
}

fn labels(cx: &mut TestAppContext, page: &Page) -> Vec<String> {
    with_page(cx, page, |panel, _| panel.inline_labels_for_test())
}

fn shown(cx: &mut TestAppContext, page: &Page) -> bool {
    with_page(cx, page, |panel, _| panel.inline_shown_for_test())
}

/// Pumps the executor until the Vault lookup (off-thread) has come back to the panel.
fn settle(cx: &mut TestAppContext, page: &Page, what: &str, done: impl Fn(&[String]) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        if done(&labels(cx, page)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("{what}: got {:?}", labels(cx, page));
}

/// Waits for the lookup that follows a focus: the rows list the logins.
fn settle_logins(cx: &mut TestAppContext, page: &Page) {
    settle(cx, page, "the logins list", |rows| {
        rows.iter().any(|row| row.starts_with("Example"))
    });
}

fn settle_fill(cx: &mut TestAppContext, page: &Page, count: usize) -> Vec<VaultLoginField> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        let filled = with_page(cx, page, |panel, _| panel.filled_for_test());
        if filled.len() >= count {
            return filled;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    with_page(cx, page, |panel, _| panel.filled_for_test())
}

fn row_exists(cx: &mut TestAppContext, window: AnyWindowHandle, id: &str) -> bool {
    cx.update_window(window, |_, window, _| {
        window.try_find(id.to_owned()).is_some()
    })
    .expect("the window is open")
}

#[gpui_kit::test]
fn focusing_a_sign_in_field_lists_the_logins_and_a_click_fills_them(cx: &mut TestAppContext) {
    let (window, _app, page) = open_page(cx, "https://login.example/");
    assert!(with_page(cx, &page, |panel, _| panel.visible_for_test()));
    assert!(!shown(cx, &page), "nothing is up before a field is focused");

    send(cx, &page, &field_event("focus", "username"));
    assert!(
        shown(cx, &page),
        "the field's focus opens the picker at once"
    );
    assert_eq!(
        labels(cx, &page),
        vec!["Vault · this Mac", "Checking Vault…"],
        "while Vault answers"
    );
    settle_logins(cx, &page);
    assert_eq!(
        labels(cx, &page),
        vec![
            "Vault · this Mac",
            "Example, me@example.com",
            "Work, work@example.com",
        ]
    );

    render_frames(cx, window);
    assert!(
        row_exists(cx, window, "browser-vault-inline-1"),
        "the first login is drawn"
    );
    assert!(row_exists(cx, window, "browser-vault-inline-2"));

    let clicked = cx.update_window(window, |_, window, cx| {
        window.click("browser-vault-inline-1", cx);
    });
    assert!(clicked.is_ok());
    // The page shows a username and a password field: one pick fills both, in that order.
    assert_eq!(
        settle_fill(cx, &page, 2),
        vec![VaultLoginField::Username, VaultLoginField::Password]
    );
    assert!(!shown(cx, &page), "a pick closes the picker");
    render_frames(cx, window);
    assert!(!row_exists(cx, window, "browser-vault-inline-1"));
}

#[gpui_kit::test]
fn arrow_keys_and_enter_pick_a_login_and_escape_closes_the_picker(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx, "https://login.example/");
    send(cx, &page, &field_event("focus", "password"));
    settle_logins(cx, &page);

    assert!(
        !key(cx, &page, "enter"),
        "Enter with nothing highlighted goes to the page, to submit the form"
    );
    assert!(!key(cx, &page, "tab"), "other keys go to the page");
    assert!(key(cx, &page, "down"), "an arrow key is the picker's");
    assert!(key(cx, &page, "down"));
    assert!(key(cx, &page, "up"));
    assert!(key(cx, &page, "enter"), "Enter on a login picks it");
    assert_eq!(
        settle_fill(cx, &page, 2),
        vec![VaultLoginField::Username, VaultLoginField::Password]
    );
    assert!(!shown(cx, &page));

    send(cx, &page, &field_event("focus", "password"));
    settle_logins(cx, &page);
    assert!(shown(cx, &page), "focusing the field again reopens it");
    assert!(
        !key(cx, &page, "escape"),
        "Escape still reaches the page, which keeps the picker closed for this field"
    );
    assert!(!shown(cx, &page));
    assert!(
        !key(cx, &page, "down"),
        "a closed picker takes no arrow keys"
    );
}

#[gpui_kit::test]
fn a_locked_vault_offers_unlock_and_unlocking_lists_the_logins(cx: &mut TestAppContext) {
    let (window, _app, page) = open_page(cx, "https://locked.example/");
    send(cx, &page, &field_event("focus", "username"));
    assert_eq!(
        labels(cx, &page),
        vec!["Vault · this Mac", "Checking Vault…"],
        "while Vault answers"
    );
    settle(cx, &page, "the unlock row", |rows| {
        rows.contains(&"Unlock Vault".to_owned())
    });
    assert_eq!(
        labels(cx, &page),
        vec!["Vault · this Mac", "Unlock Vault"],
        "a locked answer leaves the loading state"
    );
    render_frames(cx, window);
    assert!(row_exists(cx, window, "browser-vault-inline-1"));

    // The click asks Vault again, now allowed to prompt: the stub answers with the list.
    let clicked = cx.update_window(window, |_, window, cx| {
        window.click("browser-vault-inline-1", cx);
    });
    assert!(clicked.is_ok());
    settle_logins(cx, &page);
    assert!(shown(cx, &page), "unlocking keeps the picker up");
    assert_eq!(
        with_page(cx, &page, |panel, _| panel.filled_for_test()),
        Vec::new(),
        "unlocking fills nothing"
    );
}

#[gpui_kit::test]
fn enter_on_the_unlock_row_unlocks(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx, "https://locked.example/");
    send(cx, &page, &field_event("focus", "username"));
    settle(cx, &page, "the unlock row", |rows| {
        rows.contains(&"Unlock Vault".to_owned())
    });
    assert!(key(cx, &page, "down"), "the row can be walked to");
    assert!(key(cx, &page, "enter"), "Enter on it is the picker's");
    settle_logins(cx, &page);
}

#[gpui_kit::test]
fn a_vault_error_says_so_and_offers_a_retry(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx, "https://broken.example/");
    send(cx, &page, &field_event("focus", "username"));
    settle(cx, &page, "the error", |rows| {
        rows.contains(&"Try again".to_owned())
    });
    assert_eq!(
        labels(cx, &page),
        vec![
            "Vault · this Mac",
            "Vault could not answer. Open or update Vault and try again.",
            "Try again",
        ]
    );
}

#[gpui_kit::test]
fn a_vault_that_never_answers_ends_in_an_error_not_in_loading(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx, "https://hang.example/");
    send(cx, &page, &field_event("focus", "username"));
    assert_eq!(
        labels(cx, &page),
        vec!["Vault · this Mac", "Checking Vault…"]
    );
    settle(cx, &page, "the timeout", |rows| {
        rows.contains(&"Try again".to_owned())
    });
    assert_eq!(
        labels(cx, &page),
        vec![
            "Vault · this Mac",
            "Vault did not answer in time.",
            "Try again"
        ]
    );
}

#[gpui_kit::test]
fn missing_and_empty_vaults_say_so_and_offer_no_pick(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx, "about:blank");
    for (url, text) in [
        ("https://unavailable.example/", "Vault is not installed"),
        ("https://empty.example/", "No matching login."),
    ] {
        goto(cx, &page, url);
        send(cx, &page, &field_event("focus", "username"));
        settle(cx, &page, text, |rows| rows.contains(&text.to_owned()));
        assert!(!key(cx, &page, "down"), "{text}: nothing to move through");
        assert!(!key(cx, &page, "enter"), "{text}: Enter goes to the page");
    }
}

#[gpui_kit::test]
fn the_picker_stays_away_from_pages_it_must_not_serve(cx: &mut TestAppContext) {
    // Only HTTPS: Vault logins are for HTTPS origins.
    let (_window, _app, page) = open_page(cx, "http://plain.example/");
    send(cx, &page, &field_event("focus", "username"));
    assert!(!shown(cx, &page), "an http page gets no picker");

    // Malformed or off-page metadata from a hostile page is dropped.
    goto(cx, &page, "https://login.example/");
    let mut off_page = field_event("focus", "username");
    off_page["anchor"]["x"] = json!(9000.0);
    for bad in [
        off_page,
        json!({"revision": 1, "kind": "focus", "anchor": {"field": "search"}}),
        json!({"kind": "focus"}),
        json!("focus"),
    ] {
        send(cx, &page, &bad);
        assert!(!shown(cx, &page), "{bad} opens nothing");
    }

    // A panel that is not on screen draws nothing and forgets the field.
    with_page(cx, &page, |panel, cx| panel.set_visible(false, cx));
    send(cx, &page, &field_event("focus", "username"));
    assert!(!shown(cx, &page), "a hidden panel gets no picker");
    with_page(cx, &page, |panel, cx| panel.set_visible(true, cx));
    send(cx, &page, &field_event("focus", "username"));
    assert!(shown(cx, &page), "shown again, it works");

    // The field going away (a dismiss report) closes it; so does a new page.
    send(cx, &page, &field_event("dismiss", "username"));
    assert!(!shown(cx, &page));
    send(cx, &page, &field_event("focus", "username"));
    assert!(shown(cx, &page));
    with_page(cx, &page, |panel, cx| panel.load_start_for_test(cx));
    assert!(!shown(cx, &page), "a new page starts with no picker");
}

#[gpui_kit::test]
fn the_page_never_receives_the_account_list(cx: &mut TestAppContext) {
    // The watcher script reports a field kind and its rectangle; the picker rows are native.
    // Check the script itself carries no way to hand the page a label or a value.
    let script = include_str!("../panels/browser_overlay_bridge.js");
    let watcher = script
        .split("function startCredentialInlineWatcher")
        .nth(1)
        .and_then(|rest| rest.split("let credentialInline").next())
        .expect("the watcher is in the bridge");
    for forbidden in [
        ".value",
        "innerText",
        "textContent",
        "outerHTML",
        "fetch(",
        "XMLHttp",
    ] {
        assert!(
            !watcher.contains(forbidden),
            "the watcher must not touch `{forbidden}`"
        );
    }
    // Nothing the page does reaches the Vault lookup: an event has a kind and a rectangle only.
    let (_window, _app, page) = open_page(cx, "https://login.example/");
    let mut spoof = field_event("focus", "username");
    spoof["items"] = json!([{"id": "x", "title": "Evil", "username": "evil"}]);
    spoof["anchor"]["items"] = json!(["Evil"]);
    send(cx, &page, &spoof);
    settle_logins(cx, &page);
    assert!(
        !labels(cx, &page).iter().any(|row| row.contains("Evil")),
        "a page cannot add rows to the picker"
    );
}
