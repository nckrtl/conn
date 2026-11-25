use super::*;

fn all_frames(fixture: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(fixture.dir.join("codex.stdin"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn workspace_mcp_and_delegated_start_receive_their_own_thread_identity() {
    let cases = r#"    *'"method":"config/read"'*) emit "{\"id\":$id,\"result\":{\"config\":{\"mcp_servers\":{\"local\":{\"command\":\"tool\"},\"web\":{\"url\":\"http://localhost\"},\"ignored.name\":{\"command\":\"tool\"}}}}}" ;;"#;
    let f = Fixture::open(
        "workspace-mcp",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    let other = f.second_session().await;
    other
        .ensure_thread(EnsureThreadInput {
            thread_id: "thread:delegated-task:abc".into(),
            title: None,
            model_selection: selection(),
            runtime_policy: policy(),
            existing_provider_thread: None,
        })
        .await
        .unwrap();
    let frames = all_frames(&f);
    let starts: Vec<_> = frames
        .iter()
        .filter(|v| v["method"] == "thread/start")
        .collect();
    for (start, id) in starts.iter().zip(["t1", "thread:delegated-task:abc"]) {
        let config = &start["params"]["config"];
        assert_eq!(config["mcp_servers.local.env.T3CODE_THREAD_ID"], id);
        assert!(config.get("mcp_servers.web.env.T3CODE_THREAD_ID").is_none());
        assert!(
            config
                .get("mcp_servers.ignored.name.env.T3CODE_THREAD_ID")
                .is_none()
        );
    }
    assert!(starts[0]["params"].get("threadSource").is_none());
    assert_eq!(starts[1]["params"]["threadSource"], "subagent");
    other.close().await;
    f.finish().await;
}

#[tokio::test]
async fn explicit_compaction_restores_context_after_completion_with_its_original_role() {
    let cases = r#"    *'"method":"thread/compact/start"'*)
      emit "{\"id\":$id,\"result\":{}}"
      emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"compact"}}}'
      emit '{"method":"item/completed","params":{"threadId":"th1","turnId":"compact","item":{"id":"cc","type":"contextCompaction"}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"compact","status":"completed"}}}' ;;
    *'"method":"thread/inject_items"'*) emit "{\"id\":$id,\"result\":{}}" ;;"#;
    let mut f = Fixture::open(
        "native-compact",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    let mut first = turn(&f.thread, 1, "hello");
    first.app_context = vec![conn_provider::AppContextEntry {
        key: "note".into(),
        text: "external text".into(),
    }];
    f.session.start_turn(first).await.unwrap();
    f.until_terminal().await;
    f.session
        .start_turn(turn(&f.thread, 2, "/compact"))
        .await
        .unwrap();
    f.until_terminal().await;
    let frames = all_frames(&f);
    assert_eq!(
        frames
            .iter()
            .filter(|f| f["method"] == "turn/start")
            .count(),
        1
    );
    let restored = frames
        .iter()
        .find(|f| f["method"] == "thread/inject_items")
        .unwrap();
    let item = &restored["params"]["items"][0];
    assert_eq!(item["role"], "user");
    assert_eq!(
        item["content"][0]["text"],
        "<external_note>external text</external_note>"
    );
    f.finish().await;
}

#[tokio::test]
async fn capacity_continues_one_run_without_repeating_the_user_message() {
    let cases = r#"    *'"method":"turn/start"'*'"input":[]'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"retry\"}}}"
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"retry","status":"completed"}}}' ;;
    *'"method":"turn/start"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"first\"}}}"
      emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"first"}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"first","status":"failed","error":{"message":"at capacity","codexErrorInfo":"serverOverloaded"}}}}' ;;"#;
    let mut f = Fixture::open(
        "overload",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    f.session
        .start_turn(turn(&f.thread, 1, "once"))
        .await
        .unwrap();
    let events = f.until_terminal().await;
    let ends: Vec<_> = events
        .iter()
        .filter(|v| v["type"] == "turn.terminal")
        .collect();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0]["status"], "completed");
    let frames = all_frames(&f);
    let starts: Vec<_> = frames
        .iter()
        .filter(|f| f["method"] == "turn/start")
        .collect();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0]["params"]["input"][0]["text"], "once");
    assert_eq!(starts[1]["params"]["input"], json!([]));
    assert_eq!(
        starts[1]["params"]["threadId"],
        starts[0]["params"]["threadId"]
    );
    f.finish().await;
}

