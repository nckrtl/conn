//! Bridge to the Vault Mac app (`Vault --conn-bridge`), matching Conn's
//! `apps/desktop/src/ipc/methods/vault.ts` and `apps/desktop/src/vault/Logins.ts`.
//!
//! Each request starts `/Applications/Vault.app/Contents/MacOS/Vault --conn-bridge` over stdio
//! pipes and exchanges one 4-byte little-endian length-prefixed JSON frame. Stdin stays open until
//! Vault sends its reply (the relay treats EOF as caller disconnect). Passwords and OTP codes are
//! never persisted to disk and live only for the single database open or browser fill call.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;

use crate::database::DatabaseDriver;

/// Default Vault Mac app binary path.
pub const VAULT_BINARY: &str = "/Applications/Vault.app/Contents/MacOS/Vault";

/// Touch ID or master-password unlock can take a while before Vault replies.
const TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound for a login status check, which never prompts the user.
const STATUS_DEADLINE: Duration = Duration::from_secs(15);
/// Maximum accepted reply frame length (64 KiB, matching Conn's `MAX_FRAME`).
const MAX_FRAME: usize = 64 * 1024;

/// TLS requirement reported by a Vault Database entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum VaultTls {
    #[serde(rename = "disabled")]
    Disabled,
    #[serde(rename = "required")]
    Required,
    #[serde(rename = "verify-ca")]
    VerifyCa,
    #[serde(rename = "verify-full")]
    VerifyFull,
}

/// High-level status returned by the Vault bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultErrorKind {
    Locked,
    Unavailable,
    Error,
}

/// Failure talking to the Vault Mac app bridge.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct VaultError {
    pub kind: VaultErrorKind,
    pub message: String,
}

impl VaultError {
    #[must_use]
    pub fn new(kind: VaultErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    #[must_use]
    pub fn locked() -> Self {
        Self::new(
            VaultErrorKind::Locked,
            "Vault is locked. Unlock Vault to use this connection.",
        )
    }

    #[must_use]
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(VaultErrorKind::Unavailable, message)
    }
}

/// A Database entry listed by Vault (never contains a password).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDatabase {
    pub id: String,
    pub name: String,
    pub driver: DatabaseDriver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub tls: VaultTls,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub organization: Option<String>,
}

/// One Vault Database entry together with its transient password and SSH agent socket.
#[derive(Clone, PartialEq, Eq)]
pub struct VaultDatabaseCredential {
    pub database: VaultDatabase,
    pub password: String,
    pub ssh_agent: Option<String>,
}

impl fmt::Debug for VaultDatabaseCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VaultDatabaseCredential")
            .field("database", &self.database)
            .field("password", &"<redacted>")
            .field("ssh_agent", &self.ssh_agent)
            .finish()
    }
}

/// Login field supported by Vault autofill (`CredentialField`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultLoginField {
    Username,
    Password,
    Otp,
}

impl VaultLoginField {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
            Self::Otp => "otp",
        }
    }
}

/// One login suggestion returned by Vault for an HTTPS origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLoginItem {
    pub id: String,
    pub title: String,
    pub username: Option<String>,
    pub source: String,
    /// The site icon Vault stores for this login, as PNG bytes (already base64-decoded and
    /// checked). `None` when Vault sent none, or sent one that failed the checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_png: Option<Vec<u8>>,
}

/// Longest accepted `icon` text. Vault sends at most 8,000 characters (a 6,000-byte PNG).
const MAX_ICON_BASE64: usize = 12_000;
/// Largest accepted decoded icon.
const MAX_ICON_BYTES: usize = 9_000;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Decodes the optional `icon` of a Vault login suggestion: standard base64 of a PNG, within the
/// size limits. Anything else gives `None`, and the login is still listed.
#[must_use]
pub fn decode_login_icon(icon: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    if icon.is_empty() || icon.len() > MAX_ICON_BASE64 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(icon)
        .ok()?;
    (bytes.len() > PNG_SIGNATURE.len()
        && bytes.len() <= MAX_ICON_BYTES
        && bytes.starts_with(&PNG_SIGNATURE))
    .then_some(bytes)
}

/// Result of querying Vault login status or suggestions for a page URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLoginsResponse {
    pub status: VaultLoginsStatus,
    pub items: Vec<VaultLoginItem>,
    pub error: Option<String>,
}

/// Status tag for [`VaultLoginsResponse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultLoginsStatus {
    Ok,
    Locked,
    Unavailable,
    Error,
}

/// Result of looking up one login field for browser autofill.
#[derive(Clone, PartialEq, Eq)]
pub enum VaultLoginFillLookup {
    Value(String),
    OriginMismatch,
    ItemNotFound,
    Denied,
    NoValue,
    InsertFailed,
    ProviderUnavailable,
}

impl fmt::Debug for VaultLoginFillLookup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Value(_) => f.write_str("Value(<redacted>)"),
            Self::OriginMismatch => f.write_str("OriginMismatch"),
            Self::ItemNotFound => f.write_str("ItemNotFound"),
            Self::Denied => f.write_str("Denied"),
            Self::NoValue => f.write_str("NoValue"),
            Self::InsertFailed => f.write_str("InsertFailed"),
            Self::ProviderUnavailable => f.write_str("ProviderUnavailable"),
        }
    }
}

