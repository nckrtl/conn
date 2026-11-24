//! Workspace-local Laravel definition lookup. Each active artisan root owns one stdio session.
use crate::{paths::InternalPaths, workspace};
use conn_contract::{
    ProjectReadFileInput,
    source::{DefinitionQuery, DefinitionTarget, SourceLines, workspace_relative},
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot},
    time::timeout,
};
use url::Url;

type Answer = Result<Vec<DefinitionTarget>, String>;
struct Lookup {
    uri: Url,
    workspace: PathBuf,
    contents: String,
    query: DefinitionQuery,
    internal: InternalPaths,
    answer: oneshot::Sender<Answer>,
}

#[derive(Default, Debug)]
pub struct LaravelNavigation {
    sessions: Mutex<HashMap<PathBuf, mpsc::Sender<Lookup>>>,
}

impl LaravelNavigation {
    pub async fn definition(
        &self,
        root: &str,
        query: DefinitionQuery,
        internal: &InternalPaths,
    ) -> Answer {
        if !workspace_relative(&query.path)
            || !query.path.ends_with(".php")
            || query.line == 0
            || query.column == 0
        {
            return Err("Use a relative PHP path and positive line and column.".into());
        }
        let (answer, rx) = oneshot::channel();
        let root = root.to_owned();
        let internal = internal.clone();
        let (artisan, lookup) =
            tokio::task::spawn_blocking(move || prepare(&root, query, internal, answer))
                .await
                .map_err(|_| "Cannot prepare source lookup.")??;
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Navigation service unavailable.")?;
            sessions.retain(|_, tx| !tx.is_closed());
            if sessions.len() >= 8 && !sessions.contains_key(&artisan) {
                return Err("All language server slots are busy.".into());
            }
            let tx = sessions.entry(artisan.clone()).or_insert_with(|| {
                let (tx, rx) = mpsc::channel(8);
                tokio::spawn(serve(artisan, rx));
                tx
            });
            tx.try_send(lookup)
                .map_err(|_| "The language server is busy. Try the lookup again.")?;
        }
        timeout(Duration::from_secs(25), rx)
            .await
            .map_err(|_| "Language server lookup timed out.")?
            .map_err(|_| "Language server stopped.")?
    }
}

fn prepare(
    root: &str,
    query: DefinitionQuery,
    internal: InternalPaths,
    answer: oneshot::Sender<Answer>,
) -> Result<(PathBuf, Lookup), String> {
    let workspace = Path::new(root)
        .canonicalize()
        .map_err(|_| "Workspace is unavailable.")?;
    if workspace.parent().is_none() {
        return Err("Expected a project workspace.".into());
    }
    let path = workspace
        .join(&query.path)
        .canonicalize()
        .map_err(|_| "Source file is unavailable.")?;
    if !path.starts_with(&workspace) || internal.contains(&path) {
        return Err("Source file is outside the workspace.".into());
    }
    let artisan = path
        .ancestors()
        .skip(1)
        .take_while(|p| p.starts_with(&workspace))
        .find(|p| p.join("artisan").is_file())
        .ok_or("No Laravel artisan root contains this file.")?
        .to_owned();
    let file = workspace::read_file(
        &ProjectReadFileInput {
            cwd: root.into(),
            relative_path: query.path.clone(),
            allow_missing: None,
        },
        None,
        &internal,
    )
    .map_err(|_| "Cannot read this source file.")?;
    if file.truncated {
        return Err("File exceeds the source navigation limit.".into());
    }
    if !valid_position(&file.contents, &query) {
        return Err("The source line changed or the position is outside the file. Reopen the file and try again.".into());
    }
    let lookup = Lookup {
        uri: Url::from_file_path(path).map_err(|_| "Invalid file URI.")?,
        workspace,
        contents: file.contents,
        query,
        internal,
        answer,
    };
    Ok((artisan, lookup))
}

fn valid_position(contents: &str, query: &DefinitionQuery) -> bool {
    let Some(line) = contents
        .split('\n')
        .nth(query.line.saturating_sub(1) as usize)
    else {
        return false;
    };
    if query
        .expected_line
        .as_deref()
        .is_some_and(|expected| line.trim_end_matches('\r') != expected)
    {
        return false;
    }
    let target = query.column - 1;
    let mut at = 0;
    for ch in line.trim_end_matches('\r').chars() {
        if at == target {
            return true;
        }
        at += ch.len_utf16() as u32;
    }
    at == target
}

