//! Passkeys in the Browser panel, through a real `BrowserPanel` in the mounted app. The page
//! shim's console messages are fed in as the bridge would deliver them, and Vault is a stand-in:
//! no test reaches the real one.

use gpui_kit::Context;

use super::*;
use crate::panels::BrowserPanelHandle;

type Page = gpui_kit::WeakEntity<BrowserPanelHandle>;

const URL: &str = "https://login.example/signin";
const GET: &str = "passkey-get";
const OPTIONS: &str = r#"{"publicKey":{"challenge":"AAAAAAAAAAAAAAAAAAAAAA"}}"#;
const HANG: &str = r#"{"publicKey":{"hang":true}}"#;

/// The mounted app with a browser tab on an HTTPS page whose document has started, so the browser
/// has made its token.
fn open_page(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<ConnApp>, Page) {
    // The ceremony runs on a Tokio thread and comes back to the panel.
    cx.executor().allow_parking();
    let (window, app) = mount_two_thread_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.select_thread("thread-selected", cx);
            app.open_browser_tab(URL.into(), false, cx);
        })
    });
    render_frames(cx, window);
    let id = cx
        .update(|cx| app.read(cx).right_panel_tabs().browser_ids().last())
        .expect("a browser tab is open");
    let page = cx
        .update(|cx| app.read(cx).browser_weak_for_test(id, cx))
        .expect("the shown tab has a browser");
    goto(cx, &page, URL);
    (window, app, page)
}

/// A new document, as the browser reports it: its callback makes the token, then the panel hears
/// the load start.
fn goto(cx: &mut TestAppContext, page: &Page, url: &str) -> Option<String> {
    with_page(cx, page, |panel, cx| {
        let script = panel.document_start_for_test(url);
        panel.load_start_for_test(cx);
        panel.commit_url_for_test(url, cx);
        script
    })
}

