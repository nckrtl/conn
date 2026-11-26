//! Headless `#[gpui_kit::test]` suite covering Settings › Passwords states:
//! no account, connected, check error, collection selection, save secret clearing,
//! Vault status states, test logins empty/list/add/edit/delete, and Protection toggles.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use conn_contract::{
    SaveTestLoginInput, TestLoginList, TestLoginSecrets, TestLoginSummary,
    TestLoginSummaryCreatedBy, UpdateTestLoginInput,
};
use conn_desktop::vault::{VaultLoginsResponse, VaultLoginsStatus};
use conn_desktop::vaultwarden as vw;
use conn_state::providers::ServerConfigState;
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, Point, TestAppContext, WindowBounds,
    WindowOptions, px, size,
};
use serde_json::{Value, json};

use super::{
    BoxFuture, LocalPasswordsBackend, PasswordsView, SecretsLoad, ServerPasswordsBackend,
    update_test_login_input,
};
use crate::theme::apply_kit_theme;

#[derive(Clone)]
struct FakeLocalBackend {
    status_calls: Arc<AtomicUsize>,
    status_result: Arc<Mutex<Result<Option<vw::Connection>, String>>>,
    check_result: Arc<Mutex<Result<Vec<vw::Collection>, String>>>,
    save_result: Arc<Mutex<Result<vw::Connection, String>>>,
    disconnect_result: Arc<Mutex<Result<(), String>>>,
    vault_result: Arc<Mutex<VaultLoginsResponse>>,
    saved_collection_ids: Arc<Mutex<Vec<String>>>,
}

