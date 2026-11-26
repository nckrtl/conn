//! Full-image viewer for the images of a sent chat message.
//!
//! Web Conn opens `ExpandedImageDialog.tsx` from `TimelineUserMessageRow.tsx`: a thumbnail is a
//! `<button>` (`Preview {name}`) that builds one gallery from the message's images, in the order
//! they were attached, and opens it on the clicked one. The dialog shows the whole picture
//! (never cropped), a `Back` button, previous and next buttons with `ArrowLeft` and `ArrowRight`
//! when there is more than one image, `name (n/total)` below the picture, and an unavailable
//! state when the picture does not load. It closes on Escape, on `Back` and on a click outside
//! the picture, and gives the keyboard back to what had it before.
//!
//! Native keeps the same behavior. [`ImageViewer`] is a window-level overlay owned by `ConnApp`
//! (so it draws above the header and the right panel). The chat only asks for it with
//! [`ChatEvent::OpenImageViewer`]. The viewer shares the thumbnails' download entities, so an
//! image that already loaded opens at once and one that is still loading, or failed, shows that.
//! Zoom and pan (`ZoomableImage.tsx`) are not part of this first version.

use conn_contract::{ChatAttachment, ChatImageAttachment};
use conn_theme::Tokens;
use gpui_kit::assets::IconName;
use gpui_kit::base::FocusTrapElement as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, CursorStyle, Entity, EventEmitter,
    FocusHandle, ImageSource, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    MouseDownEvent, MouseMoveEvent, ObjectFit, ParentElement as _, Pixels, Point, Render, Role,
    ScrollHandle, StatefulInteractiveElement as _, Styled as _, StyledImage as _, Subscription,
    TestSupportExt as _, Window, anchored, deferred, div, img, point, px,
};

use super::attachment_thumb::{AttachmentImageLoad, AttachmentImageState};
use super::icons as chat_icons;
use super::{ChatEvent, ChatView};
use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::theme::hsla_alpha;

/// Media colors are fixed in both themes (`dialog-styles.ts` `bg-black/75`, `button.tsx`
/// `media-close` and `media-navigation`: white on black), so the picture reads the same on a
/// light shell.
fn black(alpha: f32) -> gpui_kit::Hsla {
    gpui_kit::hsla(0.0, 0.0, 0.0, alpha)
}

fn white(alpha: f32) -> gpui_kit::Hsla {
    gpui_kit::hsla(0.0, 0.0, 1.0, alpha)
}

/// Width below which the previous and next buttons sit at the bottom corners instead of the
/// sides (`sm:` in `ExpandedImageDialog.tsx`).
const COMPACT_WIDTH_PX: f32 = 640.0;
/// Room the side buttons take from the picture on a wide window (`calc(92vw - 96px)`).
const SIDE_BUTTONS_PX: f32 = 96.0;
/// Space between the window edge and the controls.
const EDGE_INSET_PX: f32 = 16.0;
/// The `Back` button sits below the macOS window buttons.
const BACK_TOP_PX: f32 = 52.0;
const BUTTON_HEIGHT_PX: f32 = 36.0;
const PICTURE_RADIUS_PX: f32 = 8.0;
/// `w-[min(var(--media-width),32rem)] h-48` of the unavailable state.
const STATUS_CARD_MAX_WIDTH_PX: f32 = 512.0;
const STATUS_CARD_HEIGHT_PX: f32 = 192.0;

/// One image of the gallery: the thumbnails' own download of the attachment.
#[derive(Clone)]
pub(crate) struct ViewerItem {
    id: String,
    name: String,
    state: Entity<AttachmentImageState>,
}

impl std::fmt::Debug for ViewerItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ViewerItem")
            .field("id", &self.id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl PartialEq for ViewerItem {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && self.name == other.name
    }
}

/// What the viewer tells `ConnApp`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageViewerEvent {
    Close,
}

/// A step through the gallery.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Previous,
    Next,
}

/// What is known about the pixel size of the picture on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PixelSize {
    Unread,
    /// A format whose header the `image` crate does not read (SVG): the picture fills the stage.
    Unreadable,
    Known(u32, u32),
}

/// The images of one message in the order they were attached, and where the attachment at
/// `clicked` sits among them. It goes by position, not id, so a repeated attachment opens the
/// occurrence that was clicked. `None` when `clicked` is not an image. Videos and files do not
/// count, as in web (`regularImages`).
pub(super) fn gallery_images(
    attachments: &[ChatAttachment],
    clicked: usize,
) -> Option<(Vec<&ChatImageAttachment>, usize)> {
    let is_image = |attachment: &ChatAttachment| matches!(attachment, ChatAttachment::Image(_));
    if !attachments.get(clicked).is_some_and(is_image) {
        return None;
    }
    let images = attachments
        .iter()
        .filter_map(|attachment| match attachment {
            ChatAttachment::Image(image) => Some(image),
            ChatAttachment::File(_) | ChatAttachment::Unknown(_) => None,
        })
        .collect();
    let position = attachments
        .iter()
        .take(clicked)
        .filter(|attachment| is_image(attachment))
        .count();
    Some((images, position))
}

