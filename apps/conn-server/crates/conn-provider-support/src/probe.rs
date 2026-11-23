//! Runs a provider CLI for a status probe (Grok's status and Antigravity's health check), as
//! T3's `spawnAndCollect` does (`packages/provider-core/src/server/snapshotProbe.ts` on Effect's Node spawner): its own
//! process group, the given environment and nothing else, stdin a pipe that stays open, stdout
//! and stderr collected, and on a timeout SIGTERM to the group, then SIGKILL after 1 s
//! (`PROBE_FORCE_KILL_AFTER`) unless the CLI and every pipe holder have ended. The CLI is
//! reaped only after the last group signal, so a reused group id never gets one.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

/// `PROBE_FORCE_KILL_AFTER`.
const FORCE_KILL_AFTER: Duration = Duration::from_secs(1);
/// T3 collects all output. We keep the first 4 MiB of each stream, so a CLI that floods its
/// output cannot grow the server's memory without bound. No probe output comes near it.
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// `CommandResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Why a probe could not run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandError {
    /// `isCommandMissingCause`: the executable does not exist.
    NotFound,
    /// Any other spawn or read failure (permission denied, not an executable, …).
    Failed(String),
}

/// `spawnAndCollect` under `Effect.timeoutOption`: `Ok(None)` when the timeout passed first.
pub async fn spawn_and_collect(
    program: &str,
    args: &[&str],
    environment: &[(String, String)],
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<Option<CommandOutput>, CommandError> {
    run_collect(program, args, environment, cwd, None, timeout).await
}

/// As [`spawn_and_collect`], with `stdin` written to the child and then closed (Effect's
/// spawner with `stdin: { stream }`).
pub async fn run_collect(
    program: &str,
    args: &[&str],
    environment: &[(String, String)],
    cwd: Option<&Path>,
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<Option<CommandOutput>, CommandError> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(environment.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    command.process_group(0);
    conn_support::spawn_guard::check(command.as_std());
    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => CommandError::NotFound,
        _ => CommandError::Failed(error.to_string()),
    })?;
    let pid = child.id();
    // Without input, held open until the child ends, as Effect's spawner leaves an unused
    // stdin pipe; with input, written and closed.
    let input = stdin.map(str::to_owned);
    let (held, fed) = match input {
        Some(_) => (None, child.stdin.take()),
        None => (child.stdin.take(), None),
    };
    let feed = async move {
        if let (Some(text), Some(mut pipe)) = (input, fed) {
            use tokio::io::AsyncWriteExt;
            let _ = pipe.write_all(text.as_bytes()).await;
            let _ = pipe.shutdown().await;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Kept past a timeout: after the group signal, closed pipes show the helpers have ended.
    let mut output =
        std::pin::pin!(async move { tokio::join!(read_capped(stdout), read_capped(stderr)) });
    // The CLI stays unreaped until every signal to its group is sent, so no other process can
    // hold the group id yet.
    let result = tokio::time::timeout(timeout, async {
        let (_, output, ours) = tokio::join!(feed, &mut output, exited_unreaped(pid));
        (output, ours)
    })
    .await;
    drop(held);
    match result {
        Ok(((stdout, stderr), ours)) => {
            // A referenced detached child: the scope's release signals the group once more,
            // which ends any helper the CLI left behind.
            #[cfg(unix)]
            if let (true, Some(pid)) = (ours, pid) {
                crate::process::signal_group(pid, rustix::process::Signal::TERM);
            }
            #[cfg(not(unix))]
            let _ = ours;
            let status = child
                .wait()
                .await
                .map_err(|e| CommandError::Failed(e.to_string()))?;
            Ok(Some(CommandOutput {
                stdout,
                stderr,
                code: exit_code(status),
            }))
        }
        Err(_) => {
            // Not reaped yet (`child.wait` has not run), so the pid is still the CLI's.
            #[cfg(unix)]
            if let Some(pid) = pid {
                use crate::process::{signal_group, wait_exit_unreaped};
                use rustix::process::Signal;
                signal_group(pid, Signal::TERM);
                let ended = tokio::time::timeout(FORCE_KILL_AFTER, async {
                    tokio::join!(&mut output, wait_exit_unreaped(pid))
                })
                .await
                .is_ok();
                if !ended {
                    signal_group(pid, Signal::KILL);
                }
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            Ok(None)
        }
    }
}

/// Whether the CLI has exited and is still unreaped ([`crate::process::wait_exit_unreaped`]).
#[cfg(unix)]
async fn exited_unreaped(pid: Option<u32>) -> bool {
    match pid {
        Some(pid) => crate::process::wait_exit_unreaped(pid).await,
        None => false,
    }
}

#[cfg(not(unix))]
async fn exited_unreaped(_pid: Option<u32>) -> bool {
    false
}

/// Node reports a signal death as a null code; Effect turns it into a number. A probe that
/// dies by a signal is a failed run either way.
fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

async fn read_capped(stream: Option<impl AsyncRead + Unpin>) -> String {
    let Some(mut stream) = stream else {
        return String::new();
    };
    let mut kept = Vec::new();
    let mut chunk = vec![0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(chunk.get(..n.min(room)).unwrap_or_default());
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn path_env() -> Vec<(String, String)> {
        std::env::vars().filter(|(k, _)| k == "PATH").collect()
    }

    #[tokio::test]
    async fn collects_output_and_code() {
        let out = spawn_and_collect(
            "sh",
            &["-c", "echo out; echo err >&2; exit 3"],
            &path_env(),
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(out.stdout, "out\n");
        assert_eq!(out.stderr, "err\n");
        assert_eq!(out.code, 3);
    }

    #[tokio::test]
    async fn a_missing_program_is_not_found() {
        let error = spawn_and_collect(
            "/nonexistent/conn-probe",
            &[],
            &[],
            None,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert_eq!(error, CommandError::NotFound);
    }

    #[tokio::test]
    async fn a_hung_program_that_ignores_sigterm_is_killed() {
        let started = std::time::Instant::now();
        let out = spawn_and_collect(
            "sh",
            &["-c", "trap '' TERM; sleep 30"],
            &path_env(),
            None,
            Duration::from_millis(200),
        )
        .await
        .unwrap();
        assert_eq!(out, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// The CLI exits at once and leaves a helper that holds stdout, so the probe times out.
    /// When the group SIGTERM reaches the helper, it records the CLI's state: still an
    /// unreaped zombie (`Z`), so the group id could not have been reused.
    #[tokio::test]
    async fn the_group_is_signalled_before_the_cli_is_reaped() {
        let dir = std::env::temp_dir().join(format!("conn-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join("leader-state");
        let script = format!(
            "( trap \"ps -o stat= -p $$ > '{}'; exit 0\" TERM; while :; do sleep 0.05; done ) & exit 0",
            state.display()
        );
        let out = spawn_and_collect(
            "sh",
            &["-c", &script],
            &path_env(),
            None,
            Duration::from_millis(300),
        )
        .await
        .unwrap();
        assert_eq!(out, None);
        let seen = std::fs::read_to_string(&state).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            seen.trim_start().starts_with('Z'),
            "the CLI was already reaped when its group was signalled: {seen:?}"
        );
    }
}
