//! Pictures the user just sent show in their bubble without a download.
//!
//! An upload gets a pending attachment id. When the server accepts the message it copies each
//! upload to a new id in the thread (`AttachmentStore::claim`), so the message it echoes names
//! attachments no cache knows, and every picture downloaded again right after the send. The
//! server keeps the bytes as they came: what the upload sent is what it serves.
//!
//! So a send keeps the bytes that went up ([`ChatView::stage_uploaded`]) and decodes each picture
//! at gallery tile size while the server works ([`ChatView::note_sent_message`]). The message id
//! is the client's, so the echo is found by it, and its attachments come back in the order they
//! went. When the echo first renders ([`ChatView::adopt_sent_images`]), the bytes go to the
//! image store and the thumbnail to the decoded cache, both under the server's id: the bubble's
//! first frame has the picture, and the viewer and Save read the same bytes.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use conn_contract::ChatAttachment;
use gpui_kit::Context;

use super::attachment_thumb::{
    AttachmentKind, SentImage, attachment_kind, gallery_columns, gallery_tile_target,
    load_sent_image,
};
use super::thumb_cache::TargetPx;
use super::{ChatView, ThumbKey};

/// Sent messages whose pictures wait for the server's copy. One that never shows (refused, or
/// queued behind this many newer sends) falls back to the normal load.
const MAX_MESSAGES: usize = 8;
/// Uploaded pictures handed over by a send that no message claimed yet.
const MAX_STAGED: usize = 32;

/// What the chat holds of pictures it sent.
#[derive(Default)]
pub(super) struct SentImages {
    /// Uploaded bytes by pending attachment id, from the composer's send until the app names
    /// the message.
    staged: HashMap<String, Arc<[u8]>>,
    staged_order: VecDeque<String>,
    /// Sent messages by message id, oldest first in `order`.
    messages: HashMap<String, SentMessage>,
    order: VecDeque<String>,
    /// Decodes that were still running when their message showed: where each result goes.
    adopted: HashMap<u64, ThumbKey>,
}

struct SentMessage {
    environment: Option<String>,
    /// The gallery tile size the pictures decode at.
    target: TargetPx,
    /// One per attachment of the message; `None` where it is not an uploaded picture.
    pictures: Vec<Option<SentPicture>>,
}

struct SentPicture {
    name: String,
    bytes: Arc<[u8]>,
    /// The decode's thumbnail request number.
    request: u64,
    /// The thumbnail and its cost, once decoded.
    decoded: Option<(SentImage, usize)>,
}

impl SentMessage {
    fn release(self, cx: &mut gpui_kit::App) {
        for picture in self.pictures.into_iter().flatten() {
            if let Some((image, _)) = picture.decoded {
                image.release(cx);
            }
        }
    }
}

impl ChatView {
    /// Keeps the bytes a send uploaded, by attachment id, until the app names its message.
    pub(super) fn stage_uploaded(&mut self, uploaded: &[(String, Arc<[u8]>)]) {
        let sent = self.sent_images.get_mut();
        for (id, bytes) in uploaded {
            if sent.staged.insert(id.clone(), bytes.clone()).is_none() {
                sent.staged_order.push_back(id.clone());
            }
        }
        while sent.staged_order.len() > MAX_STAGED {
            if let Some(id) = sent.staged_order.pop_front() {
                sent.staged.remove(&id);
            }
        }
    }

