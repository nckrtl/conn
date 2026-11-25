//! Composer draft rules from Conn mobile's `use-thread-composer-state.ts` and
//! `use-composer-drafts.ts`.

use crate::{FfiError, FfiSendMode};
use conn_client::Connection;
use conn_contract::{ChatAttachment, ExecutionEnvironmentCapabilities};

#[derive(uniffi::Record)]
pub struct FfiComposerFile {
    pub path: String,
    pub name: String,
    pub mime_type: String,
}

impl std::fmt::Debug for FfiComposerFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FfiComposerFile")
            .field("mime_type", &self.mime_type)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, uniffi::Enum)]
pub enum FfiComposerTarget {
    New {
        project_id: Option<String>,
    },
    Reply {
        thread_id: String,
        mode: FfiSendMode,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct FfiComposerLimits {
    pub images: bool,
    pub max_file_bytes: Option<u64>,
}

impl FfiComposerLimits {
    pub(crate) fn new(caps: &ExecutionEnvironmentCapabilities) -> Self {
        let images = caps.attachment_uploads == Some(true);
        Self {
            images,
            max_file_bytes: caps
                .file_attachments
                .as_ref()
                .filter(|_| images)
                .and_then(|f| u64::try_from(f.max_upload_bytes).ok())
                .map(|size| size.min(conn_contract::PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
        }
    }

    pub(crate) async fn upload(
        self,
        connection: &Connection,
        files: Vec<FfiComposerFile>,
        ready: &mut Vec<ChatAttachment>,
        cache: Option<(
            &std::sync::Arc<crate::OfflineReader>,
            &str,
            &str,
            &tokio::runtime::Handle,
        )>,
    ) -> Result<(), FfiError> {
        let invalid = |message: String| FfiError::InvalidInput { message };
        if files.len() > 100 {
            return Err(invalid("Attach up to 100 files per message.".into()));
        }
        let mut image_bytes = 0;
        for file in files {
            let image = matches!(
                file.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            );
            let limit = if image {
                self.images.then_some(10 * 1024 * 1024)
            } else {
                self.max_file_bytes
            }
            .ok_or_else(|| invalid(format!("This server cannot upload {}.", file.name)))?;
            let read_error =
                |error: std::io::Error| invalid(format!("Could not read {}: {error}", file.name));
            let size = std::fs::metadata(&file.path).map_err(read_error)?.len();
            if size > limit {
                return Err(invalid(format!(
                    "{} exceeds the upload limit of {limit} bytes.",
                    file.name
                )));
            }
            if image {
                image_bytes += size;
                if image_bytes > 80 * 1024 * 1024 {
                    return Err(invalid("Images can total up to 80 MiB per message.".into()));
                }
            }
            // These are private, immutable copies made by the native picker.
            let bytes = std::fs::read(&file.path).map_err(read_error)?;
            let pick = cache.filter(|_| image).map(|cache| (cache, bytes.clone()));
            let uploaded = connection
                .upload_chat_attachment(file.name, file.mime_type, bytes)
                .await?;
            if let Some(((reader, thread, item, runtime), bytes)) = pick {
                let (reader, thread, item, index, file) = (
                    reader.clone(),
                    thread.to_owned(),
                    item.to_owned(),
                    ready.len(),
                    (&uploaded).into(),
                );
                let _ = runtime
                    .spawn(
                        async move { reader.seed_pick(&thread, &item, index, file, &bytes).await },
                    )
                    .await;
            }
            ready.push(uploaded);
        }
        Ok(())
    }
}

/// The draft after a send fails. Mobile clears the draft when it sends, so typing during a slow
/// send is kept; a failed send puts the sent text back in front of it (`mergeComposerDraftText`).
#[uniffi::export]
#[must_use]
pub fn composer_restore_draft(current: String, sent: String) -> String {
    if sent.is_empty() {
        return current;
    }
    if current.is_empty() {
        return sent;
    }
    if current == sent || current.ends_with(&format!("\n\n{sent}")) {
        return current;
    }
    format!("{current}\n\n{sent}")
}

#[cfg(test)]
mod tests {
    use super::composer_restore_draft;

    fn restore(current: &str, sent: &str) -> String {
        composer_restore_draft(current.to_owned(), sent.to_owned())
    }

    #[test]
    fn a_failed_send_keeps_what_was_typed_meanwhile() {
        assert_eq!(
            restore("", "fix the bug"),
            "fix the bug",
            "an untouched draft gets its text back"
        );
        assert_eq!(
            restore("and add a test", "fix the bug"),
            "and add a test\n\nfix the bug",
            "newer typing stays, the sent text follows"
        );
        assert_eq!(
            restore("fix the bug", "fix the bug"),
            "fix the bug",
            "the same text is not doubled"
        );
        assert_eq!(
            restore("more\n\nfix the bug", "fix the bug"),
            "more\n\nfix the bug",
            "a text already restored is not added twice"
        );
        assert_eq!(
            restore("draft", ""),
            "draft",
            "nothing sent changes nothing"
        );
    }
}