/// The index after a step, wrapping at both ends. A gallery of one stays where it is.
fn stepped_index(index: usize, step: Step, count: usize) -> usize {
    if count <= 1 {
        return 0;
    }
    match step {
        Step::Previous => (index + count - 1) % count,
        Step::Next => (index + 1) % count,
    }
}

/// `name (2/3)`, or just the name for a single image.
fn caption(name: &str, index: usize, count: usize) -> String {
    if count > 1 {
        format!("{name} ({}/{count})", index + 1)
    } else {
        name.to_owned()
    }
}

/// The box the picture may fill, in logical px: `92%` of the width less the side buttons on a
/// wide window, and `86%` of the height with at least 160px left for the caption and the top
/// controls (`ZoomableImage.tsx`).
fn stage_limits(viewport_width: f32, viewport_height: f32) -> (f32, f32) {
    let side = if viewport_width >= COMPACT_WIDTH_PX {
        SIDE_BUTTONS_PX
    } else {
        0.0
    };
    let width = (viewport_width * 0.92 - side).max(1.0);
    let height = (viewport_height * 0.86)
        .min(viewport_height - 160.0)
        .max(1.0);
    (width, height)
}

/// The painted size of a picture of `natural` pixels in `limits`: the whole picture at its own
/// aspect ratio, scaled down to fit and never up past one image pixel per device pixel.
fn fitted_size(natural: (u32, u32), limits: (f32, f32), scale_factor: f32) -> (f32, f32) {
    let scale = scale_factor.max(1.0);
    let width = natural.0.max(1) as f32 / scale;
    let height = natural.1.max(1) as f32 / scale;
    let fit = (limits.0 / width).min(limits.1 / height).min(1.0);
    (width * fit, height * fit)
}

/// Zoom range and steps of `ZoomableImage.tsx`: click toggles `CLICK_ZOOM`, `+`/`-` step by
/// `KEY_ZOOM_STEP`.
const MAX_ZOOM: f32 = 8.0;
const CLICK_ZOOM: f32 = 2.0;
const KEY_ZOOM_STEP: f32 = 1.5;
/// Arrow-key pan distance when zoomed.
const PAN_STEP_PX: f32 = 40.0;
/// A press that moves further than this is a drag, not a click.
const DRAG_SLOP_PX: f32 = 4.0;

/// The scroll viewport on screen: the fitted picture grown by `zoom`, up to the stage limits.
fn view_size(fit: (f32, f32), limits: (f32, f32), zoom: f32) -> (f32, f32) {
    ((fit.0 * zoom).min(limits.0), (fit.1 * zoom).min(limits.1))
}

/// How far the zoomed picture can scroll in each direction.
fn max_scroll(fit: (f32, f32), limits: (f32, f32), zoom: f32) -> (f32, f32) {
    let view = view_size(fit, limits, zoom);
    (
        (fit.0 * zoom - view.0).max(0.0),
        (fit.1 * zoom - view.1).max(0.0),
    )
}

/// A scroll offset (zero or negative) kept inside what the picture can scroll.
fn clamp_offset(offset: (f32, f32), max: (f32, f32)) -> (f32, f32) {
    (offset.0.clamp(-max.0, 0.0), offset.1.clamp(-max.1, 0.0))
}

/// The scroll offset after zooming from `old` to `new` that keeps the picture point under
/// `pos` (relative to the old viewport) where it was. The viewport is centered in the stage, so
/// its origin moves by half the size change (`changeZoom` in `ZoomableImage.tsx`).
fn zoomed_offset(
    offset: (f32, f32),
    pos: (f32, f32),
    zoom: (f32, f32),
    fit: (f32, f32),
    limits: (f32, f32),
) -> (f32, f32) {
    let (old, new) = zoom;
    let old_view = view_size(fit, limits, old);
    let new_view = view_size(fit, limits, new);
    let anchor = ((pos.0 - offset.0) / old, (pos.1 - offset.1) / old);
    // A bigger viewport reaches further out on every side, so the pointer sits deeper in it.
    let moved = (
        pos.0 + (new_view.0 - old_view.0) / 2.0,
        pos.1 + (new_view.1 - old_view.1) / 2.0,
    );
    clamp_offset(
        (moved.0 - anchor.0 * new, moved.1 - anchor.1 * new),
        max_scroll(fit, limits, new),
    )
}

/// Width and height of an image from its header, without decoding the pixels.
fn image_pixel_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let (width, height) = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

/// The full-window image viewer.
pub(crate) struct ImageViewer {
    items: Vec<ViewerItem>,
    index: usize,
    /// Pixel size of each item, read once from the bytes when its download ends.
    sizes: Vec<PixelSize>,
    tokens: Tokens,
    focus: FocusHandle,
    /// What had the keyboard when the viewer opened; it gets it back on close.
    return_focus: Option<FocusHandle>,
    /// The thread the images belong to; the viewer closes when another thread shows.
    thread_id: Option<String>,
    _downloads: Vec<Subscription>,
    /// `1.0` is the fitted picture; the picture scrolls inside its viewport above that.
    zoom: f32,
    scroll: ScrollHandle,
    /// The fitted picture size and stage limits of the last frame; `fit` is zero until a picture
    /// shows.
    stage: Stage,
    drag: Option<Drag>,
    /// The press that began a drag moved: its click must not toggle zoom.
    dragged: bool,
}