impl FakeLocalBackend {
    fn new() -> Self {
        Self {
            status_calls: Arc::new(AtomicUsize::new(0)),
            status_result: Arc::new(Mutex::new(Ok(None))),
            check_result: Arc::new(Mutex::new(Ok(Vec::new()))),
            save_result: Arc::new(Mutex::new(Err("not configured".to_owned()))),
            disconnect_result: Arc::new(Mutex::new(Ok(()))),
            vault_result: Arc::new(Mutex::new(VaultLoginsResponse {
                status: VaultLoginsStatus::Ok,
                items: Vec::new(),
                error: None,
            })),
            saved_collection_ids: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl LocalPasswordsBackend for FakeLocalBackend {
    fn vw_status(&self) -> BoxFuture<Result<Option<vw::Connection>, String>> {
        self.status_calls.fetch_add(1, Ordering::SeqCst);
        let res = self.status_result.lock().expect("lock").clone();
        Box::pin(async move { res })
    }

    fn vw_check(&self, _account: vw::Account) -> BoxFuture<Result<Vec<vw::Collection>, String>> {
        let res = self.check_result.lock().expect("lock").clone();
        Box::pin(async move { res })
    }

    fn vw_save(
        &self,
        _account: vw::Account,
        collection: vw::Collection,
    ) -> BoxFuture<Result<vw::Connection, String>> {
        self.saved_collection_ids
            .lock()
            .expect("lock")
            .push(collection.id);
        let res = self.save_result.lock().expect("lock").clone();
        Box::pin(async move { res })
    }

    fn vw_disconnect(&self) -> BoxFuture<Result<(), String>> {
        let res = self.disconnect_result.lock().expect("lock").clone();
        Box::pin(async move { res })
    }

    fn vault_status(&self) -> BoxFuture<VaultLoginsResponse> {
        let res = self.vault_result.lock().expect("lock").clone();
        Box::pin(async move { res })
    }
}

#[derive(Clone)]
struct FakeServerBackend {
    items: Arc<Mutex<Vec<TestLoginSummary>>>,
    reveal_secret: Arc<Mutex<TestLoginSecrets>>,
    autofill_patches: Arc<Mutex<Vec<Value>>>,
    autofill_error: Arc<Mutex<Option<String>>>,
    last_update: Arc<Mutex<Option<UpdateTestLoginInput>>>,
    update_calls: Arc<AtomicUsize>,
    /// When set, the next reveal waits for this answer.
    reveal_gate:
        Arc<Mutex<Option<futures::channel::oneshot::Receiver<Result<TestLoginSecrets, String>>>>>,
}

impl FakeServerBackend {
    fn new(items: Vec<TestLoginSummary>) -> Self {
        Self {
            items: Arc::new(Mutex::new(items)),
            reveal_secret: Arc::new(Mutex::new(TestLoginSecrets {
                password: "revealed-password".to_owned(),
                otp_secret: Some("JBSWY3DPEHPK3PXP".to_owned()),
            })),
            autofill_patches: Arc::new(Mutex::new(Vec::new())),
            autofill_error: Arc::new(Mutex::new(None)),
            last_update: Arc::new(Mutex::new(None)),
            update_calls: Arc::new(AtomicUsize::new(0)),
            reveal_gate: Arc::new(Mutex::new(None)),
        }
    }

    /// Makes the next reveal wait; the returned sender answers it.
    fn hold_reveal(&self) -> futures::channel::oneshot::Sender<Result<TestLoginSecrets, String>> {
        let (tx, rx) = futures::channel::oneshot::channel();
        *self.reveal_gate.lock().expect("lock") = Some(rx);
        tx
    }
}

impl ServerPasswordsBackend for FakeServerBackend {
    fn list_test_logins(&self) -> BoxFuture<Result<TestLoginList, String>> {
        let items = self.items.lock().expect("lock").clone();
        Box::pin(async move { Ok(TestLoginList { items }) })
    }

    fn save_test_login(
        &self,
        input: SaveTestLoginInput,
    ) -> BoxFuture<Result<TestLoginSummary, String>> {
        let summary = TestLoginSummary {
            id: "login-new".to_owned(),
            label: input.label.unwrap_or_default(),
            url: input.url,
            username: input.username,
            has_otp: input.otp_secret.is_some(),
            created_at: "2026-11-25T12:00:00Z".to_owned(),
            created_by: TestLoginSummaryCreatedBy::User,
        };
        self.items.lock().expect("lock").push(summary.clone());
        Box::pin(async move { Ok(summary) })
    }

    fn update_test_login(
        &self,
        input: UpdateTestLoginInput,
    ) -> BoxFuture<Result<TestLoginSummary, String>> {
        self.update_calls.fetch_add(1, Ordering::SeqCst);
        *self.last_update.lock().expect("lock") = Some(input.clone());
        let mut items = self.items.lock().expect("lock");
        let Some(existing) = items.iter_mut().find(|item| item.id == input.id) else {
            return Box::pin(async move { Err("Test login not found".to_owned()) });
        };
        if let Some(url) = input.url {
            existing.url = url;
        }
        if let Some(username) = input.username {
            existing.username = username;
        }
        if let Some(label) = input.label {
            existing.label = label;
        }
        if let Some(otp) = input.otp_secret {
            existing.has_otp = otp.is_some();
        }
        let updated = existing.clone();
        Box::pin(async move { Ok(updated) })
    }

    fn remove_test_login(&self, id: String) -> BoxFuture<Result<(), String>> {
        self.items
            .lock()
            .expect("lock")
            .retain(|item| item.id != id);
        Box::pin(async move { Ok(()) })
    }

    fn reveal_test_login(&self, _id: String) -> BoxFuture<Result<TestLoginSecrets, String>> {
        if let Some(gate) = self.reveal_gate.lock().expect("lock").take() {
            return Box::pin(
                async move { gate.await.unwrap_or_else(|_| Err("cancelled".to_owned())) },
            );
        }
        let secrets = self.reveal_secret.lock().expect("lock").clone();
        Box::pin(async move { Ok(secrets) })
    }

    fn update_credential_autofill(&self, patch: Value) -> BoxFuture<Result<(), String>> {
        self.autofill_patches.lock().expect("lock").push(patch);
        let err = self.autofill_error.lock().expect("lock").clone();
        Box::pin(async move {
            match err {
                Some(message) => Err(message),
                None => Ok(()),
            }
        })
    }
}

fn config_with_autofill(block_scripts: bool, allow_subdomains: bool) -> Arc<ServerConfigState> {
    let mut snapshot: Value = serde_json::from_str(include_str!(
        "../../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
    ))
    .expect("fixture is JSON");
    snapshot["config"]["settings"]["credentialAutofill"] = json!({
        "oneApprovalPerSignIn": false,
        "approvalTimeoutSeconds": 90,
        "blockScriptsAfterFill": block_scripts,
        "allowSubdomains": allow_subdomains,
    });
    let mut state = ServerConfigState::new();
    state.apply(serde_json::from_value(snapshot).expect("snapshot event"));
    Arc::new(state)
}

fn init(cx: &mut gpui_kit::App) -> Tokens {
    gpui_kit::init(cx);
    let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
    let tokens = Tokens::derive(&theme);
    apply_kit_theme(&tokens, cx);
    tokens
}

fn tall_window() -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            Point::default(),
            size(px(1200.0), px(2400.0)),
        ))),
        ..Default::default()
    }
}

fn mount(
    cx: &mut TestAppContext,
    local: Arc<FakeLocalBackend>,
    server: Option<Arc<FakeServerBackend>>,
) -> (AnyWindowHandle, Entity<PasswordsView>) {
    cx.update(|cx| {
        let tokens = init(cx);
        let server_dyn: Option<Arc<dyn ServerPasswordsBackend>> =
            server.map(|s| s as Arc<dyn ServerPasswordsBackend>);
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|_| {
                PasswordsView::with_backends(tokens, ShellGeometry::default(), local, server_dyn)
            })
        })
        .expect("window opens")
    })
}

fn has(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.try_find_by_label(label).is_some()
    })
    .unwrap_or(false)
}

fn sample_connection() -> vw::Connection {
    vw::Connection {
        email: "conn-bot@example.com".to_owned(),
        server: "https://vault.orbit".to_owned(),
        collection: vw::Collection {
            id: "col-1".to_owned(),
            organization_id: "org-1".to_owned(),
            name: "Conn".to_owned(),
            organization_name: "Acme".to_owned(),
        },
    }
}

