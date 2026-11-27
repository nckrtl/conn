//! Attachment bytes on disk ([`conn_image_cache::ImageCache`]): a sent picture downloads once
//! per environment and then comes from `image-cache-v1/`, next to the offline message cache,
//! across thread switches, reconnects and restarts.
//!
//! The cache opens on first use, off the UI thread. Every read and write runs on the background
//! executor.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use conn_client::{ClientError, Connection, FetchDeadlines};
use conn_image_cache::ImageCache;
use gpui_kit::BackgroundExecutor;

/// Bytes of attachments kept on disk. Past it, the pictures used longest ago go first.
pub(crate) const DISK_CAP_BYTES: u64 = 1024 * 1024 * 1024;

/// Where attachment bytes live: a lazily opened on-disk cache, or nowhere.
#[derive(Clone)]
pub(crate) struct ImageStore(Arc<Inner>);

struct Inner {
    dir: Option<PathBuf>,
    cap: u64,
    cache: OnceLock<Option<ImageCache>>,
}

impl ImageStore {
    /// The app's store in its config folder. Tests without `CONN_GPUI_CONFIG_DIR` get none, so
    /// they never touch the user's cache.
    pub(crate) fn shared() -> Self {
        static SHARED: OnceLock<ImageStore> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                if cfg!(test) && std::env::var_os("CONN_GPUI_CONFIG_DIR").is_none() {
                    return Self::disabled();
                }
                let dir = conn_desktop::orbit::OrbitSessionStore::default_path()
                    .and_then(|path| path.parent().map(|dir| dir.join("image-cache-v1")));
                Self::new(dir, DISK_CAP_BYTES)
            })
            .clone()
    }

    /// A store in `dir` that keeps at most `cap` bytes.
    #[cfg(test)]
    pub(crate) fn at(dir: PathBuf, cap: u64) -> Self {
        Self::new(Some(dir), cap)
    }

    /// A store that keeps nothing: every read misses.
    pub(crate) fn disabled() -> Self {
        Self::new(None, 0)
    }

    fn new(dir: Option<PathBuf>, cap: u64) -> Self {
        Self(Arc::new(Inner {
            dir,
            cap,
            cache: OnceLock::new(),
        }))
    }

    /// The cache, opened on first call. Blocking: call it off the UI thread.
    fn cache(&self) -> Option<&ImageCache> {
        self.0
            .cache
            .get_or_init(|| {
                let dir = self.0.dir.as_ref()?;
                match ImageCache::open(dir, self.0.cap) {
                    Ok(cache) => Some(cache),
                    Err(err) => {
                        eprintln!("image cache: {err}");
                        None
                    }
                }
            })
            .as_ref()
    }

    /// Whether this store keeps anything.
    pub(crate) fn enabled(&self) -> bool {
        self.0.dir.is_some()
    }

    /// The bytes of `id` on `environment`, when they are on disk. Blocking.
    pub(crate) fn get(&self, environment: &str, id: &str) -> Option<Vec<u8>> {
        self.cache()?.get(environment, id)
    }

    /// Whether `id` of `environment` is on disk. Blocking (the first call opens the cache).
    pub(crate) fn contains(&self, environment: &str, id: &str) -> bool {
        self.cache()
            .is_some_and(|cache| cache.contains(environment, id))
    }

    /// Keeps `bytes` as `id` of `environment`. Blocking; a failed write only logs.
    pub(crate) fn put(&self, environment: &str, id: &str, bytes: &[u8]) {
        if let Some(cache) = self.cache()
            && let Err(err) = cache.put(environment, id, bytes)
        {
            eprintln!("image cache: write failed: {err}");
        }
    }

    /// The bytes of attachment `id`: from disk when an earlier download kept them, otherwise from
    /// `connection` within `deadlines` (and at most `limit` bytes), then kept on disk.
    /// `environment` names the server the attachment lives on; with none, nothing is kept.
    ///
    /// # Errors
    /// Returns the download's error when the bytes are not on disk.
    pub(crate) async fn attachment_bytes(
        &self,
        background: &BackgroundExecutor,
        connection: &Connection,
        environment: Option<&str>,
        id: &str,
        deadlines: FetchDeadlines,
        limit: Option<usize>,
    ) -> Result<Vec<u8>, ClientError> {
        let environment = environment.filter(|_| self.enabled()).map(str::to_owned);
        if let Some(environment) = environment.clone() {
            let store = self.clone();
            let key = id.to_owned();
            let cached = background
                .spawn(async move { store.get(&environment, &key) })
                .await;
            if let Some(bytes) = cached.filter(|bytes| limit.is_none_or(|max| bytes.len() <= max)) {
                return Ok(bytes);
            }
        }
        let bytes = connection
            .fetch_attachment_bytes_limited(id, deadlines, limit)
            .await?;
        if let Some(environment) = environment {
            let store = self.clone();
            let key = id.to_owned();
            let copy = bytes.clone();
            background
                .spawn(async move { store.put(&environment, &key, &copy) })
                .detach();
        }
        Ok(bytes)
    }
}
