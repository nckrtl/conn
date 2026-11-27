//! Headless layout checks for the composer's model picker: the first model row lines up with the
//! first provider tile, and the rail tiles are concentric with the shell.

use gpui_kit::test::TestQueryExt as _;
use image::RgbaImage;

use super::super::picker_settings_shots::{config, headless_context, open_picker};
use super::model_picker::{
    RAIL_TILE_RADIUS_PX, SEARCH_ROW_HEIGHT_PX, SHELL_INSET_PX, SHELL_RADIUS_PX,
};

/// Pixels of the glyph differ from the tile or row fill by more than this on some channel.
const INK_THRESHOLD: i32 = 40;

/// Vertical centre, in points, of the glyph in the columns `x_from..x_to` (points) and rows
/// `y_from..y_to` (points) of `image`. The glyph is every pixel that differs from the fill three
/// points left of the columns. Returns `None` when no pixel differs.
fn glyph_center_y(
    image: &RgbaImage,
    scale: f32,
    (x_from, x_to): (f32, f32),
    (y_from, y_to): (f32, f32),
) -> Option<f32> {
    let px = |points: f32| (points * scale).round() as u32;
    let (mut top, mut bottom) = (u32::MAX, 0);
    for y in px(y_from)..px(y_to) {
        let fill = image.get_pixel(px(x_from - 3.0), y);
        let ink = (px(x_from)..px(x_to)).any(|x| {
            let p = image.get_pixel(x, y);
            (0..3).any(|c| (i32::from(p[c]) - i32::from(fill[c])).abs() > INK_THRESHOLD)
        });
        if ink {
            top = top.min(y);
            bottom = bottom.max(y + 1);
        }
    }
    (top != u32::MAX).then(|| (top + bottom) as f32 / 2.0 / scale)
}

/// The first model row's icon sits on the first provider tile's icon centre, in dark and light,
/// to within a point. Both icons are the first provider's glyph at the same size.
#[test]
fn first_model_row_icon_lines_up_with_first_provider_icon() {
    let config = config();
    let catalog = config.catalog();
    let first = catalog
        .picker_providers()
        .next()
        .expect("the fixture has a provider");
    let model = catalog
        .filtered_models(Some(first.instance_id.as_str()), "")
        .first()
        .cloned()
        .expect("the first provider has a model");

    let mut ctx = headless_context();
    for theme_id in ["dark-ocean", "t3-code-light"] {
        let window = open_picker(
            &mut ctx,
            theme_id,
            &first.instance_id,
            &first.driver,
            &model.slug,
        );
        // Only the search input is observable, so the shell's top-left corner is found from it:
        // the input starts 80 right of the shell (border 1, inset 3, rail 40, inset 3, panel
        // border 1, search padding 10, icon 14, gap 8) and is centred in the search row, whose
        // top is 5 below the shell.
        let input = ctx
            .update_window(window, |_, w, _| {
                w.find_by_label("Search models...").bounds()
            })
            .expect("the picker is open");
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        let scale = image.width() as f32 / super::super::picker_settings_shots::WIDTH_PX;
        let left = f32::from(input.origin.x) - 80.0;
        let top = f32::from(input.center().y) - 5.0 - (SEARCH_ROW_HEIGHT_PX - 1.0) / 2.0;

        // Rail: border 1, shell inset 3, tile padding 2 and glyph inset 10 to the glyph; the
        // favorites tile and the gap come first, so the first provider tile spans 45..81. The
        // window stays clear of the ★ tile above and the second tile below.
        let tile = glyph_center_y(
            &image,
            scale,
            (left + 16.0, left + 32.0),
            (top + 43.0, top + 83.0),
        )
        .expect("the first provider's glyph is drawn in the rail");
        // List: the model column starts at 48, and the list pads 6 and the row 8 more to the
        // glyph. The window clears the search icon above and the second row below.
        let row = glyph_center_y(
            &image,
            scale,
            (left + 62.0, left + 78.0),
            (top + 40.0, top + 88.0),
        )
        .expect("the first model's glyph is drawn in the list");

        assert!(
            (tile - row).abs() <= 1.0,
            "{theme_id}: first provider icon centre {tile} vs first model icon centre {row}"
        );
    }
}

/// A rail tile's radius is the shell radius minus the inset between the shell and the tile, as
/// the panel's is.
#[test]
fn rail_tiles_are_concentric_with_the_shell() {
    assert_eq!(SHELL_RADIUS_PX, 12.0);
    assert_eq!(SHELL_INSET_PX, 3.0);
    // 12 - (3 inset + 1 rail padding on the tighter axis).
    assert_eq!(
        RAIL_TILE_RADIUS_PX,
        SHELL_RADIUS_PX - (SHELL_INSET_PX + 1.0)
    );
    assert_eq!(RAIL_TILE_RADIUS_PX, 8.0);
}