#[gpui_kit::test]
fn no_account_state_and_status_called_only_on_open(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    let (window, view) = mount(cx, Arc::clone(&local), None);

    // Background config/token updates must never invoke vaultwarden::status().
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.set_server_config(config_with_autofill(true, false), cx);
        });
    });
    cx.run_until_parked();
    assert_eq!(
        local.status_calls.load(Ordering::SeqCst),
        0,
        "status() must not run before opening Passwords"
    );

    cx.update(|cx| {
        view.update(cx, |view, cx| view.on_open(cx));
    });
    cx.run_until_parked();
    assert_eq!(
        local.status_calls.load(Ordering::SeqCst),
        1,
        "opening Passwords calls status() once"
    );

    assert!(
        has(cx, window, "Dedicated Conn account"),
        "shows unconfigured Vaultwarden title"
    );
    assert!(has(cx, window, "Connect"), "shows Connect button");
    assert!(
        !has(cx, window, "Disconnect"),
        "hides Disconnect when disconnected"
    );
    assert!(
        has(cx, window, "Vault \u{00b7} this Mac"),
        "shows Vault provider row"
    );
    assert!(
        has(cx, window, "Check connection"),
        "shows Vault check button"
    );
    assert!(has(cx, window, "Test logins"), "shows Test logins section");
    assert!(
        !has(cx, window, "Add test login"),
        "hides Add test login when no environment is connected"
    );
    assert!(
        has(cx, window, "Hide passwords from page reads"),
        "shows always-on redaction row"
    );
    assert!(
        has(cx, window, "Block agent scripts after a fill"),
        "shows block scripts row"
    );
    assert!(
        has(cx, window, "Fill on subdomains of a saved site"),
        "shows subdomains row"
    );
}

#[gpui_kit::test]
fn connected_vaultwarden_shows_connection_and_disconnects(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    *local.status_result.lock().expect("lock") = Ok(Some(sample_connection()));
    let (window, view) = mount(cx, Arc::clone(&local), None);

    cx.update(|cx| {
        view.update(cx, |view, cx| view.on_open(cx));
    });
    cx.run_until_parked();

    assert!(
        has(cx, window, "Acme / Conn"),
        "shows connected org and collection"
    );
    assert!(
        has(cx, window, "Replace connection"),
        "shows Replace connection button"
    );
    assert!(has(cx, window, "Disconnect"), "shows Disconnect button");

    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.disconnect_vaultwarden(window, cx));
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        has(cx, window, "Dedicated Conn account"),
        "returns to disconnected title"
    );
    assert!(
        has(cx, window, "Connect"),
        "returns to Connect button after disconnect"
    );
    assert!(
        !has(cx, window, "Disconnect"),
        "hides Disconnect after disconnect"
    );
    assert!(
        has(
            cx,
            window,
            "Local connection removed. Your Vaultwarden account and items were kept."
        ),
        "shows disconnect confirmation notice"
    );
}

#[gpui_kit::test]
fn vaultwarden_check_error_then_collection_pick_and_save_clears_form(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    *local.check_result.lock().expect("lock") =
        Err("Invalid API key or master password.".to_owned());
    let (window, view) = mount(cx, Arc::clone(&local), None);

    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    cx.run_until_parked();

    // Open form and populate fields.
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.open_vaultwarden_form(window, cx);
            let form = view.vw_form.as_ref().expect("form open");
            form.client_id
                .update(cx, |s, cx| s.set_value("user.123".to_owned(), window, cx));
            form.client_secret.update(cx, |s, cx| {
                s.set_value("secret-fixture".to_owned(), window, cx)
            });
            form.master_password.update(cx, |s, cx| {
                s.set_value("master-fixture".to_owned(), window, cx)
            });
        });
    })
    .expect("window");

    assert!(
        has(cx, window, "Check account"),
        "shows Check account button"
    );
    assert!(has(cx, window, "Cancel"), "shows Cancel button");

    // First check fails -> shows user-safe error.
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.submit_vaultwarden(false, window, cx));
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        has(cx, window, "Invalid API key or master password."),
        "shows user-safe check error"
    );
    assert!(
        has(cx, window, "Check account"),
        "keeps Check account after error"
    );

    // Second check succeeds with 2 collections -> requires explicit selection.
    let col_a = vw::Collection {
        id: "col-a".to_owned(),
        organization_id: "org-1".to_owned(),
        name: "Alpha".to_owned(),
        organization_name: "Acme".to_owned(),
    };
    let col_b = vw::Collection {
        id: "col-b".to_owned(),
        organization_id: "org-1".to_owned(),
        name: "Staging".to_owned(),
        organization_name: "Acme".to_owned(),
    };
    *local.check_result.lock().expect("lock") = Ok(vec![col_a, col_b.clone()]);
    *local.save_result.lock().expect("lock") = Ok(vw::Connection {
        email: "conn-bot@example.com".to_owned(),
        server: "https://vault.orbit".to_owned(),
        collection: col_b,
    });

    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.submit_vaultwarden(false, window, cx));
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        has(cx, window, "Choose a collection"),
        "shows collection picker placeholder"
    );
    assert!(
        has(cx, window, "Check account"),
        "save label waits until a collection is selected"
    );

    // Pick Staging -> submit button becomes Save connection.
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            if let Some(form) = &mut view.vw_form {
                form.selected_collection_id = Some("col-b".to_owned());
            }
            cx.notify();
        });
    });
    assert!(
        has(cx, window, "Acme / Staging"),
        "shows chosen collection in picker"
    );
    assert!(
        has(cx, window, "Save connection"),
        "switches submit label to Save connection"
    );

    // Save connection -> clears form (and secrets) and displays connected status.
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.submit_vaultwarden(true, window, cx));
    })
    .expect("window");
    cx.run_until_parked();

    assert_eq!(
        local.saved_collection_ids.lock().expect("lock").as_slice(),
        &["col-b"],
        "saves the chosen collection"
    );
    assert!(
        cx.update(|cx| view.read(cx).vw_form.is_none()),
        "form and secrets are cleared after save"
    );
    assert!(
        has(cx, window, "Acme / Staging"),
        "shows saved connection summary"
    );
    assert!(
        has(cx, window, "Replace connection"),
        "shows Replace connection after save"
    );
    assert!(
        has(
            cx,
            window,
            "Connection saved on this Mac. Browser and agent credential routing is not enabled yet."
        ),
        "shows saved confirmation notice"
    );
}

