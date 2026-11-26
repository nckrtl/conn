//! The Browser panel's new-tab page, from Conn's `PreviewEmptyState` and `PreviewRecentUrlCard`:
//! the project's recently used pages as clickable, removable rows, or "No preview yet" when there
//! are none. Local server discovery is not part of this port.

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, Window, div, px,
};
use url::Url;

use super::BrowserPanel;
use super::history::{BrowserHistory, HistoryEntry, MAX_ENTRIES_PER_PROJECT};
use super::visits::now_ms;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::alpha;
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::sidebar::tree::focus_ring;

/// `recents.slice(0, 8)`.
const RECENT_LIMIT: usize = 8;
/// `text-sm`: 14px / 20px.
const TEXT_PX: f32 = 14.0;
const TEXT_LINE_PX: f32 = 20.0;
/// `text-xs`: 12px / 16px.
const META_PX: f32 = 12.0;
const META_LINE_PX: f32 = 16.0;
/// `px-5 py-8`.
const PAGE_PAD_X_PX: f32 = 20.0;
const PAGE_PAD_Y_PX: f32 = 32.0;
/// `max-w-xl`.
const CONTENT_MAX_WIDTH_PX: f32 = 576.0;
/// `gap-3` between the heading, the list and its notes.
const SECTION_GAP_PX: f32 = 12.0;
/// `rounded-xl` list card.
const LIST_RADIUS_PX: f32 = 12.0;
/// `px-3 py-3 pr-10 gap-3` row.
const ROW_PAD_PX: f32 = 12.0;
const ROW_PAD_END_PX: f32 = 40.0;
const ROW_GAP_PX: f32 = 12.0;
/// `size-7` icon.
const ICON_PX: f32 = 28.0;
/// The remove button: `right-3 rounded p-1`, a `size-3.5` glyph.
const REMOVE_RIGHT_PX: f32 = 12.0;
const REMOVE_PAD_PX: f32 = 4.0;
const REMOVE_RADIUS_PX: f32 = 4.0;
const REMOVE_GLYPH_PX: f32 = 14.0;
/// `Empty` media tile (`size-9`) and its glyph (`size-4.5`).
const EMPTY_TILE_PX: f32 = 36.0;
const EMPTY_TILE_RADIUS_PX: f32 = 8.0;
const EMPTY_GLYPH_PX: f32 = 18.0;
/// `Empty`: `max-w-sm`, media `mb-6`, title `text-xl` (20px / 28px).
const EMPTY_MAX_WIDTH_PX: f32 = 384.0;
const EMPTY_GAP_PX: f32 = 24.0;
const EMPTY_TITLE_PX: f32 = 20.0;
const EMPTY_TITLE_LINE_PX: f32 = 28.0;

/// One row of the list, ready to draw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecentRow {
    pub(super) url: String,
    /// The page title, or the address when it has none.
    pub(super) primary: String,
    /// `address · 5m ago`, or `5m ago` when the primary line is the address.
    pub(super) detail: String,
    /// The address as the row names it.
    pub(super) label: String,
}

/// Where the keyboard goes when the row `index` of `count` is removed: the row that takes its
/// place, else the one above, else the panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AfterRemove {
    NextRow,
    PreviousRow,
    Panel,
}

fn after_remove(index: usize, count: usize) -> AfterRemove {
    if index + 1 < count {
        AfterRemove::NextRow
    } else if count > 1 {
        AfterRemove::PreviousRow
    } else {
        AfterRemove::Panel
    }
}

/// The recent rows for a project's history: pages whose address parses, at most eight.
pub(super) fn recent_rows(entries: &[HistoryEntry], now: i64) -> Vec<RecentRow> {
    entries
        .iter()
        .filter_map(|entry| {
            let label = url_label(&entry.url)?;
            let title = entry.title.as_deref().filter(|title| !title.is_empty());
            let time = relative_time_label(entry.last_visited_at, now);
            let detail = match (title, time) {
                (Some(_), Some(time)) => format!("{label} · {time}"),
                (Some(_), None) => label.clone(),
                (None, time) => time.unwrap_or_default(),
            };
            Some(RecentRow {
                url: entry.url.clone(),
                primary: title.map_or_else(|| label.clone(), str::to_owned),
                detail,
                label,
            })
        })
        .take(RECENT_LIMIT)
        .collect()
}

