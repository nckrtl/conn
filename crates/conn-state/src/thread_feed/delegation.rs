//! Completion wakes are user-role transport messages emitted by the server.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct DelegatedResult {
    pub task: String,
    pub title: Option<String>,
    pub state: String,
    pub body: String,
}

fn task_id(id: &str) -> bool {
    ["node:delegated-task:", "thread:delegated-task:"]
        .iter()
        .any(|prefix| id.strip_prefix(prefix).is_some_and(|tail| !tail.is_empty()))
}

struct Header<'a> {
    task: &'a str,
    title: Option<&'a str>,
    state: &'static str,
    inline: bool,
}

fn header(line: &str) -> Option<Header<'_>> {
    let (task, suffix) = line.strip_prefix("Delegated task ")?.split_once(' ')?;
    if !task_id(task) {
        return None;
    }
    let receipt = format!(". Use task_status with taskId {task} to read the result.");
    let (label, inline) = if let Some(label) = suffix.strip_suffix(':') {
        (label, true)
    } else {
        (
            suffix
                .strip_suffix(&receipt)
                .or_else(|| suffix.strip_suffix('.'))?,
            false,
        )
    };
    if label == "reached a terminal state" && !inline {
        return Some(Header {
            task,
            title: None,
            state: "Finished",
            inline,
        });
    }
    let (title, state) = label.strip_suffix(']')?.rsplit_once('[')?;
    let state = match state {
        "completed" => "Completed",
        "cancelled" => "Cancelled",
        "failed" => "Failed",
        "interrupted" => "Interrupted",
        _ => return None,
    };
    let title = match title.trim_end() {
        "" => None,
        title => Some(title.strip_prefix('(')?.strip_suffix(')')?),
    };
    Some(Header {
        task,
        title,
        state,
        inline,
    })
}

/// A receipt has zero results. An unrecognized message stays in the conversation.
pub fn completion_results(text: &str) -> Option<Vec<DelegatedResult>> {
    if let Some(ids) = text.strip_prefix("Delegated tasks ").and_then(|s| {
        s.strip_suffix(
            " reached terminal states. Use task_status with each taskId to read the results.",
        )
    }) {
        return ids.split(", ").all(task_id).then(Vec::new);
    }

    let first = header(text.lines().next()?)?;
    let mut results = Vec::new();
    let mut start = 0;
    let mut current = first;
    for (offset, _) in text.match_indices("\n\nDelegated task ") {
        let next = offset + 2;
        if let Some(candidate) = header(text[next..].lines().next()?) {
            push_result(&mut results, current, &text[start..offset])?;
            current = candidate;
            start = next;
        }
    }
    push_result(&mut results, current, &text[start..])?;
    Some(results)
}

fn push_result(
    results: &mut Vec<DelegatedResult>,
    header: Header<'_>,
    section: &str,
) -> Option<()> {
    let body = section.split_once('\n').map_or("", |(_, body)| body);
    if !body.trim().is_empty() {
        if !header.inline {
            return None;
        }
        results.push(DelegatedResult {
            task: header.task.to_owned(),
            title: header.title.map(str::to_owned),
            state: header.state.to_owned(),
            body: body.to_owned(),
        });
    }
    Some(())
}

/// Old offline rows kept the item id but discarded its actor and creation source.
pub fn cached_completion_id(id: &str, text: &str) -> bool {
    let Some(rest) = id.strip_prefix("turn-item:message:delegated-completion:") else {
        return false;
    };
    let Some((task, ordinal)) = rest.rsplit_once(':') else {
        return false;
    };
    ordinal.parse::<u64>().is_ok()
        && header(text.lines().next().unwrap_or("")).is_some_and(|h| h.task == task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batches_keep_paragraphs_and_skip_only_receipts() {
        let a = "node:delegated-task:a";
        let b = "node:delegated-task:b";
        let c = "node:delegated-task:c";
        let body =
            "**Build ready**\n\nDelegated task examples go here.\n\n[Report](https://example.org)";
        let wake = format!(
            "Delegated task {a} (QA (iOS)) [completed]:\n{body}\n\nDelegated task {b} [failed]. Use task_status with taskId {b} to read the result.\n\nDelegated task {c} [interrupted]:\nMissing input."
        );
        let results = completion_results(&wake).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title.as_deref(), Some("QA (iOS)"));
        assert_eq!(results[0].body, body);
        assert_eq!(results[1].state, "Interrupted");
        assert!(cached_completion_id(
            &format!("turn-item:message:delegated-completion:{a}:9"),
            &wake
        ));
        assert!(!cached_completion_id("user-quote", &wake));
        assert_eq!(
            completion_results(&format!(
                "Delegated tasks {a}, {b} reached terminal states. Use task_status with each taskId to read the results."
            )),
            Some(vec![])
        );
    }
}
