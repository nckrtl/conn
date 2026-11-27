//! Offscreen renders and pixel checks of the queue tray's rows and icon buttons.
//!
//! The pixel checks find the visible ink of each row's text and icons in a headless render, and
//! measure it against the row's band: from the tray's top border (or the hairline above) down to
//! the hairline below (or the composer's top edge, for the last row).

use std::path::Path;

use gpui_kit::test::{TestEventExt as _, TestQueryExt as _};
use gpui_kit::{AnyWindowHandle, Bounds, HeadlessAppContext, MouseButton, Pixels, point, px};
use image::RgbaImage;

use super::card_shots::{bounds_of, hover, open_thread_scene, settle};
use super::left_align_shots::queued_thread;
use super::picker_settings_shots::headless_context;

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 720.0;
const THEMES: [(&str, &str); 2] = [("dark-ocean", "dark"), ("t3-code-light", "light")];
const STEER_LABEL: &str = "Steer";
const REMOVE_LABEL: &str = "Remove queued message";
const MORE_LABEL: &str = "More actions for queued message";
/// A pixel is ink when it differs from the row's fill by more than this on some channel.
const INK_THRESHOLD: i32 = 40;

/// The bounds of every element labelled `label`, top to bottom.
fn all_bounds(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    label: &str,
) -> Vec<Bounds<Pixels>> {
    let mut found: Vec<Bounds<Pixels>> = ctx
        .update_window(window, |_, w, _| {
            w.elements()
                .iter()
                .filter(|element| element.label().is_some_and(|l| l == label))
                .map(|element| element.bounds())
                .collect()
        })
        .unwrap_or_else(|error| panic!("no window: {error}"));
    found.sort_by(|a, b| f32::from(a.top()).total_cmp(&f32::from(b.top())));
    found
}

/// The queued rows' bounds, top to bottom.
fn row_bounds(ctx: &mut HeadlessAppContext, window: AnyWindowHandle) -> Vec<Bounds<Pixels>> {
    let mut rows: Vec<Bounds<Pixels>> = ctx
        .update_window(window, |_, w, _| {
            w.elements()
                .iter()
                .filter(|element| {
                    element
                        .label()
                        .is_some_and(|l| l.to_string().starts_with("Queued message "))
                })
                .map(|element| element.bounds())
                .collect()
        })
        .unwrap_or_else(|error| panic!("no window: {error}"));
    rows.sort_by(|a, b| f32::from(a.top()).total_cmp(&f32::from(b.top())));
    rows
}

/// The rows (top, bottom, in points) of the ink in the columns `x_from..x_to` (points) between
/// `y_from` and `y_to` (points). Ink is every pixel that differs from the row's fill, sampled on
/// the same pixel row at `fill_x`.
fn ink_extent(
    image: &RgbaImage,
    scale: f32,
    (x_from, x_to): (f32, f32),
    (y_from, y_to): (f32, f32),
    fill_x: f32,
) -> Option<(f32, f32)> {
    let dev = |points: f32| (points * scale).round() as u32;
    let (mut top, mut bottom) = (u32::MAX, 0);
    for y in dev(y_from)..dev(y_to) {
        let fill = image.get_pixel(dev(fill_x), y);
        let ink = (dev(x_from)..dev(x_to)).any(|x| {
            let p = image.get_pixel(x, y);
            (0..3).any(|c| (i32::from(p[c]) - i32::from(fill[c])).abs() > INK_THRESHOLD)
        });
        if ink {
            top = top.min(y);
            bottom = bottom.max(y + 1);
        }
    }
    (top != u32::MAX).then(|| (top as f32 / scale, bottom as f32 / scale))
}

/// The ⋯ button of the first row.
fn first_more_button(ctx: &mut HeadlessAppContext, window: AnyWindowHandle) -> Bounds<Pixels> {
    *all_bounds(ctx, window, MORE_LABEL)
        .first()
        .unwrap_or_else(|| panic!("a queued row has no … button"))
}

