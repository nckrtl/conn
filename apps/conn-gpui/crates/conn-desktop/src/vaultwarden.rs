//! Dedicated Vaultwarden account backend for Conn's native desktop settings.
//!
//! Mirrors Conn's Electron main-process backend (`apps/desktop/src/vaultwarden/Account.ts` and
//! `apps/desktop/src/ipc/methods/vaultwarden.ts`) 1:1. Owns only Conn's dedicated account stored
//! in the OS Keychain under the same service/account entry (`com.nckrtl.conn.vaultwarden` /
//! `dedicated-account`) and JSON schema as T3 Conn so connections interoperate seamlessly.
//! The user's personal `bw` CLI profile is never opened.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;
use tokio::process::Command;
use tokio::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::child_reaper::OwnedChild;

/// Keychain service name shared with Conn's Electron backend.
const KEYCHAIN_SERVICE: &str = "com.nckrtl.conn.vaultwarden";
/// Keychain account name shared with Conn's Electron backend.
const KEYCHAIN_ACCOUNT: &str = "dedicated-account";

/// Maximum accepted text length for account fields and CLI session keys (`contracts/vaultwarden.ts`).
const MAX_TEXT_LEN: usize = 4096;
/// Timeout for a single `bw` CLI command (`Account.ts`: 45 seconds).
const CLI_TIMEOUT: Duration = Duration::from_secs(45);
/// Maximum stdout size accepted from `bw` (`Account.ts`: 4 MiB).
const MAX_CLI_STDOUT: usize = 4 * 1024 * 1024;
/// Timeout for Vaultwarden HTTP API requests (`Account.ts`: 15 seconds).
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Maximum response body accepted from Vaultwarden HTTP API (`Account.ts`: 16 MiB).
const MAX_HTTP_BODY: usize = 16 * 1024 * 1024;
/// Duration a recent account verification stays reusable for `save` (`Account.ts`: 5 minutes).
const CHECK_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
/// Vaultwarden/Bitwarden `OrganizationUserStatusType::Confirmed`.
const ORG_STATUS_CONFIRMED: i64 = 2;

/// Credentials for Conn's dedicated Vaultwarden account.
///
/// Intentionally omits `Debug` so secrets cannot accidentally be formatted into logs or panics.
/// All fields are zeroized when dropped.
#[expect(
    missing_debug_implementations,
    reason = "Account carries raw secrets (client_secret, master_password) and intentionally omits Debug"
)]
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Account {
    pub server: String,
    pub client_id: String,
    pub client_secret: String,
    pub master_password: String,
}

/// One writable Vaultwarden collection verified for the dedicated account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Collection {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub organization_name: String,
}

/// Non-secret metadata for the saved dedicated Vaultwarden connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Connection {
    pub email: String,
    pub server: String,
    pub collection: Collection,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ErrorKind {
    InvalidDetails,
    UnwritableCollection,
    ConnectFailed,
    CredentialStoreUnavailable,
}

/// User-safe error returned by Vaultwarden account operations.
///
/// Neither [`std::fmt::Display`] nor [`std::fmt::Debug`] ever includes account secrets, session
/// keys, or raw CLI/Keychain output.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.message())]
pub struct Error {
    kind: ErrorKind,
}

impl Error {
    const fn new(kind: ErrorKind) -> Self {
        Self { kind }
    }

    const fn invalid_details() -> Self {
        Self::new(ErrorKind::InvalidDetails)
    }

    const fn unwritable_collection() -> Self {
        Self::new(ErrorKind::UnwritableCollection)
    }

    const fn connect_failed() -> Self {
        Self::new(ErrorKind::ConnectFailed)
    }

    const fn credential_store_unavailable() -> Self {
        Self::new(ErrorKind::CredentialStoreUnavailable)
    }

    const fn message(&self) -> &'static str {
        match self.kind {
            ErrorKind::InvalidDetails => "Enter valid Vaultwarden connection details.",
            ErrorKind::UnwritableCollection => {
                "Choose a collection that this account can edit and read passwords from."
            }
            ErrorKind::ConnectFailed => {
                "Could not connect. Check the bw CLI, server certificate, account API key, master password, and Keychain access. Your saved connection was not changed."
            }
            ErrorKind::CredentialStoreUnavailable => {
                "The OS credential store is unavailable. Nothing was saved."
            }
        }
    }
}

/// Returns the saved Vaultwarden connection metadata, or `None` when not connected.
///
/// # Errors
///
/// Returns [`Error`] if the OS Keychain is unavailable, cannot be read, or contains corrupt data.
pub async fn status() -> Result<Option<Connection>, Error> {
    default_accounts().status().await
}

/// Verifies the dedicated account without saving it and returns its writable collections.
///
/// # Errors
///
/// Returns [`Error`] if the account details are invalid or verification fails.
pub async fn check(account: &Account) -> Result<Vec<Collection>, Error> {
    default_accounts().check(account).await
}

/// Verifies access to `collection` and stores the dedicated account in the OS Keychain.
///
/// Reuses a recent matching [`check`] to avoid repeating CLI login/unlock while always fetching
/// fresh collection permissions from Vaultwarden before writing to the Keychain.
///
/// # Errors
///
/// Returns [`Error`] if verification fails, the collection is not writable, or Keychain storage
/// fails. The previously saved connection is preserved on failure.
pub async fn save(account: &Account, collection: &Collection) -> Result<Connection, Error> {
    default_accounts().save(account, collection).await
}

/// Removes only the local Keychain entry and discards any cached check, leaving remote items intact.
///
/// # Errors
///
/// Returns [`Error`] if the OS Keychain is unavailable or fails to delete the credential.
pub async fn disconnect() -> Result<(), Error> {
    default_accounts().disconnect().await
}

fn default_accounts()
-> &'static VaultwardenAccounts<SystemKeychain, SystemBitwarden, ReqwestTransport, MonotonicClock> {
    static DEFAULT: OnceLock<
        VaultwardenAccounts<SystemKeychain, SystemBitwarden, ReqwestTransport, MonotonicClock>,
    > = OnceLock::new();
    DEFAULT.get_or_init(VaultwardenAccounts::system)
}

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeychainError {
    Unavailable,
    Failed,
}

impl From<KeychainError> for Error {
    fn from(err: KeychainError) -> Self {
        match err {
            KeychainError::Unavailable => Self::credential_store_unavailable(),
            KeychainError::Failed => Self::connect_failed(),
        }
    }
}

trait AccountKeychain: Send + Sync {
    fn get_password(&self) -> BoxFuture<'_, Result<Option<Zeroizing<String>>, KeychainError>>;
    fn set_password(&self, value: Zeroizing<String>) -> BoxFuture<'_, Result<(), KeychainError>>;
    fn delete_credential(&self) -> BoxFuture<'_, Result<bool, KeychainError>>;
}

#[derive(Debug)]
struct CliError;

trait BitwardenRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        args: &'a [&'a str],
        env: BTreeMap<String, Zeroizing<String>>,
    ) -> BoxFuture<'a, Result<Zeroizing<String>, CliError>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpMethod {
    Get,
    Post,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedirectPolicy {
    Error,
}

struct HttpRequest {
    method: HttpMethod,
    url: String,
    headers: Vec<(String, Zeroizing<String>)>,
    body: Option<Zeroizing<String>>,
    redirect: RedirectPolicy,
}

