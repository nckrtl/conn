//! Viewport-level placement of a menu's submenu beside the row that opens it.
//!
//! A submenu laid out inside its parent menu is clipped by the window edge, and any flip
//! decision made before layout reads the pointer, not the row, so the parent menu's own snap to
//! the window leaves the guess wrong. [`placed_submenu`] draws the submenu in the window layer
//! and places it from the trigger row's real bounds and the real viewport at prepaint.

use gpui_kit::{
    AnyElement, App, Bounds, Edges, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, Position, Size, Style, Window, point, px,
};

/// Space kept between a submenu and the window edge, like the parent menu's own snap margin.
pub(crate) const SUBMENU_VIEWPORT_MARGIN_PX: f32 = 8.0;
/// Space between the parent menu's surface and the submenu's.
const SUBMENU_GAP_PX: f32 = 2.0;
/// From a row's edge to its menu surface's outer edge: `p-1` plus the 1px border.
pub(crate) const MENU_SURFACE_INSET_PX: f32 = 5.0;

/// Where a submenu of `size` goes for the trigger row `trigger` in a window of `viewport`.
///
/// It opens to the right of the parent menu and flips to the left when the right side clips.
/// Vertically its first row sits level with the trigger row. When it would run past the bottom
/// it aligns its last row with the trigger instead, then slides inside the window.
#[must_use]
pub(crate) fn place_submenu(
    trigger: Bounds<Pixels>,
    size: Size<Pixels>,
    viewport: Size<Pixels>,
) -> Bounds<Pixels> {
    let margin = px(SUBMENU_VIEWPORT_MARGIN_PX);
    let reach = px(MENU_SURFACE_INSET_PX + SUBMENU_GAP_PX);

    let right_x = trigger.right() + reach;
    let left_x = trigger.left() - reach - size.width;
    let fits_right = right_x + size.width <= viewport.width - margin;
    let fits_left = left_x >= margin;
    let x = if fits_right {
        right_x
    } else if fits_left {
        left_x
    } else if viewport.width - trigger.right() >= trigger.left() {
        right_x
    } else {
        left_x
    };

    let inset = px(MENU_SURFACE_INSET_PX);
    let mut y = trigger.top() - inset;
    if y + size.height > viewport.height - margin {
        y = trigger.bottom() + inset - size.height;
    }

    Bounds {
        origin: point(
            slide_into(x, size.width, viewport.width, margin),
            slide_into(y, size.height, viewport.height, margin),
        ),
        size,
    }
}

/// `start` moved to keep `length` inside `extent` with `margin` to spare. Content longer than
/// the room starts at the margin.
fn slide_into(start: Pixels, length: Pixels, extent: Pixels, margin: Pixels) -> Pixels {
    let last_start = extent - margin - length;
    if last_start < margin || start < margin {
        margin
    } else if start > last_start {
        last_start
    } else {
        start
    }
}

/// Wraps `child`, an absolutely positioned submenu, so it draws in the window layer next to the
/// row it is a child of. The row must be a positioned (`relative`) ancestor.
pub(crate) fn placed_submenu(child: impl IntoElement) -> gpui_kit::Deferred {
    gpui_kit::deferred(SubmenuPlacement {
        child: child.into_any_element(),
    })
}

struct SubmenuPlacement {
    child: AnyElement,
}

impl Element for SubmenuPlacement {
    /// The layout of the child, which the placement measures at prepaint.
    type RequestLayoutState = LayoutId;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let child = self.child.request_layout(window, cx);
        // Covers the trigger row exactly, so the prepaint bounds are the row's bounds.
        let cover = Style {
            position: Position::Absolute,
            inset: Edges::all(px(0.0).into()),
            ..Style::default()
        };
        (window.request_layout(cover, [child], cx), child)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        trigger: Bounds<Pixels>,
        child: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let laid_out = window.layout_bounds(*child);
        let placed = place_submenu(trigger, laid_out.size, window.viewport_size());
        let shift: Point<Pixels> = placed.origin - laid_out.origin;
        let shift = point(shift.x.round(), shift.y.round());
        window.with_element_offset(shift, |window| self.child.prepaint(window, cx));
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _child: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}

impl IntoElement for SubmenuPlacement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::size;

    const VIEW: fn() -> Size<Pixels> = || size(px(1440.0), px(900.0));

    fn row(x: f32, y: f32) -> Bounds<Pixels> {
        Bounds {
            origin: point(px(x), px(y)),
            size: size(px(170.0), px(28.0)),
        }
    }

    fn inside(bounds: Bounds<Pixels>) -> bool {
        let m = px(SUBMENU_VIEWPORT_MARGIN_PX);
        bounds.left() >= m
            && bounds.top() >= m
            && bounds.right() <= VIEW().width - m
            && bounds.bottom() <= VIEW().height - m
    }

    #[test]
    fn opens_right_and_level_with_the_row_when_there_is_room() {
        let menu = size(px(180.0), px(122.0));
        let placed = place_submenu(row(100.0, 300.0), menu, VIEW());
        assert_eq!(placed.left(), px(100.0 + 170.0 + 7.0));
        assert_eq!(
            placed.top(),
            px(295.0),
            "first row sits level with the trigger"
        );
    }

    #[test]
    fn flips_left_at_the_right_edge_without_covering_the_parent() {
        let menu = size(px(180.0), px(122.0));
        let trigger = row(1200.0, 300.0);
        let placed = place_submenu(trigger, menu, VIEW());
        assert!(
            placed.right() < trigger.left(),
            "left of the parent menu: {placed:?}"
        );
        assert!(inside(placed));
    }

    #[test]
    fn aligns_to_the_row_bottom_near_the_bottom_edge() {
        let menu = size(px(180.0), px(122.0));
        let trigger = row(100.0, 800.0);
        let placed = place_submenu(trigger, menu, VIEW());
        assert_eq!(
            placed.bottom(),
            trigger.bottom() + px(MENU_SURFACE_INSET_PX)
        );
        assert!(inside(placed));
    }

    #[test]
    fn slides_inside_when_the_row_is_at_the_very_bottom() {
        let menu = size(px(180.0), px(122.0));
        let placed = place_submenu(row(1260.0, 880.0), menu, VIEW());
        assert!(inside(placed), "{placed:?}");
    }

    #[test]
    fn a_submenu_taller_than_the_window_starts_at_the_margin() {
        let menu = size(px(180.0), px(2000.0));
        let placed = place_submenu(row(100.0, 300.0), menu, VIEW());
        assert_eq!(placed.top(), px(SUBMENU_VIEWPORT_MARGIN_PX));
    }

    #[test]
    fn a_window_too_narrow_for_both_sides_still_keeps_the_submenu_inside() {
        let menu = size(px(180.0), px(122.0));
        let narrow = size(px(300.0), px(900.0));
        let placed = place_submenu(row(60.0, 300.0), menu, narrow);
        assert!(placed.left() >= px(SUBMENU_VIEWPORT_MARGIN_PX));
        assert!(placed.right() <= narrow.width - px(SUBMENU_VIEWPORT_MARGIN_PX));
    }
}
