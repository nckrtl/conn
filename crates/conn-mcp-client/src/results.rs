//! How the panel reads a call's result (the pure parts of Conn's `McpCatalogViews.tsx`).

use serde_json::Value;

/// The text pretty-printed when it is a JSON object or array, else `None`.
pub fn pretty_json(text: &str) -> Option<String> {
    if !text.trim_start().starts_with(['{', '[']) {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    serde_json::to_string_pretty(&value).ok()
}

/// The blocks a result lists: content, a resource's contents, or prompt messages' content.
pub fn result_blocks(result: &Value) -> Vec<Value> {
    if let Some(Value::Array(content)) = result.get("content") {
        return content.clone();
    }
    if let Some(Value::Array(contents)) = result.get("contents") {
        return contents.clone();
    }
    if let Some(Value::Array(messages)) = result.get("messages") {
        return messages
            .iter()
            .map(|message| message.get("content").cloned().unwrap_or(Value::Null))
            .collect();
    }
    Vec::new()
}

/// A block's text, or its embedded resource's text.
pub fn block_text(block: &Value) -> Option<&str> {
    block
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| block.get("resource")?.get("text")?.as_str())
}

/// The result's text as the server sent it, for copying.
pub fn raw_result_text(result: &Value) -> String {
    let blocks = result_blocks(result);
    let texts: Vec<&str> = blocks.iter().filter_map(block_text).collect();
    if texts.is_empty() {
        serde_json::to_string_pretty(result).unwrap_or_default()
    } else {
        texts.join("\n\n")
    }
}

/// True when a text block would render as Markdown, so raw and formatted views differ.
pub fn has_markdown(result: &Value) -> bool {
    result_blocks(result)
        .iter()
        .filter_map(block_text)
        .any(|text| pretty_json(text).is_none())
}

/// Rounds half away from zero on the exact value and writes `digits` decimals.
fn fixed(value: f64, digits: usize) -> String {
    let scale = 10f64.powi(i32::try_from(digits).unwrap_or(0));
    let scaled = value * scale;
    if scaled.fract().abs() == 0.5 && scaled / scale == value {
        return format!("{:.digits$}", scaled.round() / scale);
    }
    format!("{value:.digits$}")
}

fn format_number(value: f64, digits: usize) -> String {
    let text = fixed(value, digits);
    let (sign, unsigned) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text.as_str()),
    };
    let (whole, fraction) = match unsigned.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (unsigned, None),
    };
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, ch) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    let sign = if grouped.chars().all(|c| c == '0')
        && fraction.is_none_or(|f| f.chars().all(|c| c == '0'))
    {
        ""
    } else {
        sign
    };
    match fraction {
        Some(fraction) => format!("{sign}{grouped}.{fraction}"),
        None => format!("{sign}{grouped}"),
    }
}

/// Three significant digits up to a minute, as `4.27 ms`, `245 ms` or `30.2 s`.
pub fn format_ms(value: f64) -> String {
    if value < 10.0 {
        return format!("{} ms", format_number(value, 2));
    }
    if value < 100.0 {
        return format!("{} ms", format_number(value, 1));
    }
    if value < 999.5 {
        return format!("{} ms", format_number(value, 0));
    }
    let seconds = value / 1000.0;
    if seconds < 9.995 {
        return format!("{} s", format_number(seconds, 2));
    }
    if seconds < 59.95 {
        return format!("{} s", format_number(seconds, 1));
    }
    let rounded = (seconds + 0.5).floor();
    let minutes = (rounded / 60.0).floor();
    let rest = rounded % 60.0;
    if minutes < 60.0 && rest > 0.0 {
        format!("{minutes} min {rest} s")
    } else {
        format!("{} min", format_number(minutes, 0))
    }
}

/// `512 B`, `9.97 KB`, `1.50 MB`, `-13.83 KB`.
pub fn format_bytes(value: i64) -> String {
    let size = value.unsigned_abs();
    let sign = if value < 0 { "-" } else { "" };
    const KB: u64 = 1024;
    #[expect(
        clippy::cast_precision_loss,
        reason = "byte counts far below 2^53; JavaScript numbers are f64 too"
    )]
    let size_f = size as f64;
    if size >= KB.pow(3) {
        format!("{sign}{} GB", fixed(size_f / (KB.pow(3) as f64), 2))
    } else if size >= KB.pow(2) {
        format!("{sign}{} MB", fixed(size_f / 1024.0 / 1024.0, 2))
    } else if size >= KB {
        format!("{sign}{} KB", fixed(size_f / 1024.0, 2))
    } else {
        format!("{sign}{size} B")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_results() {
        let result = json!({ "content": [
            { "type": "text", "text": "{\"a\":1}" },
            { "type": "resource", "resource": { "uri": "x", "text": "# Hi" } },
            { "type": "image", "data": "AA", "mimeType": "image/png" }
        ]});
        assert_eq!(raw_result_text(&result), "{\"a\":1}\n\n# Hi", "raw text");
        assert!(has_markdown(&result), "markdown");
        assert_eq!(
            pretty_json("{\"a\":1}").as_deref(),
            Some("{\n  \"a\": 1\n}"),
            "pretty"
        );
        assert_eq!(pretty_json("12"), None, "not an object");
        let prompt = json!({ "messages": [{ "role": "user", "content": { "type": "text", "text": "hi" } }] });
        assert_eq!(raw_result_text(&prompt), "hi", "prompt");
        assert_eq!(raw_result_text(&json!({})), "{}", "fallback");
    }
}
