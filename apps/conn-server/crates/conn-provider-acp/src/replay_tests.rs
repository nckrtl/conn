//! The T3 test kit's ACP transcripts through our whole session, against an in-memory agent
//! that applies T3's replay rules (`replay_agent`), and the events compared with what T3's
//! adapter emitted for the same transcript.
//!
//! `testdata/<flavor>/<fixture>.json` comes from `tools/capture-ts-events.mjs`: the
//! transcript as T3's harness handed it to its replay agent, every adapter call the
//! orchestrator made, and every event. The test replays those calls in order: each waits until
//! the agent and the session are idle, as the orchestrator waits for the events that cause
//! it. Streamed text is held until its segment closes (`flush_interval: None`), as T3's paused
//! test clock holds it.
//!
//! Normalized before comparing (both sides): timestamps become `<now>` (T3's test clock and
//! ours differ); the random uuid in runtime request and plan ids becomes `<uuid>`.
//!
//! `testdata/<flavor>/expected-failures.txt` lists the fixtures that cannot pass yet, with the
//! reason. The test fails when a listed fixture passes or an unlisted one fails.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_contract::from_json;
use conn_provider::{
    EnsureThreadInput, InterruptInput, ProviderEvent, RuntimeRequestResponse, Session,
};
use conn_provider_support::ids::FixedEnv;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

use crate::flavor::Flavor;
use crate::replay_agent::{self, Script};
use crate::session::{self, AcpSession, Config};

