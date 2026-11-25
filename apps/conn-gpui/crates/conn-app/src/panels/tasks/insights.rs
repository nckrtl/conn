//! The board's 2-row insights strip and expandable per-metric detail chart.
//!
//! Port of `apps/web/src/orbit/tasks/TasksInsights.tsx`.

use crate::a11y::ConnA11yExt as _;
use std::cell::Cell;
use std::rc::Rc;

use conn_desktop::orbit::insights::{
    ChangeTone, INSIGHTS, InsightId, InsightResult, InsightSpec, format_insight_value,
    insight_by_provider, insight_change_text, insight_change_tone, insight_change_trend,
    insight_result, insight_trend,
};
use conn_desktop::orbit::tasks::{InsightsPeriod, TaskInsights};
use conn_theme::Tokens;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, Bounds, FontWeight, Pixels, ScrollHandle, SharedString, Window, div, px,
};

use super::charts::{render_sparkline, render_trend_chart};
use super::format::{insight_grid_layout, insight_hint};
use crate::panels::chrome::{self, ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;

/// Minimum width of each insight card (130px lets all 4 columns fit a standard right panel
/// without clipping while still enabling horizontal scrolling on narrower splits).
const CARD_MIN_WIDTH_PX: f32 = 130.0;
/// Value font size (`text-lg leading-6` = 18px / 24px).
const VALUE_FONT_PX: f32 = 18.0;
const VALUE_LINE_HEIGHT_PX: f32 = 24.0;
/// Height of one insight card: top border 1 + padding 10 + label 20 + gap 4 + value 24 + gap 4 +
/// sparkline 32 (4 above, 28 tall) + padding 8. Cards are set to it, so the strip's height is
/// known and the expanded chart can take exactly the same space.
const CARD_HEIGHT_PX: f32 = 103.0;

/// A single row stretches to 168px; two rows retain 103px each. Opening a
/// metric keeps that exact height so the task lanes stay in place.
fn strip_height(rows: usize) -> f32 {
    (rows as f32 * CARD_HEIGHT_PX).max(168.0)
}

/// Callbacks for user interactions inside the insights strip.
pub(super) struct InsightsCallbacks {
    pub(super) on_expand: Rc<dyn Fn(Option<InsightId>, &mut Window, &mut App)>,
    pub(super) on_hover_chart: Rc<dyn Fn(Option<usize>, &mut Window, &mut App)>,
}

/// Renders the insights strip, or `None` when every insight is hidden in settings.
#[expect(
    clippy::too_many_arguments,
    reason = "view render function receiving read-only panel state slices"
)]
pub(super) fn render_insights_strip(
    tokens: &Tokens,
    insights: Option<&TaskInsights>,
    period: InsightsPeriod,
    searching: bool,
    hidden: &[InsightId],
    expanded: Option<InsightId>,
    chart_hover: Option<usize>,
    chart_bounds: Rc<Cell<Bounds<Pixels>>>,
    scroll: &ScrollHandle,
    callbacks: InsightsCallbacks,
) -> Option<AnyElement> {
    let shown: Vec<InsightSpec> = INSIGHTS
        .iter()
        .copied()
        .filter(|spec| !hidden.contains(&spec.id))
        .collect();
    if shown.is_empty() {
        return None;
    }

    let grid = insight_grid_layout(shown.len());
    let height = strip_height(grid.rows);

    // Include the bottom rule in both views so opening a chart cannot move the lanes.
    let strip = div()
        .id("tasks-insights-strip")
        .a11y_group("panel.tasks.insights", "Task insights")
        .w_full()
        .h(px(height + 1.0))
        .flex_shrink_0()
        .overflow_hidden()
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider));
    if let Some(open_spec) = expanded.and_then(|id| shown.iter().copied().find(|s| s.id == id)) {
        let result = insight_result(insights, open_spec.id);
        return Some(
            strip
                .child(render_insight_detail(
                    tokens,
                    open_spec,
                    result,
                    insights,
                    chart_hover,
                    chart_bounds,
                    callbacks,
                ))
                .into_any_element(),
        );
    }

    let period_scope = match period {
        InsightsPeriod::Day => "Last 24 hours against the 24 before.",
        InsightsPeriod::Week => "Last 7 days against the 7 before.",
        InsightsPeriod::Month => "Last 30 days against the 30 before.",
    };
    let scope = if searching {
        format!("{period_scope} The search does not narrow these numbers.")
    } else {
        period_scope.to_owned()
    };

    let min_grid_width = grid.columns as f32 * CARD_MIN_WIDTH_PX;
    let mut rows_col = v_flex().w_full().min_w(px(min_grid_width));

    for row_idx in 0..grid.rows {
        let start = row_idx * grid.columns;
        let end = (start + grid.columns).min(shown.len());
        if start >= end {
            continue;
        }
        let mut row = h_flex().w_full().items_stretch();
        for (offset, spec) in shown[start..end].iter().copied().enumerate() {
            let index = start + offset;
            let span = if index + 1 == shown.len() {
                grid.last_span
            } else {
                1
            };
            let result = insight_result(insights, spec.id);
            let trend = insight_trend(insights, spec.id);
            let tooltip_text = format!("{} {scope}", insight_hint(spec.id, insights));
            row = row.child(render_insight_card(
                tokens,
                spec,
                result,
                trend,
                tooltip_text,
                span,
                height / grid.rows as f32,
                row_idx > 0,
                offset > 0,
                Rc::clone(&callbacks.on_expand),
            ));
        }
        rows_col = rows_col.child(row);
    }

    Some(
        strip
            .child(
                div()
                    .id("tasks-insights-scroll")
                    .size_full()
                    .overflow_x_scroll()
                    .track_scroll(scroll)
                    .child(rows_col),
            )
            .into_any_element(),
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "renders one insight tile with explicit grid layout metrics"
)]
fn render_insight_card(
    tokens: &Tokens,
    spec: InsightSpec,
    result: InsightResult,
    trend: Option<Vec<conn_desktop::orbit::insights::TrendPoint>>,
    tooltip_text: String,
    span: usize,
    height: f32,
    row_divider: bool,
    column_divider: bool,
    on_expand: Rc<dyn Fn(Option<InsightId>, &mut Window, &mut App)>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let card_hover = to_hsla(tokens.shell_highlight);

    let formatted_value = result.value.map(|v| format_insight_value(spec.id, v));
    let min_w = span as f32 * CARD_MIN_WIDTH_PX;

    let card = v_flex()
        .id(SharedString::from(format!("tasks-insight-{:?}", spec.id)))
        .a11y_button(
            format!("panel.tasks.insight.{:?}", spec.id),
            format!(
                "{}: {}",
                spec.label,
                formatted_value.as_deref().unwrap_or("no data")
            ),
        )
        .h(px(height))
        .min_w(px(min_w))
        .flex_grow(span as f32)
        .flex_shrink(1.0)
        .flex_basis(px(0.0))
        .gap(px(4.0))
        .px(px(12.0))
        .pt(px(10.0))
        .pb(px(8.0))
        .tab_index(0)
        .when(row_divider, |el| el.border_t_1())
        .when(column_divider, |el| el.border_l_1())
        .border_color(to_hsla(tokens.shell_divider))
        .cursor_pointer()
        .hover(move |s| s.bg(card_hover))
        .on_click(move |_, window, cx| on_expand(Some(spec.id), window, cx))
        .conn_tooltip(tooltip_text, tokens);

    let value_color = if formatted_value.is_some() {
        fg
    } else {
        muted.opacity(0.60)
    };

    card.child(
        div()
            .truncate()
            .text_size(px(14.0))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child(spec.label),
    )
    .child(
        h_flex()
            .min_w_0()
            .items_baseline()
            .gap(px(8.0))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(VALUE_FONT_PX))
                    .line_height(px(VALUE_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(value_color)
                    .child(formatted_value.unwrap_or_else(|| "\u{2013}".to_owned())),
            )
            .when_some(render_insight_change(tokens, spec, result), |el, change| {
                el.child(change)
            }),
    )
    .child(render_sparkline(trend.unwrap_or_default(), tokens))
    .into_any_element()
}

