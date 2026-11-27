//! Opt-in latency log (`CONN_GPUI_PERF_LOG=1`, or `CONN_PERF_LOG_FILE=<path>`).
//!
//! Each line goes to stderr as `[perf] <stage> thread=<id> ... +<ms>ms`, where `+<ms>` is the
//! time since that thread was opened (or subscribed, for the client's own stages). The check
//! is one cached atomic load, so the disabled path costs nothing measurable.
//!
//! The `sync.*` lines ([`shell_cached`], [`shell_current`], [`open_drawn`], [`open_current`],
//! [`kept_current`]) carry the time since the process started instead, and both apps emit them
//! under the same names. `CONN_PERF_LOG_FILE` also appends every line to that file (relative to
//! `$HOME`, the app's data container on iOS), for a harness that cannot read stderr.

use std::io::Write as _;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn log_file() -> Option<&'static Mutex<std::fs::File>> {
    static FILE: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();
    FILE.get_or_init(|| {
        let path = std::path::PathBuf::from(std::env::var_os("CONN_PERF_LOG_FILE")?);
        let path = match std::env::var_os("HOME") {
            Some(home) if path.is_relative() => std::path::Path::new(&home).join(path),
            _ => path,
        };
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()?;
        Some(Mutex::new(file))
    })
    .as_ref()
}

/// Whether `CONN_GPUI_PERF_LOG=1` (or `true`) or `CONN_PERF_LOG_FILE` was set when the process
/// first asked.
#[must_use]
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("CONN_GPUI_PERF_LOG")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            || log_file().is_some()
    })
}

/// Milliseconds elapsed since `start`, for log lines.
#[must_use]
pub fn ms_since(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Sets when the process started (milliseconds since the Unix epoch), for the `sync.*` lines.
/// Without it they count from the first perf line.
pub fn set_process_start(epoch_ms: f64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let ago = now.saturating_sub(Duration::from_secs_f64(epoch_ms.max(0.0) / 1000.0));
    let _ = PROCESS_START.set(Instant::now().checked_sub(ago).unwrap_or_else(Instant::now));
}

/// Milliseconds since the process started (see [`set_process_start`]).
#[must_use]
pub fn ms_since_start() -> f64 {
    ms_since(*PROCESS_START.get_or_init(Instant::now))
}

/// Writes one `[perf]` line when the log is enabled. Prefer the [`perf_log!`] macro, which
/// skips formatting entirely when the log is off.
pub fn write(line: std::fmt::Arguments<'_>) {
    eprintln!("[perf] {line}");
    if let Some(file) = log_file()
        && let Ok(mut file) = file.lock()
    {
        let _ = writeln!(file, "[perf] {line}");
    }
}

/// Logs a `[perf]` line when `CONN_GPUI_PERF_LOG=1`; formats nothing otherwise.
#[macro_export]
macro_rules! perf_log {
    ($($arg:tt)*) => {
        if $crate::perf::enabled() {
            $crate::perf::write(format_args!($($arg)*));
        }
    };
}

fn sync(stage: std::fmt::Arguments<'_>) {
    if enabled() {
        write(format_args!("sync.{stage} +{:.1}ms", ms_since_start()));
    }
}

/// The thread list is drawn from data on the device.
pub fn shell_cached() {
    sync(format_args!("shell_cached"));
}

/// The first synchronized shell of this connection is published.
pub fn shell_current() {
    sync(format_args!("shell_current"));
}

/// The open thread's first rows reach the view; `source` is `device` or `server`.
pub fn open_drawn(thread: &str, source: &str) {
    sync(format_args!("open_drawn thread={thread} source={source}"));
}

/// The open thread's stream sent `synchronized` and it is applied: the syncing bar may clear.
pub fn open_current(thread: &str) {
    sync(format_args!("open_current thread={thread}"));
}

/// Every kept thread has had its `synchronized` on this connection.
pub fn kept_current(count: usize) {
    sync(format_args!("kept_current count={count}"));
}