#[gpui_kit::test]
fn test_logins_empty_add_list_edit_and_delete(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    let server = Arc::new(FakeServerBackend::new(Vec::new()));
    let (window, view) = mount(cx, Arc::clone(&local), Some(Arc::clone(&server)));

    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    cx.run_until_parked();

    assert!(
        has(cx, window, "Add test login"),
        "shows Add test login when connected"
    );
    assert!(
        has(cx, window, "No test logins yet"),
        "shows empty test logins state"
    );

    // Open Add dialog, fill fields, submit.
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.open_test_login_dialog(None, window, cx);
            let dialog = view.test_login_dialog.as_ref().expect("dialog open");
            dialog.url.update(cx, |s, cx| {
                s.set_value("http://myapp.test/login".to_owned(), window, cx)
            });
            dialog.username.update(cx, |s, cx| {
                s.set_value("admin@myapp.test".to_owned(), window, cx)
            });
            dialog
                .password
                .update(cx, |s, cx| s.set_value("test-pass".to_owned(), window, cx));
            dialog
                .label
                .update(cx, |s, cx| s.set_value("Admin".to_owned(), window, cx));
        });
    })
    .expect("window");

    assert!(
        has(cx, window, "Save a test login"),
        "shows add dialog title"
    );
    assert!(
        has(cx, window, "Save test login"),
        "shows add dialog submit button"
    );

    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.submit_test_login(window, cx));
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        cx.update(|cx| !view.read(cx).has_open_dialog()),
        "dialog closes after save"
    );
    assert!(has(cx, window, "Admin"), "lists saved test login");
    assert!(has(cx, window, "Edit Admin"), "shows Edit action");
    assert!(has(cx, window, "Delete Admin"), "shows Delete action");
    assert!(
        has(cx, window, "Test login saved"),
        "shows saved notice after adding"
    );

    // Open Edit dialog -> reveals stored secrets and updates.
    let existing = server.items.lock().expect("lock")[0].clone();
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.open_test_login_dialog(Some(existing), window, cx);
        });
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        has(cx, window, "Edit test login"),
        "shows edit dialog title"
    );
    assert!(has(cx, window, "Save changes"), "shows Save changes button");
    let (revealed_pw, revealed_otp) = cx.update(|cx| {
        let dialog = view.read(cx).test_login_dialog.as_ref().expect("dialog");
        (
            dialog.password.read(cx).value().to_string(),
            dialog.otp_secret.read(cx).value().to_string(),
        )
    });
    assert_eq!(
        revealed_pw, "revealed-password",
        "edit dialog reveals password"
    );
    assert_eq!(
        revealed_otp, "JBSWY3DPEHPK3PXP",
        "edit dialog reveals OTP secret"
    );

    // Clear OTP and save changes -> sends otp_secret: Some(None).
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            let dialog = view.test_login_dialog.as_ref().expect("dialog");
            dialog
                .otp_secret
                .update(cx, |s, cx| s.set_value(String::new(), window, cx));
            view.submit_test_login(window, cx);
        });
    })
    .expect("window");
    cx.run_until_parked();

    let update_payload = server
        .last_update
        .lock()
        .expect("lock")
        .clone()
        .expect("update sent");
    assert_eq!(
        update_payload.otp_secret,
        Some(None),
        "clearing OTP sends explicit null"
    );
    assert!(
        has(cx, window, "Test login updated"),
        "shows updated notice after edit"
    );

    // Delete test login -> list returns to empty state.
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.delete_test_login("login-new".to_owned(), cx);
        });
    });
    cx.run_until_parked();
    assert!(
        has(cx, window, "No test logins yet"),
        "returns to empty state after delete"
    );
}

fn stored_login() -> TestLoginSummary {
    TestLoginSummary {
        id: "login-1".to_owned(),
        label: "Admin".to_owned(),
        url: "http://myapp.test/login".to_owned(),
        username: "admin@myapp.test".to_owned(),
        has_otp: true,
        created_at: "2026-11-25T12:00:00Z".to_owned(),
        created_by: TestLoginSummaryCreatedBy::User,
    }
}

fn open_edit_dialog(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    view: &Entity<PasswordsView>,
    login: TestLoginSummary,
) {
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.open_test_login_dialog(Some(login), window, cx);
        });
    })
    .expect("window");
    cx.run_until_parked();
}

