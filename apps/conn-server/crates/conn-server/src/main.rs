use std::sync::Arc;

use conn_provider::Provider;
#[cfg(feature = "claude")]
use conn_provider_claude::{ClaudeConfig, ClaudeProvider, HelperCommand};
use conn_server::serve::{ServeOptions, serve_with_instances};

fn main() {
    // T3's binMain dispatches the bridge before loading the server CLI.
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("acp-mcp-bridge")) {
        std::process::exit(conn_server::acp_mcp_bridge::main());
    }
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("acp-mcp-call")) {
        let args = std::env::args_os()
            .skip(2)
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        std::process::exit(conn_server::cli::acp_mcp_call(&args));
    }
    // Antigravity's `BROWSER`: reports a sign-in URL instead of opening a browser.
    #[cfg(feature = "acp")]
    if std::env::args_os().nth(1).as_deref()
        == Some(std::ffi::OsStr::new(conn_provider_acp::BROWSER_SUBCOMMAND))
    {
        let args: Vec<String> = std::env::args_os()
            .skip(2)
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        std::process::exit(conn_provider_acp::browser_main(&args));
    }
    run_server();
}

/// The most blocking-pool threads at once. One turn on the fake provider uses six.
const BLOCKING_THREADS: usize = 16;

fn run_server() {
    // One thread: a container serves a handful of clients, and each worker thread costs
    // stack and allocator arenas. The blocking pool gets a cap for the same reason: tokio's
    // default lets a burst start 512 threads. Jobs past the cap wait in the pool's queue.
    let runtime = conn_server::serve::or_exit(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(BLOCKING_THREADS)
            .build(),
        "cannot start the runtime",
    );
    // Runs and exits for every command but `serve`. For `serve`: SIGHUP asks for a reload
    // (`reload.rs`), and its default action stops the process. A handler stays for the life
    // of the process, so registering it before the bootstrap read covers all of startup.
    let options = ServeOptions::from_args_with(|| {
        let _runtime = runtime.enter();
        let _handler =
            conn_server::serve::or_exit(conn_server::reload::hangup(), "cannot handle SIGHUP");
    });
    // `fixPath`: the login shell's PATH for every child and every program lookup, read before
    // the providers are detected (Codex looks for its binary on that PATH). Blocking is fine:
    // the runtime runs nothing yet.
    conn_support::login_env::hydrate();
    #[cfg(feature = "claude")]
    let mut claude = ClaudeConfig {
        // `conn-files` stores attachments here; the CLI may read them.
        attachments_dir: Some(options.state_dir.join("attachments")),
        // T3 runs its Claude status probe in its state folder.
        status_cwd: Some(options.state_dir.clone()),
        // Checks turn the probe off, so they never run this machine's `claude`.
        status_probe: std::env::var_os("CONN_CLAUDE_STATUS_PROBE").is_none_or(|v| v != "off"),
        model_manifest: options.model_manifest.clone(),
        // The engine closes idle sessions (`--session-idle-timeout`), one rule for all.
        idle_timeout: None,
        // T3's text after the runtime instructions when the session has `conn`.
        mcp_instructions: Some(format!(
            "{}{}",
            conn_mcp::AGENT_INSTRUCTIONS,
            conn_mcp::CLAUDE_INSTRUCTIONS
        )),
        device_instructions: Some(conn_mcp::DEVICE_INSTRUCTIONS.to_owned()),
        ..ClaudeConfig::default()
    };
    #[cfg(feature = "claude")]
    if let Some(helper) = &options.sdk_host {
        claude.helper = HelperCommand::from_path(helper);
    }
    #[cfg(feature = "codex")]
    let codex = conn_provider_codex::CodexConfig {
        // The same store Claude reads; Codex gets a path line per attachment and the images.
        attachments_dir: Some(options.state_dir.join("attachments")),
        // Checks turn the probe off, so they never run this machine's `codex`.
        status_probe: std::env::var_os("CONN_CODEX_STATUS_PROBE").is_none_or(|v| v != "off"),
        // T3 probes Codex in the server's working folder (`process.cwd()`).
        status_cwd: std::env::current_dir().ok(),
        model_manifest: options.model_manifest.clone(),
        ..Default::default()
    };
    // One SDK host process for every Claude instance (it runs only while a query is open).
    #[cfg(feature = "claude")]
    let claude_host = conn_provider_claude::helper::claude_host(
        claude.helper.clone(),
        conn_provider_claude::DRIVER,
    );
    #[cfg(feature = "acp")]
    let antigravity = conn_provider_acp::AntigravityConfig {
        state_dir: options.state_dir.clone(),
        attachments_dir: Some(options.state_dir.join("attachments")),
        self_command: None,
        model_manifest: options.model_manifest.clone(),
        status_notifier: options.status_notifier.clone(),
    };
    #[cfg(feature = "acp")]
    let grok = conn_provider_acp::AcpConfig {
        workspace_cwd: Some(options.cwd.clone()),
        attachments_dir: Some(options.state_dir.join("attachments")),
        ..Default::default()
    };
    let instances = Arc::new(conn_server::instances::Instances::new(
        &[
            #[cfg(feature = "claude")]
            conn_provider_claude::DRIVER,
            #[cfg(feature = "codex")]
            conn_provider_codex::DRIVER,
            #[cfg(feature = "acp")]
            conn_provider_acp::ANTIGRAVITY.driver,
            #[cfg(feature = "acp")]
            conn_provider_acp::GROK.driver,
        ],
        // Called only for a driver of the list above.
        Arc::new(
            move |id: &str, driver: &str, entry: Option<&serde_json::Value>| {
                #[cfg(feature = "acp")]
                if driver == conn_provider_acp::ANTIGRAVITY.driver {
                    let provider = conn_provider_acp::AntigravityProvider::for_instance(
                        id.into(),
                        antigravity.clone(),
                        entry,
                    );
                    return Some(Arc::new(provider) as Arc<dyn Provider>);
                }
                #[cfg(feature = "acp")]
                if driver == conn_provider_acp::GROK.driver {
                    let provider = conn_provider_acp::AcpProvider::with_settings(
                        id.into(),
                        &conn_provider_acp::GROK,
                        grok.clone(),
                        conn_provider_acp::GrokSettings::from_instance(entry),
                    );
                    return Some(Arc::new(provider) as Arc<dyn Provider>);
                }
                #[cfg(feature = "claude")]
                if driver == conn_provider_claude::DRIVER {
                    let provider = ClaudeProvider::for_instance(
                        id.into(),
                        claude.clone(),
                        entry,
                        &claude_host,
                    );
                    return Some(Arc::new(provider) as Arc<dyn Provider>);
                }
                #[cfg(feature = "codex")]
                let provider: Option<Arc<dyn Provider>> =
                    Some(Arc::new(conn_provider_codex::CodexProvider::for_instance(
                        id.into(),
                        codex.clone(),
                        entry,
                    )));
                #[cfg(not(feature = "codex"))]
                let provider: Option<Arc<dyn Provider>> = None;
                provider
            },
        ),
    ));
    runtime.block_on(serve_with_instances(options, vec![], Some(instances)));
    // Dropping the tasks drops provider children, which kills them (`kill_on_drop`).
    runtime.shutdown_timeout(std::time::Duration::from_secs(2));
}