async fn serve(artisan: PathBuf, mut requests: mpsc::Receiver<Lookup>) {
    let dirty = Arc::new(AtomicBool::new(false));
    let flag = dirty.clone();
    let base = artisan.clone();
    let watch = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.map_or(true, |e| {
            !e.kind.is_access()
                && e.paths.iter().any(|p| {
                    p.strip_prefix(&base).is_ok_and(|relative| {
                        ![".git", "storage", "node_modules", "bootstrap/cache"]
                            .iter()
                            .any(|ignore| relative.starts_with(ignore))
                    })
                })
        }) {
            flag.store(true, Ordering::Release);
        }
    })
    .and_then(|mut w: RecommendedWatcher| {
        w.watch(&artisan, RecursiveMode::Recursive)?;
        Ok(w)
    });
    let mut server = None;
    while let Ok(Some(request)) = timeout(Duration::from_secs(90), requests.recv()).await {
        if request.answer.is_closed() {
            continue;
        }
        if dirty.swap(false, Ordering::AcqRel) || watch.is_err() {
            server = None;
        }
        let result = timeout(Duration::from_secs(20), async {
            let session = match &mut server {
                Some(session) => session,
                None => server.insert(Session::start(&artisan).await?),
            };
            session.lookup(&request).await
        })
        .await
        .unwrap_or_else(|_| Err("Laravel language server timed out.".into()));
        if result.is_err() {
            server = None;
        }
        let _ = request.answer.send(result);
    }
}

struct Session {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    id: u64,
}

impl Session {
    async fn start(root: &Path) -> Result<Self, String> {
        let mut child = Command::new("laravel-lsp")
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Cannot start laravel-lsp in this workspace: {e}"))?;
        let mut session = Self {
            input: child.stdin.take().ok_or("No language server stdin.")?,
            output: BufReader::new(child.stdout.take().ok_or("No language server stdout.")?),
            _child: child,
            id: 0,
        };
        let uri = Url::from_directory_path(root).map_err(|_| "Invalid artisan root.")?;
        let capabilities = session.call("initialize",json!({"processId":std::process::id(),"rootUri":uri.as_str(),"workspaceFolders":[{"uri":uri.as_str(),"name":"Laravel"}],"capabilities":{"general":{"positionEncodings":["utf-16"]}},"initializationOptions":{"phpEnvironment":"local","pestGenerateDocBlocks":false}})).await?;
        if !matches!(
            capabilities.pointer("/capabilities/definitionProvider"),
            Some(Value::Bool(true) | Value::Object(_))
        ) {
            return Err("Laravel server does not support definitions.".into());
        }
        session.notify("initialized", json!({})).await?;
        Ok(session)
    }

    async fn lookup(&mut self, lookup: &Lookup) -> Answer {
        let uri = &lookup.uri;
        self.notify("textDocument/didOpen",json!({"textDocument":{"uri":uri.as_str(),"languageId":if lookup.query.path.ends_with(".blade.php") {"blade"}else{"php"},"version":1,"text":lookup.contents}})).await?;
        let reply=self.call("textDocument/definition",json!({"textDocument":{"uri":uri.as_str()},"position":{"line":lookup.query.line-1,"character":lookup.query.column-1}})).await?;
        self.notify(
            "textDocument/didClose",
            json!({"textDocument":{"uri":uri.as_str()}}),
        )
        .await?;
        Ok(match &reply {
            Value::Array(items) => items
                .iter()
                .filter_map(|item| target(item, lookup))
                .collect(),
            item => target(item, lookup).into_iter().collect(),
        })
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.id += 1;
        self.write(json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}))
            .await?;
        loop {
            let frame = read_frame(&mut self.output)
                .await
                .map_err(|e| format!("Invalid Laravel server response: {e}"))?;
            if let Some(method) = frame["method"].as_str() {
                if !frame["id"].is_null() {
                    let id = &frame["id"];
                    let reply = match method {
                        "client/registerCapability" => {
                            json!({"jsonrpc":"2.0","id":id,"result":null})
                        }
                        "workspace/configuration" => {
                            let items = frame
                                .pointer("/params/items")
                                .and_then(Value::as_array)
                                .map_or(0, Vec::len);
                            json!({"jsonrpc":"2.0","id":id,"result":vec![Value::Null;items]})
                        }
                        _ => {
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported client method"}})
                        }
                    };
                    self.write(reply).await?;
                }
            } else if frame["id"] == self.id {
                if let Some(err) = frame.get("error") {
                    return Err(err["message"]
                        .as_str()
                        .unwrap_or("Laravel lookup failed.")
                        .into());
                }
                return frame
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Missing language server result.".into());
            }
        }
    }

    async fn write(&mut self, frame: Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
        self.input
            .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.input
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())?;
        self.input.flush().await.map_err(|e| e.to_string())
    }
}

