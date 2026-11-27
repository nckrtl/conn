//! Composer uploads, as T3's `attachmentUploads.ts`: a file starts uploading as soon as it is
//! attached and waits on the server as a pending upload; a send only claims it. Images are
//! re-encoded first ([`prepare`]) so they carry no more pixels than a provider reads.

use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError, Weak},
    task::{Context, Poll},
    time::{Duration, SystemTime},
};

use bytes::Bytes;
use conn_contract::ChatAttachment;
use http_body::{Body, Frame, SizeHint};
use tokio::sync::{Semaphore, watch};

use crate::Connection;

/// Claude's image limit since Opus 4.7: a larger image is scaled down to fit both bounds, so
/// more pixels only cost upload time.
pub const MAX_LONG_EDGE: u32 = 2576;
pub const MAX_PIXELS: u64 = 3_750_000;
/// ImageIO 0.6 to 0.8 look the same on photos and text at 1:1; 0.7 keeps a margin for fine text.
pub const JPEG_QUALITY: f32 = 0.7;
/// `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`, the per-message image budget and file count.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_MESSAGE_IMAGE_BYTES: u64 = 80 * 1024 * 1024;
pub const MAX_FILES: usize = 100;
/// Uploads to one server at once (Conn mobile's `concurrencyPerEnvironment`).
const UPLOADS_AT_ONCE: usize = 3;
/// The server sweeps pending uploads after 24 hours; an older one uploads again before a send.
const READY_MAX_AGE: Duration = Duration::from_secs(23 * 60 * 60);
const CHUNK: usize = 64 * 1024;

/// Whether an upload finished at `at` may be gone by `now`. Wall-clock time, as the server's
/// sweep: `Instant` stops while the device sleeps. A clock set back counts as stale.
fn is_stale(at: SystemTime, now: SystemTime) -> bool {
    !now.duration_since(at).is_ok_and(|age| age <= READY_MAX_AGE)
}

/// An image's size once its orientation is applied, and whether it has transparency.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub alpha: bool,
}

#[derive(Debug, Default)]
pub struct Encoded {
    pub jpeg: Option<Vec<u8>>,
    pub png: Option<Vec<u8>>,
}

/// The platform's image decoder and encoders: ImageIO on iPhone, the `image` crate on desktop.
pub trait ImageCodec: Send + Sync {
    fn inspect(&self, bytes: &[u8]) -> Option<ImageInfo>;
    /// Decodes once, applies the orientation, scales to `width`×`height`, and encodes a JPEG
    /// when `jpeg_quality` is set and a PNG when `png` is.
    fn encode(
        &self,
        bytes: &[u8],
        width: u32,
        height: u32,
        jpeg_quality: Option<f32>,
        png: bool,
    ) -> Option<Encoded>;
}

/// The largest size within [`MAX_LONG_EDGE`] and [`MAX_PIXELS`] with the image's aspect.
#[must_use]
pub fn fit(width: u32, height: u32) -> (u32, u32) {
    let (w, h) = (f64::from(width), f64::from(height));
    let scale = (f64::from(MAX_LONG_EDGE) / w.max(h))
        .min((MAX_PIXELS as f64 / (w * h)).sqrt())
        .min(1.0);
    if scale >= 1.0 || width == 0 || height == 0 {
        return (width, height);
    }
    let side = |v: f64| ((v * scale).floor() as u32).max(1);
    (side(w), side(h))
}

/// A file as it will upload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prepared {
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// The server's image types; anything else uploads as a file.
#[must_use]
pub fn is_upload_image(mime_type: &str) -> bool {
    matches!(
        mime_type.to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
    )
}

