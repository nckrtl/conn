//! The card for several pieces of background work that ended in one wake
//! (`TimelineEntry::BackgroundWork`): the server's `Command "a", command "b" and command "c"
//! failed`. It is the background command card (`background_command.rs`) with a header that names
//! how many and the one outcome the server reports for all of them, and one row per command or
//! monitor below it. The server reports one shared outcome (`failed` when any one failed), so the
//! status sits only on the header; a row shows its own exit code when the server named one.

use conn_state::{BackgroundCommandOutcome, BackgroundWorkItem, BackgroundWorkKind};
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, px,
};

use super::background_command::{command_one_line, is_command_text, panel_text, status_text};
use super::color::{hsla, muted_icon};
use super::{
    BODY_FONT_PX, BODY_LINE_HEIGHT_PX, ChatView, MONO_FONT_FAMILY, TIMELINE_INSET_PX,
    WORK_ICON_GAP_PX, WORK_LABEL_INDENT_PX, WORK_ROW_MIN_HEIGHT_PX, ax_snippet, icons,
    work_icon_box,
};
use crate::a11y::ConnA11yExt as _;

/// The header's label: `3 commands`, or `2 background tasks` when kinds mix.
pub(super) fn header_text(count: usize, kind: Option<BackgroundWorkKind>) -> String {
    let noun = kind.map_or("background tasks", |kind| kind.noun().1);
    format!("{count} {noun}")
}

/// A row's label: the server's label, else the kind's noun (`Command`).
pub(super) fn row_label(item: &BackgroundWorkItem) -> String {
    item.label
        .as_deref()
        .map_or_else(|| item.kind.noun().0.to_owned(), command_one_line)
}

/// The label a screen reader hears on the header.
pub(super) fn ax_header(
    count: usize,
    kind: Option<BackgroundWorkKind>,
    outcome: BackgroundCommandOutcome,
) -> String {
    format!(
        "Background work: {} ({})",
        header_text(count, kind),
        status_text(outcome, None)
    )
}

/// The label a screen reader hears on one row.
pub(super) fn ax_row(item: &BackgroundWorkItem) -> String {
    let noun = item.kind.noun().0;
    let label = item
        .label
        .as_deref()
        .map(|label| format!("{noun}: {}", ax_snippet(label)))
        .unwrap_or_else(|| noun.to_owned());
    match item.exit_code {
        Some(code) => format!("{label} (exit {code})"),
        None => label,
    }
}

fn kind_icon(kind: Option<BackgroundWorkKind>) -> &'static str {
    match kind {
        Some(BackgroundWorkKind::Command) => icons::TERMINAL,
        Some(BackgroundWorkKind::Monitor) => icons::EYE,
        Some(BackgroundWorkKind::Subagent) => icons::ROBOT,
        Some(BackgroundWorkKind::BackgroundTask) | None => icons::TOOL,
    }
}

/// The fields of a `TimelineEntry::BackgroundWork` the card draws.
pub(super) struct BackgroundWorkCard<'a> {
    pub id: &'a str,
    pub summary: &'a str,
    pub outcome: BackgroundCommandOutcome,
    pub count: usize,
    pub kind: Option<BackgroundWorkKind>,
    pub items: &'a [BackgroundWorkItem],
    pub detail: Option<&'a str>,
}

impl ChatView {
    /// Renders several ended pieces of background work; see the module docs.
    pub(super) fn render_background_work_card(
        &self,
        card: &BackgroundWorkCard<'_>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let BackgroundWorkCard {
            id,
            summary,
            outcome,
            count,
            kind,
            items,
            detail,
        } = *card;
        let expanded = self.expanded_ids.contains(id);
        let toggle_id = id.to_owned();
        let body = panel_text(summary, detail);
        let failed = outcome == BackgroundCommandOutcome::Failed;
        let muted_text = hsla(self.tokens.muted_foreground);
        let (header_icon_color, header_text_color) = if failed {
            (hsla(self.tokens.destructive), hsla(self.tokens.destructive))
        } else {
            (muted_icon(&self.tokens), muted_text)
        };
        let header_icon = if failed {
            icons::ERROR_CIRCLE
        } else {
            kind_icon(kind)
        };
        // Centres a text line in the 24px icon box.
        let text_nudge = px((24.0 - BODY_LINE_HEIGHT_PX) / 2.0);

