//! Short-lived ACP sessions for structured generation. The helper has no Conn tools.
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use conn_provider::{ProviderError, ProviderResult, TextGenerationRequest};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::{
    connection::{CallError, Connection, Incoming},
    ordered::{J, obj},
    session::{self, Spawner, StopKind},
};

fn failed(detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation: "generate_text",
        detail: detail.into(),
    }
}

pub(crate) struct Helper {
    pub cwd: String,
    pub spawner: Spawner,
    pub antigravity: Option<Antigravity>,
}

pub(crate) struct Antigravity {
    pub profile: PathBuf,
    pub auth_method: String,
    pub default_model: Option<String>,
}

struct Output {
    session: String,
    text: String,
    chars: usize,
    config_options: Option<Value>,
}

impl Helper {
    pub(crate) async fn generate(self, input: TextGenerationRequest) -> ProviderResult<Value> {
        let (mut reply, answer) = oneshot::channel();
        // The owner also cleans up when the caller abandons a title or Git operation.
        tokio::spawn(async move {
            let spawn = self.spawner.clone();
            let child = tokio::task::spawn_blocking(move || spawn()).await;
            let mut output = Output {
                session: String::new(),
                text: String::new(),
                chars: 0,
                config_options: None,
            };
            let mut result = match child {
                Ok(Ok(child)) => {
                    let (connection, mut incoming) =
                        Connection::start(child.writer, child.events, session::EVENT_CAPACITY);
                    let timeout = input
                        .timeout
                        .unwrap_or(Duration::from_secs(180))
                        .min(Duration::from_secs(180));
                    let result = tokio::select! {
                        () = reply.closed() => Err(failed("Text generation was cancelled.")),
                        result = tokio::time::timeout(timeout, self.run(&input, &connection, &mut incoming, &mut output)) =>
                            result.unwrap_or_else(|_| Err(failed("ACP text generation timed out."))),
                    };
                    drop(connection);
                    drop(incoming);
                    (child.stop)(StopKind::Kill).await;
                    result
                }
                _ => Err(failed("Could not start the text generation agent.")),
            };
            if let Some(antigravity) = self.antigravity {
                let clean = tokio::task::spawn_blocking(move || {
                    let cwd = Path::new(&self.cwd);
                    let clean = only_runtime_dirs(cwd, cwd);
                    crate::antigravity::remove_session_files(
                        &antigravity.profile,
                        &output.session,
                        &self.cwd,
                    );
                    let _ = std::fs::remove_dir_all(cwd);
                    clean
                })
                .await;
                if result.is_ok() && !matches!(clean, Ok(true)) {
                    result = Err(failed("Antigravity changed the text generation workspace."));
                }
            }
            let _ = reply.send(result);
        });
        answer
            .await
            .map_err(|_| failed("ACP text generation stopped."))?
    }