/// What zoom math needs from the last frame.
#[derive(Clone, Copy, Default)]
struct Stage {
    fit: (f32, f32),
    limits: (f32, f32),
    /// The picture's scroll viewport at the current zoom.
    viewport: (f32, f32),
    /// The window size; a change fits the picture again.
    window: (f32, f32),
}

struct Drag {
    origin: Point<Pixels>,
    offset: Point<Pixels>,
}

impl EventEmitter<ImageViewerEvent> for ImageViewer {}

impl ImageViewer {
    /// Opens on `items[index]` and takes the keyboard.
    pub(crate) fn new(
        items: Vec<ViewerItem>,
        index: usize,
        thread_id: Option<String>,
        return_focus: Option<FocusHandle>,
        tokens: Tokens,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let downloads = items
            .iter()
            .map(|item| cx.observe(&item.state, |_, _, cx| cx.notify()))
            .collect();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            index: index.min(items.len().saturating_sub(1)),
            sizes: vec![PixelSize::Unread; items.len()],
            items,
            tokens,
            focus,
            return_focus,
            thread_id,
            _downloads: downloads,
            zoom: 1.0,
            scroll: ScrollHandle::new(),
            stage: Stage::default(),
            drag: None,
            dragged: false,
        }
    }

    pub(crate) fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    /// The focus the viewer took the keyboard from, once.
    pub(crate) fn take_return_focus(&mut self) -> Option<FocusHandle> {
        self.return_focus.take()
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// Handles a key while the viewer is open, as `ExpandedImageDialog.tsx` and
    /// `ZoomableImage.tsx` do: Escape closes; Enter or Space toggles zoom; `+`/`=` and `-` zoom
    /// by 1.5×; `0` fits; the arrows pan a zoomed picture (left and right step the gallery when
    /// it cannot pan that way). Tab stays in the viewer. Returns whether the key was used.
    /// Shortcuts with a command, control or option key pass through.
    pub(crate) fn handle_key(
        &mut self,
        event: &KeyDownEvent,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let modifiers = event.keystroke.modifiers;
        if modifiers.control || modifiers.platform || modifiers.alt {
            return false;
        }
        let key = event.keystroke.key.as_str();
        match key {
            "escape" => self.close(cx),
            // Focused buttons handle Enter and Space through their own click handlers.
            "enter" | "space" if self.focus.is_focused(window) => {
                if !event.is_held {
                    self.set_zoom(if self.zoom > 1.0 { 1.0 } else { CLICK_ZOOM }, None, cx);
                }
            }
            "+" | "=" => self.set_zoom(self.zoom * KEY_ZOOM_STEP, None, cx),
            "-" => self.set_zoom(self.zoom / KEY_ZOOM_STEP, None, cx),
            "0" => self.set_zoom(1.0, None, cx),
            "left" | "right" | "up" | "down" => {
                if !self.pan(key, cx) {
                    match key {
                        "left" => self.step(Step::Previous, cx),
                        "right" => self.step(Step::Next, cx),
                        _ => {}
                    }
                }
            }
            _ => return false,
        }
        true
    }

    fn close(&mut self, cx: &mut Context<'_, Self>) {
        cx.emit(ImageViewerEvent::Close);
    }

    /// Shows another image, fitted again.
    fn step(&mut self, step: Step, cx: &mut Context<'_, Self>) {
        let next = stepped_index(self.index, step, self.items.len());
        if next != self.index {
            self.index = next;
            self.reset_zoom();
            cx.notify();
        }
    }

    fn reset_zoom(&mut self) {
        self.zoom = 1.0;
        self.drag = None;
        self.scroll.set_offset(point(px(0.0), px(0.0)));
    }

    /// Zooms to `next` (within 1× to 8×), keeping the picture point under `at` (a window
    /// position) or else the viewport's middle where it is.
    fn set_zoom(&mut self, next: f32, at: Option<Point<Pixels>>, cx: &mut Context<'_, Self>) {
        let Stage {
            fit,
            limits,
            viewport,
            ..
        } = self.stage;
        let next = next.clamp(1.0, MAX_ZOOM);
        // `fit` is zero while no picture shows: there is nothing to zoom.
        if fit.0 <= 0.0 || (next - self.zoom).abs() < f32::EPSILON {
            return;
        }
        let origin = self.scroll.bounds().origin;
        let pos = at.map_or((viewport.0 / 2.0, viewport.1 / 2.0), |at| {
            (f32::from(at.x - origin.x), f32::from(at.y - origin.y))
        });
        let offset = self.scroll.offset();
        let (x, y) = zoomed_offset(
            (f32::from(offset.x), f32::from(offset.y)),
            pos,
            (self.zoom, next),
            fit,
            limits,
        );
        self.zoom = next;
        self.scroll.set_offset(point(px(x), px(y)));
        cx.notify();
    }

    /// Pans a zoomed picture by an arrow key. False when it cannot pan that way, so left and
    /// right can step the gallery instead (up and down are used whenever zoomed).
    fn pan(&mut self, key: &str, cx: &mut Context<'_, Self>) -> bool {
        let Stage { fit, limits, .. } = self.stage;
        let max = max_scroll(fit, limits, self.zoom);
        let (dx, dy) = match key {
            "left" => (PAN_STEP_PX, 0.0),
            "right" => (-PAN_STEP_PX, 0.0),
            "up" => (0.0, PAN_STEP_PX),
            _ => (0.0, -PAN_STEP_PX),
        };
        let horizontal = matches!(key, "left" | "right");
        if self.zoom <= 1.0 || (horizontal && max.0 <= 0.0) {
            return false;
        }
        let offset = self.scroll.offset();
        let (x, y) = clamp_offset((f32::from(offset.x) + dx, f32::from(offset.y) + dy), max);
        self.scroll.set_offset(point(px(x), px(y)));
        cx.notify();
        true
    }

    /// A press on the picture: starts a drag while zoomed.
    fn press_picture(&mut self, event: &MouseDownEvent) {
        self.dragged = false;
        self.drag = (self.zoom > 1.0).then(|| Drag {
            origin: event.position,
            offset: self.scroll.offset(),
        });
    }

    /// Drags the zoomed picture with the pointer, anywhere in the window.
    fn drag_to(&mut self, event: &MouseMoveEvent, cx: &mut Context<'_, Self>) {
        let Some(drag) = &self.drag else {
            return;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            self.drag = None;
            cx.notify();
            return;
        }
        let (dx, dy) = (
            f32::from(event.position.x - drag.origin.x),
            f32::from(event.position.y - drag.origin.y),
        );
        self.dragged |= dx.hypot(dy) > DRAG_SLOP_PX;
        let max = max_scroll(self.stage.fit, self.stage.limits, self.zoom);
        let (x, y) = clamp_offset(
            (f32::from(drag.offset.x) + dx, f32::from(drag.offset.y) + dy),
            max,
        );
        self.scroll.set_offset(point(px(x), px(y)));
        cx.notify();
    }

    /// A click on the picture toggles zoom at the pointer; a second click of a double click and
    /// the click ending a drag do not.
    fn click_picture(&mut self, event: &ClickEvent, cx: &mut Context<'_, Self>) {
        let repeated = matches!(event, ClickEvent::Mouse(click) if click.down.click_count > 1);
        if self.dragged || repeated {
            return;
        }
        let next = if self.zoom > 1.0 { 1.0 } else { CLICK_ZOOM };
        let at = event.mouse_position();
        self.set_zoom(next, at, cx);
    }

    /// The pixel size of the current picture, read from its bytes the first time.
    fn current_size(&mut self, image_bytes: &[u8]) -> PixelSize {
        let Some(slot) = self.sizes.get_mut(self.index) else {
            return PixelSize::Unreadable;
        };
        if *slot == PixelSize::Unread {
            *slot = image_pixel_size(image_bytes)
                .map_or(PixelSize::Unreadable, |(width, height)| {
                    PixelSize::Known(width, height)
                });
        }
        *slot
    }

    /// The picture, or the loading or unavailable state, centered in the stage.
    fn render_stage(
        &mut self,
        limits: (f32, f32),
        scale_factor: f32,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let Some(item) = self.items.get(self.index) else {
            return div().into_any_element();
        };
        // Only a shown picture can zoom; loading and failure states reset the stage.
        self.stage.fit = (0.0, 0.0);
        let name = item.name.clone();
        let load = item.state.read(cx).load.clone();
        let card_width = limits.0.min(STATUS_CARD_MAX_WIDTH_PX);
        match load {
            AttachmentImageLoad::Loading => {
                status_card(&LOADING, card_width, &self.tokens).into_any_element()
            }
            AttachmentImageLoad::Failed => {
                status_card(&UNAVAILABLE, card_width, &self.tokens).into_any_element()
            }
            AttachmentImageLoad::Ready(image, _) => {
                let fit = match self.current_size(&image.bytes) {
                    PixelSize::Known(w, h) => fitted_size((w, h), limits, scale_factor),
                    PixelSize::Unread | PixelSize::Unreadable => limits,
                };
                let view = view_size(fit, limits, self.zoom);
                self.stage = Stage {
                    fit,
                    limits,
                    viewport: view,
                    ..self.stage
                };
                let tokens = self.tokens.clone();
                let picture = img(ImageSource::Image(image))
                    .flex_none()
                    .w(px(fit.0 * self.zoom))
                    .h(px(fit.1 * self.zoom))
                    .rounded(px(PICTURE_RADIUS_PX))
                    .object_fit(ObjectFit::Contain)
                    .with_fallback(move || {
                        status_card(&UNAVAILABLE, card_width, &tokens).into_any_element()
                    });
                let cursor = match (self.zoom > 1.0, self.drag.is_some()) {
                    (false, _) => CursorStyle::PointingHand,
                    (true, false) => CursorStyle::OpenHand,
                    (true, true) => CursorStyle::ClosedHand,
                };
                // The picture is its own scroll viewport: the wheel and trackpad scroll it
                // natively once zoomed, and a drag moves it.
                div()
                    .id("image-viewer-picture")
                    .test_support()
                    .a11y(Role::Image, "image-viewer.image", format!("Image {name}"))
                    .aria_description(
                        "Click to zoom in or return to fit. Scroll or drag to pan. Use Enter to \
                         toggle zoom, plus or minus to zoom, and 0 to fit.",
                    )
                    .flex_none()
                    .w(px(view.0))
                    .h(px(view.1))
                    .overflow_scroll()
                    .track_scroll(&self.scroll)
                    .rounded(px(PICTURE_RADIUS_PX))
                    .shadow_lg()
                    .cursor(cursor)
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, _window, cx| {
                            this.press_picture(event);
                            cx.stop_propagation();
                        }),
                    )
                    .on_click(cx.listener(|this, event: &ClickEvent, _window, cx| {
                        this.click_picture(event, cx);
                    }))
                    .child(picture)
                    .into_any_element()
            }
        }
    }

    fn render_caption(&self, max_width: f32) -> Option<AnyElement> {
        let item = self.items.get(self.index)?;
        let text = caption(&item.name, self.index, self.items.len());
        Some(
            div()
                .id("image-viewer-caption")
                .test_support()
                .a11y_group("image-viewer.caption", text.clone())
                .max_w(px(max_width))
                .px(px(EDGE_INSET_PX))
                .truncate()
                .text_size(px(12.0))
                .line_height(px(16.0))
                .text_color(white(0.80))
                .occlude()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(text)
                .into_any_element(),
        )
    }
}

