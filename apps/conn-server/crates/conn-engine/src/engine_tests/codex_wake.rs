use super::*;

/// Replay the three companion rows that the Codex adapter emits for one native child.
/// Only the app thread and spawning run change from the upstream recording.
#[tokio::test]
async fn a_codex_child_finishes_on_its_spawning_run_during_a_second_wake() {
    let db = TempDb::new("codex-child-envelope");
    let (engine, provider) = open_with(&db, FakeProvider::new("codex").with_driver("codex"));
    let mut thread = create("t1", "create");
    thread["modelSelection"] = json!({"instanceId":"codex","model":"m"});
    dispatch(&engine, thread).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    dispatch(&engine, message("t1", "spawn", "hang")).await;
    until_provider_turn(&mut stream).await;
    let tx = crate::lock(&provider.last_events)
        .as_ref()
        .unwrap()
        .upgrade()
        .unwrap();
    let provider_thread = provider_thread_of_t1(&engine).await;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../conn-provider-codex/testdata/ts/subagent_v2.json"
    ))
    .unwrap();
    let rows = fixture["events"].as_array().unwrap();
    let source = "run:t1:1";
    let child = rows
        .iter()
        .find(|event| event["type"] == "subagent.updated")
        .unwrap()["subagent"]["id"]
        .clone();
    for status in ["running", "completed"] {
        for (event_type, key) in [
            ("node.updated", "node"),
            ("subagent.updated", "subagent"),
            ("turn_item.updated", "turnItem"),
        ] {
            let mut frame = rows
                .iter()
                .find(|e| {
                    e["type"] == event_type
                        && e[key]["status"] == status
                        && (e[key]["id"] == child || e[key]["subagentId"] == child)
                })
                .unwrap()
                .clone();
            let row = &mut frame[key];
            row["threadId"] = json!("t1");
            row["runId"] = json!(source);
            for key in ["rootNodeId", "parentNodeId"] {
                if row.get(key).is_some() {
                    row[key] = json!("node:run:t1:1:root");
                }
            }
            tx.send(from_json(frame).unwrap()).await.unwrap();
        }
        if status == "running" {
            tx.send(
                from_json(
                    json!({"type":"turn.terminal","providerThreadId":provider_thread,
                "providerTurnId":"turn:run:t1:1","runOrdinal":1,"status":"completed",
                "threadDisposition":"reusable","childTurnsContinue":true}),
                )
                .unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(until_run_status(&mut stream, source).await, "completed");
            for (ordinal, text) in [(2, "first wake"), (3, "hang")] {
                tx.send(from_json(json!({"type":"continuation.requested","threadId":"t1","providerThreadId":provider_thread,
                    "detail":text,"delivery":"message_text","notification":{"source":{"kind":"subagent"},"outcome":"completed","summary":text}})).unwrap()).await.unwrap();
                until_provider_turn(&mut stream).await;
                if ordinal == 2 {
                    assert_eq!(until_run_status(&mut stream, "run:t1:2").await, "completed");
                }
            }
        }
    }
    // Wait until all three events have passed through the pump and committed to SQLite.
    loop {
        let ev = next(&mut stream).await;
        if ev["event"]["type"] == "turn-item.updated"
            && ev["event"]["payload"]["subagentId"] == child
            && ev["event"]["payload"]["status"] == "completed"
        {
            break;
        }
    }
    let stored = engine
        .inner()
        .db(|store| store.thread_events_after("t1", 0, 10_000))
        .await
        .unwrap();
    for kind in ["node.updated", "subagent.updated", "turn-item.updated"] {
        let events: Vec<_> = stored
            .iter()
            .map(|(_, e)| e)
            .filter(|e| {
                e["type"] == kind
                    && (e["payload"]["id"] == child || e["payload"]["subagentId"] == child)
                    && e["payload"]["status"] == "completed"
            })
            .collect();
        assert_eq!(events.len(), 1, "{kind}");
        assert_eq!(events[0]["runId"], source, "{kind}");
        assert_eq!(events[0]["nodeId"], child, "{kind}");
        assert_eq!(events[0]["payload"]["runId"], source);
    }
    let p = projection(&engine, "t1").await;
    assert_eq!(
        p["runs"][2]["status"], "running",
        "the second wake still owns its own turn"
    );
}