/// Scales a photo or screenshot to [`fit`] and keeps the smallest of a JPEG, a PNG (for a PNG
/// source or transparency) and the untouched original (when it needs no scaling). HEIC becomes
/// JPEG. GIF, WebP and files pass through, as does anything the codec cannot read.
#[must_use]
pub fn prepare(
    name: &str,
    mime_type: &str,
    bytes: Vec<u8>,
    codec: Option<&dyn ImageCodec>,
) -> Prepared {
    let source = mime_type.to_ascii_lowercase();
    let png_source = source == "image/png";
    let jpeg_source = matches!(source.as_str(), "image/jpeg" | "image/jpg");
    let encodable =
        png_source || jpeg_source || matches!(source.as_str(), "image/heic" | "image/heif");
    let unchanged = |bytes| Prepared {
        name: name.to_owned(),
        mime_type: mime_type.to_owned(),
        bytes,
    };
    let Some(codec) = codec.filter(|_| encodable) else {
        return unchanged(bytes);
    };
    let Some(info) = codec.inspect(&bytes) else {
        return unchanged(bytes);
    };
    let (width, height) = fit(info.width, info.height);
    let resized = (width, height) != (info.width, info.height);
    let Some(encoded) = codec.encode(
        &bytes,
        width,
        height,
        (!info.alpha).then_some(JPEG_QUALITY),
        png_source || info.alpha,
    ) else {
        return unchanged(bytes);
    };
    let original = (!resized && (png_source || jpeg_source)).then_some(bytes);
    // JPEG is the default; PNG stays only when it is smaller.
    let mut best: Option<(Vec<u8>, &str)> = None;
    for (candidate, mime) in [
        (
            original,
            if png_source {
                "image/png"
            } else {
                "image/jpeg"
            },
        ),
        (encoded.jpeg, "image/jpeg"),
        (encoded.png, "image/png"),
    ] {
        if let Some(candidate) = candidate
            && best.as_ref().is_none_or(|(b, _)| candidate.len() < b.len())
        {
            best = Some((candidate, mime));
        }
    }
    let Some((bytes, mime)) = best else {
        return unchanged(Vec::new());
    };
    let extension = if mime == "image/png" { "png" } else { "jpg" };
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem).trim();
    Prepared {
        name: format!(
            "{}.{extension}",
            if stem.is_empty() { "image" } else { stem }
        ),
        mime_type: mime.to_owned(),
        bytes,
    }
}

/// What the server accepts (`FfiComposerLimits`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UploadLimits {
    pub images: bool,
    pub max_file_bytes: Option<u64>,
}

impl Default for UploadLimits {
    fn default() -> Self {
        Self {
            images: true,
            max_file_bytes: Some(50 * 1024 * 1024),
        }
    }
}