/// Returns `https://host[:port]` when `value` is a valid HTTPS URL without embedded credentials.
#[must_use]
pub fn https_origin(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value).ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" { None } else { Some(origin) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest<'a> {
    version: u8,
    id: String,
    kind: &'a str,
    mode: &'a str,
    #[serde(skip_serializing_if = "Option::is_none", rename = "itemID")]
    item_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<&'a str>,
    allow_unlock: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDatabase {
    id: String,
    name: String,
    driver: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    tls: String,
    password: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_user: Option<String>,
    organization: Option<String>,
}

#[derive(Deserialize)]
struct WireSuggestion {
    id: String,
    name: String,
    #[serde(default)]
    username: String,
    /// Optional base64 PNG of the site's icon (Vault build 139 and later).
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Deserialize)]
struct WireCredential {
    mode: String,
    username: Option<String>,
    password: Option<String>,
    code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeReply {
    status: Option<String>,
    message: Option<String>,
    databases: Option<Vec<WireDatabase>>,
    database: Option<WireDatabase>,
    ssh_agent: Option<String>,
    suggestions: Option<Vec<WireSuggestion>>,
    #[serde(rename = "itemID")]
    item_id: Option<String>,
    credential: Option<WireCredential>,
}

/// Only the `id` of a reply frame, to find ours before reading the rest.
#[derive(Deserialize)]
struct ReplyId {
    id: Option<String>,
}

/// Which WebAuthn ceremony Vault runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasskeyMode {
    /// `navigator.credentials.create`.
    Create,
    /// `navigator.credentials.get`.
    Get,
}

impl PasskeyMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Create => "passkey-create",
            Self::Get => "passkey-get",
        }
    }
}

/// The `DOMException` a failed ceremony rejects with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PasskeyError {
    NotAllowed,
    InvalidState,
    Security,
    NotSupported,
    Abort,
}

impl PasskeyError {
    /// The `DOMException` name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::NotAllowed => "NotAllowedError",
            Self::InvalidState => "InvalidStateError",
            Self::Security => "SecurityError",
            Self::NotSupported => "NotSupportedError",
            Self::Abort => "AbortError",
        }
    }

    /// Maps a name Vault sent. A name Conn does not know is a refusal, as in the Chrome
    /// extension and Conn's Electron bridge.
    #[must_use]
    pub fn from_name(name: &str) -> Self {
        match name {
            "InvalidStateError" => Self::InvalidState,
            "SecurityError" => Self::Security,
            "NotSupportedError" => Self::NotSupported,
            "AbortError" => Self::Abort,
            _ => Self::NotAllowed,
        }
    }
}

/// Largest `url` Vault accepts in a passkey request.
pub const PASSKEY_URL_MAX_BYTES: usize = 8192;
/// Largest `options` string Vault accepts in a passkey request.
pub const PASSKEY_OPTIONS_MAX_BYTES: usize = 12_000;

/// A passkey request carries exactly these fields: Vault refuses any other.
#[derive(Serialize)]
struct PasskeyBridgeRequest<'a> {
    version: u8,
    id: &'a str,
    kind: &'static str,
    mode: &'static str,
    url: &'a str,
    options: &'a str,
}

#[derive(Deserialize)]
struct PasskeyReply {
    status: Option<String>,
    passkey: Option<String>,
    error: Option<String>,
}

/// Reads Vault's passkey reply: the credential JSON string on `ok`, else the error to reject with.
fn parse_passkey_reply(payload: &[u8]) -> Result<String, PasskeyError> {
    let reply: PasskeyReply =
        serde_json::from_slice(payload).map_err(|_| PasskeyError::NotAllowed)?;
    match reply.status.as_deref() {
        Some("ok") => {
            let passkey = reply.passkey.ok_or(PasskeyError::NotAllowed)?;
            // The page shim parses it: refuse anything that is not a JSON object.
            match serde_json::from_str::<serde_json::Value>(&passkey) {
                Ok(serde_json::Value::Object(_)) => Ok(passkey),
                _ => Err(PasskeyError::NotAllowed),
            }
        }
        Some("error") => Err(reply
            .error
            .as_deref()
            .map_or(PasskeyError::NotAllowed, PasskeyError::from_name)),
        _ => Err(PasskeyError::NotAllowed),
    }
}

fn parse_wire_database(wire: WireDatabase) -> Option<(VaultDatabase, Option<String>)> {
    let driver = match wire.driver.as_str() {
        "postgresql" | "pgsql" => DatabaseDriver::Pgsql,
        "mysql" => DatabaseDriver::Mysql,
        _ => return None,
    };
    let tls = match wire.tls.as_str() {
        "disabled" => VaultTls::Disabled,
        "required" => VaultTls::Required,
        "verify-ca" => VaultTls::VerifyCa,
        "verify-full" => VaultTls::VerifyFull,
        _ => return None,
    };
    let password = wire.password;
    let db = VaultDatabase {
        id: wire.id,
        name: wire.name,
        driver,
        host: wire.host,
        port: wire.port,
        database: wire.database,
        username: wire.username,
        tls,
        ssh_host: wire.ssh_host,
        ssh_port: wire.ssh_port,
        ssh_user: wire.ssh_user,
        organization: wire.organization,
    };
    Some((db, password))
}

fn failure_from_reply(reply: &BridgeReply) -> VaultError {
    if reply.status.as_deref() == Some("locked") {
        VaultError::locked()
    } else {
        VaultError::new(
            VaultErrorKind::Error,
            reply
                .message
                .clone()
                .unwrap_or_else(|| "Vault did not return the entry.".to_owned()),
        )
    }
}

/// Client for Vault's `--conn-bridge` stdio relay.
#[derive(Debug, Clone)]
pub struct VaultClient {
    binary: PathBuf,
    timeout: Duration,
}

