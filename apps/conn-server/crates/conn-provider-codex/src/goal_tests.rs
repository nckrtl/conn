//! `/goal` through a scripted app-server: the native `thread/goal/*` operations T3's
//! `CodexAdapterV2` sends (`runGoalCommand`, `activateGoal`, the goal hold), compared on the
//! wire and in the events. Ports the "native goals" cases of `CodexAdapterV2.test.ts`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use conn_contract::{ProviderThread, from_json, to_json};
use conn_provider::{
    EnsureThreadInput, InterruptInput, OpenSessionInput, OpenedSession, Provider, ProviderEvent,
    Session,
};
use conn_provider_support::ids;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::session::tests::{policy, turn};
use crate::{CodexConfig, CodexProvider, mapper::DRIVER};

const OBJECTIVE: &str = "Ship the feature";

fn goal(status: &str, tokens: u64) -> String {
    json!({"threadId": "th1", "objective": OBJECTIVE, "status": status, "tokenBudget": null,
        "tokensUsed": tokens, "timeUsedSeconds": 3, "createdAt": 1_782_622_440,
        "updatedAt": 1_782_622_450})
    .to_string()
}

/// The app-server: `thread/goal/get` answers `current`; setting a goal active runs `on_active`
/// (the frames Codex sends once the goal drives the thread).
fn script(current: &str, on_active: &[String]) -> String {
    let emits: String = on_active
        .iter()
        .map(|frame| format!("      emit '{frame}'\n"))
        .collect();
    let paused = goal("paused", 0);
    let active = goal("active", 0);
    format!(
        r#"#!/bin/sh
emit() {{ printf '%s\n' "$1"; }}
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$0.stdin"
  id=$(printf '%s' "$line" | sed -n 's/^{{"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) emit "{{\"id\":$id,\"result\":{{\"userAgent\":\"t3code_desktop/0.167.0 (x)\"}}}}" ;;
    *'"method":"model/list"'*) emit "{{\"id\":$id,\"result\":{{\"data\":[],\"nextCursor\":null}}}}" ;;
    *'"method":"thread/start"'*) emit "{{\"id\":$id,\"result\":{{\"thread\":{{\"id\":\"th1\",\"createdAt\":1,\"updatedAt\":2}}}}}}" ;;
    *'"method":"config/read"'*) emit "{{\"id\":$id,\"result\":{{\"config\":{{}}}}}}" ;;
    *'"method":"thread/goal/get"'*) emit "{{\"id\":$id,\"result\":{{\"goal\":$(printf '%s' '{current}')}}}}" ;;
    *'"method":"thread/goal/clear"'*)
      emit "{{\"id\":$id,\"result\":{{\"cleared\":true}}}}"
      emit '{{"method":"thread/goal/cleared","params":{{"threadId":"th1"}}}}' ;;
    *'"method":"thread/goal/set"'*'"status":"active"'*)
      emit "{{\"id\":$id,\"result\":{{\"goal\":$(printf '%s' '{active}')}}}}"
{emits}      ;;
    *'"method":"thread/goal/set"'*) emit "{{\"id\":$id,\"result\":{{\"goal\":$(printf '%s' '{paused}')}}}}" ;;
    *'"method":"turn/start"'*'goal is already set'*)
      emit "{{\"id\":$id,\"result\":{{\"turn\":{{\"id\":\"g1\",\"startedAt\":null}}}}}}" ;;
    *'"method":"turn/start"'*)
      emit "{{\"id\":$id,\"result\":{{\"turn\":{{\"id\":\"tu0\",\"startedAt\":null}}}}}}"
      emit '{{"method":"turn/completed","params":{{"threadId":"th1","turn":{{"id":"tu0","status":"completed","completedAt":3}}}}}}' ;;
    *'"method":"turn/interrupt"'*) emit "{{\"id\":$id,\"result\":{{}}}}" ;;
  esac
done
"#
    )
}

struct Fixture {
    dir: PathBuf,
    session: Box<dyn Session>,
    events: mpsc::Receiver<ProviderEvent>,
    thread: ProviderThread,
}