fn read_golden(flavor: &str, name: &str) -> Value {
    let path = format!(
        "{}/testdata/{flavor}/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
        .unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn fixtures(flavor: &str) -> Vec<String> {
    let dir = format!("{}/testdata/{flavor}", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter_map(|n| n.strip_suffix(".json").map(str::to_owned))
        .collect();
    names.sort();
    names
}

fn expected_failures(flavor: &str) -> BTreeMap<String, String> {
    let path = format!(
        "{}/testdata/{flavor}/expected-failures.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| match l.split_once(' ') {
            Some((name, reason)) => (name.to_owned(), reason.trim().to_owned()),
            None => (l.to_owned(), String::new()),
        })
        .collect()
}

pub(crate) struct Run {
    pub events: Vec<Value>,
    pub script: Arc<Mutex<Script>>,
    pub errors: Vec<String>,
    pub snapshots: Vec<conn_provider::ThreadSnapshot>,
}

/// T3's `release_replay_gate` after `finish_held_run`: a gate opens once its run ended.
fn release_gates(
    gates: &[(String, u64)],
    script: &Arc<Mutex<Script>>,
    events: &Arc<Mutex<Vec<Value>>>,
) {
    for (label, after_run) in gates {
        let ended = crate::lock(events).iter().any(|e| {
            e["type"] == "turn.terminal"
                && e["runOrdinal"].as_u64().is_some_and(|r| r >= *after_run)
        });
        if ended {
            crate::lock(script).release(label);
        }
    }
}

/// Waits until neither the agent's cursor nor the event count moves for a while.
async fn idle(
    gates: &[(String, u64)],
    script: &Arc<Mutex<Script>>,
    events: &Arc<Mutex<Vec<Value>>>,
) {
    let mut last = (usize::MAX, usize::MAX);
    let mut still = 0;
    for _ in 0..2_000 {
        tokio::time::sleep(Duration::from_millis(2)).await;
        release_gates(gates, script, events);
        let now = (crate::lock(script).cursor, crate::lock(events).len());
        if now == last {
            still += 1;
            if still >= 5 {
                return;
            }
        } else {
            still = 0;
            last = now;
        }
    }
}

async fn wait_event(
    events: &Arc<Mutex<Vec<Value>>>,
    changed: &Notify,
    matches: impl Fn(&[Value]) -> bool,
) {
    loop {
        let notified = changed.notified();
        if matches(&crate::lock(events)) {
            return;
        }
        notified.await;
    }
}

pub(crate) async fn replay(flavor: &'static Flavor, golden: &Value) -> Run {
    let calls = golden["calls"].as_array().cloned().unwrap_or_default();
    let open = calls
        .iter()
        .find(|c| c["method"] == "openSession")
        .cloned()
        .unwrap_or(Value::Null);
    let policy = &open["input"]["runtimePolicy"];
    let workspace = policy["cwd"].as_str().unwrap_or("/workspace").to_owned();
    let entries = golden["transcripts"][0]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let script = Script::new(entries, &workspace);
    // `gates`: the labels the fixture holds, each until a run ended.
    let gates: Vec<(String, u64)> = golden["gates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| Some((g["label"].as_str()?.to_owned(), g["afterRun"].as_u64()?)))
        .collect();
    crate::lock(&script).gates = gates.iter().map(|(label, _)| label.clone()).collect();
    let spawn_script = script.clone();
    let spawner: session::Spawner = Arc::new(move || {
        let (writer, events) = replay_agent::spawn(spawn_script.clone());
        Ok(session::Spawned {
            writer,
            events,
            stop: Box::new(|_| Box::pin(async {})),
        })
    });
    let config = Config {
        flush_interval: None,
        finalize_debounce: Duration::from_millis(5),
        flavor,
        instance_id: open["input"]["modelSelection"]["instanceId"]
            .as_str()
            .unwrap_or(flavor.driver)
            .to_owned(),
        provider_session_id: open["input"]["providerSessionId"]
            .as_str()
            .unwrap_or("s")
            .to_owned(),
        cwd: workspace.clone(),
        policy: policy.clone(),
        runtime_mode: policy["runtimeMode"]
            .as_str()
            .unwrap_or("full-access")
            .to_owned(),
        effort: crate::grok::selection_effort(&open["input"]["modelSelection"]),
        model: open["input"]["modelSelection"]["model"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        mcp_servers: Vec::new(),
        client_version: "0.0.0".into(),
        self_command: "/conn-server".into(),
        attachments_dir: golden["attachmentsDir"]
            .as_str()
            .map(std::path::PathBuf::from),
        auth_method: None,
        runtime_version: None,
        profile: None,
        skill_cli: None,
        default_model: None,
        observer: None,
    };
    let (tx, mut rx) = mpsc::channel::<ProviderEvent>(session::EVENT_CAPACITY);
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let changed = Arc::new(Notify::new());
    let signal = changed.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            crate::lock(&sink).push(serde_json::to_value(&event).unwrap());
            signal.notify_one();
        }
    });
    let mut errors = Vec::new();
    let mut snapshots = Vec::new();
    let session = match AcpSession::open(config, spawner, Box::new(FixedEnv::default()), tx).await {
        Ok((session, _)) => session,
        Err(error) => {
            errors.push(format!("open: {error}"));
            return Run {
                events: Vec::new(),
                snapshots,
                script,
                errors,
            };
        }
    };
    let mut pending_seen = 0usize;
    let mut continuations_expected = 0usize;
    for call in &calls {
        if !matches!(
            call["method"].as_str(),
            Some("startTurn" | "respondToRuntimeRequest" | "close")
        ) {
            idle(&gates, &script, &events).await;
        }
        let input = &call["input"];
        match call["method"].as_str().unwrap_or("") {
            "ensureThread" => {
                let result = session
                    .ensure_thread(EnsureThreadInput {
                        thread_id: from_json(input["threadId"].clone()).unwrap(),
                        title: input["title"].as_str().map(str::to_owned),
                        model_selection: from_json(input["modelSelection"].clone()).unwrap(),
                        runtime_policy: from_json(input["runtimePolicy"].clone()).unwrap(),
                        existing_provider_thread: None,
                    })
                    .await;
                if let Err(e) = result {
                    errors.push(format!("ensureThread: {e}"));
                }
            }
            "readThreadSnapshot" => {
                if let Some(supported) = input["expectedCapability"].as_bool() {
                    let caps = session.negotiated_capabilities(json!({})).await;
                    assert_eq!(caps["threads"]["canReadThreadSnapshot"], supported);
                    assert_eq!(
                        caps["checkpointing"]["providerCanReadConversationSnapshot"],
                        supported
                    );
                }
                match session
                    .read_thread_snapshot(from_json(input["providerThread"].clone()).unwrap())
                    .await
                {
                    Ok(snapshot) => snapshots.push(snapshot),
                    Err(error) => errors.push(format!("readThreadSnapshot: {error}")),
                }
            }
            "resumeThread" => {
                match session
                    .resume_thread(conn_provider::ResumeThreadInput {
                        provider_thread: from_json(input["providerThread"].clone()).unwrap(),
                        thread_id: None,
                        model_selection: None,
                        runtime_policy: None,
                    })
                    .await
                {
                    Ok(thread) => assert_eq!(
                        conn_contract::to_json(&thread)["nativeThreadRef"],
                        input["providerThread"]["nativeThreadRef"]
                    ),
                    Err(e) => errors.push(format!("resumeThread: {e}")),
                }
            }
            "stopSettledWork" => {
                assert!(
                    !session.has_turn().await,
                    "only the native background command is running"
                );
                assert!(session.has_pending_background_work());
                let turn = crate::testing::turn_input(input);
                let id = crate::lock(&events)
                    .iter()
                    .find_map(|e| e["providerTurn"]["id"].as_str().map(str::to_owned))
                    .unwrap();
                session
                    .stop_background_work(InterruptInput {
                        provider_thread: turn.provider_thread,
                        provider_turn_id: id.as_str().into(),
                    })
                    .await
                    .unwrap();
                assert!(!session.has_pending_background_work());
            }
            "checkActive" => assert!(
                session.has_turn().await,
                "foreground command must hold the turn"
            ),
            "advanceTime" => {
                tokio::time::advance(Duration::from_secs(input["seconds"].as_u64().unwrap())).await;
                tokio::task::yield_now().await;
            }
            "forkThread" => {
                let request = conn_provider::ForkThreadInput {
                    source_provider_thread: from_json(input["sourceProviderThread"].clone())
                        .unwrap(),
                    source_provider_turns: vec![],
                    provider_turn_id: None,
                    target_thread_id: input["targetThreadId"].as_str().unwrap().into(),
                    owner_node_id: None,
                    model_selection: None,
                    runtime_policy: None,
                };
                match session.fork_thread(request).await {
                    Ok(thread) => {
                        let thread = conn_contract::to_json(&thread);
                        assert_eq!(thread["nativeThreadRef"]["nativeId"], "forked");
                        assert_eq!(
                            thread["forkedFrom"]["providerThreadId"],
                            input["sourceProviderThread"]["id"]
                        );
                    }
                    Err(e) => errors.push(format!("fork: {e}")),
                }
            }
            "steerTurn" => {
                let turn = crate::testing::turn_input(input);
                let id = crate::lock(&events)
                    .iter()
                    .find_map(|e| e["providerTurn"]["id"].as_str().map(str::to_owned));
                if let Some(id) = id {
                    let steer = conn_provider::SteerInput {
                        provider_turn_id: id.as_str().into(),
                        thread_id: turn.thread_id,
                        run_id: turn.run_id,
                        provider_thread: turn.provider_thread,
                        message: turn.message,
                        model_selection: Some(turn.model_selection),
                        app_context: turn.app_context,
                    };
                    if let Err(e) = session.steer_turn(steer).await {
                        errors.push(format!("steerTurn: {e}"));
                    }
                } else {
                    errors.push("no running turn to steer".into())
                }
            }
            "startTurn" => {
                if session.has_turn().await {
                    wait_event(&events, &changed, |events| {
                        events.iter().any(|e| {
                            e["type"] == "turn.terminal"
                                && e["runOrdinal"].as_u64()
                                    == input["runOrdinal"].as_u64().map(|n| n - 1)
                        })
                    })
                    .await;
                }
                if input["message"]["createdBy"] == "agent"
                    && input["message"]["creationSource"] == "provider"
                {
                    continuations_expected += 1;
                }
                if let Err(e) = session.start_turn(crate::testing::turn_input(input)).await {
                    errors.push(format!("startTurn: {e}"));
                }
            }
            // T3's orchestrator sends `/compact` through `compactThread`, which starts the turn
            // with the text `/compact`; ours sends the message through `start_turn`.
            "compactThread" => {
                let mut input = input.clone();
                input["message"]["text"] = json!("/compact");
                if let Err(e) = session.start_turn(crate::testing::turn_input(&input)).await {
                    errors.push(format!("compactThread: {e}"));
                }
            }
            "respondToRuntimeRequest" => {
                wait_event(&events, &changed, |events| {
                    events
                        .iter()
                        .filter(|e| {
                            e["type"] == "runtime_request.updated"
                                && e["runtimeRequest"]["status"] == "pending"
                        })
                        .count()
                        > pending_seen
                })
                .await;
                // Our request ids carry our own uuid: answer the requests in the order they came.
                let ids: Vec<String> = crate::lock(&events)
                    .iter()
                    .filter(|e| {
                        e["type"] == "runtime_request.updated"
                            && e["runtimeRequest"]["status"] == "pending"
                    })
                    .filter_map(|e| e["runtimeRequest"]["id"].as_str().map(str::to_owned))
                    .collect();
                let Some(id) = ids.get(pending_seen).cloned() else {
                    errors.push("respondToRuntimeRequest: no pending request".into());
                    continue;
                };
                pending_seen += 1;
                let result = session
                    .respond_to_runtime_request(RuntimeRequestResponse {
                        request_id: id.as_str().into(),
                        decision: from_json(input["decision"].clone()).ok(),
                        feedback: None,
                        answers: from_json(input["answers"].clone()).ok(),
                    })
                    .await;
                if let Err(e) = result {
                    errors.push(format!("respond: {e}"));
                }
            }
            "interruptTurn" => {
                let result = session
                    .interrupt_turn(InterruptInput {
                        provider_thread: from_json(input["providerThread"].clone()).unwrap(),
                        provider_turn_id: from_json(input["providerTurnId"].clone()).unwrap(),
                    })
                    .await;
                if let Err(e) = result {
                    errors.push(format!("interrupt: {e}"));
                }
            }
            // The engine's `abandon_turn_start` (a Stop before the agent took the turn).
            "abandonTurnStart" => {
                session
                    .abandon_turn_start(conn_provider::AbandonTurnStartInput {
                        thread_id: from_json(input["threadId"].clone()).unwrap(),
                        run_id: from_json(input["runId"].clone()).unwrap(),
                    })
                    .await;
            }
            "close" => {
                if session.has_turn().await {
                    let ordinal = calls.iter().filter(|c| c["method"] == "startTurn").count();
                    wait_event(&events, &changed, |events| {
                        events
                            .iter()
                            .filter(|e| e["type"] == "turn.terminal")
                            .count()
                            == ordinal
                    })
                    .await;
                }
                session.close().await;
            }
            "openSession" | "getModelContextWindow" => {}
            other => errors.push(format!("call {other} is not replayed")),
        }
    }
    idle(&gates, &script, &events).await;
    // The fixture's scope closes the adapter session at the end (T3 records no call for it).
    if !calls.iter().any(|c| c["method"] == "close") {
        session.close().await;
        idle(&gates, &script, &events).await;
    }
    // Nothing of a finished turn stays behind.
    if session.has_turn().await
        || session.pending_requests().await != 0
        || !session.background_state_empty().await
    {
        errors.push("state left after the last turn".into());
    }
    let events = crate::lock(&events).clone();
    // T3 offers a continuation through its own service, not the event stream: each
    // provider continuation turn of the recording must follow one request of ours.
    let requested = events
        .iter()
        .filter(|e| e["type"] == "continuation.requested")
        .count();
    if requested != continuations_expected {
        errors.push(format!(
            "{requested} continuation requests, {continuations_expected} continuation turns"
        ));
    }
    Run {
        events,
        snapshots,
        script,
        errors,
    }
}

/// Both sides through the contract types, then the documented normalizations.
pub(crate) fn normalize(event: &Value) -> Value {
    let mut value = match serde_json::from_value::<ProviderEvent>(event.clone()) {
        Ok(typed) => serde_json::to_value(typed).unwrap(),
        Err(e) => json!({"undecodable": e.to_string(), "event": event}),
    };
    scrub(&mut value);
    value
}

fn scrub(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if let Value::String(s) = v {
                    if key.ends_with("At") && s.starts_with("1970-") {
                        *s = "<now>".into();
                    } else if (s.starts_with("runtime-request:") || s.starts_with("plan:"))
                        && s.len() > 37
                    {
                        s.replace_range(s.len() - 36.., "<uuid>");
                    } else if (s.starts_with("node:runtime-request:")
                        || s.starts_with("turn-item:runtime-request:"))
                        && let Some(at) = s.rfind("%3A")
                    {
                        s.replace_range(at + 3.., "<uuid>");
                    }
                }
                scrub(v);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        _ => {}
    }
}

