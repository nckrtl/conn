//! A disposable Conn Server for the desktop tab relay's end-to-end test
//! (`crates/conn-client/tests/desktop_relay.rs`): the scripted fake provider, one thread, the
//! server's preview broker, and that thread's agent credential for `/mcp`. State lives only in
//! the given temp directory.
//!
//! `cargo run -p conn-server --example desktop_relay_e2e -- <state-dir> <project-dir>`
//!
//! Prints one JSON line: the server's `url`, a one-time `pairingCode` for a client, the
//! environment id, the thread id, and the agent's `/mcp` url and `Authorization` header.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_engine::{Engine, EngineConfig, ProjectConfig, SqliteEngine, fake::FakeProvider};
use conn_mcp::ThreadCredentialRequest;
use conn_server::{
    AppState, auth::AuthStore, environment::Environment, method_table, methods::Deps, router,
    routes::mcp,
};
use serde_json::json;

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [state_dir, project] = args.as_slice() else {
        eprintln!("usage: desktop_relay_e2e <state-dir> <project-dir>");
        std::process::exit(2);
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run(state_dir, project));
}

async fn run(state_dir: &Path, project: &Path) {
    std::fs::create_dir_all(state_dir).expect("state directory");
    let root = project.to_string_lossy().into_owned();
    let environment = Arc::new(
        Environment::load(
            state_dir,
            Some("desktop-relay-e2e".into()),
            project.to_path_buf(),
            Default::default(),
        )
        .expect("environment"),
    );
    let mut config = EngineConfig::new(state_dir.join("engine.sqlite"));
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: root.clone(),
    }];
    let provider: Arc<dyn conn_provider::Provider> = Arc::new(FakeProvider::new("claudeAgent"));
    config.providers = vec![provider.clone()];
    let engine: Arc<dyn Engine> = Arc::new(SqliteEngine::open(config).expect("engine"));
    let mut deps = Deps {
        engine: Some(engine.clone()),
        providers: vec![provider].into(),
        environment: Some(environment.clone()),
        preview: Some(conn_preview::tabs::Preview::new(state_dir.join("browser"))),
        panels: Some(conn_features::panels::PanelBroker::default()),
        ..Deps::default()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("local address");
    deps.mcp = mcp::service(&deps, address);
    let service = deps.mcp.clone().expect("mcp service");

    let thread_id = "thread:desktop-relay-e2e";
    engine
        .launch_thread(json!({
            "commandId": "desktop-relay-e2e:launch",
            "threadId": thread_id,
            "projectId": SqliteEngine::project_id_for(&root),
            "title": "Agent thread",
            "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"},
            "runtimeMode": "full-access",
            "interactionMode": "default",
            "workspaceStrategy": {"type": "root"},
            // The fake provider keeps this run going, so the agent's writing tools are allowed.
            "initialMessage": {"messageId": "desktop-relay-e2e:message", "text": "hang", "attachments": []},
        }))
        .await
        .expect("launch the agent thread");
    let entry = service.issue_thread_credential(ThreadCredentialRequest {
        thread_id: thread_id.into(),
        provider_instance_id: "claudeAgent".into(),
        subagent: false,
        preview: true,
        device: false,
    });

    let auth = AuthStore::in_memory();
    let pairing = auth
        .issue_pairing_code(Some("desktop-relay-e2e".into()), 10 * 60 * 1000)
        .expect("pairing code");
    let server = entry.claude_server();
    println!(
        "{}",
        json!({
            "url": format!("http://{address}"),
            "pairingCode": pairing.code,
            "environmentId": environment.environment_id(),
            "threadId": thread_id,
            "mcpUrl": server["url"],
            "mcpAuthorization": server["headers"]["Authorization"],
        })
    );

    let state = AppState {
        table: Arc::new(method_table(&deps)),
        auth,
        descriptor: environment.subscribe_descriptor(),
        engine: Some(engine),
        deps,
    };
    axum::serve(listener, router(state)).await.expect("serve");
}
