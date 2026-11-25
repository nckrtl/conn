//! Images and files in a user message, as `makeClaudeUserMessageWithAttachments` sends them.
//!
//! Every attachment gets a line in the text with its saved path (`attachmentPrompt.ts`), so
//! Claude can read it with its tools; the attachments folder is passed with `--add-dir`.
//! Images of a type the API takes are also sent inline as base64 blocks, before the text, while
//! the session's budget lasts. Paths follow T3's attachment store (`attachmentStore.ts`):
//! `<dir>/<id><ext>`.
//!
use std::{io::Read, path::Path};

use conn_contract::{ChatAttachment, to_json};
use serde_json::{Value, json};

/// `CLAUDE_ATTACHMENT_MAX_BYTES`: inline bytes one session may send, base64 included.
pub const BUDGET_BYTES: u64 = 28 * 1024 * 1024;

const SUPPORTED_IMAGES: &[&str] = &["image/gif", "image/jpeg", "image/png", "image/webp"];

const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("image/avif", ".avif"),
    ("image/bmp", ".bmp"),
    ("image/gif", ".gif"),
    ("image/heic", ".heic"),
    ("image/heif", ".heif"),
    ("image/jpeg", ".jpg"),
    ("image/jpg", ".jpg"),
    ("image/png", ".png"),
    ("image/svg+xml", ".svg"),
    ("image/tiff", ".tiff"),
    ("image/webp", ".webp"),
];

const SAFE_IMAGE_EXTENSIONS: &[&str] = &[
    ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tiff",
    ".webp",
];

fn extension_of(name: &str, max: usize) -> Option<String> {
    let (_, ext) = name.trim().rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= max && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| format!(".{ext}"))
}

/// `attachmentRelativePath`.
pub fn relative_path(attachment: &Value) -> Option<String> {
    let id = attachment.get("id")?.as_str()?;
    let safe_id = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe_id {
        return None;
    }
    let name = attachment.get("name").and_then(Value::as_str).unwrap_or("");
    let mime = attachment
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = match attachment.get("type")?.as_str()? {
        "image" => IMAGE_EXTENSIONS
            .iter()
            .find(|(m, _)| *m == mime)
            .map(|(_, e)| e.to_string())
            .or_else(|| {
                extension_of(name, 8).filter(|e| SAFE_IMAGE_EXTENSIONS.contains(&e.as_str()))
            })
            .unwrap_or_else(|| ".bin".into()),
        "file" => extension_of(name, 10)
            .filter(|e| e != ".part")
            .unwrap_or_else(|| ".bin".into()),
        _ => return None,
    };
    Some(format!("{id}{extension}"))
}

#[derive(Clone, Copy, Default)]
pub struct Budget {
    pub bytes: u64,
    pub pages: u64,
}

impl Budget {
    pub fn restore(thread: &Value) -> Self {
        let budget = &thread["nativeMetadata"]["claudeAttachmentBudget"];
        Self {
            bytes: budget["bytesUsed"].as_u64().unwrap_or(0),
            pages: budget["pagesUsed"].as_u64().unwrap_or(0),
        }
    }

    pub fn metadata(self) -> Value {
        json!({"bytesUsed":self.bytes, "pagesUsed":self.pages})
    }
}

