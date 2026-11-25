//! A native conversation read replays ACP session/update messages. Live turns
//! already have app IDs; replay-only messages derive stable IDs from the peer.
use std::collections::HashMap;

use conn_contract::{ConversationMessage, ProviderThread, from_json, to_json};
use conn_provider::{ProviderError, ProviderResult, ThreadSnapshot, TurnInput};
use conn_provider_support::ids::{encode_component, message_from_item};
use serde_json::{Value, json};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_MESSAGES: usize = 16_384;

#[derive(Default)]
pub(crate) struct Snapshot {
    pub(crate) thread_id: Option<String>,
    entries: Vec<Entry>,
    by_id: HashMap<String, usize>,
    role: &'static str,
    source_id: Option<String>,
    index: u64,
    bytes: usize,
    evicted: bool,
    requested: bool,
}

enum Entry {
    Live(Box<ConversationMessage>),
    Replayed {
        item: String,
        role: &'static str,
        text: String,
        created: String,
        updated: String,
    },
}

impl Snapshot {
    pub(crate) fn for_load(requested: bool) -> Self {
        Self {
            requested,
            ..Self::default()
        }
    }

    pub(crate) fn needs_load(&self) -> bool {
        self.evicted
    }

    // A small transcript stays warm. A larger requested transcript belongs to the
    // reader only, so no agent retains it after the import completes.
    pub(crate) fn take_uncached_read(&mut self) -> Option<Box<Self>> {
        self.requested = false;
        if self.bytes <= MAX_BYTES && self.entries.len() <= MAX_MESSAGES {
            return None;
        }
        Some(Box::new(std::mem::replace(
            self,
            Self {
                evicted: true,
                ..Self::default()
            },
        )))
    }

    fn reserve(&mut self, bytes: usize, new: bool) -> bool {
        if self.evicted {
            return false;
        }
        if !self.requested
            && (self.bytes.saturating_add(bytes) > MAX_BYTES
                || (new && self.entries.len() >= MAX_MESSAGES))
        {
            *self = Self {
                evicted: true,
                ..Self::default()
            };
            return false;
        }
        self.bytes = self.bytes.saturating_add(bytes);
        true
    }

    pub(crate) fn remember(&mut self, row: &ConversationMessage) {
        if self.evicted || row.streaming || self.thread_id.as_deref() != Some(&row.thread_id) {
            return;
        }
        let key = format!("live:{}", row.id);
        // Charge the row's serialized bytes, including attachments, once.
        let cost = serde_json::to_vec(row)
            .map(|s| s.len())
            .unwrap_or(MAX_BYTES + 1);
        let known = self.by_id.get(&key).copied();
        if let Some(i) = known
            && let Entry::Live(old) = &self.entries[i]
        {
            self.bytes = self
                .bytes
                .saturating_sub(serde_json::to_vec(old).map(|s| s.len()).unwrap_or_default());
        }
        if !self.reserve(
            cost + if known.is_none() { key.len() } else { 0 },
            known.is_none(),
        ) {
            return;
        }
        let entry = Entry::Live(Box::new(row.clone()));
        if let Some(i) = known {
            self.entries[i] = entry;
        } else {
            self.by_id.insert(key, self.entries.len());
            self.entries.push(entry);
        }
    }

    pub(crate) fn remember_input(&mut self, input: &TurnInput) {
        if self.evicted {
            return;
        }
        self.thread_id = Some(input.thread_id.as_str().to_owned());
        let now = conn_support::time::now_iso();
        let row = json!({"id":input.message.message_id.as_str(),"threadId":input.thread_id.as_str(),
            "runId":input.run_id.as_str(),"nodeId":input.root_node_id.as_str(),"role":"user",
            "createdBy":input.message.created_by,"creationSource":input.message.creation_source,
            "scheduledTaskId":input.message.scheduled_task_id,"senderThreadId":input.message.sender_thread_id,
            "text":input.message.text,"attachments":input.message.attachments,"streaming":false,"createdAt":now,"updatedAt":now});
        if let Ok(message) = from_json(row) {
            self.remember(&message);
        }
    }