impl Default for VaultClient {
    fn default() -> Self {
        Self::new()
    }
}

impl VaultClient {
    /// Creates a client targeting `/Applications/Vault.app/Contents/MacOS/Vault`.
    #[must_use]
    pub fn new() -> Self {
        Self {
            binary: PathBuf::from(VAULT_BINARY),
            timeout: TIMEOUT,
        }
    }

    /// Creates a client targeting a custom binary (used by tests).
    #[must_use]
    pub fn with_binary(binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            timeout: TIMEOUT,
        }
    }

    /// Sets a custom per-request timeout.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Path to the configured Vault binary.
    #[must_use]
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// Whether the Vault binary exists on disk.
    #[must_use]
    pub fn is_installed(&self) -> bool {
        self.binary.exists()
    }

    /// Lists all Database entries in Vault (without passwords).
    ///
    /// # Errors
    ///
    /// Returns [`VaultError`] when Vault is missing, locked, refuses the signature, or errors.
    pub async fn list_databases(
        &self,
        allow_unlock: bool,
    ) -> Result<Vec<VaultDatabase>, VaultError> {
        let reply = self
            .send_request("database", "list-database", None, None, None, allow_unlock)
            .await?;
        if reply.status.as_deref() != Some("databases") {
            return Err(failure_from_reply(&reply));
        }
        let list = reply
            .databases
            .unwrap_or_default()
            .into_iter()
            .filter_map(|wire| parse_wire_database(wire).map(|(db, _)| db))
            .collect();
        Ok(list)
    }

    /// Fetches one Database entry with its password and optional Vault SSH agent socket.
    ///
    /// # Errors
    ///
    /// Returns [`VaultError`] when Vault is missing, locked, refuses the signature, or has no
    /// matching entry.
    pub async fn database_credential(
        &self,
        item_id: &str,
        allow_unlock: bool,
    ) -> Result<VaultDatabaseCredential, VaultError> {
        let reply = self
            .send_request(
                "database",
                "database-credential",
                Some(item_id),
                None,
                None,
                allow_unlock,
            )
            .await?;
        if reply.status.as_deref() != Some("ok") {
            return Err(failure_from_reply(&reply));
        }
        let ssh_agent = reply.ssh_agent.clone();
        let Some(wire) = reply.database else {
            return Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not return the entry.",
            ));
        };
        let Some((database, Some(password))) = parse_wire_database(wire) else {
            return Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not return the entry.",
            ));
        };
        Ok(VaultDatabaseCredential {
            database,
            password,
            ssh_agent,
        })
    }

    /// Queries whether Vault is currently unlocked without prompting.
    ///
    /// A status check never waits for Touch ID or a master password, so the whole exchange
    /// (spawning the relay, the reply, and stopping the relay) is capped at [`STATUS_DEADLINE`]
    /// instead of the 120 second unlock allowance. A relay that never answers then ends in an
    /// error the caller can show and retry, rather than an endless "checking" state.
    pub async fn login_status(&self) -> VaultLoginsResponse {
        let deadline = self.timeout.min(STATUS_DEADLINE);
        let reply = match tokio::time::timeout(
            deadline,
            self.send_request("login", "status", None, None, None, false),
        )
        .await
        {
            Ok(reply) => reply,
            Err(_) => Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not answer in time.",
            )),
        };
        match reply {
            Ok(reply) => match reply.status.as_deref() {
                Some("unlocked") => VaultLoginsResponse {
                    status: VaultLoginsStatus::Ok,
                    items: Vec::new(),
                    error: None,
                },
                Some("locked" | "cancelled") => VaultLoginsResponse {
                    status: VaultLoginsStatus::Locked,
                    items: Vec::new(),
                    error: None,
                },
                _ => VaultLoginsResponse {
                    status: VaultLoginsStatus::Error,
                    items: Vec::new(),
                    error: Some(
                        "Vault did not return logins. Update Vault and try again.".to_owned(),
                    ),
                },
            },
            Err(err) => logins_error_response(err),
        }
    }

    /// Lists Vault login suggestions for an HTTPS page URL. Non-HTTPS URLs return an empty `ok`
    /// list without invoking Vault (matching `Logins.ts`).
    pub async fn list_logins(&self, url: &str, allow_unlock: bool) -> VaultLoginsResponse {
        if https_origin(url).is_none() {
            return VaultLoginsResponse {
                status: VaultLoginsStatus::Ok,
                items: Vec::new(),
                error: None,
            };
        }
        match self
            .send_request("login", "list-login", None, Some(url), None, allow_unlock)
            .await
        {
            Ok(reply) => match reply.status.as_deref() {
                Some("locked" | "cancelled") => VaultLoginsResponse {
                    status: VaultLoginsStatus::Locked,
                    items: Vec::new(),
                    error: None,
                },
                Some("suggestions") => {
                    let items = reply
                        .suggestions
                        .unwrap_or_default()
                        .into_iter()
                        .map(|s| VaultLoginItem {
                            id: s.id.to_ascii_lowercase(),
                            title: s.name,
                            username: if s.username.is_empty() {
                                None
                            } else {
                                Some(s.username)
                            },
                            source: "vault".to_owned(),
                            icon_png: s.icon.as_deref().and_then(decode_login_icon),
                        })
                        .collect();
                    VaultLoginsResponse {
                        status: VaultLoginsStatus::Ok,
                        items,
                        error: None,
                    }
                }
                _ => VaultLoginsResponse {
                    status: VaultLoginsStatus::Error,
                    items: Vec::new(),
                    error: Some(
                        "Vault did not return logins. Update Vault and try again.".to_owned(),
                    ),
                },
            },
            Err(err) => logins_error_response(err),
        }
    }

    /// Reads one selected login field for `page_url` after verifying `expected_origin`.
    pub async fn login_credential(
        &self,
        page_url: &str,
        expected_origin: &str,
        item_id: &str,
        field: VaultLoginField,
    ) -> VaultLoginFillLookup {
        if https_origin(expected_origin).is_none()
            || https_origin(page_url).as_deref() != Some(expected_origin)
        {
            return VaultLoginFillLookup::OriginMismatch;
        }
        let reply = match self
            .send_request(
                "login",
                "login-credential",
                Some(item_id),
                Some(page_url),
                Some(field.as_str()),
                true,
            )
            .await
        {
            Ok(reply) => reply,
            Err(_) => return VaultLoginFillLookup::ProviderUnavailable,
        };
        match reply.status.as_deref() {
            Some("item-not-found") => return VaultLoginFillLookup::ItemNotFound,
            Some("locked" | "cancelled") => return VaultLoginFillLookup::Denied,
            Some("ok") => {}
            _ => return VaultLoginFillLookup::InsertFailed,
        }
        if !reply
            .item_id
            .as_deref()
            .is_some_and(|got| got.eq_ignore_ascii_case(item_id))
        {
            return VaultLoginFillLookup::InsertFailed;
        }
        let Some(cred) = reply.credential else {
            return VaultLoginFillLookup::InsertFailed;
        };
        if cred.mode != field.as_str() {
            return VaultLoginFillLookup::InsertFailed;
        }
        let value = match field {
            VaultLoginField::Username => cred.username,
            VaultLoginField::Password => cred.password,
            VaultLoginField::Otp => cred.code,
        };
        match value {
            Some(v) if !v.is_empty() => VaultLoginFillLookup::Value(v),
            _ => VaultLoginFillLookup::NoValue,
        }
    }

    /// Runs one passkey ceremony in Vault, which is the authenticator.
    ///
    /// `url` is the page's exact HTTPS top-frame address and `options` the `{publicKey: …}` string
    /// in the Chrome extension's wire format. Both come from Conn, never from the page. Vault
    /// waits for a person (Touch ID), so the call waits as long as the client timeout allows.
    /// Closing the pipe with no reply (an older Vault) rejects with `NotAllowedError`, and so does
    /// every other failure to reach Vault.
    ///
    /// # Errors
    ///
    /// Returns the [`PasskeyError`] the page's promise rejects with.
    pub async fn passkey(
        &self,
        mode: PasskeyMode,
        url: &str,
        options: &str,
    ) -> Result<String, PasskeyError> {
        if https_origin(url).is_none() || url.len() > PASSKEY_URL_MAX_BYTES {
            return Err(PasskeyError::Security);
        }
        if options.is_empty() || options.len() > PASSKEY_OPTIONS_MAX_BYTES {
            return Err(PasskeyError::NotSupported);
        }
        if !self.binary.exists() {
            return Err(PasskeyError::NotAllowed);
        }
        let request_id = next_request_id();
        let body = serde_json::to_vec(&PasskeyBridgeRequest {
            version: 1,
            id: &request_id,
            kind: "passkey",
            mode: mode.as_str(),
            url,
            options,
        })
        .map_err(|_| PasskeyError::NotSupported)?;
        let payload = self
            .exchange(&request_id, &body)
            .await
            .map_err(|_| PasskeyError::NotAllowed)?;
        parse_passkey_reply(&payload)
    }

    async fn send_request(
        &self,
        kind: &str,
        mode: &str,
        item_id: Option<&str>,
        url: Option<&str>,
        field: Option<&str>,
        allow_unlock: bool,
    ) -> Result<BridgeReply, VaultError> {
        if !self.binary.exists() {
            return Err(VaultError::unavailable(
                "Vault is not installed on this Mac.",
            ));
        }

        let request_id = next_request_id();
        let payload = BridgeRequest {
            version: 1,
            id: request_id.clone(),
            kind,
            mode,
            item_id,
            url,
            field,
            allow_unlock,
        };
        let body = serde_json::to_vec(&payload)
            .map_err(|err| VaultError::new(VaultErrorKind::Error, err.to_string()))?;
        let payload = self.exchange(&request_id, &body).await?;
        serde_json::from_slice(&payload)
            .map_err(|_| VaultError::new(VaultErrorKind::Error, "Vault sent an invalid reply."))
    }

    /// Sends one framed request to a fresh `--conn-bridge` process and returns the raw payload of
    /// the reply whose `id` is `request_id`. Closing the pipe without a reply (an older Vault, or a
    /// refused caller) is an error. The child dies with the call, which Vault reads as the caller
    /// going away, so dropping the future cancels a pending ceremony.
    async fn exchange(&self, request_id: &str, body: &[u8]) -> Result<Vec<u8>, VaultError> {
        let body_len = u32::try_from(body.len())
            .map_err(|_| VaultError::new(VaultErrorKind::Error, "Vault request is too large."))?;
        let mut child = Command::new(&self.binary)
            .arg("--conn-bridge")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| VaultError::unavailable(err.to_string()))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| VaultError::unavailable("Vault bridge stdin unavailable."))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| VaultError::unavailable("Vault bridge stdout unavailable."))?;

        // Keep stdin open until the reply arrives: the relay treats EOF as caller disconnect.
        let mut frame = Vec::with_capacity(4 + body.len());
        frame.extend_from_slice(&body_len.to_le_bytes());
        frame.extend_from_slice(body);
        if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() {
            let _ = child.kill().await;
            return Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault refused the request. Update Vault, and use the signed Conn app.",
            ));
        }

        let read_reply = async {
            loop {
                let mut len_buf = [0u8; 4];
                if let Err(err) = stdout.read_exact(&mut len_buf).await {
                    return if err.kind() == std::io::ErrorKind::UnexpectedEof {
                        Err(VaultError::new(
                            VaultErrorKind::Error,
                            "Vault refused the request. Update Vault, and use the signed Conn app.",
                        ))
                    } else {
                        Err(VaultError::new(VaultErrorKind::Error, err.to_string()))
                    };
                }
                let size = u32::from_le_bytes(len_buf) as usize;
                if size == 0 || size > MAX_FRAME {
                    return Err(VaultError::new(
                        VaultErrorKind::Error,
                        "Vault sent an invalid reply.",
                    ));
                }
                let mut payload_buf = vec![0u8; size];
                if stdout.read_exact(&mut payload_buf).await.is_err() {
                    return Err(VaultError::new(
                        VaultErrorKind::Error,
                        "Vault sent an invalid reply.",
                    ));
                }
                let reply: ReplyId = serde_json::from_slice(&payload_buf).map_err(|_| {
                    VaultError::new(VaultErrorKind::Error, "Vault sent an invalid reply.")
                })?;
                if reply.id.as_deref() == Some(request_id) {
                    return Ok(payload_buf);
                }
            }
        };

        let result = match tokio::time::timeout(self.timeout, read_reply).await {
            Ok(inner) => inner,
            Err(_) => Err(VaultError::new(
                VaultErrorKind::Error,
                "Vault did not answer in time.",
            )),
        };

        drop(stdin);
        let _ = child.kill().await;
        result
    }
}

