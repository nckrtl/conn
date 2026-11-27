//! Images release their memory once they leave the screen: a pasted image's chip keeps a
//! chip-sized thumbnail, not the decoded picture; removing the chip frees it and its window
//! texture; a parked draft keeps its chips.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};

use super::{kitchen_sink_shell, kitchen_sink_thread, mount_app};

/// A `width`×`height` PNG; `seed` makes the bytes distinct.
fn png(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let picture = image::RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba([x as u8, y as u8, seed, 255])
    });
    let mut bytes = Vec::new();
    picture
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode PNG");
    bytes
}

#[gpui_kit::test]
fn a_pasted_image_keeps_a_chip_sized_thumbnail_that_goes_with_its_chip(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (window, app) = mount_app(cx);
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-pinned".into(), kitchen_sink_thread(), cx);
        })
    });
    frames(cx);
    let composer = cx.read(|cx| app.read(cx).chat_for_test().read(cx).composer_for_test());
    let stage = |cx: &mut TestAppContext, seed: u8| {
        cx.update_window(window, |_, window, cx| {
            composer.update(cx, |composer, cx| {
                composer.stage_image_for_test(
                    "shot.png",
                    "image/png",
                    png(1920, 1080, seed),
                    window,
                    cx,
                )
            })
        })
        .expect("window")
    };
    let kept = stage(cx, 1);
    let removed = stage(cx, 2);
    // The decode runs off the UI thread.
    for _ in 0..200 {
        frames(cx);
        if cx.read(|cx| composer.read(cx).attachment_previews_for_test()) == (2, 2) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        cx.read(|cx| composer.read(cx).attachment_previews_for_test()),
        (2, 2),
        "both thumbnails decoded"
    );
    let thumb = cx
        .read(|cx| composer.read(cx).attachment_preview_image_for_test(removed))
        .expect("a thumbnail");
    let size = thumb.size(0);
    let scale = cx
        .update_window(window, |_, window, _| window.scale_factor())
        .expect("window");
    let chip_px = (64.0 * scale.max(1.0)).ceil() as i32;
    assert!(
        size.width.0 <= chip_px && size.height.0 <= chip_px,
        "a chip keeps chip-sized pixels, not the 1920×1080 picture: {size:?}"
    );
    let painted = cx
        .update_window(window, |_, window, _| window.has_image_atlas_entry(&thumb))
        .expect("window");
    assert!(painted, "the chip painted its thumbnail");

    cx.update(|cx| {
        composer.update(cx, |composer, cx| {
            composer.remove_attachment_for_test(removed, cx)
        })
    });
    frames(cx);
    assert_eq!(
        cx.read(|cx| composer.read(cx).attachment_previews_for_test()),
        (1, 1)
    );
    let still_in_atlas = cx
        .update_window(window, |_, window, _| window.has_image_atlas_entry(&thumb))
        .expect("window");
    assert!(!still_in_atlas, "the removed chip's texture left the atlas");

    // Another thread shows: the draft and its chip are parked, not freed.
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-failed", cx)));
    frames(cx);
    assert_eq!(
        cx.read(|cx| composer.read(cx).attachment_previews_for_test()),
        (1, 1),
        "a parked draft keeps its chip"
    );
    cx.update(|cx| app.update(cx, |app, cx| app.select_thread("thread-pinned", cx)));
    frames(cx);
    assert!(
        cx.read(|cx| composer.read(cx).attachment_preview_image_for_test(kept))
            .is_some(),
        "back on the thread, the chip shows at once"
    );
}
