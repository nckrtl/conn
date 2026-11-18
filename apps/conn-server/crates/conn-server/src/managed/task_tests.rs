//! The task worker grant on a real managed ingress (item 6): the allowlist, the atomic owner
//! check at dispatch, exactly one accept, no replay, exact cancellation and own-run
//! interrupts. The lab, the fake Gateway and the socket helpers are item 4's (`tests.rs`).

use std::time::Duration;

use serde_json::{Value, json};

use super::super::tests::{Lab, connect, next, send};
use crate::managed::task::GRANT_FIELD;

const NODE_B: u64 = 102;
const THREAD: &str = "task-thread-1";

fn project_id() -> String {
    conn_engine::SqliteEngine::project_id_for("/tmp/p")
}

fn sha(text: &str) -> String {
    conn_support::hex::hex(&conn_support::hmac::sha256(text.as_bytes()))
}

fn create_body() -> Value {
    json!({
        "projectId": project_id(), "title": "Implement", "runtimeMode": "full-access",
        "interactionMode": "default",
        "modelSelection": {"instanceId": "claudeAgent", "model": "m"},
    })
}

fn grant(message_id: &str, text: &str, create: bool) -> Value {
    json!({
        "purpose": "task_worker", "task_id": 5873, "copy_id": 3709, "turn_id": format!("turn-{message_id}"),
        "project_id": project_id(), "thread_id": THREAD,
        "create": if create { json!({"command_id": "cmd-create", "body": create_body()}) } else { Value::Null },
        "message": {"command_id": format!("cmd-{message_id}"), "message_id": message_id, "text_sha256": sha(text)},
        "earlier": [], "questions": [],
    })
}

fn worker_token(lab: &Lab, grant: Value) -> String {
    let mut extra = serde_json::Map::new();
    extra.insert(GRANT_FIELD.into(), grant);
    lab.fake.issue_with(
        NODE_B,
        vec!["orchestration:read".into(), "orchestration:operate".into()],
        extra,
    )
}

fn create_command() -> Value {
    let mut command = json!({
        "type": "thread.create", "commandId": "cmd-create", "threadId": THREAD,
        "branch": null, "worktreePath": null, "createdBy": "user", "creationSource": "web",
    });
    for (key, value) in create_body().as_object().unwrap() {
        command[key] = value.clone();
    }
    command
}

fn dispatch_command(command_id: &str, message_id: &str, text: &str) -> Value {
    json!({
        "type": "message.dispatch", "commandId": command_id, "threadId": THREAD,
        "messageId": message_id, "text": text, "attachments": [],
        "createdBy": "user", "creationSource": "web",
        "dispatchMode": {"type": "start_immediately"},
    })
}

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// One unary call; returns `Ok(value)` or `Err(failure)`.
async fn call(socket: &mut Socket, id: u32, tag: &str, payload: Value) -> Result<Value, Value> {
    send(
        socket,
        json!({"_tag": "Request", "id": id.to_string(), "tag": tag, "payload": payload, "headers": []}),
    )
    .await;
    loop {
        let frame = next(socket).await.expect("socket open");
        if frame["_tag"] == "Exit" && frame["requestId"].as_str() == Some(id.to_string().as_str()) {
            let exit = &frame["exit"];
            return if exit["_tag"] == "Success" {
                Ok(exit["value"].clone())
            } else {
                Err(exit.clone())
            };
        }
    }
}

async fn projection(socket: &mut Socket, id: u32) -> Value {
    call(
        socket,
        id,
        "orchestration.getThreadProjection",
        json!({"threadId": THREAD}),
    )
    .await
    .expect("projection")
}

fn runs(projection: &Value) -> Vec<Value> {
    projection["runs"].as_array().cloned().unwrap_or_default()
}

