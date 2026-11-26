//! The composer's side of new-thread drafts: what each draft holds, for the sidebar rows and
//! the drafts file, and how a discarded or restored draft goes in and out of the store.

use gpui_kit::App;

use super::super::composer_state::ComposerDraft;
use super::{AttachmentUploadStatus, Composer, PendingAttachment};
use crate::drafts::{DraftAttachment, DraftContent};

/// The part of a draft that outlives the process: its text and its uploaded attachments.
fn saved_content(text: &str, attachments: &[PendingAttachment]) -> DraftContent {
    DraftContent {
        text: text.to_owned(),
        attachments: attachments
            .iter()
            .filter_map(|attachment| match &attachment.status {
                AttachmentUploadStatus::Ready(descriptor) => Some(DraftAttachment {
                    name: attachment.name.clone(),
                    size_bytes: attachment.size_bytes,
                    attachment: descriptor.clone(),
                }),
                AttachmentUploadStatus::Uploading | AttachmentUploadStatus::Error(_) => None,
            })
            .collect(),
    }
}

/// The name and size an uploaded attachment shows with in the composer.
fn attachment_name_and_size(attachment: &conn_contract::ChatAttachment) -> (String, usize) {
    let (name, size) = match attachment {
        conn_contract::ChatAttachment::Image(image) => (&image.name, image.size_bytes),
        conn_contract::ChatAttachment::File(file) => (&file.name, file.size_bytes),
        conn_contract::ChatAttachment::Unknown(other) => (&other.name, other.size_bytes),
    };
    (name.clone(), usize::try_from(size).unwrap_or(0))
}

impl Composer {
    /// Calls `visit(key, text, attachment count)` for every draft the composer holds: each
    /// parked one, then the live one under the active key.
    pub(crate) fn visit_drafts(&self, cx: &App, mut visit: impl FnMut(&str, &str, usize)) {
        for (key, draft) in self.drafts.parked_drafts() {
            visit(key, &draft.text, draft.attachments.len());
        }
        if let Some(key) = self.drafts.active_key() {
            let text = self.textarea.read(cx).value();
            visit(key, &text, self.attachments.len());
        }
    }

    /// What every draft holds that outlives a restart, by store key.
    pub(crate) fn saved_drafts(&self, cx: &App) -> Vec<(String, DraftContent)> {
        let mut saved: Vec<(String, DraftContent)> = self
            .drafts
            .parked_drafts()
            .map(|(key, draft)| {
                (
                    key.to_owned(),
                    saved_content(&draft.text, &draft.attachments),
                )
            })
            .collect();
        if let Some(key) = self.drafts.active_key() {
            let text = self.textarea.read(cx).value().to_string();
            saved.push((key.to_owned(), saved_content(&text, &self.attachments)));
        }
        saved
    }

    /// Puts a draft's text and attachments back under `key` (read from disk, or an undone
    /// discard). It shows when the composer next syncs to `key`.
    pub(crate) fn restore_draft(&mut self, key: &str, content: DraftContent) {
        let attachments = content
            .attachments
            .into_iter()
            .map(|saved| {
                let local_id = self.next_attachment_id;
                self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
                PendingAttachment {
                    local_id,
                    name: saved.name,
                    size_bytes: saved.size_bytes,
                    status: AttachmentUploadStatus::Ready(saved.attachment),
                }
            })
            .collect();
        self.drafts.park(
            key,
            ComposerDraft {
                text: content.text,
                attachments,
            },
        );
    }

    /// Puts a message whose send failed back under `key`: in the composer when `key` shows,
    /// else parked for that thread. Its text replaces the shown draft's text, as before; its
    /// attachments go before any the user added since. A parked draft keeps what was typed
    /// since, after the message.
    pub(crate) fn return_unsent(
        &mut self,
        key: &str,
        text: String,
        attachments: Vec<conn_contract::ChatAttachment>,
        window: Option<&mut gpui_kit::Window>,
        cx: &mut gpui_kit::Context<'_, Self>,
    ) {
        let mut returned: Vec<PendingAttachment> = attachments
            .into_iter()
            .map(|attachment| {
                let local_id = self.next_attachment_id;
                self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
                let (name, size_bytes) = attachment_name_and_size(&attachment);
                PendingAttachment {
                    local_id,
                    name,
                    size_bytes,
                    status: AttachmentUploadStatus::Ready(attachment),
                }
            })
            .collect();
        if self.drafts.active_key() == Some(key) {
            let Some(window) = window else {
                return;
            };
            returned.append(&mut self.attachments);
            self.attachments = returned;
            self.set_draft_text(text, window, cx);
            return;
        }
        let parked = self.drafts.discard(key).unwrap_or_default();
        let text = if parked.text.trim().is_empty() {
            text
        } else {
            format!("{text}\n\n{}", parked.text)
        };
        returned.extend(parked.attachments);
        self.drafts.park(
            key,
            ComposerDraft {
                text,
                attachments: returned,
            },
        );
        cx.notify();
    }

    /// Drops `key`'s draft once it is sent or discarded (`clearDraftThread`) and returns what
    /// it held, for an undo. The live draft clears on the next sync.
    pub(crate) fn discard_draft_key(&mut self, key: &str, cx: &App) -> Option<DraftContent> {
        let live = (self.drafts.active_key() == Some(key)).then(|| {
            let text = self.textarea.read(cx).value().to_string();
            saved_content(&text, &self.attachments)
        });
        let parked = self
            .drafts
            .discard(key)
            .map(|draft| saved_content(&draft.text, &draft.attachments));
        live.or(parked).filter(DraftContent::has_content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(local_id: u64, status: AttachmentUploadStatus) -> PendingAttachment {
        PendingAttachment {
            local_id,
            name: format!("file-{local_id}.txt"),
            size_bytes: 3,
            status,
        }
    }

    #[test]
    fn only_uploaded_attachments_outlive_the_process() {
        let ready: conn_contract::ChatAttachment = conn_contract::from_json(serde_json::json!({
            "type": "file",
            "id": "att-1",
            "name": "file-1.txt",
            "mimeType": "text/plain",
            "sizeBytes": 3,
        }))
        .expect("a file attachment");
        let content = saved_content(
            "text",
            &[
                pending(1, AttachmentUploadStatus::Ready(ready)),
                pending(2, AttachmentUploadStatus::Uploading),
                pending(3, AttachmentUploadStatus::Error("offline".to_owned())),
            ],
        );
        assert_eq!(content.text, "text");
        let names: Vec<&str> = content
            .attachments
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert_eq!(names, vec!["file-1.txt"]);
    }
}
