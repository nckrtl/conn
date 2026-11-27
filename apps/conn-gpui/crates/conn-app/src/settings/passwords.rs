//! Settings › Passwords page ported 1:1 from Conn web:
//! `PasswordsSettings.tsx`, `VaultwardenSettings.tsx`, `VaultProviderRow.tsx`,
//! and `TestLoginDialog.tsx`.
//!
//! Four sections:
//! 1. `Vaultwarden · this Mac`: dedicated local account connect / check / collection pick /
//!    save / replace / disconnect via `conn_desktop::vaultwarden`. `status()` is called only
//!    when the user opens the Passwords page, never on background refresh. Secret fields are
//!    never logged or persisted and are cleared from the form after save or close.
//! 2. `Password manager`: Mac Vault app status via `conn_desktop::vault::VaultClient`.
//! 3. `Test logins`: per-environment list, add/edit modal dialog (with secret reveal on edit),
//!    and delete via `testLogins.*` RPCs on `conn_client::Connection`.
//! 4. `Protection`: always-on disabled redaction switch plus the server-scoped
//!    `credentialAutofill` toggles (`blockScriptsAfterFill`, `allowSubdomains`) written via
//!    `server.updateSettings`.

#[cfg(test)]
mod tests;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use conn_client::Connection;
use conn_contract::{
    SaveTestLoginInput, TestLoginList, TestLoginSecrets, TestLoginSummary,
    TestLoginSummaryCreatedBy, UpdateTestLoginInput,
};
use conn_desktop::vault::{VaultClient, VaultLoginsResponse, VaultLoginsStatus};
use conn_desktop::vaultwarden as vw;
use conn_state::providers::ServerConfigState;
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, App, AppContext as _, ClickEvent, Context, Entity,
    FontWeight, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Task, TestSupportExt as _, Transformation, Window, anchored, deferred, div,
    percentage, point, px,
};
use serde_json::{Value, json};

use super::controls::{
    disabled_pill_switch, pill_switch_labeled, settings_row, settings_section,
    settings_section_with_header_action,
};
use super::providers::styled_button;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::MODAL_LAYER_PRIORITY;
use crate::theme::{hsla, hsla_alpha};

const DEFAULT_VAULTWARDEN_SERVER: &str = "https://vault.orbit";
const DEFAULT_BLOCK_SCRIPTS_AFTER_FILL: bool = true;
const DEFAULT_ALLOW_SUBDOMAINS: bool = false;
const FORM_CONTROL_H_PX: f32 = 30.0;
const DIALOG_MAX_W_PX: f32 = 448.0;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Local macOS backends for Vaultwarden (`conn_desktop::vaultwarden`) and Vault
/// (`conn_desktop::vault`). Swappable in headless unit tests so tests never touch Keychain,
/// network, or `/Applications/Vault.app`.
pub(crate) trait LocalPasswordsBackend: Send + Sync + 'static {
    fn vw_status(&self) -> BoxFuture<Result<Option<vw::Connection>, String>>;
    fn vw_check(&self, account: vw::Account) -> BoxFuture<Result<Vec<vw::Collection>, String>>;
    fn vw_save(
        &self,
        account: vw::Account,
        collection: vw::Collection,
    ) -> BoxFuture<Result<vw::Connection, String>>;
    fn vw_disconnect(&self) -> BoxFuture<Result<(), String>>;
    fn vault_status(&self) -> BoxFuture<VaultLoginsResponse>;
}

/// Production backend bridging `conn_desktop::vaultwarden` and `conn_desktop::vault` onto
/// `crate::live::RT`.
struct LiveLocalPasswordsBackend;

impl LocalPasswordsBackend for LiveLocalPasswordsBackend {
    fn vw_status(&self) -> BoxFuture<Result<Option<vw::Connection>, String>> {
        Box::pin(async move {
            let task = crate::live::RT.spawn(async move {
                vw::status().await.map_err(|err| {
                    let msg = err.to_string();
                    if msg.trim().is_empty() {
                        "Could not read the local Vaultwarden connection.".to_owned()
                    } else {
                        msg
                    }
                })
            });
            match task.await {
                Ok(res) => res,
                Err(_) => Err("Could not read the local Vaultwarden connection.".to_owned()),
            }
        })
    }

    fn vw_check(&self, account: vw::Account) -> BoxFuture<Result<Vec<vw::Collection>, String>> {
        Box::pin(async move {
            let task = crate::live::RT
                .spawn(async move { vw::check(&account).await.map_err(|err| err.to_string()) });
            match task.await {
                Ok(res) => res,
                Err(_) => Err("Vaultwarden setup did not finish. Nothing was saved.".to_owned()),
            }
        })
    }

    fn vw_save(
        &self,
        account: vw::Account,
        collection: vw::Collection,
    ) -> BoxFuture<Result<vw::Connection, String>> {
        Box::pin(async move {
            let task = crate::live::RT.spawn(async move {
                vw::save(&account, &collection)
                    .await
                    .map_err(|err| err.to_string())
            });
            match task.await {
                Ok(res) => res,
                Err(_) => Err("Vaultwarden setup did not finish. Nothing was saved.".to_owned()),
            }
        })
    }

    fn vw_disconnect(&self) -> BoxFuture<Result<(), String>> {
        Box::pin(async move {
            let task = crate::live::RT
                .spawn(async move { vw::disconnect().await.map_err(|err| err.to_string()) });
            match task.await {
                Ok(res) => res,
                Err(_) => Err("Could not remove the local connection.".to_owned()),
            }
        })
    }

    fn vault_status(&self) -> BoxFuture<VaultLoginsResponse> {
        vault_status_via(VaultClient::new())
    }
}

/// Asks the Vault bridge behind `client` for its login status on `crate::live::RT`.
fn vault_status_via(client: VaultClient) -> BoxFuture<VaultLoginsResponse> {
    Box::pin(async move {
        if !client.is_installed() {
            return VaultLoginsResponse {
                status: VaultLoginsStatus::Unavailable,
                items: Vec::new(),
                error: Some("Vault is not installed on this Mac.".to_owned()),
            };
        }
        let task = crate::live::RT.spawn(async move { client.login_status().await });
        task.await.unwrap_or_else(|_| VaultLoginsResponse {
            status: VaultLoginsStatus::Error,
            items: Vec::new(),
            error: Some("Vault could not answer.".to_owned()),
        })
    })
}

/// Environment RPC backend for test logins and `credentialAutofill` server settings.
pub(crate) trait ServerPasswordsBackend: Send + Sync + 'static {
    fn list_test_logins(&self) -> BoxFuture<Result<TestLoginList, String>>;
    fn save_test_login(
        &self,
        input: SaveTestLoginInput,
    ) -> BoxFuture<Result<TestLoginSummary, String>>;
    fn update_test_login(
        &self,
        input: UpdateTestLoginInput,
    ) -> BoxFuture<Result<TestLoginSummary, String>>;
    fn remove_test_login(&self, id: String) -> BoxFuture<Result<(), String>>;
    fn reveal_test_login(&self, id: String) -> BoxFuture<Result<TestLoginSecrets, String>>;
    fn update_credential_autofill(&self, patch: Value) -> BoxFuture<Result<(), String>>;
}

struct LiveServerPasswordsBackend(Connection);

