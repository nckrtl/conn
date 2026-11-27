//! Composer draft rules from Conn mobile's `use-thread-composer-state.ts` and
//! `use-composer-drafts.ts`.

use std::sync::Arc;

use crate::{ConnCore, FfiError, FfiSendMode};
use conn_client::uploads::{
    Encoded, FileSource, ImageCodec, ImageInfo, LocalFile, ReadyUpload, UploadLimits, UploadStatus,
};
use conn_contract::ExecutionEnvironmentCapabilities;

#[derive(Clone, uniffi::Record)]
pub struct FfiComposerFile {
    /// The draft's id for this file; its upload is keyed by it.
    pub id: String,
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

impl FfiComposerFile {
    pub(crate) fn local(&self) -> (String, LocalFile) {
        (
            self.id.clone(),
            LocalFile {
                source: FileSource::Path(self.path.clone().into()),
                name: self.name.clone(),
                mime_type: self.mime_type.clone(),
            },
        )
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
}

impl From<FfiComposerLimits> for UploadLimits {
    fn from(limits: FfiComposerLimits) -> Self {
        Self {
            images: limits.images,
            max_file_bytes: limits.max_file_bytes,
        }
    }
}

/// A draft file's upload (`AttachmentUploadStatus`).
#[derive(Clone, Debug, PartialEq, uniffi::Enum)]
pub enum FfiUploadStatus {
    /// `progress` is the share sent, 0 to 1 in 5% steps.
    Uploading {
        progress: f32,
    },
    Ready,
    Failed {
        reason: String,
    },
}

impl From<&UploadStatus> for FfiUploadStatus {
    fn from(status: &UploadStatus) -> Self {
        match status {
            UploadStatus::Uploading { progress } => Self::Uploading {
                progress: *progress,
            },
            UploadStatus::Ready => Self::Ready,
            UploadStatus::Failed { reason } => Self::Failed {
                reason: reason.clone(),
            },
        }
    }
}

/// Upload status changes; `None` once the upload is gone (removed or sent).
#[uniffi::export(with_foreign)]
pub trait FfiUploadListener: Send + Sync {
    fn on_upload(&self, id: String, status: Option<FfiUploadStatus>);
}

#[derive(Clone, Copy, Debug, uniffi::Record)]
pub struct FfiImageInfo {
    pub width: u32,
    pub height: u32,
    pub alpha: bool,
}

#[derive(Debug, uniffi::Record)]
pub struct FfiEncodedImage {
    pub jpeg: Option<Vec<u8>>,
    pub png: Option<Vec<u8>>,
}

/// The app's image codec (ImageIO on iPhone); the core decides sizes and formats
/// (`conn_client::uploads::prepare`).
#[uniffi::export(with_foreign)]
pub trait FfiImageCodec: Send + Sync {
    /// The size once the orientation is applied, and whether the image has transparency.
    fn inspect(&self, bytes: Vec<u8>) -> Option<FfiImageInfo>;
    /// Scales to exactly `width`×`height` after orienting, then encodes a JPEG when
    /// `jpeg_quality` is set and a PNG when `png` is.
    fn encode(
        &self,
        bytes: Vec<u8>,
        width: u32,
        height: u32,
        jpeg_quality: Option<f32>,
        png: bool,
    ) -> Option<FfiEncodedImage>;
}

struct ForeignCodec(Arc<dyn FfiImageCodec>);

impl ImageCodec for ForeignCodec {
    fn inspect(&self, bytes: &[u8]) -> Option<ImageInfo> {
        self.0.inspect(bytes.to_vec()).map(|info| ImageInfo {
            width: info.width,
            height: info.height,
            alpha: info.alpha,
        })
    }

    fn encode(
        &self,
        bytes: &[u8],
        width: u32,
        height: u32,
        jpeg_quality: Option<f32>,
        png: bool,
    ) -> Option<Encoded> {
        self.0
            .encode(bytes.to_vec(), width, height, jpeg_quality, png)
            .map(|encoded| Encoded {
                jpeg: encoded.jpeg,
                png: encoded.png,
            })
    }
}

/// Draft files upload as soon as they are attached (`attachmentUploads.ts`).
#[uniffi::export]
impl ConnCore {
    /// The listener for status changes and the codec that scales images before they upload.
    pub fn set_upload_handlers(
        &self,
        listener: Arc<dyn FfiUploadListener>,
        codec: Arc<dyn FfiImageCodec>,
    ) {
        self.uploads.set_listener(Arc::new(move |id, status| {
            listener.on_upload(id.to_owned(), status.map(FfiUploadStatus::from));
        }));
        self.uploads.set_codec(Arc::new(ForeignCodec(codec)));
    }

    /// Starts uploading a file the draft holds, unless it already is.
    pub fn attach_upload(&self, file: FfiComposerFile) {
        self.uploads.set_limits(self.composer_limits().into());
        let (id, file) = file.local();
        self.uploads.add(&id, file);
    }

    /// The draft let go of the file: stops its upload or deletes it from the server.
    pub fn drop_upload(&self, id: String) {
        self.uploads.remove(&id);
    }

    pub fn retry_upload(&self, id: String) {
        self.uploads.retry(&id);
    }

    #[must_use]
    pub fn upload_status(&self, id: String) -> Option<FfiUploadStatus> {
        self.uploads.status(&id).as_ref().map(FfiUploadStatus::from)
    }
}

impl ConnCore {
    /// The files' uploads for a send, waiting for any still running.
    pub(crate) async fn ready_uploads(
        &self,
        files: &[FfiComposerFile],
    ) -> Result<Vec<ReadyUpload>, FfiError> {
        self.uploads.set_limits(self.composer_limits().into());
        // Waiting needs no Tokio context; the uploads run on the connection's runtime.
        self.uploads
            .ready(files.iter().map(FfiComposerFile::local).collect())
            .await
            .map_err(|message| FfiError::InvalidInput { message })
    }

    /// A send that claimed these files' uploads went through.
    pub(crate) fn uploads_sent(&self, files: &[FfiComposerFile]) {
        let ids: Vec<String> = files.iter().map(|file| file.id.clone()).collect();
        self.uploads.sent(&ids);
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