/// A status in the stage: loading, or the picture could not be shown.
struct Status {
    id: &'static str,
    ax_id: &'static str,
    role: Role,
    label: &'static str,
    message: &'static str,
    icon: &'static str,
}

const LOADING: Status = Status {
    id: "image-viewer-loading",
    ax_id: "image-viewer.loading",
    role: Role::Group,
    label: "Loading image",
    message: "Loading image…",
    icon: chat_icons::IMAGE,
};

/// `ExpandedMediaFailure` copy when there is no link to the original.
const UNAVAILABLE: Status = Status {
    id: "image-viewer-unavailable",
    ax_id: "image-viewer.error",
    role: Role::Alert,
    label: "Image unavailable",
    message: "Image unavailable. The file may have been moved or deleted.",
    icon: chat_icons::ERROR_CIRCLE,
};

/// `EXPANDED_MEDIA_STATE_CLASS_NAME`: white on black with a `border-border/70` edge.
fn status_card(status: &Status, width: f32, tokens: &Tokens) -> impl IntoElement {
    div()
        .id(status.id)
        .test_support()
        .a11y(status.role, status.ax_id, status.label)
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(12.0))
        .w(px(width))
        .h(px(STATUS_CARD_HEIGHT_PX))
        .p(px(24.0))
        .rounded(px(10.0))
        .border_1()
        .border_color(hsla_alpha(tokens.border, 0.70))
        .bg(black(1.0))
        .text_color(white(1.0))
        .text_size(px(13.0))
        .line_height(px(20.0))
        .text_center()
        .shadow_lg()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(chat_icons::icon(status.icon, 20.0, white(0.65)))
        .child(status.message)
}