    async fn run(
        &self,
        input: &TextGenerationRequest,
        conn: &Connection,
        rx: &mut mpsc::Receiver<Incoming>,
        out: &mut Output,
    ) -> ProviderResult<Value> {
        let agy = self.antigravity.is_some();
        let (flavor, name, version) = if agy {
            let flavor = &crate::ANTIGRAVITY;
            let (name, version) = flavor
                .client_info
                .map_or_else(|| ("t3-code".into(), "0.0.0".into()), |info| info(None));
            (flavor, name, version)
        } else {
            (
                &crate::GROK,
                "t3-code-git-text".to_owned(),
                "0.0.0".to_owned(),
            )
        };
        let mut peer = Peer { conn, rx, agy };
        let init = peer
            .call(
                "initialize",
                session::initialize_params(flavor, &name, &version, agy),
                out,
            )
            .await?;
        if let Some(config) = &self.antigravity {
            let method = if init.get("info").is_some() {
                "auth/login"
            } else {
                "authenticate"
            };
            peer.call(method, J::V(json!({"methodId":config.auth_method})), out)
                .await?;
        }
        let params = obj()
            .with("cwd", self.cwd.clone())
            .with("mcpServers", J::Arr(vec![]))
            .with_opt(
                "_meta",
                agy.then(|| crate::antigravity::setup_meta(&init, false))
                    .flatten(),
            );
        let setup = peer.call("session/new", params, out).await?;
        if out.config_options.is_none() {
            out.config_options = setup.get("configOptions").cloned();
        }
        let id = setup["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| failed("Agent returned no text helper session ID."))?
            .to_owned();
        out.session.clone_from(&id);
        let model = input.model_selection.model.as_str().unwrap_or_default();
        if let Some(config) = &self.antigravity {
            if !crate::antigravity::is_native_session_id(&id) {
                return Err(failed(
                    "Antigravity returned an invalid text helper session ID.",
                ));
            }
            peer.call(
                "session/set_mode",
                J::V(json!({"sessionId":id,"modeId":"default"})),
                out,
            )
            .await?;
            if let Some((key, value)) =
                crate::antigravity::model_switch(&setup, model, config.default_model.as_deref())
                    .map_err(failed)?
            {
                let reply = peer
                    .call(
                        "session/set_config_option",
                        J::V(json!({"sessionId":id,"configId":key,"value":value})),
                        out,
                    )
                    .await?;
                if let Some(options) = reply.get("configOptions") {
                    out.config_options = Some(options.clone());
                }
            }
            let selection = serde_json::to_value(&input.model_selection)
                .map_err(|_| failed("Invalid model selection."))?;
            if let Some((key, value)) = out.config_options.as_ref().and_then(|options| {
                crate::antigravity::thinking_write(
                    options,
                    selection["options"].as_array()?.as_slice(),
                )
            }) {
                let params = obj()
                    .with("sessionId", id.clone())
                    .with("configId", key)
                    .with("value", value);
                peer.call_inner("session/set_config_option", params, out, true)
                    .await?;
            }
        } else {
            let selection = serde_json::to_value(&input.model_selection)
                .map_err(|_| failed("Invalid model selection."))?;
            let effort = crate::grok::selection_effort(&selection);
            if let Some((model_id, effort)) =
                crate::grok::model_switch(&setup, model, effort.as_deref())
            {
                let mut params = json!({"sessionId":id,"modelId":model_id});
                if let Some(effort) = &effort {
                    params["_meta"] = json!({"reasoningEffort":effort});
                }
                if let Err(error) = peer.call("session/set_model", J::V(params), out).await {
                    if effort.is_none() {
                        return Err(error);
                    }
                    if setup["models"]["currentModelId"] != model_id {
                        peer.call(
                            "session/set_model",
                            J::V(json!({"sessionId":id,"modelId":model_id})),
                            out,
                        )
                        .await?;
                    }
                }
            }
        }
        let prompt = if agy {
            format!(
                "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.\nReturn only the requested JSON object.\n\n{}",
                input.prompt
            )
        } else {
            input.prompt.clone()
        };
        let result = peer
            .call(
                "session/prompt",
                J::V(json!({"sessionId":id,"prompt":[{"type":"text","text":prompt}]})),
                out,
            )
            .await?;
        if agy && result["stopReason"] == "cancelled" {
            return Err(failed("Antigravity text generation was cancelled."));
        }
        let text = out.text.trim();
        let object = text
            .find('{')
            .and_then(|start| {
                serde_json::Deserializer::from_str(&text[start..])
                    .into_iter::<Value>()
                    .next()?
                    .ok()
            })
            .filter(Value::is_object);
        object.ok_or_else(|| failed("Agent returned invalid structured output."))
    }
}

struct Peer<'a> {
    conn: &'a Connection,
    rx: &'a mut mpsc::Receiver<Incoming>,
    agy: bool,
}
impl Peer<'_> {
    async fn call(
        &mut self,
        method: &str,
        params: J,
        output: &mut Output,
    ) -> ProviderResult<Value> {
        self.call_inner(method, params, output, false).await
    }

    async fn call_inner(
        &mut self,
        method: &str,
        params: J,
        output: &mut Output,
        skip_invalid_option: bool,
    ) -> ProviderResult<Value> {
        let id = self
            .conn
            .send(method, params)
            .await
            .ok_or_else(|| failed("Agent stopped during text generation."))?;
        while let Some(event) = self.rx.recv().await {
            match event {
                Incoming::Reply {
                    id: got,
                    result: Err(CallError::Rpc(error)),
                } if got == id && skip_invalid_option && error.code == -32602 => {
                    return Ok(Value::Null);
                }
                Incoming::Reply { id: got, result } if got == id => {
                    return result.map_err(|_| failed(format!("ACP {method} failed.")));
                }
                Incoming::Notification { method, params } if method == "session/update" => {
                    let update = &params["update"];
                    if params["sessionId"] == output.session
                        && update["sessionUpdate"] == "config_option_update"
                        && let Some(options) = update.get("configOptions")
                    {
                        output.config_options = Some(options.clone());
                    }
                    if self.agy
                        && matches!(
                            update["sessionUpdate"].as_str(),
                            Some("tool_call" | "tool_call_update")
                        )
                    {
                        return Err(failed(
                            "Antigravity attempted tool work during text generation.",
                        ));
                    }
                    if params["sessionId"] == output.session
                        && update["sessionUpdate"] == "agent_message_chunk"
                        && update["content"]["type"] == "text"
                        && let Some(text) = update["content"]["text"].as_str()
                    {
                        output.chars += text.encode_utf16().count();
                        if output.chars > 128_000 {
                            return Err(failed("Text generation exceeded the output limit."));
                        }
                        output.text.push_str(text);
                    }
                }
                Incoming::Request { id, method, .. } => {
                    if method == "session/request_permission" {
                        self.conn
                            .reply(&id, J::V(json!({"outcome":{"outcome":"cancelled"}})))
                            .await;
                    } else if method == "elicitation/create" {
                        self.conn.reply(&id, obj().with("action", "decline")).await;
                    } else {
                        self.conn
                            .reply_error(
                                &id,
                                -32601,
                                "Tools and user input are disabled for text generation.",
                            )
                            .await;
                    }
                    if self.agy {
                        return Err(failed("Antigravity requested a tool or user input."));
                    }
                }
                Incoming::Barrier(done) => {
                    let _ = done.send(());
                }
                Incoming::Closed { .. } => break,
                _ => {}
            }
        }
        Err(failed("Agent stopped during text generation."))
    }
}

