//! What a thread view reads beside its snapshot: images kept on the device (the engine's image
//! table), the prompt outline and a window around a prompt, both from the server.
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};

use conn_cache::Images;
use conn_client::Connection;
use conn_state::ThreadState;

use crate::{FfiError, FfiThreadSnapshot, types::build_thread_snapshot};

#[derive(Debug, uniffi::Record)]
pub struct FfiPromptMarker {
    pub id: String,
    pub preview: String,
    pub assistant_preview: Option<String>,
    pub has_error: bool,
    pub has_checkpoint: bool,
    pub is_agent_prompt: bool,
}

#[derive(Debug, uniffi::Object)]
pub struct OfflineReader {
    images: Images,
    connection: Connection,
    image_slots: tokio::sync::Semaphore,
    image_flights: std::sync::Mutex<HashMap<(String, String, bool), std::sync::Weak<ImageFlight>>>,
    picks: std::sync::Mutex<VecDeque<PickedImage>>,
}

type ImageFlight = tokio::sync::OnceCell<Result<Vec<u8>, FfiError>>;

#[derive(Debug)]
struct PickedImage {
    thread: String,
    item: String,
    index: usize,
    pending: crate::FfiAttachment,
    claimed: Option<String>,
}

fn read_error(e: impl std::fmt::Display) -> FfiError {
    FfiError::Connection {
        message: e.to_string(),
    }
}

fn image_version(file: &crate::FfiAttachment) -> Result<String, FfiError> {
    serde_json::to_string(&(&file.id, &file.name, &file.mime_type, file.size_bytes))
        .map_err(read_error)
}

impl OfflineReader {
    pub(crate) fn new(images: Images, connection: Connection) -> Arc<Self> {
        Arc::new(Self {
            images,
            connection,
            image_slots: tokio::sync::Semaphore::new(3),
            image_flights: Default::default(),
            picks: Default::default(),
        })
    }

    pub(crate) async fn seed_pick(
        &self,
        thread: &str,
        item: &str,
        index: usize,
        file: crate::FfiAttachment,
        bytes: &[u8],
    ) -> Result<(), FfiError> {
        if !file.is_image || file.size_bytes != bytes.len() as i64 {
            return Ok(());
        }
        self.images
            .save(thread, &image_version(&file)?, bytes)
            .await
            .map_err(read_error)?;
        let mut picks = self.picks.lock().map_err(read_error)?;
        picks.retain(|pick| pick.thread != thread || pick.item != item || pick.index != index);
        if picks.len() >= 128 {
            picks.pop_front();
        }
        picks.push_back(PickedImage {
            thread: thread.into(),
            item: item.into(),
            index,
            pending: file,
            claimed: None,
        });
        Ok(())
    }

    /// Ties picked images to the server's attachment ids once the thread shows the reply.
    pub(crate) fn bind_picks(&self, state: &ThreadState) {
        let Ok(mut picks) = self.picks.lock() else {
            return;
        };
        for pick in picks
            .iter_mut()
            .filter(|pick| pick.thread == state.thread_id && pick.claimed.is_none())
        {
            let Some(files) = state.entries.iter().rev().find_map(|entry| match entry {
                conn_state::TimelineEntry::User {
                    id, attachments, ..
                } if id == &pick.item => Some(attachments),
                conn_state::TimelineEntry::QueuedUser {
                    id,
                    message_id,
                    attachments,
                    ..
                } if id == &pick.item
                    || pick.item.strip_prefix("turn-item:") == Some(message_id.as_str()) =>
                {
                    Some(attachments)
                }
                _ => None,
            }) else {
                continue;
            };
            if let Some(conn_contract::ChatAttachment::Image(file)) = files.get(pick.index)
                && !file.id.starts_with("pending-")
                && file.name == pick.pending.name
                && file.mime_type == pick.pending.mime_type
                && file.size_bytes == pick.pending.size_bytes
            {
                pick.claimed = Some(file.id.clone());
            }
        }
    }