/// Element id, accessibility id and label of one control.
struct ControlIds {
    id: &'static str,
    ax_id: &'static str,
    label: &'static str,
}

/// The two media button looks of `button.tsx`.
#[derive(Clone, Copy)]
enum ControlStyle {
    /// `media-close`: `bg-black/65`, white text, `ring-white/20`, `hover:bg-black/80`.
    Close,
    /// `media-navigation`: no fill, `text-white/90`, `hover:bg-white/10`.
    Navigation,
}

/// A round or pill control over the scrim.
fn control_button(
    style: ControlStyle,
    ids: &ControlIds,
    content: AnyElement,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let (fill, hover, edge, text) = match style {
        ControlStyle::Close => (black(0.65), black(0.80), white(0.20), white(1.0)),
        ControlStyle::Navigation => (black(0.0), white(0.10), black(0.0), white(0.90)),
    };
    div()
        .id(ids.id)
        .test_support()
        .a11y_button(ids.ax_id, ids.label)
        .tab_index(0)
        .focus_visible(|style| style.border_color(white(1.0)))
        .flex()
        .flex_row()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .h(px(BUTTON_HEIGHT_PX))
        .min_w(px(BUTTON_HEIGHT_PX))
        .px(px(10.0))
        .rounded(px(9999.0))
        .bg(fill)
        .border_1()
        .border_color(edge)
        .text_color(text)
        .text_size(px(13.0))
        .line_height(px(20.0))
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_click(on_click)
        .child(content)
}