/// Saves the tray and the space around it (where the menu opens) as `<name>.png`.
fn save_tray(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, dir: &Path, name: &str) {
    let tray = bounds_of(ctx, window, "Queued messages");
    let composer = bounds_of(ctx, window, "Message input card");
    let image = ctx
        .capture_screenshot(window)
        .unwrap_or_else(|error| panic!("no screenshot: {error}"));
    let scale = image.width() as f32 / WIDTH_PX;
    let dev = |points: f32| (points * scale).round().max(0.0) as u32;
    let top = dev(f32::from(tray.top()) - 40.0);
    let bottom = dev(f32::from(composer.top()) + 130.0).min(image.height());
    let left = dev(f32::from(composer.left()) - 20.0);
    let right = image.width();
    image::imageops::crop_imm(&image, left, top, right - left, bottom - top)
        .to_image()
        .save(dir.join(format!("{name}.png")))
        .unwrap_or_else(|error| panic!("no PNG: {error}"));
}

/// Renders the tray in dark and light, with one and three rows: at rest, with the first row's ⋯
/// hovered, and with its menu open and the pointer away.
///
/// `CONN_QUEUE_SHOTS_DIR=<dir> CONN_QUEUE_SHOTS_PREFIX=after cargo test -p conn-app
/// render_queue_tray_button_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_QUEUE_SHOTS_DIR"]
fn render_queue_tray_button_screenshots() {
    let Some(dir) = std::env::var_os("CONN_QUEUE_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap_or_else(|error| panic!("no output folder: {error}"));
    let prefix = std::env::var("CONN_QUEUE_SHOTS_PREFIX").unwrap_or_else(|_| "after".to_owned());
    let mut ctx = headless_context();
    for (theme_id, theme) in THEMES {
        for count in [1, 2, 4] {
            let (window, _) = open_thread_scene(
                &mut ctx,
                theme_id,
                WIDTH_PX,
                HEIGHT_PX,
                queued_thread(count, 0),
            );
            save_tray(
                &mut ctx,
                window,
                dir,
                &format!("{prefix}-{theme}-rows-{count}"),
            );
            if count == 4 {
                continue;
            }
            let more = first_more_button(&mut ctx, window);
            hover(&mut ctx, window, more.center());
            save_tray(
                &mut ctx,
                window,
                dir,
                &format!("{prefix}-{theme}-rows-{count}-more-hover"),
            );
            ctx.update_window(window, |_, w, cx| {
                w.pointer_down(more.center(), MouseButton::Left, cx);
                w.pointer_up(more.center(), MouseButton::Left, cx);
            })
            .unwrap_or_else(|error| panic!("no window: {error}"));
            settle(&mut ctx, window);
            save_tray(
                &mut ctx,
                window,
                dir,
                &format!("{prefix}-{theme}-rows-{count}-menu-hovered"),
            );
            // The pointer leaves for the timeline; the menu stays open.
            hover(&mut ctx, window, point(px(WIDTH_PX / 2.0), px(120.0)));
            save_tray(
                &mut ctx,
                window,
                dir,
                &format!("{prefix}-{theme}-rows-{count}-menu-open"),
            );
        }
    }
}

/// Renders the hovered first of two rows in dark and light: the pointer on its text, on Steer, on
/// trash and on ⋯, then with the ⋯ menu open (pointer on ⋯, then away).
///
/// `CONN_QUEUE_SHOTS_DIR=<dir> CONN_QUEUE_SHOTS_PREFIX=after cargo test -p conn-app
/// render_queue_tray_hover_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_QUEUE_SHOTS_DIR"]
fn render_queue_tray_hover_screenshots() {
    let Some(dir) = std::env::var_os("CONN_QUEUE_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).unwrap_or_else(|error| panic!("no output folder: {error}"));
    let prefix = std::env::var("CONN_QUEUE_SHOTS_PREFIX").unwrap_or_else(|_| "after".to_owned());
    let mut ctx = headless_context();
    for (theme_id, theme) in THEMES {
        let (window, _) =
            open_thread_scene(&mut ctx, theme_id, WIDTH_PX, HEIGHT_PX, queued_thread(2, 0));
        let row = row_bounds(&mut ctx, window)[0];
        let steer = all_bounds(&mut ctx, window, STEER_LABEL)[0];
        let remove = all_bounds(&mut ctx, window, REMOVE_LABEL)[0];
        let more = first_more_button(&mut ctx, window);
        let text = point(row.left() + px(60.0), row.center().y);
        for (state, at) in [
            ("text", text),
            ("steer", steer.center()),
            ("trash", remove.center()),
            ("more", more.center()),
        ] {
            hover(&mut ctx, window, at);
            save_tray(
                &mut ctx,
                window,
                dir,
                &format!("{prefix}-{theme}-hover-{state}"),
            );
        }
        ctx.update_window(window, |_, w, cx| {
            w.pointer_down(more.center(), MouseButton::Left, cx);
            w.pointer_up(more.center(), MouseButton::Left, cx);
        })
        .unwrap_or_else(|error| panic!("no window: {error}"));
        settle(&mut ctx, window);
        save_tray(
            &mut ctx,
            window,
            dir,
            &format!("{prefix}-{theme}-menu-open-on-more"),
        );
        hover(&mut ctx, window, point(px(WIDTH_PX / 2.0), px(120.0)));
        save_tray(
            &mut ctx,
            window,
            dir,
            &format!("{prefix}-{theme}-menu-open-away"),
        );
    }
}

/// The relative luminance of a pixel.
fn luma(p: image::Rgba<u8>) -> f32 {
    0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])
}