fn next_request_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0u128, |d| d.as_nanos());
    let hi = (nanos as u64) ^ (u64::from(std::process::id()) << 32);
    let lo = ((nanos >> 64) as u64) ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!(
        "{:08X}-{:04X}-4{:03X}-{:04X}-{:012X}",
        (hi >> 32) as u32,
        ((hi >> 16) & 0xFFFF) as u16,
        (hi & 0x0FFF) as u16,
        ((lo >> 48) & 0x3FFF) | 0x8000,
        lo & 0x0000_FFFF_FFFF_FFFF,
    )
}

fn logins_error_response(error: VaultError) -> VaultLoginsResponse {
    let status = match error.kind {
        VaultErrorKind::Locked => VaultLoginsStatus::Locked,
        VaultErrorKind::Unavailable => VaultLoginsStatus::Unavailable,
        VaultErrorKind::Error => VaultLoginsStatus::Error,
    };
    let msg = if error.kind == VaultErrorKind::Unavailable {
        "Vault is not installed on this Mac.".to_owned()
    } else {
        "Vault could not answer. Open or update Vault and try again.".to_owned()
    };
    VaultLoginsResponse {
        status,
        items: Vec::new(),
        error: Some(msg),
    }
}

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests assert expected bridge frames and use ? for setup"
)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn write_fake_vault(script_body: &str) -> Result<(tempfile::TempDir, PathBuf), std::io::Error> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("fake-vault");
        let full = format!("#!/usr/bin/env python3\n{script_body}");
        std::fs::write(&path, full)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        Ok((dir, path))
    }

    /// A relay that answers a login `status` request with `locked`, then keeps stdin and stdout
    /// open like the real `Vault --conn-bridge` does until its parent hangs up.
    const LOCKED_STATUS_RELAY: &str = r#"