        let ax_id = format!("timeline.background-work.{id}");
        let mut header = div()
            .id(SharedString::from(format!("bgwork-{id}")))
            .flex()
            .flex_row()
            .items_start()
            .gap(px(WORK_ICON_GAP_PX))
            .w_full()
            .min_w_0()
            .min_h(px(WORK_ROW_MIN_HEIGHT_PX))
            .px(px(TIMELINE_INSET_PX))
            .rounded(px(6.0))
            .text_size(px(BODY_FONT_PX))
            .line_height(px(BODY_LINE_HEIGHT_PX))
            .child(work_icon_box(
                SharedString::from(format!("bgwork-icon-{id}")),
                icons::icon(header_icon, 16.0, header_icon_color),
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .mt(text_nudge)
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .text_color(muted_text)
                    .child(header_text(count, kind)),
            )
            .child(
                div()
                    .flex_none()
                    .mt(text_nudge)
                    .text_size(px(12.0))
                    .line_height(px(BODY_LINE_HEIGHT_PX))
                    .text_color(header_text_color)
                    .child(status_text(outcome, None)),
            );
        let ax = ax_header(count, kind, outcome);
        header = if body.is_some() {
            header
                .a11y_button(ax_id.clone(), ax)
                .aria_expanded(expanded)
                .cursor_pointer()
                .hover(|s| s.text_color(hsla(self.tokens.foreground)))
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.toggle_expanded(&toggle_id, cx);
                }))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(16.0))
                        .flex_none()
                        // Centres the caret in the 24px first line.
                        .mt(px(4.0))
                        .child(icons::icon(
                            if expanded {
                                icons::CARET_DOWN
                            } else {
                                icons::CARET_RIGHT
                            },
                            12.0,
                            muted_icon(&self.tokens),
                        )),
                )
        } else {
            header.a11y_group(ax_id.clone(), ax)
        };
        #[cfg(test)]
        let header = gpui_kit::TestSupportExt::test_support(header);

        let mut container = div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            // The air a work group leaves below its last row, as on the one-command card.
            .pb(px(8.0))
            .child(header);

        for (index, item) in items.iter().enumerate() {
            let shown = row_label(item);
            let mono = item.label.is_some() && is_command_text(&shown);
            let mut label_el = div()
                .flex_1()
                .min_w_0()
                .mt(text_nudge)
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .text_color(muted_text);
            if mono {
                label_el = label_el
                    .font_family(MONO_FONT_FAMILY)
                    .text_size(px(13.0))
                    .line_height(px(BODY_LINE_HEIGHT_PX));
            }
            let mut row = div()
                .id(SharedString::from(format!("bgwork-row-{id}-{index}")))
                .a11y_group(format!("{ax_id}.item-{index}"), ax_row(item))
                .flex()
                .flex_row()
                .items_start()
                .gap(px(WORK_ICON_GAP_PX))
                .w_full()
                .min_w_0()
                .min_h(px(WORK_ROW_MIN_HEIGHT_PX))
                .pl(px(TIMELINE_INSET_PX + WORK_LABEL_INDENT_PX))
                .text_size(px(BODY_FONT_PX))
                .line_height(px(BODY_LINE_HEIGHT_PX))
                .child(work_icon_box(
                    SharedString::from(format!("bgwork-row-icon-{id}-{index}")),
                    icons::icon(kind_icon(Some(item.kind)), 16.0, muted_icon(&self.tokens)),
                ))
                .child(label_el.child(shown));
            if let Some(code) = item.exit_code {
                let color = if code == 0 {
                    muted_text
                } else {
                    hsla(self.tokens.destructive)
                };
                row = row.child(
                    div()
                        .flex_none()
                        .mt(text_nudge)
                        .text_size(px(12.0))
                        .line_height(px(BODY_LINE_HEIGHT_PX))
                        .text_color(color)
                        .child(format!("exit {code}")),
                );
            }
            #[cfg(test)]
            let row = gpui_kit::TestSupportExt::test_support(row);
            container = container.child(row);
        }

        if expanded && let Some(body) = body {
            // Same panel as the one-command card: indented under the label, monospace.
            let panel = div()
                .id(SharedString::from(format!("bgwork-detail-{id}")))
                .a11y_group(
                    format!("{ax_id}.detail"),
                    format!("Details: {}", header_text(count, kind)),
                )
                .ml(px(WORK_LABEL_INDENT_PX))
                .mt(px(2.0))
                .mb(px(6.0))
                .px(px(10.0))
                .py(px(8.0))
                .rounded(px(8.0))
                .bg(hsla(self.tokens.code_background))
                .border_1()
                .border_color(hsla(self.tokens.shell_divider))
                .font_family(MONO_FONT_FAMILY)
                .font_weight(FontWeight::NORMAL)
                .text_size(px(11.5))
                .line_height(px(18.0))
                .text_color(muted_text)
                .child(body);
            #[cfg(test)]
            let panel = gpui_kit::TestSupportExt::test_support(panel);
            container = container.child(panel);
        }
        container.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use BackgroundCommandOutcome::{Failed, Finished};
    use BackgroundWorkKind::{Command, Monitor};

    fn item(
        kind: BackgroundWorkKind,
        label: Option<&str>,
        exit_code: Option<i64>,
    ) -> BackgroundWorkItem {
        BackgroundWorkItem {
            kind,
            label: label.map(str::to_owned),
            exit_code,
        }
    }

    #[test]
    fn the_header_counts_the_work_and_names_the_shared_outcome() {
        assert_eq!(header_text(3, Some(Command)), "3 commands");
        assert_eq!(header_text(2, Some(Monitor)), "2 monitors");
        assert_eq!(header_text(2, None), "2 background tasks");
        assert_eq!(
            ax_header(3, Some(Command), Failed),
            "Background work: 3 commands (Failed)"
        );
        assert_eq!(
            ax_header(2, None, Finished),
            "Background work: 2 background tasks (Finished)"
        );
    }

    #[test]
    fn a_row_names_its_work_and_its_own_exit_code() {
        assert_eq!(
            row_label(&item(Command, Some("npm test"), None)),
            "npm test"
        );
        assert_eq!(row_label(&item(Monitor, None, None)), "Monitor");
        assert_eq!(
            ax_row(&item(Command, Some("npm test"), Some(2))),
            "Command: npm test (exit 2)"
        );
        assert_eq!(ax_row(&item(Command, None, None)), "Command");
    }
}

