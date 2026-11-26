//! Passkeys (WebAuthn) in the Browser panel, with Vault as the authenticator.
//!
//! Chromium in Alloy style has no WebAuthn UI, so Conn injects `browser_passkeys.js` into the main
//! frame of each HTTPS page. The shim sends `navigator.credentials.create/get` requests over the
//! console bridge, and the panel hands each one to the Vault Mac app
//! ([`conn_desktop::vault::VaultClient::passkey`]). Vault shows its own panel and does the
//! cryptography, as it does for its Chrome extension. This file holds the parts that decide what
//! may reach Vault:
//!
//! - The page's address always comes from the browser, never from a message. A message carries
//!   only the request options.
//! - Each page load has a random token that lives only in the main frame's shim. A message
//!   without it (a subframe, or a page that already went away) is refused with `SecurityError`.
//! - A page that is not HTTPS is refused with `SecurityError`.
//! - A tab runs one ceremony at a time.

use std::io::Read as _;
use std::sync::{Arc, Mutex};

use conn_desktop::vault::{
    PASSKEY_OPTIONS_MAX_BYTES, PASSKEY_URL_MAX_BYTES, PasskeyError, PasskeyMode, https_origin,
};

const SHIM: &str = include_str!("browser_passkeys.js");
/// The string literal the shim ends with, quoted so the comment that names it stays as written.
const TOKEN_PLACEHOLDER: &str = "\"__CONN_PASSKEY_TOKEN__\"";
const TOKEN_BYTES: usize = 16;
const ID_MAX_CHARS: usize = 64;

/// The token of the page the main frame shows now. The browser thread sets it when a document
/// starts, and the panel reads it.
pub(super) type SharedToken = Arc<Mutex<Option<String>>>;

/// A random token, or `None` when the system gives none (then no shim is injected).
pub(super) fn new_token() -> Option<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    std::fs::File::open("/dev/urandom")
        .ok()?
        .read_exact(&mut bytes)
        .ok()?;
    use std::fmt::Write as _;
    Some(bytes.iter().fold(String::new(), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    }))
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 64 && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The shim for the page that holds `token`. `None` for a token that could not sit inside a script
/// string safely.
pub(super) fn shim_script(token: &str) -> Option<String> {
    valid_token(token).then(|| SHIM.replacen(TOKEN_PLACEHOLDER, &format!("\"{token}\""), 1))
}

/// Runs when the main frame starts a new document, on a browser thread. An HTTPS page gets a new
/// token and the shim. Any other page clears the token, so nothing it sends is answered.
pub(super) fn document_script(url: &str, slot: &SharedToken) -> Option<String> {
    let token = https_origin(url).and_then(|_| new_token());
    let script = token.as_deref().and_then(shim_script);
    if let Ok(mut current) = slot.lock() {
        *current = script.as_ref().and(token);
    }
    script
}

/// What the shim says: a request to run, or the page cancelling one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PasskeyMessage {
    pub token: String,
    pub op: PasskeyOp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PasskeyOp {
    Start {
        id: String,
        mode: String,
        options: String,
    },
    Abort {
        id: String,
    },
}

/// Reads the fields of a `passkey` console message. A malformed one is dropped.
pub(super) fn parse_message(
    token: String,
    op: &str,
    id: String,
    mode: String,
    options: String,
) -> Option<PasskeyMessage> {
    let id_ok = !id.is_empty()
        && id.len() <= ID_MAX_CHARS
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !id_ok {
        return None;
    }
    let op = match op {
        "start" => PasskeyOp::Start { id, mode, options },
        "abort" => PasskeyOp::Abort { id },
        _ => return None,
    };
    Some(PasskeyMessage { token, op })
}

/// The script that answers the shim: the credential JSON, or the `DOMException` name.
pub(super) fn reply_script(id: &str, result: &Result<String, PasskeyError>) -> String {
    let id_json = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_owned());
    let (ok, payload) = match result {
        Ok(credential) => (true, credential.as_str()),
        Err(error) => (false, error.name()),
    };
    let payload_json = serde_json::to_string(payload).unwrap_or_else(|_| "\"\"".to_owned());
    format!("window.__CONN_PASSKEY_REPLY__?.({id_json}, {ok}, {payload_json});")
}

/// A request that may go to Vault. Its URL is the browser's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Admitted {
    pub mode: PasskeyMode,
    pub url: String,
    pub options: String,
}

