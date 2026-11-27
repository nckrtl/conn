//! The desktop's image codec for `conn_client::uploads` (iPhone uses ImageIO): the core picks
//! the size and keeps the smaller encoding.

use std::io::Cursor;

use conn_client::uploads::{Encoded, ImageCodec, ImageInfo};
use image::{
    DynamicImage, ImageDecoder, ImageEncoder, ImageReader,
    codecs::{
        jpeg::JpegEncoder,
        png::{self, PngEncoder},
    },
    imageops::FilterType,
    metadata::Orientation,
};

pub(crate) struct DesktopImageCodec;

fn decode(bytes: &[u8]) -> Option<DynamicImage> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    Some(image)
}

/// macOS screenshots are often RGBA with every pixel opaque; only real transparency counts.
fn transparent(image: &DynamicImage) -> bool {
    image.color().has_alpha() && image.to_rgba8().pixels().any(|p| p.0[3] != u8::MAX)
}

impl ImageCodec for DesktopImageCodec {
    fn inspect(&self, bytes: &[u8]) -> Option<ImageInfo> {
        let image = decode(bytes)?;
        Some(ImageInfo {
            width: image.width(),
            height: image.height(),
            alpha: transparent(&image),
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
        let mut image = decode(bytes)?;
        if (image.width(), image.height()) != (width, height) {
            // Triangle widens with the scale, so a large reduction still averages every pixel.
            image = image.resize_exact(width, height, FilterType::Triangle);
        }
        let alpha = transparent(&image);
        let jpeg = jpeg_quality.and_then(|quality| {
            let mut out = Vec::new();
            let quality = (quality.clamp(0.0, 1.0) * 100.0).round() as u8;
            JpegEncoder::new_with_quality(&mut out, quality)
                .encode_image(&image.to_rgb8())
                .ok()?;
            Some(out)
        });
        let png = png
            .then(|| {
                let mut out = Vec::new();
                let encoder = PngEncoder::new_with_quality(
                    &mut out,
                    png::CompressionType::Default,
                    png::FilterType::Adaptive,
                );
                let written = if alpha {
                    let rgba = image.to_rgba8();
                    encoder.write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
                } else {
                    let rgb = image.to_rgb8();
                    encoder.write_image(&rgb, width, height, image::ExtendedColorType::Rgb8)
                };
                written.ok().map(|()| out)
            })
            .flatten();
        Some(Encoded { jpeg, png })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_client::uploads::prepare;

    fn png_bytes(image: &DynamicImage) -> Vec<u8> {
        let mut out = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode fixture");
        out
    }

    #[test]
    fn opaque_rgba_screenshots_can_become_jpeg_and_large_ones_shrink() {
        // A noisy 3000×2000 RGBA image with no transparency: a photo saved as PNG.
        let noisy = image::RgbaImage::from_fn(3000, 2000, |x, y| {
            let v = ((x * 31 + y * 17) ^ (x * y)) as u8;
            image::Rgba([v, v.wrapping_mul(3), v.wrapping_add(90), 255])
        });
        let bytes = png_bytes(&DynamicImage::ImageRgba8(noisy));
        let info = DesktopImageCodec.inspect(&bytes).expect("inspect");
        assert!(!info.alpha, "opaque RGBA is not transparent");
        let out = prepare(
            "photo.png",
            "image/png",
            bytes.clone(),
            Some(&DesktopImageCodec),
        );
        assert_eq!(out.mime_type, "image/jpeg");
        assert!(
            out.bytes.len() < bytes.len() / 4,
            "{} vs {}",
            out.bytes.len(),
            bytes.len()
        );
        let decoded = image::load_from_memory(&out.bytes).expect("decode");
        assert_eq!((decoded.width(), decoded.height()), (2371, 1581));
    }

    #[test]
    fn transparency_stays_png() {
        let logo = image::RgbaImage::from_fn(64, 64, |x, _| {
            image::Rgba([0, 0, 0, if x < 32 { 0 } else { 255 }])
        });
        let bytes = png_bytes(&DynamicImage::ImageRgba8(logo));
        let out = prepare("logo.png", "image/png", bytes, Some(&DesktopImageCodec));
        assert_eq!(out.mime_type, "image/png");
        assert!(
            image::load_from_memory(&out.bytes)
                .expect("decode")
                .color()
                .has_alpha()
        );
    }
}
