//! The Database panel with no connection chosen (`NoConnection` in the desktop lab's
//! `DatabasePanel.tsx`, styled by `.lab-db-empty*` in `DatabasePanel.css`): a centred block
//! near the top with a mark, a title, a balanced description, an add button, and the
//! connections the user can pick from.

use conn_desktop::database::api::{ConnectionSource, PanelConnection, connection_target};
use conn_desktop::vault::VaultErrorKind;
use conn_theme::Tokens;
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Font, FontWeight, IntoElement, ParentElement, Pixels, Role, SharedString,
    Styled, TextRun, Window, div, px,
};

use super::DatabasePanel;
use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::panels::chrome::{UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::theme::MONO_FONT;

/// `.lab-db-empty` top padding is `max(32px, 8vh)`.
const TOP_PAD_MIN_PX: f32 = 32.0;
const TOP_PAD_VIEWPORT_RATIO: f32 = 0.08;
/// `.lab-db-empty-mark`: a 40px rounded square with a 16px glyph.
const MARK_PX: f32 = 40.0;
const MARK_RADIUS_PX: f32 = 10.0;
const MARK_GLYPH_PX: f32 = 16.0;
/// `.lab-db-empty p`: at most 380px wide, 19px lines.
const DESCRIPTION_MAX_WIDTH_PX: f32 = 380.0;
const DESCRIPTION_LINE_HEIGHT_PX: f32 = 19.0;
/// `.lab-db-empty code`: 12px monospace.
const CODE_TEXT_PX: f32 = 12.0;
/// `.lab-db-empty section`: 300px wide lists.
const LIST_MAX_WIDTH_PX: f32 = 300.0;
const ADD_BUTTON_HEIGHT_PX: f32 = 32.0;
const PILL_RADIUS_PX: f32 = 9999.0;

/// One word of the description; `mono` words are the `<code>` ones. `suffix` is plain text that
/// touches the word, such as the full stop after a `<code>` word.
struct Word {
    text: &'static str,
    mono: bool,
    suffix: &'static str,
}

const fn word(text: &'static str) -> Word {
    Word {
        text,
        mono: false,
        suffix: "",
    }
}

const fn code(text: &'static str, suffix: &'static str) -> Word {
    Word {
        text,
        mono: true,
        suffix,
    }
}

/// "This project's `.env` has no `DB_CONNECTION`. Connect a database to browse its tables and
/// run read-only queries."
fn no_env_description() -> Vec<Word> {
    vec![
        word("This"),
        word("project's"),
        code(".env", ""),
        word("has"),
        word("no"),
        code("DB_CONNECTION", "."),
        word("Connect"),
        word("a"),
        word("database"),
        word("to"),
        word("browse"),
        word("its"),
        word("tables"),
        word("and"),
        word("run"),
        word("read-only"),
        word("queries."),
    ]
}

fn disconnected_description() -> Vec<Word> {
    "Pick a connection to browse its tables and run read-only queries."
        .split(' ')
        .map(word)
        .collect()
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
pub(super) fn split_lines(widths: &[Pixels], space: Pixels, max: Pixels) -> Vec<Vec<usize>> {
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
            text_width(window, w.text, size, w.mono)
                + text_width(window, w.suffix, UI_TEXT_PX, false)
        })
        .collect();
    let space = text_width(window, " ", UI_TEXT_PX, false);
    split_lines(&widths, space, max)
}

impl DatabasePanel {
    /// Connections the empty state lists: the `.env` one, then the saved ones.
    fn known_connections(&self) -> Vec<PanelConnection> {
        let mut known = Vec::new();
        known.extend(self.env_connection.clone());
        if let Some(key) = self.project_key.as_deref() {
            known.extend_from_slice(self.store.saved_connections(key));
        }
        known
    }

