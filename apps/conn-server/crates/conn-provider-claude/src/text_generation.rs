//! Text generation through the `claude` CLI, as `ClaudeTextGeneration.ts` (`runClaudeJson`)
//! runs it: no SDK and no SDK host, one short CLI run per request.
//!
//! `claude -p --output-format json --json-schema <schema> --model <api model> [--effort <e>]
//! --settings <json> --tools "" --disable-slash-commands --no-session-persistence
//! [--strict-mcp-config] --permission-mode dontAsk`, the prompt on stdin, in a fresh
//! temporary folder for a thread title (else the request's folder), 180 s. A CLI before 2.0.63
//! rejects `--no-session-persistence`; then the run is repeated without it. The answer is the
//! `structured_output` of the JSON envelope (or of the last `result` message of a list).
//! An investigating request (a review guide) gets read-only tools in place of `--tools ""`
//! (`--tools`, `--allowedTools`, `--disallowedTools`, `--setting-sources ""`) and its own
//! deadline; `probe-conformance` compares its argv with T3's.
//!
//! The environment is the Claude process environment (`mergeClaudeProcessEnvironment`, then
//! `makeClaudeEnvironment`). An image title uses a stream-json user message and falls back to text when the CLI rejects it.

use std::time::Duration;

use conn_provider::{ProviderError, TextGenerationRequest};
use conn_provider_support::probe::{CommandError, run_collect};
use serde_json::{Map, Value, json};

use crate::catalog;

/// `CLAUDE_TIMEOUT_MS`.
pub const TIMEOUT: Duration = Duration::from_secs(180);
/// `CLAUDE_INVESTIGATION_TOOLS`: the tools a review guide run may load.
pub const INVESTIGATION_TOOLS: &str = "Read,Grep,Glob,Bash";
/// `CLAUDE_INVESTIGATION_ALLOWED`: in `dontAsk` mode every call outside this list, Bash
/// included, is refused.
pub const INVESTIGATION_ALLOWED: &str =
    "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*)";
/// `CLAUDE_INVESTIGATION_DENIED`: denies win over allows; git's `--output`/`-o` could write
/// anywhere.
pub const INVESTIGATION_DENIED: &str = "Bash(git * --output*),Bash(git * -o *)";
const NO_SESSION_PERSISTENCE: &str = "--no-session-persistence";
/// What a Claude Code before 2.0.63 writes on stderr for that flag.
const NO_SESSION_PERSISTENCE_REJECTED: &str = "error: unknown option '--no-session-persistence'";

fn failed(detail: impl Into<String>) -> ProviderError {
    ProviderError::Failed {
        operation: "generate_text",
        detail: detail.into(),
    }
}

/// A boolean option's chosen value (`getModelSelectionBooleanOptionValue`).
fn chosen_bool(selection: &Value, id: &str) -> Option<bool> {
    selection["options"]
        .as_array()?
        .iter()
        .find(|o| o["id"] == id)?
        .get("value")?
        .as_bool()
}

/// The model, by slug or alias, in `models` (the picker's).
fn model_entry<'a>(models: &'a [Value], model: &str) -> Option<&'a Value> {
    let model = model.trim();
    models.iter().find(|m| m["slug"] == model).or_else(|| {
        models.iter().find(|m| {
            m["aliases"].as_array().is_some_and(|aliases| {
                aliases
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|a| a.eq_ignore_ascii_case(model))
            })
        })
    })
}

/// The CLI's arguments for one request (`runClaudeJson`), compiled against the instance's
/// current catalog (`manifest`, else the bundled one), as T3 resolves its `modelCatalog`.
pub fn cli_args(
    selection: &Value,
    manifest: &conn_provider::LiveManifest,
    output_schema: &str,
    no_session_persistence: bool,
    managed_mcp_config: bool,
    investigate: bool,
) -> Vec<String> {
    cli_args_scoped(
        selection,
        &crate::ClaudeConfig {
            model_manifest: manifest.clone(),
            ..Default::default()
        },
        output_schema,
        no_session_persistence,
        managed_mcp_config,
        investigate,
    )
}

