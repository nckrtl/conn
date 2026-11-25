#![forbid(unsafe_code)]

//! Durable conversation data shared by the desktop and iOS clients.

mod store;
use conn_client::{ClientError, Connection};
use conn_contract::ChatAttachment;
use conn_state::{ItemStatus, ReviewComment, ThreadState, TimelineEntry};
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
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => Some(Self::User {
                id: id.clone(),
                text: text.clone(),
                created_by_agent: *created_by_agent,
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

    pub fn entry(self) -> TimelineEntry {
        match self {
            Self::User {
                id,
                text,
                delegated_completion: _,
                notice_results: _,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => TimelineEntry::User {
                id,
                text,
                created_by_agent,
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
            next = Some(state.history_cursor.ok_or_else(|| {
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
