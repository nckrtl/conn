use gpui_kit::TestSupportExt as _;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, DragMoveEvent, EmptyView, Entity, IntoElement, ParentElement, Styled,
    Window, div, px,
};
use serde::{Deserialize, Serialize};

use super::{FilesPanel, h_flex, to_hsla, v_flex};
use crate::a11y::ConnA11yExt as _;

const DEFAULT_WIDTH: f32 = 256.;
const MIN_WIDTH: f32 = 160.;
const MAX_WIDTH: f32 = 560.;

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(super) struct Navigator {
    pub(super) open: bool,
    width: f32,
}

impl Navigator {
    pub(super) fn state(window: &mut Window, cx: &mut Context<'_, FilesPanel>) -> Entity<Self> {
        window.use_keyed_state("files-navigator-settings", cx, |_, _| {
            crate::terminal_settings::settings_path("files-navigator.json")
                .and_then(|path| std::fs::read(path).ok())
                .and_then(|data| serde_json::from_slice::<Self>(&data).ok())
                .unwrap_or(Self {
                    open: true,
                    width: DEFAULT_WIDTH,
                })
        })
    }

    fn save(&self) {
        if let Some(path) = crate::terminal_settings::settings_path("files-navigator.json")
            && let Ok(json) = serde_json::to_string(self)
        {
            let _ = crate::drafts::write_drafts_file(&path, &json);
        }
    }

    pub(super) fn toggle(&mut self) {
        self.open = !self.open;
        self.save();
    }
}

#[derive(Clone)]
struct ResizeNavigator;

impl FilesPanel {
    pub(super) fn render_file_split(
        &self,
        editor: AnyElement,
        navigator: Entity<Navigator>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let mut row = h_flex()
            .id("files-split")
            .flex_1()
            .min_h_0()
            .w_full()
            .child(editor);
        if self.workspace_root.is_some() && navigator.read(cx).open {
            let divider = to_hsla(self.tokens.shell_divider);
            let width = navigator.read(cx).width.clamp(MIN_WIDTH, MAX_WIDTH);
            let save = navigator.clone();
            let handle = div()
                .id("files-navigator-resize")
                .test_support()
                .a11y_group("panel.files.navigator-resize", "Resize file explorer")
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(-3.))
                .w(px(7.))
                .cursor(gpui_kit::CursorStyle::ResizeLeftRight)
                .on_drag(ResizeNavigator, move |_, _, _, cx| {
                    let save = save.clone();
                    cx.new(|cx: &mut Context<'_, EmptyView>| {
                        cx.on_release(move |_, cx| save.read(cx).save()).detach();
                        EmptyView
                    })
                });
            row = row
                .child(
                    v_flex()
                        .id("files-navigator")
                        .test_support()
                        .a11y_group("panel.files.navigator", "File explorer")
                        .relative()
                        .h_full()
                        .min_h_0()
                        .min_w_0()
                        .flex_shrink_0()
                        .w(px(width))
                        .max_w(gpui_kit::relative(0.45))
                        .border_l_1()
                        .border_color(divider)
                        .child(self.render_tree_toolbar(cx))
                        .child(self.render_tree_column(cx))
                        .child(handle),
                )
                .on_drag_move::<ResizeNavigator>(cx.listener(
                    move |_, event: &DragMoveEvent<ResizeNavigator>, _, cx| {
                        let max_width = (f32::from(event.bounds.size.width) * 0.45).min(MAX_WIDTH);
                        let width = f32::from(event.bounds.right() - event.event.position.x)
                            .clamp(MIN_WIDTH.min(max_width), max_width);
                        if navigator.read(cx).width != width {
                            navigator.update(cx, |state, _| state.width = width);
                            cx.notify();
                        }
                    },
                ));
        }
        row.into_any_element()
    }
}
