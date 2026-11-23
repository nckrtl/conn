//! Runs a provider CLI for a status probe (Grok's status and Antigravity's health check), as
//! T3's `spawnAndCollect` does (`packages/provider-core/src/server/snapshotProbe.ts` on Effect's Node spawner): its own
//! process group, the given environment and nothing else, stdin a pipe that stays open, stdout
//! and stderr collected, and on a timeout SIGTERM to the group, then SIGKILL after 1 s
//! (`PROBE_FORCE_KILL_AFTER`) unless the CLI and every pipe holder have ended. The CLI is
//! reaped only after the last group signal, so a reused group id never gets one. When another
//! waiter reaps the CLI first, the probe fails at once and signals nothing.

use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::{Pin, pin};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};

use crate::process::Exit;

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
    /// Any other spawn, read or wait failure (permission denied, not an executable, the CLI
    /// reaped by another waiter, …).
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
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    command.process_group(0);
    conn_support::spawn_guard::check(command.as_std());
    let child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => CommandError::NotFound,
        _ => CommandError::Failed(error.to_string()),
    })?;
    let mut cli = Cli { child, ours: true };
    let pid = cli
        .child
        .id()
        .ok_or_else(|| CommandError::Failed("the spawned CLI has no pid".into()))?;
    // Without input, held open until the child ends, as Effect's spawner leaves an unused
    // stdin pipe; with input, written and closed.
    let input = stdin.map(str::to_owned);
    let (held, fed) = match input {
        Some(_) => (None, cli.child.stdin.take()),
        None => (cli.child.stdin.take(), None),
    };
    let feed = async move {
        if let (Some(text), Some(mut pipe)) = (input, fed) {
            use tokio::io::AsyncWriteExt;
            let _ = pipe.write_all(text.as_bytes()).await;
            let _ = pipe.shutdown().await;
        }
    };
    let stdout = cli.child.stdout.take();
    let stderr = cli.child.stderr.take();
    let mut seen = Seen::default();
    let in_time = {
        let mut output = pin!(async move {
            let ((), stdout, stderr) = tokio::join!(feed, read_capped(stdout), read_capped(stderr));
            (stdout, stderr)
        });
        // The CLI stays unreaped until every signal to its group is sent, so no other process
        // can hold the group id yet.
        #[cfg(unix)]
        let mut exit = pin!(crate::process::wait_exit_unreaped(pid));
        #[cfg(not(unix))]
        let mut exit = pin!(async { cli.child.wait().await.map(|_| Exit::Exited) });
        let in_time = tokio::time::timeout(timeout, seen.settle(output.as_mut(), exit.as_mut()))
            .await
            .is_ok();
        drop(held);
        // Past the timeout the same two futures go on: what finished stays in `seen`.
        #[cfg(unix)]
        if !in_time && seen.signal_group(pid, rustix::process::Signal::TERM) {
            let _ = tokio::time::timeout(
                FORCE_KILL_AFTER,
                seen.settle(output.as_mut(), exit.as_mut()),
            )
            .await;
            if !seen.ended() {
                seen.signal_group(pid, rustix::process::Signal::KILL);
            }
        }
        in_time
    };
    match seen.exit {
        Some(Ok(Exit::Lost)) => return Err(cli.lost()),
        Some(Err(error)) => return Err(CommandError::Failed(error.to_string())),
        _ => {}
    }
    if !in_time {
        #[cfg(unix)]
        if seen.ours(pid) {
            let _ = cli.child.start_kill();
        }
        #[cfg(not(unix))]
        let _ = cli.child.start_kill();
        return cli.reap(pid).await.map(|_| None);
    }
    // A referenced detached child: the scope's release signals the group once more, which
    // ends any helper the CLI left behind.
    #[cfg(unix)]
    seen.signal_group(pid, rustix::process::Signal::TERM);
    let status = cli.reap(pid).await?;
    let (stdout, stderr) = seen.output.unwrap_or_default();
    Ok(Some(CommandOutput {
        stdout,
        stderr,
        code: exit_code(status),
    }))
}

/// The spawned CLI. Dropped while ours and unreaped, it gets SIGKILL, as `kill_on_drop` does;
/// once another waiter has reaped it, its pid may name another process and gets nothing.
#[derive(Debug)]
struct Cli {
    child: tokio::process::Child,
    ours: bool,
}

impl Cli {
    fn lost(&mut self) -> CommandError {
        self.ours = false;
        CommandError::Failed("another waiter reaped the CLI".into())
    }

    /// Reaps the CLI once it has exited. The exit is seen as in
    /// [`crate::process::wait_exit_unreaped`], so a missed SIGCHLD only costs a poll.
    #[cfg(unix)]
    async fn reap(&mut self, pid: u32) -> Result<ExitStatus, CommandError> {
        use rustix::io::Errno;
        match crate::process::wait_exit_unreaped(pid).await {
            Ok(Exit::Exited) => {}
            Ok(Exit::Lost) => return Err(self.lost()),
            Err(error) => return Err(CommandError::Failed(error.to_string())),
        }
        match self.child.try_wait() {
            Ok(Some(status)) => Ok(status),
            Err(error) if Errno::from_io_error(&error) == Some(Errno::CHILD) => Err(self.lost()),
            // Exited above, so `try_wait` has the status; `wait` covers the case it has not.
            Ok(None) | Err(_) => self
                .child
                .wait()
                .await
                .map_err(|error| CommandError::Failed(error.to_string())),
        }
    }