#[cfg(test)]
mod render_tests {
    use conn_state::{
        BackgroundCommandOutcome, BackgroundWorkItem, BackgroundWorkKind, ItemStatus, ThreadState,
        TimelineEntry,
    };
    use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
    use gpui_kit::{AnyWindowHandle, AppContext as _, TestAppContext};

    use super::super::WORK_ROW_MIN_HEIGHT_PX;

    const BUILD: &str = "Build baseline server with fake provider";
    const CHECK: &str = "Run server tools/check.sh";

    fn item(kind: BackgroundWorkKind, label: &str, exit_code: Option<i64>) -> BackgroundWorkItem {
        BackgroundWorkItem {
            kind,
            label: Some(label.to_owned()),
            exit_code,
        }
    }

    pub(super) fn thread() -> ThreadState {
        use BackgroundCommandOutcome::{Failed, Finished};
        use BackgroundWorkKind::{Command, Monitor};
        let mut thread = ThreadState::new("thread-selected");
        thread.synchronized = true;
        thread.entries = vec![
            TimelineEntry::Assistant {
                id: "answer-1".to_owned(),
                markdown: "Paragraph that marks the timeline's left edge.".to_owned(),
                streaming: false,
                created_at: None,
                run_id: Some("run-1".to_owned()),
                status: ItemStatus::Completed,
            },
            TimelineEntry::BackgroundWork {
                id: "bg-three".to_owned(),
                summary: format!(
                    "Command \"{BUILD}\", command \"{BUILD}\" and command \"{CHECK}\" failed"
                ),
                outcome: Failed,
                count: 3,
                kind: Some(Command),
                items: vec![
                    item(Command, BUILD, None),
                    item(Command, BUILD, None),
                    item(Command, CHECK, None),
                ],
                detail: None,
            },
            TimelineEntry::BackgroundWork {
                id: "bg-two".to_owned(),
                summary: "Command \"make\" (exit 0) and command \"npm test\" (exit 2) failed"
                    .to_owned(),
                outcome: Failed,
                count: 2,
                kind: Some(Command),
                items: vec![
                    item(Command, "make", Some(0)),
                    item(Command, "npm test", Some(2)),
                ],
                detail: Some("1 failing".to_owned()),
            },
            TimelineEntry::BackgroundWork {
                id: "bg-mixed".to_owned(),
                summary: "Command \"a\" and monitor \"CI\" finished".to_owned(),
                outcome: Finished,
                count: 2,
                kind: None,
                items: vec![item(Command, "a", None), item(Monitor, "CI", None)],
                detail: None,
            },
            TimelineEntry::BackgroundCommand {
                id: "bg-one".to_owned(),
                summary: "Command \"npm test\" failed (exit 2)".to_owned(),
                label: Some("npm test".to_owned()),
                outcome: Failed,
                exit_code: Some(2),
                detail: None,
            },
        ];
        thread
    }

