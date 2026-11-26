//! The one empty and error state every panel uses (`EmptyState.tsx` and `EmptyState.css` in the
//! desktop lab). It sits near the top of the panel, centred: a 40px tile with a 16px glyph, a
//! 14px title, a muted description of at most two balanced lines, and optional pill buttons.

use std::rc::Rc;

use conn_theme::Tokens;
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Font, FontWeight, IntoElement, ParentElement, Pixels, Role, SharedString,
    Styled, TextRun, Window, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::{UI_LINE_HEIGHT_PX, UI_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::theme::MONO_FONT;

/// `.lab-empty` top padding is `max(32px, 8vh)`.
const TOP_PAD_MIN_PX: f32 = 32.0;
const TOP_PAD_VIEWPORT_RATIO: f32 = 0.08;
/// `.lab-empty-mark`: a 40px rounded square with a 16px glyph.
const MARK_PX: f32 = 40.0;
const MARK_RADIUS_PX: f32 = 10.0;
const MARK_GLYPH_PX: f32 = 16.0;
/// `.lab-empty p`: at most 380px wide, 19px lines.
pub(crate) const DESCRIPTION_MAX_WIDTH_PX: f32 = 380.0;
const DESCRIPTION_LINE_HEIGHT_PX: f32 = 19.0;
/// `.lab-empty code`: 12px monospace.
const CODE_TEXT_PX: f32 = 12.0;
/// `.lab-empty-action`: a 32px pill.
const ACTION_HEIGHT_PX: f32 = 32.0;
const PILL_RADIUS_PX: f32 = 9999.0;

/// One word of a description; `mono` words are the `<code>` ones. `suffix` is plain text that
/// touches the word, such as the full stop after a `<code>` word.
pub(crate) struct Word {
    text: SharedString,
    mono: bool,
    suffix: SharedString,
}

/// A description in plain text.
pub(crate) fn plain(text: &str) -> Vec<Word> {
    text.split_whitespace()
        .map(|word| Word {
            text: SharedString::from(word.to_owned()),
            mono: false,
            suffix: SharedString::default(),
        })
        .collect()
}

pub(crate) fn word(text: &str) -> Word {
    Word {
        text: SharedString::from(text.to_owned()),
        mono: false,
        suffix: SharedString::default(),
    }
}

/// A `<code>` word, with the plain text that touches it.
pub(crate) fn code(text: &str, suffix: &str) -> Word {
    Word {
        text: SharedString::from(text.to_owned()),
        mono: true,
        suffix: SharedString::from(suffix.to_owned()),
    }
}

/// A pill button under the description.
pub(crate) struct EmptyAction {
    /// The element id, which tests find the button by.
    pub(crate) id: SharedString,
    /// The accessibility id.
    pub(crate) ax_id: SharedString,
    pub(crate) label: SharedString,
    pub(crate) icon: Option<&'static str>,
    pub(crate) on_click: Rc<dyn Fn(&mut Window, &mut App)>,
}

/// What an empty or error state says.
pub(crate) struct EmptyState {
    /// Prefix of the element ids: `{id}-mark`, `{id}-title`, `{id}-description`.
    pub(crate) id: &'static str,
    /// Prefix of the accessibility ids.
    pub(crate) ax_id: &'static str,
    /// What the block is, for the accessibility tree.
    pub(crate) label: &'static str,
    pub(crate) icon: &'static str,
    pub(crate) title: SharedString,
    pub(crate) description: Vec<Word>,
    pub(crate) actions: Vec<EmptyAction>,
}

fn font_for(window: &Window, mono: bool) -> Font {
    let mut font = window.text_style().font();
    if mono {
        font.family = SharedString::from(MONO_FONT);
    }
    font
}

fn text_width(window: &Window, text: &str, size_px: f32, mono: bool) -> Pixels {
    let run = TextRun {
        len: text.len(),
        font: font_for(window, mono),
        color: gpui_kit::black(),
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    window
        .text_system()
        .shape_line(
            SharedString::from(text.to_owned()),
            px(size_px),
            &[run],
            None,
        )
        .width
}

/// Splits words of the given `widths` into lines of at most `max`. A text that needs two lines
/// gets them as even as possible, as `text-wrap: balance` makes them; longer ones wrap greedily.
/// `space` is the gap between words. Returns each line as the indices of its words.
pub(crate) fn split_lines(widths: &[Pixels], space: Pixels, max: Pixels) -> Vec<Vec<usize>> {
    let count = widths.len();
    let span = |from: usize, to: usize| -> Pixels {
        let sum: Pixels = widths[from..to].iter().copied().sum();
        sum + space * (to - from).saturating_sub(1) as f32
    };
    if span(0, count) <= max {
        return vec![(0..count).collect()];
    }
    let widest = |split: usize| span(0, split).max(span(split, count));
    let best = (1..count)
        .filter(|&split| span(0, split) <= max && span(split, count) <= max)
        .min_by(|&a, &b| {
            widest(a)
                .partial_cmp(&widest(b))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    if let Some(split) = best {
        return vec![(0..split).collect(), (split..count).collect()];
    }
    let mut lines: Vec<Vec<usize>> = vec![Vec::new()];
    let mut line_start = 0;
    for index in 0..count {
        if span(line_start, index + 1) > max && !lines.last().is_some_and(Vec::is_empty) {
            lines.push(Vec::new());
            line_start = index;
        }
        if let Some(line) = lines.last_mut() {
            line.push(index);
        }
    }
    lines
}

/// The lines `words` take in a block `max` wide, measured with the window's fonts.
fn balanced_lines(window: &Window, words: &[Word], max: Pixels) -> Vec<Vec<usize>> {
    let widths: Vec<Pixels> = words
        .iter()
        .map(|w| {
            let size = if w.mono { CODE_TEXT_PX } else { UI_TEXT_PX };
            text_width(window, &w.text, size, w.mono)
                + text_width(window, &w.suffix, UI_TEXT_PX, false)
        })
        .collect();
    let space = text_width(window, " ", UI_TEXT_PX, false);
    split_lines(&widths, space, max)
}

/// Renders the state as a block that fills its panel.
pub(crate) fn render_empty_state(
    window: &Window,
    tokens: &Tokens,
    state: EmptyState,
) -> AnyElement {
    let EmptyState {
        id,
        ax_id,
        label,
        icon,
        title,
        description,
        actions,
    } = state;
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let raised = to_hsla(tokens.shell_control);
    let line = to_hsla(tokens.shell_divider_header);
    let hover = to_hsla(tokens.shell_highlight);

    let lines = balanced_lines(window, &description, px(DESCRIPTION_MAX_WIDTH_PX));
    let space = text_width(window, " ", UI_TEXT_PX, false);
    let description_text = description
        .iter()
        .map(|w| format!("{}{}", w.text, w.suffix))
        .collect::<Vec<_>>()
        .join(" ");
    let mut body = v_flex()
        .id(SharedString::from(format!("{id}-description")))
        .test_support()
        .a11y_group(format!("{ax_id}.description"), description_text)
        .max_w(px(DESCRIPTION_MAX_WIDTH_PX))
        .items_center()
        .mb(px(16.0))
        .text_color(muted)
        .text_size(px(UI_TEXT_PX))
        .line_height(px(DESCRIPTION_LINE_HEIGHT_PX));
    for (index, line_words) in lines.iter().enumerate() {
        let mut row = h_flex()
            .id(SharedString::from(format!("{id}-description-{index}")))
            .test_support()
            .gap(space)
            .justify_center();
        for &at in line_words {
            let word = &description[at];
            row = row.child(if word.mono {
                h_flex()
                    .child(
                        div()
                            .font_family(SharedString::from(MONO_FONT))
                            .text_size(px(CODE_TEXT_PX))
                            .text_color(fg)
                            .child(word.text.clone()),
                    )
                    .child(word.suffix.clone())
                    .into_any_element()
            } else {
                div().child(word.text.clone()).into_any_element()
            });
        }
        body = body.child(row);
    }

    let mark = div()
        .id(SharedString::from(format!("{id}-mark")))
        .test_support()
        .flex()
        .items_center()
        .justify_center()
        .size(px(MARK_PX))
        .mb(px(14.0))
        .rounded(px(MARK_RADIUS_PX))
        .bg(raised)
        .border_1()
        .border_color(line)
        .child(superhero_icon(icon, MARK_GLYPH_PX, muted));

    let heading = div()
        .id(SharedString::from(format!("{id}-title")))
        .test_support()
        .a11y(Role::Heading, format!("{ax_id}.title"), title.clone())
        .mb(px(6.0))
        .text_size(px(14.0))
        .line_height(px(20.0))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(title);

    let mut block = v_flex()
        .id(SharedString::from(id))
        .test_support()
        .a11y_group(ax_id, label)
        .flex_1()
        .min_h_0()
        .w_full()
        .items_center()
        .overflow_y_scroll()
        .pt(px(TOP_PAD_MIN_PX.max(
            window.viewport_size().height.as_f32() * TOP_PAD_VIEWPORT_RATIO,
        )))
        .px(px(24.0))
        .pb(px(24.0))
        .text_center()
        .child(mark)
        .child(heading)
        .child(body);

    if !actions.is_empty() {
        let mut row = h_flex().flex_wrap().justify_center().gap(px(8.0));
        for action in actions {
            let on_click = action.on_click;
            let mut button = h_flex()
                .id(action.id)
                .test_support()
                .a11y_button(action.ax_id, action.label.clone())
                .h(px(ACTION_HEIGHT_PX))
                .pl(px(11.0))
                .pr(px(14.0))
                .gap(px(6.0))
                .items_center()
                .rounded(px(PILL_RADIUS_PX))
                .bg(raised)
                .border_1()
                .border_color(line)
                .cursor_pointer()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(fg)
                .hover(move |s| s.bg(hover))
                .on_click(move |_, window, cx| on_click(window, cx));
            if let Some(path) = action.icon {
                button = button.child(superhero_icon(path, 14.0, fg));
            }
            row = row.child(button.child(action.label));
        }
        block = block.child(row);
    }

    block.into_any_element()
}

/// Test helpers shared by the panels' empty-state tests: a headless window, and offscreen PNGs.
#[cfg(test)]
pub(crate) mod shots {
    use std::path::Path;

    use conn_theme::Tokens;
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{
        AnyWindowHandle, AppContext as _, Bounds, Context, Entity, HeadlessAppContext, Point,
        Render, Window, WindowBounds, WindowOptions, px, size,
    };

    /// The two themes every screenshot is taken in: (theme id, file label).
    pub(crate) const THEMES: [(&str, &str); 2] =
        [("dark-ocean", "dark"), ("t3-code-light", "light")];

    pub(crate) fn tokens_for(theme: &str) -> Tokens {
        Tokens::derive(&conn_theme::theme_by_id(theme).expect("a built-in theme"))
    }

    /// A headless app that draws into a texture: no window on screen, no focus taken.
    #[cfg(target_os = "macos")]
    pub(crate) fn context() -> HeadlessAppContext {
        HeadlessAppContext::with_platform(
            // `current_platform(true)` needs the main thread, which libtest does not give a test.
            std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
            std::sync::Arc::new(crate::superhero::AppAssets),
            gpui_kit::platform::current_headless_renderer,
        )
    }

    /// Opens a hidden window `width` by `height` showing the view `build` makes.
    pub(crate) fn open<V: Render + 'static>(
        ctx: &mut HeadlessAppContext,
        tokens: &Tokens,
        (width, height): (f32, f32),
        build: impl FnOnce(&mut Window, &mut Context<'_, V>) -> V + 'static,
    ) -> (AnyWindowHandle, Entity<V>) {
        ctx.update(|cx| {
            gpui_kit::init(cx);
            crate::fonts::register(cx);
            crate::theme::apply_kit_theme(tokens, cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::default(),
                        size(px(width), px(height)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| build(window, cx)),
            )
            .expect("a window")
        })
    }

    /// Renders the window to `<dir>/<name>-<label>.png`.
    pub(crate) fn shoot(
        ctx: &mut HeadlessAppContext,
        window: AnyWindowHandle,
        dir: &Path,
        name: &str,
        label: &str,
    ) {
        for _ in 0..3 {
            ctx.update_window(window, |_, w, c| w.render_frame(c))
                .expect("a frame");
            ctx.run_until_parked();
        }
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("{name}-{label}.png")))
            .expect("a saved PNG");
    }
}