#[derive(Debug)]
struct HttpError;

trait HttpTransport: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<Zeroizing<Vec<u8>>, HttpError>>;
}

trait Clock: Send + Sync {
    /// Monotonic elapsed milliseconds.
    fn now_ms(&self) -> u64;
}

struct MonotonicClock {
    origin: Instant,
}

impl MonotonicClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

struct SystemKeychain {
    service: &'static str,
    account: &'static str,
}

impl SystemKeychain {
    const fn new() -> Self {
        Self {
            service: KEYCHAIN_SERVICE,
            account: KEYCHAIN_ACCOUNT,
        }
    }
}

#[cfg(target_os = "macos")]
impl AccountKeychain for SystemKeychain {
    fn get_password(&self) -> BoxFuture<'_, Result<Option<Zeroizing<String>>, KeychainError>> {
        // Apple `SecBase.h`: `errSecItemNotFound` (-25300), `errSecNotAvailable` (-25291).
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
        const ERR_SEC_NOT_AVAILABLE: i32 = -25291;
        let service = self.service;
        let account = self.account;
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let options = security_framework::passwords::PasswordOptions::new_generic_password(
                    service, account,
                );
                match security_framework::passwords::generic_password(options) {
                    Ok(bytes) => match String::from_utf8(bytes) {
                        Ok(secret) => Ok(Some(Zeroizing::new(secret))),
                        Err(err) => {
                            let mut raw = err.into_bytes();
                            raw.zeroize();
                            Err(KeychainError::Failed)
                        }
                    },
                    Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                    Err(err) if err.code() == ERR_SEC_NOT_AVAILABLE => {
                        Err(KeychainError::Unavailable)
                    }
                    Err(_) => Err(KeychainError::Failed),
                }
            })
            .await
            .map_err(|_| KeychainError::Failed)?
        })
    }

    fn set_password(&self, value: Zeroizing<String>) -> BoxFuture<'_, Result<(), KeychainError>> {
        const ERR_SEC_NOT_AVAILABLE: i32 = -25291;
        let service = self.service;
        let account = self.account;
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                security_framework::passwords::set_generic_password(
                    service,
                    account,
                    value.as_bytes(),
                )
                .map_err(|err| {
                    if err.code() == ERR_SEC_NOT_AVAILABLE {
                        KeychainError::Unavailable
                    } else {
                        KeychainError::Failed
                    }
                })
            })
            .await
            .map_err(|_| KeychainError::Failed)?
        })
    }

    fn delete_credential(&self) -> BoxFuture<'_, Result<bool, KeychainError>> {
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
        const ERR_SEC_NOT_AVAILABLE: i32 = -25291;
        let service = self.service;
        let account = self.account;
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                match security_framework::passwords::delete_generic_password(service, account) {
                    Ok(()) => Ok(true),
                    Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
                    Err(err) if err.code() == ERR_SEC_NOT_AVAILABLE => {
                        Err(KeychainError::Unavailable)
                    }
                    Err(_) => Err(KeychainError::Failed),
                }
            })
            .await
            .map_err(|_| KeychainError::Failed)?
        })
    }
}

#[cfg(not(target_os = "macos"))]
impl AccountKeychain for SystemKeychain {
    fn get_password(&self) -> BoxFuture<'_, Result<Option<Zeroizing<String>>, KeychainError>> {
        Box::pin(async { Err(KeychainError::Unavailable) })
    }

    fn set_password(&self, _value: Zeroizing<String>) -> BoxFuture<'_, Result<(), KeychainError>> {
        Box::pin(async { Err(KeychainError::Unavailable) })
    }

    fn delete_credential(&self) -> BoxFuture<'_, Result<bool, KeychainError>> {
        Box::pin(async { Err(KeychainError::Unavailable) })
    }
}

struct SystemBitwarden;

impl BitwardenRunner for SystemBitwarden {
    /// Runs `bw` with `--nointeraction` in a strictly isolated environment.
    /// Never interpolates secrets into argv or surfaces CLI output in errors.
    fn run<'a>(
        &'a self,
        args: &'a [&'a str],
        env: BTreeMap<String, Zeroizing<String>>,
    ) -> BoxFuture<'a, Result<Zeroizing<String>, CliError>> {
        Box::pin(async move {
            let program = env
                .get("PATH")
                .and_then(|path| resolve_executable("bw", path))
                .unwrap_or_else(|| PathBuf::from("bw"));

            let mut cmd = Command::new(program);
            cmd.args(args)
                .arg("--nointeraction")
                .env_clear()
                .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);

            let run_future = async {
                // However this ends (error, timeout, dropped), `child` kills `bw` and leaves its
                // exit to the background reaper. Nothing here waits on SIGCHLD, which the
                // embedded Chromium can disable.
                let mut child = OwnedChild::new(cmd.spawn().map_err(|_| CliError)?);
                let mut stdout = child.child().stdout.take().ok_or(CliError)?;

                let mut buf = Zeroizing::new(Vec::new());
                let mut limited = (&mut stdout).take((MAX_CLI_STDOUT + 1) as u64);
                limited.read_to_end(&mut buf).await.map_err(|_| CliError)?;
                if buf.len() > MAX_CLI_STDOUT {
                    return Err(CliError);
                }

                // `bw` closed stdout, so it is exiting: poll for its status.
                let status = child.exit_status().await.map_err(|_| CliError)?;
                if !status.success() {
                    return Err(CliError);
                }

                let owned = std::mem::take(&mut *buf);
                match String::from_utf8(owned) {
                    Ok(text) => Ok(Zeroizing::new(text)),
                    Err(err) => {
                        let mut raw = err.into_bytes();
                        raw.zeroize();
                        Err(CliError)
                    }
                }
            };

            match tokio::time::timeout(CLI_TIMEOUT, run_future).await {
                Ok(result) => result,
                Err(_) => Err(CliError),
            }
        })
    }
}

fn resolve_executable(name: &str, path_env: &str) -> Option<PathBuf> {
    for dir in std::env::split_paths(path_env) {
        let candidate = dir.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && (meta.permissions().mode() & 0o111) != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &std::path::Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

struct ReqwestTransport {
    client: Option<reqwest::Client>,
}

impl ReqwestTransport {
    fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT)
            .build()
            .ok();
        Self { client }
    }
}

