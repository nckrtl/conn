//! Read native Antigravity trajectories and child transcripts under the instance profile.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const STEP_BYTES: i64 = 1024 * 1024;
const SCAN_BYTES: i64 = 8 * STEP_BYTES;
const MAX_ROWS: i64 = 200;
const BATCH: &str = "Antigravity subagent batch";

fn native_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn managed_file(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    let mut path = root.canonicalize().ok()?;
    for (n, part) in parts.iter().enumerate() {
        if Path::new(part).components().count() != 1
            || !matches!(
                Path::new(part).components().next(),
                Some(std::path::Component::Normal(_))
            )
        {
            return None;
        }
        path.push(part);
        let stat = path.symlink_metadata().ok()?;
        if stat.is_symlink()
            || if n + 1 == parts.len() {
                !stat.is_file()
            } else {
                !stat.is_dir()
            }
        {
            return None;
        }
    }
    (path.canonicalize().ok()? == path).then_some(path)
}

fn database(profile: &Path, session: &str) -> Option<Connection> {
    if !native_id(session) {
        return None;
    }
    let path = managed_file(
        profile,
        &["antigravity-acp", "conversations", &format!("{session}.db")],
    )?;
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .ok()
}

pub(crate) fn last_step(profile: &Path, session: &str) -> Option<i64> {
    database(profile, session)?
        .query_row("SELECT coalesce(max(idx),-1) FROM steps", [], |r| r.get(0))
        .ok()
}

/// A turn that created the file after dispatch also owns its first step.
pub(crate) fn terminal_error(profile: &Path, session: &str, after: i64) -> Option<String> {
    let db = database(profile, session)?;
    let (kind,bytes):(i64,Vec<u8>)=db.query_row("SELECT step_type,substr(step_payload,1,16384) FROM steps WHERE idx>?1 ORDER BY idx DESC LIMIT 1",[after],|r|Ok((r.get(0)?,r.get(1)?))).optional().ok()??;
    if kind != 17 {
        return None;
    }
    let decoded = String::from_utf8_lossy(&bytes);
    let start = [
        "Error ",
        "RESOURCE_EXHAUSTED",
        "UNAVAILABLE",
        "PERMISSION_DENIED",
        "INVALID_ARGUMENT",
        "INTERNAL",
        "There was a network issue",
    ]
    .iter()
    .filter_map(|marker| decoded.find(marker))
    .min();
    // The remaining bytes can include native diagnostic data. Report only the bounded user-facing first line.
    Some(
        start
            .and_then(|at| decoded[at..].split(|c: char| c.is_control()).next())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Antigravity reported a native provider error.")
            .chars()
            .take(1024)
            .collect(),
    )
}

fn varint(input: &mut &[u8]) -> Option<u64> {
    let mut value = 0;
    for shift in (0..64).step_by(7) {
        let (&byte, rest) = input.split_first()?;
        *input = rest;
        if shift == 63 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Some(value);
        }
    }
    None
}
fn fields(mut data: &[u8]) -> Option<Vec<(u64, &[u8])>> {
    let mut out = Vec::new();
    while !data.is_empty() {
        let tag = varint(&mut data)?;
        let field = tag >> 3;
        if field == 0 {
            return None;
        }
        match tag & 7 {
            0 => {
                varint(&mut data)?;
            }
            1 => data = data.get(8..)?,
            2 => {
                let size = usize::try_from(varint(&mut data)?).ok()?;
                let (v, rest) = data.split_at_checked(size)?;
                data = rest;
                out.push((field, v));
            }
            5 => data = data.get(4..)?,
            _ => return None,
        }
    }
    Some(out)
}
fn parts(data: &[u8], number: u64) -> Option<Vec<&[u8]>> {
    Some(
        fields(data)?
            .into_iter()
            .filter_map(|(f, b)| (f == number).then_some(b))
            .collect(),
    )
}
fn part(data: &[u8], number: u64) -> Option<&[u8]> {
    parts(data, number)?.first().copied()
}
fn text(data: &[u8], number: u64) -> Option<&str> {
    std::str::from_utf8(part(data, number)?).ok()
}