/// Accept plain page trees when their direct /Count agrees with the visible page objects.
/// Streams, strings, comments and hex strings cannot contribute page-tree tokens.
fn pdf_pages(bytes: &[u8]) -> Option<u64> {
    let delim = |b: u8| b <= 32 || b"()<>[]{}/%".contains(&b);
    let skip = |mut tail: &[u8]| -> usize {
        let len = tail.len();
        while let Some((&b, rest)) = tail.split_first() {
            if b <= 32 {
                tail = rest;
            } else if b == b'%' {
                let n = rest
                    .iter()
                    .position(|b| matches!(b, b'\n' | b'\r'))
                    .unwrap_or(rest.len());
                tail = rest.get(n..).unwrap_or_default();
            } else {
                break;
            }
        }
        len - tail.len()
    };
    if !bytes.starts_with(b"%PDF-")
        || !bytes
            .get(bytes.len().saturating_sub(1024)..)?
            .windows(5)
            .any(|w| w == b"%%EOF")
    {
        return None;
    }
    let (mut catalog, mut tree, mut pages, mut count) = (false, false, 0u64, 0u64);
    let mut tail = bytes;
    let mut previous = &b""[..];
    while !tail.is_empty() {
        tail = tail.get(skip(tail)..)?;
        let Some((&ch, rest)) = tail.split_first() else {
            break;
        };
        if previous == b"/Type" && ch != b'/' || previous == b"/Kids" && ch != b'[' {
            return None;
        }
        if ch == b'(' {
            let mut depth = 1;
            let mut escaped = false;
            let mut consumed = None;
            for (i, byte) in rest.iter().enumerate() {
                if escaped {
                    escaped = false;
                    continue;
                }
                match byte {
                    b'\\' => escaped = true,
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                if depth == 0 {
                    consumed = Some(i + 1);
                    break;
                }
            }
            tail = rest.get(consumed?..)?;
            previous = b"";
            continue;
        }
        if tail.starts_with(b"<<") {
            tail = rest.get(1..)?;
            previous = b"";
            continue;
        }
        if ch == b'<' {
            tail = rest.get(rest.iter().position(|b| *b == b'>')? + 1..)?;
            previous = b"";
            continue;
        }
        if delim(ch) && ch != b'/' {
            tail = rest;
            previous = b"";
            continue;
        }
        let len = rest.iter().position(|b| delim(*b)).unwrap_or(rest.len()) + 1;
        let token = tail.get(..len)?;
        tail = tail.get(len..)?;
        if len > 64
            || token.contains(&b'#')
            || matches!(token, b"/ObjStm" | b"/XRef" | b"/Encrypt" | b"/Prev")
        {
            return None;
        }
        if token == b"stream" {
            tail = tail.get(tail.windows(9).position(|w| w == b"endstream")? + 9..)?;
            previous = b"";
            continue;
        }
        if previous == b"/Type" {
            match token {
                b"/Page" => pages += 1,
                b"/Pages" => tree = true,
                b"/Catalog" => catalog = true,
                _ => {}
            }
        }
        if previous == b"/Count" {
            if token.len() > 9
                || token.first() == Some(&b'0')
                || !token.iter().all(u8::is_ascii_digit)
                || tail.get(skip(tail)).is_some_and(|b| !delim(*b))
            {
                return None;
            }
            count = count.max(std::str::from_utf8(token).ok()?.parse().ok()?);
        }
        previous = token;
    }
    (catalog && tree && pages > 0 && pages == count).then_some(pages)
}

pub fn prompt_content(
    text: &str,
    attachments: &[ChatAttachment],
    dir: Option<&Path>,
    budget: &mut Budget,
) -> Result<Value, String> {
    let values: Vec<Value> = attachments.iter().map(to_json).collect();
    let prompt = conn_provider_support::attachments::prompt_text(text, &values, dir);
    let mut blocks = Vec::new();
    let text_block = json!({"type":"text","text":prompt});
    let plain = json!(text);
    let cost = if values.is_empty() {
        plain.to_string().len()
    } else {
        text_block.to_string().len() + 2
    };
    budget.bytes = budget.bytes.saturating_add(cost as u64);
    if values.is_empty() {
        return Ok(plain);
    }
    for value in &values {
        let kind = value["type"].as_str().unwrap_or("");
        let mime = value["mimeType"]
            .as_str()
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let pdf = kind == "file"
            && mime == "application/pdf"
            && value["source"]["_tag"] != "pasted-text"
            && budget.pages < 100;
        if kind != "image" && !pdf {
            continue;
        }
        if kind == "image" && !SUPPORTED_IMAGES.contains(&mime.as_str()) {
            return Err(format!("Unsupported Claude image attachment type '{mime}'"));
        }
        let read_error = || {
            format!(
                "Failed to read attachment '{}'",
                value["id"].as_str().unwrap_or("")
            )
        };
        let file = conn_provider_support::attachments::saved_path(dir, value)
            .and_then(|path| std::fs::File::open(path).ok());
        let Some(file) = file else {
            if pdf {
                continue;
            }
            return Err(read_error());
        };
        let overhead = if pdf { 1024 } else { 128 };
        let max = BUDGET_BYTES
            .saturating_sub(budget.bytes)
            .saturating_sub(overhead)
            / 4
            * 3;
        if file
            .metadata()
            .ok()
            .is_some_and(|m| m.len() > max || !m.is_file())
        {
            continue;
        }
        let mut bytes = Vec::new();
        if file.take(max + 1).read_to_end(&mut bytes).is_err() {
            if pdf {
                continue;
            }
            return Err(read_error());
        }
        let cost = 4 * (bytes.len() as u64).div_ceil(3) + overhead;
        if cost > BUDGET_BYTES.saturating_sub(budget.bytes) {
            continue;
        }
        if pdf {
            let Some(pages) = pdf_pages(&bytes).filter(|n| *n <= 100 - budget.pages) else {
                continue;
            };
            budget.pages += pages;
        }
        budget.bytes = budget.bytes.saturating_add(cost);
        blocks.push(json!({"type":if pdf{"document"}else{"image"},"source":{"type":"base64","media_type":mime,"data":conn_support::base64::encode(&bytes)}}));
    }
    if !prompt.is_empty() {
        blocks.push(text_block)
    }
    Ok(Value::Array(blocks))
}
#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::from_json;

    #[test]
    fn paths_follow_the_attachment_store() {
        let image = json!({"type": "image", "id": "t-1", "name": "a.PNG", "mimeType": "image/png", "sizeBytes": 1});
        assert_eq!(relative_path(&image).as_deref(), Some("t-1.png"));
        let file = json!({"type": "file", "id": "t-2", "name": "notes.Md", "mimeType": "text/markdown", "sizeBytes": 1});
        assert_eq!(relative_path(&file).as_deref(), Some("t-2.md"));
        let odd =
            json!({"type": "file", "id": "t-3", "name": "x.part", "mimeType": "x", "sizeBytes": 1});
        assert_eq!(relative_path(&odd).as_deref(), Some("t-3.bin"));
        let traversal =
            json!({"type": "file", "id": "../x", "name": "a", "mimeType": "x", "sizeBytes": 1});
        assert_eq!(relative_path(&traversal), None);
    }

    #[test]
    fn images_go_inline_before_the_text_with_every_path_listed() {
        let dir = std::env::temp_dir().join(format!("conn-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t-1.png"), b"png").unwrap();
        std::fs::write(dir.join("t-2.txt"), b"hello").unwrap();
        let attachments: Vec<ChatAttachment> = from_json(json!([
            {"type": "image", "id": "t-1", "name": "red.png", "mimeType": "image/png", "sizeBytes": 3},
            {"type": "file", "id": "t-2", "name": "a.txt", "mimeType": "text/plain", "sizeBytes": 5},
        ]))
        .unwrap();
        let mut used = Budget::default();
        let content = prompt_content("Look", &attachments, Some(&dir), &mut used).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["data"], "cG5n");
        let text = content[1]["text"].as_str().unwrap();
        assert!(text.starts_with("Look\n\n[Attached image \"red.png\" is saved at: "));
        assert!(text.contains("[Attached file \"a.txt\" is saved at: "));
        assert!(used.bytes >= 4 + 128);
        assert_eq!(
            prompt_content("plain", &[], None, &mut used).unwrap(),
            json!("plain")
        );
    }
}
