//! Queued-message actions (desktop's `Send now`, `Edit`, `Remove`).

use conn_contract::{ChatAttachment, OrchestrationV2Command};

use crate::FfiError;
use crate::types::FfiAttachment;

/// `Send now`, as desktop picks it: steer the active run when there is one, else start the queued
/// run (`ConnApp::promote_queued_message`).
pub(crate) fn send_now_command(
    thread_id: &str,
    run_id: &str,
    active_run_id: Option<&str>,
) -> Result<OrchestrationV2Command, serde_json::Error> {
    match active_run_id {
        Some(target) => conn_client::commands::promote_queued_to_steer(thread_id, run_id, target),
        None => conn_client::commands::start_queued_run(thread_id, run_id),
    }
}

/// The attachments a `queued-run.edit` sends.
///
/// `None` leaves the message's files as they are (the server keeps them when the field is
/// absent). Otherwise the kept files, in their order, then the new uploads. `existing` is the
/// queued message's files as the core knows them; `None` means the run left the queue.
pub(crate) fn edit_attachments(
    existing: Option<Vec<ChatAttachment>>,
    kept_ids: Option<Vec<String>>,
    uploaded: Vec<ChatAttachment>,
) -> Result<Option<Vec<ChatAttachment>>, FfiError> {
    if kept_ids.is_none() && uploaded.is_empty() {
        return Ok(None);
    }
    let existing = existing.ok_or_else(|| FfiError::InvalidInput {
        message: "This message is no longer queued.".to_owned(),
    })?;
    let mut attachments: Vec<ChatAttachment> = match kept_ids {
        Some(ids) => existing
            .into_iter()
            .filter(|attachment| ids.contains(&FfiAttachment::from(attachment).id))
            .collect(),
        None => existing,
    };
    attachments.extend(uploaded);
    Ok(Some(attachments))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn file(id: &str) -> ChatAttachment {
        conn_contract::from_json(json!({
            "type": "file",
            "id": id,
            "name": format!("{id}.txt"),
            "mimeType": "text/plain",
            "sizeBytes": 4,
        }))
        .expect("valid file attachment")
    }

    fn ids(attachments: &[ChatAttachment]) -> Vec<String> {
        attachments
            .iter()
            .map(|attachment| FfiAttachment::from(attachment).id)
            .collect()
    }

    #[test]
    fn send_now_steers_the_active_run_or_starts_the_queued_one() {
        let steer = conn_contract::to_json(
            &send_now_command("t1", "run-q", Some("run-active")).expect("promote builds"),
        );
        assert_eq!(steer["type"], json!("queued-message.promote-to-steer"));
        assert_eq!(steer["queuedRunId"], json!("run-q"));
        assert_eq!(steer["targetRunId"], json!("run-active"));

        let start =
            conn_contract::to_json(&send_now_command("t1", "run-q", None).expect("start builds"));
        assert_eq!(start["type"], json!("queued-run.start"));
        assert_eq!(start["runId"], json!("run-q"));
    }

    #[test]
    fn edit_attachments_keep_unchanged_files_out_of_the_command() {
        assert_eq!(
            edit_attachments(Some(vec![file("a")]), None, Vec::new()).expect("no change"),
            None
        );
        // Nothing to change means no lookup is needed, even after the run left the queue.
        assert_eq!(
            edit_attachments(None, None, Vec::new()).expect("no change"),
            None
        );
    }

    #[test]
    fn edit_attachments_drop_removed_files_and_append_uploads() {
        let existing = Some(vec![file("a"), file("b"), file("c")]);
        let kept = edit_attachments(
            existing.clone(),
            Some(vec!["c".to_owned(), "a".to_owned()]),
            vec![file("new")],
        )
        .expect("edit attachments")
        .expect("a list is sent");
        assert_eq!(ids(&kept), ["a", "c", "new"]);

        let all_removed = edit_attachments(existing.clone(), Some(Vec::new()), Vec::new())
            .expect("edit attachments")
            .expect("an empty list removes every file");
        assert!(all_removed.is_empty());

        let added = edit_attachments(existing, None, vec![file("new")])
            .expect("edit attachments")
            .expect("a list is sent");
        assert_eq!(ids(&added), ["a", "b", "c", "new"]);
    }

    #[test]
    fn edit_attachments_refuse_a_run_that_left_the_queue() {
        let err = edit_attachments(None, Some(vec!["a".to_owned()]), Vec::new())
            .expect_err("no queued message to edit");
        assert!(matches!(err, FfiError::InvalidInput { .. }), "{err:?}");
    }
}