impl HttpTransport for ReqwestTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<Zeroizing<Vec<u8>>, HttpError>> {
        Box::pin(async move {
            let client = self.client.as_ref().ok_or(HttpError)?;
            // Redirects are forbidden by the client's `Policy::none()`; enforce the request matches.
            if request.redirect != RedirectPolicy::Error {
                return Err(HttpError);
            }

            let mut builder = match request.method {
                HttpMethod::Get => client.get(&request.url),
                HttpMethod::Post => client.post(&request.url),
            };
            for (name, value) in &request.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            if let Some(body) = request.body {
                builder = builder.body(body.as_bytes().to_vec());
            }

            let fetch_future = async {
                let mut response = builder.send().await.map_err(|_| HttpError)?;
                if !response.status().is_success() {
                    return Err(HttpError);
                }

                let mut body = Zeroizing::new(Vec::new());
                while let Some(chunk) = response.chunk().await.map_err(|_| HttpError)? {
                    if body.len().saturating_add(chunk.len()) > MAX_HTTP_BODY {
                        return Err(HttpError);
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(body)
            };

            match tokio::time::timeout(HTTP_TIMEOUT, fetch_future).await {
                Ok(result) => result,
                Err(_) => Err(HttpError),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Wire / storage JSON schemas (camelCase, matching `packages/contracts/src/vaultwarden.ts`)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
struct StoredAccount {
    server: String,
    client_id: String,
    client_secret: String,
    master_password: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCollection {
    id: String,
    name: String,
    organization_id: String,
    organization_name: String,
}

impl From<&Collection> for StoredCollection {
    fn from(value: &Collection) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            organization_id: value.organization_id.clone(),
            organization_name: value.organization_name.clone(),
        }
    }
}

impl From<StoredCollection> for Collection {
    fn from(value: StoredCollection) -> Self {
        Self {
            id: value.id,
            organization_id: value.organization_id,
            name: value.name,
            organization_name: value.organization_name,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConnection {
    server: String,
    email: String,
    collection: StoredCollection,
}

impl From<&Connection> for StoredConnection {
    fn from(value: &Connection) -> Self {
        Self {
            server: value.server.clone(),
            email: value.email.clone(),
            collection: StoredCollection::from(&value.collection),
        }
    }
}

impl From<StoredConnection> for Connection {
    fn from(value: StoredConnection) -> Self {
        Self {
            email: value.email,
            server: value.server,
            collection: Collection::from(value.collection),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    account: StoredAccount,
    connection: StoredConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliCollection {
    id: String,
    name: String,
    organization_id: String,
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
}

impl Zeroize for TokenReply {
    fn zeroize(&mut self) {
        self.access_token.zeroize();
    }
}

impl Drop for TokenReply {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncOrganization {
    id: String,
    name: String,
    status: i64,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncProfile {
    id: String,
    email: String,
    organizations: Option<Vec<SyncOrganization>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionCollection {
    id: String,
    organization_id: String,
    read_only: Option<bool>,
    hide_passwords: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncPermissions {
    profile: SyncProfile,
    collections: Vec<PermissionCollection>,
}

// ---------------------------------------------------------------------------
// Validation & crypto helpers
// ---------------------------------------------------------------------------

fn is_valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_TEXT_LEN
}

fn is_hyphenated_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && uuid::Uuid::try_parse(value).is_ok()
}

fn validate_account_fields(account: &Account) -> Result<(), Error> {
    if is_valid_text(&account.server)
        && is_valid_text(&account.client_id)
        && is_valid_text(&account.client_secret)
        && is_valid_text(&account.master_password)
    {
        Ok(())
    } else {
        Err(Error::invalid_details())
    }
}

fn validate_collection_ids(collection: &Collection) -> Result<(), Error> {
    if is_hyphenated_uuid(&collection.id) && is_hyphenated_uuid(&collection.organization_id) {
        Ok(())
    } else {
        Err(Error::invalid_details())
    }
}

fn decode_stored_connection(raw: &str) -> Result<Connection, Error> {
    let entry: StoredEntry = serde_json::from_str(raw).map_err(|_| Error::connect_failed())?;
    let valid_account = is_valid_text(&entry.account.server)
        && is_valid_text(&entry.account.client_id)
        && is_valid_text(&entry.account.client_secret)
        && is_valid_text(&entry.account.master_password);
    let valid_collection = is_hyphenated_uuid(&entry.connection.collection.id)
        && is_hyphenated_uuid(&entry.connection.collection.organization_id);
    if !valid_account || !valid_collection {
        return Err(Error::connect_failed());
    }
    Ok(Connection::from(entry.connection))
}

fn server_origin(value: &str) -> Result<String, Error> {
    let parsed = url::Url::parse(value).map_err(|_| Error::connect_failed())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(Error::connect_failed());
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err(Error::connect_failed());
    }
    Ok(origin)
}

fn personal_api_user_id(client_id: &str) -> Result<&str, Error> {
    let user_id = client_id
        .strip_prefix("user.")
        .ok_or_else(Error::connect_failed)?;
    if !is_hyphenated_uuid(user_id) {
        return Err(Error::connect_failed());
    }
    Ok(user_id)
}

fn writable_collections(
    collections: &[Collection],
    permissions: &SyncPermissions,
) -> Vec<Collection> {
    collections
        .iter()
        .filter(|collection| {
            let membership = permissions
                .profile
                .organizations
                .as_deref()
                .and_then(|orgs| orgs.iter().find(|org| org.id == collection.organization_id));
            let access = permissions.collections.iter().find(|entry| {
                entry.id == collection.id && entry.organization_id == collection.organization_id
            });
            membership.is_some_and(|org| org.status == ORG_STATUS_CONFIRMED && org.enabled)
                && access.is_some_and(|entry| {
                    entry.read_only == Some(false) && entry.hide_passwords == Some(false)
                })
                && is_hyphenated_uuid(&collection.id)
                && is_hyphenated_uuid(&collection.organization_id)
        })
        .cloned()
        .collect()
}

/// Generates a 256-bit random HMAC key from three v4 UUIDs (366 bits of OS CSPRNG entropy)
/// compressed with SHA-256.
fn generate_check_key() -> Zeroizing<[u8; 32]> {
    let mut hasher = Sha256::new();
    for _ in 0..3 {
        let random = uuid::Uuid::new_v4();
        hasher.update(random.as_bytes());
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Zeroizing::new(digest)
}

/// RFC 2104 HMAC-SHA256 for a 32-byte key.
fn hmac_sha256(key: &[u8; 32], message: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut ipad = Zeroizing::new([0x36u8; BLOCK_SIZE]);
    let mut opad = Zeroizing::new([0x5cu8; BLOCK_SIZE]);
    for (idx, &byte) in key.iter().enumerate() {
        ipad[idx] ^= byte;
        opad[idx] ^= byte;
    }

    let mut inner = Sha256::new();
    inner.update(*ipad);
    inner.update(message);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(*opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

fn constant_time_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (&lhs, &rhs) in a.iter().zip(b.iter()) {
        diff |= lhs ^ rhs;
    }
    diff == 0
}

fn build_isolated_cli_env(appdata_dir: &std::path::Path) -> BTreeMap<String, Zeroizing<String>> {
    let mut env = BTreeMap::new();

    let mut path_entries: Vec<PathBuf> = Vec::new();
    if let Some(existing) = std::env::var_os("PATH")
        && !existing.is_empty()
    {
        path_entries.extend(std::env::split_paths(&existing));
    }
    for standard in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        path_entries.push(PathBuf::from(standard));
    }
    let joined_path = std::env::join_paths(&path_entries)
        .map(|os| os.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".to_owned());
    env.insert("PATH".to_owned(), Zeroizing::new(joined_path));

    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        env.insert("HOME".to_owned(), Zeroizing::new(home));
    }
    env.insert(
        "BITWARDENCLI_APPDATA_DIR".to_owned(),
        Zeroizing::new(appdata_dir.to_string_lossy().into_owned()),
    );
    env.insert(
        "NODE_USE_SYSTEM_CA".to_owned(),
        Zeroizing::new("1".to_owned()),
    );

    for name in ["SystemRoot", "TMPDIR", "TEMP"] {
        if let Ok(value) = std::env::var(name)
            && !value.is_empty()
        {
            env.insert(name.to_owned(), Zeroizing::new(value));
        }
    }

    env
}

// ---------------------------------------------------------------------------
// Core account coordinator (injectable dependencies for unit tests)
// ---------------------------------------------------------------------------

struct CheckedAccount {
    server: String,
    email: String,
    collections: Vec<Collection>,
}

struct CachedCheck {
    fingerprint: [u8; 32],
    expires_at_ms: u64,
    value: CheckedAccount,
}

struct AccountState {
    // Only metadata and a keyed fingerprint survive `check`. No password, token, or CLI session.
    checked: Option<CachedCheck>,
}

/// Owns only Conn's dedicated Vaultwarden account and serializes setup/disconnect operations.
struct VaultwardenAccounts<K, R, H, C> {
    state: Mutex<AccountState>,
    check_key: Zeroizing<[u8; 32]>,
    keychain: K,
    runner: R,
    http: H,
    clock: C,
}

impl VaultwardenAccounts<SystemKeychain, SystemBitwarden, ReqwestTransport, MonotonicClock> {
    fn system() -> Self {
        Self::new(
            SystemKeychain::new(),
            SystemBitwarden,
            ReqwestTransport::new(),
            MonotonicClock::new(),
        )
    }
}

impl<K, R, H, C> VaultwardenAccounts<K, R, H, C>
where
    K: AccountKeychain,
    R: BitwardenRunner,
    H: HttpTransport,
    C: Clock,
{
    fn new(keychain: K, runner: R, http: H, clock: C) -> Self {
        Self {
            state: Mutex::new(AccountState { checked: None }),
            check_key: generate_check_key(),
            keychain,
            runner,
            http,
            clock,
        }
    }

    fn fingerprint(&self, account: &Account) -> Result<[u8; 32], Error> {
        let payload = Zeroizing::new(
            serde_json::to_string(&[
                &account.server,
                &account.client_id,
                &account.client_secret,
                &account.master_password,
            ])
            .map_err(|_| Error::connect_failed())?,
        );
        Ok(hmac_sha256(&self.check_key, payload.as_bytes()))
    }

    async fn fetch_json<T: serde::de::DeserializeOwned>(
        &self,
        server: &str,
        path: &str,
        method: HttpMethod,
        extra_headers: Vec<(String, Zeroizing<String>)>,
        body: Option<Zeroizing<String>>,
    ) -> Result<T, Error> {
        let mut headers = vec![
            (
                "Bitwarden-Client-Name".to_owned(),
                Zeroizing::new("cli".to_owned()),
            ),
            (
                "Bitwarden-Client-Version".to_owned(),
                Zeroizing::new("2026.6.0".to_owned()),
            ),
            ("Device-Type".to_owned(), Zeroizing::new("25".to_owned())),
        ];
        headers.extend(extra_headers);

        let request = HttpRequest {
            method,
            url: format!("{server}{path}"),
            headers,
            body,
            redirect: RedirectPolicy::Error,
        };
        let bytes = self
            .http
            .send(request)
            .await
            .map_err(|_| Error::connect_failed())?;
        serde_json::from_slice(&bytes).map_err(|_| Error::connect_failed())
    }

    async fn permissions(&self, account: &Account, server: &str) -> Result<SyncPermissions, Error> {
        let user_id = personal_api_user_id(&account.client_id)?;

        let form_body = Zeroizing::new(
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("grant_type", "client_credentials")
                .append_pair("scope", "api")
                .append_pair("client_id", &account.client_id)
                .append_pair("client_secret", &account.client_secret)
                .append_pair("deviceType", "25")
                .append_pair("deviceIdentifier", user_id)
                .append_pair("deviceName", "Conn")
                .finish(),
        );

        let token: TokenReply = self
            .fetch_json(
                server,
                "/identity/connect/token",
                HttpMethod::Post,
                vec![(
                    "Content-Type".to_owned(),
                    Zeroizing::new("application/x-www-form-urlencoded".to_owned()),
                )],
                Some(form_body),
            )
            .await?;

        let auth_header = Zeroizing::new(format!("Bearer {}", token.access_token));
        drop(token);

        // `/api/collections` omits access flags in Vaultwarden. Sync includes collectionDetails.
        let permissions: SyncPermissions = self
            .fetch_json(
                server,
                "/api/sync?excludeDomains=true",
                HttpMethod::Get,
                vec![("Authorization".to_owned(), auth_header)],
                None,
            )
            .await?;

        if !permissions.profile.id.eq_ignore_ascii_case(user_id) {
            return Err(Error::connect_failed());
        }
        Ok(permissions)
    }

    async fn inspect(&self, account: &Account) -> Result<CheckedAccount, Error> {
        let server = server_origin(&account.server)?;
        let _user_id = personal_api_user_id(&account.client_id)?;

        // Isolated temporary CLI profile; `TempDir` removes it recursively on every exit path.
        let temp_dir = tempfile::Builder::new()
            .prefix("conn-vaultwarden-")
            .tempdir()
            .map_err(|_| Error::connect_failed())?;
        let base_env = build_isolated_cli_env(temp_dir.path());

        self.runner
            .run(&["config", "server", &server], base_env.clone())
            .await
            .map_err(|_| Error::connect_failed())?;

        let mut login_env = base_env.clone();
        login_env.insert(
            "BW_CLIENTID".to_owned(),
            Zeroizing::new(account.client_id.clone()),
        );
        login_env.insert(
            "BW_CLIENTSECRET".to_owned(),
            Zeroizing::new(account.client_secret.clone()),
        );
        self.runner
            .run(&["login", "--apikey"], login_env)
            .await
            .map_err(|_| Error::connect_failed())?;

        let mut unlock_env = base_env.clone();
        unlock_env.insert(
            "CONN_VAULT_PASSWORD".to_owned(),
            Zeroizing::new(account.master_password.clone()),
        );
        let raw_session = self
            .runner
            .run(
                &["unlock", "--passwordenv", "CONN_VAULT_PASSWORD", "--raw"],
                unlock_env,
            )
            .await
            .map_err(|_| Error::connect_failed())?;
        let session = Zeroizing::new(raw_session.trim().to_owned());
        drop(raw_session);
        if session.is_empty() || session.len() > MAX_TEXT_LEN {
            return Err(Error::connect_failed());
        }

        let mut unlocked_env = base_env;
        unlocked_env.insert("BW_SESSION".to_owned(), session);
        // Login already performs a full sync. Only collection names require CLI decryption;
        // account identity and organization names come from the authenticated profile.
        let raw_collections = self
            .runner
            .run(&["list", "collections"], unlocked_env)
            .await
            .map_err(|_| Error::connect_failed())?;
        let all: Vec<CliCollection> =
            serde_json::from_str(&raw_collections).map_err(|_| Error::connect_failed())?;

        // CLI exports omit permissions. Check the authenticated API before offering destinations.
        let permissions = self.permissions(account, &server).await?;
        let collections: Vec<Collection> = all
            .into_iter()
            .filter_map(|collection| {
                let organization = permissions
                    .profile
                    .organizations
                    .as_deref()?
                    .iter()
                    .find(|org| org.id == collection.organization_id)?;
                Some(Collection {
                    id: collection.id,
                    organization_id: organization.id.clone(),
                    name: collection.name,
                    organization_name: organization.name.clone(),
                })
            })
            .collect();

        Ok(CheckedAccount {
            server,
            email: permissions.profile.email.clone(),
            collections: writable_collections(&collections, &permissions),
        })
    }

    async fn status(&self) -> Result<Option<Connection>, Error> {
        let _guard = self.state.lock().await;
        let stored = self.keychain.get_password().await?;
        match stored {
            None => Ok(None),
            Some(raw) => Ok(Some(decode_stored_connection(&raw)?)),
        }
    }

    async fn disconnect(&self) -> Result<(), Error> {
        let mut state = self.state.lock().await;
        state.checked = None;
        let _ = self.keychain.delete_credential().await?;
        Ok(())
    }

    async fn check(&self, account: &Account) -> Result<Vec<Collection>, Error> {
        validate_account_fields(account)?;
        let mut state = self.state.lock().await;
        let fingerprint = self.fingerprint(account)?;
        state.checked = None;

        let checked = self.inspect(account).await?;
        let collections = checked.collections.clone();
        let ttl_ms = u64::try_from(CHECK_CACHE_TTL.as_millis()).unwrap_or(u64::MAX);
        state.checked = Some(CachedCheck {
            fingerprint,
            expires_at_ms: self.clock.now_ms().saturating_add(ttl_ms),
            value: checked,
        });
        Ok(collections)
    }

    async fn save(&self, account: &Account, collection: &Collection) -> Result<Connection, Error> {
        validate_account_fields(account)?;
        validate_collection_ids(collection)?;

        let mut state = self.state.lock().await;
        let fingerprint = self.fingerprint(account)?;
        let recent = state.checked.take();

        let checked = if let Some(recent) = recent
            && constant_time_eq_32(&recent.fingerprint, &fingerprint)
            && recent.expires_at_ms > self.clock.now_ms()
        {
            // Recheck access at save time without repeating login, password derivation, and decryption.
            let permissions = self.permissions(account, &recent.value.server).await?;
            CheckedAccount {
                server: recent.value.server,
                email: permissions.profile.email.clone(),
                collections: writable_collections(&recent.value.collections, &permissions),
            }
        } else {
            self.inspect(account).await?
        };

        let Some(matched) = checked.collections.into_iter().find(|entry| {
            entry.id == collection.id && entry.organization_id == collection.organization_id
        }) else {
            return Err(Error::unwritable_collection());
        };

        let connection = Connection {
            server: checked.server.clone(),
            email: checked.email,
            collection: matched,
        };
        let entry = StoredEntry {
            account: StoredAccount {
                server: checked.server,
                client_id: account.client_id.clone(),
                client_secret: account.client_secret.clone(),
                master_password: account.master_password.clone(),
            },
            connection: StoredConnection::from(&connection),
        };
        let serialized =
            Zeroizing::new(serde_json::to_string(&entry).map_err(|_| Error::connect_failed())?);
        self.keychain.set_password(serialized).await?;

        Ok(connection)
    }
}

// Compile-time check that all public types and futures are `Send`.
const _: () = {
    const fn assert_send<T: Send>() {}
    const fn assert_sync<T: Sync>() {}

    assert_send::<Account>();
    assert_sync::<Account>();
    assert_send::<Collection>();
    assert_sync::<Collection>();
    assert_send::<Connection>();
    assert_sync::<Connection>();
    assert_send::<Error>();
    assert_sync::<Error>();
};

#[cfg(test)]
#[expect(
    clippy::panic_in_result_fn,
    reason = "tests combine ? for JSON/setup with assert macros"
)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    const USER_ID: &str = "00000000-0000-0000-0000-000000000001";
    const ORG_ID: &str = "00000000-0000-0000-0000-000000000002";
    const COLLECTION_ID: &str = "00000000-0000-0000-0000-000000000003";

    fn fixture_account() -> Account {
        Account {
            server: "https://vault.example".to_owned(),
            client_id: format!("user.{USER_ID}"),
            client_secret: "fixture-api-secret".to_owned(),
            master_password: "fixture-master-password".to_owned(),
        }
    }

    fn fixture_collection() -> Collection {
        Collection {
            id: COLLECTION_ID.to_owned(),
            organization_id: ORG_ID.to_owned(),
            name: "Conn".to_owned(),
            organization_name: "Conn organization".to_owned(),
        }
    }

    #[derive(Clone)]
    struct FixtureOptions {
        read_only: bool,
        hide_passwords: bool,
        omit_permissions: bool,
        status: i64,
        fail: bool,
        wrong_user: bool,
        no_organizations: bool,
        disabled_organization: bool,
    }

    impl Default for FixtureOptions {
        fn default() -> Self {
            Self {
                read_only: false,
                hide_passwords: false,
                omit_permissions: false,
                status: 2,
                fail: false,
                wrong_user: false,
                no_organizations: false,
                disabled_organization: false,
            }
        }
    }

    #[derive(Clone, Debug)]
    struct RecordedCliCall {
        args: Vec<String>,
        env: BTreeMap<String, String>,
    }

    #[derive(Clone, Debug)]
    struct RecordedHttpRequest {
        url: String,
        redirect: RedirectPolicy,
    }

    #[derive(Clone, Default)]
    struct FakeKeychain {
        stored: Arc<std::sync::Mutex<Option<String>>>,
    }

    impl FakeKeychain {
        fn set_raw(&self, value: &str) {
            let mut guard = self
                .stored
                .lock()
                .unwrap_or_else(|_| panic!("fake keychain lock poisoned"));
            *guard = Some(value.to_owned());
        }

        fn stored(&self) -> Option<String> {
            let guard = self
                .stored
                .lock()
                .unwrap_or_else(|_| panic!("fake keychain lock poisoned"));
            guard.clone()
        }
    }

    impl AccountKeychain for FakeKeychain {
        fn get_password(&self) -> BoxFuture<'_, Result<Option<Zeroizing<String>>, KeychainError>> {
            let value = self.stored().map(Zeroizing::new);
            Box::pin(async move { Ok(value) })
        }

        fn set_password(
            &self,
            value: Zeroizing<String>,
        ) -> BoxFuture<'_, Result<(), KeychainError>> {
            self.set_raw(&value);
            Box::pin(async { Ok(()) })
        }

        fn delete_credential(&self) -> BoxFuture<'_, Result<bool, KeychainError>> {
            let mut guard = self
                .stored
                .lock()
                .unwrap_or_else(|_| panic!("fake keychain lock poisoned"));
            let existed = guard.take().is_some();
            Box::pin(async move { Ok(existed) })
        }
    }

    #[derive(Clone)]
    struct FakeRunner {
        options: Arc<std::sync::Mutex<FixtureOptions>>,
        calls: Arc<std::sync::Mutex<Vec<RecordedCliCall>>>,
    }

    impl BitwardenRunner for FakeRunner {
        fn run<'a>(
            &'a self,
            args: &'a [&'a str],
            env: BTreeMap<String, Zeroizing<String>>,
        ) -> BoxFuture<'a, Result<Zeroizing<String>, CliError>> {
            let recorded_args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
            let recorded_env: BTreeMap<String, String> =
                env.into_iter().map(|(k, v)| (k, (*v).clone())).collect();
            let joined = recorded_args.join(" ");
            let first_arg = recorded_args.first().cloned().unwrap_or_default();

            self.calls
                .lock()
                .unwrap_or_else(|_| panic!("fake runner calls lock poisoned"))
                .push(RecordedCliCall {
                    args: recorded_args,
                    env: recorded_env,
                });

            let fail = self
                .options
                .lock()
                .unwrap_or_else(|_| panic!("fake runner options lock poisoned"))
                .fail;

            Box::pin(async move {
                if fail && first_arg == "unlock" {
                    return Err(CliError);
                }
                let output = match joined.as_str() {
                    "unlock --passwordenv CONN_VAULT_PASSWORD --raw" => {
                        "fixture-session-key".to_owned()
                    }
                    "list collections" => serde_json::json!([
                        {
                            "id": COLLECTION_ID,
                            "organizationId": ORG_ID,
                            "name": "Conn",
                        }
                    ])
                    .to_string(),
                    _ => String::new(),
                };
                Ok(Zeroizing::new(output))
            })
        }
    }

    #[derive(Clone)]
    struct FakeHttp {
        options: Arc<std::sync::Mutex<FixtureOptions>>,
        requests: Arc<std::sync::Mutex<Vec<RecordedHttpRequest>>>,
    }

    impl HttpTransport for FakeHttp {
        fn send(
            &self,
            request: HttpRequest,
        ) -> BoxFuture<'_, Result<Zeroizing<Vec<u8>>, HttpError>> {
            self.requests
                .lock()
                .unwrap_or_else(|_| panic!("fake http requests lock poisoned"))
                .push(RecordedHttpRequest {
                    url: request.url.clone(),
                    redirect: request.redirect,
                });

            let opts = self
                .options
                .lock()
                .unwrap_or_else(|_| panic!("fake http options lock poisoned"))
                .clone();

            Box::pin(async move {
                if !request.url.ends_with("/identity/connect/token")
                    && !request.url.ends_with("/api/sync?excludeDomains=true")
                {
                    panic!("Unexpected endpoint: only sync includes collection permissions.");
                }

                let json = if request.url.ends_with("/identity/connect/token") {
                    serde_json::json!({ "access_token": "fixture-access-token" })
                } else {
                    let mut profile = serde_json::Map::new();
                    profile.insert(
                        "id".to_owned(),
                        serde_json::Value::String(if opts.wrong_user {
                            ORG_ID.to_owned()
                        } else {
                            USER_ID.to_owned()
                        }),
                    );
                    profile.insert(
                        "email".to_owned(),
                        serde_json::Value::String("conn@example.com".to_owned()),
                    );
                    if !opts.no_organizations {
                        profile.insert(
                            "organizations".to_owned(),
                            serde_json::json!([
                                {
                                    "id": ORG_ID,
                                    "name": "Conn organization",
                                    "status": opts.status,
                                    "enabled": !opts.disabled_organization,
                                }
                            ]),
                        );
                    }

                    let mut col = serde_json::Map::new();
                    col.insert(
                        "id".to_owned(),
                        serde_json::Value::String(COLLECTION_ID.to_owned()),
                    );
                    col.insert(
                        "organizationId".to_owned(),
                        serde_json::Value::String(ORG_ID.to_owned()),
                    );
                    if !opts.omit_permissions {
                        col.insert(
                            "readOnly".to_owned(),
                            serde_json::Value::Bool(opts.read_only),
                        );
                        col.insert(
                            "hidePasswords".to_owned(),
                            serde_json::Value::Bool(opts.hide_passwords),
                        );
                    }

                    serde_json::json!({
                        "profile": serde_json::Value::Object(profile),
                        "collections": [serde_json::Value::Object(col)],
                    })
                };

                let bytes = serde_json::to_vec(&json).map_err(|_| HttpError)?;
                Ok(Zeroizing::new(bytes))
            })
        }
    }

    #[derive(Clone)]
    struct FakeClock {
        now_ms: Arc<AtomicU64>,
    }

    impl FakeClock {
        fn new(initial_ms: u64) -> Self {
            Self {
                now_ms: Arc::new(AtomicU64::new(initial_ms)),
            }
        }

        fn set_ms(&self, ms: u64) {
            self.now_ms.store(ms, Ordering::SeqCst);
        }
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.now_ms.load(Ordering::SeqCst)
        }
    }

    struct Fixture {
        service: VaultwardenAccounts<FakeKeychain, FakeRunner, FakeHttp, FakeClock>,
        keychain: FakeKeychain,
        options: Arc<std::sync::Mutex<FixtureOptions>>,
        calls: Arc<std::sync::Mutex<Vec<RecordedCliCall>>>,
        requests: Arc<std::sync::Mutex<Vec<RecordedHttpRequest>>>,
        clock: FakeClock,
    }

    impl Fixture {
        fn new(options: FixtureOptions, initial_ms: u64) -> Self {
            let options = Arc::new(std::sync::Mutex::new(options));
            let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let keychain = FakeKeychain::default();
            let runner = FakeRunner {
                options: Arc::clone(&options),
                calls: Arc::clone(&calls),
            };
            let http = FakeHttp {
                options: Arc::clone(&options),
                requests: Arc::clone(&requests),
            };
            let clock = FakeClock::new(initial_ms);
            let service = VaultwardenAccounts::new(keychain.clone(), runner, http, clock.clone());
            Self {
                service,
                keychain,
                options,
                calls,
                requests,
                clock,
            }
        }

        fn calls(&self) -> Vec<RecordedCliCall> {
            self.calls
                .lock()
                .unwrap_or_else(|_| panic!("calls lock poisoned"))
                .clone()
        }

        fn requests(&self) -> Vec<RecordedHttpRequest> {
            self.requests
                .lock()
                .unwrap_or_else(|_| panic!("requests lock poisoned"))
                .clone()
        }

        fn set_options(&self, mutate: impl FnOnce(&mut FixtureOptions)) {
            let mut guard = self
                .options
                .lock()
                .unwrap_or_else(|_| panic!("options lock poisoned"));
            mutate(&mut guard);
        }
    }

    #[tokio::test]
    async fn checks_dedicated_account_without_storing_or_using_personal_cli_profile()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let collections = f.service.check(&account).await?;

        assert_eq!(
            collections,
            vec![fixture_collection()],
            "check should return the single writable collection"
        );
        assert_eq!(
            f.keychain.stored(),
            None,
            "check must not write anything to the Keychain"
        );

        let calls = f.calls();
        assert!(!calls.is_empty(), "check must invoke the bw CLI");
        let directory = calls[0]
            .env
            .get("BITWARDENCLI_APPDATA_DIR")
            .cloned()
            .unwrap_or_default();
        assert!(
            !directory.is_empty(),
            "BITWARDENCLI_APPDATA_DIR must be set on CLI calls"
        );
        assert!(
            calls
                .iter()
                .all(|call| call.env.get("BITWARDENCLI_APPDATA_DIR") == Some(&directory)),
            "all CLI calls within one inspect must share the same isolated temp profile"
        );
        let stat = tokio::fs::metadata(&directory).await;
        assert!(
            matches!(stat, Err(ref e) if e.kind() == std::io::ErrorKind::NotFound),
            "temporary CLI profile directory must be deleted after check: {stat:?}"
        );

        let all_args = serde_json::to_string(&calls.iter().map(|c| &c.args).collect::<Vec<_>>())?;
        for secret in [
            account.master_password.as_str(),
            account.client_secret.as_str(),
            "fixture-session-key",
        ] {
            assert!(
                !all_args.contains(secret),
                "secret must never appear in CLI argv"
            );
        }

        let login_call = calls
            .iter()
            .find(|c| c.args.first().map(String::as_str) == Some("login"));
        assert_eq!(
            login_call.and_then(|c| c.env.get("BW_CLIENTSECRET").map(String::as_str)),
            Some(account.client_secret.as_str()),
            "login call must receive BW_CLIENTSECRET via env"
        );

        let unlock_call = calls
            .iter()
            .find(|c| c.args.first().map(String::as_str) == Some("unlock"));
        assert_eq!(
            unlock_call.and_then(|c| c.env.get("CONN_VAULT_PASSWORD").map(String::as_str)),
            Some(account.master_password.as_str()),
            "unlock call must receive CONN_VAULT_PASSWORD via env"
        );

        let list_call = calls
            .iter()
            .find(|c| c.args.first().map(String::as_str) == Some("list"));
        assert_eq!(
            list_call.and_then(|c| c.env.get("CONN_VAULT_PASSWORD")),
            None,
            "list call must not inherit CONN_VAULT_PASSWORD"
        );
        assert_eq!(
            calls[0].env.get("NODE_TLS_REJECT_UNAUTHORIZED"),
            None,
            "CLI env must never disable TLS verification"
        );

        let requests = f.requests();
        assert_eq!(
            requests.len(),
            2,
            "check should send token and sync requests"
        );
        assert!(
            requests[0].url.ends_with("/identity/connect/token"),
            "first HTTP request must hit the token endpoint: {}",
            requests[0].url
        );
        assert!(
            requests[1].url.ends_with("/api/sync?excludeDomains=true"),
            "second HTTP request must hit the sync endpoint: {}",
            requests[1].url
        );
        assert!(
            requests.iter().all(|r| r.redirect == RedirectPolicy::Error),
            "all HTTP requests must reject redirects"
        );
        let debug_result = format!("{collections:?}");
        assert!(
            !debug_result.contains("fixture-"),
            "check output must never contain fixture secrets"
        );
        Ok(())
    }

    #[tokio::test]
    async fn saves_only_after_verification_and_status_never_returns_stored_secrets()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let target = fixture_collection();

        let connection = f.service.save(&account, &target).await?;
        assert_eq!(
            connection.collection.id, COLLECTION_ID,
            "saved connection must reference the selected collection"
        );

        let stored_raw = f
            .keychain
            .stored()
            .ok_or("expected Keychain entry after save")?;
        let stored_json: serde_json::Value = serde_json::from_str(&stored_raw)?;
        assert_eq!(
            stored_json["account"],
            serde_json::json!({
                "server": account.server,
                "clientId": account.client_id,
                "clientSecret": account.client_secret,
                "masterPassword": account.master_password,
            }),
            "Keychain payload must store camelCase account JSON matching T3 Conn"
        );

        let status = f.service.status().await?;
        assert_eq!(
            status,
            Some(connection.clone()),
            "status must return the same non-secret connection metadata"
        );

        let formatted = format!("{connection:?}");
        for secret in [
            account.master_password.as_str(),
            account.client_secret.as_str(),
            "fixture-session-key",
        ] {
            assert!(
                !formatted.contains(secret),
                "connection metadata must never contain stored secrets"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn reuses_recent_check_while_fetching_fresh_permissions_before_saving()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let target = fixture_collection();

        let _ = f.service.check(&account).await?;
        let cli_calls = f.calls().len();
        let http_calls = f.requests().len();

        let _ = f.service.save(&account, &target).await?;
        assert_eq!(
            f.calls().len(),
            cli_calls,
            "save should reuse the recent check without re-running the bw CLI"
        );
        assert!(
            f.requests().len() > http_calls,
            "save must still fetch fresh permissions from the Vaultwarden API"
        );

        let stored_raw = f
            .keychain
            .stored()
            .ok_or("expected Keychain entry after save")?;
        let stored_json: serde_json::Value = serde_json::from_str(&stored_raw)?;
        assert_eq!(
            stored_json["account"]["clientSecret"], account.client_secret,
            "stored account must contain the verified account"
        );
        Ok(())
    }

    #[tokio::test]
    async fn rejects_permission_revocation_between_checking_and_saving()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let target = fixture_collection();

        f.keychain.set_raw("previous-connection");
        let _ = f.service.check(&account).await?;
        let cli_calls = f.calls().len();

        f.set_options(|opts| opts.read_only = true);
        let err = f.service.save(&account, &target).await;
        assert!(
            err.is_err(),
            "save must fail when permissions were revoked after check"
        );
        assert_eq!(
            f.calls().len(),
            cli_calls,
            "revocation check should reuse cached CLI check and re-check HTTP permissions"
        );
        assert_eq!(
            f.keychain.stored().as_deref(),
            Some("previous-connection"),
            "previous Keychain entry must be preserved on permission revocation"
        );
        Ok(())
    }

    #[tokio::test]
    async fn fully_checks_changed_account_details_before_saving()
    -> Result<(), Box<dyn std::error::Error>> {
        let base = fixture_account();
        let target = fixture_collection();

        let mutations: Vec<(&str, Account)> = vec![
            ("server", {
                let mut a = base.clone();
                a.server = "https://another.example".to_owned();
                a
            }),
            ("client_id", {
                let mut a = base.clone();
                a.client_id = format!("user.{ORG_ID}");
                a
            }),
            ("client_secret", {
                let mut a = base.clone();
                a.client_secret = "changed-api-secret".to_owned();
                a
            }),
            ("master_password", {
                let mut a = base.clone();
                a.master_password = "changed-master-password".to_owned();
                a
            }),
        ];

        for (label, changed) in mutations {
            let f = Fixture::new(FixtureOptions::default(), 1_000);
            let _ = f.service.check(&base).await?;
            let cli_calls = f.calls().len();

            f.set_options(|opts| opts.fail = true);
            let result = f.service.save(&changed, &target).await;
            assert!(
                result.is_err(),
                "changed {label} must force full re-verification and fail when unlock fails"
            );
            assert!(
                f.calls().len() > cli_calls,
                "changed {label} must invoke the bw CLI instead of reusing cache"
            );
            assert_eq!(
                f.keychain.stored(),
                None,
                "nothing must be stored when changed {label} fails verification"
            );
        }
        Ok(())
    }

    #[tokio::test]
    async fn fully_checks_expired_account_verification_before_saving()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let target = fixture_collection();

        let _ = f.service.check(&account).await?;
        let cli_calls = f.calls().len();

        f.clock.set_ms(301_001);
        let _ = f.service.save(&account, &target).await?;
        assert!(
            f.calls().len() > cli_calls,
            "expired check cache must trigger a full CLI re-check before saving"
        );
        Ok(())
    }

    #[tokio::test]
    async fn discards_recent_verification_when_disconnecting()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let target = fixture_collection();

        let _ = f.service.check(&account).await?;
        let cli_calls = f.calls().len();

        f.service.disconnect().await?;
        let _ = f.service.save(&account, &target).await?;
        assert!(
            f.calls().len() > cli_calls,
            "disconnect must clear cached verification so save re-runs the CLI"
        );
        Ok(())
    }

