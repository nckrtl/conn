//! Text selection for thread messages.
//!
//! `gpui-base` keeps one window-wide selection (`TextSelectionLayer`, mounted by `Root`): a press
//! on text starts it, a drag extends it, a double or triple click picks a word or paragraph, a
//! press anywhere else clears it, and Cmd+C writes the selected text to the clipboard. Text takes
//! part by registering a [`TextSelectionHandle`] each frame with where it was laid out.
//!
//! [`SelectableFlow`] does that for a message's `StyledText`, which `gpui-base`'s own
//! `SelectableText` cannot wrap: a paragraph here may be an `InteractiveText` (links) or an
//! [`InlineCodeText`](super::inline_code::InlineCodeText) (chips). The flow
//!
//! - paints the highlight with the theme's `selection` token, under the text and the chips;
//! - copies the text the reader sees: a chip's reserved no-break spaces become its code, and a
//!   block that is not part of a tight list ends in a newline when the selection reaches its end,
//!   so the join between blocks reads as a blank line;
//! - orders itself among the other flows with [`SelectionScope`], so a drag across blocks (and
//!   across messages) copies them in reading order.

use std::cell::{Cell, RefCell};
use std::ops::Range;
use std::rc::Rc;

use gpui_kit::base::{TextSelectionHandle, TextSelectionRegistration, TextSelectionRun};
use gpui_kit::{
    AnyElement, App, BorderStyle, Bounds, Corners, Edges, Element, ElementId, GlobalElementId,
    HitboxBehavior, Hsla, InspectorElementId, IntoElement, LayoutId, PaintQuad, Pixels, Point,
    SharedString, TextLayout, Window, transparent_black,
};

/// Bits of a document order that number the flows inside one row.
const ORDER_SHIFT: u32 = 24;
const ORDER_MASK: u64 = (1 << ORDER_SHIFT) - 1;

/// Hands out document orders for the text of one timeline row, so that its flows sort in reading
/// order and after every flow of the rows above it.
#[derive(Clone, Debug)]
pub(crate) struct SelectionScope {
    base: u64,
    next: Rc<Cell<u64>>,
}

impl SelectionScope {
    /// The scope of the timeline row at `row`. Create it once per render of the row: the orders
    /// count up in the order the row is built.
    pub(crate) fn for_row(row: usize) -> Self {
        Self {
            base: (row as u64 + 1) << ORDER_SHIFT,
            next: Rc::new(Cell::new(0)),
        }
    }

    /// The order of the next flow in the row.
    pub(crate) fn next_order(&self) -> u64 {
        let n = self.next.get();
        self.next.set(n + 1);
        self.base + n.min(ORDER_MASK)
    }
}

/// Clears the window's text selection when `event` is a plain Escape and a selection exists.
/// Returns whether it did, so the key is not used twice.
pub(crate) fn clear_on_escape(
    event: &gpui_kit::KeyDownEvent,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let modifiers = event.keystroke.modifiers;
    if event.keystroke.key != "escape" || modifiers.control || modifiers.platform || modifiers.alt {
        return false;
    }
    if !gpui_kit::base::TextSelection::has_selection(window, cx) {
        return false;
    }
    gpui_kit::base::TextSelection::clear(window, cx);
    true
}

/// Plain message text (a user's words) that takes part in the window's selection, laid out and
/// painted by `gpui-base`'s own `SelectableText`. Without a scope it is plain text, as before.
pub(super) fn selectable_message_text(
    id: &str,
    text: &str,
    scope: Option<&SelectionScope>,
) -> AnyElement {
    let text = SharedString::from(text.to_owned());
    match scope {
        Some(scope) => gpui_kit::base::SelectableText::new(SharedString::from(id.to_owned()), text)
            .document_order(scope.next_order())
            .into_any_element(),
        None => text.into_any_element(),
    }
}

/// What a flow tells the selection about its text, known once it is laid out.
#[derive(Clone)]
pub(super) struct FlowInfo {
    /// The text exactly as laid out.
    pub(super) text: SharedString,
    pub(super) layout: TextLayout,
    /// Byte ranges of `text` that stand for other text when copied: a chip's reserved room and the
    /// code it holds, in ascending order.
    pub(super) chips: Vec<(Range<usize>, String)>,
}

