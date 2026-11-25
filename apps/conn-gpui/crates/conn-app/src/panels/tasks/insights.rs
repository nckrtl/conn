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
    AnyElement, App, Bounds, FontWeight, Pixels, ScrollHandle, SharedString, TestSupportExt as _,
    Window, div, px,
};

use super::charts::{
    AXIS_TOP_OVERHANG_PX, SPARKLINE_BASE_HEIGHT_PX, render_sparkline, render_trend_chart,
};
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
/// How much taller the cards and the open chart are than before. Only the charts take the extra
/// height: the label, the number row and the gaps around them keep their positions.
const STAT_HEIGHT_SCALE: f32 = 1.25;
/// Height one insight card had before it grew: top border 1 + padding 10 + label 20 + gap 4 +
/// value 24 + gap 4 + sparkline 32 (4 above, 28 tall) + padding 8.
const BASE_CARD_HEIGHT_PX: f32 = 103.0;
/// Height of one insight card. Cards are set to it, so the strip's height is known and the
/// expanded chart can take exactly the same space.
const CARD_HEIGHT_PX: f32 = BASE_CARD_HEIGHT_PX * STAT_HEIGHT_SCALE;
/// Height a lone row of cards (and so the strip) had before it grew.
const BASE_MIN_STRIP_HEIGHT_PX: f32 = 168.0;
/// Top padding of an insight card and of the open chart's box.
const CARD_PAD_TOP_PX: f32 = 10.0;
/// Flex gap between the rows inside an insight card and the open chart's box.
const CARD_GAP_PX: f32 = 4.0;
/// Space above the chart's wrapper, on top of the box's flex gap. The visible gap from the number
/// row to the first y label (whose text box starts `AXIS_TOP_OVERHANG_PX` above the chart) equals
/// the card's top padding, i.e. the gap from the card's top edge to the title.
const CHART_TOP_GAP_PX: f32 = CARD_PAD_TOP_PX - CARD_GAP_PX + AXIS_TOP_OVERHANG_PX;

/// A single row stretches to 168px × the scale; two rows keep one card height each. Opening a
/// metric keeps that exact height so the task lanes stay in place.
fn strip_height(rows: usize) -> f32 {
    (rows as f32 * CARD_HEIGHT_PX).max(BASE_MIN_STRIP_HEIGHT_PX * STAT_HEIGHT_SCALE)
}