#[tokio::test]
async fn failing_turn_uses_all_exhausted_account_windows() {
    let cases = r#"    *'"method":"turn/start"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"limited\"}}}"
      emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"limited"}}}'
      emit '{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":100,"resetsAt":2000000000},"secondary":{"usedPercent":100,"resetsAt":2000000999}}}}'
      emit '{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"other","primary":{"usedPercent":100,"resetsAt":2222222222}}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"limited","status":"failed","error":{"message":"limit","codexErrorInfo":"usageLimitExceeded"}}}}' ;;"#;
    let mut f = Fixture::open(
        "limit-reset",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    f.session
        .start_turn(turn(&f.thread, 1, "hello"))
        .await
        .unwrap();
    let events = f.until_terminal().await;
    let end = events
        .iter()
        .find(|v| v["type"] == "turn.terminal")
        .unwrap();
    assert_eq!(
        end["failure"]["resetAt"],
        conn_provider_support::ids::iso_from_ms(2_000_000_999_000)
    );
    f.finish().await;
}

#[tokio::test]
async fn stop_confirms_retained_processes_without_ending_the_completed_run_twice() {
    let cases = r#"    *'"method":"turn/start"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"command\"}}}"
      emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"command"}}}'
      emit '{"method":"item/started","params":{"threadId":"th1","turnId":"command","item":{"type":"commandExecution","id":"cmd","command":"echo test","processId":"42","status":"inProgress"}}}'
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"command","status":"completed"}}}' ;;
    *'"method":"thread/backgroundTerminals/list"'*) emit "{\"id\":$id,\"result\":{\"data\":[{\"processId\":\"42\"}],\"nextCursor\":null}}" ;;
    *'"method":"thread/backgroundTerminals/terminate"'*) emit "{\"id\":$id,\"result\":{\"terminated\":true}}" ;;"#;
    let mut f = Fixture::open(
        "idle-stop",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    let input = turn(&f.thread, 1, "hello");
    f.session.start_turn(input).await.unwrap();
    let events = f.until_terminal().await;
    let end = events
        .iter()
        .find(|v| v["type"] == "turn.terminal")
        .unwrap();
    assert_eq!(end["status"], "completed");
    f.session
        .stop_background_work(InterruptInput {
            provider_thread: f.thread.clone(),
            provider_turn_id: from_json(end["providerTurnId"].clone()).unwrap(),
        })
        .await
        .unwrap();
    let mut tail = Vec::new();
    while let Ok(event) = f.events.try_recv() {
        tail.push(serde_json::to_value(event).unwrap());
    }
    assert!(
        tail.iter()
            .any(|e| e["turnItem"]["status"] == "interrupted")
    );
    assert!(!tail.iter().any(|e| e["type"] == "turn.terminal"));
    let frames = all_frames(&f);
    assert!(
        frames
            .iter()
            .any(|v| v["method"] == "thread/backgroundTerminals/terminate"
                && v["params"]["processId"] == "42")
    );
    f.finish().await;
}

