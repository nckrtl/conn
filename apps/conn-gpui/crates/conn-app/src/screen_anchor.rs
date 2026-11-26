//! Where the browser's page area sits on screen, for Vault's passkey panel.
//!
//! GPUI lays the page area out in the window's own coordinates: logical pixels, which are
//! points, with the origin at the top-left of the window's content view. Vault wants AppKit
//! screen coordinates: points, with the origin at the bottom-left of the primary display and
//! `y` growing upward. This module converts one to the other.
//!
//! Retina scale plays no part. GPUI's logical pixel and AppKit's point are the same length; the
//! scale factor only relates them to device pixels, which neither side uses here. Multiplying by
//! it would put the panel at the wrong place on every Retina display.

use conn_desktop::vault::PasskeyAnchor;

/// A rect in AppKit screen coordinates (points, origin bottom-left, `y` up).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The page area `(x, y, width, height)` in the content view's points (origin top-left), placed
/// on screen. `view` is the content view's own rect in AppKit screen coordinates.
///
/// The page is clipped to the view, because a page area outside its window has no place to
/// show a panel. `None` when nothing is left, or when a number is not finite.
pub(crate) fn page_on_screen(
    view: ScreenRect,
    page: (f32, f32, f32, f32),
) -> Option<PasskeyAnchor> {
    let (px, py, pw, ph) = (
        f64::from(page.0),
        f64::from(page.1),
        f64::from(page.2),
        f64::from(page.3),
    );
    let finite = [view.x, view.y, view.width, view.height, px, py, pw, ph]
        .iter()
        .all(|value| value.is_finite());
    if !finite {
        return None;
    }
    // Clip to the view, still in the view's top-left space.
    let left = px.max(0.0);
    let top = py.max(0.0);
    let right = (px + pw).min(view.width);
    let bottom = (py + ph).min(view.height);
    if right <= left || bottom <= top {
        return None;
    }
    // The view's top edge is `view.y + view.height` on screen. Going down by `bottom` lands on
    // the page's bottom edge, which is its AppKit `y`.
    PasskeyAnchor::new(
        view.x + left,
        view.y + view.height - bottom,
        right - left,
        bottom - top,
    )
}

