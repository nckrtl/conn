#![forbid(unsafe_code)]

//! Durable conversation data shared by the desktop and iOS clients.

mod store;
use conn_client::{ClientError, Connection};
use conn_contract::ChatAttachment;
use conn_state::{AgentMessageSender, ItemStatus, ReviewComment, ThreadState, TimelineEntry};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

pub use store::MessageCache;

pub const MESSAGE_CAP: usize = 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Message {
    User {
        id: String,
        text: String,
        created_by_agent: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sender: Option<AgentMessageSender>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delegated_completion: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        notice_results: Option<Vec<conn_state::thread_feed::DelegatedResult>>,
        created_at: Option<String>,
        attachments: Vec<ChatAttachment>,
        is_steer: bool,
        /// Rows saved before review comments were kept have none.
        #[serde(default)]
        review_comments: Vec<ReviewComment>,
        run_id: Option<String>,
    },
    Assistant {
        id: String,
        markdown: String,
        created_at: Option<String>,
        run_id: Option<String>,
    },
}

impl Message {
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. } | Self::Assistant { id, .. } => id,
        }
    }

    pub fn capture_for_feed(state: &ThreadState, entry: &TimelineEntry) -> Option<Self> {
        if let TimelineEntry::Notice { id, text, .. } = entry
            && let Some(results) = state.delegated_results(id)
        {
            return Some(Self::User {
                id: id.clone(),
                text: text.clone(),
                created_by_agent: true,
                delegated_completion: Some(true),
                sender: None,
                notice_results: Some(results.to_vec()),
                created_at: None,
                attachments: vec![],
                is_steer: false,
                review_comments: vec![],
                run_id: None,
            });
        }
        let mut message = Self::capture(entry)?;
        if let Self::User {
            delegated_completion,
            ..
        } = &mut message
        {
            *delegated_completion = Some(matches!(
                state.feed_details.get(entry.id()),
                Some(conn_state::thread_feed::FeedDetail::Delegated(_))
            ));
        }
        Some(message)
    }

    pub fn delegated_results(&self) -> Option<Vec<conn_state::thread_feed::DelegatedResult>> {
        let Self::User {
            id,
            text,
            delegated_completion,
            notice_results,
            ..
        } = self
        else {
            return None;
        };
        if let Some(results) = notice_results {
            return Some(results.clone());
        }
        if delegated_completion
            .unwrap_or_else(|| conn_state::thread_feed::cached_completion_id(id, text))
        {
            return conn_state::thread_feed::completion_results(text);
        }
        None
    }

    pub fn capture(entry: &TimelineEntry) -> Option<Self> {
        match entry {
            TimelineEntry::User {
                id,
                text,
                created_by_agent,
                sender,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => Some(Self::User {
                id: id.clone(),
                text: text.clone(),
                created_by_agent: *created_by_agent,
                sender: sender.clone(),
                delegated_completion: None,
                notice_results: None,
                created_at: created_at.clone(),
                attachments: attachments.clone(),
                is_steer: *is_steer,
                review_comments: review_comments.clone(),
                run_id: run_id.clone(),
            }),
            TimelineEntry::Assistant {
                id,
                markdown,
                created_at,
                run_id,
                ..
            } => Some(Self::Assistant {
                id: id.clone(),
                markdown: markdown.clone(),
                created_at: created_at.clone(),
                run_id: run_id.clone(),
            }),
            _ => None,
        }
    }

    /// The id of the row [`Self::capture`] makes of `entry`, and a fingerprint of what it would
    /// keep, without copying any of it. Two captures of an entry have the same fingerprint when
    /// their stored rows are equal, so a saver can tell which rows changed since its last write.
    ///
    /// The fingerprint only detects changes; it is not a checksum for adversarial input.
    pub fn fingerprint(entry: &TimelineEntry) -> Option<(&str, u64)> {
        let mut hash = Fingerprint::default();
        let id = match entry {
            TimelineEntry::User {
                id,
                text,
                created_by_agent,
                sender,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => {
                hash.byte(0);
                hash.text(id);
                hash.text(text);
                hash.byte(u8::from(*created_by_agent));
                hash.json(sender);
                hash.optional(created_at.as_deref());
                hash.json(attachments);
                hash.byte(u8::from(*is_steer));
                hash.json(review_comments);
                hash.optional(run_id.as_deref());
                id
            }
            TimelineEntry::Assistant {
                id,
                markdown,
                created_at,
                run_id,
                ..
            } => {
                hash.byte(1);
                hash.text(id);
                hash.text(markdown);
                hash.optional(created_at.as_deref());
                hash.optional(run_id.as_deref());
                id
            }
            _ => return None,
        };
        Some((id, hash.finish()))
    }

    pub fn entry(self) -> TimelineEntry {
        match self {
            Self::User {
                id,
                text,
                delegated_completion: _,
                notice_results: _,
                created_by_agent,
                sender,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => TimelineEntry::User {
                id,
                text,
                created_by_agent,
                sender,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            },
            Self::Assistant {
                id,
                markdown,
                created_at,
                run_id,
            } => TimelineEntry::Assistant {
                id,
                markdown,
                created_at,
                run_id,
                streaming: false,
                status: ItemStatus::Completed,
            },
        }
    }
}

/// The ids and fingerprints of the tail a thread's cache rows were last written from, so the next
/// save writes only the rows that differ.
#[derive(Clone, Debug, Default)]
pub struct TailMarks(Vec<(Box<str>, u64)>);

/// What a save owes the cache, given the tail it last wrote.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TailChange {
    /// The stored rows are current.
    Nothing,
    /// These rows, by index in the new tail, are new or changed. Everything else is stored as is.
    Rows(Vec<usize>),
    /// The rows moved, were removed, or nothing is known of what is stored: write the whole tail.
    Whole,
}

impl TailMarks {
    /// The marks of a tail of `(id, fingerprint)` pairs, oldest first.
    #[must_use]
    pub fn new(tail: &[(&str, u64)]) -> Self {
        Self(tail.iter().map(|&(id, mark)| (id.into(), mark)).collect())
    }

    /// Compares the new `tail` with the marks. The tail may start later than the marks did, as
    /// the oldest rows leave the window, and may end with new rows. Anything else rewrites it all.
    #[must_use]
    pub fn diff(&self, tail: &[(&str, u64)]) -> TailChange {
        let Some(&(first, _)) = tail.first() else {
            return if self.0.is_empty() {
                TailChange::Nothing
            } else {
                TailChange::Whole
            };
        };
        let Some(skipped) = self.0.iter().position(|(id, _)| &**id == first) else {
            return TailChange::Whole;
        };
        let kept = &self.0[skipped..];
        if tail.len() < kept.len() {
            return TailChange::Whole;
        }
        let mut rows = Vec::new();
        for (index, &(id, mark)) in tail.iter().enumerate().take(kept.len()) {
            if &*kept[index].0 != id {
                return TailChange::Whole;
            }
            if kept[index].1 != mark {
                rows.push(index);
            }
        }
        // A row after the kept ones must be new. One stored already, even before the window,
        // moved, and only writing the whole tail puts it in its new place.
        let appended = &tail[kept.len()..];
        let stored: HashSet<&str> = if appended.len() > 8 {
            self.0.iter().map(|(id, _)| &**id).collect()
        } else {
            HashSet::new()
        };
        for (offset, &(id, _)) in appended.iter().enumerate() {
            let known = if appended.len() > 8 {
                stored.contains(id)
            } else {
                self.0.iter().any(|(old, _)| &**old == id)
            };
            if known {
                return TailChange::Whole;
            }
            rows.push(kept.len() + offset);
        }
        if rows.is_empty() {
            TailChange::Nothing
        } else {
            TailChange::Rows(rows)
        }
    }
}

/// A fast 64-bit hash of a message's stored fields: eight bytes per step, no allocation. Message
/// bodies are kilobytes long and a thread keeps up to a thousand of them, so SipHash would cost
/// milliseconds per save on the main thread.
#[derive(Default)]
struct Fingerprint(u64);

impl Fingerprint {
    const MUL: u64 = 0x9e37_79b9_7f4a_7c15;

    fn word(&mut self, word: u64) {
        self.0 = (self.0 ^ word).wrapping_mul(Self::MUL);
        self.0 ^= self.0 >> 32;
    }

    fn byte(&mut self, byte: u8) {
        self.word(u64::from(byte));
    }

    /// Length first, so that moving bytes between neighbouring fields changes the result.
    fn text(&mut self, text: &str) {
        self.bytes(text.as_bytes());
    }

    fn bytes(&mut self, bytes: &[u8]) {
        self.word(bytes.len() as u64);
        let (chunks, rest) = bytes.as_chunks::<8>();
        for chunk in chunks {
            self.word(u64::from_le_bytes(*chunk));
        }
        let mut word = [0; 8];
        word[..rest.len()].copy_from_slice(rest);
        self.word(u64::from_le_bytes(word));
    }

    fn optional(&mut self, text: Option<&str>) {
        match text {
            Some(text) => {
                self.byte(1);
                self.text(text);
            }
            None => self.byte(0),
        }
    }

    /// The JSON the row would be stored with, for the small structured fields.
    fn json(&mut self, value: &impl Serialize) {
        // serde_json writes the same pieces for equal values, so hashing each piece as it comes
        // needs no buffer. A value that cannot be serialized cannot be stored either.
        if serde_json::to_writer(JsonSink(self), value).is_err() {
            self.byte(0xff);
        }
    }

    fn finish(self) -> u64 {
        self.0
    }
}

struct JsonSink<'a>(&'a mut Fingerprint);