/// Where a flow's [`FlowInfo`] shows up. A paragraph with chips is built on its first layout, so
/// the slot is filled then; any other flow fills it up front.
#[derive(Clone, Default)]
pub(super) struct FlowProbe(Rc<RefCell<Option<FlowInfo>>>);

impl FlowProbe {
    pub(super) fn with(info: FlowInfo) -> Self {
        Self(Rc::new(RefCell::new(Some(info))))
    }

    pub(super) fn set(&self, info: FlowInfo) {
        *self.0.borrow_mut() = Some(info);
    }

    fn get(&self) -> Option<FlowInfo> {
        self.0.borrow().clone()
    }
}

/// The text a flow copies for its selected `range`.
#[derive(Default)]
struct FlowCopy {
    info: Option<FlowInfo>,
    range: Option<Range<usize>>,
    /// In a tight list the next block follows on the very next line.
    tight: bool,
}

impl FlowCopy {
    fn selected_text(&self) -> String {
        let (Some(info), Some(range)) = (&self.info, &self.range) else {
            return String::new();
        };
        copy_text(&info.text, &info.chips, range, self.tight)
    }
}

/// `text[range]` with each chip the range touches copied as its code, and a closing newline after
/// the last character of a block that is not `tight`.
pub(super) fn copy_text(
    text: &str,
    chips: &[(Range<usize>, String)],
    range: &Range<usize>,
    tight: bool,
) -> String {
    let end = range.end.min(text.len());
    let mut out = String::new();
    let mut at = range.start.min(end);
    for (chip, code) in chips {
        if chip.end <= at || chip.start >= end {
            continue;
        }
        if chip.start > at {
            out.push_str(&text[at..chip.start]);
        }
        out.push_str(code);
        at = chip.end;
    }
    if at < end {
        out.push_str(&text[at..end]);
    }
    if !tight && end >= text.len() && !out.is_empty() {
        out.push('\n');
    }
    out
}

/// How far the pointer may move between a press and its release and still be a click.
const CLICK_SLOP_PX: f32 = 4.0;

/// Whether the pointer moved far enough from `pressed` to `released` to be a drag.
pub(super) fn was_dragged(pressed: Point<Pixels>, released: Point<Pixels>) -> bool {
    let dx = f32::from(released.x) - f32::from(pressed.x);
    let dy = f32::from(released.y) - f32::from(pressed.y);
    dx.hypot(dy) > CLICK_SLOP_PX
}

/// Where the left button went down on a flow, and whether it came up far from there.
///
/// `InteractiveText` calls a link clicked when the press and the release both land inside the
/// link, which a drag that selects part of a long link also does. The flow keeps this between
/// frames (the press and the release are different frames), and the link's click handler asks
/// [`take_drag`](Self::take_drag) before it acts.
#[derive(Default)]
pub(super) struct LinkPress {
    pressed: Cell<Option<Point<Pixels>>>,
    dragged: Cell<bool>,
}

/// A paragraph's link handlers are built before its flow has retained state, so they reach the
/// [`LinkPress`] through this slot, which the flow binds at layout. Without a flow (no selection)
/// the slot stays empty and a link behaves as it always did.
#[derive(Clone, Default)]
pub(super) struct PressSlot(Rc<RefCell<Option<Rc<LinkPress>>>>);

impl PressSlot {
    fn bind(&self, press: Rc<LinkPress>) {
        *self.0.borrow_mut() = Some(press);
    }

    /// The left button went down at `at`.
    pub(super) fn press(&self, at: Point<Pixels>) {
        if let Some(press) = self.0.borrow().as_ref() {
            press.pressed.set(Some(at));
            press.dragged.set(false);
        }
    }

    /// The left button came up at `at`.
    pub(super) fn release(&self, at: Point<Pixels>) {
        if let Some(press) = self.0.borrow().as_ref()
            && let Some(pressed) = press.pressed.take()
        {
            press.dragged.set(was_dragged(pressed, at));
        }
    }

    /// Whether the release that is being handled ended a drag; the answer is read once.
    pub(super) fn take_drag(&self) -> bool {
        self.0
            .borrow()
            .as_ref()
            .is_some_and(|press| press.dragged.replace(false))
    }
}

/// What a flow keeps from frame to frame.
#[derive(Clone)]
pub(super) struct FlowState {
    handle: TextSelectionHandle,
    copy: Rc<RefCell<FlowCopy>>,
    press: Rc<LinkPress>,
}