    fn mount(cx: &mut TestAppContext) -> AnyWindowHandle {
        let (window, app) = crate::ui_tests::mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
                app.set_thread_for_test("thread-selected".to_owned(), thread(), cx);
            });
        });
        cx.run_until_parked();
        settle(cx, window);
        window
    }

    fn settle(cx: &mut TestAppContext, window: AnyWindowHandle) {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, window, cx| window.render_frame(cx));
            cx.run_until_parked();
        }
    }

    fn has_label(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
        cx.update_window(window, |_, window, _| {
            window.try_find_by_label(label).is_some()
        })
        .expect("a window")
    }

    #[gpui_kit::test]
    fn the_header_carries_the_shared_outcome_and_each_command_has_a_row(cx: &mut TestAppContext) {
        let window = mount(cx);
        for label in [
            "Background work: 3 commands (Failed)",
            "Background work: 2 commands (Failed)",
            "Background work: 2 background tasks (Finished)",
            "Command: Run server tools/check.sh",
            "Command: make (exit 0)",
            "Command: npm test (exit 2)",
            "Monitor: CI",
            // The one-command card is unchanged.
            "Background command: npm test (Failed, exit 2)",
        ] {
            assert!(has_label(cx, window, label), "missing {label:?}");
        }
        cx.update_window(window, |_, window, _| {
            // The duplicate keeps both rows.
            for index in 0..3 {
                window.find(format!("bgwork-row-bg-three-{index}"));
            }
            assert!(window.try_find("bgwork-row-bg-three-3").is_none());
        })
        .expect("a window");
    }

    #[gpui_kit::test]
    fn rows_are_one_line_and_indent_under_the_header_label(cx: &mut TestAppContext) {
        let window = mount(cx);
        cx.update_window(window, |_, window, _| {
            let left = window.find("assistant-text-answer-1").bounds().left();
            let one = window.find("bgcmd-icon-bg-one").bounds().left();
            for id in ["bg-three", "bg-two", "bg-mixed"] {
                let header = window.find(format!("bgwork-{id}")).bounds();
                assert_eq!(f32::from(header.size.height), WORK_ROW_MIN_HEIGHT_PX);
                let icon = window.find(format!("bgwork-icon-{id}")).bounds().left();
                assert!(
                    f32::from((icon - left).abs()) < 0.01,
                    "{id} header on the edge"
                );
                assert!(
                    f32::from((icon - one).abs()) < 0.01,
                    "{id} lines up with #441"
                );
                let row_icon = window
                    .find(format!("bgwork-row-icon-{id}-0"))
                    .bounds()
                    .left();
                assert!(
                    f32::from((row_icon - left - px_indent()).abs()) < 0.01,
                    "{id} rows indent under the header label"
                );
                let row = window.find(format!("bgwork-row-{id}-0")).bounds();
                assert_eq!(f32::from(row.size.height), WORK_ROW_MIN_HEIGHT_PX);
            }
        })
        .expect("a window");
    }

    fn px_indent() -> gpui_kit::Pixels {
        gpui_kit::px(super::super::WORK_LABEL_INDENT_PX)
    }

    #[gpui_kit::test]
    fn the_header_opens_the_whole_summary(cx: &mut TestAppContext) {
        let window = mount(cx);
        let panel = "Details: 3 commands";
        assert!(!has_label(cx, window, panel));
        cx.update_window(window, |_, window, cx| window.click("bgwork-bg-three", cx))
            .expect("a window");
        settle(cx, window);
        assert!(has_label(cx, window, panel), "opens after a click");
        cx.update_window(window, |_, window, cx| window.click("bgwork-bg-three", cx))
            .expect("a window");
        settle(cx, window);
        assert!(!has_label(cx, window, panel), "collapses again");
    }
}
