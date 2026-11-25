//! Short-lived ACP sessions for structured generation. The helper has no Conn tools.
use std::{path::{Path, PathBuf}, time::Duration};

use conn_provider::{ProviderError, ProviderResult, TextGenerationRequest};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::{connection::{Connection, Incoming}, ordered::J, session::{self, Spawner, StopKind}};

fn failed(detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed { operation: "generate_text", detail: detail.into() }
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
}

impl Helper {
    pub(crate) async fn generate(self, input: TextGenerationRequest) -> ProviderResult<Value> {
        let (mut reply, answer) = oneshot::channel();
        // The owner also cleans up when the caller abandons a title or Git operation.
        tokio::spawn(async move {
            let spawn = self.spawner.clone();
            let child = tokio::task::spawn_blocking(move || spawn()).await;
            let mut output = Output { session: String::new(), text: String::new(), chars: 0 };
            let mut result = match child {
                Ok(Ok(child)) => {
                    let (connection, mut incoming) = Connection::start(child.writer, child.events, session::EVENT_CAPACITY);
                    let timeout = input.timeout.unwrap_or(Duration::from_secs(180));
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
                    crate::antigravity::remove_session_files(&antigravity.profile, &output.session, &self.cwd);
                    let _ = std::fs::remove_dir_all(cwd);
                    clean
                }).await;
                if result.is_ok() && !matches!(clean, Ok(true)) {
                    result = Err(failed("Antigravity changed the text generation workspace."));
                }
            }
            let _ = reply.send(result);
        });
        answer.await.map_err(|_| failed("ACP text generation stopped."))?
    }

    async fn run(&self, input: &TextGenerationRequest, conn: &Connection, rx: &mut mpsc::Receiver<Incoming>, out: &mut Output) -> ProviderResult<Value> {
        let agy = self.antigravity.is_some();
        let (flavor, name, version) = if agy {
            let flavor = &crate::ANTIGRAVITY;
            let (name, version) = flavor.client_info.map_or_else(|| ("t3-code".into(), "0.0.0".into()), |info| info(None));
            (flavor, name, version)
        } else { (&crate::GROK, "t3-code-git-text".to_owned(), "0.0.0".to_owned()) };
        let mut peer = Peer { conn, rx, agy };
        let init = peer.call("initialize", session::initialize_params(flavor, &name, &version, agy), out).await?;
        if let Some(config) = &self.antigravity {
            let method = if init.get("info").is_some() { "auth/login" } else { "authenticate" };
            peer.call(method, J::V(json!({"methodId":config.auth_method})), out).await?;
        }
        let setup = peer.call("session/new", J::V(json!({"cwd":self.cwd,"mcpServers":[]})), out).await?;
        let id = setup["sessionId"].as_str().filter(|id| !id.is_empty()).ok_or_else(|| failed("Agent returned no text helper session ID."))?.to_owned();
        out.session.clone_from(&id);
        let model = input.model_selection.model.as_str().unwrap_or_default();
        if let Some(config) = &self.antigravity {
            if !crate::antigravity::is_native_session_id(&id) { return Err(failed("Antigravity returned an invalid text helper session ID.")); }
            peer.call("session/set_mode", J::V(json!({"sessionId":id,"modeId":"default"})), out).await?;
            if let Some((key,value)) = crate::antigravity::model_switch(&setup, model, config.default_model.as_deref()).map_err(failed)? {
                peer.call("session/set_config_option", J::V(json!({"sessionId":id,"configId":key,"value":value})),out).await?;
            }
        } else {
            let selection = serde_json::to_value(&input.model_selection).map_err(|_|failed("Invalid model selection."))?;
            let effort = crate::grok::selection_effort(&selection);
            if let Some((model_id, effort)) = crate::grok::model_switch(&setup,model,effort.as_deref()) {
                let mut params=json!({"sessionId":id,"modelId":model_id});
                if let Some(effort) = &effort { params["_meta"] = json!({"reasoningEffort":effort}); }
                if let Err(error) = peer.call("session/set_model",J::V(params),out).await {
                    if effort.is_none() { return Err(error); }
                    if setup["models"]["currentModelId"] != model_id {
                        peer.call("session/set_model",J::V(json!({"sessionId":id,"modelId":model_id})),out).await?;
                    }
                }
            }
        }
        let prompt = if agy { format!("Use only the input below. Do not use tools, read or write files, run commands, or ask questions.\nReturn only the requested JSON object.\n\n{}",input.prompt) } else { input.prompt.clone() };
        let result = peer.call("session/prompt",J::V(json!({"sessionId":id,"prompt":[{"type":"text","text":prompt}]})),out).await?;
        if agy && result["stopReason"] == "cancelled" { return Err(failed("Antigravity text generation was cancelled.")); }
        let text=out.text.trim();
        let object=text.find('{').zip(text.rfind('}')).and_then(|(a,b)| text.get(a..=b))
            .and_then(|s|serde_json::from_str::<Value>(s).ok()).filter(Value::is_object);
        object.ok_or_else(|| failed("Agent returned invalid structured output."))
    }
}