fn submit(cx: &mut TestAppContext, window: AnyWindowHandle, view: &Entity<PasswordsView>) {
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.submit_test_login(window, cx));
    })
    .expect("window");
    cx.run_until_parked();
}

/// Save before the stored password has loaded must not blank the stored password and OTP: Save
/// is off until the reveal answers, then it sends what the reveal loaded.
#[gpui_kit::test]
fn edit_dialog_save_waits_for_the_reveal(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    let server = Arc::new(FakeServerBackend::new(vec![stored_login()]));
    let (window, view) = mount(cx, Arc::clone(&local), Some(Arc::clone(&server)));
    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    cx.run_until_parked();

    let reveal = server.hold_reveal();
    open_edit_dialog(cx, window, &view, stored_login());
    assert_eq!(
        cx.update(|cx| view.read(cx).test_login_dialog.as_ref().map(|d| d.secrets)),
        Some(SecretsLoad::Loading)
    );

    // Save while the reveal is pending: nothing is sent, the dialog stays open and idle.
    submit(cx, window, &view);
    assert_eq!(
        server.update_calls.load(Ordering::SeqCst),
        0,
        "Save sent an update before the reveal"
    );
    assert!(cx.update(|cx| view.read(cx).has_open_dialog()));
    assert!(
        cx.update(|cx| !view
            .read(cx)
            .test_login_dialog
            .as_ref()
            .expect("dialog")
            .saving),
        "the dialog is not stuck saving"
    );

    reveal
        .send(Ok(TestLoginSecrets {
            password: "revealed-password".to_owned(),
            otp_secret: Some("JBSWY3DPEHPK3PXP".to_owned()),
        }))
        .expect("the reveal is waiting");
    cx.run_until_parked();
    submit(cx, window, &view);
    let sent = server
        .last_update
        .lock()
        .expect("lock")
        .clone()
        .expect("update sent");
    assert_eq!(sent.password.as_deref(), Some("revealed-password"));
    assert_eq!(sent.otp_secret, Some(Some("JBSWY3DPEHPK3PXP".to_owned())));
}

/// A reveal that fails never sends empty password or OTP values: they stay out of the update, and
/// anything the user types still goes.
#[gpui_kit::test]
fn edit_dialog_after_a_failed_reveal_never_overwrites_the_secrets(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    let server = Arc::new(FakeServerBackend::new(vec![stored_login()]));
    let (window, view) = mount(cx, Arc::clone(&local), Some(Arc::clone(&server)));
    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    cx.run_until_parked();

    let reveal = server.hold_reveal();
    open_edit_dialog(cx, window, &view, stored_login());
    reveal
        .send(Err("vault locked".to_owned()))
        .expect("the reveal is waiting");
    cx.run_until_parked();
    assert_eq!(
        cx.update(|cx| view.read(cx).test_login_dialog.as_ref().map(|d| d.secrets)),
        Some(SecretsLoad::Failed)
    );
    assert!(has(cx, window, "Edit test login"));

    // Change only the label.
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            let dialog = view.test_login_dialog.as_ref().expect("dialog");
            dialog
                .label
                .update(cx, |s, cx| s.set_value("Admin 2".to_owned(), window, cx));
        });
    })
    .expect("window");
    submit(cx, window, &view);
    let sent = server
        .last_update
        .lock()
        .expect("lock")
        .clone()
        .expect("update sent");
    assert_eq!(sent.label.as_deref(), Some("Admin 2"));
    assert_eq!(sent.password, None, "an unloaded password is not sent");
    assert_eq!(sent.otp_secret, None, "an unloaded OTP secret is not sent");
}

#[test]
fn the_update_leaves_out_secrets_that_never_loaded() {
    let input = |password: &str, otp: &str, secrets| {
        update_test_login_input(
            "id".into(),
            "http://a.test".into(),
            "u".into(),
            "l".into(),
            password.into(),
            otp.into(),
            secrets,
        )
    };
    // Loaded: the fields are the stored values, and an emptied OTP clears it.
    let loaded = input("pw", "", SecretsLoad::Loaded);
    assert_eq!(loaded.password.as_deref(), Some("pw"));
    assert_eq!(loaded.otp_secret, Some(None));
    let loaded = input("pw", "JBSW", SecretsLoad::Loaded);
    assert_eq!(loaded.otp_secret, Some(Some("JBSW".to_owned())));
    // Failed reveal: empty means never loaded, so nothing is sent for it.
    let failed = input("", "", SecretsLoad::Failed);
    assert_eq!((failed.password, failed.otp_secret), (None, None));
    // Failed reveal with new values typed: those go.
    let typed = input("new-pw", "NEWOTP", SecretsLoad::Failed);
    assert_eq!(typed.password.as_deref(), Some("new-pw"));
    assert_eq!(typed.otp_secret, Some(Some("NEWOTP".to_owned())));
}