/// Makes the text of `child` selectable: the window's selection reaches it, and it paints what
/// the selection covers. `child` must paint the text `probe` describes, filling the probe no
/// later than its own layout.
pub(super) struct SelectableFlow {
    id: ElementId,
    order: u64,
    probe: FlowProbe,
    press: PressSlot,
    tight: bool,
    child: AnyElement,
}

impl SelectableFlow {
    pub(super) fn new(
        id: impl Into<ElementId>,
        order: u64,
        probe: FlowProbe,
        press: PressSlot,
        tight: bool,
        child: AnyElement,
    ) -> Self {
        Self {
            id: id.into(),
            order,
            probe,
            press,
            tight,
            child,
        }
    }
}

impl IntoElement for SelectableFlow {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SelectableFlow {
    type RequestLayoutState = FlowState;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let state = match global_id {
            Some(global_id) => {
                window.with_element_state(global_id, |retained: Option<FlowState>, _| {
                    let state = retained.unwrap_or_else(|| new_flow_state(cx));
                    (state.clone(), state)
                })
            }
            None => new_flow_state(cx),
        };
        // The links in `child` read their press from the flow's retained state.
        self.press.bind(state.press.clone());
        let layout_id = self.child.request_layout(window, cx);
        (layout_id, state)
    }

    fn prepaint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.child.prepaint(window, cx);
        // Same order as `gpui-base`'s `SelectableText`: the child's own hitboxes (links) come
        // first, and this normal hitbox does not hide them.
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let registration = TextSelectionRegistration::new(hitbox, bounds)
            .with_document_order(self.order)
            .with_text_bounds(vec![bounds])
            .with_rendered_element(&state.handle, window, cx);
        state.handle.register(registration, window, cx);
    }

    fn paint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(info) = self.probe.get() {
            let run = TextSelectionRun::new(info.text.clone(), info.layout.clone(), bounds);
            let projection = state.handle.update_runs(&[run], cx);
            let range = projection.ranges().first().cloned().flatten();
            {
                let mut copy = state.copy.borrow_mut();
                let changed = copy.range != range;
                copy.tight = self.tight;
                copy.range = range.clone();
                copy.info = Some(info.clone());
                if changed {
                    // The copy text follows the projection: draw once more so a copy that races
                    // the change reads what is on screen.
                    window.refresh();
                }
            }
            if let Some(range) = range {
                let color = selection_color(cx);
                paint_selection(&info.layout, range, color, window);
            }
        }
        self.child.paint(window, cx);
    }
}

fn new_flow_state(cx: &mut App) -> FlowState {
    let handle = TextSelectionHandle::new(String::new(), cx);
    let copy = Rc::new(RefCell::new(FlowCopy::default()));
    let reader = copy.clone();
    handle.copy_with(move |_| reader.borrow().selected_text(), cx);
    FlowState {
        handle,
        copy,
        press: Rc::new(LinkPress::default()),
    }
}

/// The theme's selection background, as `gpui-base`'s own selectable text paints it.
pub(super) fn selection_color(cx: &App) -> Hsla {
    gpui_kit::base::Theme::global(cx).tokens.colors.selection
}

fn paint_selection(layout: &TextLayout, range: Range<usize>, color: Hsla, window: &mut Window) {
    let (Some(start), Some(end)) = (
        layout.position_for_index(range.start),
        layout.position_for_index(range.end),
    ) else {
        return;
    };
    for bounds in selection_quads(start, end, layout.bounds(), layout.line_height()) {
        window.paint_quad(PaintQuad {
            bounds,
            background: color.into(),
            corner_radii: Corners::default(),
            border_widths: Edges::default(),
            border_color: transparent_black(),
            border_style: BorderStyle::default(),
        });
    }
}

/// The rectangles a selection from `start` to `end` covers: the first line from `start`, the
/// full lines between, and the last line up to `end`.
fn selection_quads(
    start: Point<Pixels>,
    end: Point<Pixels>,
    bounds: Bounds<Pixels>,
    line_height: Pixels,
) -> Vec<Bounds<Pixels>> {
    if start.y == end.y {
        return vec![Bounds::from_corners(
            start,
            Point::new(end.x, end.y + line_height),
        )];
    }
    let mut quads = vec![Bounds::from_corners(
        start,
        Point::new(bounds.right(), start.y + line_height),
    )];
    if end.y > start.y + line_height {
        quads.push(Bounds::from_corners(
            Point::new(bounds.left(), start.y + line_height),
            Point::new(bounds.right(), end.y),
        ));
    }
    quads.push(Bounds::from_corners(
        Point::new(bounds.left(), end.y),
        Point::new(end.x, end.y + line_height),
    ));
    quads
}