#[tokio::test]
async fn mcp_oauth_validates_the_thread_callback_and_waits_for_native_success() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let script = r#"    *'"method":"mcpServerStatus/list"'*)
      if test -e "$0.connected"; then state=connected; else state=needsAuth; fi
      emit "{\"id\":$id,\"result\":{\"data\":[{\"name\":\"calendar\",\"runtimeStatus\":\"$state\",\"tools\":{}}]}}" ;;
    *'"method":"mcpServer/oauth/login"'*)
      emit "{\"id\":$id,\"result\":{\"authorizationUrl\":\"https://provider.test/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3APORT%2Fcallback&state=state1\"}}"
      while test ! -e "$0.connected"; do sleep 0.02; done
      emit '{"method":"mcpServer/oauthLogin/completed","params":{"name":"calendar","success":true}}' ;;"#.replace("PORT",&port.to_string());
    let f = Fixture::open(
        "mcp-signin",
        &script_with("null", &[], &script),
        Duration::from_secs(1),
    )
    .await;
    let url = f
        .session
        .start_mcp_sign_in(f.thread.clone(), "calendar".into())
        .await
        .unwrap()
        .unwrap();
    assert!(url.starts_with("https://provider.test/"));
    let wrong = format!("http://127.0.0.1:{port}/callback?code=c&state=wrong");
    assert!(
        f.session
            .complete_mcp_sign_in(f.thread.clone(), "calendar".into(), wrong)
            .await
            .is_err()
    );
    let marker = f.dir.join("codex.connected");
    let handle = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = [0; 512];
        let n = socket.read(&mut data).await.unwrap();
        assert!(
            std::str::from_utf8(&data[..n])
                .unwrap()
                .starts_with("GET /callback?code=c&state=state1 HTTP/1.1")
        );
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        std::fs::write(marker, "").unwrap();
    });
    let callback = format!("http://127.0.0.1:{port}/callback?code=c&state=state1");
    f.session
        .complete_mcp_sign_in(f.thread.clone(), "calendar".into(), callback)
        .await
        .unwrap();
    handle.await.unwrap();
    assert!(
        f.session
            .start_mcp_sign_in(f.thread.clone(), "calendar".into())
            .await
            .unwrap()
            .is_none()
    );
    let frames = all_frames(&f);
    let login = frames
        .iter()
        .find(|v| v["method"] == "mcpServer/oauth/login")
        .unwrap();
    assert_eq!(login["params"], json!({"name":"calendar","threadId":"th1"}));
    f.finish().await;
}