import json, struct, sys, time

raw_len = sys.stdin.buffer.read(4)
size = struct.unpack("<I", raw_len)[0]
req = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
assert req["kind"] == "login" and req["mode"] == "status", req
assert req["allowUnlock"] is False, req
for key in ("url", "itemID", "field"):
    assert key not in req, req

body = json.dumps({"id": req["id"], "status": "locked"}).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
time.sleep(60)
"#;

    #[tokio::test]
    async fn login_status_returns_locked_promptly_while_the_relay_stays_open()
    -> Result<(), Box<dyn std::error::Error>> {
        let (_dir, bin) = write_fake_vault(LOCKED_STATUS_RELAY)?;
        let client = VaultClient::with_binary(&bin).with_timeout(Duration::from_secs(20));

        let started = std::time::Instant::now();
        let response = client.login_status().await;
        assert_eq!(response.status, VaultLoginsStatus::Locked);
        assert!(response.items.is_empty());
        assert_eq!(response.error, None);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "login_status waited for the relay to exit: {:?}",
            started.elapsed()
        );
        Ok(())
    }

    #[tokio::test]
    async fn login_status_gives_up_when_the_relay_never_answers()
    -> Result<(), Box<dyn std::error::Error>> {
        let script = r#"
import sys, time

sys.stdin.buffer.read(4)
time.sleep(60)
"#;
        let (_dir, bin) = write_fake_vault(script)?;
        let client = VaultClient::with_binary(&bin).with_timeout(Duration::from_millis(400));

        let started = std::time::Instant::now();
        let response = client.login_status().await;
        assert_eq!(response.status, VaultLoginsStatus::Error);
        assert!(response.error.is_some());
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "login_status ignored its deadline: {:?}",
            started.elapsed()
        );
        Ok(())
    }

    #[tokio::test]
    async fn login_status_skips_frames_for_other_requests() -> Result<(), Box<dyn std::error::Error>>
    {
        let script = r#"
import json, struct, sys

raw_len = sys.stdin.buffer.read(4)
size = struct.unpack("<I", raw_len)[0]
req = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))