impl Render for ImageViewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let (viewport_w, viewport_h) = (f32::from(viewport.width), f32::from(viewport.height));
        let limits = stage_limits(viewport_w, viewport_h);
        let scale_factor = window.scale_factor();
        // A resized window fits the picture again, as `ZoomableImage.tsx` does.
        if self.stage.window != (viewport_w, viewport_h) {
            if self.stage.window.0 > 0.0 {
                self.reset_zoom();
            }
            self.stage.window = (viewport_w, viewport_h);
        }
        // Keys are routed here by `ConnApp`; keep typing out of the composer if focus is lost.
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        // `DIALOG_MEDIA_BACKDROP_CLASS`: `bg-black/75`, no blur, in both themes.
        let scrim = black(0.75);

        let mut stage = div()
            .absolute()
            .inset_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .child(self.render_stage(limits, scale_factor, cx));
        if let Some(caption) = self.render_caption(limits.0) {
            stage = stage.child(caption);
        }

        let back = control_button(
            ControlStyle::Close,
            &ControlIds {
                id: "image-viewer-close",
                ax_id: "image-viewer.close",
                label: "Back, close image preview",
            },
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(icons::chrome(IconName::ArrowLeft, white(1.0)))
                .child("Back")
                .into_any_element(),
            cx.listener(|this, _: &ClickEvent, _window, cx| this.close(cx)),
        );

        let mut root = div()
            .id("image-viewer")
            .test_support()
            .a11y(Role::Dialog, "image-viewer.modal", "Expanded image preview")
            .relative()
            .w(viewport.width)
            .h(viewport.height)
            .bg(scrim)
            .font_family(".SystemUIFont")
            .text_color(white(1.0))
            .occlude()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _window, cx| this.close(cx)),
            )
            // A drag follows the pointer over the whole window and ends on release anywhere.
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                this.drag_to(event, cx);
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _window, cx| {
                    if this.drag.take().is_some() {
                        cx.notify();
                    }
                }),
            )
            .child(stage)
            .child(
                div()
                    .absolute()
                    .top(px(BACK_TOP_PX))
                    .left(px(EDGE_INSET_PX))
                    .child(back),
            );

        if self.items.len() > 1 {
            let previous = control_button(
                ControlStyle::Navigation,
                &ControlIds {
                    id: "image-viewer-previous",
                    ax_id: "image-viewer.previous",
                    label: "Previous media",
                },
                icons::chrome(IconName::ChevronLeft, white(0.90)).into_any_element(),
                cx.listener(|this, _: &ClickEvent, _window, cx| this.step(Step::Previous, cx)),
            );
            let next = control_button(
                ControlStyle::Navigation,
                &ControlIds {
                    id: "image-viewer-next",
                    ax_id: "image-viewer.next",
                    label: "Next media",
                },
                icons::chrome(IconName::ChevronRight, white(0.90)).into_any_element(),
                cx.listener(|this, _: &ClickEvent, _window, cx| this.step(Step::Next, cx)),
            );
            // Side by side at the window's vertical middle, or in the bottom corners when narrow.
            let (previous_slot, next_slot) = if viewport_w < COMPACT_WIDTH_PX {
                (
                    div()
                        .absolute()
                        .bottom(px(EDGE_INSET_PX))
                        .left(px(EDGE_INSET_PX)),
                    div()
                        .absolute()
                        .bottom(px(EDGE_INSET_PX))
                        .right(px(EDGE_INSET_PX)),
                )
            } else {
                (
                    div()
                        .absolute()
                        .top(px((viewport_h - BUTTON_HEIGHT_PX) / 2.0))
                        .left(px(EDGE_INSET_PX)),
                    div()
                        .absolute()
                        .top(px((viewport_h - BUTTON_HEIGHT_PX) / 2.0))
                        .right(px(EDGE_INSET_PX)),
                )
            };
            root = root
                .child(previous_slot.child(previous))
                .child(next_slot.child(next));
        }

        let root = root.focus_trap("image-viewer-focus", &self.focus);
        deferred(anchored().position(point(px(0.0), px(0.0))).child(root))
            .with_priority(crate::panels::chrome::MODAL_LAYER_PRIORITY)
    }
}

/// Renders an open [`ImageViewer`] entity as a deferred window overlay.
#[must_use]
pub(crate) fn render_overlay(viewer: &Entity<ImageViewer>) -> AnyElement {
    viewer.clone().into_any_element()
}

impl ChatView {
    /// The download entity of a sent image, started on first use and shared by the thumbnail and
    /// the viewer. `None` while the chat has no connection to download from.
    pub(super) fn attachment_image_entity(
        &self,
        image: &ChatImageAttachment,
        cx: &mut Context<'_, Self>,
    ) -> Option<Entity<AttachmentImageState>> {
        let connection = self.connection.clone()?;
        let mut images = self.attachment_images.borrow_mut();
        let (state, _) = images.entry(image.id.clone()).or_insert_with(|| {
            let state = cx.new(|cx| {
                AttachmentImageState::fetch(
                    connection,
                    image.id.clone(),
                    image.mime_type.clone(),
                    cx,
                )
            });
            let subscription = cx.observe(&state, |_, _, cx| cx.notify());
            (state, subscription)
        });
        Some(state.clone())
    }