#[gpui_kit::test]
fn protection_toggles_read_server_config_and_send_patches(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    let server = Arc::new(FakeServerBackend::new(Vec::new()));
    let (window, view) = mount(cx, Arc::clone(&local), Some(Arc::clone(&server)));

    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.set_server_config(config_with_autofill(true, false), cx);
            view.on_open(cx);
        });
    });
    cx.run_until_parked();

    assert!(
        cx.update(|cx| view.read(cx).block_scripts_after_fill),
        "blockScriptsAfterFill reads true from server config"
    );
    assert!(
        cx.update(|cx| !view.read(cx).allow_subdomains),
        "allowSubdomains reads false from server config"
    );
    assert!(
        has(cx, window, "Hide passwords from page reads"),
        "renders always-on redaction switch"
    );
    assert!(
        has(cx, window, "Block agent scripts after a fill"),
        "renders block scripts switch"
    );
    assert!(
        has(cx, window, "Fill on subdomains of a saved site"),
        "renders subdomains switch"
    );

    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.toggle_block_scripts_after_fill(cx);
        });
    });
    cx.run_until_parked();
    assert!(
        cx.update(|cx| !view.read(cx).block_scripts_after_fill),
        "blockScriptsAfterFill toggles off"
    );

    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.toggle_allow_subdomains(cx);
        });
    });
    cx.run_until_parked();
    assert!(
        cx.update(|cx| view.read(cx).allow_subdomains),
        "allowSubdomains toggles on"
    );

    let patches = server.autofill_patches.lock().expect("lock").clone();
    assert_eq!(
        patches,
        vec![
            json!({ "blockScriptsAfterFill": false }),
            json!({ "allowSubdomains": true }),
        ],
        "toggles emit credentialAutofill patches"
    );

    // Server error reverts the toggle and surfaces the error message.
    *server.autofill_error.lock().expect("lock") = Some("Permission denied".to_owned());
    cx.update(|cx| {
        view.update(cx, |view, cx| {
            view.toggle_allow_subdomains(cx);
        });
    });
    cx.run_until_parked();
    assert!(
        cx.update(|cx| view.read(cx).allow_subdomains),
        "failed write reverts local state"
    );
    assert!(
        has(cx, window, "Permission denied"),
        "surfaces server update error"
    );
}

#[gpui_kit::test]
fn vault_provider_row_covers_ok_locked_unavailable_and_recheck(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    *local.vault_result.lock().expect("lock") = VaultLoginsResponse {
        status: VaultLoginsStatus::Locked,
        items: Vec::new(),
        error: None,
    };
    let (window, view) = mount(cx, Arc::clone(&local), None);

    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    cx.run_until_parked();
    assert!(
        has(cx, window, "Vault \u{00b7} this Mac"),
        "renders Vault row"
    );
    assert!(
        cx.update(|cx| {
            view.read(cx)
                .vault_state
                .as_ref()
                .is_some_and(|s| s.status == VaultLoginsStatus::Locked)
        }),
        "captures locked status"
    );

    *local.vault_result.lock().expect("lock") = VaultLoginsResponse {
        status: VaultLoginsStatus::Unavailable,
        items: Vec::new(),
        error: Some("Vault is not installed on this Mac.".to_owned()),
    };
    cx.update(|cx| view.update(cx, |view, cx| view.check_vault_status(cx)));
    cx.run_until_parked();
    assert!(
        cx.update(|cx| {
            view.read(cx)
                .vault_state
                .as_ref()
                .is_some_and(|s| s.status == VaultLoginsStatus::Unavailable)
        }),
        "captures unavailable status"
    );

    *local.vault_result.lock().expect("lock") = VaultLoginsResponse {
        status: VaultLoginsStatus::Ok,
        items: Vec::new(),
        error: None,
    };
    cx.update(|cx| view.update(cx, |view, cx| view.check_vault_status(cx)));
    cx.run_until_parked();
    assert!(
        cx.update(|cx| {
            view.read(cx)
                .vault_state
                .as_ref()
                .is_some_and(|s| s.status == VaultLoginsStatus::Ok)
        }),
        "captures ok status"
    );
}

/// Local backend whose Vault check runs the real `VaultClient` and `crate::live::RT` path
/// against a fake `--conn-bridge` binary. Vaultwarden calls stay on the in-memory fake.
struct BridgeVaultBackend {
    base: FakeLocalBackend,
    client: conn_desktop::vault::VaultClient,
}

impl LocalPasswordsBackend for BridgeVaultBackend {
    fn vw_status(&self) -> BoxFuture<Result<Option<vw::Connection>, String>> {
        self.base.vw_status()
    }

    fn vw_check(&self, account: vw::Account) -> BoxFuture<Result<Vec<vw::Collection>, String>> {
        self.base.vw_check(account)
    }

    fn vw_save(
        &self,
        account: vw::Account,
        collection: vw::Collection,
    ) -> BoxFuture<Result<vw::Connection, String>> {
        self.base.vw_save(account, collection)
    }

    fn vw_disconnect(&self) -> BoxFuture<Result<(), String>> {
        self.base.vw_disconnect()
    }

    fn vault_status(&self) -> BoxFuture<VaultLoginsResponse> {
        super::vault_status_via(self.client.clone())
    }
}

/// A fake Vault relay: reads one framed request, replies `locked` for the login `status`
/// request after a short delay, then keeps its pipes open like the real relay.
const LOCKED_RELAY: &str = r#"#!/usr/bin/env python3
import json, struct, sys, time

raw_len = sys.stdin.buffer.read(4)
size = struct.unpack("<I", raw_len)[0]
req = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
time.sleep(0.3)
body = json.dumps({"id": req["id"], "status": "locked"}).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
time.sleep(60)
"#;