/// In dark and light, with the pointer on a hovered row's Steer, trash or ⋯ button, the tray at
/// rest is darkest, the hovered row's band is lighter but clearly below the composer, and the
/// button under the pointer lighter still, about the composer's fill.
#[test]
fn a_hovered_button_is_lighter_than_its_hovered_row() {
    let mut ctx = headless_context();
    for (theme_id, theme) in THEMES {
        let (window, _) =
            open_thread_scene(&mut ctx, theme_id, WIDTH_PX, HEIGHT_PX, queued_thread(2, 0));
        let rows = row_bounds(&mut ctx, window);
        let composer = bounds_of(&mut ctx, window, "Message input card");
        for label in [STEER_LABEL, REMOVE_LABEL, MORE_LABEL] {
            let button = all_bounds(&mut ctx, window, label)[0];
            hover(&mut ctx, window, button.center());
            let image = ctx
                .capture_screenshot(window)
                .unwrap_or_else(|error| panic!("no screenshot: {error}"));
            let scale = image.width() as f32 / WIDTH_PX;
            let at = |x: Pixels, y: Pixels| {
                luma(*image.get_pixel(
                    (f32::from(x) * scale).round() as u32,
                    (f32::from(y) * scale).round() as u32,
                ))
            };
            // Plain fill: between the ↳ icon and the text, and inside the button's round box,
            // left of its icon.
            let tray = at(rows[1].left() + px(30.0), rows[1].center().y);
            let band = at(rows[0].left() + px(30.0), rows[0].center().y);
            let fill = at(button.left() + px(3.0), button.center().y);
            let card = at(composer.left() + px(6.0), composer.center().y);
            assert!(
                tray + 2.0 < band && band + 2.0 < fill && band + 2.0 < card && fill <= card + 4.0,
                "{theme}, {label}: tray {tray}, row {band}, button {fill}, composer {card}"
            );
        }
    }
}