impl UploadLimits {
    /// # Errors
    /// The reason the server would refuse this file.
    pub fn check(&self, file: &Prepared) -> Result<(), String> {
        let limit = if is_upload_image(&file.mime_type) {
            self.images.then_some(MAX_IMAGE_BYTES)
        } else {
            self.max_file_bytes
        }
        .ok_or_else(|| format!("This server cannot upload {}.", file.name))?;
        if file.bytes.len() as u64 > limit {
            return Err(format!(
                "{} is larger than {} MiB.",
                file.name,
                limit / (1024 * 1024)
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum UploadStatus {
    /// Waiting its turn, preparing or sending; `progress` is the share sent, in 5% steps.
    Uploading {
        progress: f32,
    },
    Ready,
    Failed {
        reason: String,
    },
}

#[derive(Clone, Debug)]
pub enum FileSource {
    /// A private copy the picker made; it must stay until the upload is done.
    Path(PathBuf),
    Bytes(Arc<Vec<u8>>),
}

#[derive(Clone, Debug)]
pub struct LocalFile {
    pub source: FileSource,
    pub name: String,
    pub mime_type: String,
}

impl LocalFile {
    fn read(&self) -> Result<Vec<u8>, String> {
        match &self.source {
            FileSource::Path(path) => std::fs::read(path)
                .map_err(|error| format!("Could not read {}: {error}", self.name)),
            FileSource::Bytes(bytes) => Ok(bytes.as_ref().clone()),
        }
    }
}

/// An upload the server holds, with the bytes it got.
#[derive(Clone, Debug)]
pub struct ReadyUpload {
    pub attachment: ChatAttachment,
    pub bytes: Arc<Vec<u8>>,
}

pub type UploadListener = Arc<dyn Fn(&str, Option<&UploadStatus>) + Send + Sync>;

type Outcome = Option<Result<(ReadyUpload, SystemTime), String>>;

struct Entry {
    file: LocalFile,
    status: UploadStatus,
    generation: u64,
    done: watch::Receiver<Outcome>,
    task: tokio::task::AbortHandle,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    codec: Option<Arc<dyn ImageCodec>>,
    limits: UploadLimits,
    listener: Option<UploadListener>,
    generations: u64,
}

struct Shared {
    connection: Connection,
    permits: Arc<Semaphore>,
    state: Mutex<State>,
}

/// One connection's uploads, by the caller's attachment id.
#[derive(Clone)]
pub struct Uploads(Arc<Shared>);

impl std::fmt::Debug for Uploads {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Uploads")
            .field("count", &self.state().entries.len())
            .finish()
    }
}

type Change = (String, Option<UploadStatus>);

impl Uploads {
    #[must_use]
    pub fn new(connection: Connection) -> Self {
        Self(Arc::new(Shared {
            connection,
            permits: Arc::new(Semaphore::new(UPLOADS_AT_ONCE)),
            state: Mutex::default(),
        }))
    }

    /// Whether both handles are the same queue.
    #[must_use]
    pub fn same_queue(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn notify(&self, changes: Vec<Change>) {
        let Some(listener) = self.state().listener.clone() else {
            return;
        };
        for (id, status) in changes {
            listener(&id, status.as_ref());
        }
    }

    pub fn set_listener(&self, listener: UploadListener) {
        self.state().listener = Some(listener);
    }

    pub fn set_codec(&self, codec: Arc<dyn ImageCodec>) {
        self.state().codec = Some(codec);
    }

    pub fn set_limits(&self, limits: UploadLimits) {
        self.state().limits = limits;
    }

    #[must_use]
    pub fn status(&self, id: &str) -> Option<UploadStatus> {
        self.state()
            .entries
            .get(id)
            .map(|entry| entry.status.clone())
    }

    /// Starts the file's upload unless `id` already has one.
    pub fn add(&self, id: &str, file: LocalFile) {
        let change = {
            let mut state = self.state();
            if state.entries.contains_key(id) {
                return;
            }
            self.start(&mut state, id, file)
        };
        self.notify(vec![change]);
    }

    /// Stops the upload, or deletes it from the server when it is done.
    pub fn remove(&self, id: &str) {
        let Some(entry) = self.state().entries.remove(id) else {
            return;
        };
        entry.task.abort();
        let uploaded = entry.done.borrow().clone();
        if let Some(Ok((ready, _))) = uploaded {
            self.delete_pending(vec![ready.attachment]);
        }
        self.notify(vec![(id.to_owned(), None)]);
    }

    /// Starts a failed upload again.
    pub fn retry(&self, id: &str) {
        let change = {
            let mut state = self.state();
            let Some(entry) = state.entries.get(id) else {
                return;
            };
            if !matches!(entry.status, UploadStatus::Failed { .. }) {
                return;
            }
            let file = entry.file.clone();
            self.start(&mut state, id, file)
        };
        self.notify(vec![change]);
    }

    /// The uploads for a send, in order: done ones at once, running ones when they finish. A
    /// failed or missing one starts (again) first. Fails with the first file that cannot upload.
    ///
    /// # Errors
    /// A file that failed to upload, or a message over the file count or image budget.
    pub async fn ready(&self, files: Vec<(String, LocalFile)>) -> Result<Vec<ReadyUpload>, String> {
        if files.len() > MAX_FILES {
            return Err(format!("Attach up to {MAX_FILES} files per message."));
        }
        let mut changes = Vec::new();
        let waits: Vec<(String, watch::Receiver<Outcome>)> =
            {
                let mut state = self.state();
                files
                    .into_iter()
                    .map(|(id, file)| {
                        let stale = state.entries.get(&id).is_none_or(|entry| {
                            match &*entry.done.borrow() {
                                Some(Err(_)) => true,
                                Some(Ok((_, at))) => is_stale(*at, SystemTime::now()),
                                None => false,
                            }
                        });
                        if stale {
                            let file = state.entries.get(&id).map_or(file, |e| e.file.clone());
                            changes.push(self.start(&mut state, &id, file));
                        }
                        let name = state.entries[&id].file.name.clone();
                        (name, state.entries[&id].done.clone())
                    })
                    .collect()
            };
        self.notify(changes);
        let mut ready = Vec::with_capacity(waits.len());
        for (name, mut done) in waits {
            let outcome = done
                .wait_for(Option::is_some)
                .await
                .map(|outcome| outcome.clone())
                .ok()
                .flatten()
                .unwrap_or_else(|| Err("Upload cancelled.".to_owned()));
            ready.push(
                outcome
                    .map(|(upload, _)| upload)
                    .map_err(|reason| format!("{name} could not upload: {reason}"))?,
            );
        }
        let image_bytes: u64 = ready
            .iter()
            .filter(|upload| matches!(upload.attachment, ChatAttachment::Image(_)))
            .map(|upload| upload.bytes.len() as u64)
            .sum();
        if image_bytes > MAX_MESSAGE_IMAGE_BYTES {
            return Err("Images can total up to 80 MiB per message.".to_owned());
        }
        Ok(ready)
    }

    /// The finished upload, if `id` has one.
    #[must_use]
    pub fn uploaded(&self, id: &str) -> Option<ReadyUpload> {
        let state = self.state();
        let done = state.entries.get(id)?.done.borrow().clone();
        done?.ok().map(|(ready, _)| ready)
    }

    /// Forgets uploads a sent message claimed, and deletes their pending copies.
    pub fn sent(&self, ids: &[String]) {
        let claimed = self.forget(ids);
        self.delete_pending(claimed);
    }

    /// Forgets these uploads and leaves their pending copies to the server's sweep, for a
    /// draft that keeps their ids (desktop restores a refused send from them).
    pub fn forget(&self, ids: &[String]) -> Vec<ChatAttachment> {
        let mut claimed = Vec::new();
        {
            let mut state = self.state();
            for id in ids {
                if let Some(entry) = state.entries.remove(id) {
                    entry.task.abort();
                    if let Some(Ok((ready, _))) = entry.done.borrow().clone() {
                        claimed.push(ready.attachment);
                    }
                }
            }
        }
        self.notify(ids.iter().map(|id| (id.clone(), None)).collect());
        claimed
    }

    fn delete_pending(&self, attachments: Vec<ChatAttachment>) {
        if attachments.is_empty() {
            return;
        }
        let connection = self.0.connection.clone();
        self.0.connection.runtime().spawn(async move {
            // The server sweeps pending uploads, so a lost delete only costs disk for a day.
            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                for attachment in &attachments {
                    let id = match attachment {
                        ChatAttachment::Image(a) => &a.id,
                        ChatAttachment::File(a) => &a.id,
                        ChatAttachment::Unknown(a) => &a.id,
                    };
                    let _ = connection
                        .call_json(
                            "attachments.delete",
                            serde_json::json!({ "attachmentId": id }),
                        )
                        .await;
                }
            })
            .await;
        });
    }

    fn start(&self, state: &mut State, id: &str, file: LocalFile) -> Change {
        if let Some(previous) = state.entries.get(id) {
            previous.task.abort();
        }
        state.generations += 1;
        let generation = state.generations;
        let (tx, done) = watch::channel(None);
        let weak = Arc::downgrade(&self.0);
        let codec = state.codec.clone();
        let limits = state.limits;
        let task_id = id.to_owned();
        let task_file = file.clone();
        let task = self
            .0
            .connection
            .runtime()
            .spawn(async move {
                let outcome = transfer(&weak, &task_id, generation, task_file, codec, limits).await;
                if let Some(shared) = weak.upgrade() {
                    Uploads(shared).finish(&task_id, generation, &outcome);
                }
                let _ = tx.send(Some(outcome));
            })
            .abort_handle();
        let status = UploadStatus::Uploading { progress: 0.0 };
        state.entries.insert(
            id.to_owned(),
            Entry {
                file,
                status: status.clone(),
                generation,
                done,
                task,
            },
        );
        (id.to_owned(), Some(status))
    }

    fn update(&self, id: &str, generation: u64, status: UploadStatus) {
        {
            let mut state = self.state();
            let Some(entry) = state
                .entries
                .get_mut(id)
                .filter(|entry| entry.generation == generation && entry.status != status)
            else {
                return;
            };
            entry.status = status.clone();
        }
        self.notify(vec![(id.to_owned(), Some(status))]);
    }

    fn finish(
        &self,
        id: &str,
        generation: u64,
        outcome: &Result<(ReadyUpload, SystemTime), String>,
    ) {
        let status = match outcome {
            Ok(_) => UploadStatus::Ready,
            Err(reason) => UploadStatus::Failed {
                reason: reason.clone(),
            },
        };
        self.update(id, generation, status);
    }
}

async fn transfer(
    weak: &Weak<Shared>,
    id: &str,
    generation: u64,
    file: LocalFile,
    codec: Option<Arc<dyn ImageCodec>>,
    limits: UploadLimits,
) -> Result<(ReadyUpload, SystemTime), String> {
    let (connection, permits) = {
        let shared = weak.upgrade().ok_or("Upload cancelled.")?;
        (shared.connection.clone(), shared.permits.clone())
    };
    let _permit = permits.acquire_owned().await.map_err(|e| e.to_string())?;
    let prepared = tokio::task::spawn_blocking(move || {
        let prepared = prepare(&file.name, &file.mime_type, file.read()?, codec.as_deref());
        limits.check(&prepared)?;
        Ok::<_, String>(prepared)
    })
    .await
    .map_err(|error| error.to_string())??;
    let bytes = Arc::new(prepared.bytes);
    let progress_weak = weak.clone();
    let progress_id = id.to_owned();
    let progress = Arc::new(move |share: f32| {
        if let Some(shared) = progress_weak.upgrade() {
            let progress = (share.clamp(0.0, 1.0) * 20.0).floor() / 20.0;
            Uploads(shared).update(
                &progress_id,
                generation,
                UploadStatus::Uploading { progress },
            );
        }
    });
    let attachment = connection
        .upload_chat_attachment_with_progress(
            prepared.name,
            prepared.mime_type,
            bytes.as_ref().clone(),
            progress,
        )
        .await
        .map_err(|error| match error {
            crate::ClientError::Connection(message) => message,
            other => other.to_string(),
        })?;
    Ok((ReadyUpload { attachment, bytes }, SystemTime::now()))
}

/// An upload body sent in chunks, reporting the share handed to the connection.
pub(crate) struct ProgressBody {
    data: Bytes,
    sent: usize,
    progress: Arc<dyn Fn(f32) + Send + Sync>,
}

impl ProgressBody {
    pub(crate) fn new(data: Vec<u8>, progress: Arc<dyn Fn(f32) + Send + Sync>) -> Self {
        Self {
            data: data.into(),
            sent: 0,
            progress,
        }
    }
}

impl Body for ProgressBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let len = self.data.len();
        if self.sent >= len {
            return Poll::Ready(None);
        }
        (self.progress)(self.sent as f32 / len as f32);
        let end = (self.sent + CHUNK).min(len);
        let chunk = self.data.slice(self.sent..end);
        self.sent = end;
        Poll::Ready(Some(Ok(Frame::data(chunk))))
    }

    fn is_end_stream(&self) -> bool {
        self.sent >= self.data.len()
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact((self.data.len() - self.sent) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_age_uses_wall_clock_time() {
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert!(!is_stale(at, at + Duration::from_secs(60)));
        assert!(!is_stale(at, at + READY_MAX_AGE));
        // A day asleep still counts: the server swept it.
        assert!(is_stale(at, at + Duration::from_secs(24 * 60 * 60)));
        assert!(
            is_stale(at, at - Duration::from_secs(1)),
            "a clock set back"
        );
    }

    /// Encodes to sizes chosen by the test: a JPEG of `jpeg` bytes, a PNG of `png` bytes.
    struct FakeCodec {
        info: Option<ImageInfo>,
        jpeg: usize,
        png: usize,
        asked: Mutex<Vec<(u32, u32, bool, bool)>>,
    }

    impl FakeCodec {
        fn new(width: u32, height: u32, alpha: bool, jpeg: usize, png: usize) -> Self {
            Self {
                info: Some(ImageInfo {
                    width,
                    height,
                    alpha,
                }),
                jpeg,
                png,
                asked: Mutex::default(),
            }
        }
    }

    impl ImageCodec for FakeCodec {
        fn inspect(&self, _: &[u8]) -> Option<ImageInfo> {
            self.info
        }
        fn encode(
            &self,
            _: &[u8],
            width: u32,
            height: u32,
            jpeg_quality: Option<f32>,
            png: bool,
        ) -> Option<Encoded> {
            self.asked
                .lock()
                .unwrap()
                .push((width, height, jpeg_quality.is_some(), png));
            Some(Encoded {
                jpeg: jpeg_quality.map(|_| vec![b'j'; self.jpeg]),
                png: png.then(|| vec![b'p'; self.png]),
            })
        }
    }

    #[test]
    fn fit_keeps_claudes_bounds() {
        assert_eq!(
            fit(4032, 3024),
            (2236, 1677),
            "a 12 MP photo meets the pixel cap"
        );
        assert_eq!(
            fit(1206, 2622),
            (1184, 2576),
            "a tall screenshot meets the long edge"
        );
        assert_eq!(fit(1920, 1080), (1920, 1080), "1080p already fits");
        assert_eq!(fit(8000, 10), (2576, 3));
        let (w, h) = fit(8064, 6048);
        assert!(u64::from(w) * u64::from(h) <= MAX_PIXELS && w.max(h) <= MAX_LONG_EDGE);
    }

    #[test]
    fn prepare_picks_the_smallest_and_renames() {
        let photo = FakeCodec::new(4032, 3024, false, 700, 0);
        let out = prepare("IMG_1.HEIC", "image/heic", vec![0; 3_000_000], Some(&photo));
        assert_eq!(
            (out.name.as_str(), out.mime_type.as_str(), out.bytes.len()),
            ("IMG_1.jpg", "image/jpeg", 700)
        );
        assert_eq!(
            photo.asked.lock().unwrap()[0],
            (2236, 1677, true, false),
            "no PNG for a photo"
        );

        let text = FakeCodec::new(1206, 2622, false, 900, 400);
        let out = prepare("shot.png", "image/png", vec![0; 2_000_000], Some(&text));
        assert_eq!(
            (out.name.as_str(), out.mime_type.as_str()),
            ("shot.png", "image/png"),
            "text stays PNG when smaller"
        );

        let busy = FakeCodec::new(1206, 2622, false, 500, 1_500);
        let out = prepare("shot.png", "image/png", vec![0; 2_000_000], Some(&busy));
        assert_eq!(
            out.mime_type, "image/jpeg",
            "a busy screenshot becomes JPEG"
        );

        let small = FakeCodec::new(800, 600, false, 90_000, 0);
        let out = prepare("a.jpg", "image/jpeg", vec![1; 50_000], Some(&small));
        assert_eq!(
            (out.name.as_str(), out.bytes),
            ("a.jpg", vec![1; 50_000]),
            "a small JPEG goes as it is"
        );

        let alpha = FakeCodec::new(512, 512, true, 0, 30_000);
        let out = prepare("logo.png", "image/png", vec![0; 40_000], Some(&alpha));
        assert_eq!(
            alpha.asked.lock().unwrap()[0],
            (512, 512, false, true),
            "transparency never becomes JPEG"
        );
        assert_eq!(out.bytes.len(), 30_000);
    }

    #[test]
    fn prepare_passes_through_what_it_cannot_improve() {
        let codec = FakeCodec::new(4032, 3024, false, 10, 10);
        for (name, mime) in [
            ("a.gif", "image/gif"),
            ("a.webp", "image/webp"),
            ("a.pdf", "application/pdf"),
        ] {
            let out = prepare(name, mime, vec![7; 99], Some(&codec));
            assert_eq!(
                (out.name.as_str(), out.mime_type.as_str(), out.bytes.len()),
                (name, mime, 99)
            );
        }
        let unreadable = FakeCodec {
            info: None,
            ..FakeCodec::new(0, 0, false, 0, 0)
        };
        let out = prepare("x.heic", "image/heic", vec![7; 99], Some(&unreadable));
        assert_eq!(
            out.mime_type, "image/heic",
            "an image the codec cannot read is kept"
        );
        assert_eq!(
            prepare("x.jpg", "image/jpeg", vec![7; 5], None).bytes.len(),
            5
        );
    }

    #[test]
    fn limits_follow_the_server() {
        let image = |len| Prepared {
            name: "a.jpg".into(),
            mime_type: "image/jpeg".into(),
            bytes: vec![0; len],
        };
        let file = |len| Prepared {
            name: "a.zip".into(),
            mime_type: "application/zip".into(),
            bytes: vec![0; len],
        };
        let limits = UploadLimits {
            images: true,
            max_file_bytes: Some(100),
        };
        assert!(limits.check(&image(MAX_IMAGE_BYTES as usize)).is_ok());
        assert!(limits.check(&image(MAX_IMAGE_BYTES as usize + 1)).is_err());
        assert!(limits.check(&file(100)).is_ok() && limits.check(&file(101)).is_err());
        let none = UploadLimits {
            images: false,
            max_file_bytes: None,
        };
        assert_eq!(
            none.check(&image(1)),
            Err("This server cannot upload a.jpg.".into())
        );
    }

    #[test]
    fn progress_body_sends_every_byte_in_chunks() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let mut body = ProgressBody::new(
            vec![3; CHUNK * 2 + 10],
            Arc::new(move |p| record.lock().unwrap().push(p)),
        );
        assert_eq!(body.size_hint().exact(), Some((CHUNK * 2 + 10) as u64));
        let waker = futures::task::noop_waker();
        let mut cx = Context::from_waker(&waker);
        let mut total = 0;
        while let Poll::Ready(Some(Ok(frame))) = Pin::new(&mut body).poll_frame(&mut cx) {
            total += frame.into_data().map_or(0, |d| d.len());
        }
        assert_eq!(total, CHUNK * 2 + 10);
        assert!(body.is_end_stream());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(seen.windows(2).all(|w| w[0] < w[1]) && seen[0] == 0.0);
    }
}