struct Ceremony {
    id: String,
    task: Option<tokio::task::AbortHandle>,
}

/// One tab's passkey ceremony, if any.
#[derive(Default)]
pub(super) struct PasskeyGate {
    active: Option<Ceremony>,
}

impl PasskeyGate {
    /// Whether Vault is being waited for.
    pub(super) fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// Decides whether a `start` message may reach Vault. `page_token` is the token of the page
    /// the browser shows, and `page_url` that page's address, both from the browser.
    pub(super) fn admit(
        &mut self,
        page_token: Option<&str>,
        page_url: &str,
        message_token: &str,
        id: &str,
        mode: &str,
        options: &str,
    ) -> Result<Admitted, PasskeyError> {
        if page_token != Some(message_token) {
            // A subframe cannot read the token, and a page that already went away has an old one.
            return Err(PasskeyError::Security);
        }
        if https_origin(page_url).is_none() || page_url.len() > PASSKEY_URL_MAX_BYTES {
            return Err(PasskeyError::Security);
        }
        let mode = match mode {
            "passkey-create" => PasskeyMode::Create,
            "passkey-get" => PasskeyMode::Get,
            _ => return Err(PasskeyError::NotSupported),
        };
        if options.is_empty() || options.len() > PASSKEY_OPTIONS_MAX_BYTES {
            return Err(PasskeyError::NotSupported);
        }
        if self.active.is_some() {
            return Err(PasskeyError::NotAllowed);
        }
        self.active = Some(Ceremony {
            id: id.to_owned(),
            task: None,
        });
        Ok(Admitted {
            mode,
            url: page_url.to_owned(),
            options: options.to_owned(),
        })
    }

    /// Remembers the task that talks to Vault, so cancelling can stop it.
    pub(super) fn attach(&mut self, id: &str, task: tokio::task::AbortHandle) {
        match self.active.as_mut() {
            Some(active) if active.id == id => active.task = Some(task),
            _ => task.abort(),
        }
    }

    /// Ends the ceremony `id`. `false` when it is not the live one, so its answer is stale.
    pub(super) fn finish(&mut self, id: &str) -> bool {
        if self.active.as_ref().is_some_and(|active| active.id == id) {
            self.active = None;
            true
        } else {
            false
        }
    }

    /// The page withdrew its request. Stopping the task closes the pipe to Vault, which ends
    /// the ceremony there.
    pub(super) fn abort(&mut self, page_token: Option<&str>, message_token: &str, id: &str) {
        if page_token == Some(message_token) && self.active.as_ref().is_some_and(|a| a.id == id) {
            self.cancel();
        }
    }

    /// Ends any ceremony without an answer: the page went away, or the tab closed.
    pub(super) fn cancel(&mut self) {
        if let Some(Ceremony {
            task: Some(task), ..
        }) = self.active.take()
        {
            task.abort();
        }
    }
}

