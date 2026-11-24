//! Sent image thumbnails without GPUI: the pixel size to decode at, the crop and downscale, a
//! byte-bounded LRU, and the queue that limits loads running at once.
//!
//! GPUI decodes an `ImageSource::Image` once at full size and keeps the pixels until something
//! removes them, so twelve 4000×3000 photos held about 549 MiB. The chat paints only the pixels
//! a tile shows, decoded at tile size, and keeps them in [`ByteLru`].

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::Hash;
use std::io::Cursor;

use image::{Frame, RgbaImage};

/// Decoded thumbnail pixels the chat keeps at most: about 15 full-width tiles at 2x. The rows
/// on screen plus the list's overdraw must fit, or visible tiles would evict each other.
pub(super) const THUMB_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// Pixels one entry may hold, all frames together: a quarter of the budget, so four of the
/// largest entries fit at once and never push each other out.
pub(super) const ENTRY_MAX_BYTES: usize = THUMB_BUDGET_BYTES / 4;

/// Thumbnail loads (download and decode) that run at once. Each holds one downloaded file and
/// one full-size decode, so this bounds the memory spike when many images arrive together.
pub(super) const LOAD_CONCURRENCY: usize = 2;

/// A size in device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct TargetPx {
    pub(super) width: u32,
    pub(super) height: u32,
}

impl TargetPx {
    /// `width`×`height` logical px at `scale`, rounded up. A zero side leaves that side free.
    pub(super) fn from_logical(width: f32, height: f32, scale: f32) -> Self {
        let device = |side: f32| (side.max(0.0) * scale.max(1.0)).ceil() as u32;
        Self {
            width: device(width),
            height: device(height),
        }
    }
}

/// Logical width and height of one tile in a grid of `columns` equal `aspect` (width over
/// height) tiles, `gap` apart and inset `gap` from both sides of a `container` wide box.
pub(super) fn grid_tile_px(container: f32, gap: f32, columns: usize, aspect: f32) -> (f32, f32) {
    let columns = columns.max(1) as f32;
    let width = ((container - 2.0 * gap - (columns - 1.0) * gap) / columns).max(0.0);
    (width, width / aspect)
}

/// The centered part of a `width`×`height` picture that a cover crop into a box of `target`'s
/// shape shows, as `(x, y, width, height)`. A free side in `target` keeps the whole picture.
pub(super) fn visible_region(width: u32, height: u32, target: TargetPx) -> (u32, u32, u32, u32) {
    if target.width == 0 || target.height == 0 || width == 0 || height == 0 {
        return (0, 0, width, height);
    }
    let (w, h) = (u64::from(width), u64::from(height));
    let (tw, th) = (u64::from(target.width), u64::from(target.height));
    if w * th > h * tw {
        let crop = ((h * tw + th / 2) / th).clamp(1, w) as u32;
        ((width - crop) / 2, 0, crop, height)
    } else {
        let crop = ((w * th + tw / 2) / tw).clamp(1, h) as u32;
        (0, (height - crop) / 2, width, crop)
    }
}

/// The size to scale a `width`×`height` region to: just covering `target`, never up, and no
/// more than `max_bytes` of 4-byte pixels.
pub(super) fn scaled_size(
    width: u32,
    height: u32,
    target: TargetPx,
    max_bytes: usize,
) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    let mut scale = (f64::from(target.width) / f64::from(width))
        .max(f64::from(target.height) / f64::from(height))
        .min(1.0);
    let bytes = f64::from(width) * f64::from(height) * 4.0 * scale * scale;
    let capped = bytes > max_bytes as f64;
    if capped {
        scale *= (max_bytes as f64 / bytes).sqrt();
    }
    // Round up to keep covering the target; round down under the cap to stay within it.
    let round = |side: f64| if capped { side.floor() } else { side.ceil() };
    let side = |length: u32| (round(f64::from(length) * scale) as u32).clamp(1, length);
    (side(width), side(height))
}

