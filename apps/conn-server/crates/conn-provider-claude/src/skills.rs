//! Claude's native directory skills and composer dispatch.
use crate::launch_args;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

pub(super) fn discover(home: &Path, cwd: Option<&Path>, args: &str) -> Vec<Value> {
    let mut roots = vec![(home.join("skills"), "user")];
    if let Some(cwd) = cwd {
        roots.push((cwd.join(".claude/skills"), "project"));
        roots.extend(
            launch_args::add_dirs(args)
                .into_iter()
                .map(|dir| (cwd.join(dir).join(".claude/skills"), "project")),
        );
    }
    let overrides = std::fs::read(home.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let mut found = BTreeMap::new();
    for (root, scope) in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten().take(2048) {
            let Some(name) = entry.file_name().into_string().ok().filter(|n| {
                n.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':'))
            }) else {
                continue;
            };
            if found.contains_key(&name) {
                continue;
            }
            let path = entry.path().join("SKILL.md");
            let Ok(file) = File::open(&path) else {
                continue;
            };
            if !file.metadata().is_ok_and(|m| m.is_file()) {
                continue;
            }
            let mut header = String::new();
            if file.take(32 * 1024).read_to_string(&mut header).is_err() {
                continue;
            }
            let mut skill = json!({"name":name,"path":path,"scope":scope,"enabled":true});
            let mut lines = header.lines();
            if lines.next() == Some("---") {
                for line in lines.take_while(|s| s.trim_end() != "---") {
                    let Some((key, value)) = line.split_once(':') else {
                        continue;
                    };
                    let value = value.trim().trim_matches(['\'', '"']);
                    match key {
                        "description" if !value.is_empty() => skill["description"] = json!(value),
                        "disable-model-invocation" if value == "true" => {
                            skill["userInvocationOnly"] = json!(true)
                        }
                        "user-invocable" if value == "false" => {
                            skill["userInvocable"] = json!(false)
                        }
                        _ => {}
                    }
                }
            }
            if let Some(value) = overrides
                .as_ref()
                .and_then(|v| v["skillOverrides"].get(&name))
            {
                match value.as_str() {
                    Some("off") => skill["enabled"] = json!(false),
                    Some("user-invocable-only") => skill["userInvocationOnly"] = json!(true),
                    _ => {}
                }
            }
            found.insert(name, skill);
        }
    }
    found.into_values().collect()
}

pub(super) fn dispatch(text: &str, skills: &[Value]) -> Option<(Option<String>, String)> {
    let mut mentions = Vec::new();
    for (at, c) in text.char_indices() {
        if c != '$' || at != 0 && !text.get(..at)?.ends_with(char::is_whitespace) {
            continue;
        }
        let start = at + c.len_utf8();
        let name = text.get(start..)?.split_whitespace().next()?;
        if name.is_empty() || !text.get(start..)?.starts_with(name) {
            continue;
        }
        if let Some(skill) = skills
            .iter()
            .find(|s| s["name"] == name && s["enabled"] == true && s["userInvocable"] != false)
        {
            mentions.push((at, start + name.len(), name, skill));
        }
    }
    let &(last, tail, name, _) = mentions.last()?;
    let mut seen = HashSet::from([name]);
    let mut full = String::new();
    let mut cursor = 0;
    for (at, end, name, skill) in mentions {
        full.push_str(text.get(cursor..at)?);
        full.push('/');
        full.push_str(name);
        if skill["userInvocationOnly"] == true
            && seen.insert(name)
            && let Some(path) = skill["path"].as_str()
        {
            full.push_str(&format!(
                " [The user invoked this skill. Follow the instructions at: {path}]"
            ));
        }
        cursor = end;
    }
    full.push_str(text.get(cursor..)?);
    Some((
        (!text.get(..last)?.trim().is_empty()).then(|| full.trim_end().to_owned()),
        format!("/{name}{}", text.get(tail..)?)
            .trim_end()
            .to_owned(),
    ))
}

pub(super) async fn list(home: PathBuf, cwd: Option<String>, args: String) -> Vec<Value> {
    tokio::task::spawn_blocking(move || discover(&home, cwd.as_deref().map(Path::new), &args))
        .await
        .unwrap_or_default()
}
