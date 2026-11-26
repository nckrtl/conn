//! The browser's recently visited pages, shared by every browser panel and window of the app.
//!
//! Port of `apps/web/src/browserHistoryStore.ts` without its thread plumbing: the caller names the
//! project with an opaque key (the app derives it from the sidebar's project grouping), and this
//! store keeps the newest pages under it. One process-wide store lives behind
//! [`BrowserHistory::global`]; it loads `browser-history.json` once and saves every change from a
//! writer thread, so callers only take a short lock.
//!
//! Rules carried over from T3 Code:
//! - Only absolute http(s) URLs are kept, as the address bar resolved them. Credentials are dropped
//!   and a URL over 2048 bytes is refused.
//! - `localhost`, `127.x.x.x`, `::1`, `0.0.0.0` and the environment's own host are one page.
//!   The entry keeps the stable loopback spelling.
//! - A project keeps its 50 newest pages, and the store keeps the 20 projects visited last.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;
use url::Url;

pub(crate) const MAX_ENTRIES_PER_PROJECT: usize = 50;
pub(crate) const MAX_PROJECTS: usize = 20;
const MAX_URL_LENGTH: usize = 2048;
const MAX_TITLE_CHARS: usize = 512;
const MAX_VALID_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;
const FILE_VERSION: u64 = 1;

/// One remembered page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryEntry {
    pub(crate) url: String,
    /// Unix milliseconds of the latest visit.
    pub(crate) last_visited_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
}

type ByProject = BTreeMap<String, Vec<HistoryEntry>>;

#[derive(Debug)]
enum Msg {
    Save(String),
    /// Answers once everything sent before it is on disk.
    #[cfg(test)]
    Flush(Sender<()>),
}

#[derive(Debug)]
struct Inner {
    by_project: Mutex<ByProject>,
    /// The revision: grows by one with every real change, and wakes whoever subscribed.
    revision: watch::Sender<u64>,
    writer: Option<Sender<Msg>>,
}

/// A cheap handle on the app-wide history. Clones share one store.
#[derive(Clone, Debug)]
pub(crate) struct BrowserHistory {
    inner: Arc<Inner>,
}

impl BrowserHistory {
    /// The store every panel and window shares. It reads its file on first use.
    pub(crate) fn global() -> Self {
        // A test runs on a thread of its own with a deterministic scheduler. One store for the
        // whole process would let a change in one test wake the panels of another, on a thread
        // that scheduler does not own, so tests get a store per thread.
        #[cfg(test)]
        {
            thread_local! {
                static GLOBAL: BrowserHistory = BrowserHistory::open(None);
            }
            GLOBAL.with(Self::clone)
        }
        #[cfg(not(test))]
        {
            static GLOBAL: std::sync::OnceLock<BrowserHistory> = std::sync::OnceLock::new();
            GLOBAL
                .get_or_init(|| Self::open(history_file_path()))
                .clone()
        }
    }

    /// A store saved at `path`, or kept in memory only. A missing, broken or foreign-version file
    /// loads as empty.
    fn open(path: Option<PathBuf>) -> Self {
        let by_project = path.as_deref().map(load).unwrap_or_default();
        let writer = path.map(spawn_writer);
        Self {
            inner: Arc::new(Inner {
                by_project: Mutex::new(by_project),
                revision: watch::channel(0).0,
                writer,
            }),
        }
    }

    /// The project's pages, newest first, at most `limit`.
    pub(crate) fn recent(&self, project_key: &str, limit: usize) -> Vec<HistoryEntry> {
        self.lock()
            .get(project_key)
            .map(|entries| entries.iter().take(limit).cloned().collect())
            .unwrap_or_default()
    }

    /// Records a visit at `at_ms`. A page already in history moves up, and keeps its newer
    /// timestamp if `at_ms` is older (a replayed visit). Rejected URLs change nothing.
    /// `environment_hostname` is the host the environment runs on; the page on it is the page on
    /// `localhost`.
    pub(crate) fn record_visit(
        &self,
        project_key: &str,
        url: &str,
        at_ms: i64,
        environment_hostname: Option<&str>,
    ) {
        let Some(url) = normalize_history_url(url) else {
            return;
        };
        if !is_valid_timestamp(at_ms) {
            return;
        }
        self.mutate(|by_project| {
            let entries = by_project.entry(project_key.to_owned()).or_default();
            *entries = upsert_entry(entries, &url, at_ms, environment_hostname);
            evict_excess_projects(by_project);
            true
        });
    }

    /// Titles a page already in history, matching a trailing slash or the environment's host
    /// loosely. It never adds a page. An empty title is ignored.
    pub(crate) fn set_title(
        &self,
        project_key: &str,
        url: &str,
        title: &str,
        environment_hostname: Option<&str>,
    ) {
        let Some(url) = normalize_history_url(url) else {
            return;
        };
        let title = cap_title(title.trim());
        if title.is_empty() {
            return;
        }
        let key = title_lookup_key(&url, environment_hostname);
        self.mutate(|by_project| {
            let Some(entry) = by_project.get_mut(project_key).and_then(|entries| {
                entries
                    .iter_mut()
                    .find(|entry| title_lookup_key(&entry.url, environment_hostname) == key)
            }) else {
                return false;
            };
            if entry.title.as_deref() == Some(title.as_str()) {
                return false;
            }
            entry.title = Some(title);
            true
        });
    }

    /// Forgets a page. A project left with no pages goes too.
    pub(crate) fn remove(&self, project_key: &str, url: &str) {
        let Some(url) = normalize_history_url(url) else {
            return;
        };
        let key = visit_lookup_key(&url, None);
        self.mutate(|by_project| {
            let Some(entries) = by_project.get_mut(project_key) else {
                return false;
            };
            let before = entries.len();
            entries.retain(|entry| visit_lookup_key(&entry.url, None) != key);
            if entries.len() == before {
                return false;
            }
            if entries.is_empty() {
                by_project.remove(project_key);
            }
            true
        });
    }

    pub(super) fn revision(&self) -> u64 {
        *self.inner.revision.borrow()
    }