/// The first difference between two event lists, or `None`.
pub(crate) fn compare(ours: &[Value], theirs: &[Value]) -> Option<String> {
    let ours: Vec<Value> = ours
        .iter()
        .filter(|e| e["type"] != "continuation.requested")
        .map(normalize)
        .collect();
    let theirs: Vec<Value> = theirs.iter().map(normalize).collect();
    for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
        if a != b {
            return Some(format!("event {i} differs:\n  ours   {a}\n  theirs {b}"));
        }
    }
    if ours.len() != theirs.len() {
        let extra = if ours.len() > theirs.len() {
            format!(
                "ours has more: {}",
                ours.get(theirs.len()).unwrap_or(&Value::Null)
            )
        } else {
            format!(
                "theirs has more: {}",
                theirs.get(ours.len()).unwrap_or(&Value::Null)
            )
        };
        return Some(format!(
            "{} events here, {} from T3; {extra}",
            ours.len(),
            theirs.len()
        ));
    }
    None
}

/// Replays one fixture; `Err` holds why it does not pass.
pub(crate) async fn check_fixture(flavor: &'static Flavor, name: &str) -> Result<(), String> {
    let golden = read_golden(flavor.driver, name);
    let run = replay(flavor, &golden).await;
    let mut problems = run.errors.clone();
    {
        let script = crate::lock(&run.script);
        if let Some(failure) = &script.failure {
            problems.push(format!("frames: {failure}"));
        } else if !script.complete() {
            problems.push(format!(
                "frames: stopped at entry {} of {}: {}",
                script.cursor,
                script.entries.len(),
                script
                    .entries
                    .get(script.cursor)
                    .map(|e| e.to_string())
                    .unwrap_or_default()
            ));
        }
    }
    let theirs = golden["events"].as_array().cloned().unwrap_or_default();
    if let Ok(dir) = std::env::var("ACP_DUMP") {
        let ours: Vec<Value> = run.events.iter().map(normalize).collect();
        let theirs: Vec<Value> = theirs.iter().map(normalize).collect();
        let _ = std::fs::write(
            format!("{dir}/{name}.ours.json"),
            serde_json::to_string_pretty(&ours).unwrap(),
        );
        let _ = std::fs::write(
            format!("{dir}/{name}.theirs.json"),
            serde_json::to_string_pretty(&theirs).unwrap(),
        );
    }
    if let Some(difference) = compare(&run.events, &theirs) {
        problems.push(format!("events: {difference}"));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

async fn check_flavor(flavor: &'static Flavor) {
    let expected = expected_failures(flavor.driver);
    let mut report = Vec::new();
    let mut unexpected = Vec::new();
    for name in fixtures(flavor.driver) {
        let outcome = check_fixture(flavor, &name).await;
        let listed = expected.contains_key(&name);
        match (&outcome, listed) {
            (Ok(()), false) => report.push(format!("pass {name}")),
            (Err(_), true) => report.push(format!("expected failure {name}")),
            (Ok(()), true) => unexpected.push(format!(
                "{name} passes now: take it off expected-failures.txt"
            )),
            (Err(why), false) => unexpected.push(format!("{name} fails:\n{why}")),
        }
    }
    for name in expected.keys() {
        if !fixtures(flavor.driver).contains(name) {
            unexpected.push(format!("{name} is listed but has no golden file"));
        }
    }
    eprintln!("{}", report.join("\n"));
    assert!(unexpected.is_empty(), "{}", unexpected.join("\n\n"));
}

#[tokio::test(flavor = "current_thread")]
async fn grok_transcripts_replay_as_in_t3() {
    check_flavor(&crate::flavor::GROK).await;
}

/// One fixture with its full report: `ACP_FIXTURE=simple cargo test -p conn-provider-acp one_fixture -- --nocapture`.
#[tokio::test(flavor = "current_thread")]
async fn one_fixture() {
    let Ok(name) = std::env::var("ACP_FIXTURE") else {
        return;
    };
    let flavor = &crate::flavor::GROK;
    match check_fixture(flavor, &name).await {
        Ok(()) => eprintln!("{name}: pass"),
        Err(why) => panic!("{name}:\n{why}"),
    }
}

/// 200 turns, each with streamed text, a tool call and an approval, through one session: no
/// turn, request, pending reply or tool state is left behind.
#[tokio::test(flavor = "current_thread")]
async fn state_stays_bounded_over_many_turns() {
    let golden = read_golden("grok", "tool_call_read_only_on_request");
    let entries = golden["transcripts"][0].as_array().cloned().unwrap();
    // The handshake from the recording, then one scripted turn per round.
    let prompt_at = entries
        .iter()
        .position(|e| e["frame"]["method"] == "session/prompt")
        .unwrap();
    let mut script: Vec<Value> = entries[..prompt_at].to_vec();
    let session = "00000000-0000-4000-8000-000000000001";
    let rounds = 200;
    for round in 1..=rounds {
        let update = |u: Value| json!({"type": "emit_inbound", "frame": {"kind": "notification", "method": "session/update", "params": {"sessionId": session, "update": u}}});
        script.push(json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/prompt", "params": "<any>"}}));
        script.push(update(json!({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking"}})));
        script.push(update(json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("turn {round}")}})));
        script.push(update(json!({"sessionUpdate": "tool_call", "toolCallId": format!("t{round}"), "title": "Write", "kind": "edit", "rawInput": {"file_path": "/w/a"}})));
        script.push(json!({"type": "emit_inbound", "frame": {"kind": "request", "method": "session/request_permission", "params": {"sessionId": session, "toolCall": {"toolCallId": format!("t{round}"), "kind": "edit"}, "options": [{"optionId": "allow-once", "kind": "allow_once", "name": "Allow"}]}}}));
        script.push(json!({"type": "expect_outbound", "frame": {"kind": "response", "method": "session/request_permission", "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}}}));
        script.push(update(json!({"sessionUpdate": "tool_call_update", "toolCallId": format!("t{round}"), "status": "completed"})));
        script.push(json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/prompt", "result": {"stopReason": "end_turn"}}}));
    }
    script.push(json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/close", "params": {"sessionId": session}}}));
    script.push(json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/close", "result": {}}}));
    let open = golden["calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["method"] == "openSession")
        .unwrap()
        .clone();
    let start = golden["calls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["method"] == "startTurn")
        .unwrap()
        .clone();
    let mut calls = vec![
        open,
        golden["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["method"] == "ensureThread")
            .unwrap()
            .clone(),
    ];
    for round in 1..=rounds {
        let mut turn = start.clone();
        turn["input"]["providerTurnOrdinal"] = json!(round);
        turn["input"]["runOrdinal"] = json!(round);
        turn["input"]["runtimePolicy"] =
            json!({"runtimeMode": "approval-required", "interactionMode": "default", "cwd": "/w"});
        calls.push(turn);
        calls.push(json!({"method": "respondToRuntimeRequest", "input": {"decision": "accept"}}));
    }
    calls.push(json!({"method": "close"}));
    let golden = json!({"calls": calls, "transcripts": [script], "events": []});
    let run = replay(&crate::flavor::GROK, &golden).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(
        script.complete(),
        "stopped at {}: {:?}",
        script.cursor,
        script.failure
    );
    let terminals = run
        .events
        .iter()
        .filter(|e| e["type"] == "turn.terminal")
        .count();
    assert_eq!(terminals, rounds, "every turn ended");
}

/// Stop before the agent took the turn: the engine abandons the run's start, and the start
/// fails without sending `session/prompt`, as T3's interrupted `startTurn` sends none. The
/// session stays usable: the next run's turn runs.
#[tokio::test(flavor = "current_thread")]
async fn an_abandoned_start_sends_no_prompt() {
    let golden = read_golden("grok", "tool_call_read_only_on_request");
    let entries = golden["transcripts"][0].as_array().cloned().unwrap();
    let prompt_at = entries
        .iter()
        .position(|e| e["frame"]["method"] == "session/prompt")
        .unwrap();
    let mut script: Vec<Value> = entries[..prompt_at].to_vec();
    script.push(json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/prompt", "params": "<any>"}}));
    script.push(json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/prompt", "result": {"stopReason": "end_turn"}}}));
    let session = "00000000-0000-4000-8000-000000000001";
    script.push(json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/close", "params": {"sessionId": session}}}));
    script.push(json!({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/close", "result": {}}}));
    let calls = golden["calls"].as_array().unwrap();
    let find = |method: &str| {
        calls
            .iter()
            .find(|c| c["method"] == method)
            .unwrap()
            .clone()
    };
    let start = find("startTurn");
    let mut second = start.clone();
    second["input"]["runId"] = json!("run-second");
    second["input"]["runOrdinal"] = json!(2);
    second["input"]["providerTurnOrdinal"] = json!(1);
    let abandon = json!({"method": "abandonTurnStart", "input": {
        "threadId": start["input"]["threadId"], "runId": start["input"]["runId"]}});
    let golden = json!({
        "calls": [find("openSession"), find("ensureThread"), abandon, start, second],
        "transcripts": [script],
        "events": [],
    });
    let run = replay(&crate::flavor::GROK, &golden).await;
    assert_eq!(run.errors.len(), 1, "{:?}", run.errors);
    assert!(
        run.errors[0].starts_with("startTurn: ") && run.errors[0].contains("Stop ended the turn"),
        "{:?}",
        run.errors
    );
    let script = crate::lock(&run.script);
    assert!(
        script.complete(),
        "stopped at {}: {:?}",
        script.cursor,
        script.failure
    );
    let terminals = run
        .events
        .iter()
        .filter(|e| e["type"] == "turn.terminal")
        .count();
    assert_eq!(terminals, 1, "only the second run's turn ran");
}

/// The recorded `gemini-3.8-flash` session defaults to Low thinking and offers High. A turn
/// that chose High writes it with `session/set_config_option` before its prompt, as T3's
/// selection loop does (`adapter.ts`, `configSelections`).
fn antigravity_turn_with_thinking_level() -> Value {
    let recording = read_golden("antigravity", "turns");
    let mut entries = recording["entries"].as_array().cloned().unwrap();
    // The recording's sign-in method is its own; this session has none configured.
    for entry in &mut entries {
        if entry["frame"]["method"] == "authenticate" && entry["frame"]["kind"] == "request" {
            entry["frame"]["params"] = json!("<any>");
        }
    }
    let prompt_at = entries
        .iter()
        .position(|e| e["frame"]["method"] == "session/prompt")
        .unwrap();
    let answered_at = entries
        .iter()
        .position(|e| e["frame"]["kind"] == "response" && e["frame"]["method"] == "session/prompt")
        .unwrap();
    let session = "00000000-0000-4000-8000-00000000a6f1";
    let mut script: Vec<Value> = entries[..prompt_at].to_vec();
    script.push(
        json!({"type": "expect_outbound", "frame": {"kind": "request",
        "method": "session/set_config_option",
        "params": {"sessionId": session, "configId": "thought_level", "value": "high"}}}),
    );
    script.push(json!({"type": "emit_inbound", "frame": {"kind": "response",
        "method": "session/set_config_option", "result": {}}}));
    script.extend_from_slice(&entries[prompt_at..=answered_at]);
    script.extend(entries.iter().rev().take(2).rev().cloned());
    let grok = read_golden("grok", "tool_call_read_only_on_request");
    let find = |method: &str| {
        let mut call = grok["calls"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["method"] == method)
            .unwrap()
            .clone();
        let selection = json!({"instanceId": "antigravity", "model": "gemini-3.8-flash"});
        call["input"]["modelSelection"] = selection;
        if method == "startTurn" {
            // The call template is Grok's. Its saved thread must identify the
            // Antigravity conversation established by this recording's session/new.
            let thread = &mut call["input"]["providerThread"];
            thread["driver"] = json!("antigravity");
            thread["providerInstanceId"] = json!("antigravity");
            thread["nativeThreadRef"]["driver"] = json!("antigravity");
            thread["nativeThreadRef"]["nativeId"] = json!(session);

            call["input"]["modelSelection"]["options"] =
                json!([{"id": "thought_level", "value": "high"}]);
        }
        call
    };
    json!({
        "calls": [find("openSession"), find("ensureThread"), find("startTurn")],
        "transcripts": [script],
        "events": [],
    })
}

#[tokio::test]
async fn an_antigravity_turn_applies_the_chosen_thinking_level() {
    let run = replay(
        &crate::antigravity::ANTIGRAVITY,
        &antigravity_turn_with_thinking_level(),
    )
    .await;
    let script = crate::lock(&run.script);
    assert!(
        script.complete(),
        "stopped at {}: {:?} {:?}",
        script.cursor,
        script.failure,
        run.errors
    );
}

#[tokio::test]
async fn antigravity_reports_a_terminal_network_warning_as_a_failed_turn() {
    const WARNING: &str = "⚠ There was a network issue connecting to the server, please try again.";
    for (prefix, suffix, stop, status) in [
        ("", "", "end_turn", "failed"),
        ("The CLI said: ", "", "end_turn", "completed"),
        ("", " The retry worked.", "end_turn", "completed"),
        ("", "", "cancelled", "cancelled"),
    ] {
        let mut golden = antigravity_turn_with_thinking_level();
        let script = golden["transcripts"][0].as_array_mut().unwrap();
        let position = script
            .iter()
            .position(|entry| {
                entry["frame"]["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
            })
            .unwrap();
        let mut chunk = script[position].clone();
        script[position]["frame"]["params"]["update"]["content"]["text"] =
            json!(format!("{prefix}\n⚠ There was a network issue "));
        chunk["frame"]["params"]["update"]["content"]["text"] = json!(format!(
            "connecting to the server, please try again.\n{suffix}"
        ));
        script.insert(position + 1, chunk);
        script
            .iter_mut()
            .find(|entry| {
                entry["frame"]["kind"] == "response" && entry["frame"]["method"] == "session/prompt"
            })
            .unwrap()["frame"]["result"]["stopReason"] = json!(stop);

        let run = replay(&crate::antigravity::ANTIGRAVITY, &golden).await;
        assert!(run.errors.is_empty(), "{:?}", run.errors);
        assert!(crate::lock(&run.script).complete());
        let terminal = run
            .events
            .iter()
            .find(|event| event["type"] == "turn.terminal")
            .unwrap();
        assert_eq!(terminal["status"], status);
        if status == "failed" {
            assert_eq!(terminal["failure"]["message"], WARNING);
            assert_eq!(terminal["threadDisposition"], "reusable");
        }
        assert!(
            run.events
                .iter()
                .any(|event| event["type"] == "message.updated"
                    && event["message"]["text"] == format!("{prefix}\n{WARNING}\n{suffix}"))
        );
    }
}

#[tokio::test]
async fn antigravity_retries_undelivered_instructions_after_a_trailing_tool_update() {
    let mut golden = antigravity_turn_with_thinking_level();
    let calls = golden["calls"].as_array_mut().unwrap();
    let mut retry = calls.last().unwrap().clone();
    retry["input"]["providerTurnOrdinal"] = json!(2);
    retry["input"]["runOrdinal"] = json!(2);
    retry["input"]["runId"] = json!("retry-run");
    retry["input"]["message"]["text"] = json!("Try again");
    calls.push(retry);

    let script = golden["transcripts"][0].as_array_mut().unwrap();
    let at = script
        .iter()
        .position(|entry| {
            entry["frame"]["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
        })
        .unwrap();
    let original = script[at].clone();
    let session_id = original["frame"]["params"]["sessionId"].clone();
    let update = |body: Value| {
        let mut event = original.clone();
        event["frame"]["params"]["update"] = body;
        event
    };
    let warning = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text",
        "text": "\n⚠ There was a network issue connecting to the server, please try again.\n"}});
    let tool =
        json!({"sessionUpdate":"tool_call","toolCallId":"read","kind":"read","title":"Read"});
    let done = json!({"sessionUpdate":"tool_call_update","toolCallId":"read","status":"completed"});
    let reply = script[at + 1].clone();
    let retry_prompt = json!({"type": "expect_outbound", "frame": {"kind": "request", "method": "session/prompt",
    "params":{"sessionId":session_id,"prompt":[
        {"type":"text","text":"<any><conn_instructions><any>Try again<any>"},
        {"type":"text","text":"<any><runtime_info><any>"}
    ]}}});
    let select = script
        .iter()
        .position(|entry| entry["frame"]["params"]["configId"] == "thought_level")
        .unwrap();
    let select_request = script[select].clone();
    let select_reply = script[select + 1].clone();
    script.splice(
        at..=at + 1,
        [
            update(tool.clone()),
            update(warning.clone()),
            update(done.clone()),
            reply.clone(),
            select_request,
            select_reply,
            retry_prompt,
            update(tool),
            update(warning),
            update(done),
            original,
            reply,
        ],
    );

    let run = replay(&crate::antigravity::ANTIGRAVITY, &golden).await;
    let script = crate::lock(&run.script);
    assert!(
        script.complete(),
        "entry {}: {:?}, {:?}",
        script.cursor,
        script.failure,
        run.errors
    );
    let statuses: Vec<_> = run
        .events
        .iter()
        .filter(|event| event["type"] == "turn.terminal")
        .map(|event| event["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["failed", "completed"]);
}

fn wire_request(method: &str, params: Value) -> Value {
    json!({"type":"expect_outbound","label":format!("request:{method}"),"frame":{"kind":"request","method":method,"params":params}})
}
fn user_echo(session: &Value, text: &Value) -> Value {
    json!({"type":"emit_inbound","frame":{"kind":"notification","method":"session/update",
        "params":{"sessionId":session,"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}}}}})
}

fn wire_result(method: &str, result: Value) -> Value {
    json!({"type":"emit_inbound","label":format!("response:{method}"),"frame":{"kind":"response","method":method,"result":result}})
}

#[tokio::test]
async fn cold_resume_activates_saved_conversations_before_prompting() {
    for (flavor, mut fixture) in [
        (&crate::flavor::GROK, read_golden("grok", "simple")),
        (
            &crate::antigravity::ANTIGRAVITY,
            antigravity_turn_with_thinking_level(),
        ),
    ] {
        let calls = fixture["calls"].as_array_mut().unwrap();
        let at = calls
            .iter()
            .position(|c| c["method"] == "startTurn")
            .unwrap();
        let thread = &mut calls[at]["input"]["providerThread"];
        thread["nativeThreadRef"]["nativeId"] = json!("saved-session");
        let thread = thread.clone();
        calls.insert(
            at,
            json!({"method":"resumeThread","input":{"providerThread":thread}}),
        );
        let script = fixture["transcripts"][0].as_array_mut().unwrap();
        let init = script
            .iter_mut()
            .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
            .unwrap();
        init["frame"]["result"]["agentCapabilities"]["loadSession"] = json!(true);
        if flavor.resume {
            init["frame"]["result"]["agentCapabilities"]["sessionCapabilities"]["resume"] =
                json!({});
        }
        let new = script
            .iter()
            .position(|r| r["frame"]["method"] == "session/new" && r["frame"]["kind"] == "response")
            .unwrap();
        let setup = script[new]["frame"]["result"].clone();
        let prompt = script
            .iter()
            .position(|r| {
                r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request"
            })
            .unwrap();
        let method = if flavor.resume {
            "session/resume"
        } else {
            "session/load"
        };
        let at = script
            .iter()
            .position(|r| {
                r["frame"]["kind"] == "request"
                    && r["frame"]["params"]["configId"] == "thought_level"
            })
            .unwrap_or(prompt);
        for r in script.iter_mut().skip(at) {
            let f = &mut r["frame"];
            if f["params"].get("sessionId").is_some() {
                f["params"]["sessionId"] = json!("saved-session");
            }
        }
        let mut setup = setup;
        if let Some(options) = setup["configOptions"].as_array_mut()
            && let Some(model) = options.iter_mut().find(|o| o["category"] == "model")
        {
            model["currentValue"] = json!("gemini-3.8-flash");
        }
        script.splice(
            at..at,
            [
                wire_request(method, json!("<any>")),
                wire_result(method, setup),
            ],
        );
        let run = replay(flavor, &fixture).await;
        assert!(run.errors.is_empty(), "{:?}", run.errors);
        let script = crate::lock(&run.script);
        assert!(script.complete(), "{:?}", script.failure);
        for method in [method, "session/prompt"] {
            assert!(
                script
                    .written
                    .iter()
                    .any(|f| f["method"] == method && f["params"]["sessionId"] == "saved-session")
            );
        }
    }
}

#[tokio::test]
async fn antigravity_reports_typed_limits_and_native_usage() {
    for reason in ["max_tokens", "max_turn_requests", "refusal"] {
        let mut fixture = antigravity_turn_with_thinking_level();
        let frame = fixture["transcripts"][0]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|v| v["frame"]["method"] == "session/prompt" && v["frame"]["kind"] == "response")
            .unwrap();
        frame["frame"]["result"] = json!({"stopReason":reason,"usage":{"inputTokens":163,"outputTokens":40,"cachedReadTokens":12,"thoughtTokens":32}});
        let run = replay(&crate::antigravity::ANTIGRAVITY, &fixture).await;
        assert!(run.errors.is_empty(), "{:?}", run.errors);
        let terminal = run
            .events
            .iter()
            .find(|e| e["type"] == "turn.terminal")
            .unwrap();
        assert_eq!(terminal["status"], "failed");
        if reason == "refusal" {
            assert_eq!(terminal["failure"]["class"], "usage_limit");
        }
        let usage = run
            .events
            .iter()
            .find_map(|e| e["providerTurn"].get("turnTokenUsage"))
            .unwrap();
        assert_eq!(usage["inputTokens"], 175);
        assert_eq!(usage["outputTokens"], 40);
        assert_eq!(usage["reasoningTokens"], 32);
        assert_eq!(usage["usageStatus"], "partial");
    }
}

#[tokio::test]
async fn app_context_reaches_the_grok_prompt_as_external_text() {
    let mut fixture = read_golden("grok", "simple");
    let call = fixture["calls"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["method"] == "startTurn")
        .unwrap();
    call["input"]["appContext"] = json!([{"key":"card","text":"selected value"}]);
    let prompt = fixture["transcripts"][0]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["frame"]["method"] == "session/prompt" && e["frame"]["kind"] == "request")
        .unwrap();
    prompt["frame"]["params"]["prompt"]
        .as_array_mut()
        .unwrap()
        .insert(
            0,
            json!({"type":"text","text":"<external_card>selected value</external_card>"}),
        );
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    assert!(crate::lock(&run.script).complete());
}

#[tokio::test(start_paused = true)]
async fn active_steers_use_the_native_route_and_keep_the_original_turn() {
    for (is_grok, mut fixture) in [
        (true, read_golden("grok", "simple")),
        (false, antigravity_turn_with_thinking_level()),
    ] {
        fixture["attachmentsDir"] = json!("/test-attachments");
        let calls = fixture["calls"].as_array_mut().unwrap();
        let pos = calls
            .iter()
            .position(|c| c["method"] == "startTurn")
            .unwrap();
        let initial_text = calls[pos]["input"]["message"]["text"].clone();
        let mut steer = calls[pos].clone();
        steer["method"] = json!("steerTurn");
        steer["input"]["message"]["text"] = json!("adjust course");
        steer["input"]["message"]["attachments"] = json!([{"type":"file","id":"archive","name":"reports.zip","mimeType":"application/zip","sizeBytes":5}]);
        let text = "adjust course\n\n[Attached file \"reports.zip\" is saved at: /test-attachments/archive.zip]";
        calls.insert(pos + 1, steer);
        if !is_grok {
            let mut second = calls[pos + 1].clone();
            second["input"]["message"]["messageId"] = json!("second");
            second["input"]["message"]["text"] = json!("one more");
            second["input"]["message"]["attachments"] = json!([]);
            calls.insert(pos + 2, second);
        }
        let script = fixture["transcripts"][0].as_array_mut().unwrap();
        let init = script
            .iter_mut()
            .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
            .unwrap();
        init["frame"]["result"]["agentInfo"]["version"] = json!("1.5.11");
        let prompt = script
            .iter()
            .position(|r| {
                r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request"
            })
            .unwrap();
        let session = script
            .iter()
            .find(|r| r["frame"]["method"] == "session/new" && r["frame"]["kind"] == "response")
            .unwrap()["frame"]["result"]["sessionId"]
            .clone();
        let (method, params, result) = if is_grok {
            (
                "_x.ai/interject",
                json!({"sessionId":session,"text":text}),
                json!({"result":{"status":"queued"}}),
            )
        } else {
            // A failed response to the superseded first prompt is not the new turn outcome.
            (
                "session/prompt",
                json!({"sessionId":session,"prompt":[{"type":"text","text":text}]}),
                json!({"stopReason":"refusal","usage":{"inputTokens":999,"outputTokens":100}}),
            )
        };
        script.splice(prompt+1..prompt+1,[json!({"type":"expect_outbound","frame":{"kind":"request","method":method,"params":params}}),
            json!({"type":"emit_inbound","frame":{"kind":"response","method":method,"result":result}})]);
        if !is_grok {
            // A's user echo admits B before A has finished. A delayed refusal for A
            // cannot settle the turn after B's own correlated response.
            script.splice(prompt + 3..prompt + 3, [
                json!({"type":"emit_inbound","frame":{"kind":"notification","method":"session/update",
                    "params":{"sessionId":session,"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":text}}}}}),
                wire_request(method, json!({"sessionId":session,"prompt":[{"type":"text","text":"one more"}]})),
                wire_result(method, json!({"stopReason":"refusal"})),
            ]);
        }
        if !is_grok {
            script.insert(prompt + 1, user_echo(&session, &initial_text));
        }
        let flavor = if is_grok {
            &crate::flavor::GROK
        } else {
            &crate::antigravity::ANTIGRAVITY
        };
        let run = replay(flavor, &fixture).await;
        assert!(
            run.errors.is_empty(),
            "{:?}; wire: {:?}",
            run.errors,
            crate::lock(&run.script).failure
        );
        let script = crate::lock(&run.script);
        assert!(script.complete(), "{:?}", script.failure);
        let terminals: Vec<_> = run
            .events
            .iter()
            .filter(|e| e["type"] == "turn.terminal")
            .collect();
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0]["status"], "completed");
    }
}

#[tokio::test(start_paused = true)]
async fn antigravity_declines_busy_steers_in_order_and_stops_the_original_prompt() {
    for (stop, original_busy) in [(true, false), (false, false), (true, true)] {
        let mut fixture = antigravity_turn_with_thinking_level();
        let mut calls = fixture["calls"].as_array().unwrap().clone();
        let start = calls.last().unwrap().clone();
        for (message_id, text) in [("a", "first steer"), ("b", "second steer")] {
            let mut steer = start.clone();
            steer["method"] = json!("steerTurn");
            steer["input"]["message"]["messageId"] = json!(message_id);
            steer["input"]["message"]["text"] = json!(text);
            calls.push(steer);
        }
        let script = fixture["transcripts"][0].as_array_mut().unwrap();
        let init = script
            .iter_mut()
            .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
            .unwrap();
        init["frame"]["result"]["agentInfo"]["version"] = json!("1.5.11");
        let prompt = script
            .iter()
            .position(|r| r["frame"]["method"] == "session/prompt")
            .unwrap();
        let session = script
            .iter()
            .find(|r| r["frame"]["kind"] == "response" && r["frame"]["method"] == "session/new")
            .unwrap()["frame"]["result"]["sessionId"]
            .clone();
        let close = script.split_off(script.len() - 2);
        script.truncate(prompt + 1);
        if !original_busy {
            script.push(user_echo(&session, &start["input"]["message"]["text"]));
            script.push(wire_request(
                "session/prompt",
                json!({"sessionId":session,"prompt":[{"type":"text","text":"first steer"}]}),
            ));
        }
        // For Stop, the original native request remains outstanding after A is rejected.
        // For failure, its earlier refusal must be retained until the outcome of A is known.
        if !stop {
            script.push(wire_result(
                "session/prompt",
                json!({"stopReason":"refusal"}),
            ));
        }
        script.push(json!({"type":"emit_inbound","frame":{"kind":"response","method":"session/prompt",
            "pendingRequestIndex":usize::from(stop && !original_busy),"error":{"code":-32603,"message":"Agent is already processing a request."}}}));
        if stop {
            let turn = crate::testing::turn_input(&start["input"]);
            let native = format!(
                "{}:turn:{}",
                session.as_str().unwrap(),
                turn.provider_turn_ordinal
            );
            let id = conn_provider_support::ids::provider_turn_id(
                "antigravity",
                &format!("provider-instance:antigravity:{native}"),
            );
            calls.push(json!({"method":"interruptTurn","input":{"providerThread":start["input"]["providerThread"],"providerTurnId":id}}));
            script.push(json!({"type":"expect_outbound","frame":{"kind":"notification","method":"session/cancel","params":{"sessionId":session}}}));
            if !original_busy {
                script.push(wire_result(
                    "session/prompt",
                    json!({"stopReason":"cancelled"}),
                ));
            }
        }
        script.extend(close);
        fixture["calls"] = Value::Array(calls);
        let run = replay(&crate::antigravity::ANTIGRAVITY, &fixture).await;
        assert_eq!(run.errors.len(), 2, "{:?}", run.errors);
        assert!(
            run.errors[0].contains(if original_busy {
                "awaiting delivery"
            } else {
                "already processing"
            }),
            "{:?}",
            run.errors
        );
        assert!(run.errors[1].starts_with("steerTurn:"), "{:?}", run.errors);
        let script = crate::lock(&run.script);
        assert!(script.complete(), "{:?}", script.failure);
        assert_eq!(
            script
                .written
                .iter()
                .filter(|r| r["method"] == "session/prompt")
                .count(),
            if original_busy { 1 } else { 2 }
        );
        let terminals: Vec<_> = run
            .events
            .iter()
            .filter(|e| e["type"] == "turn.terminal")
            .collect();
        assert_eq!(terminals.len(), 1, "{terminals:?}");
        assert_eq!(
            terminals[0]["status"],
            if stop { "interrupted" } else { "failed" }
        );
    }
}

#[tokio::test]
async fn antigravity_questions_round_trip_under_full_access() {
    for form in [true, false] {
        let mut fixture = antigravity_turn_with_thinking_level();
        let calls = fixture["calls"].as_array_mut().unwrap();
        let pos = calls
            .iter()
            .position(|c| c["method"] == "startTurn")
            .unwrap();
        let script = fixture["transcripts"][0].as_array_mut().unwrap();
        let prompt = script
            .iter()
            .position(|r| {
                r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request"
            })
            .unwrap();
        let session = script
            .iter()
            .find(|r| r["frame"]["method"] == "session/new" && r["frame"]["kind"] == "response")
            .unwrap()["frame"]["result"]["sessionId"]
            .clone();
        let (method, params, answers, reply) = if form {
            (
                "elicitation/create",
                json!({"mode":"form","message":"Choose","requestedSchema":{"type":"object","properties":{"amount":{"type":"integer"}},"required":["amount"]}}),
                json!({"amount":"2"}),
                json!({"action":"accept","content":{"amount":2}}),
            )
        } else {
            (
                "session/request_permission",
                json!({"sessionId":session,"toolCall":{"toolCallId":"interaction_q","title":"Choice"},"options":[{"kind":"allow_once","optionId":"a","name":"A"},{"kind":"allow_once","optionId":"b","name":"B"}]}),
                json!({"interaction_q":"b"}),
                json!({"outcome":{"outcome":"selected","optionId":"b"}}),
            )
        };
        fixture["calls"].as_array_mut().unwrap().insert(
            pos + 1,
            json!({"method":"respondToRuntimeRequest","input":{"answers":answers}}),
        );
        let script = fixture["transcripts"][0].as_array_mut().unwrap();
        script.splice(prompt+1..prompt+1,[json!({"type":"emit_inbound","frame":{"kind":"request","method":method,"params":params}}),
            json!({"type":"expect_outbound","frame":{"kind":"response","method":method,"result":reply}})]);
        let run = tokio::time::timeout(
            Duration::from_secs(4),
            replay(&crate::antigravity::ANTIGRAVITY, &fixture),
        )
        .await
        .expect("agent must wait for human answers");
        assert!(run.errors.is_empty(), "{:?}", run.errors);
        assert!(
            crate::lock(&run.script).complete(),
            "{:?}",
            crate::lock(&run.script).failure
        );
        assert!(
            run.events
                .iter()
                .any(|e| e["type"] == "runtime_request.updated"
                    && e["runtimeRequest"]["status"] == "pending")
        );
    }
}

#[tokio::test]
async fn fork_negotiates_native_session_and_uses_the_child_for_the_next_prompt() {
    let mut fixture = read_golden("grok", "simple");
    let calls = fixture["calls"].as_array_mut().unwrap();
    let at = calls
        .iter()
        .position(|c| c["method"] == "startTurn")
        .unwrap();
    let source = calls[at]["input"]["providerThread"].clone();
    calls[at]["input"]["providerThread"]["nativeThreadRef"]["nativeId"] = json!("forked");
    calls.insert(at,json!({"method":"forkThread","input":{"sourceProviderThread":source,"targetThreadId":"child"}}));
    let entries = fixture["transcripts"][0].as_array_mut().unwrap();
    let new = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/new" && r["frame"]["kind"] == "response")
        .unwrap();
    let mut child = entries[new]["frame"]["result"].clone();
    let source = child["sessionId"].clone();
    child["sessionId"] = json!("forked");
    let init = entries
        .iter_mut()
        .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
        .unwrap();
    init["frame"]["result"]["agentCapabilities"]["sessionCapabilities"]["fork"] = json!({});
    let prompt = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request")
        .unwrap();
    for r in &mut entries[prompt..] {
        if r["frame"]["params"]["sessionId"] == source {
            r["frame"]["params"]["sessionId"] = json!("forked");
        }
    }
    entries.splice(prompt..prompt,[json!({"type":"expect_outbound","frame":{"kind":"request","method":"session/fork","params":"<any>"}}),
        json!({"type":"emit_inbound","frame":{"kind":"response","method":"session/fork","result":child}})]);
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(script.complete(), "{:?}", script.failure);
    assert_eq!(
        script
            .written
            .iter()
            .find(|v| v["method"] == "session/fork")
            .unwrap()["params"]["sessionId"],
        source
    );
    assert_eq!(
        script
            .written
            .iter()
            .find(|v| v["method"] == "session/prompt")
            .unwrap()["params"]["sessionId"],
        "forked"
    );
}

#[tokio::test(start_paused = true)]
async fn antigravity_watchdog_retires_an_unresponsive_live_prompt() {
    let mut fixture = antigravity_turn_with_thinking_level();
    fixture["calls"]
        .as_array_mut()
        .unwrap()
        .push(json!({"method":"advanceTime","input":{"seconds":901}}));
    let entries = fixture["transcripts"][0].as_array_mut().unwrap();
    let prompt = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request")
        .unwrap();
    // The simulated agent remains alive with its stdin open and sends no response.
    entries.truncate(prompt + 1);
    let run = replay(&crate::antigravity::ANTIGRAVITY, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let failed = run
        .events
        .iter()
        .find(|e| e["type"] == "turn.terminal")
        .expect("terminal inactivity failure");
    assert_eq!(failed["status"], "failed");
    assert!(
        failed["failure"]["message"]
            .as_str()
            .unwrap()
            .contains("15 minutes")
    );
}

fn snapshot_update(session: &str, update: Value) -> Value {
    json!({"type":"emit_inbound","frame":{"kind":"notification","method":"session/update","params":{
        "sessionId":session,"_meta":{"isReplay":true},"update":update
    }}})
}

#[tokio::test]
async fn grok_snapshot_loads_only_its_native_transcript_and_caches_stable_ids() {
    let mut fixture = read_golden("grok", "simple");
    let calls = fixture["calls"].as_array_mut().unwrap();
    let mut thread =
        calls.iter().find(|c| c["method"] == "startTurn").unwrap()["input"]["providerThread"]
            .clone();
    let native = "saved-snapshot";
    thread["nativeThreadRef"]["nativeId"] = json!(native);
    thread["appThreadId"] = Value::Null; // older strong refs fall back to the opened application thread
    calls.retain(|c| c["method"] == "openSession" || c["method"] == "ensureThread");
    let app_thread = calls[1]["input"]["threadId"].clone();
    let read = json!({"method":"readThreadSnapshot","input":{"providerThread":thread}});
    calls.extend([read.clone(), read]);
    let entries = fixture["transcripts"][0].as_array_mut().unwrap();
    let init = entries
        .iter_mut()
        .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
        .unwrap();
    init["frame"]["result"]["agentCapabilities"]["loadSession"] = json!(true);
    let prompt = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt")
        .unwrap();
    entries.truncate(prompt);
    entries.extend([
        wire_request("session/load",json!("<any>")),
        snapshot_update(native,json!({"sessionUpdate":"user_message_chunk","messageId":"u","content":{"type":"text","text":"hello"}})),
        snapshot_update(native,json!({"sessionUpdate":"user_message_chunk","messageId":"u","content":{"type":"text","text":" there"}})),
        snapshot_update("foreign",json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"another session"}})),
        snapshot_update(native,json!({"sessionUpdate":"agent_thought_chunk","messageId":"r","content":{"type":"text","text":"working"}})),
        snapshot_update(native,json!({"sessionUpdate":"agent_message_chunk","messageId":"a","content":{"type":"text","text":"partial"}})),
        snapshot_update(native,json!({"sessionUpdate":"agent_message","messageId":"a","content":[{"type":"text","text":"final answer"}]})),
        snapshot_update(native,json!({"sessionUpdate":"tool_call","toolCallId":"tool","title":"open"})),
        snapshot_update(native,json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"anonymous"}})),
        snapshot_update(native,json!({"sessionUpdate":"plan","entries":[]})),
        snapshot_update(native,json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"next"}})),
        wire_result("session/load",json!({"sessionId":native})),
        wire_request("session/close",json!({"sessionId":native})),
        wire_result("session/close",json!({})),
        json!({"type":"runtime_exit","status":"success"}),
    ]);
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(script.complete(), "{:?}", script.failure);
    let loads: Vec<_> = script
        .written
        .iter()
        .filter(|r| r["method"] == "session/load")
        .collect();
    assert_eq!(loads.len(), 1);
    assert_eq!(loads[0]["params"]["sessionId"], native);
    assert_eq!(run.snapshots.len(), 2);
    for snapshot in &run.snapshots {
        let texts: Vec<_> = snapshot.messages.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "hello there",
                "working",
                "final answer",
                "anonymous",
                "next"
            ]
        );
        let roles: Vec<_> = snapshot
            .messages
            .iter()
            .map(|m| conn_contract::to_json(m)["role"].clone())
            .collect();
        assert_eq!(
            roles,
            json!(["user", "assistant", "assistant", "assistant", "assistant"])
                .as_array()
                .unwrap()
                .as_slice()
        );
        assert_eq!(
            snapshot.reasoning_message_ids,
            [snapshot.messages[1].id.to_string()]
        );
        let id = conn_provider_support::ids::message_from_item(
            "grok",
            "provider-instance:grok:saved-snapshot:history:thought:message:r",
        );
        assert_eq!(snapshot.reasoning_message_ids, [id]);
        assert!(
            snapshot
                .messages
                .iter()
                .all(|m| m.thread_id == app_thread.as_str().unwrap() && !m.streaming)
        );
        assert_eq!(
            conn_contract::to_json(&snapshot.provider_thread)["status"],
            "idle"
        );
        assert!(snapshot.provider_turns.is_empty() && snapshot.runtime_requests.is_empty());
    }
    assert_eq!(
        conn_contract::to_json(&run.snapshots[0].messages),
        conn_contract::to_json(&run.snapshots[1].messages)
    );
    assert!(
        !run.events
            .iter()
            .any(|event| event["type"] == "message.updated")
    );
}

#[tokio::test]
async fn a_prompt_after_a_foreign_snapshot_reactivates_its_own_native_conversation() {
    let mut fixture = read_golden("grok", "simple");
    let calls = fixture["calls"].as_array_mut().unwrap();
    let start = calls
        .iter()
        .position(|c| c["method"] == "startTurn")
        .unwrap();
    let mut thread = calls[start]["input"]["providerThread"].clone();
    let original = thread["nativeThreadRef"]["nativeId"].clone();
    thread["nativeThreadRef"]["nativeId"] = json!("saved");
    calls.insert(
        start,
        json!({"method":"readThreadSnapshot","input":{"providerThread":thread}}),
    );
    let entries = fixture["transcripts"][0].as_array_mut().unwrap();
    let init = entries
        .iter_mut()
        .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
        .unwrap();
    init["frame"]["result"]["agentCapabilities"]["loadSession"] = json!(true);
    let prompt = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt")
        .unwrap();
    entries.splice(
        prompt..prompt,
        [
            wire_request("session/load", json!("<any>")),
            wire_result("session/load", json!({"sessionId":"saved"})),
            wire_request("session/load", json!("<any>")),
            wire_result("session/load", json!({"sessionId":original})),
        ],
    );
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(script.complete(), "{:?}", script.failure);
    let route: Vec<_> = script
        .written
        .iter()
        .filter(|r| r["method"] == "session/load" || r["method"] == "session/prompt")
        .map(|r| r["params"]["sessionId"].clone())
        .collect();
    assert_eq!(route, vec![json!("saved"), original.clone(), original]);
}

#[tokio::test(start_paused = true)]
async fn a_snapshot_needs_the_end_of_replay_before_it_can_return_rows() {
    let mut fixture = read_golden("grok", "simple");
    let calls = fixture["calls"].as_array_mut().unwrap();
    let mut thread =
        calls.iter().find(|c| c["method"] == "startTurn").unwrap()["input"]["providerThread"]
            .clone();
    thread["nativeThreadRef"]["nativeId"] = json!("unconfirmed");
    calls.retain(|c| c["method"] == "openSession" || c["method"] == "ensureThread");
    calls.push(json!({"method":"readThreadSnapshot","input":{"providerThread":thread}}));
    let entries = fixture["transcripts"][0].as_array_mut().unwrap();
    let init = entries
        .iter_mut()
        .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
        .unwrap();
    init["frame"]["result"]["agentCapabilities"]["loadSession"] = json!(true);
    let prompt = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt")
        .unwrap();
    let close = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/close")
        .unwrap();
    entries.splice(prompt..close, [
        wire_request("session/load",json!("<any>")),
        snapshot_update("unconfirmed",json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"only the first row"}})),
    ]);
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.snapshots.is_empty());
    assert_eq!(run.errors.len(), 1);
    assert!(run.errors[0].contains("timed out"), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(script.complete(), "{:?}", script.failure);
}

#[tokio::test]
async fn grok_snapshots_keep_live_app_ids_and_respect_missing_load_capability() {
    for supported in [true, false] {
        let mut fixture = read_golden("grok", "simple");
        let calls = fixture["calls"].as_array_mut().unwrap();
        let input = calls.iter().find(|c| c["method"] == "startTurn").unwrap()["input"].clone();
        calls.push(json!({"method":"readThreadSnapshot","input":{"providerThread":input["providerThread"],"expectedCapability":supported}}));
        let init = fixture["transcripts"][0]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
            .unwrap();
        init["frame"]["result"]["agentCapabilities"]["loadSession"] = json!(supported);
        let run = replay(&crate::flavor::GROK, &fixture).await;
        let script = crate::lock(&run.script);
        assert!(script.complete(), "{:?}", script.failure);
        assert!(!script.written.iter().any(|r| r["method"] == "session/load"));
        if supported {
            assert!(run.errors.is_empty(), "{:?}", run.errors);
            let snapshot = &run.snapshots[0];
            let live: Vec<_> = run
                .events
                .iter()
                .filter(|e| e["type"] == "message.updated" && e["message"]["streaming"] == false)
                .collect();
            assert!(!live.is_empty());
            assert_eq!(
                snapshot.messages[0].id,
                input["message"]["messageId"].as_str().unwrap()
            );
            for event in live {
                assert!(
                    snapshot
                        .messages
                        .iter()
                        .any(|m| m.id == event["message"]["id"].as_str().unwrap()
                            && m.text == event["message"]["text"])
                );
            }
        } else {
            assert!(run.snapshots.is_empty());
            assert_eq!(run.errors.len(), 1);
            assert!(
                run.errors[0].contains("read_thread_snapshot"),
                "{:?}",
                run.errors
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn grok_load_uses_replay_progress_and_survives_a_late_real_response() {
    let mut fixture = read_golden("grok", "simple");
    let calls = fixture["calls"].as_array_mut().unwrap();
    let at = calls
        .iter()
        .position(|c| c["method"] == "startTurn")
        .unwrap();
    let thread = &mut calls[at]["input"]["providerThread"];
    thread["nativeThreadRef"]["nativeId"] = json!("restored");
    let thread = thread.clone();
    calls.insert(
        at,
        json!({"method":"resumeThread","input":{"providerThread":thread}}),
    );
    let entries = fixture["transcripts"][0].as_array_mut().unwrap();
    let init = entries
        .iter_mut()
        .find(|r| r["frame"]["method"] == "initialize" && r["frame"]["kind"] == "response")
        .unwrap();
    init["frame"]["result"]["agentCapabilities"]["loadSession"] = json!(true);
    init["frame"]["result"]["agentCapabilities"]["sessionCapabilities"]["resume"] = Value::Null;
    let prompt = entries
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request")
        .unwrap();
    for r in &mut entries[prompt..] {
        if r["frame"]["params"].get("sessionId").is_some() {
            r["frame"]["params"]["sessionId"] = json!("restored");
        }
    }
    entries.insert(
        prompt + 1,
        wire_result("session/load", json!({"sessionId":"restored"})),
    );
    entries.splice(prompt..prompt,[wire_request("session/load",json!("<any>")),
        json!({"type":"emit_inbound","frame":{"kind":"notification","method":"session/update","params":{"sessionId":"restored","_meta":{"isReplay":true},"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"history sentinel"}}}}})]);
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    let script = crate::lock(&run.script);
    assert!(script.complete(), "{:?}", script.failure);
    assert!(
        !run.events
            .iter()
            .any(|e| e.to_string().contains("history sentinel"))
    );
}

#[tokio::test]
async fn a_settled_grok_command_holds_the_lane_until_explicit_stop() {
    let mut fixture = read_golden("grok", "grok_background_bash");
    let calls = fixture["calls"].as_array_mut().unwrap();
    let first = calls
        .iter()
        .position(|r| r["method"] == "startTurn")
        .unwrap();
    calls.truncate(first + 1);
    calls.push(json!({"method":"stopSettledWork","input":calls[first]["input"]}));
    fixture["gates"] = json!([]);
    // The transcript next reports completion of the native task. Test the real
    // command roster before that notification, once its foreground run has ended.
    let script = fixture["transcripts"][0].as_array_mut().unwrap();
    let end = script
        .iter()
        .position(|r| r["frame"]["method"] == "_x.ai/task_completed")
        .unwrap();
    script.truncate(end);
    let run = replay(&crate::flavor::GROK, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    assert!(crate::lock(&run.script).complete());
}

#[tokio::test(start_paused = true)]
async fn antigravity_releases_a_silent_foreground_command_after_its_bounded_hold() {
    let mut fixture = antigravity_turn_with_thinking_level();
    let script = fixture["transcripts"][0].as_array_mut().unwrap();
    let prompt = script
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "request")
        .unwrap();
    let reply = script
        .iter()
        .position(|r| r["frame"]["method"] == "session/prompt" && r["frame"]["kind"] == "response")
        .unwrap();
    let session = script
        .iter()
        .find(|r| r["frame"]["method"] == "session/new" && r["frame"]["kind"] == "response")
        .unwrap()["frame"]["result"]["sessionId"]
        .clone();
    script.splice(prompt+1..reply,[json!({"type":"emit_inbound","frame":{"kind":"notification","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"tool_call","toolCallId":"native-command","title":"Run command","kind":"execute","status":"in_progress","rawInput":{"CommandLine":"build","WaitMsBeforeAsync":1000}}}}})]);
    let calls = fixture["calls"].as_array_mut().unwrap();
    calls.extend([
        json!({"method":"advanceTime","input":{"seconds":1799}}),
        json!({"method":"checkActive"}),
        json!({"method":"advanceTime","input":{"seconds":2}}),
    ]);
    let run = replay(&crate::antigravity::ANTIGRAVITY, &fixture).await;
    assert!(run.errors.is_empty(), "{:?}", run.errors);
    assert!(
        run.events
            .iter()
            .any(|e| e["type"] == "turn.terminal" && e["status"] == "completed")
    );
}