    /// Asks the shell to open the viewer on the attachment at `clicked` in a sent message. The
    /// gallery is every image of the message in attach order, whatever videos or files sit
    /// between them.
    pub(super) fn open_image_viewer(
        &self,
        attachments: &[ChatAttachment],
        clicked: usize,
        cx: &mut Context<'_, Self>,
    ) {
        let Some((images, index)) = gallery_images(attachments, clicked) else {
            return;
        };
        let items = images
            .into_iter()
            .map(|image| {
                // Without a connection nothing can download: the viewer shows it as unavailable
                // and nothing is cached, so a later connection still loads the thumbnail.
                let state = self.attachment_image_entity(image, cx).unwrap_or_else(|| {
                    cx.new(|_| AttachmentImageState {
                        load: AttachmentImageLoad::Failed,
                    })
                });
                ViewerItem {
                    id: image.id.clone(),
                    name: image.name.clone(),
                    state,
                }
            })
            .collect();
        cx.emit(ChatEvent::OpenImageViewer {
            images: items,
            index,
        });
    }
}

/// How a test item's download stands.
#[cfg(test)]
pub(crate) enum TestLoad {
    Loading,
    Png(Vec<u8>),
}

#[cfg(test)]
impl TestLoad {
    fn into_load(self) -> AttachmentImageLoad {
        match self {
            Self::Loading => AttachmentImageLoad::Loading,
            Self::Png(bytes) => {
                let aspect = super::attachment_thumb::image_aspect_ratio(&bytes);
                super::attachment_thumb::preview_image("image/png", bytes)
                    .map_or(AttachmentImageLoad::Failed, |image| {
                        AttachmentImageLoad::Ready(image, aspect)
                    })
            }
        }
    }
}

#[cfg(test)]
impl ViewerItem {
    pub(crate) fn for_test(id: &str, name: &str, load: TestLoad, cx: &mut App) -> Self {
        Self {
            id: id.to_owned(),
            name: name.to_owned(),
            state: cx.new(|_| AttachmentImageState {
                load: load.into_load(),
            }),
        }
    }

    /// Ends or changes this item's download, as the network would.
    pub(crate) fn resolve_for_test(&self, load: TestLoad, cx: &mut App) {
        self.state.update(cx, |state, cx| {
            state.load = load.into_load();
            cx.notify();
        });
    }
}

#[cfg(test)]
impl ImageViewer {
    pub(crate) fn has_focus_for_test(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }
}

/// A transparent PNG of `width` by `height` pixels.
#[cfg(test)]
pub(crate) fn png_for_test(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image::RgbaImage::new(width, height))
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("a blank image encodes as PNG");
    bytes
}

#[cfg(test)]
mod tests {
    use conn_contract::{ChatFileAttachment, ChatUnknownAttachment, lit};

    use super::*;

    fn image(id: &str) -> ChatAttachment {
        ChatAttachment::Image(ChatImageAttachment {
            r#type: lit::Image,
            id: id.to_owned(),
            name: format!("{id}.png"),
            mime_type: "image/png".to_owned(),
            size_bytes: 1,
            source: None,
        })
    }

    fn file(id: &str) -> ChatAttachment {
        ChatAttachment::File(ChatFileAttachment {
            r#type: lit::File,
            id: id.to_owned(),
            name: format!("{id}.txt"),
            mime_type: "text/plain".to_owned(),
            size_bytes: 1,
            source: None,
        })
    }

    fn unknown(id: &str) -> ChatAttachment {
        ChatAttachment::Unknown(ChatUnknownAttachment {
            r#type: "audio".to_owned(),
            id: id.to_owned(),
            name: format!("{id}.m4a"),
            mime_type: "audio/mp4".to_owned(),
            size_bytes: 1,
        })
    }

