//! Starts Chromium the first time something needs it: a Browser tab, an agent's page, or an
//! embedded document. Until then no Chromium helper process runs; the GPU, network and storage
//! helpers it starts cost 93–250 MB with no tab open.
//!
//! The file work that can be done ahead stays at launch, on a background thread: the first-run
//! download and building the helper apps ([`prepare_after_launch`]). Mapping the 1.3 GB framework
//! and starting CEF wait for the first use ([`begin`]). The main thread only runs what CEF requires
//! of it (`cef_initialize` and the message loop). Tests and `CONN_GPUI_NO_CEF=1` never start it.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use conn_web::{WebError, WebRuntime};
use gpui_kit::App;

static BEGUN: AtomicBool = AtomicBool::new(false);
static FAILURE: Mutex<Option<String>> = Mutex::new(None);
/// Held while the download or the helper apps are being prepared, so the launch preparation and
/// a first use never do that file work at the same time.
static PREPARING: Mutex<()> = Mutex::new(());
#[cfg(test)]
thread_local! {
    /// How many times something on this thread asked for Chromium ([`begin`]), counted even
    /// though CEF is off in tests, so a test can see which actions would start it.
    static REQUESTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Whether this process must never start CEF.
#[must_use]
pub(crate) fn disabled() -> bool {
    cfg!(test) || std::env::var_os("CONN_GPUI_NO_CEF").is_some()
}

/// Why the last start failed before CEF could report a state of its own (helpers, framework).
#[must_use]
pub(crate) fn failure() -> Option<String> {
    FAILURE.lock().ok().and_then(|f| f.clone())
}

/// Whether a warm-up is under way (download, helpers, framework, or the start itself).
#[must_use]
pub(crate) fn active() -> bool {
    BEGUN.load(Ordering::Acquire)
}

/// How many times something on this thread asked for Chromium so far.
#[cfg(test)]
#[must_use]
pub(crate) fn requests() -> usize {
    REQUESTS.with(std::cell::Cell::get)
}

/// After launch, does the file work CEF will need on a background thread: the first-run download
/// and the helper apps. Starts no Chromium process and maps no framework. A failure here is only
/// logged: the first use tries again and shows it.
pub(crate) fn prepare_after_launch() {
    if disabled() {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("conn-web-prepare".into())
        .spawn(|| {
            if let Err(err) = prepare_files() {
                log::debug!("Chromium preparation at launch did not finish: {err}");
            }
        });
    if let Err(err) = spawned {
        log::debug!("could not start the Chromium preparation thread: {err}");
    }
}

/// Starts Chromium for its first user: a Browser tab, an agent's page or an embedded document.
/// Does nothing while a start is under way or CEF is up, and tries again after a failure.
pub(crate) fn begin(cx: &mut App) {
    #[cfg(test)]
    REQUESTS.with(|requests| requests.set(requests.get() + 1));
    if disabled() {
        return;
    }
    begin_inner(cx);
}

fn begin_inner(cx: &mut App) {
    if BEGUN.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Ok(mut failure) = FAILURE.lock() {
        *failure = None;
    }
    let (tx, rx) = futures::channel::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("conn-web-warmup".into())
        .spawn(move || {
            let _ = tx.send(prepare_off_main_thread());
        });
    if let Err(err) = spawned {
        fail(&format!(
            "could not start the Chromium warm-up thread: {err}"
        ));
        return;
    }
    cx.spawn(async move |_cx| {
        let prepared = rx.await;
        match prepared {
            Ok(Ok(())) => {
                let started = std::time::Instant::now();
                let result = WebRuntime::global().start();
                log::debug!(
                    "CEF start returned on the main thread after {:?}",
                    started.elapsed()
                );
                if let Err(err) = result {
                    fail(&err.to_string());
                }
            }
            Ok(Err(err)) => fail(&err.to_string()),
            Err(_) => fail("the Chromium warm-up thread ended without a result"),
        }
    })
    .detach();
}

/// Download (first run) and helper apps. One caller at a time.
fn prepare_files() -> Result<(), WebError> {
    let _preparing = PREPARING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let runtime = WebRuntime::global();
    runtime.ensure_installed(|_| {})?;
    runtime.prepare()
}

/// Download (first run), helper apps and framework mapping: all file work, off the main thread.
fn prepare_off_main_thread() -> Result<(), WebError> {
    prepare_files()?;
    WebRuntime::global().preload_framework()
}

/// Records a failure the panel shows, and allows a later tab open to try again.
fn fail(why: &str) {
    log::error!("Chromium warm-up failed: {why}");
    if let Ok(mut failure) = FAILURE.lock() {
        *failure = Some(why.to_owned());
    }
    BEGUN.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::TestAppContext;

    #[gpui_kit::test]
    fn tests_never_start_chromium(cx: &mut TestAppContext) {
        assert!(disabled());
        // Not even a direct call starts a warm-up, so nothing downloads or starts CEF in tests.
        cx.update(begin);
        prepare_after_launch();
        assert!(!active());
        assert_eq!(failure(), None);
    }

    #[test]
    fn the_launch_preparation_never_asks_for_chromium() {
        let before = requests();
        prepare_after_launch();
        assert_eq!(
            requests(),
            before,
            "launch prepares files only; Chromium waits for its first use"
        );
    }
}