fn cli_args_scoped(
    selection: &Value,
    config: &crate::ClaudeConfig,
    output_schema: &str,
    no_session_persistence: bool,
    managed_mcp_config: bool,
    investigate: bool,
) -> Vec<String> {
    let model = selection["model"].as_str().unwrap_or_default();
    let compiled = config
        .custom_models
        .compile(selection, &config.model_manifest);
    let now = i64::try_from(conn_support::time::now_ms()).unwrap_or(i64::MAX);
    let models = config.custom_models.scope(catalog::current_provider_models(
        &config.model_manifest,
        now,
    ));
    let capabilities = model_entry(&models, model).map(|m| &m["capabilities"]);
    let has_boolean = |id: &str| {
        capabilities
            .and_then(|c| c["optionDescriptors"].as_array())
            .is_some_and(|d| d.iter().any(|d| d["id"] == id && d["type"] == "boolean"))
    };
    // T3 reads Ultracode and Fast Mode from the resolved descriptors, thinking from the choice.
    let resolved =
        |id: &str| capabilities.and_then(|c| catalog::resolved_boolean(c, selection, id));
    // Only chosen values; Claude Code's own defaults apply otherwise, as in chat turns.
    let mut settings = Map::new();
    settings.insert("disableAllHooks".into(), json!(true));
    if has_boolean("thinking")
        && let Some(thinking) = chosen_bool(selection, "thinking")
    {
        settings.insert("alwaysThinkingEnabled".into(), json!(thinking));
    }
    if resolved("fastMode") == Some(true) {
        settings.insert("fastMode".into(), json!(true));
    }
    if let Some(ultracode) = resolved("ultracode") {
        settings.insert("ultracode".into(), json!(ultracode));
    }
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        output_schema,
        "--model",
        &compiled.api_model_id,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if let Some(effort) = compiled.effort.filter(|e| !e.is_empty()) {
        args.extend(["--effort".to_owned(), effort]);
    }
    args.extend(["--settings".to_owned(), Value::Object(settings).to_string()]);
    if investigate {
        args.extend(
            [
                "--tools",
                INVESTIGATION_TOOLS,
                "--allowedTools",
                INVESTIGATION_ALLOWED,
                "--disallowedTools",
                INVESTIGATION_DENIED,
                "--setting-sources",
                "",
            ]
            .map(str::to_owned),
        );
    } else {
        args.extend(["--tools".to_owned(), String::new()]);
    }
    args.push("--disable-slash-commands".to_owned());
    if no_session_persistence {
        args.push(NO_SESSION_PERSISTENCE.to_owned());
    }
    if !managed_mcp_config {
        args.push("--strict-mcp-config".to_owned());
    }
    args.extend(["--permission-mode".to_owned(), "dontAsk".to_owned()]);
    args
}