fn planner_ids(db: &Connection, index: i64) -> Option<Vec<String>> {
    let bytes:Vec<u8>=db.query_row("SELECT step_payload FROM steps WHERE idx=?1 AND step_format=0 AND length(step_payload)<=?2",[index,STEP_BYTES],|r|r.get(0)).ok()?;
    Some(
        parts(part(&bytes, 20)?, 7)?
            .into_iter()
            .filter(|c| text(c, 2) == Some("invoke_subagent"))
            .filter_map(|c| text(c, 1).map(str::to_owned))
            .collect(),
    )
}

struct Child {
    role: String,
    prompt: String,
    id: String,
    log: Option<String>,
}
fn decode_record(data: &[u8]) -> Option<(Option<String>, Vec<Child>)> {
    let call = part(data, 5)
        .and_then(|v| part(v, 4))
        .and_then(|v| text(v, 1))
        .map(str::to_owned);
    let invoke = part(data, 143)?;
    let launches = parts(invoke, 9)?;
    let children = parts(invoke, 10)?;
    if launches.len() != children.len() || children.is_empty() || children.len() > 16 {
        return None;
    }
    let children = launches
        .into_iter()
        .zip(children)
        .map(|(launch, child)| {
            let id = text(child, 1)?;
            if !native_id(id) {
                return None;
            }
            Some(Child {
                id: id.to_owned(),
                role: text(launch, 2)?.to_owned(),
                prompt: text(launch, 3)?.to_owned(),
                log: text(child, 2).filter(|s| !s.is_empty()).map(str::to_owned),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some((call, children))
}

fn describe(children: &[Child]) -> (String, String) {
    if let [c] = children {
        return (c.role.clone(), c.prompt.clone());
    }
    (
        children
            .iter()
            .map(|c| c.role.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        children
            .iter()
            .map(|c| format!("{}\n{}", c.role, c.prompt))
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

/// Detached workers in recent agy versions live in the parent's subagents directory.
/// Require both the parent descriptor and the launch message addressed to that child.
fn read_json(path: &Path) -> Option<Value> {
    if path.metadata().ok()?.len() > STEP_BYTES as u64 {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(STEP_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > STEP_BYTES as usize {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn managed_dir(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    let mut path = root.canonicalize().ok()?;
    for part in parts {
        path.push(part);
        let stat = path.symlink_metadata().ok()?;
        if stat.is_symlink() || !stat.is_dir() {
            return None;
        }
    }
    (path.canonicalize().ok()? == path).then_some(path)
}

fn detached(profile: &Path, session: &str, task: &str) -> Option<Vec<Child>> {
    let parent = [
        "antigravity-acp",
        "brain",
        session,
        ".system_generated",
        "subagents",
    ];
    let dir = managed_dir(profile, &parent)?;
    let mut found = Vec::new();
    let mut is_swarm = true;
    let mut children = 0usize;
    let mut total_bytes = 0;
    for entry in dir.read_dir().ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        let Some(child) = name.strip_suffix(".json").filter(|s| native_id(s)) else {
            continue;
        };
        children += 1;
        if children > 64 {
            return None;
        }
        let inbox = [
            "antigravity-acp",
            "brain",
            child,
            ".system_generated",
            "messages",
        ];
        let Some(dir) = managed_dir(profile, &inbox) else {
            continue;
        };
        let mut count = 0;
        for message in dir.read_dir().ok()? {
            let message = message.ok()?;
            let file = message.file_name();
            let file = file.to_str()?;
            if file == "read.json" || !file.ends_with(".json") {
                continue;
            }
            count += 1;
            if count > 256 {
                return None;
            }
            let path = managed_file(profile, &[inbox.as_slice(), &[file]].concat())?;
            total_bytes += path.metadata().ok()?.len();
            if total_bytes > SCAN_BYTES as u64 {
                return None;
            }
            let message = read_json(&path)?;
            let meta = &message["sourceMetadata"]["tool"];
            let call = &meta["toolCall"];
            if message["sender"] != session
                || meta["conversationId"]
                    .as_str()
                    .is_some_and(|s| s != session)
                || call["id"] != task
                || !matches!(call["name"].as_str(), Some("invoke_subagent" | "swarm"))
            {
                continue;
            }
            let desc = read_json(&managed_file(
                profile,
                &[parent.as_slice(), &[name]].concat(),
            )?)?;
            if desc["conversationId"].as_str().is_some_and(|s| s != child) {
                return None;
            }
            let args: Value = call["argumentsJson"]
                .as_str()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            let descriptor = desc["subagentDescriptor"]["role"].as_str().unwrap_or("");
            let label = descriptor
                .strip_prefix("Swarm Worker (")
                .and_then(|v| v.strip_suffix(')'))
                .map(|n| format!("@{n}"));
            let role = label
                .or_else(|| args["Role"].as_str().map(str::to_owned))
                .unwrap_or_else(|| descriptor.into());
            let prompt = args["Prompt"]
                .as_str()
                .or_else(|| message["content"].as_str())
                .unwrap_or("");
            found.push(Child {
                role,
                prompt: prompt.into(),
                id: child.into(),
                log: None,
            });
            is_swarm &= call["name"] == "swarm";
            break;
        }
    }
    if found.is_empty() || found.len() > 1 && !is_swarm {
        return None;
    }
    found.sort_by(|a, b| a.role.cmp(&b.role));
    Some(found)
}

fn project(profile: &Path, children: Vec<Child>) -> Vec<Value> {
    let cap = (512 * 1024 / children.len()).min(256 * 1024);
    children.into_iter().map(|child|{
        let (steps,truncated)=transcript(profile,&child,cap).map_or((None,false),|(steps,truncated)|(Some(steps),truncated));
        json!({"conversationId":child.id,"role":child.role,"prompt":child.prompt,"steps":steps,"truncated":truncated})
    }).collect()
}

fn query(
    profile: &Path,
    session: &str,
    task: &str,
    launch: &Value,
    siblings: &[Value],
) -> Option<Vec<Value>> {
    if !native_id(session) {
        return None;
    }
    if let Some(children) = detached(profile, session, task) {
        return Some(project(profile, children));
    }
    let db = database(profile, session)?;
    let planner = |id: &str| {
        let (prefix, idx) = id.rsplit_once(':')?;
        let idx = idx.parse::<i64>().ok()?;
        Some(if prefix == session { idx } else { -1 })
    };
    let idx = planner(task);
    let (call, after) = if let Some(idx) = idx {
        if idx < 0 {
            return None;
        }
        let calls = planner_ids(&db, idx)?;
        if calls.len() != 1 {
            return None;
        }
        (calls.into_iter().next(), idx)
    } else {
        (None, -1)
    };
    let mut claimed = Vec::new();
    if call.is_none() {
        for sibling in siblings {
            if launch["title"] == sibling["title"] && launch["prompt"] == sibling["prompt"] {
                return None;
            }
            match planner(sibling["nativeTaskId"].as_str()?) {
                Some(id) if id >= 0 => claimed.extend(planner_ids(&db, id)?),
                None if sibling["title"] == BATCH
                    || sibling["title"]
                        .as_str()
                        .is_some_and(|t| t.contains("[Earlier output truncated]"))
                    || sibling["prompt"]
                        .as_str()
                        .is_some_and(|t| t.contains("[Earlier output truncated]")) =>
                {
                    return None;
                }
                _ => {}
            }
        }
    }
    let (rows,size,largest,unknown):(i64,i64,i64,i64)=db.query_row("SELECT count(*),coalesce(sum(length(step_payload)),0),coalesce(max(length(step_payload)),0),coalesce(sum(step_format!=0),0) FROM steps WHERE step_type=127 AND idx>?1",[after],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).ok()?;
    if rows > MAX_ROWS || size > SCAN_BYTES || largest > STEP_BYTES || unknown > 0 {
        return None;
    }
    let mut statement = db
        .prepare(
            "SELECT step_payload FROM steps WHERE step_type=127 AND idx>?1 ORDER BY idx LIMIT 200",
        )
        .ok()?;
    let mut rows = statement.query([after]).ok()?;
    let mut found = None;
    while let Some(row) = rows.next().ok()? {
        let bytes: Vec<u8> = row.get(0).ok()?;
        let (record, children) = decode_record(&bytes)?;
        let matched = if let Some(call) = &call {
            record.as_ref() == Some(call)
        } else {
            let (title, prompt) = describe(&children);
            !record.as_ref().is_some_and(|r| claimed.contains(r))
                && launch["title"] == title
                && launch["prompt"] == prompt
        };
        if matched && found.replace(children).is_some() {
            return None;
        }
    }
    let children = found?;
    Some(project(profile, children))
}

fn transcript(profile: &Path, child: &Child, cap: usize) -> Option<(Vec<Value>, bool)> {
    let path = managed_file(
        profile,
        &[
            "antigravity-acp",
            "brain",
            &child.id,
            ".system_generated",
            "logs",
            "transcript.jsonl",
        ],
    )?;
    if let Some(uri) = &child.log
        && Path::new(uri.strip_prefix("file://")?)
            .canonicalize()
            .ok()?
            != path
    {
        return None;
    }
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(cap as u64);
    f.seek(SeekFrom::Start(start.saturating_sub(1))).ok()?;
    let mut bytes = Vec::new();
    f.take(cap as u64 + 1).read_to_end(&mut bytes).ok()?;
    let data = if start > 0 {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .and_then(|i| bytes.get(i + 1..))
            .unwrap_or(&[])
    } else {
        &bytes
    };
    let mut steps = Vec::new();
    for line in data.split(|b| *b == b'\n') {
        let Ok(step) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let (Some(index), Some(kind)) = (step["step_index"].as_u64(), step["type"].as_str()) else {
            continue;
        };
        if index == 0
            && kind == "SYSTEM_MESSAGE"
            && !child.prompt.trim().is_empty()
            && step["content"]
                .as_str()
                .is_some_and(|c| c.contains(child.prompt.trim()))
        {
            continue;
        }
        let bounded = |s: &str, max: usize| {
            let mut chars = s.chars();
            let mut text: String = chars.by_ref().take(max).collect();
            if chars.next().is_some() {
                text.push('…')
            }
            text
        };
        let tools: Vec<_> = step["tool_calls"]
            .as_array()
            .iter()
            .flat_map(|a| a.iter())
            .filter_map(|t| {
                let name = t["name"].as_str()?;
                let mut args = t.get("args").cloned().unwrap_or_else(|| json!({}));
                if let Some(fields) = args.as_object_mut() {
                    for value in fields.values_mut() {
                        if let Some(parsed) =
                            value.as_str().and_then(|s| serde_json::from_str(s).ok())
                        {
                            *value = parsed
                        }
                    }
                }
                Some(json!({"name":name,"input":bounded(&args.to_string(),1000)}))
            })
            .collect();
        steps.push(json!({"index":index,"type":kind,"status":step["status"],"text":step["content"].as_str().or_else(||step["error"].as_str()).map(|s|bounded(s,4000)),"toolCalls":tools}));
    }
    Some((steps, start > 0))
}

pub(crate) fn children(
    profile: &Path,
    session: &str,
    task: &str,
    launch: &Value,
    siblings: &[Value],
) -> Vec<Value> {
    query(profile, session, task, launch, siblings).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn test_folder() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "conn-acp-children-{}",
            conn_provider_support::ids::Env::uuid(&mut conn_provider_support::ids::SystemEnv)
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }
    fn write(root: &Path, relative: &str, bytes: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    #[test]
    fn detached_children_require_the_matching_native_parent_and_call() {
        let dir = test_folder();
        write(
            &dir,
            "antigravity-acp/brain/root/.system_generated/subagents/child.json",
            r#"{"conversationId":"child","subagentDescriptor":{"role":"researcher"}}"#,
        );
        write(
            &dir,
            "antigravity-acp/brain/child/.system_generated/messages/1.json",
            r#"{"sender":"root","content":"Inspect the build","sourceMetadata":{"tool":{"conversationId":"root","toolCall":{"name":"invoke_subagent","id":"call"}}}}"#,
        );
        write(
            &dir,
            "antigravity-acp/brain/child/.system_generated/logs/transcript.jsonl",
            r#"{"step_index":1,"type":"PLANNER_RESPONSE","content":"Finished"}"#,
        );
        let result = children(&dir, "root", "call", &Value::Null, &[]);
        assert_eq!(result[0]["role"], "researcher");
        assert_eq!(result[0]["steps"][0]["text"], "Finished");
        assert!(children(&dir, "other", "call", &Value::Null, &[]).is_empty());
        assert!(children(&dir, "root", "other", &Value::Null, &[]).is_empty());
        assert!(children(&dir, "../root", "call", &Value::Null, &[]).is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn last_turn_error_cannot_leak_into_the_next_turn() {
        let dir = test_folder();
        let parent = dir.join("antigravity-acp/conversations");
        std::fs::create_dir_all(&parent).unwrap();
        let db = Connection::open(parent.join("root.db")).unwrap();
        db.execute_batch("create table steps(idx integer,step_type integer,step_payload blob); insert into steps values(1,17,cast('Error 503, Message: unavailable' as blob))").unwrap();
        let boundary = last_step(&dir, "root").unwrap();
        assert_eq!(boundary, 1);
        assert!(terminal_error(&dir, "root", boundary).is_none());
        assert!(terminal_error(&dir, "root", -1).unwrap().contains("503"));
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn inbox(root: &Path, session: &str, budget: &mut u64) -> Option<Vec<Value>> {
    let parts = [
        "antigravity-acp",
        "brain",
        session,
        ".system_generated",
        "messages",
    ];
    let Some(dir) = managed_dir(root, &parts) else {
        return Some(Vec::new());
    };
    let mut messages = Vec::new();
    for entry in dir.read_dir().ok()? {
        let name = entry.ok()?.file_name();
        let file = name.to_str()?;
        if file == "read.json" || !file.ends_with(".json") {
            continue;
        }
        if messages.len() == 256 {
            return None;
        }
        let path = managed_file(root, &[parts.as_slice(), &[file]].concat())?;
        *budget = budget.checked_sub(path.metadata().ok()?.len())?;
        messages.push(read_json(&path)?);
    }
    Some(messages)
}

pub(crate) fn active_children(profile: &Path, root: &str, ids: &[String]) -> Vec<String> {
    use std::collections::HashSet;
    let inspect = || {
        if !native_id(root) || ids.is_empty() {
            return None;
        }
        let mut budget = SCAN_BYTES as u64;
        let reported: HashSet<String> = inbox(profile, root, &mut budget)?
            .into_iter()
            .filter_map(|m| m["sender"].as_str().map(str::to_owned))
            .collect();
        let parts = [
            "antigravity-acp",
            "brain",
            root,
            ".system_generated",
            "subagents",
        ];
        let dir = managed_dir(profile, &parts)?;
        let swarm = managed_file(
            profile,
            &[
                "antigravity-acp",
                "brain",
                root,
                ".system_generated",
                "swarm",
                "members.json",
            ],
        )
        .and_then(|p| read_json(&p))
        .unwrap_or(Value::Null);
        let mut matches = HashSet::new();
        let mut count = 0;
        for entry in dir.read_dir().ok()? {
            let entry = entry.ok()?;
            let file = entry.file_name();
            let file = file.to_str()?;
            let Some(child) = file.strip_suffix(".json").filter(|c| native_id(c)) else {
                continue;
            };
            count += 1;
            if count > 64 {
                return None;
            }
            if reported.contains(child) {
                continue;
            }
            let desc = read_json(&managed_file(
                profile,
                &[parts.as_slice(), &[file]].concat(),
            )?)?;
            if desc["state"] == "SUBAGENT_STATE_KILLED" {
                continue;
            }
            if swarm["members"].as_object().is_some_and(|m| {
                m.values().any(|s| {
                    s["conversation_id"] == child
                        && (s["desired_state"] == "KILLED"
                            || s["phase"] == "KILLED"
                            || s["phase"] == "PARKED")
                })
            }) {
                continue;
            }
            let direct = format!("swarm:{child}");
            if ids.contains(&direct) {
                matches.insert(direct);
            }
            for msg in inbox(profile, child, &mut budget)? {
                let meta = &msg["sourceMetadata"]["tool"];
                let call = &meta["toolCall"];
                if msg["sender"] == root
                    && meta["conversationId"].as_str().is_none_or(|s| s == root)
                    && matches!(call["name"].as_str(), Some("invoke_subagent" | "swarm"))
                    && let Some(id) = call["id"].as_str()
                    && ids.iter().any(|s| s == id)
                {
                    matches.insert(id.to_owned());
                }
            }
        }
        Some(matches.into_iter().collect())
    };
    inspect().unwrap_or_default()
}