fn with_page<R>(
    cx: &mut TestAppContext,
    page: &Page,
    f: impl FnOnce(&mut BrowserPanelHandle, &mut Context<'_, BrowserPanelHandle>) -> R,
) -> R {
    cx.update(|cx| page.upgrade().expect("the page is alive").update(cx, f))
}

fn token(cx: &mut TestAppContext, page: &Page) -> String {
    with_page(cx, page, |panel, _| panel.passkey_token_for_test()).expect("the page has a token")
}

fn start(cx: &mut TestAppContext, page: &Page, token: &str, id: &str, options: &str) {
    with_page(cx, page, |panel, cx| {
        panel.passkey_message_for_test((token, "start", id), (GET, options), cx);
    });
}

fn abort(cx: &mut TestAppContext, page: &Page, token: &str, id: &str) {
    with_page(cx, page, |panel, cx| {
        panel.passkey_message_for_test((token, "abort", id), ("", ""), cx);
    });
}

fn replies(cx: &mut TestAppContext, page: &Page) -> Vec<String> {
    with_page(cx, page, |panel, _| panel.passkey_replies_for_test())
}

fn waiting(cx: &mut TestAppContext, page: &Page) -> bool {
    with_page(cx, page, |panel, _| panel.passkey_waiting_for_test())
}

/// Pumps the executor until the ceremony (off-thread) has come back to the panel.
fn settle(cx: &mut TestAppContext, page: &Page, count: usize) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        cx.run_until_parked();
        let replies = replies(cx, page);
        if replies.len() >= count {
            return replies;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    replies(cx, page)
}

/// Gives a task time to answer that should not.
fn linger(cx: &mut TestAppContext) {
    for _ in 0..5 {
        cx.run_until_parked();
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[gpui_kit::test]
fn the_top_frame_gets_a_credential_for_the_browsers_address(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let token = token(cx, &page);
    start(cx, &page, &token, "r-1", OPTIONS);
    assert!(waiting(cx, &page), "Vault is being waited for");
    let replies = settle(cx, &page, 1);
    // The credential names the URL the browser holds: the message carried none.
    assert_eq!(
        replies,
        vec![format!(r#"r-1:ok:{{"mode":"passkey-get","url":"{URL}"}}"#)]
    );
    assert!(!waiting(cx, &page));
}

#[gpui_kit::test]
fn a_request_without_the_pages_token_is_a_security_error(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    // A subframe cannot read the token: whatever it sends is refused, and nothing starts.
    start(cx, &page, "guess", "r-1", OPTIONS);
    assert!(!waiting(cx, &page));
    assert_eq!(replies(cx, &page), vec!["r-1:SecurityError"]);
}

#[gpui_kit::test]
fn the_old_pages_token_stops_working_on_a_new_page(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let old = token(cx, &page);
    goto(cx, &page, "https://other.example/");
    let new = token(cx, &page);
    assert_ne!(old, new);
    start(cx, &page, &old, "r-1", OPTIONS);
    assert_eq!(replies(cx, &page), vec!["r-1:SecurityError"]);
    start(cx, &page, &new, "r-2", OPTIONS);
    let replies = settle(cx, &page, 2);
    assert!(
        replies[1].starts_with(r#"r-2:ok:{"mode":"passkey-get","url":"https://other.example/"#),
        "{replies:?}"
    );
}

#[gpui_kit::test]
fn a_page_that_is_not_https_is_a_security_error(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let old = token(cx, &page);
    // No shim and no token for a page that is not HTTPS.
    assert_eq!(goto(cx, &page, "http://plain.example/"), None);
    assert_eq!(
        with_page(cx, &page, |panel, _| panel.passkey_token_for_test()),
        None
    );
    start(cx, &page, &old, "r-1", OPTIONS);
    start(cx, &page, "anything", "r-2", OPTIONS);
    assert_eq!(
        replies(cx, &page),
        vec!["r-1:SecurityError", "r-2:SecurityError"]
    );
    assert!(!waiting(cx, &page));
}

#[gpui_kit::test]
fn the_shim_is_made_only_for_https_pages(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let script = goto(cx, &page, URL).expect("an HTTPS page gets the shim");
    assert!(script.contains(&format!("\"{}\"", token(cx, &page))));
    for url in ["http://plain.example/", "about:blank", "file:///tmp/x.html"] {
        assert_eq!(goto(cx, &page, url), None, "{url}");
    }
}

#[gpui_kit::test]
fn a_tab_runs_one_ceremony_at_a_time(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let token = token(cx, &page);
    start(cx, &page, &token, "r-1", HANG);
    start(cx, &page, &token, "r-2", OPTIONS);
    // The second is refused at once, and the first keeps waiting.
    assert_eq!(replies(cx, &page), vec!["r-2:NotAllowedError"]);
    assert!(waiting(cx, &page));
}

#[gpui_kit::test]
fn the_page_can_withdraw_its_request(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let token = token(cx, &page);
    start(cx, &page, &token, "r-1", HANG);
    // Another request's id, or a subframe's token, cancels nothing.
    abort(cx, &page, &token, "other");
    abort(cx, &page, "guess", "r-1");
    assert!(waiting(cx, &page));
    abort(cx, &page, &token, "r-1");
    assert!(!waiting(cx, &page));
    linger(cx);
    assert!(replies(cx, &page).is_empty(), "the page gave up: no answer");
    // The slot is free.
    start(cx, &page, &token, "r-2", OPTIONS);
    assert_eq!(settle(cx, &page, 1).len(), 1);
}

#[gpui_kit::test]
fn a_new_page_ends_the_ceremony_of_the_old_one(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let token = token(cx, &page);
    start(cx, &page, &token, "r-1", HANG);
    assert!(waiting(cx, &page));
    goto(cx, &page, "https://next.example/");
    assert!(!waiting(cx, &page));
    linger(cx);
    assert!(replies(cx, &page).is_empty());
}

#[gpui_kit::test]
fn vault_errors_reach_the_page_by_name(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let token = token(cx, &page);
    for (n, name) in [
        "InvalidStateError",
        "SecurityError",
        "NotSupportedError",
        "NotAllowedError",
        "SomethingNew",
    ]
    .into_iter()
    .enumerate()
    {
        let options = format!(r#"{{"publicKey":{{"error":"{name}"}}}}"#);
        start(cx, &page, &token, &format!("r-{n}"), &options);
        let replies = settle(cx, &page, n + 1);
        let expected = if name == "SomethingNew" {
            "NotAllowedError"
        } else {
            name
        };
        assert_eq!(replies[n], format!("r-{n}:{expected}"));
        assert!(!waiting(cx, &page));
    }
}

#[gpui_kit::test]
fn a_request_vault_cannot_take_is_refused_before_it_starts(cx: &mut TestAppContext) {
    let (_window, _app, page) = open_page(cx);
    let token = token(cx, &page);
    with_page(&mut *cx, &page, |panel, cx| {
        panel.passkey_message_for_test((&token, "start", "r-1"), ("passkey-delete", OPTIONS), cx);
        panel.passkey_message_for_test((&token, "start", "r-2"), (GET, ""), cx);
        panel.passkey_message_for_test((&token, "start", "bad id"), (GET, OPTIONS), cx);
    });
    assert_eq!(
        replies(cx, &page),
        vec!["r-1:NotSupportedError", "r-2:NotSupportedError"]
    );
    assert!(!waiting(cx, &page));
}