/// "Check connection" is clickable exactly when no Vault check is running.
fn vault_check_enabled(cx: &mut TestAppContext, view: &Entity<PasswordsView>) -> bool {
    cx.update(|cx| !view.read(cx).vault_busy)
}

/// Regression: a Vault bridge that answers `locked` must clear "Checking Vault…", show the locked
/// copy, and re-enable "Check connection" even though the reply arrives after the page rendered.
#[gpui_kit::test]
async fn vault_row_leaves_checking_state_when_the_bridge_answers_locked(cx: &mut TestAppContext) {
    use std::os::unix::fs::PermissionsExt as _;

    cx.executor().allow_parking();
    let dir = tempfile::tempdir().expect("temp dir");
    let bin = dir.path().join("fake-vault");
    std::fs::write(&bin, LOCKED_RELAY).expect("write fake relay");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let local = Arc::new(BridgeVaultBackend {
        base: FakeLocalBackend::new(),
        client: conn_desktop::vault::VaultClient::with_binary(&bin)
            .with_timeout(std::time::Duration::from_secs(20)),
    });
    let (window, view) = cx.update(|cx| {
        let tokens = init(cx);
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|_| PasswordsView::with_backends(tokens, ShellGeometry::default(), local, None))
        })
        .expect("window opens")
    });

    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    assert_eq!(
        cx.update(|cx| view.read(cx).vault_description()),
        "Checking Vault\u{2026}",
        "shows the checking state while Vault answers"
    );
    assert!(
        !vault_check_enabled(cx, &view),
        "button is disabled while checking"
    );

    let started = std::time::Instant::now();
    while cx.update(|cx| view.read(cx).vault_busy) && started.elapsed().as_secs() < 10 {
        cx.run_until_parked();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    cx.run_until_parked();

    assert!(
        !cx.update(|cx| view.read(cx).vault_busy),
        "busy state clears once the bridge replied"
    );
    assert_eq!(
        cx.update(|cx| view.read(cx).vault_description()),
        "Vault is locked. Unlock it from the browser\u{2019}s saved-login menu.",
        "shows the locked description"
    );
    assert!(
        has(cx, window, "Vault \u{00b7} this Mac"),
        "row still renders"
    );
    assert!(
        vault_check_enabled(cx, &view),
        "Check connection is enabled again"
    );
}

/// Reopening the page (or clicking its sidebar entry again) while a Vault check is still waiting
/// replaces the running check. The replacement must still finish and clear the busy state.
#[gpui_kit::test]
async fn reopening_the_page_mid_check_still_clears_the_vault_row(cx: &mut TestAppContext) {
    use std::os::unix::fs::PermissionsExt as _;

    cx.executor().allow_parking();
    let dir = tempfile::tempdir().expect("temp dir");
    let bin = dir.path().join("fake-vault");
    std::fs::write(&bin, LOCKED_RELAY).expect("write fake relay");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let local = Arc::new(BridgeVaultBackend {
        base: FakeLocalBackend::new(),
        client: conn_desktop::vault::VaultClient::with_binary(&bin)
            .with_timeout(std::time::Duration::from_secs(20)),
    });
    let (_window, view) = cx.update(|cx| {
        let tokens = init(cx);
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|_| PasswordsView::with_backends(tokens, ShellGeometry::default(), local, None))
        })
        .expect("window opens")
    });

    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    cx.run_until_parked();
    std::thread::sleep(std::time::Duration::from_millis(100));
    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));

    let started = std::time::Instant::now();
    while cx.update(|cx| view.read(cx).vault_busy) && started.elapsed().as_secs() < 10 {
        cx.run_until_parked();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    cx.run_until_parked();
    assert!(
        !cx.update(|cx| view.read(cx).vault_busy),
        "the replacement check clears the busy state"
    );
    assert_eq!(
        cx.update(|cx| view.read(cx).vault_description()),
        "Vault is locked. Unlock it from the browser\u{2019}s saved-login menu."
    );
}

/// A relay that never answers must not leave the row on "Checking Vault…" with a dead button:
/// the check ends in the error copy and "Check connection" works again.
#[gpui_kit::test]
async fn silent_vault_bridge_ends_in_an_error_and_a_working_button(cx: &mut TestAppContext) {
    use std::os::unix::fs::PermissionsExt as _;

    cx.executor().allow_parking();
    let dir = tempfile::tempdir().expect("temp dir");
    let bin = dir.path().join("fake-vault");
    std::fs::write(
        &bin,
        "#!/usr/bin/env python3\nimport sys, time\nsys.stdin.buffer.read(4)\ntime.sleep(60)\n",
    )
    .expect("write fake relay");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let local = Arc::new(BridgeVaultBackend {
        base: FakeLocalBackend::new(),
        client: conn_desktop::vault::VaultClient::with_binary(&bin)
            .with_timeout(std::time::Duration::from_millis(400)),
    });
    let (_window, view) = cx.update(|cx| {
        let tokens = init(cx);
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|_| PasswordsView::with_backends(tokens, ShellGeometry::default(), local, None))
        })
        .expect("window opens")
    });

    cx.update(|cx| view.update(cx, |view, cx| view.on_open(cx)));
    assert!(!vault_check_enabled(cx, &view), "disabled while checking");

    let started = std::time::Instant::now();
    while cx.update(|cx| view.read(cx).vault_busy) && started.elapsed().as_secs() < 10 {
        cx.run_until_parked();
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    cx.run_until_parked();
    assert!(vault_check_enabled(cx, &view), "button works again");
    assert_eq!(
        cx.update(|cx| view.read(cx).vault_description()),
        "Vault could not answer. Open or update Vault and try again."
    );
}