impl ServerPasswordsBackend for LiveServerPasswordsBackend {
    fn list_test_logins(&self) -> BoxFuture<Result<TestLoginList, String>> {
        let conn = self.0.clone();
        Box::pin(async move {
            conn.list_test_logins()
                .await
                .map_err(|err| conn_client::commands::format_client_error(&err))
        })
    }

    fn save_test_login(
        &self,
        input: SaveTestLoginInput,
    ) -> BoxFuture<Result<TestLoginSummary, String>> {
        let conn = self.0.clone();
        Box::pin(async move {
            conn.save_test_login(&input)
                .await
                .map_err(|err| conn_client::commands::format_client_error(&err))
        })
    }

    fn update_test_login(
        &self,
        input: UpdateTestLoginInput,
    ) -> BoxFuture<Result<TestLoginSummary, String>> {
        let conn = self.0.clone();
        Box::pin(async move {
            conn.update_test_login(&input)
                .await
                .map_err(|err| conn_client::commands::format_client_error(&err))
        })
    }

    fn remove_test_login(&self, id: String) -> BoxFuture<Result<(), String>> {
        let conn = self.0.clone();
        Box::pin(async move {
            conn.remove_test_login(&id)
                .await
                .map_err(|err| conn_client::commands::format_client_error(&err))
        })
    }

    fn reveal_test_login(&self, id: String) -> BoxFuture<Result<TestLoginSecrets, String>> {
        let conn = self.0.clone();
        Box::pin(async move {
            conn.reveal_test_login(&id)
                .await
                .map_err(|err| conn_client::commands::format_client_error(&err))
        })
    }

