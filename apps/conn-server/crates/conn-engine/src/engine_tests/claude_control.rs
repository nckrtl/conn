//! Native Claude controls through the engine's public dispatch and session entry points.
use super::*;
use crate::store::Draft;

async fn hang(engine: &SqliteEngine) {
    dispatch(engine, create("t1", "create")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    dispatch(engine, message("t1", "hang", "hang")).await;
    until_provider_turn(&mut thread).await;
}

#[tokio::test(flavor = "current_thread")]
async fn claude_goal_stop_observes_current_delegated_work() {
    let db = TempDb::new("claude-goal-stop");
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: ROOT.into(),
    }];
    config.providers = vec![provider.clone()];
    config.host = Some(Arc::new(RecordingHost::default()));
    let engine = SqliteEngine::open(config).unwrap();
    hang(&engine).await;
    let check = crate::lock(&provider.goal_stop_check)
        .clone()
        .expect("the parent registered a goal Stop hook");
    assert!(!check().await, "no delegated work");
    dispatch(&engine, delegate("child-hangs", "hang", Some("always"))).await;
    assert!(check().await, "this active task can wake the parent");
    engine
        .inner()
        .write(|tx| {
            let mut run = tx.entity("t1", "runs", "run:t1:1")?.unwrap();
            run["delegatedCompletion"] =
                json!({"disposition":"disposed", "nextGeneration":1,"delivery":null});
            tx.append(Draft::new("t1", "run.updated", run))?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        !check().await,
        "a parent that disposed its delegated completion stops waiting"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn claude_child_wake_steers_only_when_the_parent_keeps_its_tools() {
    for interrupts in [true, false] {
        let db = TempDb::new(&format!("claude-child-wake-{interrupts}"));
        let (engine, _) = open(&db);
        hang(&engine).await;
        engine
            .inner()
            .write(move |tx| {
                let mut session = tx
                    .entities("t1", "providerSessions")?
                    .into_iter()
                    .next()
                    .unwrap();
                session["capabilities"]["turns"]["activeSteeringInterruptsTools"] =
                    json!(interrupts);
                tx.append(Draft::new("t1", "provider-session.updated", session))?;
                Ok(())
            })
            .await
            .unwrap();
        dispatch(
            &engine,
            delegate("child-finishes", "child answer", Some("always")),
        )
        .await;
        let child = "thread:delegated-task:child-finishes";
        run_to_end(&engine, child, &format!("run:{child}:1")).await;
        if !interrupts {
            let parent = run_to_end(&engine, "t1", "run:t1:1").await;
            assert_eq!(
                parent["runs"].as_array().unwrap().len(),
                1,
                "the same parent turn receives the result"
            );
            assert!(
                parent["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["text"]
                        .as_str()
                        .is_some_and(|t| t.starts_with("steered:") && t.contains("child answer"))),
                "{parent}"
            );
        } else {
            let parent = projection(&engine, "t1").await;
            assert_eq!(run_of(&parent, "run:t1:1")["status"], "running");
            assert_eq!(run_of(&parent, "run:t1:2")["status"], "queued");
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn claude_native_subagent_stop_reaches_only_its_owning_session() {
    let db = TempDb::new("claude-native-child-stop");
    let (engine, provider) = open(&db);
    let _thread = hanging_run_with_subagents(&engine).await;
    let command = |id, command| {
        from_json(json!({"type":"subagent.stop","commandId":command,"threadId":"t1","runId":"run:t1:1","subagentId":id})).unwrap()
    };
    assert!(
        engine
            .dispatch(command("node:native", "weak"))
            .await
            .is_err(),
        "a child without a strong native id cannot be stopped"
    );
    engine
        .inner()
        .write(|tx| {
            for (id, task) in [("node:native", "wf1"), ("node:other", "not-on-roster")] {
                let mut row = tx.entity("t1", "subagents", id)?.unwrap();
                row["nativeTaskRef"] =
                    json!({"driver":"claudeAgent","strength":"strong","nativeId":task});
                tx.append(Draft::new("t1", "subagent.updated", row))?;
            }
            Ok(())
        })
        .await
        .unwrap();
    engine
        .dispatch(command("node:native", "own"))
        .await
        .unwrap();
    assert_eq!(
        settled_statuses(&db, "provider-subagent.stop").await,
        ["succeeded"]
    );
    engine
        .dispatch(command("node:other", "unowned"))
        .await
        .unwrap();
    assert_eq!(
        settled_statuses(&db, "provider-subagent.stop").await,
        ["succeeded", "failed"]
    );
    assert_eq!(
        row_status(&engine, "t1", "runs", "run:t1:1").await,
        "running"
    );
    assert_eq!(
        row_status(&engine, "t1", "subagents", "node:other").await,
        "running"
    );
    assert_eq!(
        calls(&provider)
            .iter()
            .filter(|line| line.starts_with("stop workflow"))
            .collect::<Vec<_>>(),
        ["stop workflow wf1"]
    );
}
