//! The thread transcript body (`OrchestrationV2ThreadTranscript`) and the size of the file the
//! client builds from it (`threadTranscriptHeader` plus one JSON line per item).

use serde_json::Value;

/// The byte length of `threadTranscriptHeader` for title, environment id, thread id and
/// `updatedAt`, newline included.
pub(crate) fn header_bytes(values: [&str; 4]) -> u64 {
    let fixed: usize = conn_contract::THREAD_TRANSCRIPT_HEADER_PARTS
        .iter()
        .map(|part| part.len())
        .sum();
    values.iter().fold(fixed as u64, |size, value| {
        size.saturating_add(json_len(&Value::from(*value)))
    })
}

fn json_len(value: &Value) -> u64 {
    serde_json::to_vec(value).map_or(0, |text| text.len() as u64)
}

/// The JSON body, written as rows arrive: `{"items":[...],"threadId":..,"title":..,
/// "updatedAt":..}`. Each row is encoded once; its length is what the file line costs.
pub(crate) struct Body {
    out: Vec<u8>,
    rows: usize,
}

impl Body {
    pub(crate) fn new() -> Self {
        Self {
            out: b"{\"items\":[".to_vec(),
            rows: 0,
        }
    }

    /// Appends one row and answers its encoded length.
    pub(crate) fn push(&mut self, row: &Value) -> Result<u64, String> {
        if self.rows > 0 {
            self.out.push(b',');
        }
        let before = self.out.len();
        serde_json::to_writer(&mut self.out, row).map_err(|e| e.to_string())?;
        self.rows += 1;
        Ok((self.out.len() - before) as u64)
    }

    pub(crate) fn finish(
        mut self,
        thread_id: &str,
        title: &str,
        updated_at: &str,
    ) -> Result<Vec<u8>, String> {
        let text = |value: &str| serde_json::to_string(value).map_err(|e| e.to_string());
        self.out.extend_from_slice(b"],\"threadId\":");
        self.out.extend_from_slice(text(thread_id)?.as_bytes());
        self.out.extend_from_slice(b",\"title\":");
        self.out.extend_from_slice(text(title)?.as_bytes());
        self.out.extend_from_slice(b",\"updatedAt\":");
        self.out.extend_from_slice(text(updated_at)?.as_bytes());
        self.out.push(b'}');
        Ok(self.out)
    }
}