#[gpui_kit::test]
fn vaultwarden_zero_and_single_collection_check_edges(cx: &mut TestAppContext) {
    let local = Arc::new(FakeLocalBackend::new());
    *local.check_result.lock().expect("lock") = Ok(Vec::new());
    let (window, view) = mount(cx, Arc::clone(&local), None);

    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| {
            view.open_vaultwarden_form(window, cx);
            let form = view.vw_form.as_ref().expect("form");
            form.client_id
                .update(cx, |s, cx| s.set_value("user.1".to_owned(), window, cx));
            form.client_secret
                .update(cx, |s, cx| s.set_value("sec".to_owned(), window, cx));
            form.master_password
                .update(cx, |s, cx| s.set_value("pw".to_owned(), window, cx));
            view.submit_vaultwarden(false, window, cx);
        });
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        has(
            cx,
            window,
            "No writable collections found. Create the organization and collection, or confirm this account's membership, then check again."
        ),
        "shows empty writable collections guidance"
    );

    // Single collection auto-selects and switches primary button directly to Save connection.
    *local.check_result.lock().expect("lock") = Ok(vec![vw::Collection {
        id: "col-only".to_owned(),
        organization_id: "org-1".to_owned(),
        name: "Only".to_owned(),
        organization_name: "Acme".to_owned(),
    }]);
    cx.update_window(window, |_, window, cx| {
        view.update(cx, |view, cx| view.submit_vaultwarden(false, window, cx));
    })
    .expect("window");
    cx.run_until_parked();

    assert!(
        has(cx, window, "Acme / Only"),
        "auto-selects sole collection"
    );
    assert!(
        has(cx, window, "Save connection"),
        "enables Save connection immediately for sole collection"
    );
}

#[gpui_kit::test]
fn settings_modal_nav_and_search_include_passwords(cx: &mut TestAppContext) {
    use crate::orbit_sync::OrbitSettingsInfo;
    use crate::settings::{SettingsConnectionInfo, SettingsModal, SettingsPage};

    let local = Arc::new(FakeLocalBackend::new());
    let local_for_modal = Arc::clone(&local);
    let (window, modal) = cx.update(|cx| {
        let tokens = init(cx);
        gpui_kit::open_window(tall_window(), cx, |window, cx| {
            window.activate_window();
            cx.new(|cx| {
                let mut modal = SettingsModal::new(
                    "dark-ocean",
                    tokens.clone(),
                    false,
                    false,
                    SettingsConnectionInfo::default(),
                    None,
                    Vec::new(),
                    (None, String::new()),
                    OrbitSettingsInfo::default(),
                    &[],
                    window,
                    cx,
                );
                // Replace the live local backend with a fake so tests never touch Keychain or Vault.
                modal.passwords = cx.new(|_| {
                    PasswordsView::with_backends(
                        tokens,
                        ShellGeometry::default(),
                        local_for_modal,
                        None,
                    )
                });
                modal
            })
        })
        .expect("window opens")
    });

    assert!(
        has(cx, window, "Passwords"),
        "Settings nav includes Passwords tab"
    );
    assert_eq!(
        local.status_calls.load(Ordering::SeqCst),
        0,
        "opening Settings on Appearance does not call vaultwarden::status()"
    );

    // Searching for Passwords terms surfaces the Passwords sections.
    cx.update_window(window, |_, window, cx| {
        modal.update(cx, |m, cx| {
            m.search_input.update(cx, |s, cx| {
                s.set_value("vaultwarden".to_owned(), window, cx)
            });
        });
    })
    .expect("window");
    assert!(
        has(cx, window, "Dedicated Conn account"),
        "search surfaces Vaultwarden section"
    );
    assert!(
        has(cx, window, "Hide passwords from page reads"),
        "search surfaces Protection section"
    );
    assert_eq!(
        local.status_calls.load(Ordering::SeqCst),
        0,
        "searching does not trigger background vaultwarden::status()"
    );

    // Clearing search and selecting Passwords opens the Passwords page and reads status once.
    cx.update_window(window, |_, window, cx| {
        modal.update(cx, |m, cx| {
            m.search_input
                .update(cx, |s, cx| s.set_value(String::new(), window, cx));
            m.select_page(SettingsPage::Passwords, cx);
        });
    })
    .expect("window");
    cx.run_until_parked();
    assert_eq!(
        local.status_calls.load(Ordering::SeqCst),
        1,
        "selecting Passwords calls vaultwarden::status() once"
    );
    assert!(
        has(cx, window, "Vault \u{00b7} this Mac"),
        "Passwords page renders Password manager row"
    );
    assert!(
        has(cx, window, "Hide passwords from page reads"),
        "Passwords page renders Protection switch"
    );
}