/// `claudeErrorResult`: the last non-empty error text of the JSON output.
fn error_result(stdout: &str) -> Option<String> {
    let output: Value = serde_json::from_str(stdout).ok()?;
    let messages = match output {
        Value::Array(list) => list,
        other => vec![other],
    };
    messages
        .iter()
        .filter(|m| m["is_error"] == true)
        .map(|m| {
            m["result"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    m["errors"].as_array().map(|errors| {
                        errors
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|e| !e.starts_with("[ede_diagnostic]"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                })
                .unwrap_or_default()
                .trim()
                .to_owned()
        })
        .rfind(|r| !r.is_empty())
}

/// The structured output of `--output-format json`: an envelope, or a list whose last
/// `result` message carries it.
fn structured_output(stdout: &str) -> Result<Value, ProviderError> {
    let unexpected = || failed("Claude CLI returned unexpected output format.");
    let output: Value = serde_json::from_str(stdout).map_err(|_| unexpected())?;
    let envelope = match &output {
        Value::Object(map) if map.contains_key("structured_output") => Some(&output),
        Value::Array(list) => {
            if !list.iter().all(|m| m["type"].is_string()) {
                return Err(unexpected());
            }
            list.iter().rev().find(|m| m["type"] == "result")
        }
        _ => return Err(unexpected()),
    };
    Ok(envelope
        .and_then(|e| e.get("structured_output"))
        .cloned()
        .unwrap_or(Value::Null))
}

struct SettingsFile(std::path::PathBuf);

impl Drop for SettingsFile {
    fn drop(&mut self) {
        let path = self.0.clone();
        // A cancelled guide must also remove its private settings file.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || std::fs::remove_file(path));
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn merge_settings(target: &mut Value, source: Value) {
    if let (Some(map), Value::Object(source)) = (target.as_object_mut(), &source) {
        for (key, value) in source {
            merge_settings(map.entry(key).or_insert(Value::Null), value.clone());
        }
    } else {
        *target = source;
    }
}

/// Models known to reject image blocks on this provider instance.
pub type TextOnlyModels = std::sync::Mutex<std::collections::HashSet<String>>;

fn rejects_images(detail: &str) -> bool {
    detail.lines().any(|line| {
        let line = line.to_ascii_lowercase();
        line.contains("image") && (line.contains("not support") || line.contains("unsupported"))
    })
}

/// One request. `env` is the Claude process environment; `program` the CLI; `manifest` the
/// instance's live model manifest.
pub async fn generate(
    program: &str,
    env: &[(String, String)],
    config: &crate::launch::ClaudeConfig,
    text_only_models: &TextOnlyModels,
    managed_mcp_config: bool,
    request: TextGenerationRequest,
) -> Result<Value, ProviderError> {
    let selection = conn_contract::to_json(&request.model_selection);
    let mut args = cli_args_scoped(
        &selection,
        config,
        &request.output_schema,
        true,
        managed_mcp_config,
        request.investigate,
    );
    let launch_args = config.launch_args.clone();
    let project_cwd = request
        .project_cwd
        .clone()
        .unwrap_or_else(|| request.cwd.clone());
    let home = crate::launch::config_dir(
        config,
        &env.iter().map(|(k, v)| (k.clone(), json!(v))).collect(),
    );
    let investigate = request.investigate;
    let at = args
        .iter()
        .position(|arg| arg == "--settings")
        .and_then(|at| at.checked_add(1));
    let base = at
        .and_then(|i| args.get(i))
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_else(|| json!({}));
    let (settings, temp_settings) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        use std::io::Write;
        let parsed = crate::launch_args::apply(&launch_args, Some(&project_cwd))?;
        let launch = parsed
            .settings
            .map(|entries| crate::launch_args::Json::Object(entries).to_text())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!({}));
        let mut merged = if investigate {
            std::fs::read_to_string(home.join("settings.json"))
                .ok()
                .and_then(|text| conn_support::json::parse_lenient::<Value>(&text))
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}))
        } else {
            json!({})
        };
        let mut denies = Vec::new();
        for source in [&merged, &launch] {
            for rule in source["permissions"]["deny"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r.is_string())
            {
                if !denies.contains(rule) {
                    denies.push(rule.clone())
                }
            }
        }
        merge_settings(&mut merged, launch);
        merge_settings(&mut merged, base);
        if investigate {
            if let Some(map) = merged.as_object_mut() {
                map.remove("permissions");
            }
            if !denies.is_empty() {
                merged["permissions"] = json!({"deny":denies});
            }
            let path = std::env::temp_dir().join(format!(
                "conn-claude-settings-{}.json",
                conn_support::uuid_v4()
            ));
            let mut opts = std::fs::OpenOptions::new();
            opts.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts.open(&path).map_err(|e| e.to_string())?;
            let guard = SettingsFile(path);
            file.write_all(merged.to_string().as_bytes())
                .map_err(|e| e.to_string())?;
            return Ok((guard.0.to_string_lossy().into_owned(), Some(guard)));
        }
        Ok((merged.to_string(), None))
    })
    .await
    .map_err(|e| failed(e.to_string()))?
    .map_err(failed)?;
    if let Some(slot) = at.and_then(|i| args.get_mut(i)) {
        *slot = settings;
    }
    let _settings_file = temp_settings;
    let api_model = args
        .windows(2)
        .find(|pair| pair[0] == "--model")
        .map(|pair| pair[1].clone())
        .unwrap_or_default();
    let paths = if crate::lock(text_only_models).contains(&api_model) {
        vec![]
    } else {
        request.image_paths.clone()
    };
    let text = request.prompt.clone();
    let image_input=tokio::task::spawn_blocking(move || {
        let mut content=vec![json!({"type":"text","text":text})];
        for path in paths {
            let mime=match path.extension().and_then(|ext|ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str(){
                "png"=>"image/png","jpg"|"jpeg"=>"image/jpeg","webp"=>"image/webp","gif"=>"image/gif",_=>continue,
            };
            if let Ok(bytes)=std::fs::read(path){content.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":conn_support::base64::encode(&bytes)}}));}
        }
        (content.len()>1).then(||format!("{}\n",json!({"type":"user","message":{"role":"user","content":content}})))
    }).await.map_err(|e|failed(e.to_string()))?;
    let title = request.operation == "generateThreadTitle";
    // A thread title runs in a fresh folder of its own (`makeTempDirectoryScoped`), removed
    // after.
    let temp = if title {
        let made = tokio::task::spawn_blocking(|| {
            let suffix: String = conn_support::uuid_v4()
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .take(6)
                .collect();
            let dir = std::env::temp_dir().join(format!("t3code-claude-title-{suffix}"));
            std::fs::create_dir(&dir).map(|()| dir)
        })
        .await
        .map_err(|e| failed(format!("Failed to create title directory: {e}")))?
        .map_err(|e| failed(format!("Failed to create title directory: {e}")))?;
        Some(made)
    } else {
        None
    };
    let cwd = temp
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from(&request.cwd));
    let timeout = request.timeout.unwrap_or(TIMEOUT);
    let started = tokio::time::Instant::now();
    let run = |persistence: bool, images: bool| {
        let mut args = args.clone();
        if !persistence {
            args.retain(|s| s != NO_SESSION_PERSISTENCE);
        }
        if images && let Some(at) = args.iter().position(|s| s == "--output-format") {
            args.splice(
                at..at + 2,
                [
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ]
                .map(str::to_owned),
            );
        }
        let cwd = cwd.clone();
        let prompt = if images {
            image_input.as_deref().unwrap_or(&request.prompt)
        } else {
            &request.prompt
        };
        let left = timeout.saturating_sub(started.elapsed());
        async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let mut out = run_collect(program, &args, env, Some(&cwd), Some(prompt), left).await?;
            if images && let Some(out) = out.as_mut() {
                out.stdout = out
                    .stdout
                    .lines()
                    .rfind(|s| !s.trim().is_empty())
                    .unwrap_or_default()
                    .to_owned();
            }
            Ok::<_, CommandError>(out)
        }
    };
    let attempt = |images| {
        let run = &run;
        async move {
            let result = run(true, images).await;
            if matches!(&result, Ok(Some(out)) if out.code!=0 && out.stderr.contains(NO_SESSION_PERSISTENCE_REJECTED))
            {
                run(false, images).await
            } else {
                result
            }
        }
    };
    let mut result = attempt(image_input.is_some()).await;
    if image_input.is_some()
        && matches!(&result,Ok(Some(out)) if out.code!=0)
        && started.elapsed() < timeout
    {
        let unsupported = matches!(&result, Ok(Some(output)) if rejects_images(&output.stdout) || rejects_images(&output.stderr));
        result = attempt(false).await;
        if unsupported && matches!(&result, Ok(Some(output)) if output.code == 0) {
            crate::lock(text_only_models).insert(api_model);
        }
    }
    if let Some(dir) = temp {
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
    }
    let out = match result {
        Ok(Some(out)) => out,
        Ok(None) => return Err(failed("Claude CLI request timed out.")),
        Err(CommandError::NotFound) => {
            return Err(failed(
                "Failed to spawn Claude CLI process: the executable was not found",
            ));
        }
        Err(CommandError::Failed(e)) => {
            return Err(failed(format!("Failed to spawn Claude CLI process: {e}")));
        }
    };
    if out.code != 0 {
        let stdout = out.stdout.trim();
        let stderr = out.stderr.trim();
        let detail = error_result(stdout).unwrap_or_else(|| {
            if stderr.is_empty() {
                stdout.to_owned()
            } else {
                stderr.to_owned()
            }
        });
        return Err(failed(if detail.is_empty() {
            format!("Claude CLI command failed with code {}.", out.code)
        } else {
            format!("Claude CLI command failed: {detail}")
        }));
    }
    structured_output(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn guide_settings_and_image_title_cross_the_cli_boundary() {
        let root =
            std::env::temp_dir().join(format!("conn-claude-text-{}", conn_support::uuid_v4()));
        let home = root.join("profile");
        let project = root.join("original-project");
        let review = root.join("review-copy");
        for d in [&home, &project, &review] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(
            home.join("settings.json"),
            r#"{"permissions":{"deny":["Bash(rm:*)"], "allow":["Bash(*)"]}, "env":{"KEEP":"yes"}}"#,
        )
        .unwrap();
        std::fs::write(project.join("model.json"),r#"{"permissions":{"deny":["Read(/private)"],"allow":["Edit(*)"]},"env":{"PROJECT":"yes"}}"#).unwrap();
        let program = root.join("fixture");
        std::fs::write(&program, r#"#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name)+1];
const settings = arg("--settings"), file = !settings.startsWith("{");
const raw = fs.readFileSync(0, "utf8");
const entry = {args,settings: JSON.parse(file?fs.readFileSync(settings,"utf8"):settings),mode:file?fs.statSync(settings).mode & 511:null,input:raw, cwd:process.cwd()};
fs.appendFileSync(process.env.TEST_INPUTS, JSON.stringify(entry)+"\n");
if (args.includes("--input-format") && process.env.TEXT_ONLY === "1") {console.error("unsupported image input");process.exit(1);}
if (args.includes("--input-format")) console.log(JSON.stringify({type:"system"}));
console.log(JSON.stringify({type:"result",structured_output:{title:"test"}}));
"#).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let image = root.join("title.png");
        std::fs::write(&image, b"image").unwrap();
        let log = root.join("log");
        let mut env = conn_support::login_env::child_env();
        env.push(("TEST_INPUTS".into(), log.to_string_lossy().into_owned()));
        let mut config = crate::launch::ClaudeConfig {
            home_path: Some(home),
            launch_args: "--settings model.json".into(),
            ..Default::default()
        };
        let cache = TextOnlyModels::default();
        let request = |guide: bool| TextGenerationRequest {
            operation: if guide {
                "generateReviewGuide"
            } else {
                "generateThreadTitle"
            }
            .into(),
            cwd: review.to_string_lossy().into_owned(),
            project_cwd: Some(project.to_string_lossy().into_owned()),
            prompt: "describe".into(),
            output_schema: "{}".into(),
            model_selection: conn_contract::from_json(
                json!({"instanceId":"claudeAgent","model":"claude-haiku-4-5"}),
            )
            .unwrap(),
            image_paths: if guide { vec![] } else { vec![image.clone()] },
            timeout: Some(Duration::from_secs(8)),
            investigate: guide,
        };
        let program = program.to_str().unwrap();
        generate(program, &env, &config, &cache, false, request(true))
            .await
            .unwrap();
        config.launch_args.clear();
        generate(program, &env, &config, &cache, false, request(false))
            .await
            .unwrap();
        env.push(("TEXT_ONLY".into(), "1".into()));
        generate(program, &env, &config, &cache, false, request(false))
            .await
            .unwrap();
        generate(program, &env, &config, &cache, false, request(false))
            .await
            .unwrap();
        let rows: Vec<Value> = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        let guide = &rows[0];
        assert_eq!(
            guide["settings"]["permissions"],
            json!({"deny":["Bash(rm:*)","Read(/private)"]})
        );
        assert_eq!(
            guide["settings"]["env"],
            json!({"KEEP":"yes","PROJECT":"yes"})
        );
        assert_eq!(guide["mode"], 0o600);
        let args = guide["args"].as_array().unwrap();
        for (key, value) in [
            ("--setting-sources", ""),
            ("--allowedTools", INVESTIGATION_ALLOWED),
            ("--permission-mode", "dontAsk"),
        ] {
            assert!(
                args.windows(2)
                    .any(|pair| pair[0] == key && pair[1] == value),
                "{args:?}"
            );
        }
        assert_eq!(
            rows.len(),
            5,
            "successful image run, image rejection with one fallback, then cached text-only model"
        );
        let user: Value = serde_json::from_str(rows[1]["input"].as_str().unwrap()).unwrap();
        assert_eq!(user["message"]["content"][1]["source"]["data"], "aW1hZ2U=");
        assert_eq!(rows[3]["input"], "describe");
        assert_eq!(rows[4]["input"], "describe");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_answer_is_the_structured_output() {
        assert_eq!(
            structured_output(r#"{"type":"result","structured_output":{"title":"x"}}"#).unwrap(),
            json!({"title": "x"})
        );
        assert_eq!(
            structured_output(
                r#"[{"type":"system"},{"type":"result","structured_output":{"title":"y"}}]"#
            )
            .unwrap(),
            json!({"title": "y"})
        );
        assert!(structured_output("not json").is_err());
        assert_eq!(
            error_result(r#"{"is_error":true,"errors":["[ede_diagnostic] x","boom"]}"#),
            Some("boom".into())
        );
    }

    #[test]
    fn arguments_follow_run_claude_json() {
        let args = cli_args(
            &json!({"instanceId": "claudeAgent", "model": "claude-haiku-4-5"}),
            &conn_provider::LiveManifest::default(),
            "{}",
            true,
            false,
            false,
        );
        assert_eq!(args.first().map(String::as_str), Some("-p"));
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "");
        assert!(args.ends_with(&["--permission-mode".into(), "dontAsk".into()]));
        assert!(args.contains(&"--strict-mcp-config".to_owned()));
    }

    /// T3's `runClaudeJson` compiles against the instance's `modelCatalog`: a model only the
    /// accepted manifest lists gets its effort map, its model suffix and its boolean options.
    #[test]
    fn arguments_follow_the_live_catalog() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../server/src/provider/model-manifest.json"
        );
        let mut manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let catalog = &mut manifest["providers"]["claudeAgent"];
        catalog["profiles"]["next"] = json!({
            "capabilities": {"optionDescriptors": [
                {"id": "effort", "label": "Effort", "type": "select", "options": [
                    {"id": "low", "label": "Low"},
                    {"id": "high", "label": "High", "isDefault": true},
                    {"id": "ultracode", "label": "Ultracode"}]},
                {"id": "thinking", "label": "Thinking", "type": "boolean"},
                {"id": "contextWindow", "label": "Context", "type": "select", "options": [
                    {"id": "200k", "label": "200k", "isDefault": true},
                    {"id": "1m", "label": "1M"}]}]},
            "adapter": {"claudeCode": {"effortMap": {"high": "max"},
                "modelSuffixes": {"contextWindow": {"1m": "[1m]"}}}}
        });
        catalog["profiles"]["fast"] = json!({
            "capabilities": {"optionDescriptors": [
                {"id": "effort", "label": "Effort", "type": "select", "options": [
                    {"id": "high", "label": "High"},
                    {"id": "ultracode", "label": "Ultracode", "isDefault": true}]},
                {"id": "fastMode", "label": "Fast", "type": "boolean", "currentValue": true}]}
        });
        let models = catalog["models"].as_array_mut().unwrap();
        models.push(
            json!({"slug": "claude-next", "name": "Claude Next", "status": "current",
                "profile": "next"}),
        );
        models.push(
            json!({"slug": "claude-fast", "name": "Claude Fast", "status": "current",
                "profile": "fast"}),
        );
        let live = conn_provider::LiveManifest::default();
        live.set(manifest);
        let selection = json!({"instanceId": "claudeAgent", "model": "claude-next", "options": [
            {"id": "effort", "value": "high"}, {"id": "contextWindow", "value": "1m"},
            {"id": "thinking", "value": false}]});
        let args = cli_args(&selection, &live, "{}", true, false, false);
        let after = |flag: &str| {
            let at = args.iter().position(|a| a == flag).unwrap();
            args[at + 1].clone()
        };
        assert_eq!(after("--model"), "claude-next[1m]");
        assert_eq!(after("--effort"), "max");
        let settings: Value = serde_json::from_str(&after("--settings")).unwrap();
        assert_eq!(settings["alwaysThinkingEnabled"], false);
        let settings_for = |model: &str, options: Value| {
            let selection =
                json!({"instanceId": "claudeAgent", "model": model, "options": options});
            let args = cli_args(&selection, &live, "{}", true, false, false);
            let at = args.iter().position(|a| a == "--settings").unwrap();
            let effort = args
                .iter()
                .position(|a| a == "--effort")
                .map(|at| args[at + 1].clone());
            (
                serde_json::from_str::<Value>(&args[at + 1]).unwrap(),
                effort,
            )
        };
        // A saved legacy Ultracode effort: the resolved toggle is on, at xhigh.
        let (settings, effort) = settings_for(
            "claude-next",
            json!([{"id": "effort", "value": "ultracode"}]),
        );
        assert_eq!(settings["ultracode"], true, "{settings}");
        assert_eq!(effort.as_deref(), Some("xhigh"));
        // The manifest's defaults, with nothing chosen: Ultracode and Fast Mode on.
        let (settings, _) = settings_for("claude-fast", json!([]));
        assert_eq!(settings["ultracode"], true, "{settings}");
        assert_eq!(settings["fastMode"], true, "{settings}");
    }
}