async fn read_frame(output: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> io::Result<Value> {
    let mut headers = Vec::new();
    let mut bounded = (&mut *output).take(8192);
    loop {
        let start = headers.len();
        if bounded.read_until(b'\n', &mut headers).await? == 0 {
            return Err(io::Error::other("incomplete frame headers"));
        }
        if headers[start..] == *b"\r\n" {
            break;
        }
    }
    let size = std::str::from_utf8(&headers)
        .ok()
        .and_then(|h| {
            h.lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(k, _)| k.eq_ignore_ascii_case("Content-Length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        })
        .filter(|n| *n <= 4 * 1024 * 1024)
        .ok_or_else(|| io::Error::other("invalid content length"))?;
    let mut bytes = vec![0; size];
    output.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn target(location: &Value, lookup: &Lookup) -> Option<DefinitionTarget> {
    let uri = location
        .get("targetUri")
        .or_else(|| location.get("uri"))?
        .as_str()?;
    let absolute = Url::parse(uri)
        .ok()?
        .to_file_path()
        .ok()?
        .canonicalize()
        .ok()?;
    if lookup.internal.contains(&absolute) || !absolute.is_file() {
        return None;
    }
    let path = absolute
        .strip_prefix(&lookup.workspace)
        .ok()?
        .to_str()?
        .to_owned();
    let range = location
        .get("targetSelectionRange")
        .or_else(|| location.get("range"))?;
    let line = |key: &str| {
        usize::try_from(range[key]["line"].as_u64()?)
            .ok()?
            .checked_add(1)
    };
    let start_line = line("start")?;
    let end = line("end")?;
    let end_line = if end > start_line && range["end"]["character"] == 0 {
        end - 1
    } else {
        end
    };
    (end_line >= start_line).then_some(DefinitionTarget {
        path,
        lines: SourceLines {
            start_line,
            end_line,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framed_definition_leaves_the_next_message_in_the_stream() {
        let message = br#"{"result":"source"}"#;
        let mut wire = format!(
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n",
            message.len()
        )
        .into_bytes();
        wire.extend(message);
        wire.extend(b"Content-Length: 4\r\n\r\nnull");
        let mut stream = BufReader::new(&wire[..]);
        assert_eq!(read_frame(&mut stream).await.unwrap()["result"], "source");
        assert_eq!(read_frame(&mut stream).await.unwrap(), Value::Null);
        assert!(
            read_frame(&mut &b"Content-Length: 999999999\r\n\r\n"[..])
                .await
                .is_err()
        );
    }

    #[test]
    fn php_columns_use_utf16_and_end_on_scalar_boundaries() {
        let mut query = DefinitionQuery {
            path: "routes/web.php".into(),
            line: 2,
            column: 3,
            expected_line: None,
        };
        assert!(valid_position("<?php\n🦀x", &query));
        query.column = 2;
        assert!(!valid_position("<?php\n🦀x", &query));
        query.column = 5;
        assert!(!valid_position("<?php\n🦀x", &query));
    }

    #[tokio::test]
    #[ignore = "requires laravel-lsp on PATH and a Laravel skeleton in CONN_LARAVEL_FIXTURE"]
    async fn real_laravel_welcome_definition() {
        let root = std::env::var("CONN_LARAVEL_FIXTURE").expect("Laravel skeleton");
        let state = InternalPaths::new(Path::new(&root).join(".conn-test-state").as_path());
        let app = LaravelNavigation::default();
        let routes = std::fs::read_to_string(Path::new(&root).join("routes/web.php")).unwrap();
        let (line, source) = routes
            .lines()
            .enumerate()
            .find(|(_, line)| line.contains("'welcome'"))
            .unwrap();
        let column = source[..source.find("welcome").unwrap()]
            .encode_utf16()
            .count()
            + 2;
        let query = DefinitionQuery {
            path: "routes/web.php".into(),
            line: line as u32 + 1,
            column: column as u32,
            expected_line: None,
        };
        for _ in 0..2 {
            let targets = app.definition(&root, query.clone(), &state).await.unwrap();
            assert_eq!(
                targets.first().map(|t| t.path.as_str()),
                Some("resources/views/welcome.blade.php")
            );
        }
    }
}
