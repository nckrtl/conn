use super::*;
use conn_provider::ProviderEvent;

fn command_row(row: &Value, status: &str, output: &str, native_exit: Option<i64>) -> ProviderEvent {
    let mut item = row.clone();
    item["status"] = json!(status);
    item["output"] = json!(output);
    if status != "running" {
        item["completedAt"] = item["updatedAt"].clone();
    }
    let turn_item = from_json(item).unwrap();
    match native_exit {
        Some(exit_code) => ProviderEvent::GrokCommandFailed {
            turn_item,
            exit_code,
        },
        None => ProviderEvent::TurnItemUpdated { turn_item },
    }
}

async fn wait_for_item<E: serde::Serialize>(
    stream: &mut Subscription<conn_contract::ThreadStreamItem, E>,
    id: &str,
    status: &str,
) -> Value {
    loop {
        let update = next(stream).await;
        let event = &update["event"];
        if event["type"] == "turn-item.updated"
            && event["payload"]["id"] == id
            && event["payload"]["status"] == status
        {
            return event.clone();
        }
    }
}

async fn exercise_owner_stream(
    tx: &tokio::sync::mpsc::Sender<ProviderEvent>,
    stream: &mut Subscription<
        conn_contract::ThreadStreamItem,
        conn_contract::GetThreadProjectionError,
    >,
    original: &Value,
    id: &str,
) {
    let mut row = original.clone();
    row["id"] = json!(id);
    row["nativeItemRef"]["nativeId"] = json!(id);
    tx.send(command_row(&row, "completed", "", None))
        .await
        .unwrap();
    tx.send(command_row(&row, "failed", "native stderr", Some(1)))
        .await
        .unwrap();
    let result = wait_for_item(stream, id, "failed").await;
    assert_eq!(result["payload"]["runId"], original["runId"]);
    assert_eq!(result["payload"]["output"], "native stderr");
}

#[tokio::test]
async fn native_grok_exit_corrects_its_original_command_while_the_next_run_is_active() {
    let db = TempDb::new("grok-inherited-command-correction");
    let fake = FakeProvider::new("private-grok").with_driver("grok");
    let handle = fake.last_events.clone();
    let (engine, mut stream) = hanging_turn(&db, vec![fake], "private-grok").await;
    let tx = crate::lock(&handle).as_ref().unwrap().upgrade().unwrap();
    let provider_thread = provider_thread_of_t1(&engine).await;
    let row = json!({"id":"original-tool","threadId":"t1","runId":"run:t1:1","nodeId":null,
        "providerThreadId":provider_thread,"providerTurnId":"turn:run:t1:1","nativeItemRef":{"driver":"grok","nativeId":"call-shell","strength":"strong"},"parentItemId":null,"ordinal":8,
        "type":"command_execution","input":"dev-server","status":"running","title":null,"startedAt":"2026-01-01T00:00:00Z","completedAt":null,"updatedAt":"2026-01-01T00:00:01Z"});
    tx.send(command_row(&row, "running", "", None))
        .await
        .unwrap();
    wait_for_item(&mut stream, "original-tool", "running").await;
    exercise_owner_stream(&tx, &mut stream, &row, "during-original").await;
    tx.send(
        from_json(
            json!({"type":"turn.terminal","providerThreadId":provider_thread,
        "providerTurnId":"turn:run:t1:1","runOrdinal":1,"status":"completed","threadDisposition":"reusable","childTurnsContinue":true}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    run_to_end(&engine, "t1", "run:t1:1").await;
    exercise_owner_stream(&tx, &mut stream, &row, "while-idle").await;
    dispatch(&engine, message("t1", "next", "hang")).await;
    loop {
        let event = next(&mut stream).await;
        if event["event"]["type"] == "provider-turn.updated"
            && event["event"]["payload"]["id"] == "turn:run:t1:2"
            && event["event"]["payload"]["status"] == "running"
        {
            break;
        }
    }
    tx.send(command_row(&row, "completed", "", None))
        .await
        .unwrap();
    wait_for_item(&mut stream, "original-tool", "completed").await;

    // A terminal poll is not evidence of a native exit. Only the original tool/turn qualifies.
    tx.send(command_row(&row, "failed", "generic poll", None))
        .await
        .unwrap();
    for (key, value) in [
        ("providerTurnId", json!("another-turn")),
        (
            "nativeItemRef",
            json!({"driver":"grok","nativeId":"unrelated-call","strength":"strong"}),
        ),
    ] {
        let mut wrong = row.clone();
        wrong[key] = value;
        tx.send(command_row(&wrong, "failed", "wrong owner", Some(1)))
            .await
            .unwrap();
    }
    tx.send(command_row(&row, "failed", "EADDRINUSE\n", Some(1)))
        .await
        .unwrap();
    let accepted = wait_for_item(&mut stream, "original-tool", "failed").await;
    assert_eq!(accepted["payload"]["output"], "EADDRINUSE\n");
    assert_eq!(accepted["payload"]["exitCode"], 1);
    assert_eq!(accepted["runId"], "run:t1:1");
    tx.send(command_row(&row, "failed", "EADDRINUSE\n", Some(1)))
        .await
        .unwrap();
    tx.send(command_row(&row, "running", "stale ACK", None))
        .await
        .unwrap();
    tx.send(command_row(&row, "completed", "", None))
        .await
        .unwrap();
    let full_output = "EADDRINUSE\nbind failed on 127.0.0.1\n";
    tx.send(command_row(&row, "failed", full_output, Some(1)))
        .await
        .unwrap();
    let enriched = wait_for_item(&mut stream, "original-tool", "failed").await;
    assert_eq!(enriched["payload"]["output"], full_output);
    // A delayed copy of the first correction cannot discard the added diagnostic.
    tx.send(command_row(&row, "failed", "EADDRINUSE\n", Some(1)))
        .await
        .unwrap();
    tx.send(command_row(&row, "failed", "unrelated error", Some(2)))
        .await
        .unwrap();
    let mut current = row.clone();
    current["id"] = json!("barrier");
    current["runId"] = json!("run:t1:2");
    current["providerTurnId"] = json!("turn:run:t1:2");
    tx.send(command_row(&current, "running", "", None))
        .await
        .unwrap();
    wait_for_item(&mut stream, "barrier", "running").await;
    let projection = engine.get_thread_projection("t1".into()).await.unwrap();
    let stored = projection["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "original-tool")
        .unwrap();
    assert_eq!(stored, &enriched["payload"]);
    assert_eq!(projection["runs"][1]["status"], "running");
    let history = engine
        .inner()
        .db(|store| store.stored_events_after(0, 256))
        .await
        .unwrap();
    let statuses: Vec<_> = history
        .iter()
        .map(|r| &r["event"])
        .filter(|e| e["type"] == "turn-item.updated" && e["payload"]["id"] == "original-tool")
        .map(|e| e["payload"]["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["running", "completed", "failed", "failed"]);
}