    /// A receiver of the revision. `changed()` resolves after each real change made since the
    /// receiver last saw the value, from any panel or window; it needs no runtime to be created.
    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.inner.revision.subscribe()
    }

    /// Waits until every change so far is on disk.
    #[cfg(test)]
    fn flush(&self) {
        if let Some(writer) = &self.inner.writer {
            let (ack, done) = mpsc::channel();
            if writer.send(Msg::Flush(ack)).is_ok() {
                let _ = done.recv();
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, ByProject> {
        self.inner
            .by_project
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `change` under the lock. If it reports a change, queues a save (under the lock, so
    /// saves reach the file in change order) and then, with the lock released, bumps the revision.
    /// A reader woken by the bump finds the change already in place.
    fn mutate(&self, change: impl FnOnce(&mut ByProject) -> bool) {
        {
            let mut by_project = self.lock();
            if !change(&mut by_project) {
                return;
            }
            if let Some(writer) = &self.inner.writer {
                let _ = writer.send(Msg::Save(to_file_json(&by_project)));
            }
        }
        self.inner.revision.send_modify(|revision| *revision += 1);
    }
}

// ----- URLs -----------------------------------------------------------------------------------

/// Query parameters that carry a credential, in their normalized form: lowercase, without `-` and
/// `_` (so `access_token`, `accessToken` and `Access-Token` are all `accesstoken`). A normalized
/// name that ends in `token`, `secret` or `signature`, or starts with `xamz` or `xgoog` (the AWS
/// and Google signing parameters), is secret too (see [`is_secret_query_name`]). Names are matched
/// whole or by those affixes only, so `keyword`, `codec` and `token_type` stay.
const SECRET_QUERY_NAMES: &[&str] = &[
    "token",
    "accesstoken",
    "idtoken",
    "refreshtoken",
    "code",
    "state",
    "signature",
    "sig",
    "key",
    "apikey",
    "password",
    "pass",
    "secret",
    "clientsecret",
    "auth",
    "session",
    "jwt",
    "otp",
];

fn is_secret_query_name(name: &str) -> bool {
    // Decode first, so `%74oken` cannot hide a name.
    let decoded = url::form_urlencoded::parse(name.as_bytes())
        .next()
        .map_or_else(String::new, |(name, _)| name.into_owned());
    let name: String = decoded
        .chars()
        .filter(|c| !matches!(c, '-' | '_'))
        .map(|c| c.to_ascii_lowercase())
        .collect();
    SECRET_QUERY_NAMES.contains(&name.as_str())
        || name.ends_with("token")
        || name.ends_with("secret")
        || name.ends_with("signature")
        || name.starts_with("xamz")
        || name.starts_with("xgoog")
}

/// What a secret path segment becomes. The history keeps the URL's shape and drops only the
/// secret, so `/reset/abc123` is stored as `/reset/:redacted`. (We redact in place instead of
/// truncating, so pages with a secret in the middle of the path keep what follows it.)
const REDACTED_SEGMENT: &str = ":redacted";

/// Path segments that name a credential in the segment after them, in normalized form (lowercase,
/// no `-` or `_`): `/reset/<token>`, `/invite/<token>`.
const SECRET_PATH_KEYS: &[&str] = &[
    "token",
    "tokens",
    "reset",
    "resetpassword",
    "passwordreset",
    "verify",
    "invite",
    "magic",
    "magiclink",
    "auth",
    "activate",
    "confirm",
];

fn is_base64url(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Three base64url parts joined by dots: `header.payload.signature`. A JWT header always starts
/// with `eyJ` (`{"`), so that form is enough with short parts (and an empty signature); any other
/// three long parts count too. `jquery.min.js` and `app.v2.css` do not.
fn is_jwt_shaped(segment: &str) -> bool {
    let parts: Vec<&str> = segment.split('.').collect();
    let [header, payload, signature] = parts[..] else {
        return false;
    };
    if !is_base64url(header) || !is_base64url(payload) || !is_base64url(signature) {
        return false;
    }
    if header.starts_with("eyJ") {
        return !payload.is_empty();
    }
    [header, payload, signature]
        .iter()
        .all(|part| part.len() >= 16)
}

/// A plain route word such as `callback`, `login` or `google`. It follows a path key without being
/// a credential, so `/auth/callback` stays.
fn is_plain_route_word(segment: &str) -> bool {
    segment.len() <= 16
        && !segment.starts_with('-')
        && segment.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

fn normalize_path_key(segment: &str) -> String {
    segment
        .chars()
        .filter(|c| !matches!(c, '-' | '_'))
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// The path with its secret segments replaced by [`REDACTED_SEGMENT`]: JWT-shaped segments and
/// the segment right after a [`SECRET_PATH_KEYS`] key (unless it is a plain route word). Long ids
/// stay: UUIDs, commit hashes, Google Docs and Notion document ids are page addresses, and
/// redacting them would merge distinct pages into one entry that no longer opens.
fn redact_secret_path(path: &str) -> String {
    let mut previous = String::new();
    let segments: Vec<String> = path
        .split('/')
        .map(|segment| {
            let key = normalize_path_key(segment);
            let after_secret_key = SECRET_PATH_KEYS.contains(&previous.as_str());
            let secret = !segment.is_empty()
                && (is_jwt_shaped(segment) || (after_secret_key && !is_plain_route_word(segment)));
            previous = key;
            if secret {
                REDACTED_SEGMENT.to_owned()
            } else {
                segment.to_owned()
            }
        })
        .collect();
    segments.join("/")
}

/// The query without its secret parameters. The other parameters keep their exact text and order,
/// so normal page URLs stay distinct. None when nothing is left.
fn strip_secret_query(query: &str) -> Option<String> {
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| !is_secret_query_name(pair.split_once('=').map_or(*pair, |(name, _)| name)))
        .collect();
    (!kept.is_empty()).then(|| kept.join("&"))
}

/// The canonical form of an absolute http(s) URL, without credentials; none for anything else
/// and for a URL over 2048 bytes. The history file and the new-tab page show this form, so it
/// carries no secret: no userinfo, no fragment (an implicit-flow `#access_token=`), none of
/// the [`SECRET_QUERY_NAMES`] query parameters and no secret path segment (see
/// [`redact_secret_path`]). Record, rename, remove and load all go through it, so a file written
/// by an older build is cleaned when it loads. It does not read typed text: the address bar has
/// already turned that into an address (`panels/address.rs`), so a bare `localhost:3000` is
/// refused here.
pub(crate) fn normalize_history_url(raw: &str) -> Option<String> {
    let mut parsed = Url::parse(raw.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_fragment(None);
    // Redaction shortens a URL, so the limit applies to the URL as given.
    if parsed.as_str().len() > MAX_URL_LENGTH {
        return None;
    }
    let path = redact_secret_path(parsed.path());
    parsed.set_path(&path);
    let query = parsed.query().and_then(strip_secret_query);
    parsed.set_query(query.as_deref());
    (parsed.as_str().len() <= MAX_URL_LENGTH).then(|| parsed.into())
}

/// `normalizeHostname`: lowercase, no IPv6 brackets, no trailing dots.
fn normalize_hostname(host: &str) -> String {
    let lower = host.to_ascii_lowercase();
    let unbracketed = lower.strip_prefix('[').unwrap_or(&lower);
    let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
    unbracketed.trim_end_matches('.').to_owned()
}

/// `isLocalLoopbackHost`: `localhost`, `::1` and the `127.0.0.0/8` addresses.
pub(super) fn is_local_loopback_host(host: &str) -> bool {
    let host = normalize_hostname(host);
    if host == "localhost" || host == "::1" {
        return true;
    }
    let parts: Vec<Option<u8>> = host.split('.').map(|part| part.parse().ok()).collect();
    parts.len() == 4 && parts.iter().all(Option::is_some) && parts[0] == Some(127)
}

fn is_stable_local_url(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(normalize_hostname))
        .is_some_and(|host| is_local_loopback_host(&host) || host == "0.0.0.0")
}

/// Two URLs with one key are one page: the loopback aliases and the environment's own host all
/// read as host `local`.
fn visit_lookup_key(url: &str, environment_hostname: Option<&str>) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_owned();
    };
    let host = parsed
        .host_str()
        .map(normalize_hostname)
        .unwrap_or_default();
    let environment_host = environment_hostname
        .map(normalize_hostname)
        .filter(|host| !host.is_empty());
    if is_local_loopback_host(&host)
        || host == "0.0.0.0"
        || environment_host.as_deref() == Some(host.as_str())
    {
        let _ = parsed.set_host(Some("local"));
    }
    parsed.into()
}

/// Whether `a` and `b` are one page under the rules [`BrowserHistory::set_title`] matches by: the
/// same after [`normalize_history_url`], ignoring a trailing slash, loopback aliases and the
/// environment's own host. False if either is rejected.
pub(crate) fn same_page(a: &str, b: &str, environment_hostname: Option<&str>) -> bool {
    match (normalize_history_url(a), normalize_history_url(b)) {
        (Some(a), Some(b)) => {
            title_lookup_key(&a, environment_hostname) == title_lookup_key(&b, environment_hostname)
        }
        _ => false,
    }
}

/// [`visit_lookup_key`] without one trailing slash on the path, so a settled page titles the entry
/// recorded with or without it.
fn title_lookup_key(url: &str, environment_hostname: Option<&str>) -> String {
    let key = visit_lookup_key(url, environment_hostname);
    let Ok(mut parsed) = Url::parse(&key) else {
        return key;
    };
    let path = parsed.path().to_owned();
    if path != "/"
        && let Some(trimmed) = path.strip_suffix('/')
    {
        parsed.set_path(trimmed);
    }
    parsed.into()
}

// ----- Entries --------------------------------------------------------------------------------

pub(super) fn is_valid_timestamp(at_ms: i64) -> bool {
    (-MAX_VALID_TIMESTAMP_MS..=MAX_VALID_TIMESTAMP_MS).contains(&at_ms)
}

fn cap_title(title: &str) -> String {
    title.chars().take(MAX_TITLE_CHARS).collect()
}

/// `upsertHistoryEntry` in its `insertOrdered` form, which keeps the list newest first whatever
/// order visits arrive in: an entry slots in by timestamp, ahead of entries with an equal one.
fn upsert_entry(
    entries: &[HistoryEntry],
    url: &str,
    at_ms: i64,
    environment_hostname: Option<&str>,
) -> Vec<HistoryEntry> {
    let key = visit_lookup_key(url, environment_hostname);
    let is_page = |entry: &HistoryEntry| visit_lookup_key(&entry.url, environment_hostname) == key;
    let existing = entries.iter().find(|entry| is_page(entry));
    let mut rest: Vec<HistoryEntry> = entries
        .iter()
        .filter(|entry| !is_page(entry))
        .cloned()
        .collect();
    let last_visited_at = existing.map_or(at_ms, |entry| entry.last_visited_at.max(at_ms));
    let stored_url = match existing {
        Some(entry) if is_stable_local_url(&entry.url) || !is_stable_local_url(url) => {
            entry.url.clone()
        }
        _ => url.to_owned(),
    };
    let entry = HistoryEntry {
        url: stored_url,
        last_visited_at,
        title: existing.and_then(|entry| entry.title.clone()),
    };
    let index = rest
        .iter()
        .position(|candidate| candidate.last_visited_at <= entry.last_visited_at)
        .unwrap_or(rest.len());
    rest.insert(index, entry);
    rest.truncate(MAX_ENTRIES_PER_PROJECT);
    rest
}

/// `evictExcessProjects`: keeps the projects visited last.
fn evict_excess_projects(by_project: &mut ByProject) {
    if by_project.len() <= MAX_PROJECTS {
        return;
    }
    let newest = |entries: &Vec<HistoryEntry>| entries.first().map_or(0, |e| e.last_visited_at);
    let mut keys: Vec<(i64, String)> = by_project
        .iter()
        .map(|(key, entries)| (newest(entries), key.clone()))
        .collect();
    keys.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    for (_, key) in keys.into_iter().skip(MAX_PROJECTS) {
        by_project.remove(&key);
    }
}

// ----- File -----------------------------------------------------------------------------------

/// `browser-history.json` beside the other `conn-gpui` files, or under `CONN_GPUI_CONFIG_DIR`.
/// Tests keep nothing on disk: they open their stores in memory.
#[cfg(not(test))]
fn history_file_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CONN_GPUI_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("browser-history.json"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    Some(home.join("Library/Application Support/conn-gpui/browser-history.json"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileRef<'a> {
    version: u64,
    by_project_key: &'a ByProject,
}

fn to_file_json(by_project: &ByProject) -> String {
    serde_json::to_string(&FileRef {
        version: FILE_VERSION,
        by_project_key: by_project,
    })
    .unwrap_or_default()
}

fn load(path: &Path) -> ByProject {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|file| file.get("version").and_then(Value::as_u64) == Some(FILE_VERSION))
        .map(|file| migrate(file.get("byProjectKey")))
        .unwrap_or_default()
}

/// `migratePersistedBrowserHistoryState`: keeps what is valid in a file that may be broken or
/// hand-edited, and re-applies every rule, so the stored lists are always sorted, unique, bounded
/// http(s) pages.
fn migrate(raw: Option<&Value>) -> ByProject {
    let Some(Value::Object(projects)) = raw else {
        return ByProject::new();
    };
    let mut by_project = ByProject::new();
    for (project_key, value) in projects {
        let Value::Array(candidates) = value else {
            continue;
        };
        let mut entries: Vec<HistoryEntry> =
            candidates.iter().filter_map(entry_from_json).collect();
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_visited_at));
        let mut seen = std::collections::HashSet::new();
        entries.retain(|entry| seen.insert(visit_lookup_key(&entry.url, None)));
        entries.truncate(MAX_ENTRIES_PER_PROJECT);
        if !entries.is_empty() {
            by_project.insert(project_key.clone(), entries);
        }
    }
    evict_excess_projects(&mut by_project);
    by_project
}

fn entry_from_json(candidate: &Value) -> Option<HistoryEntry> {
    let url = normalize_history_url(candidate.get("url")?.as_str()?)?;
    let at = candidate.get("lastVisitedAt")?;
    let last_visited_at = at.as_i64().or_else(|| {
        at.as_f64()
            .filter(|float| float.is_finite() && float.abs() <= MAX_VALID_TIMESTAMP_MS as f64)
            .map(|float| float as i64)
    })?;
    if !is_valid_timestamp(last_visited_at) {
        return None;
    }
    let title = candidate
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .map(cap_title);
    Some(HistoryEntry {
        url,
        last_visited_at,
        title,
    })
}

/// Saves go through one thread, newest save wins: saves that queued up meanwhile are skipped.
fn spawn_writer(path: PathBuf) -> Sender<Msg> {
    let (sender, receiver) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("browser-history-writer".to_owned())
        .spawn(move || write_loop(&receiver, &path));
    if let Err(error) = spawned {
        log::warn!("browser history will not be saved: {error}");
    }
    sender
}

fn write_loop(receiver: &Receiver<Msg>, path: &Path) {
    while let Ok(first) = receiver.recv() {
        let mut latest = None;
        #[cfg(test)]
        let mut acknowledgements = Vec::new();
        for message in std::iter::once(first).chain(receiver.try_iter()) {
            match message {
                Msg::Save(json) => latest = Some(json),
                #[cfg(test)]
                Msg::Flush(ack) => acknowledgements.push(ack),
            }
        }
        if let Some(json) = latest
            && let Err(error) = write_file(path, &json)
        {
            log::warn!(
                "browser history was not saved to {}: {error}",
                path.display()
            );
        }
        #[cfg(test)]
        for ack in acknowledgements {
            let _ = ack.send(());
        }
    }
}

/// Writes through a temporary file, readable by the user only (it lists the pages they visited).
/// The temporary name carries the process id, so two app processes never share one.
fn write_file(path: &Path, json: &str) -> std::io::Result<()> {
    static SAVES: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        SAVES.fetch_add(1, Ordering::Relaxed)
    ));
    let saved = write_private(&tmp, json).and_then(|()| std::fs::rename(&tmp, path));
    if saved.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    saved
}

/// Creates `path` (never an existing file) with mode 0600 from the start, and writes `contents`.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "env:/repo";

    fn urls(history: &BrowserHistory, key: &str) -> Vec<String> {
        history
            .recent(key, 100)
            .into_iter()
            .map(|entry| entry.url)
            .collect()
    }

    fn entry(url: &str, at: i64) -> HistoryEntry {
        HistoryEntry {
            url: url.to_owned(),
            last_visited_at: at,
            title: None,
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "conn-browser-history-{}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn keeps_absolute_http_urls_with_path_and_benign_query() {
        let cases = [
            (
                "http://localhost:3000/admin?tab=1",
                "http://localhost:3000/admin?tab=1",
            ),
            (
                "http://localhost:3000/search?q=rust&page=2&tab=1",
                "http://localhost:3000/search?q=rust&page=2&tab=1",
            ),
            ("http://127.1:3000", "http://127.0.0.1:3000/"),
            ("http://[::1]:8080/x", "http://[::1]:8080/x"),
            ("HTTPS://Example.com", "https://example.com/"),
            ("  https://example.com/a  ", "https://example.com/a"),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                normalize_history_url(raw).as_deref(),
                Some(expected),
                "{raw}"
            );
        }
    }

    #[test]
    fn strips_credentials() {
        let cases = [
            ("https://user:secret@example.com/", "https://example.com/"),
            ("http://token@localhost:3000/x", "http://localhost:3000/x"),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                normalize_history_url(raw).as_deref(),
                Some(expected),
                "{raw}"
            );
        }
    }

    #[test]
    fn drops_the_fragment() {
        let cases = [
            (
                "http://localhost:3000/app#/route",
                "http://localhost:3000/app",
            ),
            (
                "https://app.test/cb#access_token=abc&token_type=bearer",
                "https://app.test/cb",
            ),
            ("https://app.test/x?tab=1#top", "https://app.test/x?tab=1"),
            ("https://app.test/#", "https://app.test/"),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                normalize_history_url(raw).as_deref(),
                Some(expected),
                "{raw}"
            );
        }
    }

    #[test]
    fn drops_each_secret_query_parameter() {
        let names = [
            "token",
            "access_token",
            "id_token",
            "refresh_token",
            "code",
            "state",
            "signature",
            "sig",
            "key",
            "api_key",
            "apikey",
            "password",
            "pass",
            "secret",
            "client_secret",
            "auth",
            "session",
            "jwt",
            "otp",
            // Any name that ends in `_token` or `_secret`.
            "csrf_token",
            "xsrf_token",
            "app_secret",
            "webhook_secret",
            // camelCase and dashed spellings of the same names.
            "accessToken",
            "idToken",
            "refreshToken",
            "clientSecret",
            "apiKey",
            "api-key",
            "Access-Token",
            "csrfToken",
            "appSecret",
            "requestSignature",
            // Vendor signing parameters.
            "X-Goog-Signature",
            "X-Goog-Credential",
            "X-Goog-Date",
            "X-Goog-Expires",
            "X-Amz-Signature",
            "X-Amz-Credential",
            "X-Amz-Security-Token",
            "X-Amz-Date",
            "X-Amz-Expires",
            "X-Amz-SignedHeaders",
            "X-Amz-Algorithm",
        ];
        for name in names {
            for spelled in [
                name.to_owned(),
                name.to_ascii_uppercase(),
                name.to_ascii_lowercase(),
            ] {
                let alone = format!("https://app.test/p?{spelled}=s3cr3t");
                assert_eq!(
                    normalize_history_url(&alone).as_deref(),
                    Some("https://app.test/p"),
                    "{alone}"
                );
                let among = format!("https://app.test/p?a=1&{spelled}=s3cr3t&b=2");
                assert_eq!(
                    normalize_history_url(&among).as_deref(),
                    Some("https://app.test/p?a=1&b=2"),
                    "{among}"
                );
            }
        }
    }

    #[test]
    fn drops_secret_names_however_they_are_written() {
        let cases = [
            // A value-less secret parameter.
            ("https://app.test/p?token&a=1", "https://app.test/p?a=1"),
            // A percent-encoded name.
            ("https://app.test/p?%74oken=s&a=1", "https://app.test/p?a=1"),
            // The OAuth callback and the implicit flow together.
            (
                "https://app.test/auth/callback?code=c&state=s#access_token=t",
                "https://app.test/auth/callback",
            ),
            // A signed Laravel link keeps its other parameters; the id after `/verify/` goes.
            (
                "http://app.test/verify/1?expires=1700000000&signature=abc",
                "http://app.test/verify/:redacted?expires=1700000000",
            ),
            // The secret is the name: a secret-looking value under a plain name is kept.
            ("https://app.test/p?q=token", "https://app.test/p?q=token"),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                normalize_history_url(raw).as_deref(),
                Some(expected),
                "{raw}"
            );
        }
    }

    #[test]
    fn keeps_benign_parameters_so_pages_stay_distinct() {
        let a = normalize_history_url("https://app.test/items?id=1&sort=name");
        let b = normalize_history_url("https://app.test/items?id=2&sort=name");
        assert_eq!(a.as_deref(), Some("https://app.test/items?id=1&sort=name"));
        assert_eq!(b.as_deref(), Some("https://app.test/items?id=2&sort=name"));
        assert_ne!(a, b);
        for raw in [
            "https://app.test/p?tab=1",
            "https://app.test/p?page=3&q=a%20b",
            "https://app.test/p?keyword=rust&passage=1&coder=x&states=2&authors=3",
            "https://app.test/p?keywords=a&codec=h264&keyCount=2&passthrough=1&stateless=1",
            "https://app.test/p?unsigned=1&signed=1&sessionId=9&tokenType=bearer",
            "https://app.test/p?xamazing=1&xgo=1&xyz=2&secretary=1&tokenizer=1",
            "https://app.test/p?tokens=1&session_id=9&token_type=bearer",
            "https://app.test/p?x-amazing=1",
        ] {
            assert_eq!(normalize_history_url(raw).as_deref(), Some(raw), "{raw}");
        }
    }

    #[test]
    fn redacts_secret_path_segments() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        let b64 = "q83vK2lO0pXz9RtYw1uHn7BcDe4FgJa5MsVx6Zi_8T-A";
        let cases = [
            // JWT-shaped segments.
            (format!("https://app.test/s/{jwt}/view"), "https://app.test/s/:redacted/view"),
            // Long secrets after a secret path key.
            (format!("https://app.test/reset/{hex}"), "https://app.test/reset/:redacted"),
            (format!("https://app.test/token/{b64}?a=1"), "https://app.test/token/:redacted?a=1"),
            ("https://app.test/s/aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccccccc".to_owned(), "https://app.test/s/:redacted"),
            // The segment after a known path key, in any case and spelling.
            ("https://app.test/token/abc123".to_owned(), "https://app.test/token/:redacted"),
            ("https://app.test/password/reset/Xk29aZ".to_owned(), "https://app.test/password/reset/:redacted"),
            ("https://app.test/Reset_Password/987654".to_owned(), "https://app.test/Reset_Password/:redacted"),
            ("https://app.test/verify/1".to_owned(), "https://app.test/verify/:redacted"),
            ("https://app.test/invite/Zm9vYmFy/accept".to_owned(), "https://app.test/invite/:redacted/accept"),
            ("https://app.test/magic/a1B2c3".to_owned(), "https://app.test/magic/:redacted"),
            ("https://app.test/auth/x7Yq2".to_owned(), "https://app.test/auth/:redacted"),
            ("https://app.test/email/verify/7/da39a3ee5e6b4b0d3255bfef95601890afd80709".to_owned(), "https://app.test/email/verify/:redacted/da39a3ee5e6b4b0d3255bfef95601890afd80709"),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                normalize_history_url(&raw).as_deref(),
                Some(expected),
                "{raw}"
            );
            // Redacting twice changes nothing.
            assert_eq!(
                normalize_history_url(expected).as_deref(),
                Some(expected),
                "{expected}"
            );
        }
        for (key, secret) in [("s", jwt), ("reset", hex), ("token", b64)] {
            let url = normalize_history_url(&format!("https://app.test/{key}/{secret}"))
                .unwrap_or_default();
            assert!(!url.contains(secret), "{url}");
        }
    }

    #[test]
    fn keeps_slugs_ids_and_short_hashes_in_paths() {
        let sha40 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
        let sha64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        let mut kept = vec![
            "https://app.test/".to_owned(),
            "https://app.test/items/42".to_owned(),
            "https://app.test/users/7/posts/1234567890".to_owned(),
            "https://app.test/blog/how-to-build-a-rust-web-app-in-2024-step-by-step".to_owned(),
            "https://app.test/docs/a_long_snake_case_page_name_for_the_guide_section".to_owned(),
            "https://app.test/assets/jquery.min.js".to_owned(),
            "https://app.test/assets/app.v2.css".to_owned(),
            "https://app.test/repo/commit/a1b2c3d".to_owned(),
            "https://app.test/repo/commit/a1b2c3d4e5f6".to_owned(),
            "https://app.test/projects/3f2a9c1e".to_owned(),
            "https://app.test/auth/callback".to_owned(),
            "https://app.test/auth/google/callback".to_owned(),
            "https://app.test/verify".to_owned(),
            "https://app.test/tokens".to_owned(),
            "https://app.test/keyword/codec".to_owned(),
            "https://app.test/a//b/".to_owned(),
        ];
        // Long resource ids are page addresses, not secrets: commit ids anywhere, canonical
        // UUIDs, Google Docs and Notion document ids, and long base64url ids.
        for sha in [sha40, sha64] {
            for key in ["commit", "tree", "blob", "dl", "files"] {
                kept.push(format!("https://github.test/o/r/{key}/{sha}"));
            }
        }
        kept.extend([
            "https://app.test/projects/3f2a9c1e-7b4d-4e8a-9c21-5d6f0a1b2c3d".to_owned(),
            "https://app.test/projects/3F2A9C1E-7B4D-4E8A-9C21-5D6F0A1B2C3D/settings".to_owned(),
            "https://docs.google.com/document/d/1aBcD3fGhIjK4lMnOpQr5StUvWxYz6AbCdEfGhIjKlMn/edit"
                .to_owned(),
            "https://www.notion.so/acme/Roadmap-8f6a2b1c9d0e4f7a8b3c5d2e1f0a9b8c".to_owned(),
            "https://www.notion.so/8f6a2b1c9d0e4f7a8b3c5d2e1f0a9b8c".to_owned(),
            "https://app.test/d/q83vK2lO0pXz9RtYw1uHn7BcDe4FgJa5MsVx6Zi_8T-A".to_owned(),
        ]);
        for raw in &kept {
            assert_eq!(
                normalize_history_url(raw).as_deref(),
                Some(raw.as_str()),
                "{raw}"
            );
        }
    }

    #[test]
    fn a_secret_never_reaches_the_store_or_the_file() {
        let path = temp_file("no-secrets.json");
        let _ = std::fs::remove_file(&path);
        let history = BrowserHistory::open(Some(path.clone()));
        for (at, url) in [
            "https://app.test/login/magic?token=TOKEN-SECRET",
            "https://app.test/auth/callback?code=CODE-SECRET&state=STATE-SECRET",
            "https://app.test/signed?signature=SIGNATURE-SECRET&id=7",
            "https://app.test/spa#access_token=FRAGMENT-SECRET",
        ]
        .into_iter()
        .zip(1..)
        .map(|(url, at)| (at, url))
        {
            history.record_visit(KEY, url, at, None);
        }
        history.flush();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        for secret in [
            "TOKEN-SECRET",
            "CODE-SECRET",
            "STATE-SECRET",
            "SIGNATURE-SECRET",
            "FRAGMENT-SECRET",
        ] {
            assert!(!text.contains(secret), "{secret} saved: {text}");
        }
        assert_eq!(
            urls(&history, KEY),
            [
                "https://app.test/spa",
                "https://app.test/signed?id=7",
                "https://app.test/auth/callback",
                "https://app.test/login/magic",
            ]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_existing_file_is_cleaned_when_it_loads() {
        let path = temp_file("dirty.json");
        let _ = std::fs::remove_file(&path);
        let dirty = serde_json::json!({
            "version": 1,
            "byProjectKey": {
                KEY: [
                    { "url": "https://app.test/cb?code=OLD-CODE&state=OLD-STATE", "lastVisitedAt": 5 },
                    { "url": "https://app.test/cb?code=OTHER-CODE", "lastVisitedAt": 4 },
                    { "url": "https://app.test/spa#access_token=OLD-FRAGMENT", "lastVisitedAt": 3 },
                    { "url": "https://app.test/p?tab=1&jwt=OLD-JWT#frag", "lastVisitedAt": 2, "title": "P" },
                    { "url": "https://app.test/x?client_secret=OLD-SECRET&id=7", "lastVisitedAt": 1 },
                    { "url": "https://app.test/y?accessToken=OLD-CAMEL&X-Goog-Signature=OLD-GOOG&n=1", "lastVisitedAt": 0 },
                    { "url": "https://app.test/reset/OLD-RESET-PATH", "lastVisitedAt": -1 },
                ]
            }
        });
        std::fs::write(&path, dirty.to_string()).expect("the file is written");

        let history = BrowserHistory::open(Some(path.clone()));
        assert_eq!(
            history.recent(KEY, 10),
            [
                entry("https://app.test/cb", 5),
                entry("https://app.test/spa", 3),
                HistoryEntry {
                    title: Some("P".to_owned()),
                    ..entry("https://app.test/p?tab=1", 2)
                },
                entry("https://app.test/x?id=7", 1),
                entry("https://app.test/y?n=1", 0),
                entry("https://app.test/reset/:redacted", -1),
            ],
            "cleaned, and the two callbacks are one page"
        );

        // The next save rewrites the file without a trace of them.
        history.record_visit(KEY, "https://app.test/new", 6, None);
        history.flush();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(text.contains("https://app.test/new"), "saved: {text}");
        for secret in [
            "OLD-CODE",
            "OLD-STATE",
            "OTHER-CODE",
            "OLD-FRAGMENT",
            "OLD-JWT",
            "OLD-SECRET",
            "OLD-CAMEL",
            "OLD-GOOG",
            "OLD-RESET-PATH",
        ] {
            assert!(!text.contains(secret), "{secret} kept: {text}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_other_schemes_typed_text_and_oversized_urls() {
        let long = format!("http://localhost/{}", "a".repeat(2048));
        for raw in [
            "",
            "   ",
            "localhost:3000",
            "example.com",
            "/relative/path",
            "ftp://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.test",
            "data:text/html,hi",
            "about:blank",
            "ws://localhost:1/",
            "http://",
            "not a url at all",
            long.as_str(),
        ] {
            assert_eq!(normalize_history_url(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_visit_moves_a_page_up_and_a_replayed_older_visit_keeps_the_newer_time() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://a.test/", 1000, None);
        history.record_visit(KEY, "http://b.test/", 2000, None);
        history.record_visit(KEY, "http://a.test/", 3000, None);
        assert_eq!(urls(&history, KEY), ["http://a.test/", "http://b.test/"]);
        history.record_visit(KEY, "http://a.test/", 1500, None);
        assert_eq!(
            history.recent(KEY, 1),
            [entry("http://a.test/", 3000)],
            "an older replay must not lower the timestamp"
        );
    }

    #[test]
    fn visits_arriving_out_of_order_still_list_newest_first() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://newer.test/", 2000, None);
        history.record_visit(KEY, "http://older.test/", 1000, None);
        history.record_visit(KEY, "http://middle.test/", 1500, None);
        assert_eq!(
            urls(&history, KEY),
            [
                "http://newer.test/",
                "http://middle.test/",
                "http://older.test/"
            ]
        );
    }

    #[test]
    fn recent_honours_the_limit_and_unknown_projects_are_empty() {
        let history = BrowserHistory::open(None);
        for i in 0..5 {
            history.record_visit(KEY, &format!("http://p{i}.test/"), i, None);
        }
        assert_eq!(history.recent(KEY, 3).len(), 3);
        assert_eq!(history.recent(KEY, 0).len(), 0);
        assert!(history.recent("other", 8).is_empty());
    }

    #[test]
    fn loopback_aliases_and_the_environment_host_are_one_page() {
        let env = Some("192.168.64.2");
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://localhost:5173/app", 1, env);
        history.record_visit(KEY, "http://127.0.0.1:5173/app", 2, env);
        history.record_visit(KEY, "http://192.168.64.2:5173/app", 3, env);
        assert_eq!(
            history.recent(KEY, 8),
            [entry("http://localhost:5173/app", 3)]
        );

        let other = BrowserHistory::open(None);
        other.record_visit(KEY, "http://192.168.64.2:5173/app", 4, env);
        other.record_visit(KEY, "http://localhost:5173/app", 5, env);
        assert_eq!(
            other.recent(KEY, 8),
            [entry("http://localhost:5173/app", 5)],
            "the stable loopback spelling wins whichever came first"
        );
    }

    #[test]
    fn different_ports_and_remote_hosts_stay_apart() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://localhost:5173/", 1, None);
        history.record_visit(KEY, "http://localhost:3000/", 2, None);
        history.record_visit(KEY, "http://a.test/", 3, None);
        history.record_visit(KEY, "https://a.test/", 4, None);
        assert_eq!(history.recent(KEY, 10).len(), 4);
    }

    #[test]
    fn rejected_urls_and_bad_timestamps_change_nothing() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "ftp://a.test/", 1, None);
        history.record_visit(KEY, "", 1, None);
        history.record_visit(KEY, "http://a.test/", i64::MAX, None);
        assert_eq!(history.revision(), 0);
        assert!(history.recent(KEY, 8).is_empty());
    }

    #[test]
    fn a_project_keeps_its_fifty_newest_pages() {
        let history = BrowserHistory::open(None);
        for i in 0..60 {
            history.record_visit(KEY, &format!("http://p{i}.test/"), i, None);
        }
        let kept = history.recent(KEY, 100);
        assert_eq!(kept.len(), MAX_ENTRIES_PER_PROJECT);
        assert_eq!(kept[0].url, "http://p59.test/");
        assert_eq!(kept[49].url, "http://p10.test/");
    }

    #[test]
    fn the_store_keeps_the_twenty_projects_visited_last() {
        let history = BrowserHistory::open(None);
        for i in 0..=MAX_PROJECTS as i64 {
            history.record_visit(&format!("project-{i}"), "http://a.test/", i + 1, None);
        }
        assert!(
            history.recent("project-0", 8).is_empty(),
            "the oldest project goes"
        );
        for i in 1..=MAX_PROJECTS {
            assert_eq!(history.recent(&format!("project-{i}"), 8).len(), 1);
        }
    }

    #[test]
    fn a_title_goes_only_on_an_existing_page() {
        let history = BrowserHistory::open(None);
        history.set_title(KEY, "http://a.test/", "Ghost", None);
        assert!(
            history.recent(KEY, 8).is_empty(),
            "a title must not add a page"
        );
        assert_eq!(history.revision(), 0);

        history.record_visit(KEY, "http://a.test/?page=settings", 1, None);
        history.set_title(KEY, "http://a.test/?page=settings", "  My App  ", None);
        assert_eq!(history.recent(KEY, 1)[0].title.as_deref(), Some("My App"));
        history.set_title(KEY, "http://a.test/?page=settings", "   ", None);
        assert_eq!(history.recent(KEY, 1)[0].title.as_deref(), Some("My App"));
    }

    #[test]
    fn a_title_survives_a_revisit() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://a.test/", 1, None);
        history.set_title(KEY, "http://a.test/", "My App", None);
        history.record_visit(KEY, "http://a.test/", 2, None);
        assert_eq!(history.recent(KEY, 1)[0].title.as_deref(), Some("My App"));
    }

    #[test]
    fn a_title_matches_across_a_trailing_slash_and_the_environment_host() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://a.test/community", 1, None);
        history.set_title(KEY, "http://a.test/community/", "Community", None);
        assert_eq!(
            history.recent(KEY, 1)[0].title.as_deref(),
            Some("Community")
        );

        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://a.test/community/", 1, None);
        history.set_title(KEY, "http://a.test/community", "Community", None);
        assert_eq!(history.recent(KEY, 1)[0].url, "http://a.test/community/");
        assert_eq!(
            history.recent(KEY, 1)[0].title.as_deref(),
            Some("Community")
        );

        let env = Some("192.168.64.2");
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://localhost:5173/app", 1, env);
        history.set_title(KEY, "http://192.168.64.2:5173/app", "Local App", env);
        assert_eq!(
            history.recent(KEY, 1)[0].title.as_deref(),
            Some("Local App")
        );
    }

    #[test]
    fn same_page_follows_the_title_rules_and_refuses_rejected_urls() {
        let env = Some("192.168.64.2");
        let same = [
            ("http://a.test/community", "http://a.test/community/"),
            ("http://localhost:5173/app", "http://127.0.0.1:5173/app"),
            ("http://localhost:5173/app", "http://192.168.64.2:5173/app"),
            ("https://user:pw@a.test/x", "https://a.test/x"),
        ];
        for (a, b) in same {
            assert!(same_page(a, b, env), "{a} == {b}");
            assert!(same_page(b, a, env), "{b} == {a}");
        }
        let different = [
            ("http://a.test/x", "http://a.test/y"),
            ("http://a.test/x", "https://a.test/x"),
            ("http://localhost:5173/", "http://localhost:3000/"),
            ("http://a.test/x?q=1", "http://a.test/x"),
            ("http://192.168.64.2:5173/", "http://localhost:5173/"),
        ];
        for (a, b) in different {
            assert!(!same_page(a, b, None), "{a} != {b}");
        }
        assert!(!same_page("ftp://a.test/", "ftp://a.test/", env));
        assert!(!same_page("", "", env));
        assert!(!same_page("http://a.test/", "javascript:1", env));
    }

    #[test]
    fn a_title_is_capped_and_an_unchanged_title_is_no_change() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://a.test/", 1, None);
        history.set_title(KEY, "http://a.test/", &"é".repeat(600), None);
        assert_eq!(
            history.recent(KEY, 1)[0]
                .title
                .as_deref()
                .map(|t| t.chars().count()),
            Some(MAX_TITLE_CHARS)
        );
        let revision = history.revision();
        history.set_title(KEY, "http://a.test/", &"é".repeat(600), None);
        assert_eq!(history.revision(), revision);
    }

    #[test]
    fn remove_forgets_a_page_and_drops_an_empty_project() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://a.test/", 1, None);
        history.record_visit(KEY, "http://b.test/", 2, None);
        history.remove(KEY, "http://a.test/");
        assert_eq!(urls(&history, KEY), ["http://b.test/"]);
        history.remove(KEY, "http://missing.test/");
        history.remove(KEY, "ftp://nope");
        history.remove(KEY, "http://b.test/");
        assert!(
            history.lock().get(KEY).is_none(),
            "an empty project is dropped"
        );
    }

    #[test]
    fn remove_takes_the_loopback_alias_of_a_page() {
        let history = BrowserHistory::open(None);
        history.record_visit(KEY, "http://localhost:5173/", 1, None);
        history.remove(KEY, "http://127.0.0.1:5173/");
        assert!(history.recent(KEY, 8).is_empty());
    }

    #[test]
    fn projects_keep_separate_pages() {
        let history = BrowserHistory::open(None);
        history.record_visit("a", "http://a.test/", 1, None);
        history.record_visit("b", "http://b.test/", 2, None);
        assert_eq!(urls(&history, "a"), ["http://a.test/"]);
        assert_eq!(urls(&history, "b"), ["http://b.test/"]);
    }

    #[test]
    fn the_revision_moves_only_on_a_real_change() {
        let history = BrowserHistory::open(None);
        assert_eq!(history.revision(), 0);
        history.record_visit(KEY, "http://a.test/", 1, None);
        assert_eq!(history.revision(), 1);
        history.set_title(KEY, "http://a.test/", "A", None);
        assert_eq!(history.revision(), 2);
        history.set_title(KEY, "http://a.test/", "A", None);
        history.remove(KEY, "http://missing.test/");
        assert_eq!(history.revision(), 2);
        history.remove(KEY, "http://a.test/");
        assert_eq!(history.revision(), 3);
    }

    #[test]
    fn a_subscriber_is_told_of_real_changes_only() {
        let history = BrowserHistory::open(None);
        let mut changes = history.subscribe();
        let second_subscriber = history.subscribe();
        let unseen = |changes: &watch::Receiver<u64>| changes.has_changed().unwrap_or(false);
        assert!(
            !unseen(&changes),
            "a new subscriber has seen the current value"
        );

        history.record_visit(KEY, "ftp://a.test/", 1, None);
        history.set_title(KEY, "http://missing.test/", "Ghost", None);
        history.remove(KEY, "http://missing.test/");
        assert!(!unseen(&changes), "a no-op must not wake anyone");

        history.record_visit(KEY, "http://a.test/", 1, None);
        assert!(unseen(&changes), "a visit is a change");
        assert!(unseen(&second_subscriber), "every subscriber is told");
        assert_eq!(*changes.borrow_and_update(), 1);
        assert!(!unseen(&changes), "borrow_and_update marks the value seen");

        history.set_title(KEY, "http://a.test/", "A", None);
        history.set_title(KEY, "http://a.test/", "A", None);
        assert!(unseen(&changes), "a title is a change");
        assert_eq!(
            *changes.borrow_and_update(),
            2,
            "the repeated title is not a second change"
        );

        history.remove(KEY, "http://a.test/");
        assert!(unseen(&changes), "a removal is a change");
        assert_eq!(*changes.borrow_and_update(), history.revision());
    }

    #[test]
    fn every_clone_and_the_global_handle_see_one_store() {
        let first = BrowserHistory::global();
        let second = BrowserHistory::global();
        let clone = first.clone();
        let key = "history-test-global-store";
        first.record_visit(key, "http://shared.test/", 7, None);
        assert_eq!(urls(&second, key), ["http://shared.test/"]);
        assert_eq!(urls(&clone, key), ["http://shared.test/"]);
        clone.remove(key, "http://shared.test/");
        assert!(first.recent(key, 8).is_empty());
    }

    #[test]
    fn history_survives_a_restart_in_order_with_titles() {
        let path = temp_file("restart.json");
        let _ = std::fs::remove_file(&path);
        {
            let history = BrowserHistory::open(Some(path.clone()));
            history.record_visit(KEY, "http://a.test/", 1, None);
            history.record_visit(KEY, "http://localhost:5173/", 2, None);
            history.set_title(KEY, "http://a.test/", "A", None);
            history.record_visit("other", "https://b.test/x?y=1", 3, None);
            history.remove("other", "https://nope.test/");
            history.flush();
        }
        let restarted = BrowserHistory::open(Some(path.clone()));
        assert_eq!(
            restarted.recent(KEY, 8),
            [
                entry("http://localhost:5173/", 2),
                HistoryEntry {
                    title: Some("A".to_owned()),
                    ..entry("http://a.test/", 1)
                }
            ]
        );
        assert_eq!(urls(&restarted, "other"), ["https://b.test/x?y=1"]);
        restarted.remove(KEY, "http://a.test/");
        restarted.flush();
        assert_eq!(
            urls(&BrowserHistory::open(Some(path.clone())), KEY),
            ["http://localhost:5173/"]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_save_is_private_and_leaves_no_temporary_file() {
        let dir = temp_file("private-dir");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("browser-history.json");
        let history = BrowserHistory::open(Some(path.clone()));
        history.record_visit(KEY, "http://a.test/", 1, None);
        history.record_visit(KEY, "http://b.test/", 2, None);
        history.flush();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).map(|meta| meta.permissions().mode() & 0o777);
            assert_eq!(
                mode.ok(),
                Some(0o600),
                "the history file is for the user only"
            );
        }
        let names: Vec<String> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|file| file.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["browser-history.json"], "no temporary file is left");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_holds_no_credentials() {
        let path = temp_file("secrets.json");
        let _ = std::fs::remove_file(&path);
        let history = BrowserHistory::open(Some(path.clone()));
        history.record_visit(KEY, "https://user:hunter2@example.com/", 1, None);
        history.flush();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(text.contains("https://example.com/"), "saved: {text}");
        assert!(!text.contains("hunter2"), "saved: {text}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_broken_or_foreign_file_loads_empty() {
        let path = temp_file("broken.json");
        let _ = std::fs::remove_file(&path);
        assert!(load(&path).is_empty(), "missing file");
        for text in [
            "not json",
            "[]",
            r#"{"version":2,"byProjectKey":{"p":[{"url":"http://a.test/","lastVisitedAt":1}]}}"#,
            r#"{"byProjectKey":{"p":[{"url":"http://a.test/","lastVisitedAt":1}]}}"#,
            r#"{"version":1,"byProjectKey":42}"#,
        ] {
            let _ = std::fs::write(&path, text);
            assert!(load(&path).is_empty(), "{text}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn loading_drops_invalid_entries_and_restores_order_dedupe_and_bounds() {
        let mut projects = serde_json::Map::new();
        projects.insert(
            "good".to_owned(),
            serde_json::json!([
                { "url": "http://a.test/", "lastVisitedAt": 100, "title": "A" },
                { "url": "", "lastVisitedAt": 100 },
                { "url": "ftp://ghost.test/", "lastVisitedAt": 100 },
                { "url": "http://b.test/", "lastVisitedAt": "soon" },
                { "url": "http://c.test/", "lastVisitedAt": 1e300 },
                { "url": "https://user:pw@d.test/", "lastVisitedAt": 50 },
                { "url": "http://localhost:3000/", "lastVisitedAt": 10 },
                { "url": "http://127.0.0.1:3000/", "lastVisitedAt": 20 },
                { "url": "http://e.test/", "lastVisitedAt": 60, "title": "" },
                "junk",
                42
            ]),
        );
        projects.insert("bad".to_owned(), serde_json::json!("junk"));
        projects.insert("empty".to_owned(), serde_json::json!([]));
        for i in 0..=MAX_PROJECTS {
            projects.insert(
                format!("project-{i:02}"),
                serde_json::json!([{ "url": "http://p.test/", "lastVisitedAt": i }]),
            );
        }
        let migrated = migrate(Some(&Value::Object(projects)));

        assert_eq!(
            migrated["good"],
            [
                HistoryEntry {
                    title: Some("A".to_owned()),
                    ..entry("http://a.test/", 100)
                },
                entry("http://e.test/", 60),
                entry("https://d.test/", 50),
                entry("http://127.0.0.1:3000/", 20),
            ],
            "sorted newest first, credentials gone, loopback aliases merged"
        );
        assert!(!migrated.contains_key("bad") && !migrated.contains_key("empty"));
        assert_eq!(migrated.len(), MAX_PROJECTS);
        assert!(
            !migrated.contains_key("project-00"),
            "the least recently visited project goes"
        );
    }

    #[test]
    fn loading_keeps_at_most_fifty_pages_per_project() {
        let pages: Vec<Value> = (0..80)
            .map(|i| serde_json::json!({ "url": format!("http://p{i}.test/"), "lastVisitedAt": i }))
            .collect();
        let migrated = migrate(Some(&serde_json::json!({ "p": pages })));
        assert_eq!(migrated["p"].len(), MAX_ENTRIES_PER_PROJECT);
        assert_eq!(migrated["p"][0].url, "http://p79.test/");
    }
}