/// Crops `frame` to what a `target` tile shows and scales it down to fit (channel order kept).
pub(super) fn fit_frame(frame: &RgbaImage, target: TargetPx, max_bytes: usize) -> RgbaImage {
    let (x, y, width, height) = visible_region(frame.width(), frame.height(), target);
    let (scaled_width, scaled_height) = scaled_size(width, height, target, max_bytes);
    let region = image::imageops::crop_imm(frame, x, y, width, height);
    if (scaled_width, scaled_height) == (width, height) {
        region.to_image()
    } else {
        image::imageops::resize(
            &*region,
            scaled_width,
            scaled_height,
            image::imageops::FilterType::Triangle,
        )
    }
}

/// Thumbnail frames in GPUI's `RenderImage` pixel order (BGRA, straight alpha, as GPUI's own
/// decode), with their delays.
pub(super) struct Thumbnail {
    pub(super) frames: Vec<Frame>,
    /// Width over height of the upright picture before the crop.
    pub(super) aspect: Option<f32>,
}

impl Thumbnail {
    /// Decoded bytes of every frame: what GPUI keeps for it.
    pub(super) fn byte_len(&self) -> usize {
        self.frames
            .iter()
            .map(|frame| frame.buffer().as_raw().len())
            .sum()
    }
}

/// Fits each of `frames` to `target`. When all of them together would pass
/// [`ENTRY_MAX_BYTES`], only the first stays: a still thumbnail. `to_bgra` swaps RGBA input.
pub(super) fn fit_frames(
    frames: impl IntoIterator<Item = Frame>,
    target: TargetPx,
    to_bgra: bool,
) -> Option<Thumbnail> {
    let mut fitted: Vec<Frame> = Vec::new();
    let mut aspect = None;
    let mut bytes = 0;
    for frame in frames {
        if fitted.is_empty() {
            let (width, height) = frame.buffer().dimensions();
            aspect = (width > 0 && height > 0).then(|| width as f32 / height as f32);
        }
        let delay = frame.delay();
        let mut pixels = fit_frame(frame.buffer(), target, ENTRY_MAX_BYTES);
        if to_bgra {
            for pixel in pixels.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
        bytes += pixels.as_raw().len();
        if bytes > ENTRY_MAX_BYTES && !fitted.is_empty() {
            fitted.truncate(1);
            break;
        }
        fitted.push(Frame::from_parts(pixels, 0, 0, delay));
    }
    (!fitted.is_empty()).then_some(Thumbnail {
        frames: fitted,
        aspect,
    })
}

/// Decodes PNG, JPEG, WebP or GIF `bytes` into a thumbnail for `target`, turning a still
/// picture upright from its EXIF orientation as GPUI does. `None` for other formats or bad
/// data. Slow: call it off the UI thread.
pub(super) fn decode_thumbnail(bytes: &[u8], target: TargetPx) -> Option<Thumbnail> {
    use image::{AnimationDecoder as _, ImageDecoder as _};
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    match reader.format()? {
        image::ImageFormat::Gif => {
            let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).ok()?;
            fit_frames(decoder.into_frames().map_while(Result::ok), target, true)
        }
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP => {
            let mut decoder = reader.into_decoder().ok()?;
            let orientation = decoder.orientation().ok()?;
            let mut picture = image::DynamicImage::from_decoder(decoder).ok()?;
            picture.apply_orientation(orientation);
            fit_frames([Frame::new(picture.into_rgba8())], target, true)
        }
        _ => None,
    }
}

/// A least-recently-used map whose entries cost bytes. Inserting past the budget evicts the
/// oldest costly entries; the entry just inserted always stays, so a picture larger than the
/// budget still shows. Free entries (loads in flight, failures) are never evicted.
pub(super) struct ByteLru<K, V> {
    entries: HashMap<K, Slot<V>>,
    budget: usize,
    total: usize,
    clock: u64,
}

struct Slot<V> {
    value: V,
    cost: usize,
    used: u64,
}