    #[tokio::test]
    async fn refuses_collection_with_insufficient_or_unconfirmed_permissions() {
        let account = fixture_account();
        let target = fixture_collection();

        let cases: Vec<(&str, FixtureOptions)> = vec![
            (
                "read_only",
                FixtureOptions {
                    read_only: true,
                    ..FixtureOptions::default()
                },
            ),
            (
                "hide_passwords",
                FixtureOptions {
                    hide_passwords: true,
                    ..FixtureOptions::default()
                },
            ),
            (
                "omit_permissions",
                FixtureOptions {
                    omit_permissions: true,
                    ..FixtureOptions::default()
                },
            ),
            (
                "unconfirmed_status",
                FixtureOptions {
                    status: 1,
                    ..FixtureOptions::default()
                },
            ),
            (
                "no_organizations",
                FixtureOptions {
                    no_organizations: true,
                    ..FixtureOptions::default()
                },
            ),
            (
                "disabled_organization",
                FixtureOptions {
                    disabled_organization: true,
                    ..FixtureOptions::default()
                },
            ),
        ];

        for (label, opts) in cases {
            let f = Fixture::new(opts, 1_000);
            f.keychain.set_raw("previous-connection");
            let result = f.service.save(&account, &target).await;
            assert!(
                result.is_err(),
                "save must reject collection for permission case: {label}"
            );
            assert_eq!(
                f.keychain.stored().as_deref(),
                Some("previous-connection"),
                "previous Keychain entry must stay intact for case: {label}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_forged_destination_even_when_another_writable_collection_exists() {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let account = fixture_account();
        let forged = Collection {
            id: COLLECTION_ID.to_owned(),
            organization_id: USER_ID.to_owned(),
            name: "Forged".to_owned(),
            organization_name: "Forged org".to_owned(),
        };

        let result = f.service.save(&account, &forged).await;
        assert_eq!(
            result,
            Err(Error::unwritable_collection()),
            "save must reject a forged organization/collection pair"
        );
        assert_eq!(
            f.keychain.stored(),
            None,
            "forged destination must never write to the Keychain"
        );
    }

    #[tokio::test]
    async fn redacts_failures_preserves_saved_account_and_removes_temp_profile() {
        let f = Fixture::new(
            FixtureOptions {
                fail: true,
                ..FixtureOptions::default()
            },
            1_000,
        );
        let account = fixture_account();
        let target = fixture_collection();

        f.keychain.set_raw("previous-connection");
        let Err(err) = f.service.save(&account, &target).await else {
            panic!("save must fail when bw unlock fails");
        };

        let display = err.to_string();
        let debug = format!("{err:?}");
        assert!(
            !display.contains(&account.master_password)
                && !debug.contains(&account.master_password),
            "error text must never leak the master password"
        );
        assert_eq!(
            f.keychain.stored().as_deref(),
            Some("previous-connection"),
            "failed save must preserve the existing Keychain entry"
        );

        let calls = f.calls();
        let directory = calls[0]
            .env
            .get("BITWARDENCLI_APPDATA_DIR")
            .cloned()
            .unwrap_or_default();
        let stat = tokio::fs::metadata(&directory).await;
        assert!(
            matches!(stat, Err(ref e) if e.kind() == std::io::ErrorKind::NotFound),
            "temporary CLI profile must be cleaned up even when unlock fails: {stat:?}"
        );
    }

    #[tokio::test]
    async fn rejects_account_identity_mismatch() {
        let f = Fixture::new(
            FixtureOptions {
                wrong_user: true,
                ..FixtureOptions::default()
            },
            1_000,
        );
        let account = fixture_account();
        let target = fixture_collection();

        let result = f.service.save(&account, &target).await;
        assert!(
            result.is_err(),
            "save must fail when sync profile id does not match client_id"
        );
        assert_eq!(
            f.keychain.stored(),
            None,
            "identity mismatch must not write to Keychain"
        );
        assert_eq!(
            f.requests().len(),
            2,
            "both token and sync requests should have executed before mismatch rejection"
        );
    }

    #[tokio::test]
    async fn refuses_unsafe_server_urls_before_sending_any_credentials() {
        let base = fixture_account();
        let target = fixture_collection();

        for server in [
            "http://vault.example",
            "https://user:password@vault.example",
            "https://vault.example/another",
            "https://vault.example?redirect=1",
        ] {
            let f = Fixture::new(FixtureOptions::default(), 1_000);
            let mut bad = base.clone();
            bad.server = server.to_owned();
            let result = f.service.save(&bad, &target).await;
            assert!(
                result.is_err(),
                "unsafe server URL must be rejected: {server}"
            );
            assert_eq!(
                f.calls().len(),
                0,
                "no CLI calls may run for unsafe server URL: {server}"
            );
            assert_eq!(
                f.requests().len(),
                0,
                "no HTTP requests may run for unsafe server URL: {server}"
            );
        }
    }

    #[tokio::test]
    async fn disconnects_only_local_keychain_storage_without_deleting_remote_items()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        f.keychain.set_raw("previous-connection");

        f.service.disconnect().await?;
        assert_eq!(
            f.keychain.stored(),
            None,
            "disconnect must clear the local Keychain entry"
        );
        assert_eq!(f.calls().len(), 0, "disconnect must not call the bw CLI");
        assert_eq!(
            f.requests().len(),
            0,
            "disconnect must not call the Vaultwarden API"
        );
        Ok(())
    }

    #[tokio::test]
    async fn reads_connection_saved_by_electron_keychain_format()
    -> Result<(), Box<dyn std::error::Error>> {
        let f = Fixture::new(FixtureOptions::default(), 1_000);
        let electron_json = serde_json::json!({
            "account": {
                "server": "https://vault.example",
                "clientId": format!("user.{USER_ID}"),
                "clientSecret": "fixture-api-secret",
                "masterPassword": "fixture-master-password",
            },
            "connection": {
                "server": "https://vault.example",
                "email": "conn@example.com",
                "collection": {
                    "id": COLLECTION_ID,
                    "name": "Conn",
                    "organizationId": ORG_ID,
                    "organizationName": "Conn organization",
                }
            }
        })
        .to_string();
        f.keychain.set_raw(&electron_json);

        let status = f.service.status().await?;
        assert_eq!(
            status,
            Some(Connection {
                email: "conn@example.com".to_owned(),
                server: "https://vault.example".to_owned(),
                collection: fixture_collection(),
            }),
            "GPUI must read connections saved by T3 Conn's Electron Keychain schema"
        );
        Ok(())
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_test_case_2_padded_key() {
        // Key padded to 32 bytes (RFC 2104 equivalence for keys <= 64 bytes).
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        let mac = hmac_sha256(&key, b"what do ya want for nothing?");
        let expected: [u8; 32] = [
            0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95,
            0x75, 0xc7, 0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9,
            0x64, 0xec, 0x38, 0x43,
        ];
        assert_eq!(
            mac, expected,
            "HMAC-SHA256 output must match RFC 4231 Test Case 2"
        );
    }
}
