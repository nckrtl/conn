//! The root view's big, stable regions (the sidebar and the thread header) as cached views.
//!
//! GPUI re-renders a view and every ancestor when the view notifies. Every view sits under
//! `ConnApp`, so a frame of the chat's shimmer used to rebuild the whole window: the sidebar's
//! lists and rows, the header, the panels. A cached region keeps last frame's layout and paint
//! and rebuilds only when its own entity is notified.
//!
//! A region renders through `ConnApp` (`app.update`), so its elements, listeners and state stay
//! where they were. It is notified:
//! - when `ConnApp` notifies: a region observes it, as everything it draws is `ConnApp`'s state;
//! - when a view drawn inside it notifies (the search and rename inputs), as GPUI dirties every
//!   ancestor view of a notified one;
//! - by the window: focus, activation, resize and appearance changes refresh every view.
//!
//! What a region reads from another entity that notifies only itself would not reach it; the
//! sidebar's one such input, the chat's model picker, is checked each frame in
//! [`ConnApp::sync_sidebar_inputs`].

use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, IntoElement, Render, StyleRefinement,
    Styled as _, Subscription, WeakEntity, Window, div, px,
};

use super::ConnApp;

/// Which slice of the root a [`ShellRegion`] draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RegionKind {
    /// The workspace rail and the thread sidebar.
    Sidebar,
    /// The thread header above the chat card.
    Header,
}

/// A cached slice of the root view; see the module docs.
pub(crate) struct ShellRegion {
    app: WeakEntity<ConnApp>,
    kind: RegionKind,
    _app_notified: Subscription,
}

impl std::fmt::Debug for ShellRegion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellRegion")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl ShellRegion {
    pub(crate) fn new(app: &Entity<ConnApp>, kind: RegionKind, cx: &mut Context<'_, Self>) -> Self {
        Self {
            app: app.downgrade(),
            kind,
            _app_notified: cx.observe(app, |_, _, cx| cx.notify()),
        }
    }
}

impl Render for ShellRegion {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let kind = self.kind;
        self.app
            .update(cx, |app, cx| match kind {
                RegionKind::Sidebar => app.render_sidebar_region(window, cx),
                RegionKind::Header => app.render_header_region(cx),
            })
            .unwrap_or_else(|_| div().into_any_element())
    }
}

/// The root's regions, created with it.
pub(crate) struct ShellRegions {
    pub(crate) sidebar: Entity<ShellRegion>,
    pub(crate) header: Entity<ShellRegion>,
}

impl ShellRegions {
    pub(crate) fn new(cx: &mut Context<'_, ConnApp>) -> Self {
        let app = cx.entity();
        Self {
            sidebar: cx.new(|cx| ShellRegion::new(&app, RegionKind::Sidebar, cx)),
            header: cx.new(|cx| ShellRegion::new(&app, RegionKind::Header, cx)),
        }
    }
}

/// The sidebar region at `width` (rail and sidebar), as tall as the window.
pub(crate) fn sidebar_region(region: &Entity<ShellRegion>, width: f32) -> AnyElement {
    let mut style = StyleRefinement::default().h_full().flex_shrink_0();
    style = style.w(px(width));
    region.clone().cached(style).into_any_element()
}

/// The header region: the chat column's width, `height` tall.
pub(crate) fn header_region(region: &Entity<ShellRegion>, height: f32) -> AnyElement {
    let style = StyleRefinement::default()
        .w_full()
        .h(px(height))
        .flex_shrink_0();
    region.clone().cached(style).into_any_element()
}

impl ConnApp {
    /// Notifies the sidebar region on the next frame when an input it draws from, that does not
    /// notify `ConnApp`, changed since it last drew: whether the rows wear their jump numbers,
    /// which the chat's model picker turns off. Runs as the root renders, every frame.
    pub(super) fn sync_sidebar_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if !self.layout.sidebar_open
            || self.jump_hints_visible(window, cx) == self.sidebar_jump_hints_shown
        {
            return;
        }
        let sidebar = self.regions.sidebar.downgrade();
        window.on_next_frame(move |_, cx| {
            let _ = sidebar.update(cx, |_, cx| cx.notify());
        });
    }
}
