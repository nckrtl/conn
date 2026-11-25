use super::*;

#[tokio::test]
async fn clearing_a_released_roster_preserves_the_selected_provider() {
    let db = TempDb::new("switch-with-background-roster");
    let (engine, _, _) = open_two(&db);
    dispatch(&engine, create("t1", "create")).await;
    dispatch(&engine, message("t1", "start", "background-task")).await;
    let first = run_to_end(&engine, "t1", "run:t1:1").await;
    let old_thread = &first["thread"]["activeProviderThreadId"];
    assert!(old_thread.is_string());
    assert_eq!(
        first["providerThreads"][0]["pendingBackgroundTasks"][0]["taskId"],
        "bg-1"
    );

    let mut events = engine
        .subscribe_thread(from_json(json!({"threadId":"t1"})).unwrap())
        .await
        .unwrap();
    next(&mut events).await;
    dispatch(&engine, model_selection_set("switch", "codex")).await;
    loop {
        let message = next(&mut events).await;
        let event = &message["event"];
        if event["type"] == "provider-thread.updated"
            && &event["payload"]["id"] == old_thread
            && event["payload"]["pendingBackgroundTasks"] == json!([])
        {
            break;
        }
    }
    let view = projection(&engine, "t1").await;
    assert_eq!(view["thread"]["providerInstanceId"], "codex");
    assert!(view["thread"]["activeProviderThreadId"].is_null());
    assert_eq!(
        view["providerThreads"][0]["pendingBackgroundTasks"],
        json!([])
    );
    // A client resuming at the historical roster also gets the current selection.
    let next_event = next(&mut events).await;
    assert_eq!(next_event["event"]["type"], "thread.metadata-updated");
    assert_eq!(next_event["event"]["payload"], view["thread"]);
    let shell = engine
        .inner()
        .db(|store| store.stored_shell("t1"))
        .await
        .unwrap()
        .unwrap();
    assert!(shell["activeProviderThreadId"].is_null());

    dispatch(&engine, message("t1", "next", "continue")).await;
    let second = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(
        second["runs"][1]["providerThreadId"],
        "provider-thread:codex:t1"
    );
}

#[tokio::test]
async fn idle_release_uses_the_opened_provider_capability_and_the_operator_override() {
    use crate::IdleTimeout::{After, Disabled, ProviderDefault};
    for (case, native, policy, threshold, pinned) in [
        ("native", true, ProviderDefault, 120, false),
        ("legacy", false, ProviderDefault, 1800, false),
        (
            "override",
            true,
            After(Duration::from_secs(300)),
            300,
            false,
        ),
        ("zero", true, Disabled, 86_400, false),
        ("pinned", true, ProviderDefault, 120, true),
    ] {
        let db = TempDb::new(&format!("provider-idle-{case}"));
        let clock = Arc::new(crate::ManualClock::at(1_800_000_000_000));
        let mut provider = FakeProvider::new("claudeAgent");
        if native {
            provider = provider.with_native_resume();
        }
        let provider = Arc::new(provider);
        let mut config = EngineConfig::new(db.path());
        config.projects = vec![ProjectConfig {
            title: "Project".into(),
            workspace_root: ROOT.into(),
        }];
        config.clock = clock.clone();
        config.providers = vec![provider.clone()];
        config.idle_session = policy;
        config.idle_max_hold = Duration::from_secs(600);
        let engine = SqliteEngine::open(config).unwrap();
        dispatch(&engine, create("t1", "create")).await;
        dispatch(
            &engine,
            message(
                "t1",
                "first",
                if pinned { "background-hold" } else { "first" },
            ),
        )
        .await;
        let projection = run_to_end(&engine, "t1", "run:t1:1").await;
        let native_thread = projection["providerThreads"][0]["nativeThreadRef"]["nativeId"].clone();
        assert!(native_thread.is_string());
        clock.advance(Duration::from_secs(threshold - 1));
        engine.release_idle_sessions().await;
        assert_eq!(engine.inner().live_count(), 1, "{case} before deadline");
        clock.advance(Duration::from_secs(1));
        engine.release_idle_sessions().await;
        if pinned {
            assert_eq!(engine.inner().live_count(), 1, "pinned at deadline");
            clock.advance(Duration::from_secs(600));
            engine.release_idle_sessions().await;
        }
        if policy == Disabled {
            assert_eq!(engine.inner().live_count(), 1, "zero disables idle cleanup");
        } else {
            assert_eq!(engine.inner().live_count(), 0, "{case}");
            dispatch(&engine, message("t1", "second", "second")).await;
            let projection = run_to_end(&engine, "t1", "run:t1:2").await;
            assert_eq!(projection["runs"][1]["status"], "completed");
            assert_eq!(
                projection["providerThreads"][0]["nativeThreadRef"]["nativeId"],
                native_thread
            );
            assert_eq!(
                provider.sessions.load(std::sync::atomic::Ordering::SeqCst),
                2
            );
            let resumed = crate::lock(&provider.resumes).clone();
            assert!(
                resumed.iter().any(|s| s
                    .split_once(' ')
                    .is_some_and(|(id, _)| Some(id) == native_thread.as_str())),
                "{resumed:?}"
            );
        }
    }
}