struct Peer<'a> { conn: &'a Connection, rx: &'a mut mpsc::Receiver<Incoming>, agy: bool }
impl Peer<'_> {
    async fn call(&mut self, method:&str, params:J, output:&mut Output) -> ProviderResult<Value> {
        let id = self.conn.send(method,params).await.ok_or_else(|| failed("Agent stopped during text generation."))?;
        while let Some(event)=self.rx.recv().await {
            match event {
                Incoming::Reply { id: got, result } if got == id => return result.map_err(|_| failed(format!("ACP {method} failed."))),
                Incoming::Notification { method, params } if method == "session/update" => {
                    let update=&params["update"];
                    if self.agy && matches!(update["sessionUpdate"].as_str(),Some("tool_call" | "tool_call_update")) { return Err(failed("Antigravity attempted tool work during text generation.")); }
                    if params["sessionId"] == output.session && update["sessionUpdate"] == "agent_message_chunk" && update["content"]["type"] == "text"
                        && let Some(text) = update["content"]["text"].as_str() {
                        output.chars += text.encode_utf16().count();
                        if output.chars > 128_000 { return Err(failed("Text generation exceeded the output limit.")); }
                        output.text.push_str(text);
                    }
                }
                Incoming::Request { id, method, .. } => {
                    if method == "session/request_permission" {
                        self.conn.reply(&id,J::V(json!({"outcome":{"outcome":"cancelled"}}))).await;
                    } else {
                        self.conn.reply_error(&id,-32601,"Tools and user input are disabled for text generation.").await;
                    }
                    if self.agy { return Err(failed("Antigravity requested a tool or user input.")); }
                }
                Incoming::Barrier(done) => { let _ = done.send(()); }
                Incoming::Closed { .. } => break,
                _ => {}
            }
        }
        Err(failed("Agent stopped during text generation."))
    }
}

pub(crate) fn profile_allows_generation(profile: &Path) -> bool {
    for (name,key) in [("hooks.json","hooks"),("mcp_config.json","mcpServers")] {
        let path=profile.join("config").join(name);
        let meta=match std::fs::metadata(&path) {
            Ok(m) => m, Err(e) if e.kind()==std::io::ErrorKind::NotFound => continue, Err(_) => return false
        };
        if !meta.is_file() || meta.len()>64_000 { return false; }
        let Ok(text)=std::fs::read_to_string(&path) else {return false};
        if text.trim().is_empty() { continue; }
        let Ok(value)=serde_json::from_str::<Value>(&text) else {return false};
        if !value.get(key).unwrap_or(&value).as_object().is_some_and(|obj|obj.is_empty()) { return false; }
    }
    true
}

fn only_runtime_dirs(root:&Path, dir:&Path)->bool {
    let Ok(entries)=std::fs::read_dir(dir) else {return false};
    entries.into_iter().all(|entry| {
        let Ok(entry)=entry else {return false};
        let path=entry.path();
        let relative=path.strip_prefix(root).ok().and_then(Path::to_str);
        matches!(relative,Some(".agents" | ".agents/skills" | ".gemini" | ".gemini/skills")) && entry.file_type().is_ok_and(|kind|kind.is_dir()) && only_runtime_dirs(root,&path)
    })
}