    #[test]
    fn the_gallery_keeps_attach_order_across_files_and_other_media() {
        let attachments = [image("a"), file("f"), image("b"), unknown("u"), image("c")];
        let (images, index) = gallery_images(&attachments, 4).expect("c is an image");
        let ids: Vec<&str> = images.iter().map(|image| image.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(index, 2);
        let (_, index) = gallery_images(&attachments, 0).expect("a is an image");
        assert_eq!(index, 0);
    }

    #[test]
    fn a_repeated_attachment_opens_the_clicked_occurrence() {
        let attachments = [image("a"), file("f"), image("a"), image("b")];
        let (images, index) = gallery_images(&attachments, 2).expect("the second a");
        assert_eq!(images.len(), 3);
        assert_eq!(index, 1, "the second occurrence, not the first");
    }

    #[test]
    fn a_file_or_missing_position_opens_nothing() {
        let attachments = [image("a"), file("f")];
        assert!(gallery_images(&attachments, 1).is_none());
        assert!(gallery_images(&attachments, 2).is_none());
        assert!(gallery_images(&[], 0).is_none());
    }

    #[test]
    fn zooming_at_the_middle_keeps_the_middle_and_fit_scrolls_nowhere() {
        let (fit, limits) = ((400.0, 300.0), (1000.0, 700.0));
        // 2x of a 400x300 fit grows the viewport to 800x600 (inside the limits): no scroll yet.
        assert_close(max_scroll(fit, limits, 2.0), (0.0, 0.0));
        // 4x is 1600x1200 in a 1000x700 viewport: it can scroll the difference.
        assert_close(max_scroll(fit, limits, 4.0), (600.0, 500.0));
        assert_close(max_scroll(fit, limits, 1.0), (0.0, 0.0));
        // Zooming from fit to 4x at the viewport middle (200, 150) lands the middle of the
        // picture in the middle of the new viewport: offset = 500 - 800 = -300, 350 - 600 = -250.
        let offset = zoomed_offset((0.0, 0.0), (200.0, 150.0), (1.0, 4.0), fit, limits);
        assert_close(offset, (-300.0, -250.0));
    }

    #[test]
    fn zooming_at_a_corner_keeps_that_corner_and_the_offset_stays_in_range() {
        let (fit, limits) = ((400.0, 300.0), (1000.0, 700.0));
        // The top-left pixel stays under the pointer: nothing scrolled yet, point (0, 0).
        let offset = zoomed_offset((0.0, 0.0), (0.0, 0.0), (1.0, 4.0), fit, limits);
        // The viewport grew by 600x400 around its middle, so the corner sits at (300, 200) in it.
        assert_close(offset, (0.0, 0.0));
        // Zooming back to fit never leaves an offset.
        let back = zoomed_offset((-300.0, -250.0), (500.0, 350.0), (4.0, 1.0), fit, limits);
        assert_close(back, (0.0, 0.0));
        assert_close(clamp_offset((50.0, -900.0), (600.0, 500.0)), (0.0, -500.0));
    }

    #[test]
    fn stepping_wraps_at_both_ends_and_a_single_image_stays() {
        assert_eq!(stepped_index(0, Step::Previous, 3), 2);
        assert_eq!(stepped_index(2, Step::Next, 3), 0);
        assert_eq!(stepped_index(1, Step::Next, 3), 2);
        assert_eq!(stepped_index(1, Step::Previous, 3), 0);
        assert_eq!(stepped_index(0, Step::Next, 1), 0);
        assert_eq!(stepped_index(0, Step::Previous, 0), 0);
    }

    #[test]
    fn the_caption_counts_only_a_gallery() {
        assert_eq!(caption("shot.png", 1, 3), "shot.png (2/3)");
        assert_eq!(caption("shot.png", 0, 1), "shot.png");
    }

    fn assert_close(actual: (f32, f32), expected: (f32, f32)) {
        assert!(
            (actual.0 - expected.0).abs() < 0.01 && (actual.1 - expected.1).abs() < 0.01,
            "{actual:?} != {expected:?}"
        );
    }

    #[test]
    fn the_stage_leaves_room_for_the_buttons_and_the_caption() {
        assert_close(stage_limits(1440.0, 900.0), (1228.8, 740.0));
        // Narrow: the side buttons move to the bottom, so the picture keeps the full 92%.
        assert_close(stage_limits(500.0, 700.0), (460.0, 540.0));
        assert_close(stage_limits(500.0, 400.0), (460.0, 240.0));
        // Never zero, so a tiny window cannot make a zero-size picture.
        assert_close(stage_limits(10.0, 100.0), (9.2, 1.0));
    }

    #[test]
    fn a_picture_fits_whole_at_its_own_aspect_ratio() {
        let limits = (1000.0, 700.0);
        let (w, h) = fitted_size((4000, 2000), limits, 1.0);
        assert!(
            (w - 1000.0).abs() < 0.01 && (h - 500.0).abs() < 0.01,
            "{w}x{h}"
        );
        let (w, h) = fitted_size((1000, 4000), limits, 1.0);
        assert!(
            (w - 175.0).abs() < 0.01 && (h - 700.0).abs() < 0.01,
            "{w}x{h}"
        );
        for natural in [(4000, 2000), (1000, 4000), (333, 777)] {
            let (w, h) = fitted_size(natural, limits, 2.0);
            assert!(w <= limits.0 + 0.01 && h <= limits.1 + 0.01);
            let want = natural.0 as f32 / natural.1 as f32;
            assert!((w / h - want).abs() < 0.01, "{natural:?} -> {w}x{h}");
        }
    }

    #[test]
    fn a_small_picture_is_not_blown_up_past_one_pixel_per_device_pixel() {
        assert_eq!(fitted_size((100, 50), (1000.0, 700.0), 1.0), (100.0, 50.0));
        assert_eq!(fitted_size((100, 50), (1000.0, 700.0), 2.0), (50.0, 25.0));
    }

    #[test]
    fn the_size_comes_from_the_header_and_bad_bytes_give_none() {
        assert_eq!(image_pixel_size(&png_for_test(30, 20)), Some((30, 20)));
        assert_eq!(image_pixel_size(b"not an image"), None);
    }
}