impl<K: Eq + Hash + Clone, V> ByteLru<K, V> {
    pub(super) fn new(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            budget,
            total: 0,
            clock: 0,
        }
    }

    /// The entry under `key`, marked as just used.
    pub(super) fn get(&mut self, key: &K) -> Option<&V> {
        self.clock += 1;
        let slot = self.entries.get_mut(key)?;
        slot.used = self.clock;
        Some(&slot.value)
    }

    pub(super) fn peek(&self, key: &K) -> Option<&V> {
        self.entries.get(key).map(|slot| &slot.value)
    }

    /// Puts `value` under `key` (replacing what was there) and returns the values it pushed out.
    #[must_use]
    pub(super) fn insert(&mut self, key: K, value: V, cost: usize) -> Vec<V> {
        self.clock += 1;
        let slot = Slot {
            value,
            cost,
            used: self.clock,
        };
        let mut evicted = Vec::new();
        if let Some(old) = self.entries.insert(key.clone(), slot) {
            self.total -= old.cost;
            evicted.push(old.value);
        }
        self.total += cost;
        while self.total > self.budget {
            let oldest = self
                .entries
                .iter()
                .filter(|(other, slot)| slot.cost > 0 && **other != key)
                .min_by_key(|(_, slot)| slot.used)
                .map(|(other, _)| other.clone());
            let Some(oldest) = oldest else { break };
            if let Some(slot) = self.entries.remove(&oldest) {
                self.total -= slot.cost;
                evicted.push(slot.value);
            }
        }
        evicted
    }

    #[must_use]
    pub(super) fn remove(&mut self, key: &K) -> Option<V> {
        let slot = self.entries.remove(key)?;
        self.total -= slot.cost;
        Some(slot.value)
    }

    /// Empties the map and returns every value.
    #[must_use]
    pub(super) fn clear(&mut self) -> Vec<V> {
        self.total = 0;
        self.entries.drain().map(|(_, slot)| slot.value).collect()
    }

    #[cfg(test)]
    pub(super) fn total_bytes(&self) -> usize {
        self.total
    }
}

/// Thumbnail loads: at most `limit` run, the rest wait in order. A load whose tile was not
/// drawn since the last [`Self::sweep`] is cancelled, so tiles scrolled past never decode.
pub(super) struct LoadQueue<K, J> {
    limit: usize,
    running: HashSet<K>,
    pending: VecDeque<(K, J)>,
    seen: HashSet<K>,
}