/// Tests never reach Vault. The `publicKey` of the options says what this stand-in does: `hang`
/// never answers, `error` answers with that error name, and anything else yields a credential
/// that names the mode and the URL Vault was given.
/// A closed tab drops its panel, which ends a ceremony Vault is still showing.
impl Drop for PasskeyGate {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[cfg(test)]
pub(super) async fn stub_vault(request: &Admitted) -> Result<String, PasskeyError> {
    let options: serde_json::Value = serde_json::from_str(&request.options).unwrap_or_default();
    let key = &options["publicKey"];
    if key.get("hang").is_some() {
        std::future::pending::<()>().await;
    }
    if let Some(name) = key["error"].as_str() {
        return Err(PasskeyError::from_name(name));
    }
    Ok(serde_json::json!({"mode": request.mode.as_str(), "url": request.url}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.com/login";
    const OPTIONS: &str = r#"{"publicKey":{}}"#;

    fn admit(gate: &mut PasskeyGate, id: &str) -> Result<Admitted, PasskeyError> {
        gate.admit(Some("tok"), URL, "tok", id, "passkey-get", OPTIONS)
    }

    #[test]
    fn the_shim_gets_the_page_token_and_nothing_else_changes() {
        let script = shim_script("abc123").expect("a plain token fits");
        assert!(script.ends_with("})(\"abc123\");\n"), "{script}");
        assert!(!script.contains(TOKEN_PLACEHOLDER));
        assert_eq!(script.len() + TOKEN_PLACEHOLDER.len(), SHIM.len() + 6 + 2);
        for bad in ["", "a\"b", "a b", "a');alert(1);('", &"a".repeat(65)] {
            assert_eq!(shim_script(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn tokens_are_random_hex() {
        let first = new_token().expect("the system has randomness");
        let second = new_token().expect("the system has randomness");
        assert_eq!(first.len(), TOKEN_BYTES * 2);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert!(shim_script(&first).is_some());
    }

    #[test]
    fn only_https_pages_get_a_shim_and_a_token() {
        let slot = SharedToken::default();
        let script = document_script(URL, &slot).expect("an HTTPS page gets the shim");
        let token = slot.lock().unwrap().clone().expect("and a token");
        assert!(script.contains(&format!("\"{token}\"")));
        // The next page has its own token.
        document_script(URL, &slot).expect("another page");
        assert_ne!(slot.lock().unwrap().clone(), Some(token));
        // A page that is not HTTPS gets neither, and the old token stops working.
        for url in [
            "http://example.com/",
            "about:blank",
            "file:///tmp/a.html",
            "https://user:pw@example.com/",
            "garbage",
        ] {
            assert_eq!(document_script(url, &slot), None, "{url}");
            assert_eq!(*slot.lock().unwrap(), None, "{url}");
        }
    }

    #[test]
    fn parses_messages_and_drops_malformed_ones() {
        let start = parse_message(
            "tok".into(),
            "start",
            "request-1".into(),
            "passkey-get".into(),
            OPTIONS.into(),
        );
        assert_eq!(
            start,
            Some(PasskeyMessage {
                token: "tok".into(),
                op: PasskeyOp::Start {
                    id: "request-1".into(),
                    mode: "passkey-get".into(),
                    options: OPTIONS.into(),
                },
            })
        );
        let abort = parse_message(
            "tok".into(),
            "abort",
            "request-1".into(),
            String::new(),
            String::new(),
        );
        assert_eq!(
            abort.map(|message| message.op),
            Some(PasskeyOp::Abort {
                id: "request-1".into()
            })
        );
        for (op, id) in [
            ("launch", "request-1"),
            ("start", ""),
            ("start", "a\"b"),
            ("start", "a b"),
            ("start", &"x".repeat(ID_MAX_CHARS + 1)),
        ] {
            assert_eq!(
                parse_message("tok".into(), op, id.into(), String::new(), String::new()),
                None,
                "{op} {id:?}"
            );
        }
    }

    #[test]
    fn replies_carry_the_credential_or_the_error_name() {
        assert_eq!(
            reply_script("r-1", &Ok(r#"{"id":"a\"b"}"#.to_owned())),
            r#"window.__CONN_PASSKEY_REPLY__?.("r-1", true, "{\"id\":\"a\\\"b\"}");"#
        );
        for (error, name) in [
            (PasskeyError::NotAllowed, "NotAllowedError"),
            (PasskeyError::InvalidState, "InvalidStateError"),
            (PasskeyError::Security, "SecurityError"),
            (PasskeyError::NotSupported, "NotSupportedError"),
            (PasskeyError::Abort, "AbortError"),
        ] {
            assert_eq!(
                reply_script("r-1", &Err(error)),
                format!("window.__CONN_PASSKEY_REPLY__?.(\"r-1\", false, \"{name}\");")
            );
        }
    }

    #[test]
    fn a_request_from_the_page_goes_to_vault_with_the_browsers_url() {
        let mut gate = PasskeyGate::default();
        let admitted = admit(&mut gate, "r-1").expect("the top frame's request runs");
        assert_eq!(admitted.mode, PasskeyMode::Get);
        assert_eq!(admitted.url, URL);
        assert_eq!(admitted.options, OPTIONS);
        assert!(gate.is_active());
        let create =
            PasskeyGate::default().admit(Some("tok"), URL, "tok", "r-2", "passkey-create", OPTIONS);
        assert_eq!(
            create.map(|admitted| admitted.mode),
            Ok(PasskeyMode::Create)
        );
    }

    #[test]
    fn a_subframe_or_stale_page_is_a_security_error() {
        let mut gate = PasskeyGate::default();
        // The subframe cannot read the token.
        for wrong in ["", "guess", "TOK"] {
            assert_eq!(
                gate.admit(Some("tok"), URL, wrong, "r-1", "passkey-get", OPTIONS),
                Err(PasskeyError::Security),
                "{wrong:?}"
            );
        }
        // A page the browser has no token for (not HTTPS, or none made yet).
        assert_eq!(
            gate.admit(None, URL, "tok", "r-1", "passkey-get", OPTIONS),
            Err(PasskeyError::Security)
        );
        assert!(!gate.is_active(), "nothing started");
    }

    #[test]
    fn a_page_that_is_not_https_is_a_security_error() {
        let mut gate = PasskeyGate::default();
        for url in [
            "http://example.com/",
            "about:blank",
            "https://user:pw@example.com/",
            "",
        ] {
            assert_eq!(
                gate.admit(Some("tok"), url, "tok", "r-1", "passkey-get", OPTIONS),
                Err(PasskeyError::Security),
                "{url:?}"
            );
        }
        let long = format!("https://example.com/{}", "a".repeat(PASSKEY_URL_MAX_BYTES));
        assert_eq!(
            gate.admit(Some("tok"), &long, "tok", "r-1", "passkey-get", OPTIONS),
            Err(PasskeyError::Security)
        );
        assert!(!gate.is_active());
    }

    #[test]
    fn unsupported_requests_are_refused_before_vault() {
        let mut gate = PasskeyGate::default();
        for (mode, options) in [
            ("passkey-delete", OPTIONS),
            ("", OPTIONS),
            ("passkey-get", ""),
        ] {
            assert_eq!(
                gate.admit(Some("tok"), URL, "tok", "r-1", mode, options),
                Err(PasskeyError::NotSupported),
                "{mode:?} {options:?}"
            );
        }
        let big = "x".repeat(PASSKEY_OPTIONS_MAX_BYTES + 1);
        assert_eq!(
            gate.admit(Some("tok"), URL, "tok", "r-1", "passkey-get", &big),
            Err(PasskeyError::NotSupported)
        );
        assert!(!gate.is_active());
    }

    #[test]
    fn a_tab_runs_one_ceremony_at_a_time() {
        let mut gate = PasskeyGate::default();
        admit(&mut gate, "r-1").expect("the first runs");
        assert_eq!(admit(&mut gate, "r-2"), Err(PasskeyError::NotAllowed));
        // The refusal leaves the first alone.
        assert!(gate.is_active());
        assert!(!gate.finish("r-2"));
        assert!(gate.finish("r-1"));
        assert!(!gate.is_active());
        admit(&mut gate, "r-3").expect("a new one runs once the slot is free");
    }

    #[test]
    fn finishing_twice_or_with_another_id_is_stale() {
        let mut gate = PasskeyGate::default();
        admit(&mut gate, "r-1").unwrap();
        assert!(!gate.finish("other"));
        assert!(gate.finish("r-1"));
        assert!(!gate.finish("r-1"));
    }

    #[tokio::test]
    async fn cancelling_stops_the_task_that_waits_for_vault() {
        let mut gate = PasskeyGate::default();
        admit(&mut gate, "r-1").unwrap();
        let task = tokio::spawn(std::future::pending::<()>());
        gate.attach("r-1", task.abort_handle());
        // An abort from a subframe (wrong token) or for another request changes nothing.
        gate.abort(Some("tok"), "guess", "r-1");
        gate.abort(Some("tok"), "tok", "other");
        assert!(gate.is_active());
        assert!(!task.is_finished());
        gate.abort(Some("tok"), "tok", "r-1");
        assert!(!gate.is_active());
        assert!(task.await.unwrap_err().is_cancelled());

        // A new page cancels the live ceremony.
        admit(&mut gate, "r-2").unwrap();
        let task = tokio::spawn(std::future::pending::<()>());
        gate.attach("r-2", task.abort_handle());
        gate.cancel();
        assert!(!gate.is_active());
        assert!(task.await.unwrap_err().is_cancelled());
        // Its answer, if one still comes, is stale.
        assert!(!gate.finish("r-2"));
    }

    #[tokio::test]
    async fn a_task_for_a_ceremony_that_ended_is_stopped_at_once() {
        let mut gate = PasskeyGate::default();
        let task = tokio::spawn(std::future::pending::<()>());
        gate.attach("gone", task.abort_handle());
        assert!(task.await.unwrap_err().is_cancelled());
    }
}