/// `host + path + search + hash`, as `PreviewRecentUrlCard`: the host keeps a non-default port and
/// a bare `/` path is dropped.
fn url_label(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    let mut label = parsed.host_str()?.to_owned();
    if let Some(port) = parsed.port() {
        label.push(':');
        label.push_str(&port.to_string());
    }
    if parsed.path() != "/" {
        label.push_str(parsed.path());
    }
    if let Some(query) = parsed.query().filter(|query| !query.is_empty()) {
        label.push('?');
        label.push_str(query);
    }
    if let Some(fragment) = parsed.fragment().filter(|fragment| !fragment.is_empty()) {
        label.push('#');
        label.push_str(fragment);
    }
    Some(label)
}

/// `RelativeTime`: `just now`, `{m}m ago`, `{h}h ago`, `{d}d ago`. `None` for a timestamp
/// outside the range a date holds (`isValidHistoryTimestamp`).
fn relative_time_label(at_ms: i64, now: i64) -> Option<String> {
    if !super::history::is_valid_timestamp(at_ms) {
        return None;
    }
    let seconds = now.saturating_sub(at_ms).max(0) / 1000;
    if seconds < 60 {
        return Some("just now".to_owned());
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return Some(format!("{minutes}m ago"));
    }
    let hours = minutes / 60;
    if hours < 24 {
        return Some(format!("{hours}h ago"));
    }
    Some(format!("{}d ago", hours / 24))
}

impl BrowserPanel {
    /// Whether the panel shows the new-tab page: the page the user asked for is blank, and so is
    /// the page in the view. A failed load shows its own error over it.
    pub(super) fn recent_page_visible(&self) -> bool {
        super::is_blank_page(&self.url) && super::is_blank_page(&self.current_url())
    }

    /// The project's rows, newest first. None while the project is not known.
    fn recent_rows(&self) -> Vec<RecentRow> {
        let history = BrowserHistory::global();
        // Noted before the pages are read: a change in between draws once more, never not at all.
        self.shown_history_revision.set(history.revision());
        let Some(key) = self.visits.project_key() else {
            return Vec::new();
        };
        let entries = history.recent(key, MAX_ENTRIES_PER_PROJECT);
        recent_rows(&entries, now_ms())
    }

    /// Opens a row's page the way the address bar does, so it moves up in the history. The page
    /// takes the keyboard, as Conn focuses the page it opens.
    fn open_recent(&mut self, url: String, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.navigate(url, cx);
        window.focus(&self.focus_handle, cx);
    }

    /// Forgets a row's page, keeping the keyboard where it was in the list: the removed row's
    /// buttons are about to leave, so focus moves first. Every panel that shows the new-tab page
    /// refreshes from the history's own change event; this panel also redraws at once.
    fn remove_recent(
        &mut self,
        url: &str,
        after: AfterRemove,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        match after {
            AfterRemove::NextRow => window.focus_next(cx),
            // Back over this row's remove and open buttons, onto the previous row's open button.
            AfterRemove::PreviousRow => {
                for _ in 0..3 {
                    window.focus_prev(cx);
                }
            }
            AfterRemove::Panel => window.focus(&self.focus_handle, cx),
        }
        if let Some(key) = self.visits.project_key() {
            BrowserHistory::global().remove(key, url);
        }
        cx.notify();
    }