#[tokio::test]
async fn steer_forwards_the_message_selection_and_explicit_rename_reaches_the_live_session() {
    let db = TempDb::new("provider-steer-model-title");
    let fake = FakeProvider::new("codex").with_driver("codex");
    let controls = fake.native_controls.clone();
    let (engine, mut thread) = hanging_turn(&db, vec![fake], "codex").await;
    dispatch(
        &engine,
        json!({"type":"thread.metadata.update","commandId":"rename",
        "threadId":"t1","title":"Native name"}),
    )
    .await;
    let selection = json!({"instanceId":"codex","model":"m",
        "options":[{"id":"serviceTier","value":"fast"}]});
    let mut steer = message_with(
        "t1",
        "steer",
        "steer with fast",
        json!({"type":"steer_active","targetRunId":"run:t1:1"}),
        None,
    );
    steer["modelSelection"] = selection.clone();
    dispatch(&engine, steer).await;
    assert_eq!(until_run_status(&mut thread, "run:t1:1").await, "completed");
    assert_eq!(
        *crate::lock(&controls),
        [json!({"rename":"Native name"}), json!({"steer":selection})]
    );
}

#[tokio::test]
async fn grok_reopens_on_mode_changes_and_protects_existing_background_work() {
    let db = TempDb::new("provider-grok-warm-policy");
    let (engine, grok) = open_with(&db, FakeProvider::new("privateGrok").with_driver("grok"));
    let mut create = create("t1", "create");
    create["modelSelection"] = json!({"instanceId":"privateGrok","model":"grok"});
    dispatch(&engine, create).await;
    for (i, (mode, prompt, status)) in [
        ("full-access", "first", "completed"),
        ("approval-required", "second", "completed"),
        ("approval-required", "third", "completed"),
        ("full-access", "background-reported", "completed"),
        ("approval-required", "do not start", "failed"),
    ]
    .into_iter()
    .enumerate()
    {
        dispatch(
            &engine,
            json!({"type":"thread.runtime-mode.set","commandId":format!("mode{i}"),
            "threadId":"t1","runtimeMode":mode}),
        )
        .await;
        dispatch(&engine, message("t1", &format!("message{i}"), prompt)).await;
        let projection = run_to_end(&engine, "t1", &format!("run:t1:{}", i + 1)).await;
        assert_eq!(projection["runs"][i]["status"], status);
    }
    let modes: Vec<_> = crate::lock(&grok.opened_policies)
        .iter()
        .map(|p| p["runtimeMode"].clone())
        .collect();
    assert_eq!(modes, ["full-access", "approval-required", "full-access"]);
    assert!(
        engine
            .inner()
            .live_thread("t1")
            .unwrap()
            .has_background_work()
    );
    assert!(
        !crate::lock(&grok.calls)
            .iter()
            .any(|c| c == "start run:t1:5")
    );
    dispatch(
        &engine,
        json!({"type":"thread.stop","commandId":"stop","threadId":"t1"}),
    )
    .await;
    timeout(Duration::from_secs(3), async {
        while engine
            .inner()
            .live_thread("t1")
            .is_some_and(|live| live.has_background_work())
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Stop did not release the earlier native background task: {:?}",
            crate::lock(&grok.calls)
        )
    });
    dispatch(
        &engine,
        message("t1", "after-stop", "continue under approvals"),
    )
    .await;
    let projection = run_to_end(&engine, "t1", "run:t1:6").await;
    assert_eq!(projection["runs"][5]["status"], "completed");
    assert_eq!(
        crate::lock(&grok.opened_policies).last().unwrap()["runtimeMode"],
        "approval-required"
    );
}

#[tokio::test]
async fn fresh_codex_history_respects_the_stored_native_background_item_while_starting() {
    let db = TempDb::new("codex-durable-pending-recovery");
    let (engine, fake) = open_with(
        &db,
        FakeProvider::new("claudeAgent")
            .with_driver("codex")
            .with_history_injection(),
    );
    dispatch(&engine, create("t1", "create")).await;
    dispatch(&engine, message("t1", "first", "keep this context")).await;
    run_to_end(&engine, "t1", "run:t1:1").await;
    dispatch(&engine, message("t1", "bad", "reject-encrypted-history")).await;
    let rejected = run_to_end(&engine, "t1", "run:t1:2").await;
    assert_eq!(rejected["runs"][1]["status"], "failed");
    // A late native event was persisted before the recovery start; the current transport
    // has no live backlog signal. The run in 'starting' must not hide that saved work.
    let provider_thread = rejected["runs"][1]["providerThreadId"].clone();
    engine.inner().write(move |tx| {
        let now = tx.now().to_owned();
        tx.append(crate::store::Draft::new("t1","turn-item.updated",json!({
            "id":"background-from-old-native","threadId":"t1","runId":"run:t1:1","nodeId":null,
            "providerThreadId":provider_thread,"providerTurnId":"turn:run:t1:1","nativeItemRef":null,"parentItemId":null,"ordinal":111,
            "type":"command_execution","input":"still running","status":"running","title":null,"startedAt":now,"completedAt":null,"updatedAt":now
        })).payload_instance())?;
        Ok(())
    }).await.unwrap();
    assert!(
        !engine
            .inner()
            .live_thread("t1")
            .unwrap()
            .has_background_work()
    );
    dispatch(&engine, message("t1", "retry", "please continue")).await;
    let guarded = run_to_end(&engine, "t1", "run:t1:3").await;
    assert_eq!(guarded["runs"][2]["status"], "failed");
    assert!(crate::lock(&fake.injected).is_empty());
    assert_eq!(
        guarded["thread"]["activeProviderThreadId"],
        rejected["thread"]["activeProviderThreadId"]
    );
}
