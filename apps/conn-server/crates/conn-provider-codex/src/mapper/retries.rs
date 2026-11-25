//! Native retry notifications keep a single timeline row until output resumes or the turn ends.
use super::{
    DRIVER, Out, Turn, Value, error_info_code, failure_json, ids, json, push_event, trimmed,
    usage_limit,
};
use std::time::Duration;
use tokio::time::Instant;

pub(super) struct Retry {
    pub deadline: Instant,
    pub error: Value,
    row: Value,
}

impl Retry {
    pub(super) fn new(turn: &mut Turn, at: &str) -> Self {
        let mut key = format!("terminal-failure:{}", turn.provider_turn_id);
        if turn.recovered_retries != 0 {
            key.push_str(&format!(":{}", turn.recovered_retries));
        }
        let (ordinal, started_at) = turn.position(&key, at.to_owned());
        Self {
            deadline: Instant::now() + Duration::from_secs(600),
            error: Value::Null,
            row: json!({
                "id":ids::turn_item_from_item(DRIVER, &key),"type":"error","status":"running",
                "threadId":turn.thread_id,"runId":turn.run_id,"nodeId":turn.root_node_id,
                "providerThreadId":turn.provider_thread_id,"providerTurnId":turn.provider_turn_id,
                "nativeItemRef":null,"parentItemId":null,"ordinal":ordinal,"startedAt":started_at,
                "completedAt":null,"title":"Provider retry"
            }),
        }
    }

    pub(super) fn notice(&mut self, error: &Value, now: &str, out: &mut Vec<Out>) {
        self.error = error.clone();
        let message = error["message"].as_str().unwrap_or_default();
        let (attempt, max) = progress(message).map_or_else(
            || {
                (
                    self.row["retry"]["attempt"]
                        .as_i64()
                        .unwrap_or_default()
                        .saturating_add(1),
                    None,
                )
            },
            |(attempt, max)| (attempt, Some(max)),
        );
        self.row["retry"] = json!({"attempt":attempt,"maxAttempts":max,"retryDelayMs":null});
        self.row["failure"] = retry_failure(error, true);
        self.row["updatedAt"] = json!(now);
        push_event(out, json!({"type":"turn_item.updated","turnItem":self.row}));
    }

    pub(super) fn end(
        mut self,
        status: &str,
        now: &str,
        failure: Option<&Value>,
        out: &mut Vec<Out>,
    ) {
        if let Some(failure) = failure {
            self.row["failure"] = failure.clone();
        }
        let title = match status {
            "completed" => "Provider recovered",
            "failed" if self.row["failure"]["class"] == "usage_limit" => "Usage limit reached",
            "failed" => "Provider error",
            _ => "Provider retry stopped",
        };
        self.row["status"] = json!(status);
        self.row["title"] = json!(title);
        self.row["completedAt"] = json!(now);
        self.row["updatedAt"] = json!(now);
        push_event(out, json!({"type":"turn_item.updated","turnItem":self.row}));
    }
}

pub(super) fn retry_failure(error: &Value, retryable: bool) -> Value {
    let info = &error["codexErrorInfo"];
    let code = error_info_code(info);
    let message = trimmed(&error["additionalDetails"]).unwrap_or_else(|| {
        error["message"]
            .as_str()
            .unwrap_or("Codex stopped making progress during a retry.")
            .to_owned()
    });
    let class = if usage_limit(code.as_deref(), info)
        || info
            .as_object()
            .is_some_and(|o| o.values().any(|v| v["httpStatusCode"] == 429))
    {
        "usage_limit"
    } else if code
        .as_deref()
        .is_some_and(|c| c.starts_with("http") || c.starts_with("responseStream"))
    {
        "transport_error"
    } else {
        "provider_error"
    };
    failure_json(class, &message, code.as_deref(), Some(retryable))
}

// Native messages can include an attempt such as "Reconnecting... 2 / 5".
fn progress(message: &str) -> Option<(i64, i64)> {
    for (slash, _) in message.match_indices('/') {
        let left = message[..slash].trim_end();
        let right = message[slash + 1..].trim_start();
        let prefix = left.trim_end_matches(|c: char| c.is_ascii_digit());
        let suffix = right.trim_start_matches(|c: char| c.is_ascii_digit());
        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        if prefix.ends_with(word) || suffix.starts_with(word) {
            continue;
        }
        if let (Ok(attempt), Ok(max)) = (
            left[prefix.len()..].parse::<i64>(),
            right[..right.len() - suffix.len()].parse::<i64>(),
        ) && attempt > 0
            && max > 0
        {
            return Some((attempt, max));
        }
    }
    None
}
