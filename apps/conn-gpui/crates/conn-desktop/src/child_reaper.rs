//! Collects exited child processes without depending on SIGCHLD.
//!
//! On Unix, Tokio learns that a child exited only through SIGCHLD. Inside the app that signal is
//! not reliable: Chromium (the embedded CEF) resets SIGCHLD to its default handling while it
//! starts, which removes Tokio's handler for the rest of the session. `Child::wait()` and
//! `Child::kill()` then never finish. The children stay zombies, and every request that awaits
//! them hangs.
//!
//! So a request never awaits a child's exit on the signal:
//! - [`OwnedChild`] owns a child for one request. When it drops, on success, error, timeout or
//!   cancellation, it kills the child and hands it to the reaper. The request returns at once.
//! - [`wait_polled`] waits for an exit by polling `try_wait()`, for the rare caller that needs
//!   the exit status (a CLI's success flag) or a graceful shutdown.
//! - [`retire`] kills a child and hands it to the reaper: one owned background thread that polls
//!   `try_wait()` with a short backoff until each child is collected.

use std::io;
use std::process::ExitStatus;
use std::sync::{Condvar, Mutex, MutexGuard, Once, PoisonError};
use std::time::Duration;

use tokio::process::Child;

/// First poll after a child is retired. A killed child is usually gone by then.
const FIRST_POLL: Duration = Duration::from_millis(5);
/// Slowest poll, for a child that ignores SIGKILL for a while (uninterruptible I/O).
const MAX_POLL: Duration = Duration::from_millis(500);

/// Children that were killed and still need to be collected.
static PENDING: Mutex<Vec<Child>> = Mutex::new(Vec::new());
/// Wakes the reaper when a child is retired.
static WAKE: Condvar = Condvar::new();
static START: Once = Once::new();

fn pending() -> MutexGuard<'static, Vec<Child>> {
    PENDING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Kills `child` (SIGKILL) without waiting, and collects its exit in the background.
pub fn retire(mut child: Child) {
    // Fails only when the child was already collected, which is fine.
    let _ = child.start_kill();
    if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
        return;
    }
    pending().push(child);
    WAKE.notify_one();
    START.call_once(|| {
        // If the thread cannot start, the children stay zombies until the app exits. The
        // request that retired them has already returned.
        let _ = std::thread::Builder::new()
            .name("conn-child-reaper".into())
            .spawn(reap_forever);
    });
}

fn reap_forever() {
    let mut delay = FIRST_POLL;
    let mut children = pending();
    loop {
        // `Ok(None)`: still running. `Ok(Some(_))`: collected now. `Err(_)`: nothing to collect.
        children.retain_mut(|child| matches!(child.try_wait(), Ok(None)));
        if children.is_empty() {
            delay = FIRST_POLL;
            children = WAKE.wait(children).unwrap_or_else(PoisonError::into_inner);
            continue;
        }
        let (guard, wait) = WAKE
            .wait_timeout(children, delay)
            .unwrap_or_else(PoisonError::into_inner);
        children = guard;
        delay = if wait.timed_out() {
            (delay * 2).min(MAX_POLL)
        } else {
            FIRST_POLL
        };
    }
}

/// Waits for `child` to exit by polling `try_wait()`, so a lost SIGCHLD cannot stall it. Bound
/// it with `tokio::time::timeout`; on timeout, the child is still yours to kill or retire.
///
/// # Errors
///
/// Returns the error `try_wait()` returns.
pub async fn wait_polled(child: &mut Child) -> io::Result<ExitStatus> {
    let mut delay = Duration::from_millis(1);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_millis(100));
    }
}

/// A child that one request owns. Dropping it kills the child and lets the reaper collect it,
/// so no path out of the request waits for the exit.
#[derive(Debug)]
pub struct OwnedChild(Option<Child>);

impl OwnedChild {
    #[must_use]
    pub fn new(child: Child) -> Self {
        Self(Some(child))
    }

    /// The child, to take its pipes or read its id.
    pub fn child(&mut self) -> &mut Child {
        match &mut self.0 {
            Some(child) => child,
            // `self.0` is `None` only inside `drop`.
            None => unreachable!("OwnedChild holds its child until it drops"),
        }
    }

    /// Waits for the exit status, as [`wait_polled`] does.
    ///
    /// # Errors
    ///
    /// Returns the error `try_wait()` returns.
    pub async fn exit_status(&mut self) -> io::Result<ExitStatus> {
        wait_polled(self.child()).await
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            retire(child);
        }
    }
}