fn user_messages(projection: &Value) -> Vec<Value> {
    projection["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "user")
        .cloned()
        .collect()
}

/// Waits until the thread's run of `message_id` has `status`.
async fn until_run(socket: &mut Socket, message_id: &str, status: &str) -> Value {
    for id in 1000.. {
        let p = projection(socket, id).await;
        if let Some(run) = runs(&p)
            .into_iter()
            .find(|r| r["userMessageId"] == message_id && r["status"] == status)
        {
            return run;
        }
        assert!(id < 1400, "run of {message_id} never reached {status}: {p}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    unreachable!()
}

async fn worker(lab: &Lab, grant: Value) -> Socket {
    connect(lab.v6, "", Some(&worker_token(lab, grant)))
        .await
        .expect("worker admitted")
}

/// A person's message on the thread, sent past the managed ingress (as Conn would).
async fn person_sends(lab: &Lab, message_id: &str, text: &str) {
    let engine = lab.app.engine.clone().unwrap();
    let command = dispatch_command(&format!("person-{message_id}"), message_id, text);
    engine
        .dispatch(conn_contract::from_json(command).unwrap())
        .await
        .expect("the person's send");
}

#[tokio::test(flavor = "current_thread")]
async fn a_worker_creates_and_dispatches_its_turn_once_and_a_replay_adds_nothing() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    call(&mut w, 1, "orchestration.dispatchCommand", create_command())
        .await
        .expect("create");
    let empty = projection(&mut w, 2).await;
    assert!(runs(&empty).is_empty() && user_messages(&empty).is_empty());
    let dispatch = dispatch_command("cmd-m1", "m1", "do it");
    call(&mut w, 3, "orchestration.dispatchCommand", dispatch.clone())
        .await
        .expect("dispatch");
    until_run(&mut w, "m1", "completed").await;
    // The reply was lost; the worker must never replay, and a replay is refused anyway.
    let replay = call(&mut w, 4, "orchestration.dispatchCommand", dispatch).await;
    assert!(replay.is_err(), "a replayed command is not accepted twice");
    let create_again = call(&mut w, 5, "orchestration.dispatchCommand", create_command()).await;
    assert!(create_again.is_err());
    let p = projection(&mut w, 6).await;
    assert_eq!(user_messages(&p).len(), 1, "{p}");
    assert_eq!(runs(&p).len(), 1, "{p}");
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_sends_to_one_thread_give_exactly_one_accept() {
    let lab = Lab::start().await;
    let mut w1 = worker(&lab, grant("m1", "do it", true)).await;
    let mut w2 = worker(&lab, grant("m1", "do it", true)).await;
    call(
        &mut w1,
        1,
        "orchestration.dispatchCommand",
        create_command(),
    )
    .await
    .expect("create");
    let dispatch = dispatch_command("cmd-m1", "m1", "do it");
    let (a, b) = tokio::join!(
        call(
            &mut w1,
            2,
            "orchestration.dispatchCommand",
            dispatch.clone()
        ),
        call(&mut w2, 2, "orchestration.dispatchCommand", dispatch),
    );
    assert_eq!(
        [a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(),
        1,
        "exactly one accept: {a:?} {b:?}"
    );
    until_run(&mut w1, "m1", "completed").await;
    let p = projection(&mut w1, 3).await;
    assert_eq!((user_messages(&p).len(), runs(&p).len()), (1, 1), "{p}");
}

#[tokio::test(flavor = "current_thread")]
async fn a_persons_active_run_refuses_the_workers_dispatch_and_nothing_is_queued() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    call(&mut w, 1, "orchestration.dispatchCommand", create_command())
        .await
        .expect("create");
    // A person writes between create and the first message; the run is still active.
    person_sends(&lab, "p1", "hang").await;
    until_run(&mut w, "p1", "running").await;
    let refused = call(
        &mut w,
        2,
        "orchestration.dispatchCommand",
        dispatch_command("cmd-m1", "m1", "do it"),
    )
    .await;
    assert!(refused.is_err(), "the owner check refuses: {refused:?}");
    let p = projection(&mut w, 3).await;
    assert_eq!(runs(&p).len(), 1, "nothing queued or steered: {p}");
    assert!(user_messages(&p).iter().all(|m| m["id"] != "m1"));
    // The worker cannot stop the person's run either.
    let run_id = runs(&p)[0]["id"].clone();
    let stop = call(
        &mut w,
        4,
        "orchestration.dispatchCommand",
        json!({"type": "run.interrupt", "commandId": "cmd-stop", "threadId": THREAD, "runId": run_id}),
    )
    .await;
    assert!(stop.is_err(), "{stop:?}");
    until_run(&mut w, "p1", "running").await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_wrong_task_grant_is_refused_and_changes_nothing() {
    let lab = Lab::start().await;
    let mut admitted = worker(&lab, grant("m1", "do it", true)).await;
    call(
        &mut admitted,
        1,
        "orchestration.dispatchCommand",
        create_command(),
    )
    .await
    .expect("create");
    // A grant for another thread and message.
    let mut other = grant("m9", "other", true);
    other["thread_id"] = json!("another-thread");
    let mut w = worker(&lab, other).await;
    let tries = [
        (
            "orchestration.dispatchCommand",
            dispatch_command("cmd-m1", "m1", "do it"),
        ),
        (
            "orchestration.dispatchCommand",
            dispatch_command("cmd-m9", "m9", "other"),
        ),
        (
            "orchestration.getThreadProjection",
            json!({"threadId": THREAD}),
        ),
        (
            "orchestration.dispatchCommand",
            json!({"type": "thread.stop", "commandId": "s", "threadId": THREAD}),
        ),
    ];
    for (n, (tag, payload)) in tries.into_iter().enumerate() {
        let id = u32::try_from(n).unwrap() + 10;
        assert!(
            call(&mut w, id, tag, payload).await.is_err(),
            "{tag} was allowed"
        );
    }
    // A method outside the allowlist is not served at all.
    let other_method = call(&mut w, 20, "orchestration.launchThread", json!({})).await;
    assert!(
        other_method
            .unwrap_err()
            .to_string()
            .contains("ConnServerNotSupported")
    );
    // A changed body or text is refused even with the admitted IDs.
    let changed = call(
        &mut admitted,
        21,
        "orchestration.dispatchCommand",
        dispatch_command("cmd-m1", "m1", "do something else"),
    )
    .await;
    assert!(changed.is_err());
    let p = projection(&mut admitted, 22).await;
    assert!(runs(&p).is_empty() && user_messages(&p).is_empty(), "{p}");
    // A grant with an extra field, or other scopes, is no worker token.
    let mut loose = grant("m1", "do it", true);
    loose["admin"] = json!(true);
    let token = worker_token(&lab, loose);
    assert_eq!(connect(lab.v6, "", Some(&token)).await.err(), Some(403));
    let mut extra = serde_json::Map::new();
    extra.insert(GRANT_FIELD.into(), grant("m1", "do it", true));
    let wide = lab.fake.issue_with(
        NODE_B,
        vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
            "terminal:operate".into(),
        ],
        extra,
    );
    assert_eq!(connect(lab.v6, "", Some(&wide)).await.err(), Some(403));
    // A worker cannot read through the reader routes.
    let token = worker_token(&lab, grant("m1", "do it", true));
    let status =
        super::super::tests::http(lab.v6, "GET", "/api/orchestration/shell", Some(&token), "")
            .await;
    assert_eq!(status, 403);
}

#[tokio::test(flavor = "current_thread")]
async fn only_the_stored_question_of_its_owner_run_is_cancelled_then_the_answer_runs() {
    let lab = Lab::start().await;
    // Turn 1 asks a question; Orbit stores it and stops the run (question ends the turn).
    let mut w1 = worker(&lab, grant("m1", "question", true)).await;
    call(
        &mut w1,
        1,
        "orchestration.dispatchCommand",
        create_command(),
    )
    .await
    .expect("create");
    call(
        &mut w1,
        2,
        "orchestration.dispatchCommand",
        dispatch_command("cmd-m1", "m1", "question"),
    )
    .await
    .expect("dispatch");
    let run = until_run(&mut w1, "m1", "running").await;
    let run_id = run["id"].as_str().unwrap().to_owned();
    let request_id = format!("question:{run_id}");
    for id in 100.. {
        let p = projection(&mut w1, id).await;
        if p["runtimeRequests"].as_array().is_some_and(|r| {
            r.iter()
                .any(|r| r["id"] == request_id.as_str() && r["status"] == "pending")
        }) {
            break;
        }
        assert!(id < 500, "the question never came: {p}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // The answer turn's grant names the stored request and its owner run.
    let mut answer = grant("m2", "the answer", false);
    answer["earlier"] = json!([{"thread_id": THREAD, "message_id": "m1"}]);
    answer["questions"] =
        json!([{"thread_id": THREAD, "request_id": request_id, "owner_run_id": run_id}]);
    let mut w2 = worker(&lab, answer.clone()).await;
    let cancel = |request: &str, decision: Value| {
        json!({"type": "runtime-request.respond", "commandId": format!("cancel-{request}-{decision}"),
               "threadId": THREAD, "requestId": request, "decision": decision})
    };
    // Not a stored request, or not a cancel: refused.
    assert!(
        call(
            &mut w2,
            1,
            "orchestration.dispatchCommand",
            cancel("question:other", json!("cancel"))
        )
        .await
        .is_err()
    );
    assert!(
        call(
            &mut w2,
            2,
            "orchestration.dispatchCommand",
            cancel(&request_id, json!("accept"))
        )
        .await
        .is_err()
    );
    // A grant whose stored owner is another run: refused by the target's owner check.
    let mut wrong_owner = answer.clone();
    wrong_owner["questions"][0]["owner_run_id"] = json!("run:other:1");
    let mut w3 = worker(&lab, wrong_owner).await;
    assert!(
        call(
            &mut w3,
            1,
            "orchestration.dispatchCommand",
            cancel(&request_id, json!("cancel"))
        )
        .await
        .is_err()
    );
    // The answer cannot start while the earlier run is still active.
    assert!(
        call(
            &mut w2,
            3,
            "orchestration.dispatchCommand",
            dispatch_command("cmd-m2", "m2", "the answer")
        )
        .await
        .is_err()
    );
    // The exact cancel succeeds, once.
    call(
        &mut w2,
        4,
        "orchestration.dispatchCommand",
        cancel(&request_id, json!("cancel")),
    )
    .await
    .expect("cancel");
    let p = projection(&mut w2, 5).await;
    let request = p["runtimeRequests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == request_id.as_str())
        .unwrap()
        .clone();
    assert_ne!(request["status"], "pending", "{request}");
    until_run(&mut w2, "m1", "completed").await;
    // Then the answer goes out as a fresh run of its own.
    call(
        &mut w2,
        6,
        "orchestration.dispatchCommand",
        dispatch_command("cmd-m2", "m2", "the answer"),
    )
    .await
    .expect("answer");
    until_run(&mut w2, "m2", "completed").await;
    let p = projection(&mut w2, 7).await;
    assert_eq!(runs(&p).len(), 2, "{p}");
}

#[tokio::test(flavor = "current_thread")]
async fn a_worker_stops_only_the_run_of_its_own_message() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "hang", true)).await;
    call(&mut w, 1, "orchestration.dispatchCommand", create_command())
        .await
        .expect("create");
    call(
        &mut w,
        2,
        "orchestration.dispatchCommand",
        dispatch_command("cmd-m1", "m1", "hang"),
    )
    .await
    .expect("dispatch");
    let own = until_run(&mut w, "m1", "running").await;
    let stop = json!({"type": "run.interrupt", "commandId": "cmd-stop", "threadId": THREAD, "runId": own["id"]});
    let mut held = stop.clone();
    held["commandId"] = json!("cmd-stop-held");
    held["holdQueue"] = json!(true);
    assert!(
        call(&mut w, 3, "orchestration.dispatchCommand", held)
            .await
            .is_err(),
        "never holds the queue"
    );
    call(&mut w, 4, "orchestration.dispatchCommand", stop)
        .await
        .expect("own run stops");
    until_run(&mut w, "m1", "interrupted").await;
}

/// The worker inherits item 4's fence: removing its Node edge ends its session.
#[tokio::test(flavor = "current_thread")]
async fn removing_the_workers_edge_ends_its_session() {
    let lab = Lab::start().await;
    let mut w = worker(&lab, grant("m1", "do it", true)).await;
    call(&mut w, 1, "orchestration.dispatchCommand", create_command())
        .await
        .expect("create");
    let notice = lab.fake.remove_edge(12);
    lab.deliver(&notice);
    let ended = tokio::time::timeout(Duration::from_secs(2), async {
        while next(&mut w).await.is_some() {}
    })
    .await;
    assert!(ended.is_ok(), "the worker's socket stayed open");
}