    pub(super) fn render_empty_no_connection(
        &self,
        window: &Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let raised = to_hsla(tokens.shell_control);
        let line = to_hsla(tokens.shell_divider_header);
        let hover = to_hsla(tokens.shell_highlight);

        let known = self.known_connections();
        let vault_waiting = matches!(
            self.vault_status,
            Some(VaultErrorKind::Locked | VaultErrorKind::Error)
        );
        let show_vault = !self.vault_connections.is_empty() || vault_waiting;

        let words = if self.env_connection.is_some() {
            disconnected_description()
        } else {
            no_env_description()
        };
        let lines = balanced_lines(window, &words, px(DESCRIPTION_MAX_WIDTH_PX));
        let space = text_width(window, " ", UI_TEXT_PX, false);
        let description_text = words
            .iter()
            .map(|w| format!("{}{}", w.text, w.suffix))
            .collect::<Vec<_>>()
            .join(" ");
        let mut description = v_flex()
            .id("db-empty-description")
            .test_support()
            .a11y_group("panel.database.empty.description", description_text)
            .max_w(px(DESCRIPTION_MAX_WIDTH_PX))
            .items_center()
            .mb(px(16.0))
            .text_color(muted)
            .text_size(px(UI_TEXT_PX))
            .line_height(px(DESCRIPTION_LINE_HEIGHT_PX));
        for (index, line_words) in lines.iter().enumerate() {
            let mut row = h_flex()
                .id(SharedString::from(format!("db-empty-description-{index}")))
                .test_support()
                .gap(space)
                .justify_center();
            for &at in line_words {
                let word = &words[at];
                row = row.child(if word.mono {
                    h_flex()
                        .child(
                            div()
                                .font_family(SharedString::from(MONO_FONT))
                                .text_size(px(CODE_TEXT_PX))
                                .text_color(fg)
                                .child(word.text),
                        )
                        .child(word.suffix)
                        .into_any_element()
                } else {
                    div().child(word.text).into_any_element()
                });
            }
            description = description.child(row);
        }

        let mark = div()
            .id("db-empty-mark")
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
            .child(superhero_icon(
                "superhero/database.svg",
                MARK_GLYPH_PX,
                muted,
            ));

        let title = div()
            .id("db-empty-title")
            .test_support()
            .a11y(
                Role::Heading,
                "panel.database.empty.title",
                "No database connected",
            )
            .mb(px(6.0))
            .text_size(px(14.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child("No database connected");

        let add_button = h_flex()
            .id("db-empty-add")
            .test_support()
            .a11y_button("panel.database.empty.add", "Add connection")
            .h(px(ADD_BUTTON_HEIGHT_PX))
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
            .on_click({
                move |_, window, cx| {
                    entity.update(cx, |panel, cx| panel.begin_add_connection(true, window, cx));
                }
            })
            .child(superhero_icon("superhero/add.svg", 14.0, fg))
            .child("Add connection");

        let mut block = v_flex()
            .id("db-empty")
            .test_support()
            .a11y_group("panel.database.empty", "Database connections")
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
            .child(title)
            .child(description)
            .child(add_button);

        let heading_style = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .test_support()
                .a11y(Role::Heading, format!("panel.database.empty.{id}"), label)
                .px(px(10.0))
                .mb(px(6.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(label)
        };

        if !known.is_empty() {
            let mut section = v_flex()
                .id("db-empty-connections")
                .test_support()
                .a11y_group("panel.database.empty.connections", "Project connections")
                .w_full()
                .max_w(px(LIST_MAX_WIDTH_PX))
                .mt(px(32.0))
                .gap(px(2.0))
                .text_left()
                .child(heading_style("db-empty-connections-heading", "Connections"));
            for connection in &known {
                section = section.child(self.empty_row(connection, cx));
            }
            block = block.child(section);
        }

        if show_vault {
            let heading = if known.is_empty() {
                "Or pick one from Vault"
            } else {
                "Vault"
            };
            let mut section = v_flex()
                .id("db-empty-vault")
                .test_support()
                .a11y_group("panel.database.empty.vault", "Vault databases")
                .w_full()
                .max_w(px(LIST_MAX_WIDTH_PX))
                .mt(px(if known.is_empty() { 32.0 } else { 16.0 }))
                .gap(px(2.0))
                .text_left()
                .child(heading_style("db-empty-vault-heading", heading));
            for connection in &self.vault_connections {
                section = section.child(self.empty_row(connection, cx));
            }
            match self.vault_status {
                Some(VaultErrorKind::Locked) => {
                    section = section.child(self.vault_action_row(
                        "db-empty-unlock-vault",
                        "Unlock Vault…",
                        |panel, cx| panel.unlock_vault(cx),
                        cx,
                    ));
                }
                Some(VaultErrorKind::Error) => {
                    let message = self
                        .vault_error
                        .clone()
                        .unwrap_or_else(|| "Vault unavailable".to_owned());
                    section = section
                        .child(
                            div()
                                .px(px(10.0))
                                .py(px(4.0))
                                .text_size(px(XS_TEXT_PX))
                                .line_height(px(XS_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child(message),
                        )
                        .child(self.vault_action_row(
                            "db-empty-retry-vault",
                            "Retry Vault",
                            |panel, cx| panel.retry_vault(cx),
                            cx,
                        ));
                }
                _ => {}
            }
            block = block.child(section);
        }

        block.into_any_element()
    }

    /// `.lab-db-empty section button`: icon, name, muted target, chevron.
    fn empty_row(&self, connection: &PanelConnection, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let muted = to_hsla(tokens.muted_foreground);
        let target = if connection.source == ConnectionSource::Vault {
            connection.connection.database.clone()
        } else {
            connection_target(&connection.connection, connection.ssh_host.as_deref())
        };
        let id = connection.id.clone();
        let leading: AnyElement = match (connection.source, icons::vault_mark(16.0)) {
            (ConnectionSource::Vault, Some(mark)) => mark,
            _ => div()
                .mx(px(1.0))
                .child(superhero_icon("superhero/database.svg", 14.0, muted))
                .into_any_element(),
        };
        empty_row_shell(
            tokens,
            SharedString::from(format!("db-empty-row-{id}")),
            format!("panel.database.empty.connection.{id}"),
            connection.name.clone(),
            leading,
            target,
            move |_, _, cx| {
                let id = id.clone();
                entity.update(cx, |panel, cx| panel.select_connection(&id, cx));
            },
        )
    }

    fn vault_action_row(
        &self,
        id: &'static str,
        label: &'static str,
        action: fn(&mut DatabasePanel, &mut Context<'_, DatabasePanel>),
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let entity = cx.entity();
        let muted = to_hsla(tokens.muted_foreground);
        let leading = div()
            .mx(px(1.0))
            .child(superhero_icon("superhero/lock.svg", 14.0, muted))
            .into_any_element();
        empty_row_shell(
            tokens,
            SharedString::from(id),
            format!("panel.database.empty.{id}"),
            label.to_owned(),
            leading,
            String::new(),
            move |_, _, cx| entity.update(cx, action),
        )
    }
}

fn empty_row_shell(
    tokens: &Tokens,
    id: SharedString,
    ax_id: String,
    name: String,
    leading: AnyElement,
    target: String,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let hover = to_hsla(tokens.shell_highlight);
    let mut row = h_flex()
        .id(id)
        .test_support()
        .a11y_button(ax_id, name.clone())
        .w_full()
        .min_w_0()
        .px(px(10.0))
        .py(px(7.0))
        .gap(px(8.0))
        .items_center()
        .rounded(px(8.0))
        .cursor_pointer()
        .text_size(px(UI_TEXT_PX))
        .line_height(px(UI_LINE_HEIGHT_PX))
        .text_color(fg)
        .hover(move |s| s.bg(hover))
        .on_click(on_click)
        .child(leading)
        .child(div().min_w_0().truncate().child(name));
    row = row.child(
        div()
            .ml_auto()
            .min_w_0()
            .truncate()
            .text_size(px(XS_TEXT_PX))
            .text_color(muted)
            .child(target),
    );
    row.child(superhero_icon("superhero/chevron-right.svg", 12.0, muted))
        .into_any_element()
}