    /// The new-tab page over the page area. `notice` is the runtime's warm-up or failure line.
    pub(super) fn render_recent_page(
        &self,
        notice: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let muted = to_hsla(self.tokens.muted_foreground);
        let rows = self.recent_rows();
        let notice = notice.map(|text| {
            div()
                .px(px(4.0))
                .text_size(px(META_PX))
                .line_height(px(META_LINE_PX))
                .text_color(muted)
                .child(text)
        });
        let content = if rows.is_empty() {
            self.render_recent_empty(notice).into_any_element()
        } else {
            self.render_recent_list(rows, notice, cx).into_any_element()
        };
        // `RightPanelTabs.tsx` re-roots `--background` to `--shell-card` for the preview, so the
        // page and its list are `shell_card`. The page is drawn over a view that forwards its
        // clicks to Chromium: keep them here.
        v_flex()
            .id("browser-recent-page")
            .a11y_group("browser.recent-page", "New tab")
            .absolute()
            .inset_0()
            .items_center()
            .px(px(PAGE_PAD_X_PX))
            .py(px(PAGE_PAD_Y_PX))
            .bg(to_hsla(self.tokens.shell_card))
            .overflow_y_scroll()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Middle, |_, _, cx| cx.stop_propagation())
            .child(content)
            .into_any_element()
    }

    /// `Empty`: "No preview yet".
    fn render_recent_empty(&self, notice: Option<gpui_kit::Div>) -> gpui_kit::Div {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        v_flex()
            .flex_1()
            .w_full()
            .max_w(px(EMPTY_MAX_WIDTH_PX))
            .items_center()
            .justify_center()
            .gap(px(EMPTY_GAP_PX))
            .text_center()
            .child(
                div()
                    .size(px(EMPTY_TILE_PX))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(EMPTY_TILE_RADIUS_PX))
                    .bg(to_hsla(self.tokens.shell_tile))
                    .border_1()
                    .border_color(to_hsla(self.tokens.shell_tile_border))
                    .child(superhero_icon("superhero/globe.svg", EMPTY_GLYPH_PX, muted)),
            )
            .child(
                v_flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(EMPTY_TITLE_PX))
                            .line_height(px(EMPTY_TITLE_LINE_PX))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(fg)
                            .child("No preview yet"),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_PX))
                            .line_height(px(TEXT_LINE_PX))
                            .text_color(muted)
                            .child("Type a URL above to open a page."),
                    ),
            )
            .children(notice)
    }

    /// "Recently used": the heading and the card of rows.
    fn render_recent_list(
        &self,
        rows: Vec<RecentRow>,
        notice: Option<gpui_kit::Div>,
        cx: &mut Context<'_, Self>,
    ) -> gpui_kit::Div {
        let muted = to_hsla(self.tokens.muted_foreground);
        let count = rows.len();
        let list = rows.into_iter().enumerate().fold(
            v_flex()
                .id("browser-recent-list")
                .a11y_group("browser.recent", "Recently used")
                .w_full()
                .overflow_hidden()
                .rounded(px(LIST_RADIUS_PX))
                .border_1()
                .border_color(alpha(self.tokens.border, 0.7))
                .bg(to_hsla(self.tokens.shell_card)),
            |list, (index, row)| list.child(self.render_recent_row(index, count, row, cx)),
        );
        v_flex()
            .w_full()
            .max_w(px(CONTENT_MAX_WIDTH_PX))
            .gap(px(SECTION_GAP_PX))
            .child(
                h_flex()
                    .gap(px(8.0))
                    .items_center()
                    .text_size(px(TEXT_PX))
                    .line_height(px(TEXT_LINE_PX))
                    .text_color(muted)
                    .child(superhero_icon("superhero/history.svg", 16.0, muted))
                    .child(div().font_weight(FontWeight::MEDIUM).child("Recently used")),
            )
            .child(list)
            .children(notice)
    }

    /// `PreviewRecentUrlCard`: the open button, and the remove button that shows on hover or
    /// keyboard focus. Both are tab stops; `Enter` and `Space` press the one that has focus
    /// (GPUI turns them into a click). Element ids follow the address, not the position, so the
    /// keyboard stays on a row when the rows above it change.
    fn render_recent_row(
        &self,
        index: usize,
        count: usize,
        row: RecentRow,
        cx: &mut Context<'_, Self>,
    ) -> impl IntoElement {
        let fg = to_hsla(self.tokens.foreground);
        let muted = to_hsla(self.tokens.muted_foreground);
        let hover = alpha(self.tokens.accent, 0.4);
        let accent = to_hsla(self.tokens.accent);
        let divider = alpha(self.tokens.border, 0.6);
        let group = SharedString::from(format!("browser-recent-{index}"));
        let remove_group = SharedString::from(format!("browser-recent-{index}-remove"));
        let open_url = row.url.clone();
        let remove_url = row.url.clone();
        let after = after_remove(index, count);
        // `focus-visible:ring-2 ring-inset`, as the sidebar's rows.
        let open_ring = focus_ring(&self.tokens);
        let remove_ring = open_ring.clone();

        let open = h_flex()
            .id(SharedString::from(format!(
                "browser-recent-open:{}",
                row.url
            )))
            .a11y_button(
                format!("browser.recent.{index}.open"),
                format!("Open {}", row.primary),
            )
            .w_full()
            .gap(px(ROW_GAP_PX))
            .pl(px(ROW_PAD_PX))
            .pr(px(ROW_PAD_END_PX))
            .py(px(ROW_PAD_PX))
            .items_center()
            .cursor_pointer()
            .tab_index(0)
            .focus_visible(move |style| style.shadow(vec![open_ring]))
            .hover(move |style| style.bg(hover))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.open_recent(open_url.clone(), window, cx);
            }))
            .child(self.render_page_icon())
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(TEXT_PX))
                            .line_height(px(TEXT_LINE_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(row.primary.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(META_PX))
                            .line_height(px(META_LINE_PX))
                            .text_color(muted)
                            .child(row.detail),
                    ),
            );

        let remove = div()
            .absolute()
            .top_0()
            .bottom_0()
            .right(px(REMOVE_RIGHT_PX))
            .flex()
            .items_center()
            .child(
                div()
                    .id(SharedString::from(format!(
                        "browser-recent-remove:{}",
                        row.url
                    )))
                    .a11y_button(
                        format!("browser.recent.{index}.remove"),
                        format!("Remove {} from history", row.label),
                    )
                    .group(remove_group.clone())
                    .p(px(REMOVE_PAD_PX))
                    .rounded(px(REMOVE_RADIUS_PX))
                    .cursor_pointer()
                    // Not `invisible()`: a hidden element cannot take keyboard focus.
                    .opacity(0.0)
                    .group_hover(group.clone(), |style| style.opacity(1.0))
                    .tab_index(0)
                    .focus_visible(move |style| style.opacity(1.0).shadow(vec![remove_ring]))
                    .hover(move |style| style.bg(accent))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.remove_recent(&remove_url, after, window, cx);
                    }))
                    .child(
                        superhero_icon("superhero/close.svg", REMOVE_GLYPH_PX, muted)
                            .group_hover(remove_group, move |style| style.text_color(fg)),
                    ),
            );

        div()
            .id(group.clone())
            .group(group)
            .a11y_group(format!("browser.recent.{index}"), row.label)
            .relative()
            .w_full()
            .when(index > 0, |el| el.border_t_1().border_color(divider))
            .child(open)
            .child(remove)
    }

    /// `BrowserMockup`: a tiny page in place of a favicon.
    fn render_page_icon(&self) -> gpui_kit::Div {
        let dot = |color: gpui_kit::Hsla| div().size(px(3.0)).rounded_full().bg(color);
        let bar = |width_px: f32, a: f32| {
            div()
                .h(px(2.0))
                .w(px(width_px))
                .rounded_full()
                .bg(alpha(self.tokens.muted_foreground, a))
        };
        v_flex()
            .size(px(ICON_PX))
            .flex_none()
            .gap(px(2.0))
            .p(px(4.0))
            .overflow_hidden()
            .rounded(px(4.0))
            .border_1()
            .border_color(alpha(self.tokens.border, 0.6))
            .bg(to_hsla(self.tokens.card))
            .child(
                h_flex()
                    .gap(px(2.0))
                    .child(dot(alpha(self.tokens.destructive, 0.8)))
                    .child(dot(alpha(self.tokens.warning, 0.8)))
                    .child(dot(alpha(self.tokens.success, 0.8))),
            )
            .child(
                v_flex()
                    .mt(px(1.0))
                    .gap(px(2.0))
                    .child(bar(18.0, 0.3))
                    .child(bar(10.8, 0.2)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn entry(url: &str, ago_ms: i64, title: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            url: url.to_owned(),
            last_visited_at: NOW - ago_ms,
            title: title.map(str::to_owned),
        }
    }

    #[test]
    fn the_address_label_is_host_path_search_and_hash() {
        assert_eq!(
            url_label("https://example.com/").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            url_label("http://localhost:3000/a/b?x=1#top").as_deref(),
            Some("localhost:3000/a/b?x=1#top")
        );
        assert_eq!(
            url_label("https://example.com:443/docs").as_deref(),
            Some("example.com/docs")
        );
        assert_eq!(url_label("not a url"), None);
    }

    #[test]
    fn times_read_like_the_relative_time_component() {
        let label = |ago_ms: i64| relative_time_label(NOW - ago_ms, NOW);
        assert_eq!(label(0).as_deref(), Some("just now"));
        assert_eq!(label(59_000).as_deref(), Some("just now"));
        assert_eq!(label(5 * 60_000).as_deref(), Some("5m ago"));
        assert_eq!(label(3 * 3_600_000).as_deref(), Some("3h ago"));
        assert_eq!(label(2 * 86_400_000).as_deref(), Some("2d ago"));
        // A visit stamped ahead of this clock is not negative.
        assert_eq!(label(-5_000).as_deref(), Some("just now"));
        assert_eq!(relative_time_label(i64::MAX, NOW), None);
        assert_eq!(relative_time_label(i64::MIN, NOW), None);
    }

    #[test]
    fn a_titled_row_names_the_address_beside_the_time() {
        let rows = recent_rows(
            &[
                entry("http://localhost:3000/", 120_000, Some("Dev")),
                entry("https://example.com/docs", 7_200_000, None),
            ],
            NOW,
        );
        assert_eq!(rows[0].primary, "Dev");
        assert_eq!(rows[0].detail, "localhost:3000 · 2m ago");
        assert_eq!(rows[0].label, "localhost:3000");
        assert_eq!(rows[0].url, "http://localhost:3000/");
        assert_eq!(rows[1].primary, "example.com/docs");
        assert_eq!(rows[1].detail, "2h ago");
    }

    #[test]
    fn removing_a_row_hands_the_keyboard_to_a_neighbour_or_the_panel() {
        assert_eq!(after_remove(0, 3), AfterRemove::NextRow);
        assert_eq!(after_remove(1, 3), AfterRemove::NextRow);
        assert_eq!(after_remove(2, 3), AfterRemove::PreviousRow);
        assert_eq!(after_remove(0, 1), AfterRemove::Panel);
    }

    #[test]
    fn an_empty_title_is_no_title() {
        let rows = recent_rows(&[entry("https://example.com/", 0, Some(""))], NOW);
        assert_eq!(rows[0].primary, "example.com");
        assert_eq!(rows[0].detail, "just now");
    }

    #[test]
    fn rows_skip_unparsable_addresses_and_stop_at_eight() {
        let mut entries = vec![entry("not a url", 0, None)];
        entries.extend((0..12).map(|i| entry(&format!("https://example.com/{i}"), i, None)));
        let rows = recent_rows(&entries, NOW);
        assert_eq!(rows.len(), RECENT_LIMIT);
        assert_eq!(rows[0].url, "https://example.com/0");
    }
}