impl Fixture {
    async fn open(name: &str, script: &str, grace: Duration) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "conn-codex-goal-{name}-{}-{}",
            std::process::id(),
            conn_support::uuid_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("codex");
        conn_support::test_util::executable(&binary, script).unwrap();
        let provider = CodexProvider::new(
            "codex".into(),
            CodexConfig {
                binary,
                home_path: Some(dir.clone()),
                goal_continuation_grace: grace,
                stop_confirm_timeout: Duration::from_secs(2),
                ..CodexConfig::default()
            },
        );
        let selection =
            || from_json(json!({"instanceId": "codex", "model": "gpt-6-luna"})).unwrap();
        let OpenedSession {
            session, events, ..
        } = provider
            .open_session(OpenSessionInput {
                thread_id: "t1".into(),
                provider_session_id: "s1".into(),
                model_selection: selection(),
                runtime_policy: policy(),
                resume_from_session: None,
                mcp_servers: vec![],
                host: None,
            })
            .await
            .unwrap();
        let thread = session
            .ensure_thread(EnsureThreadInput {
                thread_id: "t1".into(),
                title: None,
                model_selection: selection(),
                runtime_policy: policy(),
                existing_provider_thread: None,
            })
            .await
            .unwrap();
        Self {
            dir,
            session,
            events,
            thread,
        }
    }

    /// Events until the run's terminal, within 10 s.
    async fn until_terminal(&mut self) -> Vec<Value> {
        tokio::time::timeout(
            Duration::from_secs(10),
            crate::session::tests::until(&mut self.events, "turn.terminal"),
        )
        .await
        .expect("the run ended within 10 s")
    }

    /// The `thread/goal/*` and `turn/*` requests the session wrote, in order.
    fn requests(&self) -> Vec<Value> {
        wire(&self.dir.join("codex.stdin"))
    }

    async fn finish(self) {
        self.session.close().await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn wire(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|frame| {
            frame["method"]
                .as_str()
                .is_some_and(|m| m.starts_with("thread/goal/") || m.starts_with("turn/"))
        })
        .collect()
}

fn methods(frames: &[Value]) -> Vec<&str> {
    frames
        .iter()
        .filter_map(|frame| frame["method"].as_str())
        .collect()
}