    async fn acquire_image<F, Fut>(
        &self,
        thread: &str,
        file: &crate::FfiAttachment,
        online: bool,
        fetch: F,
    ) -> Result<Vec<u8>, FfiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, FfiError>>,
    {
        if !file.is_image || !(1..=10 * 1024 * 1024).contains(&file.size_bytes) {
            return Err(FfiError::Closed);
        }
        let size = file.size_bytes as usize;
        let version = image_version(file)?;
        let flight = {
            let mut locks = self.image_flights.lock().map_err(read_error)?;
            locks.retain(|_, weak| weak.strong_count() > 0);
            let weak = locks
                .entry((thread.to_owned(), version.clone(), online))
                .or_default();
            weak.upgrade().unwrap_or_else(|| {
                let lock = Arc::new(ImageFlight::new());
                *weak = Arc::downgrade(&lock);
                lock
            })
        };
        let _ = flight
            .get_or_init(|| async {
                if let Some(bytes) = self
                    .images
                    .get(thread, &version)
                    .await
                    .map_err(read_error)?
                    && bytes.len() == size
                {
                    return Ok(bytes);
                }
                let _slot = self.image_slots.acquire().await.map_err(read_error)?;
                let pending = self
                    .picks
                    .lock()
                    .map_err(read_error)?
                    .iter()
                    .find(|pick| {
                        pick.thread == thread
                            && pick.claimed.as_deref() == Some(file.id.as_str())
                            && pick.pending.name == file.name
                            && pick.pending.mime_type == file.mime_type
                            && pick.pending.size_bytes == file.size_bytes
                    })
                    .map(|pick| image_version(&pick.pending))
                    .transpose()?;
                let local = match &pending {
                    Some(pending) => self.images.get(thread, pending).await.map_err(read_error)?,
                    None => None,
                };
                let bytes = match local {
                    Some(bytes) if bytes.len() == size => bytes,
                    _ if online => fetch().await?,
                    _ => return Err(FfiError::Closed),
                };
                if bytes.len() != size {
                    return Err(read_error("Incomplete image"));
                }
                if let Err(error) = self.images.save(thread, &version, &bytes).await {
                    tracing::warn!(%error, "image cache write failed");
                }
                if pending.is_some() {
                    self.picks.lock().map_err(read_error)?.retain(|pick| {
                        pick.thread != thread || pick.claimed.as_deref() != Some(file.id.as_str())
                    });
                }
                Ok(bytes)
            })
            .await;
        match Arc::try_unwrap(flight) {
            Ok(cell) => cell.into_inner(),
            Err(cell) => cell.get().cloned(),
        }
        .ok_or(FfiError::Closed)?
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl OfflineReader {
    pub async fn image_bytes(
        self: Arc<Self>,
        thread: String,
        file: crate::FfiAttachment,
        online: bool,
    ) -> Result<Vec<u8>, FfiError> {
        let reader = self.clone();
        tokio::spawn(async move {
            reader
                .acquire_image(&thread, &file, online, || async {
                    reader
                        .connection
                        .fetch_attachment_bytes_limited(
                            &file.id,
                            conn_client::FetchDeadlines {
                                rpc: Duration::from_secs(15),
                                download: Duration::from_secs(30),
                            },
                            Some(file.size_bytes as usize),
                        )
                        .await
                        .map_err(|_| read_error("Image unavailable"))
                })
                .await
        })
        .await
        .map_err(|_| FfiError::Closed)?
    }

    pub async fn discard_image(
        &self,
        thread: String,
        file: crate::FfiAttachment,
    ) -> Result<(), FfiError> {
        self.images
            .forget(&thread, &image_version(&file)?)
            .await
            .map_err(read_error)
    }

    /// The window around one prompt, from the server.
    pub async fn prompt_window(
        &self,
        thread: String,
        id: String,
        online: bool,
    ) -> Result<FfiThreadSnapshot, FfiError> {
        if !online {
            return Err(read_error("Reconnect to read this prompt."));
        }
        let page = self.connection.fetch_thread_window(&thread, &id).await?;
        let mut state = ThreadState::new(thread);
        state.prepend_history_page(page);
        Ok(build_thread_snapshot(&state, None, &Default::default()))
    }

    /// The thread's prompts, from the server.
    pub async fn outline(
        &self,
        thread: String,
        online: bool,
    ) -> Result<Vec<FfiPromptMarker>, FfiError> {
        if !online {
            return Ok(Vec::new());
        }
        let outline = self.connection.fetch_thread_outline(&thread).await?;
        Ok(outline
            .markers
            .into_iter()
            .map(|m| FfiPromptMarker {
                id: m.entry_id,
                preview: m.preview,
                assistant_preview: m.assistant_preview,
                has_error: m.has_error,
                has_checkpoint: m.has_checkpoint,
                is_agent_prompt: m.is_agent_prompt,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let config = conn_client::ServerConfig {
            http_base_url: url::Url::parse("http://127.0.0.1:9").unwrap_or_else(|_| unreachable!()),
            credential: conn_client::Credential::Bearer("test".into()),
        };
        Connection::start(config, &tokio::runtime::Handle::current()).0
    }

    async fn open(
        dir: &std::path::Path,
        env: &str,
    ) -> Result<Arc<OfflineReader>, Box<dyn std::error::Error>> {
        let connection = connection();
        let engine = conn_cache::Engine::open(
            &dir.join("local.sqlite3"),
            env,
            connection.clone(),
            conn_cache::Settings::default(),
        )
        .await?;
        Ok(OfflineReader::new(engine.images(), connection))
    }

    fn attachment(id: &str) -> conn_contract::ChatAttachment {
        conn_contract::ChatAttachment::Image(conn_contract::ChatImageAttachment {
            r#type: conn_contract::lit::Image,
            id: id.into(),
            name: "IMG_3145.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 4,
            source: None,
        })
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn image_remount_and_offline_reopen_do_not_fetch_again()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let reader = open(dir.path(), "phone-a").await?;
        let mut file = crate::FfiAttachment::from(&attachment("image-1"));
        let calls = std::cell::Cell::new(0);
        let sign_and_fetch = || async {
            calls.set(calls.get() + 1);
            Ok(b"data".to_vec())
        };
        let (first, remount) = tokio::join!(
            reader.acquire_image("chat", &file, true, sign_and_fetch),
            reader.acquire_image("chat", &file, true, sign_and_fetch),
        );
        assert_eq!(first?, remount?);
        assert_eq!(
            reader
                .acquire_image("chat", &file, true, sign_and_fetch)
                .await?,
            b"data"
        );
        assert_eq!(calls.get(), 1);
        drop(reader);
        let cold = open(dir.path(), "phone-a").await?;
        assert_eq!(
            cold.clone()
                .image_bytes("chat".into(), file.clone(), false)
                .await?,
            b"data"
        );
        let other = open(dir.path(), "phone-b").await?;
        assert!(
            other
                .clone()
                .image_bytes("chat".into(), file.clone(), false)
                .await
                .is_err()
        );
        assert!(
            other
                .acquire_image("chat", &file, true, || async { Ok(vec![1]) })
                .await
                .is_err()
        );
        assert_eq!(
            other
                .acquire_image("chat", &file, true, || async { Ok(b"else".to_vec()) })
                .await?,
            b"else"
        );
        assert_eq!(
            cold.clone()
                .image_bytes("chat".into(), file.clone(), false)
                .await?,
            b"data"
        );
        file.name = "revised.png".into();
        assert!(cold.image_bytes("chat".into(), file, false).await.is_err());
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn image_pick_survives_queue_to_sent_without_network()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let reader = open(dir.path(), "env").await?;
        let item = "turn-item:message-local";
        let picked = crate::FfiAttachment::from(&attachment("pending-1"));
        let claimed = attachment("thread-1");
        let file = crate::FfiAttachment::from(&claimed);
        reader.seed_pick("chat", item, 0, picked, b"pick").await?;
        let mut state = ThreadState::new("chat");
        state.entries.push(conn_state::TimelineEntry::QueuedUser {
            id: "queued".into(),
            run_id: "run".into(),
            message_id: "message-other".into(),
            text: String::new(),
            attachments: vec![claimed.clone()],
            created_at: String::new(),
            created_by_agent: false,
        });
        reader.bind_picks(&state);
        assert!(
            reader
                .clone()
                .image_bytes("chat".into(), file.clone(), false)
                .await
                .is_err()
        );
        if let conn_state::TimelineEntry::QueuedUser { message_id, .. } = &mut state.entries[0] {
            *message_id = "message-local".into();
        }
        reader.bind_picks(&state);
        assert_eq!(
            reader
                .clone()
                .image_bytes("chat".into(), file.clone(), false)
                .await?,
            b"pick"
        );
        drop(reader);
        // A restart finds the image under the server's id.
        let sent = open(dir.path(), "env").await?;
        assert_eq!(sent.image_bytes("chat".into(), file, false).await?, b"pick");
        Ok(())
    }
}