/// In every row, with one to four rows, in dark and light, the visible ink of the text and of each
/// icon sits as far below the band's top as above its bottom, to within a point. The last band
/// ends at the composer's top edge, which hides the tray's tucked bottom.
#[test]
fn queued_row_text_and_icons_are_centred_in_each_band() {
    let mut ctx = headless_context();
    for (theme_id, theme) in THEMES {
        for count in 1..=4_u32 {
            let (window, _) = open_thread_scene(
                &mut ctx,
                theme_id,
                WIDTH_PX,
                HEIGHT_PX,
                queued_thread(count, 0),
            );
            let rows = row_bounds(&mut ctx, window);
            assert_eq!(rows.len(), count as usize, "{theme}: {count} rows");
            let composer = bounds_of(&mut ctx, window, "Message input card");
            let steers = all_bounds(&mut ctx, window, STEER_LABEL);
            let removes = all_bounds(&mut ctx, window, REMOVE_LABEL);
            let mores = all_bounds(&mut ctx, window, MORE_LABEL);
            let image = ctx
                .capture_screenshot(window)
                .unwrap_or_else(|error| panic!("no screenshot: {error}"));
            let scale = image.width() as f32 / WIDTH_PX;
            for (index, row) in rows.iter().enumerate() {
                let band_top = f32::from(row.top());
                let band_bottom = if index + 1 == rows.len() {
                    f32::from(composer.top())
                } else {
                    f32::from(row.bottom())
                };
                let left = f32::from(row.left());
                // The gap between the ↳ icon (12..26 in) and the text (34 in) is plain row fill.
                let fill_x = left + 30.0;
                let glyphs = [
                    ("the ↳ icon", (left + 11.0, left + 27.0)),
                    (
                        "the text",
                        (left + 33.0, f32::from(steers[index].left()) - 4.0),
                    ),
                    ("Steer", inner(steers[index])),
                    ("trash", inner(removes[index])),
                    ("…", inner(mores[index])),
                ];
                let mut gaps = Vec::new();
                for (name, columns) in glyphs {
                    let (ink_top, ink_bottom) = ink_extent(
                        &image,
                        scale,
                        columns,
                        (band_top + 0.5, band_bottom - 0.5),
                        fill_x,
                    )
                    .unwrap_or_else(|| panic!("{theme}, {count} rows, row {index}: no {name}"));
                    let above = ink_top - band_top;
                    let below = band_bottom - ink_bottom;
                    assert!(
                        (above - below).abs() <= 1.0,
                        "{theme}, {count} rows, row {index}: {name} sits {above}px below the \
                         band's top and {below}px above its bottom"
                    );
                    gaps.push((name, above, below));
                }
                eprintln!("{theme} {count} rows, row {index}: {gaps:?}");
            }
        }
    }
}

/// The first row's `…` button, measured in the layout, sits in the tray's top-right corner, and its
/// hover box's radius is the tray's radius less the button's inset on the tighter axis.
#[test]
fn the_more_button_hover_box_is_concentric_with_the_tray_corner() {
    use super::queue_tray::{ICON_BUTTON_PX, ICON_BUTTON_RADIUS_PX};
    const TRAY_RADIUS: f32 = 16.0;
    let mut ctx = headless_context();
    for count in [1, 3] {
        let (window, _) = open_thread_scene(
            &mut ctx,
            "dark-ocean",
            WIDTH_PX,
            HEIGHT_PX,
            queued_thread(count, 0),
        );
        let tray = bounds_of(&mut ctx, window, "Queued messages");
        let more = first_more_button(&mut ctx, window);
        assert!((f32::from(more.size.width) - ICON_BUTTON_PX).abs() < 0.01);
        assert!((f32::from(more.size.height) - ICON_BUTTON_PX).abs() < 0.01);
        let inset_top = f32::from(more.top() - tray.top());
        let inset_right = f32::from(tray.right() - more.right());
        let concentric = TRAY_RADIUS - inset_top.min(inset_right);
        assert!(
            (ICON_BUTTON_RADIUS_PX - concentric).abs() < 0.01,
            "{count} rows: the … button sits {inset_top}px below and {inset_right}px inside the \
             tray's corner, so its radius is {concentric}px, not {ICON_BUTTON_RADIUS_PX}px"
        );
    }
}

/// A button's columns, less a point each side, where only its icon draws.
fn inner(button: Bounds<Pixels>) -> (f32, f32) {
    (
        f32::from(button.left()) + 1.0,
        f32::from(button.right()) - 1.0,
    )
}