def send(reply):
    body = json.dumps(reply).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
    sys.stdout.buffer.flush()

send({"id": "00000000-0000-4000-8000-000000000000", "status": "locked"})
send({"id": req["id"], "status": "unlocked"})
"#;
        let (_dir, bin) = write_fake_vault(script)?;
        let client = VaultClient::with_binary(&bin).with_timeout(Duration::from_secs(20));
        let response = client.login_status().await;
        assert_eq!(response.status, VaultLoginsStatus::Ok);
        Ok(())
    }

    #[tokio::test]
    async fn unavailable_when_binary_missing() {
        let client = VaultClient::with_binary("/nonexistent/Vault");
        let err = client.list_databases(false).await.unwrap_err();
        assert_eq!(err.kind, VaultErrorKind::Unavailable);
        assert!(err.message.contains("not installed"));
    }

    #[tokio::test]
    async fn lists_databases_and_fetches_credentials_and_logins()
    -> Result<(), Box<dyn std::error::Error>> {
        let script = r#"
import json, struct, sys

raw_len = sys.stdin.buffer.read(4)
size = struct.unpack("<I", raw_len)[0]
req = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
rid = req["id"]

if req["mode"] == "list-database":
    reply = {
        "id": rid,
        "status": "databases",
        "databases": [
            {
                "id": "item-1",
                "name": "Production",
                "driver": "postgresql",
                "host": "127.0.0.1",
                "port": 5432,
                "database": "app",
                "username": "readonly",
                "tls": "verify-full",
                "sshHost": "bastion.example.com",
                "sshPort": 22,
                "sshUser": "deploy",
                "organization": "Acme",
            }
        ],
    }
elif req["mode"] == "database-credential":
    reply = {
        "id": rid,
        "status": "ok",
        "sshAgent": "/tmp/vault-agent.sock",
        "database": {
            "id": req["itemID"],
            "name": "Production",
            "driver": "postgresql",
            "host": "127.0.0.1",
            "port": 5432,
            "database": "app",
            "username": "readonly",
            "password": "s3cr3t-password",
            "tls": "required",
        },
    }
elif req["mode"] == "list-login":
    reply = {
        "id": rid,
        "status": "suggestions",
        "suggestions": [
            {"id": "ABC-123", "name": "GitHub", "username": "nick@example.com"}
        ],
    }
elif req["mode"] == "login-credential":
    reply = {
        "id": rid,
        "status": "ok",
        "itemID": req["itemID"],
        "credential": {"mode": req["field"], "password": "vault-login-pass"},
    }
else:
    reply = {"id": rid, "status": "locked"}

body = json.dumps(reply).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
"#;
        let (_dir, bin) = write_fake_vault(script)?;
        let client = VaultClient::with_binary(&bin);

        let dbs = client.list_databases(false).await?;
        assert_eq!(dbs.len(), 1);
        assert_eq!(dbs[0].driver, DatabaseDriver::Pgsql);
        assert_eq!(dbs[0].tls, VaultTls::VerifyFull);
        assert_eq!(dbs[0].organization.as_deref(), Some("Acme"));

        let cred = client.database_credential("item-1", true).await?;
        assert_eq!(cred.password, "s3cr3t-password");
        assert_eq!(cred.ssh_agent.as_deref(), Some("/tmp/vault-agent.sock"));
        assert!(!format!("{cred:?}").contains("s3cr3t-password"));

        let http_logins = client.list_logins("http://example.com/login", false).await;
        assert_eq!(http_logins.status, VaultLoginsStatus::Ok);
        assert!(http_logins.items.is_empty());

        let https_logins = client.list_logins("https://github.com/login", false).await;
        assert_eq!(https_logins.status, VaultLoginsStatus::Ok);
        assert_eq!(https_logins.items.len(), 1);
        assert_eq!(https_logins.items[0].id, "abc-123");

        let lookup = client
            .login_credential(
                "https://github.com/login",
                "https://github.com",
                "abc-123",
                VaultLoginField::Password,
            )
            .await;
        assert_eq!(
            lookup,
            VaultLoginFillLookup::Value("vault-login-pass".to_owned())
        );

        let mismatch = client
            .login_credential(
                "https://evil.example/login",
                "https://github.com",
                "abc-123",
                VaultLoginField::Password,
            )
            .await;
        assert_eq!(mismatch, VaultLoginFillLookup::OriginMismatch);
        Ok(())
    }

    /// A 1 × 1 PNG, base64.
    const TINY_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn a_login_icon_is_a_small_base64_png_or_nothing() {
        use base64::Engine as _;
        let png = decode_login_icon(TINY_PNG).expect("a valid icon");
        assert!(png.starts_with(&PNG_SIGNATURE));

        assert_eq!(decode_login_icon(""), None, "empty");
        assert_eq!(decode_login_icon("not base64 !!"), None, "invalid base64");
        let text = base64::engine::general_purpose::STANDARD.encode(b"GIF89a plus more bytes");
        assert_eq!(decode_login_icon(&text), None, "not a PNG");
        let signature_only = base64::engine::general_purpose::STANDARD.encode(PNG_SIGNATURE);
        assert_eq!(decode_login_icon(&signature_only), None, "no image data");
        let mut huge = PNG_SIGNATURE.to_vec();
        huge.resize(MAX_ICON_BYTES + 1, 0);
        let huge = base64::engine::general_purpose::STANDARD.encode(huge);
        assert!(huge.len() > MAX_ICON_BASE64);
        assert_eq!(decode_login_icon(&huge), None, "oversized");
        let mut largest = PNG_SIGNATURE.to_vec();
        largest.resize(MAX_ICON_BYTES, 0);
        let largest = base64::engine::general_purpose::STANDARD.encode(largest);
        assert!(largest.len() <= MAX_ICON_BASE64);
        assert!(decode_login_icon(&largest).is_some(), "the largest allowed");
    }

    #[tokio::test]
    async fn logins_carry_an_icon_only_when_vault_sent_a_valid_one()
    -> Result<(), Box<dyn std::error::Error>> {
        let script = format!(
            r#"
import json, struct, sys

size = struct.unpack("<I", sys.stdin.buffer.read(4))[0]
req = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
reply = {{
    "id": req["id"],
    "status": "suggestions",
    "suggestions": [
        {{"id": "AAA", "name": "With icon", "username": "a@example.com", "icon": "{TINY_PNG}"}},
        {{"id": "BBB", "name": "No icon", "username": "b@example.com"}},
        {{"id": "CCC", "name": "Bad icon", "username": "c@example.com", "icon": "!!not-base64!!"}},
        {{"id": "DDD", "name": "Wrong type", "username": "d@example.com", "icon": "R0lGODlhAQABAAAAACw="}},
    ],
}}
body = json.dumps(reply).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
"#
        );
        let (_dir, bin) = write_fake_vault(&script)?;
        let client = VaultClient::with_binary(&bin);
        let logins = client.list_logins("https://example.com/login", false).await;
        assert_eq!(logins.status, VaultLoginsStatus::Ok);
        let icons: Vec<(&str, bool)> = logins
            .items
            .iter()
            .map(|item| (item.title.as_str(), item.icon_png.is_some()))
            .collect();
        assert_eq!(
            icons,
            vec![
                ("With icon", true),
                ("No icon", false),
                ("Bad icon", false),
                ("Wrong type", false),
            ],
            "a bad icon never drops the login"
        );
        assert!(
            logins.items[0]
                .icon_png
                .as_deref()
                .is_some_and(|png| png.starts_with(&PNG_SIGNATURE))
        );
        Ok(())
    }

    const PASSKEY_OPTIONS: &str =
        r#"{"publicKey":{"challenge":"AAAAAAAAAAAAAAAAAAAAAA","rpId":"example.com"}}"#;

    /// A fake Vault that checks the request is exactly the contract's shape, then answers with
    /// `reply_body` (Python source of an expression over `req`).
    fn passkey_script(reply_body: &str) -> String {
        format!(
            r#"
import json, struct, sys

req = json.loads(sys.stdin.buffer.read(struct.unpack("<I", sys.stdin.buffer.read(4))[0]))
keys = sorted(req.keys())
ok_shape = (
    keys == ["id", "kind", "mode", "options", "url", "version"]
    and req["version"] == 1
    and req["kind"] == "passkey"
    and req["mode"] in ("passkey-create", "passkey-get")
    and isinstance(req["options"], str)
)
if not ok_shape:
    reply = {{"id": req["id"], "status": "error", "error": "NotSupportedError"}}
else:
    reply = {reply_body}
body = json.dumps(reply).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
"#
        )
    }

    #[test]
    fn passkey_modes_and_errors_use_the_contract_names() {
        assert_eq!(PasskeyMode::Create.as_str(), "passkey-create");
        assert_eq!(PasskeyMode::Get.as_str(), "passkey-get");
        for error in [
            PasskeyError::NotAllowed,
            PasskeyError::InvalidState,
            PasskeyError::Security,
            PasskeyError::NotSupported,
            PasskeyError::Abort,
        ] {
            assert_eq!(PasskeyError::from_name(error.name()), error);
        }
        assert_eq!(PasskeyError::from_name("Locked"), PasskeyError::NotAllowed);
        assert_eq!(PasskeyError::from_name(""), PasskeyError::NotAllowed);
    }

    #[test]
    fn parses_passkey_replies() {
        let ok =
            br#"{"id":"1","status":"ok","passkey":"{\"id\":\"abc\",\"type\":\"public-key\"}"}"#;
        assert_eq!(
            parse_passkey_reply(ok).as_deref(),
            Ok(r#"{"id":"abc","type":"public-key"}"#)
        );
        let named = |name: &str| {
            parse_passkey_reply(
                format!(r#"{{"id":"1","status":"error","error":"{name}","message":"x"}}"#)
                    .as_bytes(),
            )
        };
        assert_eq!(named("InvalidStateError"), Err(PasskeyError::InvalidState));
        assert_eq!(named("SecurityError"), Err(PasskeyError::Security));
        assert_eq!(named("NotSupportedError"), Err(PasskeyError::NotSupported));
        assert_eq!(named("AbortError"), Err(PasskeyError::Abort));
        assert_eq!(named("NotAllowedError"), Err(PasskeyError::NotAllowed));
        assert_eq!(named("Surprise"), Err(PasskeyError::NotAllowed));
        // An error with no name, a missing credential, a credential that is not an object, an
        // unknown status and a frame that is not JSON all refuse.
        for bad in [
            &br#"{"id":"1","status":"error"}"#[..],
            br#"{"id":"1","status":"ok"}"#,
            br#"{"id":"1","status":"ok","passkey":"[1]"}"#,
            br#"{"id":"1","status":"ok","passkey":"not json"}"#,
            br#"{"id":"1","status":"locked"}"#,
            b"nonsense",
        ] {
            assert_eq!(parse_passkey_reply(bad), Err(PasskeyError::NotAllowed));
        }
    }

    #[tokio::test]
    async fn passkey_request_has_exactly_the_contract_fields()
    -> Result<(), Box<dyn std::error::Error>> {
        let script = passkey_script(
            r#"{"id": req["id"], "status": "ok", "passkey": json.dumps({"mode": req["mode"], "url": req["url"], "options": req["options"]})}"#,
        );
        let (_dir, bin) = write_fake_vault(&script)?;
        let client = VaultClient::with_binary(&bin);
        let url = "https://example.com/login?next=%2F";
        for mode in [PasskeyMode::Get, PasskeyMode::Create] {
            let credential = client
                .passkey(mode, url, PASSKEY_OPTIONS)
                .await
                .map_err(|err| err.name())?;
            let value: serde_json::Value = serde_json::from_str(&credential)?;
            assert_eq!(value["mode"], mode.as_str());
            assert_eq!(value["url"], url);
            assert_eq!(value["options"], PASSKEY_OPTIONS);
        }
        Ok(())
    }

    #[tokio::test]
    async fn passkey_skips_replies_for_other_requests() -> Result<(), Box<dyn std::error::Error>> {
        let script = passkey_script(r#"{"id": req["id"], "status": "ok", "passkey": "{}"}"#)
            .replace(
                "body = json.dumps(reply)",
                r#"stray = json.dumps({"id": "other", "status": "error", "error": "SecurityError"}).encode("utf-8")
sys.stdout.buffer.write(struct.pack("<I", len(stray)) + stray)
body = json.dumps(reply)"#,
            );
        let (_dir, bin) = write_fake_vault(&script)?;
        let client = VaultClient::with_binary(&bin);
        let credential = client
            .passkey(PasskeyMode::Get, "https://example.com/", PASSKEY_OPTIONS)
            .await;
        assert_eq!(credential.as_deref(), Ok("{}"));
        Ok(())
    }

    #[tokio::test]
    async fn passkey_error_names_reach_the_caller() -> Result<(), Box<dyn std::error::Error>> {
        for (name, expected) in [
            ("InvalidStateError", PasskeyError::InvalidState),
            ("SecurityError", PasskeyError::Security),
            ("NotSupportedError", PasskeyError::NotSupported),
            ("NotAllowedError", PasskeyError::NotAllowed),
        ] {
            let script = passkey_script(&format!(
                r#"{{"id": req["id"], "status": "error", "error": "{name}", "message": "no"}}"#
            ));
            let (_dir, bin) = write_fake_vault(&script)?;
            let outcome = VaultClient::with_binary(&bin)
                .passkey(PasskeyMode::Create, "https://example.com/", PASSKEY_OPTIONS)
                .await;
            assert_eq!(outcome, Err(expected), "{name}");
        }
        Ok(())
    }

    /// An older Vault closes the pipe without a reply.
    #[tokio::test]
    async fn passkey_closed_pipe_is_not_allowed() -> Result<(), Box<dyn std::error::Error>> {
        let (_dir, bin) = write_fake_vault(
            "import sys
sys.stdin.buffer.read(4)
sys.exit(0)
",
        )?;
        let outcome = VaultClient::with_binary(&bin)
            .passkey(PasskeyMode::Get, "https://example.com/", PASSKEY_OPTIONS)
            .await;
        assert_eq!(outcome, Err(PasskeyError::NotAllowed));
        Ok(())
    }

    #[tokio::test]
    async fn passkey_timeout_is_not_allowed() -> Result<(), Box<dyn std::error::Error>> {
        let (_dir, bin) = write_fake_vault(
            "import time
time.sleep(30)
",
        )?;
        let started = std::time::Instant::now();
        let outcome = VaultClient::with_binary(&bin)
            .with_timeout(Duration::from_millis(300))
            .passkey(PasskeyMode::Get, "https://example.com/", PASSKEY_OPTIONS)
            .await;
        assert_eq!(outcome, Err(PasskeyError::NotAllowed));
        assert!(started.elapsed() < Duration::from_secs(10));
        Ok(())
    }

    /// The default wait covers a person using Touch ID, far beyond the 15 s status cap.
    #[test]
    fn passkey_waits_for_a_person() {
        assert!(VaultClient::new().timeout >= Duration::from_secs(120));
    }

    #[tokio::test]
    async fn passkey_refuses_before_starting_vault() {
        // A binary that does not exist proves the checks ran first for these.
        let client = VaultClient::with_binary("/nonexistent/Vault");
        for url in [
            "http://example.com/",
            "https://user:pw@example.com/",
            "about:blank",
            "not a url",
        ] {
            assert_eq!(
                client.passkey(PasskeyMode::Get, url, PASSKEY_OPTIONS).await,
                Err(PasskeyError::Security),
                "{url}"
            );
        }
        let long_url = format!("https://example.com/{}", "a".repeat(PASSKEY_URL_MAX_BYTES));
        assert_eq!(
            client
                .passkey(PasskeyMode::Get, &long_url, PASSKEY_OPTIONS)
                .await,
            Err(PasskeyError::Security)
        );
        for options in ["", &"x".repeat(PASSKEY_OPTIONS_MAX_BYTES + 1)] {
            assert_eq!(
                client
                    .passkey(PasskeyMode::Get, "https://example.com/", options)
                    .await,
                Err(PasskeyError::NotSupported)
            );
        }
        assert_eq!(
            client
                .passkey(PasskeyMode::Get, "https://example.com/", PASSKEY_OPTIONS)
                .await,
            Err(PasskeyError::NotAllowed),
            "no Vault installed"
        );
    }
}