fn terminals(events: &[Value]) -> Vec<(String, String)> {
    events
        .iter()
        .filter(|e| e["type"] == "turn.terminal")
        .map(|e| {
            (
                e["providerTurnId"].as_str().unwrap_or_default().to_owned(),
                e["status"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

fn goal_statuses(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .filter(|e| e["type"] == "provider_thread.updated")
        .map(|e| e["providerThread"]["goal"]["status"].clone())
        .collect()
}

fn turn_statuses(events: &[Value], provider_turn: &str) -> Vec<String> {
    events
        .iter()
        .filter(|e| {
            e["type"] == "provider_turn.updated" && e["providerTurn"]["id"] == provider_turn
        })
        .map(|e| {
            e["providerTurn"]["status"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

fn updated(status: &str, tokens: u64, turn: &str) -> String {
    format!(
        r#"{{"method":"thread/goal/updated","params":{{"threadId":"th1","turnId":{turn},"goal":{}}}}}"#,
        goal(status, tokens)
    )
}

fn turn_frame(method: &str, id: &str, status: &str) -> String {
    format!(
        r#"{{"method":"{method}","params":{{"threadId":"th1","turn":{{"id":"{id}","status":"{status}","startedAt":null,"completedAt":3}}}}}}"#
    )
}

/// `keeps a /goal run open across the turns Codex continues on its own`: the objective is set
/// paused, the first turn starts with T3's prompt, then the goal goes active. Codex's own
/// continuation joins the same run, and only its end settles the run.
#[tokio::test(flavor = "current_thread")]
async fn a_goal_run_stays_open_across_codexs_continuation() {
    let script = script(
        "null",
        &[
            updated("active", 0, "\"g1\""),
            turn_frame("turn/completed", "g1", "completed"),
            turn_frame("turn/started", "g2", "inProgress"),
            updated("complete", 1200, "\"g2\""),
            turn_frame("turn/completed", "g2", "completed"),
        ],
    );
    let mut fixture = Fixture::open("continue", &script, Duration::from_secs(5)).await;
    fixture
        .session
        .start_turn(turn(&fixture.thread, 1, &format!("/goal {OBJECTIVE}")))
        .await
        .unwrap();
    let events = fixture.until_terminal().await;

    let requests = fixture.requests();
    assert_eq!(
        methods(&requests),
        [
            "thread/goal/get",
            "thread/goal/set",
            "turn/start",
            "thread/goal/set"
        ]
    );
    assert_eq!(
        requests[1]["params"],
        json!({"threadId": "th1", "objective": OBJECTIVE, "status": "paused"})
    );
    assert_eq!(
        requests[2]["params"]["input"][0]["text"],
        format!(
            "This thread's goal is already set. Do not call create_goal. Start working on it now: {OBJECTIVE}"
        )
    );
    assert_eq!(
        requests[3]["params"],
        json!({"threadId": "th1", "status": "active"})
    );
    let g1 = ids::provider_turn_id(DRIVER, "g1");
    let g2 = ids::provider_turn_id(DRIVER, "g2");
    assert_eq!(terminals(&events), [(g2.clone(), "completed".to_owned())]);
    let running: Vec<(Value, Value, Value)> = events
        .iter()
        .filter(|e| {
            e["type"] == "provider_turn.updated" && e["providerTurn"]["status"] == "running"
        })
        .map(|e| {
            let t = &e["providerTurn"];
            (
                t["id"].clone(),
                t["runAttemptId"].clone(),
                t["ordinal"].clone(),
            )
        })
        .collect();
    assert_eq!(
        running,
        [
            (json!(g1), json!("a1"), json!(1)),
            (json!(g2), json!("a1"), json!(2))
        ]
    );
    assert_eq!(turn_statuses(&events, &g1), ["running", "completed"]);
    // Set paused until its first turn starts: only the result shows.
    let goals = goal_statuses(&events);
    assert!(!goals.contains(&json!("paused")), "{goals:?}");
    assert_eq!(goals.last(), Some(&json!("complete")));
    fixture.finish().await;
}

/// `seventh audit clears a native goal without starting a model turn`.
#[tokio::test(flavor = "current_thread")]
async fn clear_removes_a_paused_goal_without_a_model_turn() {
    let script = script(&goal("paused", 7), &[]);
    let mut fixture = Fixture::open("clear", &script, Duration::from_secs(5)).await;
    let mut thread = to_json(&fixture.thread);
    thread["goal"] = json!({"objective": OBJECTIVE, "status": "paused", "tokensUsed": 7,
        "tokenBudget": null, "timeUsedSeconds": 3});
    let thread: ProviderThread = from_json(thread).unwrap();
    fixture
        .session
        .start_turn(turn(&thread, 1, "/goal clear"))
        .await
        .unwrap();
    let events = fixture.until_terminal().await;

    assert_eq!(
        methods(&fixture.requests()),
        ["thread/goal/get", "thread/goal/clear"]
    );
    let command_turn = events
        .iter()
        .find(|e| e["type"] == "provider_turn.updated")
        .unwrap();
    assert_eq!(command_turn["providerTurn"]["nativeTurnRef"], Value::Null);
    assert_eq!(terminals(&events).len(), 1);
    assert_eq!(terminals(&events)[0].1, "completed");
    assert_eq!(goal_statuses(&events).last(), Some(&Value::Null));
    assert!(
        !events.iter().any(|e| e["type"] == "message.updated"),
        "a cleared goal replies through the goal row"
    );
    fixture.finish().await;
}

/// Plain chat still starts one ordinary turn with its own text.
#[tokio::test(flavor = "current_thread")]
async fn plain_chat_starts_one_ordinary_turn() {
    let mut fixture = Fixture::open("plain", &script("null", &[]), Duration::from_secs(5)).await;
    fixture
        .session
        .start_turn(turn(&fixture.thread, 1, "plain request"))
        .await
        .unwrap();
    let events = fixture.until_terminal().await;
    let requests = fixture.requests();
    assert_eq!(methods(&requests), ["turn/start"]);
    assert_eq!(requests[0]["params"]["input"][0]["text"], "plain request");
    assert_eq!(terminals(&events).len(), 1);
    fixture.finish().await;
}

/// `rejects an oversized /goal objective before any goal request`.
#[tokio::test(flavor = "current_thread")]
async fn an_oversized_objective_fails_before_any_goal_request() {
    let fixture = Fixture::open("oversized", &script("null", &[]), Duration::from_secs(5)).await;
    let error = fixture
        .session
        .start_turn(turn(
            &fixture.thread,
            1,
            &format!("/goal {}", "x".repeat(4001)),
        ))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("4001") && error.contains("4000"), "{error}");
    assert!(fixture.requests().is_empty());
    fixture.finish().await;
}

/// `pauses a goal Codex does not continue before its run settles`.
#[tokio::test(flavor = "current_thread")]
async fn a_goal_codex_does_not_continue_is_paused_before_the_run_settles() {
    let script = script(
        "null",
        &[
            updated("active", 10, "\"g1\""),
            turn_frame("turn/completed", "g1", "completed"),
            updated("active", 11, "null"),
        ],
    );
    let mut fixture = Fixture::open("expire", &script, Duration::from_millis(300)).await;
    fixture
        .session
        .start_turn(turn(&fixture.thread, 1, &format!("/goal {OBJECTIVE}")))
        .await
        .unwrap();
    let events = fixture.until_terminal().await;
    let requests = fixture.requests();
    assert_eq!(
        requests.last().unwrap()["params"],
        json!({"threadId": "th1", "status": "paused"})
    );
    assert_eq!(terminals(&events)[0].1, "completed");
    assert_eq!(goal_statuses(&events).last(), Some(&json!("paused")));
    fixture.finish().await;
}

/// `settles a run held for the next goal turn when Stop arrives in between`: no
/// `turn/interrupt`, the held turn completes and the run ends interrupted.
#[tokio::test(flavor = "current_thread")]
async fn stop_between_goal_turns_settles_the_held_run() {
    let script = script(
        "null",
        &[
            updated("active", 10, "\"g1\""),
            turn_frame("turn/completed", "g1", "completed"),
            updated("active", 11, "null"),
        ],
    );
    let mut fixture = Fixture::open("stop", &script, Duration::from_secs(30)).await;
    fixture
        .session
        .start_turn(turn(&fixture.thread, 1, &format!("/goal {OBJECTIVE}")))
        .await
        .unwrap();
    let g1 = ids::provider_turn_id(DRIVER, "g1");
    // The goal update after the turn ended shows; the held turn shows no end yet.
    let mut seen = Vec::new();
    while !seen.iter().any(|e: &Value| {
        e["type"] == "provider_thread.updated" && e["providerThread"]["goal"]["tokensUsed"] == 11
    }) {
        let event = tokio::time::timeout(Duration::from_secs(10), fixture.events.recv())
            .await
            .expect("the goal update within 10 s")
            .expect("events");
        seen.push(serde_json::to_value(event).unwrap());
    }
    assert_eq!(turn_statuses(&seen, &g1), ["running"]);
    assert!(terminals(&seen).is_empty());
    fixture
        .session
        .interrupt_turn(InterruptInput {
            provider_thread: fixture.thread.clone(),
            provider_turn_id: g1.as_str().into(),
        })
        .await
        .unwrap();
    seen.extend(fixture.until_terminal().await);
    assert!(!methods(&fixture.requests()).contains(&"turn/interrupt"));
    assert_eq!(turn_statuses(&seen, &g1), ["running", "completed"]);
    assert_eq!(terminals(&seen), [(g1, "interrupted".to_owned())]);
    fixture.finish().await;
}
