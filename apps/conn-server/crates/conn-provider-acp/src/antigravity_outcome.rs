//! Translate the last native error step of this prompt into a user-facing failure.
use regex_automata::meta::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

#[derive(Debug, Clone)]
pub(crate) struct Failure {
    pub(crate) detail: Value,
    pub(crate) disposition: &'static str,
    pub(crate) resume: bool,
}

static INVALID_SIGNATURE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)").expect("valid Antigravity error pattern")
});
static ERROR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Error (\d{3}), Message: ([^\p{Cc}]*?), Status: ([A-Z_]+|\d{3}[^,\p{Cc}]*)")
        .expect("valid Antigravity error pattern")
});
static STATUS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([A-Z_]+) \(code (\d{3})\): ([^\p{Cc}]+)")
        .expect("valid Antigravity error pattern")
});
static RESET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:quotaResetDelay:|retryDelay:|Resets in )((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)").expect("valid Antigravity error pattern")
});
static DURATION_PART: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)").expect("valid Antigravity error pattern")
});
static JSON_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\{\s*"error"\s*:"#).expect("valid Antigravity error pattern"));

fn group<'a>(
    text: &'a str,
    captures: &regex_automata::util::captures::Captures,
    i: usize,
) -> Option<&'a str> {
    text.get(captures.get_group(i)?.range())
}

fn error_status(text: &str) -> Option<(u16, &str, &str)> {
    for (pattern, indices) in [(&*ERROR, [1, 2, 3]), (&*STATUS, [2, 3, 1])] {
        let mut c = pattern.create_captures();
        pattern.captures(text, &mut c);
        if let (Some(code), Some(msg), Some(status)) = (
            group(text, &c, indices[0]),
            group(text, &c, indices[1]),
            group(text, &c, indices[2]),
        ) && let Ok(code) = code.parse()
        {
            return Some((code, msg.trim(), status.trim()));
        }
    }
    None
}

fn reset_time(text: &str, now_ms: u64) -> Option<String> {
    if let Some((_, tail)) = text.split_once("quotaResetTimeStamp:")
        && let Some(t) = tail.split(|c: char| c.is_whitespace() || c == ']').next()
        && let Some(ms) = conn_support::time::millis_from_iso(t)
    {
        return Some(conn_support::time::iso_from_millis(ms));
    }
    let mut c = RESET.create_captures();
    RESET.captures(text, &mut c);
    let duration = group(text, &c, 1)?;
    let mut ms = 0.;
    for part in DURATION_PART.captures_iter(duration) {
        let n: f64 = group(duration, &part, 1)?.parse().ok()?;
        ms += n * match group(duration, &part, 2)? {
            "h" => 3_600_000.,
            "m" => 60_000.,
            "s" => 1000.,
            "ms" => 1.,
            "ns" => 0.000001,
            _ => 0.001,
        };
    }
    (ms > 0. && ms < i64::MAX as f64)
        .then(|| conn_support::time::iso_from_ms(now_ms.saturating_add(ms as u64)))
}

fn verification(text: &str) -> Option<Option<String>> {
    for start in JSON_START.find_iter(text) {
        let Some(Ok(json)) = serde_json::Deserializer::from_str(&text[start.start()..])
            .into_iter::<Value>()
            .next()
        else {
            continue;
        };
        let e = &json["error"];
        if e["code"] != 403 || e["status"] != "PERMISSION_DENIED" {
            continue;
        }
        let Some(info) = e["details"].as_array().and_then(|a| {
            a.iter().find(|i| {
                i["@type"] == "type.googleapis.com/google.rpc.ErrorInfo"
                    && i["domain"] == "cloudcode-pa.googleapis.com"
                    && i["reason"] == "VALIDATION_REQUIRED"
            })
        }) else {
            continue;
        };
        let url = info["metadata"]["validation_url"].as_str().filter(|url| {
            let query = url
                .strip_prefix("https://accounts.google.com/signin/continue?")
                .or_else(|| url.strip_prefix("https://accounts.google.com/v3/signin/continue?"));
            url.len() <= 4096
                && query.is_some_and(|q| {
                    !q.is_empty()
                        && !q
                            .chars()
                            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '\\' | '#'))
                })
        });
        return Some(url.map(str::to_owned));
    }
    None
}

pub(crate) fn classify(text: &str, refusal: bool, reached_model: bool, now_ms: u64) -> Failure {
    let status = error_status(text);
    let mut disposition = "reusable";
    let mut detail = if refusal || text.contains("reason:QUOTA_EXHAUSTED") {
        json!({"class":"usage_limit","code":status.map(|s|s.2).unwrap_or("QUOTA_EXHAUSTED"),"message":"You have reached your Antigravity quota for this period.","retryable":true})
    } else if INVALID_SIGNATURE.is_match(text) {
        disposition = "broken";
        json!({"class":"provider_error","code":"INVALID_THINKING_SIGNATURE","message":"Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.","retryable":true})
    } else if let Some(url) = verification(text) {
        let mut error = json!({"class":"permission_error","code":"VALIDATION_REQUIRED","message":"Verify your Google account, then retry this turn.","retryable":false});
        if let Some(url) = url {
            error["verificationUrl"] = json!(url);
        }
        error
    } else if let Some((http, message, code)) = status {
        let limited = http == 429 || code == "RESOURCE_EXHAUSTED";
        let class = if limited {
            "usage_limit"
        } else {
            "provider_error"
        };
        json!({"class":class, "code":conn_provider_support::redact::bounded(code,128),
            "message":conn_provider_support::redact::bounded(message,4096),
            "retryable":limited || (http == 404 && reached_model) || http >= 500})
    } else {
        json!({"class":"provider_error","code":null,"message":"Antigravity stopped this turn because of an error.","retryable":null})
    };
    if detail["class"] == "usage_limit"
        && let Some(at) = reset_time(text, now_ms)
    {
        detail["resetAt"] = json!(at);
    }
    let detail_is_retryable = detail["retryable"] == true
        && detail["class"] == "provider_error"
        && disposition == "reusable";
    Failure {
        detail,
        disposition,
        resume: !refusal
            && reached_model
            && status.is_some_and(|s| s.0 == 404)
            && detail_is_retryable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_native_steps_without_leaking_diagnostics() {
        let quota = classify(
            "RESOURCE_EXHAUSTED (code 429): Slow down. Resets in 4m42s.\0private stack",
            false,
            false,
            0,
        );
        assert_eq!(quota.detail["resetAt"], "1970-01-01T00:04:42.000Z");
        assert!(!quota.detail.to_string().contains("private"));
        assert_eq!(
            classify(
                "messages.0.content.2.thinking.signature: Field required",
                false,
                false,
                0
            )
            .disposition,
            "broken"
        );
        let verify = r#"{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","domain":"cloudcode-pa.googleapis.com","reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/signin/continue?x=1"}}]}}"#;
        assert_eq!(
            classify(verify, false, false, 0).detail["verificationUrl"],
            "https://accounts.google.com/signin/continue?x=1"
        );
        assert_eq!(
            classify(
                "Error 404, Message: missing, Status: NOT_FOUND",
                false,
                true,
                0
            )
            .detail["retryable"],
            true
        );
        assert_eq!(
            classify("sensitive native diagnostics", false, false, 0).detail["message"],
            "Antigravity stopped this turn because of an error."
        );
    }
}
