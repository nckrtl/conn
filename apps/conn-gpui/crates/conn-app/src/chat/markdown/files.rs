//! The Files panel's Markdown preview, ported from the lab's `FilesPanel.css` `.lf-markdown`.
//!
//! It shares the parser, the code card, the inline text and the highlighter with the chat. This
//! module holds what differs: type sizes, the spacing between blocks, lists, task lists, quotes,
//! tables, rules, and the source view's syntax palette.

use conn_theme::{Appearance, Rgba, Tokens, color_mix_srgb};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, FontStyle, FontWeight, HighlightStyle, Hsla, InteractiveElement as _,
    IntoElement as _, ParentElement as _, Role, StatefulInteractiveElement as _, Styled as _, div,
    px, relative,
};

use super::{
    InlineSpan, ListItem, MarkdownBlock, MarkdownOptions, ProseStyle, ax_preview, list_item_text,
    md_ax_id, md_element_id, render_block as render_shared_block, render_inline_spans,
};
use crate::a11y::ConnA11yExt as _;
use crate::chat::color::{SyntaxRole, chat_page, hsla, hsla_alpha};
use crate::chat::icons;

/// Body text: 14px on a 20px line.
pub(super) const BODY_SIZE_PX: (f32, f32) = (14.0, 20.0);
/// The code card's language name: 12px on a 16px line.
pub(super) const CODE_LABEL_PX: f32 = 12.0;
/// Space between blocks.
const BLOCK_GAP_PX: f32 = 12.0;
/// Space above a heading: H1, H2, then H3 to H6.
const H1_TOP_PX: f32 = 28.0;
const H2_TOP_PX: f32 = 24.0;
const H3_TOP_PX: f32 = 20.0;
/// Space under an H2 to H6.
const HEADING_BOTTOM_PX: f32 = 8.0;
/// Space above and below a horizontal rule.
const RULE_MARGIN_PX: f32 = 20.0;
/// A list's indent, and the gap between its items.
const LIST_INDENT_PX: f32 = 18.0;
const LIST_ITEM_GAP_PX: f32 = 4.0;
/// Space above a code card inside a list item.
const LIST_CODE_TOP_PX: f32 = 8.0;
/// The bullet of an unordered item: its size and its distance from the column's left edge.
const BULLET_PX: f32 = 5.0;
const BULLET_LEFT_PX: f32 = 7.0;
/// The room between an ordered item's number and its text.
const NUMBER_GAP_PX: f32 = 4.0;
/// A task item's checkbox: size, ring, corner radius, gap to the text, and the nudge that centres
/// it on the first line.
const CHECKBOX_PX: f32 = 14.0;
const CHECKBOX_RING_PX: f32 = 1.5;
const CHECKBOX_RADIUS_PX: f32 = 4.0;
const CHECKBOX_GAP_PX: f32 = 8.0;
const CHECKBOX_TOP_PX: f32 = 3.0;
const CHECKBOX_MARK_PX: f32 = 10.0;
/// A quote's inset (its rule is 2px).
const QUOTE_INSET_PX: f32 = 12.0;
/// A table: 13px on an 18px line, cells padded 7px above and below and 12px on the right.
const TABLE_TEXT_PX: f32 = 13.0;
const TABLE_LINE_PX: f32 = 18.0;
const TABLE_CELL_PAD_Y_PX: f32 = 7.0;
const TABLE_CELL_PAD_RIGHT_PX: f32 = 12.0;
/// The share of a table a column can ask for, in characters, and the least it keeps.
const TABLE_COLUMN_MAX_CHARS: usize = 40;
const TABLE_COLUMN_MIN_CHARS: usize = 6;

/// Lab `--line`: 8% white on dark, 8% black on light.
pub(super) fn line(tokens: &Tokens) -> Hsla {
    match tokens.appearance {
        Appearance::Dark => Hsla {
            a: 0.08,
            ..hsla(Rgba::new(1.0, 1.0, 1.0, 1.0))
        },
        Appearance::Light => Hsla {
            a: 0.08,
            ..hsla(Rgba::new(0.0, 0.0, 0.0, 1.0))
        },
    }
}