#[tokio::test]
async fn closing_resume_waits_for_thread_closed_and_interrupts_an_unowned_goal() {
    let cases = r#"    *'"method":"thread/resume"'*)
      if test ! -e "$0.retry"; then
        touch "$0.retry"
        emit "{\"id\":$id,\"error\":{\"code\":-32600,\"message\":\"thread th1 is closing\"}}"
        emit '{"method":"thread/closed","params":{"threadId":"th1"}}'
      else
        emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th1\",\"updatedAt\":2}}}"
        emit '{"method":"thread/goal/updated","params":{"threadId":"th1","goal":{"threadId":"th1","objective":"keep working","status":"active","tokensUsed":0,"timeUsedSeconds":1,"createdAt":1,"updatedAt":2}}}'
        emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"orphan","status":"inProgress"}}}'
      fi ;;"#;
    let f = Fixture::open(
        "closing-goal",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    let fresh = f.second_session().await;
    fresh
        .resume_thread(conn_provider::ResumeThreadInput {
            provider_thread: f.thread.clone(),
            thread_id: Some("t1".into()),
            model_selection: Some(selection()),
            runtime_policy: Some(policy()),
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frames = all_frames(&f);
            if frames
                .iter()
                .any(|v| v["method"] == "turn/interrupt" && v["params"]["turnId"] == "orphan")
            {
                assert_eq!(
                    frames
                        .iter()
                        .filter(|v| v["method"] == "thread/resume")
                        .count(),
                    2
                );
                assert!(
                    frames
                        .iter()
                        .any(|v| v["method"] == "thread/goal/set"
                            && v["params"]["status"] == "paused")
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    fresh.close().await;
    f.finish().await;
}

#[tokio::test]
async fn live_steer_updates_tier_and_thread_name_only_after_codex_accepts_it() {
    use conn_provider::SteerInput;
    let cases = r#"    *'"method":"turn/start"'*) emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"steer\"}}}" ;;
    *'"method":"thread/settings/update"'*|*'"method":"turn/steer"'*) emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"thread/name/set"'*'Changed'*)
      if test ! -e "$0.renamed"; then touch "$0.renamed"; emit "{\"id\":$id,\"error\":{\"code\":-32601,\"message\":\"failed\"}}"; else emit "{\"id\":$id,\"result\":{}}"; fi ;;"#;
    let f = Fixture::open(
        "tier-and-title",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    let input = turn(&f.thread, 1, "hello");
    f.session.start_turn(input.clone()).await.unwrap();
    for _ in 0..3 {
        f.session.rename_thread("Changed".into()).await.unwrap();
    }
    let selected = from_json(json!({"instanceId":"codex","model":"m","options":[{"id":"serviceTier","value":"priority"}]})).unwrap();
    f.session
        .steer_turn(SteerInput {
            thread_id: input.thread_id,
            run_id: input.run_id,
            provider_thread: f.thread.clone(),
            provider_turn_id: ids::provider_turn_id("codex", "steer").into(),
            message: input.message,
            model_selection: Some(selected),
            app_context: vec![],
        })
        .await
        .unwrap();
    let frames = all_frames(&f);
    let settings = frames
        .iter()
        .position(|v| v["method"] == "thread/settings/update")
        .unwrap();
    assert_eq!(frames[settings]["params"]["serviceTier"], "priority");
    assert_eq!(frames[settings + 1]["method"], "turn/steer");
    assert_eq!(
        frames
            .iter()
            .filter(|v| v["method"] == "thread/name/set" && v["params"]["name"] == "Changed")
            .count(),
        2
    );
    f.finish().await;
}

#[tokio::test]
async fn a_turn_sends_standard_only_for_catalog_models_that_offer_the_program() {
    let mut f = Fixture::open("standard", &script("null", &[]), Duration::from_secs(1)).await;
    crate::lock(&f.provider.status)["models"] = json!([{"slug":"eligible","capabilities":{"optionDescriptors":[{"id":"cyberAccessProgram","type":"select"}]}}]);
    for (n, model) in [(1, "eligible"), (2, "unsupported")] {
        let mut input = turn(&f.thread, n, "hello");
        input.model_selection = from_json(json!({"instanceId":"codex","model":model,"options":[{"id":"cyberAccessProgram","value":"standard"}]})).unwrap();
        // The simple fixture reuses its native turn id: inspect the request before closing.
        f.session.start_turn(input).await.unwrap();
        if n == 1 {
            f.until_terminal().await;
        }
    }
    let frames = all_frames(&f);
    let params: Vec<_> = frames
        .iter()
        .filter(|v| v["method"] == "turn/start")
        .map(|v| &v["params"])
        .collect();
    assert_eq!(params[0]["cyberAccessProgram"], "standard");
    assert!(params[1].get("cyberAccessProgram").is_none());
    f.finish().await;
}

#[tokio::test]
async fn an_unbroken_stream_flushes_before_its_final_item() {
    let cases = r#"    *'"method":"turn/start"'*)
      emit "{\"id\":$id,\"result\":{\"turn\":{\"id\":\"stream\"}}}"
      emit '{"method":"turn/started","params":{"threadId":"th1","turn":{"id":"stream"}}}'
      while test ! -e "$0.flushed"; do
        emit '{"method":"item/agentMessage/delta","params":{"threadId":"th1","turnId":"stream","itemId":"answer","delta":"hello "}}'
        sleep 0.005
      done
      emit '{"method":"turn/completed","params":{"threadId":"th1","turn":{"id":"stream","status":"completed"}}}' ;;"#;
    let mut f = Fixture::open(
        "stream-flush",
        &script_with("null", &[], cases),
        Duration::from_secs(1),
    )
    .await;
    f.session
        .start_turn(turn(&f.thread, 1, "hello"))
        .await
        .unwrap();
    let events = tokio::time::timeout(
        Duration::from_secs(2),
        crate::session::tests::until(&mut f.events, "turn_item.updated"),
    )
    .await
    .unwrap();
    assert!(events.iter().any(|v| {
        v["turnItem"]["text"]
            .as_str()
            .is_some_and(|s| s.contains("hello"))
    }));
    std::fs::write(f.dir.join("codex.flushed"), "").unwrap();
    f.until_terminal().await;
    f.finish().await;
}
