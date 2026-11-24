//! Sent image thumbnails without GPUI: the pixel size to decode at, the downscale, and a
//! byte-bounded LRU.
//!
//! GPUI decodes an `ImageSource::Image` once at full size and keeps the pixels until something
//! removes them, so twelve 4000×3000 photos held about 549 MiB. The chat paints pixels decoded
//! at tile size instead and keeps them in [`ByteLru`].

use std::collections::HashMap;
use std::hash::Hash;
use std::io::Cursor;

/// Decoded thumbnail pixels the chat keeps at most: about 15 full-width tiles at 2x. The rows
/// on screen plus the list's overdraw must fit, or visible tiles would evict each other.
pub(super) const THUMB_BUDGET_BYTES: usize = 64 * 1024 * 1024;

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

/// The size of a `width`×`height` picture scaled to just cover `target`, never scaled up.
pub(super) fn cover_size(width: u32, height: u32, target: TargetPx) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    let scale = (target.width as f64 / width as f64)
        .max(target.height as f64 / height as f64)
        .min(1.0);
    let side = |length: u32| ((length as f64 * scale).ceil() as u32).clamp(1, length);
    (side(width), side(height))
}

/// Whether the chat decodes `mime_type` into a thumbnail. GIF keeps GPUI's own path so it still
/// animates; SVG, BMP and TIFF are formats this build of `image` does not read.
pub(super) fn thumbnail_supported(mime_type: &str) -> bool {
    matches!(
        mime_type.to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp"
    )
}

/// A thumbnail in GPUI's `RenderImage` pixel order (BGRA, straight alpha, as GPUI's own decode).
pub(super) struct Thumbnail {
    pub(super) pixels: image::RgbaImage,
    /// Width over height of the upright picture.
    pub(super) aspect: Option<f32>,
}

impl Thumbnail {
    pub(super) fn byte_len(&self) -> usize {
        self.pixels.as_raw().len()
    }
}

/// Decodes `bytes`, turns the picture upright from its EXIF orientation as GPUI does, and
/// scales it to cover `target`. Slow: call it off the UI thread.
pub(super) fn decode_thumbnail(bytes: &[u8], target: TargetPx) -> Option<Thumbnail> {
    use image::ImageDecoder as _;
    let mut decoder = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().ok()?;
    let mut picture = image::DynamicImage::from_decoder(decoder).ok()?;
    picture.apply_orientation(orientation);
    let (width, height) = (picture.width(), picture.height());
    let aspect = (width > 0 && height > 0).then(|| width as f32 / height as f32);
    let (thumb_width, thumb_height) = cover_size(width, height, target);
    if (thumb_width, thumb_height) != (width, height) {
        picture = picture.resize_exact(
            thumb_width,
            thumb_height,
            image::imageops::FilterType::Triangle,
        );
    }
    let mut pixels = picture.into_rgba8();
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    Some(Thumbnail { pixels, aspect })
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

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT_BUBBLE_MAX_PX: f32 = 736.0 * 0.8;

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
    fn cover_size_covers_the_target_without_upscaling() {
        let target = TargetPx {
            width: 286,
            height: 214,
        };
        // Landscape and portrait photos both cover the box on both sides.
        for (width, height) in [(4000, 3000), (3000, 4000), (8000, 1000)] {
            let (w, h) = cover_size(width, height, target);
            assert!(w >= target.width && h >= target.height, "{width}x{height}");
            assert!(w < width && h < height);
            assert!(w == target.width || h == target.height, "just covers");
        }
        assert_eq!(cover_size(100, 80, target), (100, 80));
        // A free height fits the width: a full-width picture.
        assert_eq!(
            cover_size(
                4000,
                3000,
                TargetPx {
                    width: 1000,
                    height: 0
                }
            ),
            (1000, 750)
        );
    }

    #[test]
    fn large_photos_stay_within_the_budget() {
        // The review case: 4000x3000 photos, one per row at 2x, the largest tile there is.
        let (width, height) = grid_tile_px(CHAT_BUBBLE_MAX_PX, 3.0, 1, 4.0 / 3.0);
        let target = TargetPx::from_logical(width, height, 2.0);
        let (w, h) = cover_size(4000, 3000, target);
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

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::new_rgba8(width, height)
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .expect("encode png");
        bytes
    }

    #[test]
    fn decode_scales_to_the_target() {
        let target = TargetPx {
            width: 160,
            height: 120,
        };
        let thumb = decode_thumbnail(&png(1600, 1200), target).expect("decodes");
        assert_eq!(thumb.pixels.dimensions(), (160, 120));
        assert_eq!(thumb.byte_len(), 160 * 120 * 4);
        assert!((thumb.aspect.unwrap_or_default() - 4.0 / 3.0).abs() < 1e-4);
        assert!(decode_thumbnail(&[1, 2, 3], target).is_none());
    }

    #[test]
    fn only_static_raster_formats_are_thumbnailed() {
        assert!(thumbnail_supported("image/png"));
        assert!(thumbnail_supported("IMAGE/JPEG"));
        assert!(thumbnail_supported("image/webp"));
        assert!(!thumbnail_supported("image/gif"));
        assert!(!thumbnail_supported("image/svg+xml"));
    }
}