#[cfg(test)]
mod tests {
    use super::*;

    const NBSP: &str = "\u{a0}";

    #[test]
    fn plain_text_copies_the_selected_slice() {
        assert_eq!(copy_text("Hello world", &[], &(6..11), true), "world");
        assert_eq!(copy_text("Hello world", &[], &(0..5), true), "Hello");
    }

    #[test]
    fn a_block_ends_in_a_newline_only_when_the_selection_reaches_its_end() {
        assert_eq!(copy_text("Hello world", &[], &(0..5), false), "Hello");
        assert_eq!(copy_text("Hello world", &[], &(6..11), false), "world\n");
        assert_eq!(copy_text("Hello world", &[], &(6..11), true), "world");
    }

    #[test]
    fn a_chip_copies_as_its_code_not_its_reserved_room() {
        let text = format!("Run {NBSP}{NBSP}{NBSP} now");
        let room = 4..4 + 3 * NBSP.len();
        let chips = vec![(room.clone(), "cargo".to_owned())];
        assert_eq!(
            copy_text(&text, &chips, &(0..text.len()), true),
            "Run cargo now"
        );
        // Starting inside the chip still takes all of it, and nothing before.
        assert_eq!(
            copy_text(&text, &chips, &(room.start + NBSP.len()..text.len()), true),
            "cargo now"
        );
        // Ending inside the chip takes all of it, and nothing after.
        assert_eq!(
            copy_text(&text, &chips, &(0..room.start + NBSP.len()), true),
            "Run cargo"
        );
        // A selection that stops before the chip takes none of it.
        assert_eq!(copy_text(&text, &chips, &(0..3), true), "Run");
    }

    #[test]
    fn two_chips_in_a_row_keep_the_text_between_them() {
        let text = format!("{NBSP}{NBSP} and {NBSP}");
        let first = 0..2 * NBSP.len();
        let second_start = first.end + " and ".len();
        let chips = vec![
            (first, "a".to_owned()),
            (second_start..second_start + NBSP.len(), "b".to_owned()),
        ];
        assert_eq!(copy_text(&text, &chips, &(0..text.len()), true), "a and b");
    }

    // ---- Headless window tests: a real window under `Root`, real pointer events and Cmd+C. ----

    use std::cell::RefCell;

    use conn_theme::Tokens;
    use gpui_kit::test::{ClickOptions, TestEventExt as _, TestWindowExt as _};
    use gpui_kit::{
        AnyWindowHandle, AppContext as _, Context, Entity, FocusHandle, Focusable,
        InteractiveElement as _, ParentElement as _, Render, ScrollDelta,
        StatefulInteractiveElement as _, Styled as _, TestAppContext, div, point, px,
    };

    use crate::chat::markdown::{MarkdownOptions, render_markdown};

    #[derive(Clone, Copy)]
    enum Body {
        Markdown,
        UserText,
        Scrolling,
        /// Two messages (rows 0 and 1) in one column: `source` is the first, a fixed text the second.
        TwoMessages,
    }

    struct Harness {
        source: String,
        body: Body,
        tokens: Tokens,
        focus: FocusHandle,
        opened: Rc<RefCell<Vec<String>>>,
    }

    impl Focusable for Harness {
        fn focus_handle(&self, _: &App) -> FocusHandle {
            self.focus.clone()
        }
    }