pub(crate) fn profile_allows_generation(profile: &Path) -> bool {
    for (name, key) in [("hooks.json", "hooks"), ("mcp_config.json", "mcpServers")] {
        let path = profile.join("config").join(name);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() <= 64_000 => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            _ => return false,
        }
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return false,
        };
        if !file
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.len() <= 64_000)
        {
            return false;
        }
        let mut text = String::new();
        if !file
            .take(64_001)
            .read_to_string(&mut text)
            .is_ok_and(|len| len <= 64_000)
        {
            return false;
        }
        if text.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return false;
        };
        if !value
            .get(key)
            .unwrap_or(&value)
            .as_object()
            .is_some_and(|obj| obj.is_empty())
        {
            return false;
        }
    }
    true
}

fn only_runtime_dirs(root: &Path, dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.into_iter().all(|entry| {
        let Ok(entry) = entry else { return false };
        let path = entry.path();
        let relative = path.strip_prefix(root).ok().and_then(Path::to_str);
        matches!(
            relative,
            Some(".agents" | ".agents/skills" | ".gemini" | ".gemini/skills")
        ) && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && only_runtime_dirs(root, &path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_provider_support::{lines::Line, process::ProcEvent};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    fn request(driver: &str) -> TextGenerationRequest {
        TextGenerationRequest {
            operation: "generateThreadTitle".into(),
            cwd: ".".into(),
            project_cwd: None,
            prompt: "Return a title".into(),
            output_schema: "{}".into(),
            model_selection: serde_json::from_value(json!({"instanceId":driver,"model":"m"}))
                .unwrap(),
            timeout: Some(Duration::from_secs(2)),
            investigate: false,
            image_paths: vec![],
        }
    }

    async fn generation(agy: bool, tool: bool) -> ProviderResult<Value> {
        let root = std::env::temp_dir().join(format!("conn-text-test-{}", conn_support::uuid_v4()));
        let cwd = root.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let driver = if agy { "antigravity" } else { "grok" };
        let stopped = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (log, stop) = (calls.clone(), stopped.clone());
        let handle = tokio::runtime::Handle::current();
        let spawn: Spawner = Arc::new(move || {
            let (writer, mut frames) = mpsc::channel::<String>(16);
            let (stdout, events) = mpsc::channel(16);
            let log = log.clone();
            handle.spawn(async move {
                let id="4ea64c7c-323b-40c2-954f-000000000001";
                while let Some(frame)=frames.recv().await {
                    let frame:Value=serde_json::from_str(&frame).unwrap();
                    let Some(method)=frame["method"].as_str() else { continue };
                    log.lock().unwrap().push(method.to_owned());
                    let result=match method {
                        "initialize"=>json!({"protocolVersion":1,"agentInfo":{"version":"1.4.5"}}),
                        "session/new"=>{
                            assert_eq!(frame["params"]["mcpServers"],json!([]));
                            if agy {
                                assert_eq!(frame["params"]["_meta"]["antigravity"]["disabledTools"],json!(["run_workflow"]));
                                assert!(frame["params"]["_meta"]["antigravity"]["systemPrompt"].is_null());
                            }
                            json!({"sessionId":id,"models":{"currentModelId":"m"}})
                        }
                        "session/prompt"=>{
                            assert_eq!(frame["params"]["sessionId"],id);
                            let update=if tool {json!({"sessionUpdate":"tool_call","toolCallId":"fixture"})}
                                else {json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Answer: {\"title\":\"a } brace\"} and another {\"ignored\":true}"}})};
                            let message=json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":id,"update":update}});
                            if stdout.send(ProcEvent::Line(Line::Text(message.to_string()))).await.is_err(){break}
                            json!({"stopReason":"end_turn"})
                        }
                        _=>json!({}),
                    };
                    let reply=json!({"jsonrpc":"2.0","id":frame["id"],"result":result});
                    if stdout.send(ProcEvent::Line(Line::Text(reply.to_string()))).await.is_err() { break; }
                }
            });
            let stop = stop.clone();
            Ok(session::Spawned {
                writer,
                events,
                stop: Box::new(move |kind| {
                    Box::pin(async move {
                        assert_eq!(kind, StopKind::Kill);
                        stop.store(true, Ordering::SeqCst);
                    })
                }),
            })
        });
        let result = Helper {
            spawner: spawn,
            cwd: cwd.display().to_string(),
            antigravity: agy.then(|| Antigravity {
                profile: root.join("profile"),
                auth_method: "fixture".into(),
                default_model: None,
            }),
        }
        .generate(request(driver))
        .await;
        assert!(stopped.load(Ordering::SeqCst));
        assert_eq!(cwd.exists(), !agy);
        let methods = calls.lock().unwrap();
        assert!(methods.iter().any(|m| m == "session/prompt"), "{methods:?}");
        assert_eq!(methods.iter().any(|m| m == "authenticate"), agy);
        std::fs::remove_dir_all(root).unwrap();
        result
    }

    #[tokio::test]
    async fn both_native_agents_return_one_structured_object_and_close() {
        for agy in [false, true] {
            assert_eq!(
                generation(agy, false).await.unwrap(),
                json!({"title":"a } brace"})
            );
        }
        assert!(generation(true, true).await.is_err());
    }

    #[test]
    fn antigravity_requires_an_empty_profile_and_restores_only_runtime_directories() {
        let root =
            std::env::temp_dir().join(format!("conn-text-profile-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(root.join("config")).unwrap();
        assert!(profile_allows_generation(&root));
        for (file, field) in [("hooks.json", "hooks"), ("mcp_config.json", "mcpServers")] {
            let path = root.join("config").join(file);
            std::fs::write(&path, json!({field:{}}).to_string()).unwrap();
            assert!(profile_allows_generation(&root));
            std::fs::write(&path, json!({field:{"fixture":{}}}).to_string()).unwrap();
            assert!(!profile_allows_generation(&root));
            std::fs::remove_file(path).unwrap();
        }
        let work = root.join("work");
        std::fs::create_dir_all(work.join(".agents/skills")).unwrap();
        assert!(only_runtime_dirs(&work, &work));
        std::fs::write(work.join(".agents/skills/unexpected.txt"), "fixture").unwrap();
        assert!(!only_runtime_dirs(&work, &work));
        std::fs::remove_dir_all(root).unwrap();
    }
}
