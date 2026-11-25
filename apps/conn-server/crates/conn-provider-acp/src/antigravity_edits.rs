//! Locate native replacement chunks in the pre-edit file before reporting a review hunk.
use serde_json::{Value, json};
use std::io::Read;
use std::path::Path;

fn field<'a>(v: &'a Value, pascal: &str, snake: &str) -> &'a Value {
    v.get(pascal).unwrap_or(&v[snake])
}

fn located_patch(path: &Path, input: &Value, cwd: &Path, pending: bool) -> Option<String> {
    use std::fmt::Write;
    let chunks = field(input, "ReplacementChunks", "replacement_chunks")
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(std::slice::from_ref(input));
    if chunks.is_empty() {
        return None;
    }
    let file = if pending
        && let Some(p) = cwd
            .join(path)
            .canonicalize()
            .ok()
            .filter(|p| cwd.canonicalize().is_ok_and(|root| p.starts_with(root)))
    {
        let mut text = String::new();
        std::fs::File::open(p)
            .ok()
            .and_then(|f| f.take(1024 * 1024 + 1).read_to_string(&mut text).ok())
            .filter(|n| *n <= 1024 * 1024)
            .map(|_| text.replace("\r\n", "\n"))
    } else {
        None
    };
    let mut placed = Vec::new();
    for chunk in chunks {
        let old = field(chunk, "TargetContent", "target_content")
            .as_str()?
            .replace("\r\n", "\n");
        let new = field(chunk, "ReplacementContent", "replacement_content")
            .as_str()?
            .replace("\r\n", "\n");
        if old.is_empty()
            || old.len() + new.len() > 8000
            || old.ends_with('\n') != new.ends_with('\n') && !new.is_empty()
            || new.is_empty() && !old.ends_with('\n')
        {
            return None;
        }
        let hinted = field(chunk, "StartLine", "start_line")
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .filter(|n| *n > 0);
        let line = if let Some(file) = &file {
            let (mut prior, mut line) = (0, 1);
            let mut matches = file
                .match_indices(&old)
                .filter_map(|(i, _)| {
                    line += file.as_bytes()[prior..i]
                        .iter()
                        .filter(|b| **b == b'\n')
                        .count();
                    prior = i;
                    let boundary = i + old.len();
                    if (i > 0 && file.as_bytes()[i - 1] != b'\n')
                        || !(old.ends_with('\n')
                            || boundary == file.len()
                            || file.as_bytes()[boundary] == b'\n')
                    {
                        return None;
                    }
                    Some(line)
                })
                .filter(|line| hinted.is_none_or(|n| n == *line));
            let line = matches.next()?;
            if matches.next().is_some() {
                return None;
            }
            line
        } else {
            hinted?
        };
        placed.push((line, old, new));
    }
    placed.sort_by_key(|(line, _, _)| *line);
    let name = path.to_string_lossy();
    let mut out = format!("--- {name}\n+++ {name}\n");
    let mut end = 0usize;
    let mut offset = 0isize;
    for (line, old, new) in placed {
        if line <= end {
            return None;
        }
        let before = old.lines().count();
        let after = new.lines().count();
        let start = line.checked_add_signed(offset)?;
        writeln!(
            out,
            "@@ -{line},{before} +{},{after} @@",
            if after == 0 {
                start.saturating_sub(1)
            } else {
                start
            }
        )
        .ok()?;
        for l in old.lines() {
            writeln!(out, "-{l}").ok()?;
        }
        for l in new.lines() {
            writeln!(out, "+{l}").ok()?;
        }
        end = line + before.saturating_sub(1);
        offset += isize::try_from(after).ok()? - isize::try_from(before).ok()?;
    }
    (out.len() <= 8000).then_some(out)
}

pub(crate) fn enrich(params: &mut Value, cwd: &Path) {
    let update = &mut params["update"];
    let input = update["rawInput"].clone();
    if field(&input, "ReplacementChunks", "replacement_chunks").is_null()
        && field(&input, "TargetContent", "target_content").is_null()
    {
        return;
    }
    let pending = update["status"] == "pending";
    let Some(content) = update["content"].as_array_mut() else {
        return;
    };
    for entry in content
        .iter_mut()
        .filter(|v| v["type"] == "diff" && v["patch"].is_null())
    {
        let patch = entry["path"]
            .as_str()
            .and_then(|p| located_patch(Path::new(p), &input, cwd, pending));
        entry["patch"] =
            patch.map_or_else(|| json!({"format":"omitted"}), |text| json!({"text":text}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snippets_use_the_pre_edit_range_and_unknown_locations_are_omitted() {
        let file = Path::new(file!()).file_name().unwrap();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let line = std::fs::read_to_string(dir.join(file))
            .unwrap()
            .lines()
            .position(|l| l == "use std::io::Read;")
            .unwrap()
            + 1;
        let input = json!({"TargetContent":"use std::io::Read;","ReplacementContent":"use std::io::Write;"});
        let patch = located_patch(Path::new(file), &input, &dir, true).unwrap();
        assert!(patch.contains(&format!("@@ -{line},1 +{line},1 @@")));
        assert!(located_patch(Path::new(file), &input, &dir, false).is_none());
    }
}