    fn update_credential_autofill(&self, patch: Value) -> BoxFuture<Result<(), String>> {
        let conn = self.0.clone();
        Box::pin(async move {
            conn.call_json(
                "server.updateSettings",
                json!({ "credentialAutofill": patch }),
            )
            .await
            .map(|_| ())
            .map_err(|err| conn_client::commands::format_client_error(&err))
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VaultwardenPendingAction {
    Check,
    Save,
    Disconnect,
}

/// Active Vaultwarden connect/replace form. Dropped on cancel, save, or disconnect so secret
/// field states are cleared immediately.
struct VaultwardenForm {
    server: Entity<InputState>,
    client_id: Entity<InputState>,
    client_secret: Entity<InputState>,
    master_password: Entity<InputState>,
    collections: Vec<vw::Collection>,
    selected_collection_id: Option<String>,
    collection_menu_open: bool,
    checked: bool,
    _subscriptions: Vec<Subscription>,
}

/// Whether the edit dialog has the stored password and OTP secret yet. They load through an async
/// reveal, and the fields stay empty until it answers, so empty is not "the user cleared it".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SecretsLoad {
    /// A new login: there is nothing stored to load.
    NotStored,
    Loading,
    Loaded,
    /// The reveal failed: the fields hold only what the user types.
    Failed,
}

/// Active Add / Edit Test login modal dialog (`TestLoginDialog.tsx`).
struct TestLoginDialogState {
    editing_id: Option<String>,
    secrets: SecretsLoad,
    url: Entity<InputState>,
    username: Entity<InputState>,
    password: Entity<InputState>,
    label: Entity<InputState>,
    otp_secret: Entity<InputState>,
    saving: bool,
    error: Option<String>,
    _subscriptions: Vec<Subscription>,
}

/// Settings › Passwords view.
pub(crate) struct PasswordsView {
    tokens: Tokens,
    geometry: ShellGeometry,
    local: Arc<dyn LocalPasswordsBackend>,
    server: Option<Arc<dyn ServerPasswordsBackend>>,
    config: Arc<ServerConfigState>,
    opened: bool,

    // Section 1: Vaultwarden · this Mac
    vw_connection: Option<vw::Connection>,
    vw_form: Option<VaultwardenForm>,
    vw_pending: Option<VaultwardenPendingAction>,
    vw_status_loading: bool,
    vw_message: Option<String>,
    _vw_status_task: Option<Task<()>>,
    _vw_action_task: Option<Task<()>>,

    // Section 2: Password manager (Mac Vault app)
    vault_state: Option<VaultLoginsResponse>,
    vault_busy: bool,
    _vault_task: Option<Task<()>>,

    // Section 3: Test logins
    test_logins: Vec<TestLoginSummary>,
    test_logins_error: Option<String>,
    test_logins_notice: Option<String>,
    test_login_dialog: Option<TestLoginDialogState>,
    _test_logins_task: Option<Task<()>>,
    _test_login_reveal_task: Option<Task<()>>,

    // Section 4: Protection (`credentialAutofill`)
    block_scripts_after_fill: bool,
    allow_subdomains: bool,
    protection_pending: bool,
    protection_error: Option<String>,
}

impl PasswordsView {
    #[must_use]
    pub(crate) fn new(
        tokens: Tokens,
        geometry: ShellGeometry,
        connection: Option<Connection>,
    ) -> Self {
        let server: Option<Arc<dyn ServerPasswordsBackend>> =
            connection.map(|conn| Arc::new(LiveServerPasswordsBackend(conn)) as _);
        Self::with_backends(
            tokens,
            geometry,
            Arc::new(LiveLocalPasswordsBackend),
            server,
        )
    }

    pub(crate) fn with_backends(
        tokens: Tokens,
        geometry: ShellGeometry,
        local: Arc<dyn LocalPasswordsBackend>,
        server: Option<Arc<dyn ServerPasswordsBackend>>,
    ) -> Self {
        Self {
            tokens,
            geometry,
            local,
            server,
            config: Arc::default(),
            opened: false,
            vw_connection: None,
            vw_form: None,
            vw_pending: None,
            vw_status_loading: false,
            vw_message: None,
            _vw_status_task: None,
            _vw_action_task: None,
            vault_state: None,
            vault_busy: false,
            _vault_task: None,
            test_logins: Vec::new(),
            test_logins_error: None,
            test_logins_notice: None,
            test_login_dialog: None,
            _test_logins_task: None,
            _test_login_reveal_task: None,
            block_scripts_after_fill: DEFAULT_BLOCK_SCRIPTS_AFTER_FILL,
            allow_subdomains: DEFAULT_ALLOW_SUBDOMAINS,
            protection_pending: false,
            protection_error: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// Updates the connected environment. Never calls `vaultwarden::status()`.
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        let server: Option<Arc<dyn ServerPasswordsBackend>> =
            connection.map(|conn| Arc::new(LiveServerPasswordsBackend(conn)) as _);
        self.set_server_backend(server, cx);
    }

    pub(crate) fn set_server_backend(
        &mut self,
        server: Option<Arc<dyn ServerPasswordsBackend>>,
        cx: &mut Context<'_, Self>,
    ) {
        self.server = server;
        self.test_logins.clear();
        self.test_logins_error = None;
        self.test_logins_notice = None;
        self.test_login_dialog = None;
        self._test_logins_task = None;
        self._test_login_reveal_task = None;
        self.protection_error = None;
        if self.opened {
            self.refresh_test_logins(cx);
        }
        cx.notify();
    }

    /// Applies the server's `credentialAutofill` settings. Never calls `vaultwarden::status()`.
    pub(crate) fn set_server_config(
        &mut self,
        config: Arc<ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(settings) = config.settings() {
            let autofill = settings.credential_autofill.as_ref();
            self.block_scripts_after_fill = autofill
                .and_then(|a| a.block_scripts_after_fill)
                .unwrap_or(DEFAULT_BLOCK_SCRIPTS_AFTER_FILL);
            self.allow_subdomains = autofill
                .and_then(|a| a.allow_subdomains)
                .unwrap_or(DEFAULT_ALLOW_SUBDOMAINS);
        }
        self.config = config;
        cx.notify();
    }

    /// Called only when the user opens Settings › Passwords (never on background refresh).
    pub(crate) fn on_open(&mut self, cx: &mut Context<'_, Self>) {
        self.opened = true;
        self.load_vaultwarden_status(cx);
        self.check_vault_status(cx);
        self.refresh_test_logins(cx);
        cx.notify();
    }

    /// True while the Add / Edit test login modal dialog is open (so Escape closes it first).
    #[must_use]
    pub(crate) fn has_open_dialog(&self) -> bool {
        self.test_login_dialog.is_some()
    }

    /// Closes any open Add / Edit test login dialog and clears its input fields.
    pub(crate) fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if let Some(dialog) = self.test_login_dialog.take() {
            clear_test_login_dialog_inputs(&dialog, window, cx);
            self._test_login_reveal_task = None;
            cx.notify();
        }
    }

    // --- Section 1: Vaultwarden actions ----------------------------------------------------

    fn load_vaultwarden_status(&mut self, cx: &mut Context<'_, Self>) {
        if self.vw_status_loading || self.vw_pending.is_some() {
            return;
        }
        self.vw_status_loading = true;
        let local = Arc::clone(&self.local);
        self._vw_status_task = Some(cx.spawn(async move |this, cx| {
            let result = local.vw_status().await;
            let _ = this.update(cx, |view, cx| {
                view.vw_status_loading = false;
                match result {
                    Ok(connection) => {
                        view.vw_connection = connection;
                        view.vw_message = None;
                    }
                    Err(err) => {
                        view.vw_message = Some(if err.trim().is_empty() {
                            "Could not read the local Vaultwarden connection.".to_owned()
                        } else {
                            err
                        });
                    }
                }
                cx.notify();
            });
        }));
    }

    fn open_vaultwarden_form(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.vw_pending.is_some() {
            return;
        }
        if self.vw_form.is_some() {
            self.vw_message = None;
            cx.notify();
            return;
        }
        let server = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(DEFAULT_VAULTWARDEN_SERVER)
                .default_value(DEFAULT_VAULTWARDEN_SERVER)
        });
        let client_id = cx.new(|cx| InputState::new(window, cx).placeholder("user.\u{2026}"));
        let client_secret = cx.new(|cx| InputState::new(window, cx).masked(true));
        let master_password = cx.new(|cx| InputState::new(window, cx).masked(true));

        let mut subscriptions = Vec::with_capacity(4);
        for input in [&server, &client_id, &client_secret, &master_password] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |view, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => {
                        if let Some(form) = &mut view.vw_form {
                            form.checked = false;
                            form.collections.clear();
                            form.selected_collection_id = None;
                            form.collection_menu_open = false;
                        }
                        view.vw_message = None;
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => {
                        let save = view.vw_form.as_ref().is_some_and(|form| {
                            form.checked && form.selected_collection_id.is_some()
                        });
                        view.submit_vaultwarden(save, window, cx);
                    }
                    _ => {}
                },
            ));
        }

        self.vw_message = None;
        self.vw_form = Some(VaultwardenForm {
            server,
            client_id,
            client_secret,
            master_password,
            collections: Vec::new(),
            selected_collection_id: None,
            collection_menu_open: false,
            checked: false,
            _subscriptions: subscriptions,
        });
        cx.notify();
    }

    fn close_vaultwarden_form(&mut self, window: Option<&mut Window>, cx: &mut Context<'_, Self>) {
        if let Some(form) = self.vw_form.take()
            && let Some(window) = window
        {
            clear_vaultwarden_form_inputs(&form, window, cx);
        }
        cx.notify();
    }

    fn read_vaultwarden_account(&self, cx: &Context<'_, Self>) -> Option<vw::Account> {
        let form = self.vw_form.as_ref()?;
        Some(vw::Account {
            server: form.server.read(cx).value().to_string(),
            client_id: form.client_id.read(cx).value().to_string(),
            client_secret: form.client_secret.read(cx).value().to_string(),
            master_password: form.master_password.read(cx).value().to_string(),
        })
    }

    fn submit_vaultwarden(&mut self, save: bool, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.vw_pending.is_some() {
            return;
        }
        let Some(account) = self.read_vaultwarden_account(cx) else {
            return;
        };
        if account.server.is_empty()
            || account.client_id.is_empty()
            || account.client_secret.is_empty()
            || account.master_password.is_empty()
        {
            return;
        }
        let selected_collection = if save {
            let Some(form) = self.vw_form.as_ref() else {
                return;
            };
            let Some(selected_id) = form.selected_collection_id.as_deref() else {
                return;
            };
            let Some(collection) = form
                .collections
                .iter()
                .find(|entry| entry.id == selected_id)
                .cloned()
            else {
                return;
            };
            Some(collection)
        } else {
            None
        };

        self.vw_pending = Some(if save {
            VaultwardenPendingAction::Save
        } else {
            VaultwardenPendingAction::Check
        });
        if let Some(form) = &mut self.vw_form {
            form.collection_menu_open = false;
        }
        self.vw_message = None;
        cx.notify();

        let local = Arc::clone(&self.local);
        let window_handle = window.window_handle();
        self._vw_action_task = Some(cx.spawn(async move |this, cx| {
            if let Some(collection) = selected_collection {
                let result = local.vw_save(account, collection).await;
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    let _ = this.update(cx, |view, cx| {
                        view.vw_pending = None;
                        match result {
                            Ok(connection) => {
                                view.vw_connection = Some(connection);
                                view.close_vaultwarden_form(Some(window), cx);
                                view.vw_message = Some(
                                    "Connection saved on this Mac. Browser and agent credential routing is not enabled yet."
                                        .to_owned(),
                                );
                            }
                            Err(err) => {
                                view.vw_message = Some(err);
                            }
                        }
                        cx.notify();
                    });
                });
            } else {
                let result = local.vw_check(account).await;
                let _ = this.update(cx, |view, cx| {
                    view.vw_pending = None;
                    match result {
                        Ok(collections) => {
                            let empty = collections.is_empty();
                            let auto_selected = if collections.len() == 1 {
                                Some(collections[0].id.clone())
                            } else {
                                None
                            };
                            if let Some(form) = &mut view.vw_form {
                                form.collections = collections;
                                form.checked = true;
                                form.selected_collection_id = auto_selected;
                                form.collection_menu_open = false;
                            }
                            if empty {
                                view.vw_message = Some(
                                    "No writable collections found. Create the organization and collection, or confirm this account's membership, then check again."
                                        .to_owned(),
                                );
                            }
                        }
                        Err(err) => {
                            view.vw_message = Some(err);
                        }
                    }
                    cx.notify();
                });
            }
        }));
    }

    fn disconnect_vaultwarden(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.vw_pending.is_some() {
            return;
        }
        self.vw_pending = Some(VaultwardenPendingAction::Disconnect);
        cx.notify();

        let local = Arc::clone(&self.local);
        let window_handle = window.window_handle();
        self._vw_action_task = Some(cx.spawn(async move |this, cx| {
            let result = local.vw_disconnect().await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |view, cx| {
                    view.vw_pending = None;
                    match result {
                        Ok(()) => {
                            view.vw_connection = None;
                            view.close_vaultwarden_form(Some(window), cx);
                            view.vw_message = Some(
                                "Local connection removed. Your Vaultwarden account and items were kept."
                                    .to_owned(),
                            );
                        }
                        Err(err) => {
                            view.vw_message = Some(err);
                        }
                    }
                    cx.notify();
                });
            });
        }));
    }

    // --- Section 2: Mac Vault app status ---------------------------------------------------

    fn check_vault_status(&mut self, cx: &mut Context<'_, Self>) {
        self.vault_busy = true;
        cx.notify();
        let local = Arc::clone(&self.local);
        self._vault_task = Some(cx.spawn(async move |this, cx| {
            let response = local.vault_status().await;
            let _ = this.update(cx, |view, cx| {
                view.vault_state = Some(response);
                view.vault_busy = false;
                cx.notify();
            });
        }));
    }

    // --- Section 3: Test logins ------------------------------------------------------------

    fn refresh_test_logins(&mut self, cx: &mut Context<'_, Self>) {
        let Some(server) = self.server.clone() else {
            self.test_logins.clear();
            self.test_logins_error = None;
            return;
        };
        self._test_logins_task = Some(cx.spawn(async move |this, cx| {
            let result = server.list_test_logins().await;
            let _ = this.update(cx, |view, cx| {
                match result {
                    Ok(list) => {
                        view.test_logins = list.items;
                        view.test_logins_error = None;
                    }
                    Err(err) => {
                        view.test_logins_error = Some(err);
                    }
                }
                cx.notify();
            });
        }));
    }

    fn open_test_login_dialog(
        &mut self,
        login: Option<TestLoginSummary>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.server.is_none() {
            return;
        }
        let editing_id = login.as_ref().map(|item| item.id.clone());
        let initial_url = login
            .as_ref()
            .map(|item| item.url.clone())
            .unwrap_or_default();
        let initial_username = login
            .as_ref()
            .map(|item| item.username.clone())
            .unwrap_or_default();
        let initial_label = login
            .as_ref()
            .map(|item| item.label.clone())
            .unwrap_or_default();

        let url = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("http://myapp.test/login")
                .default_value(initial_url)
        });
        let username = cx.new(|cx| InputState::new(window, cx).default_value(initial_username));
        let password = cx.new(|cx| InputState::new(window, cx));
        let label = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("admin, customer\u{2026}")
                .default_value(initial_label)
        });
        let otp_secret = cx
            .new(|cx| InputState::new(window, cx).placeholder("Base32 secret or otpauth:// link"));

        let mut subscriptions = Vec::with_capacity(5);
        for input in [&url, &username, &password, &label, &otp_secret] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |view, _, event: &InputEvent, window, cx| match event {
                    InputEvent::Change => cx.notify(),
                    InputEvent::PressEnter { .. } => view.submit_test_login(window, cx),
                    _ => {}
                },
            ));
        }

        self.test_login_dialog = Some(TestLoginDialogState {
            secrets: if editing_id.is_some() {
                SecretsLoad::Loading
            } else {
                SecretsLoad::NotStored
            },
            editing_id: editing_id.clone(),
            url,
            username,
            password,
            label,
            otp_secret,
            saving: false,
            error: None,
            _subscriptions: subscriptions,
        });
        self._test_login_reveal_task = None;

        // Editing loads the stored secrets into the form (`TestLoginDialog.tsx`). Save waits for
        // this; if it fails, the fields are never sent empty (`update_test_login_input`).
        if let Some(id) = editing_id {
            let Some(server) = self.server.clone() else {
                // Nothing can load them, and nothing can save either.
                if let Some(dialog) = &mut self.test_login_dialog {
                    dialog.secrets = SecretsLoad::Failed;
                }
                cx.notify();
                return;
            };
            let window_handle = window.window_handle();
            self._test_login_reveal_task = Some(cx.spawn(async move |this, cx| {
                let result = server.reveal_test_login(id.clone()).await;
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    let _ = this.update(cx, |view, cx| {
                        let Some(dialog) = view.test_login_dialog.as_mut() else {
                            return;
                        };
                        if dialog.editing_id.as_deref() != Some(id.as_str()) {
                            return;
                        }
                        match result {
                            Ok(secrets) => {
                                dialog.password.update(cx, |state, cx| {
                                    state.set_value(secrets.password, window, cx);
                                });
                                dialog.otp_secret.update(cx, |state, cx| {
                                    state.set_value(
                                        secrets.otp_secret.unwrap_or_default(),
                                        window,
                                        cx,
                                    );
                                });
                                dialog.secrets = SecretsLoad::Loaded;
                            }
                            Err(err) => {
                                dialog.secrets = SecretsLoad::Failed;
                                dialog.error = Some(format!(
                                    "Could not load the stored password and OTP secret ({err}). Saving keeps them unless you type new ones."
                                ));
                            }
                        }
                        cx.notify();
                    });
                });
            }));
        }

        cx.notify();
    }

    fn submit_test_login(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(server) = self.server.clone() else {
            return;
        };
        let Some(dialog) = self.test_login_dialog.as_ref() else {
            return;
        };
        let url = dialog.url.read(cx).value().to_string();
        let username = dialog.username.read(cx).value().to_string();
        let password = dialog.password.read(cx).value().to_string();
        let label = dialog.label.read(cx).value().to_string();
        let otp_secret = dialog.otp_secret.read(cx).value().to_string();
        if dialog.saving
            || dialog.secrets == SecretsLoad::Loading
            || url.trim().is_empty()
            || username.trim().is_empty()
        {
            return;
        }
        let secrets = dialog.secrets;
        let editing_id = dialog.editing_id.clone();

        if let Some(dialog) = &mut self.test_login_dialog {
            dialog.saving = true;
            dialog.error = None;
        }
        cx.notify();

        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = if let Some(id) = editing_id.clone() {
                server
                    .update_test_login(update_test_login_input(
                        id, url, username, label, password, otp_secret, secrets,
                    ))
                    .await
            } else {
                server
                    .save_test_login(SaveTestLoginInput {
                        url,
                        username,
                        password,
                        label: (!label.is_empty()).then_some(label),
                        otp_secret: (!otp_secret.is_empty()).then_some(otp_secret),
                    })
                    .await
            };
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |view, cx| match result {
                    Ok(_) => {
                        view.close_dialog(window, cx);
                        view.test_logins_notice = Some(if editing_id.is_some() {
                            "Test login updated".to_owned()
                        } else {
                            "Test login saved".to_owned()
                        });
                        view.refresh_test_logins(cx);
                        cx.notify();
                    }
                    Err(err) => {
                        if let Some(dialog) = &mut view.test_login_dialog {
                            dialog.saving = false;
                            dialog.error = Some(err);
                        }
                        cx.notify();
                    }
                });
            });
        })
        .detach();
    }

    fn delete_test_login(&mut self, id: String, cx: &mut Context<'_, Self>) {
        let Some(server) = self.server.clone() else {
            return;
        };
        self.test_logins_error = None;
        self.test_logins_notice = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = server.remove_test_login(id).await;
            let _ = this.update(cx, |view, cx| {
                match result {
                    Ok(()) => {
                        view.refresh_test_logins(cx);
                    }
                    Err(err) => {
                        view.test_logins_error = Some(err);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- Section 4: Protection toggles -----------------------------------------------------

    fn toggle_block_scripts_after_fill(&mut self, cx: &mut Context<'_, Self>) {
        let Some(server) = self.server.clone() else {
            return;
        };
        if self.protection_pending {
            return;
        }
        let previous = self.block_scripts_after_fill;
        let next = !previous;
        self.block_scripts_after_fill = next;
        self.protection_pending = true;
        self.protection_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let result = server
                .update_credential_autofill(json!({ "blockScriptsAfterFill": next }))
                .await;
            let _ = this.update(cx, |view, cx| {
                view.protection_pending = false;
                if let Err(err) = result {
                    view.block_scripts_after_fill = previous;
                    view.protection_error = Some(err);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_allow_subdomains(&mut self, cx: &mut Context<'_, Self>) {
        let Some(server) = self.server.clone() else {
            return;
        };
        if self.protection_pending {
            return;
        }
        let previous = self.allow_subdomains;
        let next = !previous;
        self.allow_subdomains = next;
        self.protection_pending = true;
        self.protection_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let result = server
                .update_credential_autofill(json!({ "allowSubdomains": next }))
                .await;
            let _ = this.update(cx, |view, cx| {
                view.protection_pending = false;
                if let Err(err) = result {
                    view.allow_subdomains = previous;
                    view.protection_error = Some(err);
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- Rendering -------------------------------------------------------------------------

    fn render_vaultwarden_section(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let busy = self.vw_pending.is_some();
        let connected = self.vw_connection.as_ref();

        let (title, description) = match connected {
            Some(conn) => (
                format!(
                    "{} / {}",
                    conn.collection.organization_name, conn.collection.name
                ),
                format!("{} \u{00b7} {}", conn.email, conn.server),
            ),
            None => (
                "Dedicated Conn account".to_owned(),
                "Connect an account with access to the collection Conn will use.".to_owned(),
            ),
        };

        let mut controls = div().flex().flex_row().items_center().gap(px(8.0));
        let connect_label = if connected.is_some() {
            "Replace connection"
        } else {
            "Connect"
        };
        controls = controls.child(styled_button(
            &self.tokens,
            "settings.passwords.vaultwarden.connect".to_owned(),
            connect_label,
            connect_label,
            false,
            (!busy).then(|| {
                cx.listener(|view, _: &ClickEvent, window, cx| {
                    view.open_vaultwarden_form(window, cx);
                })
            }),
        ));
        if connected.is_some() {
            controls = controls.child(styled_button(
                &self.tokens,
                "settings.passwords.vaultwarden.disconnect".to_owned(),
                "Disconnect",
                "Disconnect",
                false,
                (!busy).then(|| {
                    cx.listener(|view, _: &ClickEvent, window, cx| {
                        view.disconnect_vaultwarden(window, cx);
                    })
                }),
            ));
        }

        let mut rows = vec![self.custom_row(
            "settings.passwords.vaultwarden.summary",
            &title,
            Some(description),
            controls.into_any_element(),
        )];

        if let Some(form) = &self.vw_form {
            rows.push(self.render_vaultwarden_form(form, cx));
        }

        if let Some(message) = &self.vw_message {
            rows.push(self.status_row("settings.passwords.vaultwarden.status", message, false));
        }

        settings_section(
            "Vaultwarden \u{00b7} this Mac",
            rows,
            &self.tokens,
            &self.geometry,
        )
        .into_any_element()
    }

    fn render_vaultwarden_form(
        &self,
        form: &VaultwardenForm,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let busy = self.vw_pending.is_some();
        let any_empty = form.server.read(cx).value().is_empty()
            || form.client_id.read(cx).value().is_empty()
            || form.client_secret.read(cx).value().is_empty()
            || form.master_password.read(cx).value().is_empty();
        let can_save = form.checked && form.selected_collection_id.is_some();
        let submit_label = match self.vw_pending {
            Some(VaultwardenPendingAction::Check) => "Checking\u{2026}",
            Some(VaultwardenPendingAction::Save) => "Saving\u{2026}",
            _ if can_save => "Save connection",
            _ => "Check account",
        };
        let submit_disabled = busy || any_empty;

        let mut fields = div()
            .id("settings-passwords-vaultwarden-form")
            .a11y_group(
                "settings.passwords.vaultwarden.form",
                "Vaultwarden account form",
            )
            .flex()
            .flex_col()
            .gap(px(12.0))
            .w_full()
            .max_w(px(560.0))
            .p(px(14.0))
            .child(self.form_field(
                "Server",
                None,
                Input::new(&form.server).disabled(busy).into_any_element(),
            ))
            .child(self.form_field(
                "Personal API client ID",
                Some(
                    "In the dedicated account's web vault: Settings \u{2192} Security \u{2192} Keys \u{2192} API key.",
                ),
                Input::new(&form.client_id).disabled(busy).into_any_element(),
            ))
            .child(self.form_field(
                "Personal API client secret",
                None,
                Input::new(&form.client_secret)
                    .disabled(busy)
                    .into_any_element(),
            ))
            .child(self.form_field(
                "Account master password",
                Some(
                    "Stored with the API key in macOS Keychain. Conn needs it to encrypt and decrypt this account's items.",
                ),
                Input::new(&form.master_password)
                    .disabled(busy)
                    .into_any_element(),
            ));

        if !form.collections.is_empty() {
            fields = fields.child(self.render_collection_picker(form, busy, cx));
        }

        let actions = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .pt(px(2.0))
            .child(busy_button(
                &self.tokens,
                "settings.passwords.vaultwarden.submit".to_owned(),
                submit_label,
                true,
                matches!(
                    self.vw_pending,
                    Some(VaultwardenPendingAction::Check | VaultwardenPendingAction::Save)
                ),
                (!submit_disabled).then(|| {
                    cx.listener(move |view, _: &ClickEvent, window, cx| {
                        view.submit_vaultwarden(can_save, window, cx);
                    })
                }),
            ))
            .child(styled_button(
                &self.tokens,
                "settings.passwords.vaultwarden.cancel".to_owned(),
                "Cancel",
                "Cancel",
                false,
                (!busy).then(|| {
                    cx.listener(|view, _: &ClickEvent, window, cx| {
                        view.close_vaultwarden_form(Some(window), cx);
                    })
                }),
            ));

        fields.child(actions).test_support().into_any_element()
    }

    fn render_collection_picker(
        &self,
        form: &VaultwardenForm,
        busy: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);
        let highlight = hsla(self.tokens.shell_highlight);
        let divider = hsla(self.tokens.glass_divider);

        let selected_label = form
            .selected_collection_id
            .as_deref()
            .and_then(|id| form.collections.iter().find(|entry| entry.id == id))
            .map(|entry| format!("{} / {}", entry.organization_name, entry.name));

        let trigger_text = selected_label
            .clone()
            .unwrap_or_else(|| "Choose a collection".to_owned());
        let trigger_color = if selected_label.is_some() { fg } else { muted };

        let mut trigger = div()
            .id("vaultwarden-collection-trigger")
            .a11y_button(
                "settings.passwords.vaultwarden.collection",
                selected_label.unwrap_or_else(|| "Choose a collection".to_owned()),
            )
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .w_full()
            .h(px(FORM_CONTROL_H_PX))
            .px(px(10.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(hsla(self.tokens.shell_divider_header))
            .bg(hsla(self.tokens.shell_control))
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(trigger_color)
            .child(div().min_w_0().truncate().child(trigger_text))
            .child(crate::panels::header::superhero_icon(
                "superhero/chevron-down.svg",
                12.0,
                muted,
            ));

        if busy {
            trigger = trigger.opacity(0.5);
        } else {
            trigger =
                trigger
                    .cursor_pointer()
                    .on_click(cx.listener(|view, _: &ClickEvent, _, cx| {
                        if let Some(form) = &mut view.vw_form {
                            form.collection_menu_open = !form.collection_menu_open;
                        }
                        cx.notify();
                    }));
        }

        let mut wrapper = div()
            .id("vaultwarden-collection-wrapper")
            .relative()
            .w_full()
            .on_mouse_down_out(cx.listener(|view, _, _, cx| {
                if let Some(form) = &mut view.vw_form
                    && form.collection_menu_open
                {
                    form.collection_menu_open = false;
                    cx.notify();
                }
            }))
            .child(trigger.test_support());

        if form.collection_menu_open && !busy {
            let mut list = div()
                .id("vaultwarden-collection-menu")
                .a11y(
                    Role::Menu,
                    "settings.passwords.vaultwarden.collection.menu",
                    "Vaultwarden collections",
                )
                .flex()
                .flex_col()
                .w_full()
                .mt(px(4.0))
                .p(px(4.0))
                .rounded(px(10.0))
                .bg(hsla(self.tokens.popover))
                .border_1()
                .border_color(divider)
                .shadow_md()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

            for entry in &form.collections {
                let entry_id = entry.id.clone();
                let entry_label = format!("{} / {}", entry.organization_name, entry.name);
                let is_selected = form.selected_collection_id.as_deref() == Some(entry.id.as_str());
                list = list.child(
                    div()
                        .id(SharedString::from(format!(
                            "vaultwarden-collection-{}",
                            entry.id
                        )))
                        .a11y(
                            Role::MenuItem,
                            SharedString::from(format!(
                                "settings.passwords.vaultwarden.collection.{}",
                                entry.id
                            )),
                            entry_label.clone(),
                        )
                        .flex()
                        .flex_row()
                        .items_center()
                        .w_full()
                        .min_h(px(28.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .rounded(px(6.0))
                        .cursor_pointer()
                        .text_size(px(self.geometry.ui_font_size_px))
                        .line_height(px(self.geometry.ui_line_height_px))
                        .text_color(fg)
                        .when(is_selected, |el| el.bg(highlight))
                        .hover(move |s| s.bg(highlight))
                        .on_click(cx.listener(move |view, _: &ClickEvent, _, cx| {
                            if let Some(form) = &mut view.vw_form {
                                form.selected_collection_id = Some(entry_id.clone());
                                form.collection_menu_open = false;
                            }
                            cx.notify();
                        }))
                        .child(div().min_w_0().truncate().child(entry_label))
                        .test_support(),
                );
            }
            wrapper = wrapper.child(list);
        }

        self.form_field("Collection", None, wrapper.into_any_element())
    }

    /// The Vault row's description for the current state (`VaultProviderRow.tsx`).
    fn vault_description(&self) -> String {
        if self.vault_busy {
            return "Checking Vault\u{2026}".to_owned();
        }
        match self.vault_state.as_ref() {
            Some(resp) if resp.status == VaultLoginsStatus::Ok => {
                "Personal logins appear in the browser\u{2019}s saved-login menu.".to_owned()
            }
            Some(resp) if resp.status == VaultLoginsStatus::Locked => {
                "Vault is locked. Unlock it from the browser\u{2019}s saved-login menu.".to_owned()
            }
            Some(resp) => resp
                .error
                .clone()
                .unwrap_or_else(|| "Check the Vault app on this Mac.".to_owned()),
            None => "Check the Vault app on this Mac.".to_owned(),
        }
    }

    fn render_password_manager_section(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let description = self.vault_description();

        let check_btn = busy_button(
            &self.tokens,
            "settings.passwords.vault.check".to_owned(),
            "Check connection",
            false,
            self.vault_busy,
            (!self.vault_busy).then(|| {
                cx.listener(|view, _: &ClickEvent, _, cx| {
                    view.check_vault_status(cx);
                })
            }),
        );

        let rows = vec![self.custom_row(
            "settings.passwords.vault.row",
            "Vault \u{00b7} this Mac",
            Some(description),
            check_btn,
        )];

        settings_section("Password manager", rows, &self.tokens, &self.geometry).into_any_element()
    }

    fn render_test_logins_section(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let connected = self.server.is_some();
        let header_action = connected.then(|| {
            styled_button(
                &self.tokens,
                "settings.passwords.test-logins.add".to_owned(),
                "Add test login",
                "Add test login",
                false,
                Some(cx.listener(|view, _: &ClickEvent, window, cx| {
                    view.open_test_login_dialog(None, window, cx);
                })),
            )
        });

        let mut rows: Vec<AnyElement> = Vec::new();
        if !connected {
            rows.push(self.custom_row(
                "settings.passwords.test-logins.disconnected",
                "Test logins",
                Some("Connect an environment to see its test logins.".to_owned()),
                div().into_any_element(),
            ));
        } else if self.test_logins.is_empty() {
            rows.push(self.custom_row(
                "settings.passwords.test-logins.empty",
                "No test logins yet",
                Some(
                    "Save test users of sites you develop here, or let an agent save the users it creates. They fill without a prompt."
                        .to_owned(),
                ),
                div().into_any_element(),
            ));
        } else {
            for login in &self.test_logins {
                rows.push(self.render_test_login_row(login, cx));
            }
        }

        if let Some(notice) = &self.test_logins_notice {
            rows.push(self.status_row("settings.passwords.test-logins.notice", notice, false));
        }
        if let Some(err) = &self.test_logins_error {
            rows.push(self.status_row("settings.passwords.test-logins.error", err, true));
        }

        settings_section_with_header_action(
            "Test logins",
            header_action,
            rows,
            &self.tokens,
            &self.geometry,
        )
        .into_any_element()
    }

    fn render_test_login_row(
        &self,
        login: &TestLoginSummary,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted_raised = hsla(self.tokens.muted_foreground_raised);
        let url_muted = hsla_alpha(self.tokens.muted_foreground_raised, 0.70);

        let title = if login.label.is_empty() {
            login.username.clone()
        } else {
            login.label.clone()
        };

        let mut desc = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap_x(px(8.0))
            .gap_y(px(2.0))
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(muted_raised)
            .child(div().child(login.username.clone()))
            .child(div().text_color(url_muted).child(login.url.clone()));

        if login.has_otp {
            desc = desc.child(div().child("one-time code"));
        }
        if login.created_by == TestLoginSummaryCreatedBy::Agent {
            desc = desc.child(div().child("saved by an agent"));
        }

        let edit_login = login.clone();
        let delete_id = login.id.clone();
        let edit_ax = format!("Edit {title}");
        let delete_ax = format!("Delete {title}");
        let controls = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .child(styled_button(
                &self.tokens,
                format!("settings.passwords.test-login.{}.edit", login.id),
                "Edit",
                &edit_ax,
                false,
                Some(cx.listener(move |view, _: &ClickEvent, window, cx| {
                    view.open_test_login_dialog(Some(edit_login.clone()), window, cx);
                })),
            ))
            .child(styled_button(
                &self.tokens,
                format!("settings.passwords.test-login.{}.delete", login.id),
                "Delete",
                &delete_ax,
                false,
                Some(cx.listener(move |view, _: &ClickEvent, _, cx| {
                    view.delete_test_login(delete_id.clone(), cx);
                })),
            ));

        let ax_id = SharedString::from(format!("settings.passwords.test-login.{}", login.id));
        div()
            .id(SharedString::from(format!(
                "settings-passwords-test-login-{}",
                login.id
            )))
            .a11y_group(ax_id, title.clone())
            .flex()
            .flex_row()
            .items_start()
            .justify_between()
            .gap(px(16.0))
            .w_full()
            .px(px(14.0))
            .py(px(12.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(px(self.geometry.ui_font_size_px))
                            .line_height(px(self.geometry.ui_line_height_px))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(title),
                    )
                    .child(desc),
            )
            .child(div().flex_shrink_0().child(controls))
            .test_support()
            .into_any_element()
    }

    fn render_protection_section(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let connected = self.server.is_some();

        let hide_switch = disabled_pill_switch(
            "conn-settings-hide-passwords",
            "Hide passwords from page reads",
            true,
            &self.tokens,
        )
        .into_any_element();

        let block_entity = cx.entity();
        let block_switch = if connected && !self.protection_pending {
            pill_switch_labeled(
                "conn-settings-credential-block-scripts",
                "Block agent scripts after a fill",
                self.block_scripts_after_fill,
                &self.tokens,
                move |_window, cx| {
                    block_entity.update(cx, |view, cx| view.toggle_block_scripts_after_fill(cx));
                },
            )
            .into_any_element()
        } else {
            disabled_pill_switch(
                "conn-settings-credential-block-scripts",
                "Block agent scripts after a fill",
                self.block_scripts_after_fill,
                &self.tokens,
            )
            .into_any_element()
        };

        let sub_entity = cx.entity();
        let sub_switch = if connected && !self.protection_pending {
            pill_switch_labeled(
                "conn-settings-credential-subdomains",
                "Fill on subdomains of a saved site",
                self.allow_subdomains,
                &self.tokens,
                move |_window, cx| {
                    sub_entity.update(cx, |view, cx| view.toggle_allow_subdomains(cx));
                },
            )
            .into_any_element()
        } else {
            disabled_pill_switch(
                "conn-settings-credential-subdomains",
                "Fill on subdomains of a saved site",
                self.allow_subdomains,
                &self.tokens,
            )
            .into_any_element()
        };

        let mut rows = vec![
            settings_row(
                "Hide passwords from page reads",
                Some(
                    "Always on. Page text and script results the agent reads show [redacted] in place of password and code values.",
                ),
                hide_switch,
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Block agent scripts after a fill",
                Some(
                    "After a password or code fills, the agent can't run JavaScript in that tab until a new page loads. Stops a script from copying the value out.",
                ),
                block_switch,
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Fill on subdomains of a saved site",
                Some(
                    "A test login saved for example.com also fills login.example.com. Off: only the exact saved site.",
                ),
                sub_switch,
                &self.tokens,
                &self.geometry,
            ),
        ];

        if let Some(err) = &self.protection_error {
            rows.push(self.status_row("settings.passwords.protection.error", err, true));
        }

        settings_section("Protection", rows, &self.tokens, &self.geometry).into_any_element()
    }

    fn render_test_login_dialog(
        &self,
        dialog: &TestLoginDialogState,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let viewport = window.viewport_size();
        let viewport_w = f32::from(viewport.width);
        let dialog_w = DIALOG_MAX_W_PX.min((viewport_w - 32.0).max(320.0));
        let scrim_alpha = match self.tokens.appearance {
            Appearance::Dark => 0.45,
            Appearance::Light => 0.20,
        };
        let scrim = hsla_alpha(self.tokens.background, scrim_alpha);
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);

        let editing = dialog.editing_id.is_some();
        let title = if editing {
            "Edit test login"
        } else {
            "Save a test login"
        };
        let submit_label = if editing {
            "Save changes"
        } else {
            "Save test login"
        };
        let can_save = !dialog.saving
            && dialog.secrets != SecretsLoad::Loading
            && !dialog.url.read(cx).value().trim().is_empty()
            && !dialog.username.read(cx).value().trim().is_empty();

        let mut card = div()
            .id("conn-test-login-dialog")
            .a11y(Role::Dialog, "settings.passwords.test-login.dialog", title)
            .flex()
            .flex_col()
            .w(px(dialog_w))
            .p(px(20.0))
            .gap(px(14.0))
            .rounded(px(self.geometry.shell_corner_px))
            .bg(hsla(self.tokens.shell_card))
            .border_1()
            .border_color(hsla(self.tokens.shell_inner_border))
            .shadow_lg()
            .font_family(".SystemUIFont")
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(fg)
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" {
                    view.close_dialog(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(15.0))
                            .line_height(px(20.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(fg)
                            .child(title),
                    )
                    .child(
                        div()
                            .text_size(px(self.geometry.ui_font_size_px))
                            .line_height(px(self.geometry.ui_line_height_px))
                            .text_color(muted)
                            .child(
                                "For test users of sites you develop. Agents can sign in with it without a prompt, so keep real accounts in Vault.",
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(self.form_field(
                        "Site",
                        None,
                        Input::new(&dialog.url)
                            .disabled(dialog.saving)
                            .into_any_element(),
                    ))
                    .child(self.form_field(
                        "Username or email",
                        None,
                        Input::new(&dialog.username)
                            .disabled(dialog.saving)
                            .into_any_element(),
                    ))
                    .child(self.form_field(
                        "Password",
                        None,
                        Input::new(&dialog.password)
                            .disabled(dialog.saving)
                            .into_any_element(),
                    ))
                    .child(self.form_field(
                        "Label (optional)",
                        None,
                        Input::new(&dialog.label)
                            .disabled(dialog.saving)
                            .into_any_element(),
                    ))
                    .child(self.form_field(
                        "One-time code secret (optional)",
                        None,
                        Input::new(&dialog.otp_secret)
                            .disabled(dialog.saving)
                            .into_any_element(),
                    )),
            );

        if let Some(err) = &dialog.error {
            card = card.child(
                div()
                    .id("conn-test-login-dialog-error")
                    .a11y_group("settings.passwords.test-login.dialog.error", err.clone())
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(hsla(self.tokens.destructive))
                    .child(err.clone())
                    .test_support(),
            );
        }

        let footer = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(8.0))
            .pt(px(4.0))
            .child(styled_button(
                &self.tokens,
                "settings.passwords.test-login.dialog.cancel".to_owned(),
                "Cancel",
                "Cancel",
                false,
                (!dialog.saving).then(|| {
                    cx.listener(|view, _: &ClickEvent, window, cx| {
                        view.close_dialog(window, cx);
                    })
                }),
            ))
            .child(styled_button(
                &self.tokens,
                "settings.passwords.test-login.dialog.submit".to_owned(),
                submit_label,
                submit_label,
                true,
                can_save.then(|| {
                    cx.listener(|view, _: &ClickEvent, window, cx| {
                        view.submit_test_login(window, cx);
                    })
                }),
            ));

        let card = card.child(footer).test_support();

        deferred(
            anchored().position(point(px(0.0), px(0.0))).child(
                div()
                    .id("conn-test-login-dialog-backdrop")
                    .flex()
                    .items_center()
                    .justify_center()
                    .w(viewport.width)
                    .h(viewport.height)
                    .bg(scrim)
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|view, _, window, cx| {
                            if view.test_login_dialog.as_ref().is_some_and(|d| !d.saving) {
                                view.close_dialog(window, cx);
                            }
                            cx.stop_propagation();
                        }),
                    )
                    .child(card),
            ),
        )
        .with_priority(MODAL_LAYER_PRIORITY + 1)
        .into_any_element()
    }

    fn custom_row(
        &self,
        ax_id: &str,
        title: &str,
        description: Option<String>,
        trailing: AnyElement,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted_raised = hsla(self.tokens.muted_foreground_raised);

        let mut text_col = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap(px(2.0))
            .child(
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(title.to_owned()),
            );

        if let Some(desc) = description {
            text_col = text_col.child(
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(muted_raised)
                    .child(desc),
            );
        }

        div()
            .id(SharedString::from(ax_id.replace('.', "-")))
            .a11y_group(ax_id.to_owned(), title.to_owned())
            .flex()
            .flex_row()
            .items_start()
            .justify_between()
            .gap(px(16.0))
            .w_full()
            .px(px(14.0))
            .py(px(12.0))
            .child(text_col)
            .child(div().flex_shrink_0().child(trailing))
            .test_support()
            .into_any_element()
    }

    fn status_row(&self, ax_id: &str, text: &str, error: bool) -> AnyElement {
        let color = if error {
            hsla(self.tokens.destructive)
        } else {
            hsla(self.tokens.muted_foreground_raised)
        };
        div()
            .id(SharedString::from(ax_id.replace('.', "-")))
            .a11y_group(ax_id.to_owned(), text.to_owned())
            .w_full()
            .px(px(14.0))
            .py(px(10.0))
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(color)
            .child(text.to_owned())
            .test_support()
            .into_any_element()
    }

    fn form_field(
        &self,
        label: &str,
        description: Option<&str>,
        control: AnyElement,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);

        let mut col = div()
            .flex()
            .flex_col()
            .gap(px(5.0))
            .w_full()
            .child(
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(label.to_owned()),
            )
            .child(control);

        if let Some(desc) = description {
            col = col.child(
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(muted)
                    .child(desc.to_owned()),
            );
        }

        col.into_any_element()
    }
}

/// A [`styled_button`] with a leading spinner while `busy`, like web's
/// `{busy && <Spinner data-icon="inline-start" />}` inside a disabled `Button`. The button is not
/// clickable while `on_click` is `None`.
fn busy_button(
    tokens: &Tokens,
    ax_id: String,
    label: &str,
    primary: bool,
    busy: bool,
    on_click: Option<impl Fn(&ClickEvent, &mut Window, &mut App) + 'static>,
) -> AnyElement {
    let disabled_primary = primary && on_click.is_none();
    let (primary_bg, primary_fg) = if disabled_primary {
        crate::theme::disabled_primary(tokens)
    } else {
        (hsla(tokens.primary), hsla(tokens.primary_foreground))
    };
    let fg = if primary {
        primary_fg
    } else {
        hsla(tokens.foreground)
    };
    let hover = hsla(tokens.shell_highlight);
    let spinner = busy.then(|| {
        crate::panels::header::superhero_icon("superhero/spinner.svg", 12.0, fg).with_animation(
            SharedString::from(format!("{ax_id}-spinner")),
            Animation::new(std::time::Duration::from_secs(1)).repeat(),
            |icon, delta| icon.with_transformation(Transformation::rotate(percentage(delta))),
        )
    });
    let base = div()
        .id(SharedString::from(ax_id.clone()))
        .a11y_button(ax_id, label.to_owned())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .h(px(28.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .text_size(px(12.0))
        .text_color(fg)
        .when(primary, |el| el.bg(primary_bg))
        .when(!primary, |el| {
            el.border_1().border_color(hsla_alpha(tokens.border, 0.8))
        })
        .children(spinner)
        .child(label.to_owned());
    match on_click {
        Some(on_click) => base
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
            .test_support()
            .into_any_element(),
        // A disabled primary button keeps its muted primary fill instead of fading.
        None => base
            .when(!primary, |el| el.opacity(0.5))
            .test_support()
            .into_any_element(),
    }
}

fn clear_vaultwarden_form_inputs(
    form: &VaultwardenForm,
    window: &mut Window,
    cx: &mut Context<'_, PasswordsView>,
) {
    for input in [
        &form.server,
        &form.client_id,
        &form.client_secret,
        &form.master_password,
    ] {
        input.update(cx, |state, cx| state.set_value(String::new(), window, cx));
    }
}

/// The update an edit dialog sends. The password and OTP fields hold the stored values only once
/// the reveal has loaded them; after a failed reveal an empty field means "never loaded", not
/// "cleared", so it is left out and the server keeps the stored value.
fn update_test_login_input(
    id: String,
    url: String,
    username: String,
    label: String,
    password: String,
    otp_secret: String,
    secrets: SecretsLoad,
) -> UpdateTestLoginInput {
    let revealed = secrets != SecretsLoad::Failed;
    UpdateTestLoginInput {
        id,
        url: Some(url),
        username: Some(username),
        label: Some(label),
        password: (revealed || !password.is_empty()).then_some(password),
        otp_secret: (revealed || !otp_secret.is_empty())
            .then(|| (!otp_secret.is_empty()).then_some(otp_secret)),
    }
}

fn clear_test_login_dialog_inputs(
    dialog: &TestLoginDialogState,
    window: &mut Window,
    cx: &mut Context<'_, PasswordsView>,
) {
    for input in [
        &dialog.url,
        &dialog.username,
        &dialog.password,
        &dialog.label,
        &dialog.otp_secret,
    ] {
        input.update(cx, |state, cx| state.set_value(String::new(), window, cx));
    }
}

impl Render for PasswordsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let mut page = div()
            .id("settings-passwords-page")
            .a11y_region("settings.passwords.page", "Passwords")
            .flex()
            .flex_col()
            .w_full()
            .gap(px(20.0))
            .child(self.render_vaultwarden_section(cx))
            .child(self.render_password_manager_section(cx))
            .child(self.render_test_logins_section(cx))
            .child(self.render_protection_section(cx));

        if let Some(dialog) = &self.test_login_dialog {
            page = page.child(self.render_test_login_dialog(dialog, window, cx));
        }

        page.test_support()
    }
}