impl<K: Eq + Hash + Clone, J> LoadQueue<K, J> {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit: limit.max(1),
            running: HashSet::new(),
            pending: VecDeque::new(),
            seen: HashSet::new(),
        }
    }

    /// Asks to load `key`. Returns the job when a slot is free and it should start now.
    #[must_use]
    pub(super) fn request(&mut self, key: K, job: J) -> Option<(K, J)> {
        self.seen.insert(key.clone());
        if self.running.len() < self.limit {
            self.running.insert(key.clone());
            Some((key, job))
        } else {
            self.pending.push_back((key, job));
            None
        }
    }

    /// Marks `key` as still drawn, so the next sweep keeps its load.
    pub(super) fn touch(&mut self, key: &K) {
        if !self.seen.contains(key) {
            self.seen.insert(key.clone());
        }
    }

    /// Frees the slot of the finished load `key` and returns the loads that start now.
    #[must_use]
    pub(super) fn finish(&mut self, key: &K) -> Vec<(K, J)> {
        self.running.remove(key);
        self.start_waiting()
    }

    /// Cancels every load not drawn since the last sweep. Returns the cancelled keys and the
    /// loads that start in the freed slots.
    #[must_use]
    pub(super) fn sweep(&mut self) -> (Vec<K>, Vec<(K, J)>) {
        let mut cancelled = Vec::new();
        let seen = std::mem::take(&mut self.seen);
        self.running.retain(|key| {
            let keep = seen.contains(key);
            if !keep {
                cancelled.push(key.clone());
            }
            keep
        });
        self.pending.retain(|(key, _)| {
            let keep = seen.contains(key);
            if !keep {
                cancelled.push(key.clone());
            }
            keep
        });
        (cancelled, self.start_waiting())
    }

    /// Forgets every load (reconnect); the caller drops their tasks.
    pub(super) fn clear(&mut self) {
        self.running.clear();
        self.pending.clear();
        self.seen.clear();
    }

    fn start_waiting(&mut self) -> Vec<(K, J)> {
        let mut started = Vec::new();
        while self.running.len() < self.limit {
            let Some((key, job)) = self.pending.pop_front() else {
                break;
            };
            self.running.insert(key.clone());
            started.push((key, job));
        }
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT_BUBBLE_MAX_PX: f32 = 736.0 * 0.8;

    fn one_column_tile_at_2x() -> TargetPx {
        let (width, height) = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 1, 4.0 / 3.0);
        TargetPx::from_logical(width, height, 2.0)
    }

    #[test]
    fn target_follows_tile_size_and_scale() {
        let one = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 1, 4.0 / 3.0);
        let four = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 4, 4.0 / 3.0);
        assert!((one.0 - (CHAT_BUBBLE_MAX_PX - 6.0)).abs() < 1e-3);
        assert!((one.1 - one.0 * 0.75).abs() < 1e-3);
        // Four columns: three 3px gutters and two 3px insets share the width.
        assert!((four.0 - (CHAT_BUBBLE_MAX_PX - 15.0) / 4.0).abs() < 1e-3);
        let at_1x = TargetPx::from_logical(four.0, four.1, 1.0);
        let at_2x = TargetPx::from_logical(four.0, four.1, 2.0);
        assert_eq!(at_1x.width, four.0.ceil() as u32);
        assert_eq!(at_2x.width, (four.0 * 2.0).ceil() as u32);
        assert_eq!(at_2x.height, (four.1 * 2.0).ceil() as u32);
        assert!(
            TargetPx::from_logical(four.0, four.1, 0.0).width == at_1x.width,
            "a scale below 1 decodes at 1x"
        );
    }

    #[test]
    fn visible_region_is_the_centered_cover_crop() {
        let tile = TargetPx {
            width: 400,
            height: 300,
        };
        // Tall: the middle 4:3 band. Wide: the middle 4:3 slice. Same shape: all of it.
        assert_eq!(visible_region(1080, 8000, tile), (0, 3595, 1080, 810));
        assert_eq!(visible_region(8000, 1000, tile), (3333, 0, 1333, 1000));
        assert_eq!(visible_region(800, 600, tile), (0, 0, 800, 600));
        // A free height (a full-width picture) keeps everything.
        let full_width = TargetPx {
            width: 400,
            height: 0,
        };
        assert_eq!(visible_region(1080, 8000, full_width), (0, 0, 1080, 8000));
    }

    #[test]
    fn scaled_size_covers_without_upscaling_and_caps_bytes() {
        let target = TargetPx {
            width: 286,
            height: 214,
        };
        assert_eq!(scaled_size(1333, 1000, target, usize::MAX), (286, 215));
        assert_eq!(scaled_size(100, 80, target, usize::MAX), (100, 80));
        let full_width = TargetPx {
            width: 1000,
            height: 0,
        };
        assert_eq!(scaled_size(4000, 3000, full_width, usize::MAX), (1000, 750));
        // A tall full-width screenshot scales down until it fits the byte cap.
        let (width, height) = scaled_size(1080, 8000, full_width, ENTRY_MAX_BYTES);
        assert!(width as usize * height as usize * 4 <= ENTRY_MAX_BYTES);
        assert!(((width as f32 / height as f32) - 1080.0 / 8000.0).abs() < 0.01);
    }

    #[test]
    fn tall_screenshots_cache_only_the_visible_tile() {
        // The re-check case: a 1080x8000 screenshot kept 33 MiB outside its 4:3 crop.
        let target = one_column_tile_at_2x();
        let fitted = fit_frame(&RgbaImage::new(1080, 8000), target, ENTRY_MAX_BYTES);
        let (width, height) = fitted.dimensions();
        assert_eq!(width, 1080, "narrower than the tile, so no upscale");
        assert!((width as f32 / height as f32 - 4.0 / 3.0).abs() < 0.01);
        let cost = fitted.as_raw().len();
        assert!(cost <= target.width as usize * target.height as usize * 4);
        // Two visible together fit the budget and never evict each other.
        let mut cache = ByteLru::new(THUMB_BUDGET_BYTES);
        assert!(cache.insert("a", (), cost).is_empty());
        assert!(cache.insert("b", (), cost).is_empty());
    }

    #[test]
    fn large_photos_stay_within_the_budget() {
        // The review case: 4000x3000 photos, one per row at 2x, the largest tile there is.
        let target = one_column_tile_at_2x();
        let (x, y, w, h) = visible_region(4000, 3000, target);
        assert!(
            x <= 1 && y == 0,
            "a 4:3 photo loses at most a rounding column"
        );
        let (w, h) = scaled_size(w, h, target, ENTRY_MAX_BYTES);
        let cost = w as usize * h as usize * 4;
        // Twelve of them held about 549 MiB at full size; as tiles they take under 50 MiB.
        assert!(cost * 12 < 50 * 1024 * 1024);
        let mut cache = ByteLru::new(THUMB_BUDGET_BYTES);
        let mut evicted = 0;
        for id in 0..40 {
            evicted += cache.insert(id, (), cost).len();
            assert!(cache.total_bytes() <= THUMB_BUDGET_BYTES);
        }
        assert!(evicted > 0);
        assert!(cache.peek(&39).is_some(), "the newest stays");
        assert!(cache.peek(&0).is_none(), "the oldest went first");
    }

    fn frames(count: usize, width: u32, height: u32) -> Vec<Frame> {
        (0..count)
            .map(|_| Frame::new(RgbaImage::new(width, height)))
            .collect()
    }

    #[test]
    fn animations_are_charged_for_every_decoded_frame() {
        let tile = TargetPx {
            width: 64,
            height: 48,
        };
        let thumb = fit_frames(frames(5, 640, 480), tile, true).expect("frames");
        assert_eq!(thumb.frames.len(), 5);
        assert_eq!(thumb.byte_len(), 5 * 64 * 48 * 4);
    }

    #[test]
    fn an_animation_past_the_entry_cap_keeps_its_first_frame() {
        let full_width = TargetPx {
            width: 1024,
            height: 0,
        };
        // Five 4 MiB frames pass the 16 MiB cap: a still first frame stays.
        let thumb = fit_frames(frames(5, 1024, 1024), full_width, true).expect("frames");
        assert_eq!(thumb.frames.len(), 1);
        assert_eq!(thumb.byte_len(), 1024 * 1024 * 4);
        assert!(thumb.byte_len() <= ENTRY_MAX_BYTES);
        assert!(fit_frames(Vec::new(), full_width, true).is_none());
    }

    #[test]
    fn gifs_decode_every_frame() {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder.encode_frames(frames(3, 8, 6)).expect("encode gif");
        }
        let tile = TargetPx {
            width: 8,
            height: 6,
        };
        let thumb = decode_thumbnail(&bytes, tile).expect("decodes");
        assert_eq!(thumb.frames.len(), 3);
        assert_eq!(thumb.byte_len(), 3 * 8 * 6 * 4);
    }

    /// A 64x32 JPEG, red on the left and blue on the right, with EXIF orientation 6 (turn 90°
    /// clockwise to show it upright).
    fn rotated_jpeg() -> Vec<u8> {
        let picture = RgbaImage::from_fn(64, 32, |x, _| {
            if x < 32 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            }
        });
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgba8(picture)
            .into_rgb8()
            .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .expect("encode jpeg");
        // Big-endian TIFF with one IFD entry: Orientation (0x0112), SHORT, 1, value 6.
        let tiff: [u8; 26] = [
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0,
            0,
        ];
        let length = (2 + 6 + tiff.len()) as u16;
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&length.to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&tiff);
        jpeg.splice(2..2, app1);
        jpeg
    }

    #[test]
    fn decode_turns_the_picture_upright_in_bgra() {
        let free = TargetPx {
            width: 1000,
            height: 0,
        };
        let thumb = decode_thumbnail(&rotated_jpeg(), free).expect("decodes");
        let [frame] = thumb.frames.as_slice() else {
            panic!("one frame");
        };
        let pixels = frame.buffer();
        // Turned clockwise: 32 wide, 64 tall, the red left half now on top.
        assert_eq!(pixels.dimensions(), (32, 64));
        assert!((thumb.aspect.unwrap_or_default() - 0.5).abs() < 1e-4);
        // BGRA: red has its weight in byte 2, blue in byte 0.
        let red = pixels.get_pixel(16, 12).0;
        let blue = pixels.get_pixel(16, 52).0;
        assert!(red[2] > 200 && red[0] < 60, "top is red: {red:?}");
        assert!(blue[0] > 200 && blue[2] < 60, "bottom is blue: {blue:?}");
        assert!(decode_thumbnail(&[1, 2, 3], free).is_none());
    }

    #[test]
    fn lru_evicts_the_least_recently_used() {
        let mut cache = ByteLru::new(100);
        assert!(cache.insert("a", 1, 40).is_empty());
        assert!(cache.insert("b", 2, 40).is_empty());
        assert_eq!(cache.get(&"a"), Some(&1));
        assert_eq!(
            cache.insert("c", 3, 40),
            vec![2],
            "b was used last longest ago"
        );
        assert_eq!(cache.total_bytes(), 80);
        // Replacing an entry hands back the old value and settles the total.
        assert_eq!(cache.insert("a", 4, 10), vec![1]);
        assert_eq!(cache.total_bytes(), 50);
        assert_eq!(cache.remove(&"a"), Some(4));
        assert_eq!(cache.total_bytes(), 40);
    }

    #[test]
    fn lru_keeps_free_entries_and_an_oversized_newest() {
        let mut cache = ByteLru::new(100);
        assert!(cache.insert("loading", 0, 0).is_empty());
        assert!(cache.insert("small", 1, 60).is_empty());
        assert_eq!(cache.insert("huge", 2, 500), vec![1]);
        assert_eq!(cache.peek(&"huge"), Some(&2));
        assert_eq!(cache.peek(&"loading"), Some(&0));
        assert_eq!(cache.clear().len(), 2);
        assert_eq!(cache.total_bytes(), 0);
    }

    #[test]
    fn loads_run_two_at_a_time_in_order() {
        let mut loads = LoadQueue::new(LOAD_CONCURRENCY);
        assert_eq!(loads.request("a", 1), Some(("a", 1)));
        assert_eq!(loads.request("b", 2), Some(("b", 2)));
        assert_eq!(loads.request("c", 3), None);
        assert_eq!(loads.request("d", 4), None);
        assert_eq!(loads.finish(&"a"), vec![("c", 3)]);
        assert_eq!(loads.finish(&"b"), vec![("d", 4)]);
        assert!(loads.finish(&"c").is_empty());
    }

    #[test]
    fn loads_of_tiles_scrolled_away_are_cancelled() {
        let mut loads = LoadQueue::new(2);
        assert!(loads.request("a", 1).is_some());
        assert!(loads.request("b", 2).is_some());
        assert!(loads.request("c", 3).is_none());
        assert!(loads.request("d", 4).is_none());
        // Every request counts as drawn until the first sweep.
        let (cancelled, started) = loads.sweep();
        assert!(cancelled.is_empty() && started.is_empty());
        // Only `b` and `d` are drawn again: `a` (running) and `c` (waiting) go, `d` starts.
        loads.touch(&"b");
        loads.touch(&"d");
        let (mut cancelled, started) = loads.sweep();
        cancelled.sort_unstable();
        assert_eq!(cancelled, ["a", "c"]);
        assert_eq!(started, [("d", 4)]);
        // A cancelled load finishing late frees nothing and starts nothing.
        assert!(loads.finish(&"a").is_empty());
        loads.clear();
        assert_eq!(loads.request("e", 5), Some(("e", 5)));
    }
}