/// Lab `--raised`: the page with 8% of the text colour on dark, white on light. Inline code chips
/// sit on it.
pub(super) fn raised(tokens: &Tokens) -> Hsla {
    match tokens.appearance {
        Appearance::Dark => hsla(color_mix_srgb(chat_page(tokens), 0.92, tokens.foreground)),
        Appearance::Light => hsla(Rgba::new(1.0, 1.0, 1.0, 1.0)),
    }
}

/// The code card's body: the panel itself (lab `.m-code-body { background: var(--bg) }`), on the
/// card's slightly darker frame.
pub(super) fn code_body_background(tokens: &Tokens) -> Hsla {
    hsla(chat_page(tokens))
}

/// Size, line height, weight and colour of an H1 to H6: 20/28, 16/24, then 14/20, all semibold.
pub(super) fn heading_type(level: u8, tokens: &Tokens) -> (f32, f32, FontWeight, Hsla) {
    let (font, line) = match level {
        1 => (20.0, 28.0),
        2 => (16.0, 24.0),
        _ => (14.0, 20.0),
    };
    (font, line, FontWeight::SEMIBOLD, hsla(tokens.foreground))
}

/// A colour from a `0xRRGGBB` value.
fn hex(value: u32) -> Hsla {
    let channel = |shift: u32| ((value >> shift) & 0xff) as f32 / 255.0;
    hsla(Rgba::new(channel(16), channel(8), channel(0), 1.0))
}

/// The Files source view's palette (`.lf-source [data-syntax]`): keyword, variable, string,
/// number, call, type, and muted italic comments. Everything else keeps the text colour.
pub(super) fn syntax_style(role: SyntaxRole, tokens: &Tokens) -> HighlightStyle {
    let dark = tokens.appearance == Appearance::Dark;
    let pick = |dark_hex: u32, light_hex: u32| hex(if dark { dark_hex } else { light_hex });
    let color = match role {
        SyntaxRole::Keyword => Some(pick(0xc792dc, 0x8340a1)),
        SyntaxRole::Variable => Some(pick(0xe48a94, 0xa13c45)),
        SyntaxRole::String => Some(pick(0x98c379, 0x427329)),
        SyntaxRole::Number | SyntaxRole::Constant => Some(pick(0xdca778, 0x995620)),
        SyntaxRole::Function => Some(pick(0x72b7ec, 0x1a66a2)),
        SyntaxRole::Type => Some(pick(0x62bdc6, 0x127579)),
        SyntaxRole::Comment => Some(hsla(tokens.muted_foreground)),
        SyntaxRole::Operator | SyntaxRole::Plain => None,
    };
    HighlightStyle {
        color,
        font_style: (role == SyntaxRole::Comment).then_some(FontStyle::Italic),
        ..HighlightStyle::default()
    }
}

/// The space above `block` when it follows `previous`, as the lab's CSS sets it (the later rule
/// wins where two have the same weight): a rule keeps 20px; anything under an H2 to H6 keeps 8px;
/// a heading gets 28, 24 or 20px; any other block 12px. A rule's 20px below it merges with the
/// next block's own margin, as block margins do.
pub(super) fn top_margin(previous: Option<&MarkdownBlock>, block: &MarkdownBlock) -> f32 {
    let Some(previous) = previous else {
        return 0.0;
    };
    let own = match (previous, block) {
        (_, MarkdownBlock::ThematicBreak) => RULE_MARGIN_PX,
        (MarkdownBlock::Heading { level, .. }, _) if *level >= 2 => HEADING_BOTTOM_PX,
        (_, MarkdownBlock::Heading { level: 1, .. }) => H1_TOP_PX,
        (_, MarkdownBlock::Heading { level: 2, .. }) => H2_TOP_PX,
        (_, MarkdownBlock::Heading { .. }) => H3_TOP_PX,
        _ => BLOCK_GAP_PX,
    };
    if matches!(previous, MarkdownBlock::ThematicBreak) {
        own.max(RULE_MARGIN_PX)
    } else {
        own
    }
}

/// The blocks of a document, each with its own space above.
pub(super) fn render_blocks(
    entry_id: &str,
    blocks: &[MarkdownBlock],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let mut container = div().flex().flex_col().w_full().min_w_0();
    for (idx, block) in blocks.iter().enumerate() {
        let block_id = format!("{entry_id}-b{idx}");
        let previous = idx.checked_sub(1).and_then(|prev| blocks.get(prev));
        // `is_first` is true so a heading adds no space of its own: `top_margin` sets it.
        container = container.child(
            div()
                .w_full()
                .min_w_0()
                .mt(px(top_margin(previous, block)))
                .child(render_shared_block(
                    &block_id, block, true, false, tokens, options,
                )),
        );
    }
    container.into_any_element()
}