    /// The app sent `attachments` as message `message_id`. Their uploaded pictures decode at
    /// gallery tile size now, one at a time off the UI thread, so the echo paints at once.
    pub(crate) fn note_sent_message(
        &mut self,
        message_id: &str,
        attachments: &[ChatAttachment],
        cx: &mut Context<'_, Self>,
    ) {
        let columns = gallery_columns(
            attachments
                .iter()
                .filter(|att| attachment_kind(att) == AttachmentKind::Image)
                .count(),
        );
        let target = gallery_tile_target(columns, self.thumb_scale);
        let mut jobs = Vec::new();
        let pictures: Vec<Option<SentPicture>> = {
            let sent = self.sent_images.get_mut();
            attachments
                .iter()
                .map(|att| {
                    let ChatAttachment::Image(image) = att else {
                        return None;
                    };
                    let bytes = sent.staged.remove(&image.id)?;
                    sent.staged_order.retain(|id| *id != image.id);
                    let request = self.next_thumb_request.get();
                    self.next_thumb_request.set(request + 1);
                    jobs.push((request, image.mime_type.clone(), bytes.clone()));
                    Some(SentPicture {
                        name: image.name.clone(),
                        bytes,
                        request,
                        decoded: None,
                    })
                })
                .collect()
        };
        if jobs.is_empty() {
            return;
        }
        let message = SentMessage {
            environment: self.environment_key.clone(),
            target,
            pictures,
        };
        let sent = self.sent_images.get_mut();
        if let Some(old) = sent.messages.insert(message_id.to_owned(), message) {
            old.release(cx);
        } else {
            sent.order.push_back(message_id.to_owned());
        }
        while sent.order.len() > MAX_MESSAGES {
            if let Some(id) = sent.order.pop_front()
                && let Some(old) = sent.messages.remove(&id)
            {
                old.release(cx);
            }
        }
        let svg_renderer = cx.svg_renderer();
        cx.spawn(async move |this, cx| {
            for (request, mime_type, bytes) in jobs {
                let svg_renderer = svg_renderer.clone();
                let loaded = cx
                    .background_executor()
                    .spawn(async move {
                        let cancel = AtomicBool::new(false);
                        load_sent_image(&mime_type, bytes.to_vec(), target, svg_renderer, &cancel)
                    })
                    .await;
                if this
                    .update(cx, |view, cx| view.finish_sent_decode(request, loaded, cx))
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();
    }

    /// A sent picture decoded: into the thumbnail cache when its message already showed, else
    /// kept with the message.
    fn finish_sent_decode(
        &mut self,
        request: u64,
        (image, cost): (SentImage, usize),
        cx: &mut Context<'_, Self>,
    ) {
        let sent = self.sent_images.get_mut();
        if let Some(key) = sent.adopted.remove(&request) {
            let thumbs = self.attachment_thumbs.get_mut();
            let waiting =
                matches!(thumbs.peek(&key), Some(SentImage::Loading(id)) if *id == request);
            if !waiting {
                image.release(cx);
                return;
            }
            if matches!(image, SentImage::Ready(_)) {
                for old in thumbs.insert(key, image, cost) {
                    old.release(cx);
                }
            } else {
                // The tile loads it the normal way, from the bytes in the store.
                if let Some(entry) = thumbs.remove(&key) {
                    entry.release(cx);
                }
                image.release(cx);
            }
            cx.notify();
            return;
        }
        let slot = sent
            .messages
            .values_mut()
            .flat_map(|message| message.pictures.iter_mut().flatten())
            .find(|picture| picture.request == request);
        match slot {
            Some(picture) => picture.decoded = Some((image, cost)),
            None => image.release(cx),
        }
    }

    /// The server's copy of message `message_id` is rendering with `attachments`: each picture
    /// this chat sent goes to the image store and the thumbnail cache under its server id, so
    /// the tile paints from them and nothing downloads it.
    pub(super) fn adopt_sent_images(
        &self,
        message_id: &str,
        attachments: &[ChatAttachment],
        cx: &mut Context<'_, Self>,
    ) {
        let mut sent = self.sent_images.borrow_mut();
        let Some(message) = sent.messages.remove(message_id) else {
            return;
        };
        sent.order.retain(|id| id != message_id);
        if message.environment != self.environment_key {
            message.release(cx);
            return;
        }
        let SentMessage {
            environment,
            target,
            pictures,
        } = message;
        let mut thumbs = self.attachment_thumbs.borrow_mut();
        let mut pictures = pictures.into_iter();
        for att in attachments {
            let picture = pictures.next().flatten();
            let (ChatAttachment::Image(image), Some(picture)) = (att, picture) else {
                continue;
            };
            // The server keeps names and order; anything else is not the picture that went.
            if image.name != picture.name {
                if let Some((decoded, _)) = picture.decoded {
                    decoded.release(cx);
                }
                continue;
            }
            if let Some(environment) = &environment {
                self.image_store.seed(
                    cx.background_executor(),
                    environment,
                    &image.id,
                    picture.bytes.clone(),
                );
            }
            let key: ThumbKey = (environment.clone(), image.id.clone(), target);
            if thumbs.peek(&key).is_some() {
                if let Some((decoded, _)) = picture.decoded {
                    decoded.release(cx);
                }
                continue;
            }
            match picture.decoded {
                Some((decoded @ SentImage::Ready(_), cost)) => {
                    for old in thumbs.insert(key, decoded, cost) {
                        old.release(cx);
                    }
                }
                // A picture that did not decode loads the normal way.
                Some((failed, _)) => failed.release(cx),
                None => {
                    for old in thumbs.insert(key.clone(), SentImage::Loading(picture.request), 0) {
                        old.release(cx);
                    }
                    sent.adopted.insert(picture.request, key);
                }
            }
        }
        for rest in pictures.flatten() {
            if let Some((decoded, _)) = rest.decoded {
                decoded.release(cx);
            }
        }
    }

    /// Test helper: whether every picture of sent message `message_id` has decoded.
    #[cfg(test)]
    pub(crate) fn sent_images_decoded_for_test(&self, message_id: &str) -> bool {
        self.sent_images
            .borrow()
            .messages
            .get(message_id)
            .is_some_and(|message| {
                message
                    .pictures
                    .iter()
                    .flatten()
                    .all(|picture| picture.decoded.is_some())
            })
    }
}