impl std::io::Write for JsonSink<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.bytes(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Fetches at most the missing prefix of a bounded snapshot, newest page first.
/// The result is chronological and contains each conversation row once.
///
/// # Errors
/// Returns a transport or codec error if any page fails. A cursor cycle is also an error:
/// callers must never commit a partial prefix as complete.
pub async fn fetch_history_prefix(
    connection: &Connection,
    thread: &str,
    cursor: &str,
    limit: usize,
) -> Result<Vec<Message>, ClientError> {
    let limit = limit.min(MESSAGE_CAP);
    let mut next = Some(cursor.to_owned());
    let mut messages = VecDeque::with_capacity(limit);
    let mut ids = HashSet::with_capacity(limit);
    let mut cursors = HashSet::new();
    while messages.len() < limit
        && let Some(cursor) = next.take()
    {
        if !cursors.insert(cursor.clone()) {
            return Err(ClientError::Connection(
                "repeated server history cursor".to_owned(),
            ));
        }
        let page = connection
            .fetch_thread_conversation_page(thread, &cursor)
            .await?;
        let mut state = ThreadState::new(thread);
        state.prepend_history_page(page);
        if state.has_more_history {
            next = Some(state.history_cursor.take().ok_or_else(|| {
                ClientError::Connection("missing server history cursor".to_owned())
            })?);
        }
        for entry in state.entries.iter().rev() {
            if let Some(message) = Message::capture_for_feed(&state, entry)
                && ids.insert(message.id().to_owned())
            {
                messages.push_front(message);
                if messages.len() == limit {
                    break;
                }
            }
        }
    }
    Ok(messages.into())
}

#[cfg(test)]
mod tests {
    use super::{AgentMessageSender, Message, TailChange, TailMarks, TimelineEntry};
    use serde_json::json;

    fn assistant(id: &str, markdown: &str) -> TimelineEntry {
        TimelineEntry::Assistant {
            id: id.to_owned(),
            markdown: markdown.to_owned(),
            streaming: false,
            created_at: None,
            run_id: None,
            status: conn_state::ItemStatus::Completed,
        }
    }

    fn user(id: &str, text: &str) -> TimelineEntry {
        TimelineEntry::User {
            id: id.to_owned(),
            text: text.to_owned(),
            created_by_agent: false,
            sender: None,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: None,
        }
    }

    #[test]
    fn a_fingerprint_changes_with_every_stored_field_and_with_nothing_else() {
        let print = |entry: &TimelineEntry| Message::fingerprint(entry).expect("a message").1;
        let base = assistant("a", "hello");
        assert_eq!(print(&base), print(&assistant("a", "hello")));
        assert_eq!(Message::fingerprint(&base).map(|(id, _)| id), Some("a"));
        // What the row does not keep does not count.
        let streaming = TimelineEntry::Assistant {
            id: "a".into(),
            markdown: "hello".into(),
            streaming: true,
            created_at: None,
            run_id: None,
            status: conn_state::ItemStatus::Completed,
        };
        assert_eq!(print(&base), print(&streaming));

        let mut seen = std::collections::HashSet::new();
        let mut distinct = |entry: TimelineEntry| {
            assert!(
                seen.insert(print(&entry)),
                "{entry:?} repeats a fingerprint"
            );
        };
        distinct(base);
        distinct(assistant("b", "hello"));
        distinct(assistant("a", "hellp"));
        distinct(assistant("a", "hello!"));
        distinct(assistant("a", ""));
        distinct(assistant("ahello", ""));
        distinct(assistant("a", "hello world, longer than a word"));
        distinct(assistant("a", "hello world, longer than a worm"));
        distinct(TimelineEntry::Assistant {
            id: "a".into(),
            markdown: "hello".into(),
            streaming: false,
            created_at: Some("2026-01-01T00:00:00Z".into()),
            run_id: None,
            status: conn_state::ItemStatus::Completed,
        });
        distinct(TimelineEntry::Assistant {
            id: "a".into(),
            markdown: "hello".into(),
            streaming: false,
            created_at: None,
            run_id: Some("run".into()),
            status: conn_state::ItemStatus::Completed,
        });
        distinct(user("a", "hello"));
        let edit = |change: &dyn Fn(&mut TimelineEntry)| {
            let mut entry = user("a", "hello");
            change(&mut entry);
            entry
        };
        macro_rules! user_field {
            ($field:ident, $value:expr) => {
                distinct(edit(&|entry| {
                    let TimelineEntry::User { $field, .. } = entry else {
                        unreachable!("a user entry")
                    };
                    *$field = $value;
                }))
            };
        }
        user_field!(text, "hellp".into());
        user_field!(created_by_agent, true);
        user_field!(
            sender,
            Some(AgentMessageSender::LinkedTitle("Release reviews".into()))
        );
        user_field!(created_at, Some("2026-01-01T00:00:00Z".into()));
        user_field!(is_steer, true);
        user_field!(run_id, Some("run".into()));
        user_field!(
            review_comments,
            vec![
                serde_json::from_value(json!({
                    "file_path": "src/lib.rs", "range_label": "L3", "text": "no",
                    "diff": "", "fence_language": null
                }))
                .expect("a review comment")
            ]
        );
        user_field!(
            attachments,
            vec![serde_json::from_value(json!({
                "type": "image", "id": "i", "name": "x.png", "mimeType": "image/png", "sizeBytes": 1
            }))
            .expect("an attachment")]
        );
        assert!(
            Message::fingerprint(&TimelineEntry::Notice {
                id: "n".into(),
                text: "tool status".into(),
                level: conn_state::NoticeLevel::Info,
            })
            .is_none()
        );
    }

    #[test]
    fn marks_tell_new_and_changed_rows_from_a_moved_tail() {
        let marks = TailMarks::new(&[("a", 1), ("b", 2), ("c", 3)]);
        assert_eq!(
            marks.diff(&[("a", 1), ("b", 2), ("c", 3)]),
            TailChange::Nothing
        );
        assert_eq!(
            marks.diff(&[("a", 1), ("b", 9), ("c", 3), ("d", 4)]),
            TailChange::Rows(vec![1, 3])
        );
        assert_eq!(
            marks.diff(&[("b", 2), ("c", 3), ("d", 4)]),
            TailChange::Rows(vec![2]),
            "the oldest row left the window"
        );
        assert_eq!(marks.diff(&[("a", 1), ("c", 3)]), TailChange::Whole);
        assert_eq!(marks.diff(&[("a", 1), ("b", 2)]), TailChange::Whole);
        assert_eq!(
            marks.diff(&[("a", 1), ("x", 5), ("b", 2), ("c", 3)]),
            TailChange::Whole
        );
        assert_eq!(
            marks.diff(&[("c", 3), ("b", 2), ("a", 1)]),
            TailChange::Whole,
            "rows already stored that come back after the kept ones moved"
        );
        assert_eq!(marks.diff(&[("z", 1)]), TailChange::Whole);
        assert_eq!(marks.diff(&[]), TailChange::Whole);
        assert_eq!(TailMarks::default().diff(&[]), TailChange::Nothing);
        assert_eq!(TailMarks::default().diff(&[("a", 1)]), TailChange::Whole);
    }

    #[test]
    fn cached_agent_messages_round_trip_and_old_rows_have_no_sender() {
        let old = json!({"User":{"id":"m","text":"hello","created_by_agent":true,"created_at":null,"attachments":[],"is_steer":false,"run_id":null}});
        let mut row = serde_json::from_value::<Message>(old)
            .expect("old cache row")
            .entry();
        let TimelineEntry::User { sender, .. } = &mut row else {
            panic!("user")
        };
        assert!(sender.is_none());
        *sender = Some(AgentMessageSender::LinkedTitle("Release reviews".into()));
        let saved = Message::capture(&row).expect("cached conversation entry");
        let wire = serde_json::to_vec(&saved).expect("encoded cache row");
        let restored = serde_json::from_slice::<Message>(&wire)
            .expect("decoded cache row")
            .entry();
        assert_eq!(restored, row);
    }
}
