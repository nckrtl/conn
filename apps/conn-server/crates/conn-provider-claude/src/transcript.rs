//! Check a warm query's last emitted messages against recent root transcript entries.
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub(super) fn extended(root: &Path, native: &str, emitted: &VecDeque<String>) -> Option<bool> {
    if emitted.is_empty()
        || native.is_empty()
        || !native
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    let name = format!("{native}.jsonl");
    let path = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path().join(&name);
            let meta = path.metadata().ok()?;
            meta.is_file().then_some((meta.modified().ok()?, path))
        })
        .max_by_key(|(mtime, _)| *mtime)?
        .1;
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    for cap in [2 * 1024 * 1024, 32 * 1024 * 1024] {
        let start = size.saturating_sub(cap);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(size - start)
            .read_to_end(&mut bytes)
            .ok()?;
        let mut lines = bytes.split(|b| *b == b'\n');
        lines.next_back();
        if start != 0 {
            lines.next();
        }
        let mut unseen = None;
        let mut refusal = false;
        for line in lines {
            let Ok(row) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if !matches!(row["type"].as_str(), Some("user" | "assistant"))
                || row["message"]["content"].is_null()
            {
                continue;
            }
            let Some(uuid) = row["uuid"].as_str() else {
                continue;
            };
            if emitted.iter().any(|id| id == uuid) {
                unseen = Some(false);
                refusal = false;
                continue;
            }
            if unseen.is_none()
                || row["isMeta"] == true
                || row["isSidechain"] == true
                || row["isCompactSummary"] == true
            {
                continue;
            }
            let content = &row["message"]["content"];
            let interrupted = |text: &str| {
                matches!(
                    text,
                    "[Request interrupted by user]" | "[Request interrupted by user for tool use]"
                )
            };
            let stop = row["type"] == "user"
                && (content.as_str().is_some_and(interrupted)
                    || content.as_array().is_some_and(|v| {
                        !v.is_empty()
                            && v.iter()
                                .all(|b| b["text"].as_str().is_some_and(interrupted))
                    }));
            if stop {
                refusal = false;
                continue;
            }
            if row["type"] == "user"
                && content.as_array().is_some_and(|v| {
                    !v.is_empty()
                        && v.iter().all(|b| {
                            b["type"] == "tool_result"
                                && b["is_error"] == true
                                && b["content"].as_str().is_some_and(|s| {
                                    s.starts_with(
                                        "The user doesn't want to proceed with this tool use.",
                                    )
                                })
                        })
                })
            {
                refusal = true;
                continue;
            }
            unseen = Some(true);
        }
        if let Some(unseen) = unseen {
            return Some(unseen || refusal);
        }
        if start == 0 {
            break;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_a_new_root_message_after_a_known_anchor_restarts_the_query() {
        let root =
            std::env::temp_dir().join(format!("conn-transcript-{}", conn_support::uuid_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let entry = |id: &str| json!({"type":"user","uuid":id,"message":{"content":"test"}});
        let mut external = entry("external");
        external["isSidechain"] = json!(true);
        let mut lines = vec![entry("old"), entry("seen"), external];
        let emitted = VecDeque::from(["seen".to_owned()]);
        let write = |rows: &[Value]| {
            std::fs::write(
                repo.join("native.jsonl"),
                rows.iter().map(|v| format!("{v}\n")).collect::<String>(),
            )
            .unwrap()
        };
        write(&lines);
        assert_eq!(extended(&root, "native", &emitted), Some(false));
        lines.push(entry("terminal"));
        write(&lines);
        assert_eq!(extended(&root, "native", &emitted), Some(true));
        std::fs::remove_dir_all(root).unwrap();
    }
}