/// Height of a card's sparkline. It keeps its old height and its old top edge; the card's extra
/// height (what the card gained over `card_height / STAT_HEIGHT_SCALE`) all goes to the chart.
fn sparkline_height(card_height: f32) -> f32 {
    SPARKLINE_BASE_HEIGHT_PX + (card_height - card_height / STAT_HEIGHT_SCALE)
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
        .test_support()
        .h(px(height))
        .min_w(px(min_w))
        .flex_grow(span as f32)
        .flex_shrink(1.0)
        .flex_basis(px(0.0))
        .gap(px(CARD_GAP_PX))
        .px(px(12.0))
        .pt(px(CARD_PAD_TOP_PX))
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
            .id(SharedString::from(format!(
                "tasks-insight-label-{:?}",
                spec.id
            )))
            .test_support()
            .truncate()
            .text_size(px(14.0))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child(spec.label),
    )
    .child(
        h_flex()
            .id(SharedString::from(format!(
                "tasks-insight-value-{:?}",
                spec.id
            )))
            .test_support()
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
    .child(render_sparkline(
        SharedString::from(format!("tasks-insight-spark-{:?}", spec.id)),
        trend.unwrap_or_default(),
        sparkline_height(height),
        tokens,
    ))
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
        .id("tasks-insight-detail")
        .test_support()
        .relative()
        .size_full()
        .gap(px(CARD_GAP_PX))
        .px(px(12.0))
        .pt(px(CARD_PAD_TOP_PX))
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
                .id("tasks-insight-title")
                .test_support()
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
                .id("tasks-insight-summary")
                .test_support()
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
        .child(
            div()
                .mt(px(CHART_TOP_GAP_PX))
                .flex_1()
                .min_h_0()
                .child(chart_body),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{Context, Render};

    #[test]
    fn the_insight_strip_uses_the_same_height_when_expanded() {
        // The heights before the cards grew, times 1.25.
        assert_eq!(strip_height(insight_grid_layout(1).rows), 168.0 * 1.25);
        assert_eq!(strip_height(insight_grid_layout(2).rows), 168.0 * 1.25);
        assert_eq!(strip_height(insight_grid_layout(7).rows), 206.0 * 1.25);
        assert_eq!(strip_height(insight_grid_layout(8).rows), 206.0 * 1.25);
        assert_eq!(CARD_HEIGHT_PX, 103.0 * 1.25);
    }

    #[test]
    fn the_sparkline_keeps_its_top_and_takes_all_the_extra_height() {
        // Two rows: the card is 128.75px, was 103px. The sparkline was 28px.
        assert_eq!(sparkline_height(CARD_HEIGHT_PX), 28.0 + (128.75 - 103.0));
        // A lone row stretched to 168px, now 210px.
        assert_eq!(sparkline_height(210.0), 28.0 + (210.0 - 168.0));
    }

    struct ChartHost {
        tokens: Tokens,
        scroll: ScrollHandle,
        data: Option<TaskInsights>,
        expanded: Option<InsightId>,
        bounds: Rc<Cell<Bounds<Pixels>>>,
    }

    impl Render for ChartHost {
        fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
            v_flex()
                .size_full()
                .bg(to_hsla(self.tokens.shell_card))
                .children(render_insights_strip(
                    &self.tokens,
                    self.data.as_ref(),
                    InsightsPeriod::Month,
                    false,
                    &[],
                    self.expanded,
                    None,
                    self.bounds.clone(),
                    &self.scroll,
                    InsightsCallbacks {
                        on_expand: Rc::new(|_, _, _| {}),
                        on_hover_chart: Rc::new(|_, _, _| {}),
                    },
                ))
        }
    }

    fn chart_data() -> TaskInsights {
        let daily: Vec<_> = [2, 48, 115, 140, 95]
            .iter()
            .enumerate()
            .map(|(i, merged)| {
                serde_json::json!({"date": format!("2026-11-{:02}", 20 + i), "merged": merged, "tokens": 1000})
            })
            .collect();
        conn_desktop::orbit::tasks::decode_task_insights(&serde_json::json!({"data": {
            "period": "30d",
            "current": {"merged": 163, "tokens": 12_345_678},
            "previous": {"merged": 180, "tokens": 11_111},
            "daily": daily,
            "breakdowns": {"model": [
                {"key": "gpt-5", "label": "gpt-5", "merged": 13},
                {"key": "claude-opus", "label": "claude-opus", "merged": 143},
                {"key": "gemini", "label": "gemini", "merged": 5},
            ]},
        }}))
        .expect("insights fixture decodes")
    }

    struct Measured {
        chart: Bounds<Pixels>,
        summary: Bounds<Pixels>,
        labels: Vec<Bounds<Pixels>>,
        title: Bounds<Pixels>,
        card: Bounds<Pixels>,
    }

    /// Measures the open chart's card, title, number row, chart and axis labels.
    fn measure(cx: &mut gpui_kit::TestAppContext, width: f32, expanded: InsightId) -> Measured {
        use gpui_kit::test::TestWindowExt as _;
        use gpui_kit::{AppContext as _, Point, WindowBounds, WindowOptions, size};
        let (window, view) = cx.update(|cx| {
            gpui_kit::init(cx);
            let theme = conn_theme::theme_by_id("dark-ocean").expect("dark-ocean theme");
            let tokens = Tokens::derive(&theme);
            crate::theme::apply_kit_theme(&tokens, cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(width), px(420.0)),
                ))),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, move |_, cx| {
                cx.new(|_| ChartHost {
                    tokens,
                    scroll: ScrollHandle::new(),
                    data: Some(chart_data()),
                    expanded: Some(expanded),
                    bounds: Rc::default(),
                })
            })
            .expect("headless window opens")
        });
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.render_frame(cx);
        })
        .expect("window renders");
        let chart = cx.update(|cx| view.read(cx).bounds.get());
        let (summary, labels, title, card) = cx
            .update_window(window, |_, window, _| {
                let summary = window.find("tasks-insight-summary").bounds();
                let title = window.find("tasks-insight-title").bounds();
                let card = window.find("tasks-insight-detail").bounds();
                let labels = (0..)
                    .map_while(|i| {
                        window
                            .try_find(SharedString::from(format!("tasks-insight-axis-{i}")))
                            .map(|label| label.bounds())
                    })
                    .collect::<Vec<_>>();
                (summary, labels, title, card)
            })
            .expect("window queried");
        Measured {
            chart,
            summary,
            labels,
            title,
            card,
        }
    }

    /// Layout snaps to half a pixel, so a fractional height (128.75) lands within 0.5px of it.
    #[track_caller]
    fn assert_near(actual: f32, expected: f32, what: &str) {
        assert!(
            (actual - expected).abs() <= 0.5,
            "{what} is {actual}px, expected {expected}px"
        );
    }

    /// Bounds of one card's label, number row and sparkline, and of the card.
    struct MeasuredCard {
        card: Bounds<Pixels>,
        label: Bounds<Pixels>,
        value: Bounds<Pixels>,
        spark: Bounds<Pixels>,
    }

    /// Renders the collapsed strip (all eight cards) and measures the "Tasks completed" card.
    fn measure_card(cx: &mut gpui_kit::TestAppContext, width: f32) -> MeasuredCard {
        use gpui_kit::test::TestWindowExt as _;
        use gpui_kit::{AppContext as _, Point, WindowBounds, WindowOptions, size};
        let window = cx.update(|cx| {
            gpui_kit::init(cx);
            let theme = conn_theme::theme_by_id("dark-ocean").expect("dark-ocean theme");
            let tokens = Tokens::derive(&theme);
            crate::theme::apply_kit_theme(&tokens, cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(width), px(420.0)),
                ))),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, move |_, cx| {
                cx.new(|_| ChartHost {
                    tokens,
                    scroll: ScrollHandle::new(),
                    data: Some(chart_data()),
                    expanded: None,
                    bounds: Rc::default(),
                })
            })
            .expect("headless window opens")
            .0
        });
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.render_frame(cx);
        })
        .expect("window renders");
        cx.update_window(window, |_, window, _| MeasuredCard {
            card: window.find("tasks-insight-Completed").bounds(),
            label: window.find("tasks-insight-label-Completed").bounds(),
            value: window.find("tasks-insight-value-Completed").bounds(),
            spark: window.find("tasks-insight-spark-Completed").bounds(),
        })
        .expect("window queried")
    }

    /// Renders the collapsed strip and the open "Tasks completed" chart offscreen to PNG, in Dark
    /// Ocean and Light. It opens no window on screen and takes no focus: GPUI's headless
    /// renderer draws into a texture.
    ///
    /// `CONN_TASKS_SHOTS_DIR=<dir> CONN_TASKS_SHOTS_TAG=after cargo test -p conn-app \
    ///  render_task_stats_screenshots -- --ignored`
    #[test]
    #[ignore = "writes PNGs; set CONN_TASKS_SHOTS_DIR"]
    fn render_task_stats_screenshots() {
        use gpui_kit::test::TestWindowExt as _;
        use gpui_kit::{AppContext as _, Point, WindowBounds, WindowOptions, size};
        let Some(dir) = std::env::var_os("CONN_TASKS_SHOTS_DIR") else {
            return;
        };
        let tag = std::env::var("CONN_TASKS_SHOTS_TAG").unwrap_or_else(|_| "after".to_owned());
        let dir = std::path::Path::new(&dir);
        std::fs::create_dir_all(dir).expect("an output folder");
        let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
            gpui_kit::platform::current_platform(true).text_system(),
            std::sync::Arc::new(crate::superhero::AppAssets),
            gpui_kit::platform::current_headless_renderer,
        );
        for (theme, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
            for (view, expanded) in [("card", None), ("expanded", Some(InsightId::Completed))] {
                let tokens = Tokens::derive(&conn_theme::theme_by_id(theme).expect("a theme"));
                let (window, _) = ctx.update(|cx| {
                    gpui_kit::init(cx);
                    crate::fonts::register(cx);
                    crate::theme::apply_kit_theme(&tokens, cx);
                    gpui_kit::open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                                Point::default(),
                                size(px(560.0), px(270.0)),
                            ))),
                            focus: false,
                            show: false,
                            ..Default::default()
                        },
                        cx,
                        move |_, cx| {
                            cx.new(|_| ChartHost {
                                tokens,
                                scroll: ScrollHandle::new(),
                                data: Some(chart_data()),
                                expanded,
                                bounds: Rc::default(),
                            })
                        },
                    )
                    .expect("a window")
                });
                for _ in 0..3 {
                    ctx.update_window(window, |_, w, c| w.render_frame(c))
                        .expect("a frame");
                    ctx.run_until_parked();
                }
                ctx.capture_screenshot(window)
                    .expect("a screenshot")
                    .save(dir.join(format!("{view}-{label}-{tag}.png")))
                    .expect("a saved PNG");
            }
        }
    }

    #[gpui_kit::test]
    fn a_card_is_taller_and_only_its_sparkline_takes_the_height(cx: &mut gpui_kit::TestAppContext) {
        for width in [560.0, 780.0] {
            let m = measure_card(cx, width);
            let top = f32::from(m.card.origin.y);
            let rel = |b: Bounds<Pixels>| f32::from(b.origin.y) - top;
            // 25% taller than the 103px it had.
            assert_near(f32::from(m.card.size.height), 103.0 * 1.25, "card height");
            // The label, the number row and the gaps keep the positions they had: padding 10,
            // label 20, gap 4, number row 24, gap 4.
            assert_eq!(rel(m.label), 10.0, "label top at {width}px");
            assert_eq!(
                f32::from(m.label.size.height),
                20.0,
                "label height at {width}px"
            );
            assert_eq!(rel(m.value), 34.0, "number row top at {width}px");
            assert_eq!(
                f32::from(m.value.size.height),
                27.0,
                "number row height at {width}px (24px number, baseline-aligned with the 20px change)"
            );
            // The sparkline keeps its old top edge (card top + 103 - 8 padding - 28 tall = 67)
            // and still ends 8px above the card's bottom; all the added 25.75px is its height.
            assert_near(rel(m.spark), 67.0, "sparkline top");
            assert_near(
                f32::from(m.spark.size.height),
                28.0 + 103.0 * 0.25,
                "sparkline height",
            );
            assert_near(
                f32::from(m.card.bottom()) - f32::from(m.spark.bottom()),
                8.0,
                "bottom padding",
            );
        }
    }

    #[gpui_kit::test]
    fn the_open_chart_is_taller_and_the_text_above_it_stays_put(cx: &mut gpui_kit::TestAppContext) {
        let Measured {
            chart,
            summary,
            title,
            card,
            ..
        } = measure(cx, 780.0, InsightId::Completed);
        let rel = |b: Bounds<Pixels>| f32::from(b.origin.y) - f32::from(card.origin.y);
        // The strip was 206px (two rows of 103px); now 25% taller.
        assert_near(
            f32::from(card.size.height),
            206.0 * 1.25,
            "open card height",
        );
        // Title at 10, number row at 10 + 20 + 4 = 34, as before.
        assert_eq!(rel(title), 10.0);
        assert_eq!(rel(summary), 34.0);
        assert_eq!(f32::from(summary.size.height), 24.0);
        // The chart starts where it did (34 + 24 + 4 gap + the 7px tuned gap = 69) and ends 8px
        // above the bottom; it was 129px tall and gains all of the 51.5px.
        assert_eq!(rel(chart), 69.0);
        assert_near(
            f32::from(chart.size.height),
            129.0 + 206.0 * 0.25,
            "open chart height",
        );
        assert_eq!(f32::from(card.bottom()) - f32::from(chart.bottom()), 8.0);
    }

    #[gpui_kit::test]
    fn the_axis_labels_start_on_the_left_edge_and_the_chart_sits_below_the_numbers(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        for (width, expanded) in [
            (340.0, InsightId::Completed),
            (780.0, InsightId::Completed),
            (780.0, InsightId::Spent),
        ] {
            let Measured {
                chart,
                summary,
                labels,
                title,
                card,
            } = measure(cx, width, expanded);
            assert!(labels.len() >= 3, "a few ticks at {width}px ({expanded:?})");
            let widths: Vec<f32> = labels.iter().map(|b| f32::from(b.size.width)).collect();
            assert!(
                widths.iter().any(|w| (w - widths[0]).abs() > 1.0),
                "labels of different widths make the alignment check meaningful: {widths:?}"
            );
            for (i, label) in labels.iter().enumerate() {
                assert_eq!(
                    f32::from(label.origin.x),
                    f32::from(chart.origin.x),
                    "axis label {i} starts at the chart's left edge at {width}px ({expanded:?})"
                );
            }
            // The gap above the title is the card's top padding; the gap from the number row to
            // the top y label's text box must be the same, so the chart does not look detached.
            let top_gap = f32::from(title.origin.y) - f32::from(card.origin.y);
            let first_label_top = labels
                .iter()
                .map(|b| f32::from(b.origin.y))
                .fold(f32::INFINITY, f32::min);
            let chart_gap = first_label_top - f32::from(summary.bottom());
            assert_eq!(top_gap, CARD_PAD_TOP_PX, "card top padding at {width}px");
            assert!(
                (chart_gap - top_gap).abs() <= 0.5,
                "number row to top y label is {chart_gap}px, card top to title is {top_gap}px \
                 at {width}px ({expanded:?})"
            );
            assert!(
                f32::from(chart.origin.y) >= f32::from(summary.bottom()),
                "the chart sits below the numbers at {width}px ({expanded:?})"
            );
            let plot_left = f32::from(chart.origin.x) + 44.0;
            assert!(
                labels
                    .iter()
                    .all(|b| f32::from(b.right()) <= plot_left - 4.0),
                "labels stay left of the plot at {width}px ({expanded:?})"
            );
        }
    }
}
