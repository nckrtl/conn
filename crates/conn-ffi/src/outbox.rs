//! Replies on their way to the server, shown in the thread at once (Conn mobile's outbox).
//!
//! A send gets a pending `QueuedUser` row keyed by its idempotency key until the server's own
//! row for the same message arrives; a failed send loses its row and the app restores the draft.

use crate::types::{FfiAttachment, FfiThreadSnapshot, FfiTimelineEntry};

/// One reply between the tap on Send and the server's row for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PendingSend {
    /// The composer's idempotency key: the message is `message-<key>`.
    pub key: String,
    pub text: String,
    /// The files being uploaded, with `pending:<key>:<index>` ids.
    pub attachments: Vec<FfiAttachment>,
    pub created_at: String,
    /// The server accepted the command.
    pub acked: bool,
    /// A full thread snapshot arrived after the server accepted it: the server's row must be in
    /// it, so a missing one is not coming.
    pub superseded: bool,
}

impl PendingSend {
    fn message_id(&self) -> String {
        format!("message-{}", self.key)
    }

    /// The server's turn item for this message (`turn-item:<message id>`).
    fn item_id(&self) -> String {
        format!("turn-item:{}", self.message_id())
    }

    fn echoed_in(&self, entries: &[FfiTimelineEntry]) -> bool {
        let item = self.item_id();
        let message = self.message_id();
        entries.iter().rev().any(|entry| match entry {
            FfiTimelineEntry::User { id, .. } => *id == item,
            FfiTimelineEntry::QueuedUser { id, message_id, .. } => {
                *id == item || *message_id == message
            }
            _ => false,
        })
    }
}

/// `ms` (Unix) as UTC ISO-8601 with milliseconds, as the server writes `createdAt`.
pub(crate) fn iso_from_epoch_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// The id of a file in a pending row, so the app can show its local copy until it is uploaded.
pub(crate) fn pending_attachment_id(key: &str, index: usize) -> String {
    format!("pending:{key}:{index}")
}

/// The pending row's files: what the picker made, before the upload gives them server ids.
pub(crate) fn pending_attachments(
    key: &str,
    files: &[crate::composer::FfiComposerFile],
) -> Vec<FfiAttachment> {
    files
        .iter()
        .enumerate()
        .map(|(index, file)| FfiAttachment {
            id: pending_attachment_id(key, index),
            name: file.name.clone(),
            mime_type: file.mime_type.clone(),
            size_bytes: std::fs::metadata(&file.path)
                .ok()
                .and_then(|meta| i64::try_from(meta.len()).ok())
                .unwrap_or(0),
            is_image: matches!(
                file.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            ),
        })
        .collect()
}

/// Appends a row for each send the snapshot doesn't show yet, and drops the sends that are done:
/// the server's row arrived, or it was accepted and a later full snapshot lacks it.
pub(crate) fn apply(snapshot: &mut FfiThreadSnapshot, sends: &mut Vec<PendingSend>) {
    sends.retain(|send| !send.echoed_in(&snapshot.entries) && !(send.acked && send.superseded));
    for send in sends.iter() {
        snapshot.entries.push(FfiTimelineEntry::QueuedUser {
            id: send.item_id(),
            run_id: String::new(),
            message_id: send.message_id(),
            text: send.text.clone(),
            created_at: send.created_at.clone(),
            created_by_agent: false,
            attachments: send.attachments.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(key: &str) -> PendingSend {
        PendingSend {
            key: key.to_owned(),
            text: format!("text {key}"),
            attachments: vec![FfiAttachment {
                id: pending_attachment_id(key, 0),
                name: "shot.png".to_owned(),
                mime_type: "image/png".to_owned(),
                size_bytes: 10,
                is_image: true,
            }],
            created_at: "2026-11-26T10:00:00.000Z".to_owned(),
            acked: false,
            superseded: false,
        }
    }

    fn snapshot(entries: Vec<FfiTimelineEntry>) -> FfiThreadSnapshot {
        let mut snap = crate::coalesce::tests::thread_snap("t", "", false);
        snap.entries = entries;
        snap
    }

    fn user(id: &str) -> FfiTimelineEntry {
        FfiTimelineEntry::User {
            id: id.to_owned(),
            text: "echo".to_owned(),
            created_at: None,
            created_by_agent: false,
            is_steer: false,
            run_id: None,
            attachments: Vec::new(),
        }
    }

    #[test]
    fn formats_epoch_ms_like_the_server() {
        assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            conn_state::parse_iso8601_epoch_ms(&iso_from_epoch_ms(1_795_046_400_123)),
            Some(1_795_046_400_123)
        );
        assert_eq!(
            iso_from_epoch_ms(1_795_046_400_123),
            "2026-11-19T00:00:00.123Z"
        );
    }

    #[test]
    fn a_send_shows_one_row_until_the_server_row_replaces_it() {
        let mut sends = vec![send("k1")];
        let mut before = snapshot(vec![user("turn-item:older")]);
        apply(&mut before, &mut sends);
        assert_eq!(before.entries.len(), 2, "the pending row follows the feed");
        assert!(matches!(
            &before.entries[1],
            FfiTimelineEntry::QueuedUser { id, text, attachments, .. }
                if id == "turn-item:message-k1" && text == "text k1" && attachments[0].id == "pending:k1:0"
        ));

        // The echo can land before the acknowledgement.
        let mut echoed = snapshot(vec![user("turn-item:older"), user("turn-item:message-k1")]);
        apply(&mut echoed, &mut sends);
        assert_eq!(echoed.entries.len(), 2, "exactly one row for the message");
        assert!(sends.is_empty(), "the echo ends the pending send");
    }

    #[test]
    fn a_queued_echo_matches_by_message_id() {
        let mut sends = vec![send("k2")];
        let mut snap = snapshot(vec![FfiTimelineEntry::QueuedUser {
            id: "turn-item:server-chosen".to_owned(),
            run_id: "run-2".to_owned(),
            message_id: "message-k2".to_owned(),
            text: "text k2".to_owned(),
            created_at: String::new(),
            created_by_agent: false,
            attachments: Vec::new(),
        }]);
        apply(&mut snap, &mut sends);
        assert_eq!(snap.entries.len(), 1);
        assert!(sends.is_empty());
    }

    #[test]
    fn an_accepted_send_missing_from_a_later_full_snapshot_is_dropped() {
        let mut sends = vec![send("k3")];
        sends[0].superseded = true;
        let mut snap = snapshot(Vec::new());
        apply(&mut snap, &mut sends);
        assert_eq!(snap.entries.len(), 1, "not yet accepted: the row stays");
        sends[0].acked = true;
        let mut snap = snapshot(Vec::new());
        apply(&mut snap, &mut sends);
        assert!(snap.entries.is_empty());
        assert!(sends.is_empty());
    }
}