    impl Render for Harness {
        fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
            let scope = SelectionScope::for_row(0);
            let opened = self.opened.clone();
            let body = match self.body {
                Body::UserText => selectable_message_text("user-text", &self.source, Some(&scope)),
                Body::TwoMessages => {
                    let mut column = div().flex().flex_col().gap(px(16.0));
                    for (row, source) in [(0, self.source.as_str()), (1, "Second message.")] {
                        let options = MarkdownOptions {
                            selection: Some(SelectionScope::for_row(row)),
                            ..MarkdownOptions::default()
                        };
                        column = column.child(render_markdown(
                            &format!("m{row}"),
                            source,
                            &self.tokens,
                            &options,
                        ));
                    }
                    column.into_any_element()
                }
                Body::Markdown | Body::Scrolling => {
                    let options = MarkdownOptions {
                        selection: Some(scope),
                        workspace_root: Some("/ws"),
                        on_open_file: Some(Rc::new(move |location, _, _| {
                            opened.borrow_mut().push(location.path.clone());
                        })),
                        ..MarkdownOptions::default()
                    };
                    render_markdown("t", &self.source, &self.tokens, &options)
                }
            };
            let probe = div()
                .id("probe")
                .track_focus(&self.focus)
                .w(px(300.0))
                .text_size(px(14.0))
                .line_height(px(22.75));
            let probe = match self.body {
                Body::Scrolling => probe.h(px(100.0)).overflow_y_scroll(),
                Body::Markdown | Body::UserText | Body::TwoMessages => probe,
            };
            gpui_kit::TestSupportExt::test_support(probe.child(body))
        }
    }

    fn tokens(theme_id: &str) -> Tokens {
        let Some(theme) = conn_theme::theme_by_id(theme_id) else {
            panic!("{theme_id} must be built in");
        };
        Tokens::derive(&theme)
    }

    fn open(
        cx: &mut TestAppContext,
        source: &str,
        body: Body,
    ) -> (AnyWindowHandle, Entity<Harness>, Rc<RefCell<Vec<String>>>) {
        let opened = Rc::new(RefCell::new(Vec::new()));
        let shared = opened.clone();
        let source = source.to_owned();
        let (window, harness) = cx.update(|cx| {
            gpui_kit::init(cx);
            let tokens = tokens("dark-ocean");
            crate::theme::apply_kit_theme(&tokens, cx);
            let Ok(opened_window) =
                gpui_kit::open_window(gpui_kit::WindowOptions::default(), cx, move |_, cx| {
                    cx.new(|cx| Harness {
                        source,
                        body,
                        tokens,
                        focus: cx.focus_handle(),
                        opened: shared,
                    })
                })
            else {
                panic!("failed to open the headless window");
            };
            opened_window
        });
        let focus = cx.read(|cx| harness.read(cx).focus.clone());
        let _ = cx.update_window(window, |_, window, cx| {
            window.focus(&focus, cx);
            window.render_frame(cx);
            window.render_frame(cx);
        });
        (window, harness, opened)
    }

    /// Runs `act` on the window, then renders so the selection has projected.
    fn act(
        cx: &mut TestAppContext,
        window: AnyWindowHandle,
        act: impl FnOnce(&mut Window, &mut App),
    ) {
        let _ = cx.update_window(window, |_, window, cx| {
            act(window, cx);
            window.render_frame(cx);
            window.render_frame(cx);
        });
    }

    fn copy(cx: &mut TestAppContext, window: AnyWindowHandle) -> Option<String> {
        cx.update(|cx| cx.write_to_clipboard(gpui_kit::ClipboardItem::new_string(String::new())));
        act(cx, window, |window, cx| window.key_down("cmd-c", false, cx));
        cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()))
    }

    fn has_selection(cx: &mut TestAppContext, window: AnyWindowHandle) -> bool {
        cx.update_window(window, |_, window, cx| {
            gpui_kit::base::TextSelection::has_selection(window, cx)
        })
        .unwrap_or(false)
    }

    /// Where `prefix` ends on a 14px line, in the window's x.
    fn x_after(cx: &mut TestAppContext, window: AnyWindowHandle, prefix: &str) -> f32 {
        cx.update_window(window, |_, window, _| {
            let font = gpui_kit::Font {
                family: ".SystemUIFont".into(),
                features: gpui_kit::FontFeatures::default(),
                fallbacks: None,
                weight: gpui_kit::FontWeight::NORMAL,
                style: gpui_kit::FontStyle::Normal,
            };
            f32::from(
                super::super::inline_code::shape(window, prefix, font, px(14.0), Hsla::default())
                    .width(),
            )
        })
        .unwrap_or(0.0)
    }

    const LINE_MID: f32 = 11.0;

    #[gpui_kit::test]
    fn dragging_across_blocks_copies_the_text_as_read(cx: &mut TestAppContext) {
        let source = "First paragraph.\n\nSecond has `code` inside.\n\n# Heading\n\n```rust\nlet x = 1;\n```\n\n- item one\n- item two";
        let (window, _, _) = open(cx, source, Body::Markdown);
        act(cx, window, |window, cx| {
            window.drag(
                point(px(1.0), px(LINE_MID)),
                point(px(299.0), px(700.0)),
                cx,
            );
        });
        assert!(has_selection(cx, window));
        assert_eq!(
            copy(cx, window).as_deref(),
            Some(
                "First paragraph.\n\nSecond has code inside.\n\nHeading\n\nlet x = 1;\n\nitem one\nitem two"
            ),
            "paragraphs, an inline-code chip (as its code, not its padding), a heading, a code \
             block and list items read as the message does"
        );
    }

    #[gpui_kit::test]
    fn dragging_over_a_word_copies_only_that_word(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "Hello world and more", Body::Markdown);
        let from = x_after(cx, window, "Hello ") + 1.0;
        let to = x_after(cx, window, "Hello world") - 1.0;
        act(cx, window, |window, cx| {
            window.drag(
                point(px(from), px(LINE_MID)),
                point(px(to), px(LINE_MID)),
                cx,
            );
        });
        assert_eq!(copy(cx, window).as_deref(), Some("world"));
    }

    #[gpui_kit::test]
    fn a_drag_starting_on_inline_code_copies_the_code(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "Run `cargo test` now please", Body::Markdown);
        act(cx, window, |window, cx| {
            window.drag(
                point(px(1.0), px(LINE_MID)),
                point(px(299.0), px(LINE_MID)),
                cx,
            );
        });
        assert_eq!(
            copy(cx, window).as_deref(),
            Some("Run cargo test now please")
        );
    }

    #[gpui_kit::test]
    fn double_click_selects_a_word_and_triple_click_a_paragraph(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "Hello world and more\n\nSecond one", Body::Markdown);
        let on_world = x_after(cx, window, "Hello ") + 8.0;
        act(cx, window, |window, cx| {
            window.click_with_options(
                "probe",
                ClickOptions::new()
                    .with_count(2)
                    .with_offset(point(px(on_world), px(LINE_MID))),
                cx,
            );
        });
        assert_eq!(copy(cx, window).as_deref(), Some("world"));
        act(cx, window, |window, cx| {
            window.click_with_options(
                "probe",
                ClickOptions::new()
                    .with_count(3)
                    .with_offset(point(px(on_world), px(LINE_MID))),
                cx,
            );
        });
        assert_eq!(copy(cx, window).as_deref(), Some("Hello world and more"));
    }

    #[gpui_kit::test]
    fn a_plain_click_on_a_link_still_opens_it_and_selects_nothing(cx: &mut TestAppContext) {
        let (window, _, opened) =
            open(cx, "See [main](file:///ws/src/main.rs) now", Body::Markdown);
        let on_link = x_after(cx, window, "See ") + 4.0;
        act(cx, window, |window, cx| {
            window.click_with_options(
                "probe",
                ClickOptions::new().with_offset(point(px(on_link), px(LINE_MID))),
                cx,
            );
        });
        assert_eq!(opened.borrow().as_slice(), ["src/main.rs"]);
        assert!(!has_selection(cx, window), "a click is not a selection");
    }

    #[gpui_kit::test]
    fn a_drag_inside_a_link_selects_and_does_not_open_it(cx: &mut TestAppContext) {
        let (window, _, opened) = open(
            cx,
            "See [documentation](file:///ws/docs/index.md) now",
            Body::Markdown,
        );
        let from = x_after(cx, window, "See ") + 1.0;
        let to = x_after(cx, window, "See documentation") - 1.0;
        act(cx, window, |window, cx| {
            window.drag(
                point(px(from), px(LINE_MID)),
                point(px(to), px(LINE_MID)),
                cx,
            );
        });
        assert!(opened.borrow().is_empty(), "opened {:?}", opened.borrow());
        assert_eq!(copy(cx, window).as_deref(), Some("documentation"));
    }

    #[gpui_kit::test]
    fn a_click_elsewhere_clears_the_selection(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "Hello world\n\nSecond paragraph", Body::Markdown);
        act(cx, window, |window, cx| {
            window.drag(
                point(px(1.0), px(LINE_MID)),
                point(px(299.0), px(LINE_MID)),
                cx,
            );
        });
        assert!(has_selection(cx, window));
        act(cx, window, |window, cx| {
            window.pointer_down(point(px(150.0), px(400.0)), gpui_kit::MouseButton::Left, cx);
            window.pointer_up(point(px(150.0), px(400.0)), gpui_kit::MouseButton::Left, cx);
        });
        assert!(!has_selection(cx, window));
        assert_eq!(
            copy(cx, window).unwrap_or_default(),
            "",
            "nothing is left to copy"
        );
    }

    #[gpui_kit::test]
    fn escape_clears_the_selection_and_is_used_only_then(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "Hello world", Body::Markdown);
        let escape = gpui_kit::KeyDownEvent {
            keystroke: gpui_kit::Keystroke::parse("escape").expect("a valid keystroke"),
            is_held: false,
            prefer_character_input: false,
        };
        let used = |cx: &mut TestAppContext| {
            cx.update_window(window, |_, window, cx| clear_on_escape(&escape, window, cx))
                .unwrap_or(false)
        };
        assert!(!used(cx), "nothing is selected: Escape goes on to others");
        act(cx, window, |window, cx| {
            window.drag(
                point(px(1.0), px(LINE_MID)),
                point(px(299.0), px(LINE_MID)),
                cx,
            );
        });
        assert!(has_selection(cx, window));
        assert!(used(cx));
        assert!(!has_selection(cx, window));
    }

    #[gpui_kit::test]
    fn user_message_text_selects_and_copies(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "Please review the plan", Body::UserText);
        let from = x_after(cx, window, "Please ") + 1.0;
        let to = x_after(cx, window, "Please review") - 1.0;
        act(cx, window, |window, cx| {
            window.drag(
                point(px(from), px(LINE_MID)),
                point(px(to), px(LINE_MID)),
                cx,
            );
        });
        assert_eq!(copy(cx, window).as_deref(), Some("review"));
    }

    #[gpui_kit::test]
    fn scrolling_keeps_the_selection_on_its_text(cx: &mut TestAppContext) {
        let source = "Anchor paragraph.\n\nTwo\n\nThree\n\nFour\n\nFive\n\nSix\n\nSeven";
        let (window, _, _) = open(cx, source, Body::Scrolling);
        act(cx, window, |window, cx| {
            window.drag(
                point(px(1.0), px(LINE_MID)),
                point(px(299.0), px(LINE_MID)),
                cx,
            );
        });
        assert_eq!(copy(cx, window).as_deref(), Some("Anchor paragraph."));
        act(cx, window, |window, cx| {
            window.scroll("probe", ScrollDelta::Pixels(point(px(0.0), px(-12.0))), cx);
        });
        assert!(has_selection(cx, window));
        assert_eq!(
            copy(cx, window).as_deref(),
            Some("Anchor paragraph."),
            "the selection moves with the text it covers"
        );
    }

    #[gpui_kit::test]
    fn a_drag_across_two_messages_copies_both_in_order(cx: &mut TestAppContext) {
        let (window, _, _) = open(cx, "First message.", Body::TwoMessages);
        act(cx, window, |window, cx| {
            window.drag(
                point(px(1.0), px(LINE_MID)),
                point(px(299.0), px(700.0)),
                cx,
            );
        });
        assert_eq!(
            copy(cx, window).as_deref(),
            Some("First message.\n\nSecond message.")
        );
    }

    #[gpui_kit::test]
    fn the_highlight_uses_the_theme_selection_token_in_dark_and_light(cx: &mut TestAppContext) {
        for id in ["dark-ocean", "t3-code-light"] {
            let tokens = tokens(id);
            let (selection, kit) = cx.update(|cx| {
                gpui_kit::init(cx);
                crate::theme::apply_kit_theme(&tokens, cx);
                (
                    selection_color(cx),
                    gpui_kit::component::Theme::global(cx).colors.selection,
                )
            });
            assert_eq!(
                selection, kit,
                "{id}: the flow paints the kit's selection token"
            );
            assert!(selection.a > 0.0, "{id}: the highlight is visible");
        }
    }

    #[test]
    fn scopes_order_rows_and_the_flows_inside_them() {
        let top = SelectionScope::for_row(0);
        let first = top.next_order();
        let second = top.next_order();
        let below = SelectionScope::for_row(1).next_order();
        assert!(first < second, "flows follow the order they are built in");
        assert!(second < below, "a later row sorts after an earlier one");
    }
}