/// The blocks the Files preview draws itself; `None` leaves a block to the shared renderer.
pub(super) fn render_block(
    block_id: &str,
    block: &MarkdownBlock,
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> Option<AnyElement> {
    match block {
        MarkdownBlock::List {
            ordered,
            start,
            items,
        } => Some(render_list(
            block_id, *ordered, *start, items, tokens, options,
        )),
        MarkdownBlock::Blockquote(inner) => Some(render_quote(block_id, inner, tokens, options)),
        MarkdownBlock::Table { headers, rows } => {
            Some(render_table(block_id, headers, rows, tokens, options))
        }
        MarkdownBlock::ThematicBreak => Some(
            div()
                .w_full()
                .h(px(1.0))
                .bg(line(tokens))
                .into_any_element(),
        ),
        MarkdownBlock::Paragraph(_)
        | MarkdownBlock::Heading { .. }
        | MarkdownBlock::CodeBlock { .. }
        | MarkdownBlock::ArtifactTemplate(_) => None,
    }
}

/// Blocks inside a list item: 4px apart, and 8px above a code card.
fn render_item_blocks(
    block_id: &str,
    item_idx: usize,
    item: &ListItem,
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let mut body = div().flex().flex_col().flex_1().min_w_0();
    for (b_idx, inner) in item.blocks.iter().enumerate() {
        let inner_id = format!("{block_id}-i{item_idx}-{b_idx}");
        let top = if b_idx == 0 {
            0.0
        } else if matches!(inner, MarkdownBlock::CodeBlock { .. }) {
            LIST_CODE_TOP_PX
        } else {
            LIST_ITEM_GAP_PX
        };
        body = body.child(
            div()
                .w_full()
                .min_w_0()
                .mt(px(top))
                .child(render_shared_block(
                    &inner_id, inner, true, true, tokens, options,
                )),
        );
    }
    body.into_any_element()
}

/// A task item's box: a ring that fills solid with a check mark when done.
fn checkbox(checked: bool, tokens: &Tokens) -> AnyElement {
    let ink = hsla(tokens.foreground);
    let frame = div()
        .relative()
        .flex_none()
        .mt(px(CHECKBOX_TOP_PX))
        .size(px(CHECKBOX_PX))
        .rounded(px(CHECKBOX_RADIUS_PX))
        .flex()
        .items_center()
        .justify_center();
    if checked {
        frame
            .bg(ink)
            .child(icons::icon(
                icons::CHECK,
                CHECKBOX_MARK_PX,
                hsla(chat_page(tokens)),
            ))
            .into_any_element()
    } else {
        // A 1.5px ring at 35% of the text colour: the frame shows around a panel-coloured face.
        frame
            .bg(hsla_alpha(tokens.foreground, 0.35))
            .child(
                div()
                    .size(px(CHECKBOX_PX - 2.0 * CHECKBOX_RING_PX))
                    .rounded(px(CHECKBOX_RADIUS_PX - CHECKBOX_RING_PX))
                    .bg(hsla(chat_page(tokens))),
            )
            .into_any_element()
    }
}

fn render_list(
    block_id: &str,
    ordered: bool,
    start: u32,
    items: &[ListItem],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let (font_px, line_px) = BODY_SIZE_PX;
    let mut list = div()
        .id(md_element_id(block_id, "list"))
        .a11y(
            Role::List,
            md_ax_id(block_id, "list"),
            format!(
                "{} list, {} {}",
                if ordered { "Numbered" } else { "Bulleted" },
                items.len(),
                if items.len() == 1 { "item" } else { "items" }
            ),
        )
        .flex()
        .flex_col()
        .gap(px(LIST_ITEM_GAP_PX))
        .w_full()
        .min_w_0();
    for (idx, item) in items.iter().enumerate() {
        let item_kind = format!("item.{idx}");
        let body = render_item_blocks(block_id, idx, item, tokens, options);
        let row = div().flex().flex_row().items_start().w_full().min_w_0();
        let row = if let Some(checked) = item.checked {
            // Lab `.task-list-item`: no bullet, the box and the text 8px apart.
            row.gap(px(CHECKBOX_GAP_PX))
                .child(checkbox(checked, tokens))
                .child(body)
        } else if ordered {
            row.child(
                div()
                    .flex()
                    .flex_none()
                    .justify_end()
                    .w(px(LIST_INDENT_PX))
                    .pr(px(NUMBER_GAP_PX))
                    .text_size(px(font_px))
                    .line_height(px(line_px))
                    .text_color(muted)
                    .child(format!("{}.", start.saturating_add(idx as u32))),
            )
            .child(body)
        } else {
            row.child(
                div()
                    .flex_none()
                    .w(px(LIST_INDENT_PX))
                    .pl(px(BULLET_LEFT_PX))
                    .pt(px((line_px - BULLET_PX) * 0.5))
                    .child(div().size(px(BULLET_PX)).rounded_full().bg(muted)),
            )
            .child(body)
        };
        list = list.child(
            row.id(md_element_id(block_id, &item_kind))
                .a11y(
                    Role::ListItem,
                    md_ax_id(block_id, &item_kind),
                    format!(
                        "List item {}: {}",
                        idx + 1,
                        ax_preview(&list_item_text(item))
                    ),
                )
                .aria_position_in_set(idx + 1)
                .aria_size_of_set(items.len()),
        );
    }
    list.into_any_element()
}

/// A quote: a 2px rule, the text 12px in, and the text muted (strong text keeps the text colour).
fn render_quote(
    block_id: &str,
    inner: &[MarkdownBlock],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let quoted = MarkdownOptions {
        prose: Some(ProseStyle {
            color: muted,
            size: options.prose.and_then(|prose| prose.size),
        }),
        ..options.clone()
    };
    let mut quote = div()
        .id(md_element_id(block_id, "quote"))
        .a11y(Role::Blockquote, md_ax_id(block_id, "quote"), "Block quote")
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .pl(px(QUOTE_INSET_PX))
        .border_l_2()
        .border_color(line(tokens))
        .text_color(muted);
    for (idx, block) in inner.iter().enumerate() {
        let inner_id = format!("{block_id}-q{idx}");
        let previous = idx.checked_sub(1).and_then(|prev| inner.get(prev));
        quote = quote.child(
            div()
                .w_full()
                .min_w_0()
                .mt(px(top_margin(previous, block)))
                .child(render_shared_block(
                    &inner_id, block, true, false, tokens, &quoted,
                )),
        );
    }
    quote.into_any_element()
}

/// The longest cell of a column, in characters (inline code counts a little wider).
fn cell_chars(cell: &[InlineSpan]) -> usize {
    cell.iter()
        .map(|span| {
            let chars = span.text.chars().count();
            if span.style.code {
                chars + chars / 5 + 1
            } else {
                chars
            }
        })
        .sum()
}

/// Each column's share of the table. A table sizes its columns to their contents; this follows
/// the longest cell of each column, within limits, since the rows are separate rows.
fn column_shares(
    headers: &[Vec<InlineSpan>],
    rows: &[Vec<Vec<InlineSpan>>],
    columns: usize,
) -> Vec<f32> {
    let weights: Vec<f32> = (0..columns)
        .map(|column| {
            let longest = headers
                .get(column)
                .into_iter()
                .chain(rows.iter().filter_map(|row| row.get(column)))
                .map(|cell| cell_chars(cell))
                .max()
                .unwrap_or(0);
            longest.clamp(TABLE_COLUMN_MIN_CHARS, TABLE_COLUMN_MAX_CHARS) as f32
        })
        .collect();
    let total: f32 = weights.iter().sum();
    weights.into_iter().map(|weight| weight / total).collect()
}

/// A table: 13/18 text, a divider under every row, muted medium-weight headers, no fills.
fn render_table(
    block_id: &str,
    headers: &[Vec<InlineSpan>],
    rows: &[Vec<Vec<InlineSpan>>],
    tokens: &Tokens,
    options: &MarkdownOptions<'_>,
) -> AnyElement {
    let divider = line(tokens);
    let columns = headers
        .len()
        .max(rows.iter().map(Vec::len).max().unwrap_or(0));
    let shares = column_shares(headers, rows, columns);
    let mut table = div()
        .id(md_element_id(block_id, "table"))
        .a11y(
            Role::Table,
            md_ax_id(block_id, "table"),
            format!(
                "Table, {} {}, {} {}",
                rows.len(),
                if rows.len() == 1 { "row" } else { "rows" },
                columns,
                if columns == 1 { "column" } else { "columns" }
            ),
        )
        .w_full()
        .min_w_0()
        .flex()
        .flex_col();

    let divider_color = divider;
    let table_row = |kind: String, label: String, cells: &[Vec<InlineSpan>], header: bool| {
        let mut row = div()
            .id(md_element_id(block_id, &kind))
            .a11y(Role::Row, md_ax_id(block_id, &kind), label)
            .flex()
            .flex_row()
            .w_full()
            .border_b_1()
            .border_color(divider_color);
        let color = if header {
            hsla(tokens.muted_foreground)
        } else {
            hsla(tokens.foreground)
        };
        for (c_idx, cell) in cells.iter().enumerate() {
            row = row.child(
                div()
                    .flex_none()
                    .w(relative(shares.get(c_idx).copied().unwrap_or(0.0)))
                    .min_w_0()
                    .pr(px(TABLE_CELL_PAD_RIGHT_PX))
                    .py(px(TABLE_CELL_PAD_Y_PX))
                    .text_size(px(TABLE_TEXT_PX))
                    .line_height(px(TABLE_LINE_PX))
                    .text_color(color)
                    .when(header, |el| el.font_weight(FontWeight::MEDIUM))
                    .child(render_inline_spans(
                        &format!("{block_id}-{kind}-{c_idx}"),
                        cell,
                        tokens,
                        &cell_options(options, color),
                        true,
                    )),
            );
        }
        row
    };
    if !headers.is_empty() {
        table = table.child(table_row(
            "row.header".to_owned(),
            "Header row".to_owned(),
            headers,
            true,
        ));
    }
    for (r_idx, row) in rows.iter().enumerate() {
        table = table.child(table_row(
            format!("row.{r_idx}"),
            format!("Row {}", r_idx + 1),
            row,
            false,
        ));
    }
    table.into_any_element()
}

/// The options for the text in a cell, in the cell's colour.
fn cell_options<'a>(options: &MarkdownOptions<'a>, color: Hsla) -> MarkdownOptions<'a> {
    MarkdownOptions {
        prose: Some(ProseStyle {
            color,
            size: options.prose.and_then(|prose| prose.size),
        }),
        ..options.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::markdown::parse_markdown;

    fn heading(level: u8) -> MarkdownBlock {
        MarkdownBlock::Heading {
            level,
            spans: Vec::new(),
        }
    }

    fn paragraph() -> MarkdownBlock {
        MarkdownBlock::Paragraph(Vec::new())
    }

    #[test]
    fn headings_step_down_in_size() {
        let tokens = Tokens::derive(&conn_theme::theme_by_id("dark-ocean").expect("a theme"));
        let size = |level| {
            let (font, line, weight, _) = heading_type(level, &tokens);
            (font, line, weight)
        };
        assert_eq!(size(1), (20.0, 28.0, FontWeight::SEMIBOLD));
        assert_eq!(size(2), (16.0, 24.0, FontWeight::SEMIBOLD));
        for level in 3..=6 {
            assert_eq!(size(level), (14.0, 20.0, FontWeight::SEMIBOLD));
        }
    }

    #[test]
    fn blocks_sit_twelve_apart_and_headings_take_more_room_above() {
        assert_eq!(top_margin(None, &paragraph()), 0.0);
        assert_eq!(top_margin(Some(&paragraph()), &paragraph()), 12.0);
        assert_eq!(top_margin(Some(&paragraph()), &heading(1)), 28.0);
        assert_eq!(top_margin(Some(&paragraph()), &heading(2)), 24.0);
        for level in 3..=6 {
            assert_eq!(top_margin(Some(&paragraph()), &heading(level)), 20.0);
        }
    }

    #[test]
    fn anything_under_an_h2_to_h6_keeps_eight_pixels() {
        for level in 2..=6 {
            assert_eq!(top_margin(Some(&heading(level)), &paragraph()), 8.0);
        }
        // An H1 gives no such room, and the later CSS rule wins over a heading's own space.
        assert_eq!(top_margin(Some(&heading(1)), &paragraph()), 12.0);
        assert_eq!(top_margin(Some(&heading(2)), &heading(2)), 8.0);
        assert_eq!(top_margin(Some(&heading(1)), &heading(1)), 28.0);
    }

    #[test]
    fn a_rule_keeps_twenty_pixels_on_both_sides() {
        assert_eq!(
            top_margin(Some(&paragraph()), &MarkdownBlock::ThematicBreak),
            20.0
        );
        assert_eq!(
            top_margin(Some(&heading(2)), &MarkdownBlock::ThematicBreak),
            20.0
        );
        assert_eq!(
            top_margin(Some(&MarkdownBlock::ThematicBreak), &paragraph()),
            20.0
        );
        assert_eq!(
            top_margin(Some(&MarkdownBlock::ThematicBreak), &heading(1)),
            28.0,
            "a margin that is larger than the rule's wins"
        );
    }

    #[test]
    fn the_syntax_palette_is_the_source_views() {
        let dark = Tokens::derive(&conn_theme::theme_by_id("dark-ocean").expect("a theme"));
        let light = Tokens::derive(&conn_theme::theme_by_id("t3-code-light").expect("a theme"));
        assert_eq!(
            syntax_style(SyntaxRole::Keyword, &dark).color,
            Some(hex(0xc792dc))
        );
        assert_eq!(
            syntax_style(SyntaxRole::Keyword, &light).color,
            Some(hex(0x8340a1))
        );
        assert_eq!(
            syntax_style(SyntaxRole::Variable, &dark).color,
            Some(hex(0xe48a94))
        );
        assert_eq!(
            syntax_style(SyntaxRole::String, &dark).color,
            Some(hex(0x98c379))
        );
        assert_eq!(
            syntax_style(SyntaxRole::Number, &dark).color,
            Some(hex(0xdca778))
        );
        assert_eq!(
            syntax_style(SyntaxRole::Function, &dark).color,
            Some(hex(0x72b7ec))
        );
        assert_eq!(
            syntax_style(SyntaxRole::Type, &dark).color,
            Some(hex(0x62bdc6))
        );
        let comment = syntax_style(SyntaxRole::Comment, &dark);
        assert_eq!(comment.color, Some(hsla(dark.muted_foreground)));
        assert_eq!(comment.font_style, Some(FontStyle::Italic));
        assert_eq!(syntax_style(SyntaxRole::Plain, &dark).color, None);
    }

    #[test]
    fn php_variables_get_the_variable_role() {
        let blocks = parse_markdown("```php\n$total = $item->price;\n```");
        let Some(MarkdownBlock::CodeBlock { highlights, .. }) = blocks.first() else {
            panic!("expected a code block");
        };
        assert!(
            highlights
                .iter()
                .any(|span| span.role == SyntaxRole::Variable),
            "a PHP variable is a variable: {highlights:?}"
        );
    }

    #[test]
    fn php_ranges_point_into_the_snippet_not_the_added_tag() {
        let code = "$total = 1;";
        let blocks = parse_markdown(&format!("```php\n{code}\n```"));
        let Some(MarkdownBlock::CodeBlock { highlights, .. }) = blocks.first() else {
            panic!("expected a code block");
        };
        let variable = highlights
            .iter()
            .find(|span| span.role == SyntaxRole::Variable)
            .expect("a variable span");
        assert!(
            code[variable.range.clone()].contains("total"),
            "{variable:?}"
        );
    }

    #[test]
    fn shell_commands_and_options_are_not_variables() {
        let blocks = parse_markdown("```bash\nphp artisan migrate --seed\n```");
        let Some(MarkdownBlock::CodeBlock { highlights, .. }) = blocks.first() else {
            panic!("expected a code block");
        };
        assert!(
            highlights
                .iter()
                .all(|span| span.role != SyntaxRole::Variable),
            "{highlights:?}"
        );
    }

    #[test]
    fn a_table_column_follows_its_longest_cell() {
        let blocks = parse_markdown(
            "| Column | Type | Notes |\n| --- | --- | --- |\n| `number` | integer | Shown to customers |\n",
        );
        let Some(MarkdownBlock::Table { headers, rows }) = blocks.first() else {
            panic!("expected a table");
        };
        let shares = column_shares(headers, rows, 3);
        assert!((shares.iter().sum::<f32>() - 1.0).abs() < 1e-4);
        assert!(shares[2] > shares[0] && shares[0] > shares[1], "{shares:?}");
    }
}
