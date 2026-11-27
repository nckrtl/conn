//! Vault requests and the child reaper with every SIGCHLD lost.
//!
//! In the app, Chromium resets SIGCHLD to its default handling while CEF starts. Tokio then never
//! learns that a child exited, so `Child::wait()` and `Child::kill()` hang. This test runs with
//! `harness = false`: `main` blocks SIGCHLD before any thread starts, so every thread inherits the
//! block and no SIGCHLD is ever delivered. Each case checks that the reply still arrives at once
//! and that the relay is still collected (no zombie left behind).

#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    unix::run()
}

#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
mod unix {
    use std::error::Error;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use conn_desktop::child_reaper;
    use conn_desktop::vault::VaultClient;
    use nix::sys::signal::{SigSet, SigmaskHow, Signal, sigprocmask};
    use tokio::process::Command;

    type Result<T = ()> = std::result::Result<T, Box<dyn Error>>;

    /// Writes its PID, answers the request, then keeps running until it is killed.
    const REPLIES: &str = r#"
import json, os, struct, sys, time
open(os.path.join(os.path.dirname(sys.argv[0]), "pid"), "w").write(str(os.getpid()))
size = struct.unpack("<I", sys.stdin.buffer.read(4))[0]
req = json.loads(sys.stdin.buffer.read(size))
body = json.dumps({"id": req["id"], "status": "databases", "databases": [
    {"id": "item-1", "name": "Production", "driver": "postgresql", "host": "127.0.0.1",
     "port": 5432, "database": "app", "username": "readonly", "tls": "disabled"}]}).encode()
sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
sys.stdout.buffer.flush()
time.sleep(60)
"#;

    /// Writes its PID and never answers.
    const SILENT: &str = r#"
import os, sys, time
open(os.path.join(os.path.dirname(sys.argv[0]), "pid"), "w").write(str(os.getpid()))
time.sleep(60)
"#;

    pub(super) fn run() -> Result {
        let mut block = SigSet::empty();
        block.add(Signal::SIGCHLD);
        sigprocmask(SigmaskHow::SIG_BLOCK, Some(&block), None)?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        runtime.block_on(async {
            premise_tokio_wait_hangs().await?;
            reply_arrives_at_once_and_relay_is_collected().await?;
            deadline_ends_a_silent_relay_and_collects_it().await?;
            cancelled_request_collects_its_relay().await?;
            wait_polled_reads_the_exit_status().await?;
            println!("missed_sigchld: all cases passed");
            Ok(())
        })
    }

    /// Without SIGCHLD, Tokio's own wait never sees the exit. If this fails, the test does not
    /// simulate the bug and proves nothing.
    async fn premise_tokio_wait_hangs() -> Result {
        let mut child = Command::new("/bin/sleep").arg("0.2").spawn()?;
        let started = Instant::now();
        // When the timer fires, `timeout` polls `wait()` once more, which then finds the exit:
        // the app's "success at exactly the deadline". So check the time, not the result.
        let _ = tokio::time::timeout(Duration::from_millis(1500), child.wait()).await;
        let took = started.elapsed();
        assert!(
            took >= Duration::from_millis(1400),
            "SIGCHLD is blocked, so tokio's wait() must not see the exit at 0.2 s (took {took:?})"
        );
        child_reaper::retire(child);
        Ok(())
    }

    async fn reply_arrives_at_once_and_relay_is_collected() -> Result {
        let (dir, bin) = fake_vault(REPLIES)?;
        let client = VaultClient::with_binary(&bin).with_timeout(Duration::from_secs(20));
        let started = Instant::now();
        let list = client.list_databases(false).await?;
        let took = started.elapsed();
        assert_eq!(list.len(), 1, "the reply carries one database");
        assert!(
            took < Duration::from_secs(3),
            "the reply must arrive without waiting for the relay to exit, took {took:?}"
        );
        assert_collected(&dir).await
    }

    async fn deadline_ends_a_silent_relay_and_collects_it() -> Result {
        let (dir, bin) = fake_vault(SILENT)?;
        let client = VaultClient::with_binary(&bin).with_timeout(Duration::from_millis(500));
        let started = Instant::now();
        let err = client
            .list_databases(false)
            .await
            .err()
            .ok_or("a relay that never answers must fail")?;
        let took = started.elapsed();
        assert!(
            err.message.contains("in time"),
            "unexpected error: {}",
            err.message
        );
        assert!(
            took < Duration::from_secs(3),
            "the deadline must end the request, took {took:?}"
        );
        assert_collected(&dir).await
    }

    async fn cancelled_request_collects_its_relay() -> Result {
        let (dir, bin) = fake_vault(SILENT)?;
        let client = VaultClient::with_binary(&bin).with_timeout(Duration::from_secs(20));
        // Dropping the future mid-request, as a closed page or a newer lookup does.
        let cancelled =
            tokio::time::timeout(Duration::from_millis(800), client.list_databases(true)).await;
        assert!(cancelled.is_err(), "the request is dropped mid-flight");
        assert_collected(&dir).await
    }

    async fn wait_polled_reads_the_exit_status() -> Result {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 3"])
            .stdin(Stdio::null())
            .spawn()?;
        let status = tokio::time::timeout(
            Duration::from_secs(3),
            child_reaper::wait_polled(&mut child),
        )
        .await??;
        assert_eq!(status.code(), Some(3), "wait_polled returns the exit code");
        Ok(())
    }

    fn fake_vault(script: &str) -> Result<(tempfile::TempDir, PathBuf)> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("fake-vault");
        std::fs::write(&path, format!("#!/usr/bin/env python3\n{script}"))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        Ok((dir, path))
    }

    /// The PID the fake relay wrote, once it has started.
    async fn pid_of(dir: &tempfile::TempDir) -> Result<u32> {
        let file = dir.path().join("pid");
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(&file)
                && let Ok(pid) = text.trim().parse()
            {
                return Ok(pid);
            }
            if Instant::now() > until {
                return Err("the fake relay never wrote its PID".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Waits until the relay's PID is gone from the process table: killed and collected, not a
    /// zombie.
    async fn assert_collected(dir: &tempfile::TempDir) -> Result {
        let pid = pid_of(dir).await?;
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let state = process_state(pid)?;
            if state.is_empty() {
                return Ok(());
            }
            if Instant::now() > until {
                return Err(format!("relay {pid} was not collected (state {state})").into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// `ps` state of `pid` (`Z` for a zombie), or empty once the process is gone. `std`'s
    /// `output()` collects `ps` with a blocking `waitpid`, so it does not need SIGCHLD.
    fn process_state(pid: u32) -> Result<String> {
        let out = std::process::Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }
}
