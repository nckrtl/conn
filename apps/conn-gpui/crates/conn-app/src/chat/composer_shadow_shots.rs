//! Offscreen renders and pixel checks of the composer card's shadow falloff.
//!
//! A dark shadow over a dark background spans only a few 8-bit grey levels. Without dithering
//! each level shows as a solid band. These checks sample one pixel row out from the card's left
//! edge, through the falloff, and measure the bands.

use std::path::Path;

use gpui_kit::{AnyWindowHandle, HeadlessAppContext};
use image::RgbaImage;

use super::card_shots::{bounds_of, open_thread_scene, settle};
use super::left_align_shots::queued_thread;
use super::picker_settings_shots::headless_context;

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;
const THEMES: [(&str, &str); 2] = [("dark-ocean", "dark"), ("t3-code-light", "light")];
/// How far out from the card edge the falloff is sampled, in points: up to the sidebar border
/// in the 1100pt test window.
const FALLOFF_PT: f32 = 46.0;
/// Rows sampled above and below the card's middle; a column is flat when all of them match.
const WINDOW_ROWS: u32 = 8;
/// The widest solid band the falloff may have, in device pixels. Undithered, a dark-mode band is
/// 20 to 40 device pixels wide; dithered, flat columns stay isolated.
const MAX_BAND_PX: usize = 4;

/// The measured falloff, from the card edge outward.
#[derive(Debug)]
struct Falloff {
    /// Green values along the card's middle row, card edge first.
    middle: Vec<u8>,
    /// Distinct green levels in the sampled window.
    levels: usize,
    /// Solid bands: runs of 4+ adjacent flat columns with one value. Each reads as a step.
    bands: usize,
    /// The widest run of adjacent flat columns with one value.
    widest_band: usize,
}

impl Falloff {
    /// Measures `columns`, each the green values of one column across the window, card edge first.
    fn measure(columns: &[Vec<u8>]) -> Self {
        let mut levels: Vec<u8> = columns.iter().flatten().copied().collect();
        levels.sort_unstable();
        levels.dedup();
        // The value of each flat column, or `None` where the dither varies it.
        let flat: Vec<Option<u8>> = columns
            .iter()
            .map(|c| c.iter().all(|v| *v == c[0]).then(|| c[0]))
            .collect();
        let mut runs = Vec::new();
        let mut run = 0;
        for (i, value) in flat.iter().enumerate() {
            match value {
                Some(v) if i > 0 && flat[i - 1] == Some(*v) => run += 1,
                Some(_) => {
                    runs.push(run);
                    run = 1;
                }
                None => {
                    runs.push(run);
                    run = 0;
                }
            }
        }
        runs.push(run);
        Self {
            middle: columns.iter().map(|c| c[c.len() / 2]).collect(),
            levels: levels.len(),
            bands: runs.iter().filter(|&&r| r >= 4).count(),
            widest_band: runs.iter().copied().max().unwrap_or(0),
        }
    }
}

/// Draws the composer and returns the image, its scale and the card's left edge and middle in
/// device pixels.
fn render_composer(
    ctx: &mut HeadlessAppContext,
    theme_id: &str,
) -> (AnyWindowHandle, RgbaImage, f32, u32, u32) {
    let (window, _) = open_thread_scene(ctx, theme_id, WIDTH_PX, HEIGHT_PX, queued_thread(0, 0));
    settle(ctx, window);
    let card = bounds_of(ctx, window, "Message input card");
    let image = ctx
        .capture_screenshot(window)
        .unwrap_or_else(|error| panic!("no screenshot: {error}"));
    let scale = image.width() as f32 / WIDTH_PX;
    let left = (f32::from(card.left()) * scale).round() as u32;
    let middle = (f32::from(card.top() + card.size.height / 2.0) * scale).round() as u32;
    (window, image, scale, left, middle)
}

/// The falloff left of the card around its vertical middle, card edge first.
fn falloff(image: &RgbaImage, scale: f32, left: u32, middle: u32) -> Falloff {
    let span = (FALLOFF_PT * scale).round() as u32;
    // Skip the card's 1px border and its antialiased edge.
    let start = left.saturating_sub(2);
    let columns: Vec<Vec<u8>> = (0..span)
        .map(|i| {
            (middle - WINDOW_ROWS..middle + WINDOW_ROWS)
                .map(|y| image.get_pixel(start.saturating_sub(i), y)[1])
                .collect()
        })
        .collect();
    Falloff::measure(&columns)
}