/// Renders the change indicator (`↘ −28%`, `↗ +39 pts`, or `No earlier data`).
fn render_insight_change(
    tokens: &Tokens,
    spec: InsightSpec,
    result: InsightResult,
) -> Option<AnyElement> {
    let text = insight_change_text(spec, result)?;
    let tone = insight_change_tone(spec, result.change);
    let color = match tone {
        ChangeTone::Good => to_hsla(tokens.success_foreground),
        ChangeTone::Bad => to_hsla(tokens.destructive_foreground),
        ChangeTone::Neutral => {
            if result.change.is_none() {
                to_hsla(tokens.muted_foreground).opacity(0.70)
            } else {
                to_hsla(tokens.muted_foreground)
            }
        }
    };
    let arrow = insight_change_trend(result.change).map(|is_down| {
        if is_down {
            "superhero/trend-down.svg"
        } else {
            "superhero/trend-up.svg"
        }
    });

    Some(
        h_flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(4.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(color)
            .when_some(arrow, |el, icon| {
                el.child(superhero_icon(icon, 14.0, color))
            })
            .child(text)
            .into_any_element(),
    )
}

fn render_insight_detail(
    tokens: &Tokens,
    spec: InsightSpec,
    result: InsightResult,
    insights: Option<&TaskInsights>,
    chart_hover: Option<usize>,
    chart_bounds: Rc<Cell<Bounds<Pixels>>>,
    callbacks: InsightsCallbacks,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let formatted_value = result
        .value
        .map(|v| format_insight_value(spec.id, v))
        .unwrap_or_else(|| "\u{2013}".to_owned());
    let trend = insight_trend(insights, spec.id);
    let providers = insight_by_provider(insights, spec.id);
    let on_close = callbacks.on_expand;

    let legend = providers
        .into_iter()
        .map(|entry| {
            let value = entry
                .value
                .map(|v| format_insight_value(spec.id, v))
                .unwrap_or_else(|| "\u{2013}".to_owned());
            format!("{} {value}", entry.provider.name())
        })
        .collect::<Vec<_>>()
        .join(" · ");

    let chart_body: AnyElement = match trend {
        Some(points) if !points.is_empty() => render_trend_chart(
            spec.id,
            points,
            chart_hover,
            chart_bounds,
            tokens,
            callbacks.on_hover_chart,
        ),
        _ => div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child("Orbit reports no history for this number yet.")
            .into_any_element(),
    };

    v_flex()
        .relative()
        .size_full()
        .gap(px(4.0))
        .px(px(12.0))
        .pt(px(10.0))
        .pb(px(8.0))
        .child(
            div().absolute().top(px(4.0)).right(px(4.0)).child(
                chrome::icon_button(
                    "tasks-insight-close",
                    "superhero/close.svg",
                    tokens,
                    false,
                    move |_, window, cx| on_close(None, window, cx),
                )
                .conn_tooltip(format!("Close {} chart", spec.label), tokens),
            ),
        )
        .child(
            div()
                .pr(px(32.0))
                .truncate()
                .h(px(UI_LINE_HEIGHT_PX))
                .flex_shrink_0()
                .text_size(px(14.0))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(spec.label),
        )
        .child(
            h_flex()
                .min_w_0()
                .h(px(VALUE_LINE_HEIGHT_PX))
                .flex_shrink_0()
                .whitespace_nowrap()
                .items_baseline()
                .gap(px(8.0))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(VALUE_FONT_PX))
                        .line_height(px(VALUE_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(formatted_value),
                )
                .when_some(render_insight_change(tokens, spec, result), |el, change| {
                    el.child(change)
                })
                .child(
                    div()
                        .min_w_0()
                        .ml_auto()
                        .truncate()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(legend),
                ),
        )
        .child(div().flex_1().min_h_0().child(chart_body))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_insight_strip_uses_the_same_height_when_expanded() {
        assert_eq!(strip_height(insight_grid_layout(1).rows), 168.0);
        assert_eq!(strip_height(insight_grid_layout(2).rows), 168.0);
        assert_eq!(strip_height(insight_grid_layout(7).rows), 206.0);
        assert_eq!(strip_height(insight_grid_layout(8).rows), 206.0);
    }
}