    #[cfg(not(unix))]
    async fn reap(&mut self, _pid: u32) -> Result<ExitStatus, CommandError> {
        self.child
            .wait()
            .await
            .map_err(|error| CommandError::Failed(error.to_string()))
    }
}

impl Drop for Cli {
    fn drop(&mut self) {
        if self.ours {
            // An error means it was reaped already: nothing to stop.
            let _ = self.child.start_kill();
        }
    }
}

/// What a probe has seen of its CLI: both pipes closed, and the exit.
#[derive(Debug, Default)]
struct Seen {
    output: Option<(String, String)>,
    exit: Option<io::Result<Exit>>,
}

impl Seen {
    /// Drives the output and the exit until both are in, or the exit wait fails or finds the
    /// CLI lost. Cancel-safe: a finished future is never polled again.
    async fn settle(
        &mut self,
        mut output: Pin<&mut impl Future<Output = (String, String)>>,
        mut exit: Pin<&mut impl Future<Output = io::Result<Exit>>>,
    ) {
        loop {
            match (&self.output, &self.exit) {
                (_, Some(Ok(Exit::Lost) | Err(_))) | (Some(_), Some(_)) => return,
                _ => {}
            }
            tokio::select! {
                out = output.as_mut(), if self.output.is_none() => self.output = Some(out),
                exit = exit.as_mut(), if self.exit.is_none() => self.exit = Some(exit),
            }
        }
    }

    /// The CLI has exited and every pipe holder has closed its end.
    #[cfg(unix)]
    fn ended(&self) -> bool {
        self.output.is_some() && matches!(self.exit, Some(Ok(Exit::Exited)))
    }

    /// Whether the CLI is still our unreaped child, from a fresh look just before a signal. A
    /// loss is kept, so every later signal is skipped too.
    #[cfg(unix)]
    fn ours(&mut self, pid: u32) -> bool {
        if matches!(self.exit, Some(Ok(Exit::Lost))) {
            return false;
        }
        match crate::process::exit_unreaped(pid) {
            Ok(Some(Exit::Lost)) => {
                self.exit = Some(Ok(Exit::Lost));
                false
            }
            Ok(_) => true,
            Err(_) => false,
        }
    }

    /// Signals the CLI's group while the CLI is ours; whether it did.
    #[cfg(unix)]
    fn signal_group(&mut self, pid: u32, signal: rustix::process::Signal) -> bool {
        let ours = self.ours(pid);
        if ours {
            crate::process::signal_group(pid, signal);
        }
        ours
    }
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

    /// Both pipes reach EOF while the CLI still runs, so the output finishes before the
    /// timeout and the exit never does.
    #[tokio::test]
    async fn a_cli_that_closes_its_pipes_and_hangs_times_out() {
        let out = spawn_and_collect(
            "sh",
            &["-c", "exec >&- 2>&-; sleep 30"],
            &path_env(),
            None,
            Duration::from_millis(200),
        )
        .await
        .unwrap();
        assert_eq!(out, None);
    }

    /// Another waiter reaps the CLI while a helper in its group still holds stdout. The probe
    /// reports it at once, before the pipes close, and signals nothing: the pid and group id
    /// are no longer the CLI's.
    #[tokio::test]
    async fn a_cli_reaped_by_another_waiter_gets_no_signals() {
        use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, kill_process_group, waitid};
        let dir = std::env::temp_dir().join(format!("conn-probe-lost-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (cli_pid, go, signalled) = (dir.join("cli"), dir.join("go"), dir.join("signalled"));
        let script = format!(
            "( trap \"echo > '{signalled}'; exit 0\" TERM; i=0; \
               while [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done ) & \
             echo $$ > '{cli}.tmp'; mv '{cli}.tmp' '{cli}'; \
             while [ ! -e '{go}' ]; do sleep 0.01; done; exit 0",
            signalled = signalled.display(),
            cli = cli_pid.display(),
            go = go.display(),
        );
        let (args, env) = (["-c", script.as_str()], path_env());
        let started = std::time::Instant::now();
        let probe = spawn_and_collect("sh", &args, &env, None, Duration::from_secs(2));
        let reap_elsewhere = async {
            let pid = loop {
                if let Ok(text) = std::fs::read_to_string(&cli_pid) {
                    break text.trim().parse::<i32>().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            std::fs::write(&go, "").unwrap();
            // Blocks the runtime, so the probe cannot look between the CLI's exit and this reap.
            waitid(
                WaitId::Pid(Pid::from_raw(pid).unwrap()),
                WaitIdOptions::EXITED,
            )
            .unwrap();
            pid
        };
        let (out, pid) = tokio::join!(probe, reap_elsewhere);
        let elapsed = started.elapsed();
        let was_signalled = signalled.exists();
        // The helper still runs; end its group, which the test owns now.
        let _ = kill_process_group(Pid::from_raw(pid).unwrap(), Signal::KILL);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            matches!(out, Err(CommandError::Failed(_))),
            "a lost CLI is an error: {out:?}"
        );
        assert!(!was_signalled, "the lost CLI's group was signalled");
        assert!(
            elapsed < Duration::from_secs(1),
            "the loss waited for the pipes: {elapsed:?}"
        );
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