/// Saves the card's left edge and falloff 8x zoomed, as-is and contrast-stretched so each grey
/// level reads as its own shade.
fn save_crops(image: &RgbaImage, scale: f32, left: u32, middle: u32, dir: &Path, name: &str) {
    let span = (FALLOFF_PT * scale).round() as u32;
    let x = left.saturating_sub(span);
    let half = span / 2;
    let crop = image::imageops::crop_imm(image, x, middle - half, span + 16, half * 2).to_image();
    let zoom = |img: &RgbaImage| {
        image::imageops::resize(
            img,
            img.width() * 8,
            img.height() * 8,
            image::imageops::FilterType::Nearest,
        )
    };
    zoom(&crop)
        .save(dir.join(format!("{name}.png")))
        .unwrap_or_else(|error| panic!("no PNG: {error}"));
    // Stretch the falloff's range (left of the card) to the full 0..255 range.
    let (lo, hi) = crop
        .enumerate_pixels()
        .filter(|(px, _, _)| *px < span)
        .fold((255u8, 0u8), |(lo, hi), (_, _, p)| {
            (lo.min(p[1]), hi.max(p[1]))
        });
    let range = f32::from(hi.saturating_sub(lo).max(1));
    let mut stretched = crop;
    for p in stretched.pixels_mut() {
        for c in 0..3 {
            let v = (f32::from(p[c].saturating_sub(lo)) / range * 255.0).min(255.0);
            p[c] = v as u8;
        }
    }
    zoom(&stretched)
        .save(dir.join(format!("{name}-stretched.png")))
        .unwrap_or_else(|error| panic!("no PNG: {error}"));
}

/// Renders the composer's shadow falloff in dark and light, saves zoomed crops and prints the
/// band counts.
///
/// `CONN_SHADOW_SHOTS_DIR=<dir> CONN_SHADOW_SHOTS_PREFIX=after cargo test -p conn-app
/// render_composer_shadow_screenshots -- --ignored --nocapture`
#[test]
#[ignore = "writes PNGs; set CONN_SHADOW_SHOTS_DIR"]
fn render_composer_shadow_screenshots() {
    let Some(dir) = std::env::var_os("CONN_SHADOW_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap_or_else(|error| panic!("no output folder: {error}"));
    let prefix = std::env::var("CONN_SHADOW_SHOTS_PREFIX").unwrap_or_else(|_| "after".to_owned());
    let mut ctx = headless_context();
    for (theme_id, theme) in THEMES {
        let (_, image, scale, left, middle) = render_composer(&mut ctx, theme_id);
        let name = format!("{prefix}-gpui-{theme}");
        save_crops(&image, scale, left, middle, dir, &name);
        let f = falloff(&image, scale, left, middle);
        println!(
            "{name}: levels={} bands={} widest_band={}px scale={scale}\n  middle row green: {:?}",
            f.levels, f.bands, f.widest_band, f.middle
        );
    }
}

/// The shadow falloff has no solid bands: no run of flat columns is wide enough to read as a
/// step, in dark or light.
#[test]
fn the_composer_shadow_falloff_has_no_solid_bands() {
    let mut ctx = headless_context();
    for (theme_id, theme) in THEMES {
        let (_, image, scale, left, middle) = render_composer(&mut ctx, theme_id);
        let f = falloff(&image, scale, left, middle);
        // The falloff starts darker than where it ends: the shadow is there at all.
        let first = f.middle.first().copied().unwrap_or(0);
        let last = f.middle.last().copied().unwrap_or(0);
        assert!(
            first < last,
            "{theme}: no shadow at the card edge ({first} vs {last})"
        );
        assert!(
            f.widest_band <= MAX_BAND_PX,
            "{theme}: a {}px solid band in the shadow falloff ({} bands, {} levels)",
            f.widest_band,
            f.bands,
            f.levels
        );
    }
}