/// The window's content view in AppKit screen coordinates, read from the native window.
#[cfg(target_os = "macos")]
pub(crate) fn content_view_on_screen(window: &gpui_kit::Window) -> Option<ScreenRect> {
    use objc2::runtime::AnyObject;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsRect {
        origin: NsPoint,
        size: NsSize,
    }
    // SAFETY: `NsPoint` matches AppKit `NSPoint` (`CGPoint`: two f64s).
    unsafe impl objc2::Encode for NsPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: `NsSize` matches AppKit `NSSize` (`CGSize`: two f64s).
    unsafe impl objc2::Encode for NsSize {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: `NsRect` matches AppKit `NSRect` (`CGRect`: `CGPoint` + `CGSize`).
    unsafe impl objc2::Encode for NsRect {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGRect", &[NsPoint::ENCODING, NsSize::ENCODING]);
    }

    let handle = HasWindowHandle::window_handle(window).ok()?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return None;
    };
    // SAFETY: Called on the AppKit main thread inside a window update, with the window's live
    // `NSView` from GPUI. Every selector is a documented `NSView` or `NSWindow` method:
    // `window`, `bounds`, `convertRect:toView:` (nil means window base coordinates) and
    // `convertRectToScreen:`, which returns a rect with a bottom-left origin whatever the
    // view's `isFlipped` says.
    let rect: NsRect = unsafe {
        let view: &AnyObject = handle.ns_view.cast::<AnyObject>().as_ref();
        let ns_window: Option<objc2::rc::Retained<AnyObject>> = objc2::msg_send![view, window];
        let ns_window = ns_window?;
        let bounds: NsRect = objc2::msg_send![view, bounds];
        let nil: *mut AnyObject = std::ptr::null_mut();
        let in_window: NsRect = objc2::msg_send![view, convertRect: bounds, toView: nil];
        objc2::msg_send![&*ns_window, convertRectToScreen: in_window]
    };
    Some(ScreenRect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn content_view_on_screen(_window: &gpui_kit::Window) -> Option<ScreenRect> {
    None
}

/// The page area on screen, for a passkey request. `None` when the window cannot say.
pub(crate) fn page_anchor(
    window: &gpui_kit::Window,
    page: (f32, f32, f32, f32),
) -> Option<PasskeyAnchor> {
    page_on_screen(content_view_on_screen(window)?, page)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(x: f64, y: f64, width: f64, height: f64) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn anchor(x: f64, y: f64, width: f64, height: f64) -> Option<PasskeyAnchor> {
        PasskeyAnchor::new(x, y, width, height)
    }

    #[test]
    fn page_below_the_toolbar_flips_to_a_bottom_left_origin() {
        // A 1100x720 window whose bottom-left corner is at (200, 100) on the primary display.
        // The page starts 52 points down, under the toolbar, and fills the rest.
        let on_screen = page_on_screen(
            view(200.0, 100.0, 1100.0, 720.0),
            (0.0, 52.0, 1100.0, 668.0),
        );
        // Its bottom edge is the window's bottom edge, and its top edge is 52 points below the
        // window's top: 100 + 720 - 52 = 768.
        assert_eq!(on_screen, anchor(200.0, 100.0, 1100.0, 668.0));
        let page = on_screen.expect("a page on screen");
        assert!((page.y + page.height - 768.0).abs() < f64::EPSILON);
    }

    #[test]
    fn page_inside_the_view_keeps_its_offsets() {
        // A page inset by a sidebar (240 left) and a toolbar (52 top), with a 30-point panel below.
        let on_screen = page_on_screen(view(0.0, 0.0, 1500.0, 900.0), (240.0, 52.0, 1260.0, 818.0));
        assert_eq!(on_screen, anchor(240.0, 30.0, 1260.0, 818.0));
    }

    #[test]
    fn a_second_display_keeps_its_negative_coordinates() {
        // A display to the left of and below the primary one.
        let on_screen = page_on_screen(
            view(-1920.0, -400.0, 1920.0, 1080.0),
            (0.0, 52.0, 1920.0, 1028.0),
        );
        assert_eq!(on_screen, anchor(-1920.0, -400.0, 1920.0, 1028.0));
    }

    #[test]
    fn retina_points_are_not_scaled() {
        // Half-point offsets, as on a 2x display. The result is the same length in points, not
        // doubled into device pixels.
        let on_screen =
            page_on_screen(view(100.5, 200.5, 1000.0, 800.0), (0.5, 52.5, 999.0, 747.0));
        assert_eq!(on_screen, anchor(101.0, 201.0, 999.0, 747.0));
    }

    #[test]
    fn page_is_clipped_to_the_window() {
        // A page that hangs off the right and the bottom of the view.
        let on_screen = page_on_screen(view(0.0, 0.0, 800.0, 600.0), (100.0, 100.0, 900.0, 700.0));
        assert_eq!(on_screen, anchor(100.0, 0.0, 700.0, 500.0));
        // A page left of and above the view.
        let on_screen = page_on_screen(view(0.0, 0.0, 800.0, 600.0), (-50.0, -50.0, 300.0, 300.0));
        assert_eq!(on_screen, anchor(0.0, 350.0, 250.0, 250.0));
    }

    #[test]
    fn nothing_visible_or_nothing_finite_gives_no_anchor() {
        let window = view(0.0, 0.0, 800.0, 600.0);
        assert_eq!(page_on_screen(window, (0.0, 0.0, 0.0, 100.0)), None);
        assert_eq!(page_on_screen(window, (0.0, 0.0, 100.0, -5.0)), None);
        assert_eq!(page_on_screen(window, (900.0, 0.0, 100.0, 100.0)), None);
        assert_eq!(page_on_screen(window, (f32::NAN, 0.0, 100.0, 100.0)), None);
        assert_eq!(
            page_on_screen(window, (0.0, 0.0, f32::INFINITY, 100.0)),
            None
        );
        assert_eq!(
            page_on_screen(view(f64::NAN, 0.0, 800.0, 600.0), (0.0, 0.0, 100.0, 100.0)),
            None
        );
    }
}
