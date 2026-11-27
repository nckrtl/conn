//! The pixel work between a decoded picture and the downscaled copy a client keeps.
//!
//! It lives here, not in the app, for speed: `image`'s resize is generic, so it compiles in
//! the crate that calls it. An app built without optimizations (a dev or hot-patch build) took
//! about 900 ms to fit one 2880×1800 screenshot; this crate builds optimized as a dependency.

use image::RgbaImage;
use image::imageops::FilterType;

/// The `(x, y, width, height)` part of `picture`, scaled to `width`×`height` with a triangle
/// filter. A region that is already that size is only copied.
pub fn crop_resize(
    picture: &RgbaImage,
    region: (u32, u32, u32, u32),
    size: (u32, u32),
) -> RgbaImage {
    let (x, y, width, height) = region;
    let cropped = image::imageops::crop_imm(picture, x, y, width, height);
    if size == (width, height) {
        cropped.to_image()
    } else {
        image::imageops::resize(&*cropped, size.0, size.1, FilterType::Triangle)
    }
}

/// Swaps the first and third channel of every pixel: RGBA to BGRA and back.
pub fn swap_red_blue(pixels: &mut RgbaImage) {
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_resize_scales_the_region() {
        let picture = RgbaImage::from_fn(8, 4, |x, _| image::Rgba([x as u8, 0, 0, 255]));
        let out = crop_resize(&picture, (4, 0, 4, 4), (2, 2));
        assert_eq!(out.dimensions(), (2, 2));
        assert!(out.get_pixel(0, 0)[0] >= 4, "the right half was kept");
        let copy = crop_resize(&picture, (0, 0, 8, 4), (8, 4));
        assert_eq!(copy, picture);
    }

    #[test]
    fn swap_red_blue_swaps_channels() {
        let mut pixels = RgbaImage::from_pixel(1, 1, image::Rgba([1, 2, 3, 4]));
        swap_red_blue(&mut pixels);
        assert_eq!(pixels.get_pixel(0, 0).0, [3, 2, 1, 4]);
    }
}