    pub(crate) fn update(&mut self, params: &Value, grok: bool) {
        if self.evicted {
            return;
        }
        let update = &params["update"];
        let (role, whole) = match update["sessionUpdate"].as_str() {
            Some("user_message_chunk") => ("user", false),
            Some("user_message") => ("user", true),
            Some("agent_message_chunk") => ("assistant", false),
            Some("agent_message") => ("assistant", true),
            Some("agent_thought_chunk") => ("thought", false),
            Some("agent_thought") => ("thought", true),
            Some("tool_call" | "tool_call_update" | "plan" | "plan_update" | "plan_removed") => {
                self.role = "";
                self.source_id = None;
                return;
            }
            _ => return,
        };
        let text = if whole {
            let Some(blocks) = update["content"].as_array() else {
                return;
            };
            blocks
                .iter()
                .filter_map(crate::mapper::content_display_text)
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            let Some(text) = crate::mapper::content_display_text(&update["content"]) else {
                return;
            };
            if text.is_empty()
                || (grok
                    && (crate::grok_background::is_monitor_chatter(&text)
                        || !crate::grok_background::background_tool_mutations(&text).is_empty()))
            {
                return;
            }
            text
        };
        let source = update["messageId"].as_str().filter(|s| !s.is_empty());
        let session = params["sessionId"].as_str().unwrap_or_default();
        if role != self.role || source.is_some_and(|id| self.source_id.as_deref() != Some(id)) {
            self.index += 1;
            self.source_id = source.map(str::to_owned);
        }
        self.role = role;
        let item = source.map_or_else(
            || format!("{session}:history:{role}:{}", self.index),
            |id| format!("{session}:history:{role}:message:{id}"),
        );
        let now = conn_support::time::now_iso();
        let key = format!("replay:{item}");
        if let Some(&i) = self.by_id.get(&key) {
            if whole && let Entry::Replayed { text: old, .. } = &self.entries[i] {
                self.bytes = self.bytes.saturating_sub(old.len());
            }
            if !self.reserve(text.len(), false) {
                return;
            }
            if let Entry::Replayed {
                text: old, updated, ..
            } = &mut self.entries[i]
            {
                if whole {
                    *old = text;
                } else {
                    old.push_str(&text);
                }
                *updated = now;
            }
        } else if self.reserve(text.len() + item.len() + key.len() + now.len() * 2, true) {
            self.by_id.insert(key, self.entries.len());
            self.entries.push(Entry::Replayed {
                item,
                role,
                text,
                created: now.clone(),
                updated: now,
            });
        }
    }

    pub(crate) fn read(
        &self,
        thread: &ProviderThread,
        session_id: &str,
        app_thread: Option<&str>,
    ) -> ProviderResult<ThreadSnapshot> {
        let error = |s: String| ProviderError::Protocol { detail: s };
        if self.evicted {
            return Err(error(
                "The native ACP transcript must be loaded before reading.".into(),
            ));
        }
        let mut pt = to_json(thread);
        let driver = pt["driver"].as_str().unwrap_or_default();
        let scope = if pt["nativeMetadata"]["itemIdentityVersion"] == 2 {
            format!(
                "provider-instance:{}:",
                encode_component(pt["providerInstanceId"].as_str().unwrap_or_default())
            )
        } else {
            String::new()
        };
        // Imported messages belong to the application thread that opened this session.
        let app_thread = app_thread.or(thread.app_thread_id.as_deref());
        let mut messages = Vec::new();
        let mut reasoning_message_ids = Vec::new();
        for entry in &self.entries {
            let message = match entry {
                Entry::Live(row) => {
                    if row.text.trim().is_empty() && row.attachments.is_empty() {
                        continue;
                    }
                    (**row).clone()
                }
                Entry::Replayed {
                    item,
                    role,
                    text,
                    created,
                    updated,
                } => {
                    if text.trim().is_empty() {
                        continue;
                    }
                    let id = message_from_item(driver, &format!("{scope}{item}"));
                    if *role == "thought" {
                        reasoning_message_ids.push(id.clone());
                    }
                    let user = *role == "user";
                    from_json(json!({"id":id,"threadId":app_thread,"runId":null,"nodeId":null,
                        "role":if user{"user"}else{"assistant"},"text":text,"attachments":[],"streaming":false,
                        "createdBy":if user{"user"}else{"agent"},"creationSource":"provider","createdAt":created,"updatedAt":updated})).map_err(|e|error(e.to_string()))?
                }
            };
            messages.push(message);
        }
        pt["providerSessionId"] = json!(session_id);
        pt["status"] = json!("idle");
        pt["updatedAt"] = json!(conn_support::time::now_iso());
        Ok(ThreadSnapshot {
            provider_thread: from_json(pt).map_err(|e| error(e.to_string()))?,
            provider_turns: vec![],
            messages,
            reasoning_message_ids,
            runtime_requests: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_requested_transcript_can_exceed_the_idle_cache_budget() {
        let message = json!({"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"last row"}}});
        let mut warming = Snapshot {
            bytes: MAX_BYTES,
            ..Snapshot::default()
        };
        warming.update(&message, true);
        assert!(warming.needs_load());
        assert!(warming.entries.is_empty());

        let mut requested = Snapshot {
            bytes: MAX_BYTES,
            ..Snapshot::for_load(true)
        };
        requested.update(&message, true);
        let complete = requested
            .take_uncached_read()
            .expect("caller owns the complete transcript");
        assert!(
            matches!(&complete.entries[..], [Entry::Replayed { text, .. }] if text == "last row")
        );
        assert!(requested.needs_load());
        assert!(requested.entries.is_empty());
    }
}
