//! The card for a background command that ended (`TimelineEntry::BackgroundCommand`): Claude's
//! `task-notification` for a Bash `run_in_background` task. It is drawn in the family of the
//! command rows in a work log: a terminal icon, the label on one truncated line, and a caret that
//! opens the server's whole summary, then the provider's output when it sent any. A status reads at
//! the right edge.

use conn_state::BackgroundCommandOutcome;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, px,
};

use super::color::{hsla, muted_icon};
use super::{
    BODY_FONT_PX, BODY_LINE_HEIGHT_PX, ChatView, MONO_FONT_FAMILY, TIMELINE_INSET_PX,
    WORK_ICON_GAP_PX, WORK_LABEL_INDENT_PX, WORK_ROW_MIN_HEIGHT_PX, ax_snippet, icons,
    work_icon_box,
};
use crate::a11y::ConnA11yExt as _;

/// What the card shows when the notification names no command.
const UNNAMED_LABEL: &str = "Background command";

/// The status at the card's right edge: `Finished`, `Failed · exit 2` or `Stopped`.
pub(super) fn status_text(outcome: BackgroundCommandOutcome, exit_code: Option<i64>) -> String {
    let word = match outcome {
        BackgroundCommandOutcome::Finished => "Finished",
        BackgroundCommandOutcome::Failed => "Failed",
        BackgroundCommandOutcome::Stopped => "Stopped",
    };
    match exit_code {
        Some(code) => format!("{word} · exit {code}"),
        None => word.to_owned(),
    }
}

/// The label a screen reader hears.
pub(super) fn ax_label(
    label: Option<&str>,
    outcome: BackgroundCommandOutcome,
    exit_code: Option<i64>,
) -> String {
    format!(
        "Background command: {} ({})",
        ax_snippet(label.unwrap_or(UNNAMED_LABEL)),
        status_text(outcome, exit_code).replace(" · ", ", ")
    )
}

/// True when the label reads as a shell command, so it is drawn in monospace. The label is the
/// task's description when it has one (`Wait for dev app rebuild`), else its command, and the
/// notification does not say which. A sentence that starts with a capital letter is a description.
pub(super) fn is_command_text(label: &str) -> bool {
    let label = label.trim();
    let sentence = label.chars().next().is_some_and(char::is_uppercase)
        && label.split_whitespace().nth(1).is_some()
        && !label.contains(|c: char| "$|;&<>()=~/\\\"'`*{}[]".contains(c));
    !sentence
}

/// What the expand panel shows: the server's whole summary, then the provider's output.
pub(super) fn panel_text(summary: &str, detail: Option<&str>) -> Option<String> {
    let summary = summary.trim();
    let detail = detail.map(str::trim).filter(|d| !d.is_empty());
    match (summary.is_empty(), detail) {
        (true, None) => None,
        (true, Some(detail)) => Some(detail.to_owned()),
        (false, None) => Some(summary.to_owned()),
        (false, Some(detail)) => Some(format!("{summary}\n\n{detail}")),
    }
}

/// The fields of a `TimelineEntry::BackgroundCommand` the card draws.
pub(super) struct BackgroundCommandCard<'a> {
    pub id: &'a str,
    pub summary: &'a str,
    pub label: Option<&'a str>,
    pub outcome: BackgroundCommandOutcome,
    pub exit_code: Option<i64>,
    pub detail: Option<&'a str>,
}

impl ChatView {
    /// Renders one ended background command; see the module docs.
    pub(super) fn render_background_command_row(
        &self,
        card: &BackgroundCommandCard<'_>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let BackgroundCommandCard {
            id,
            summary,
            label,
            outcome,
            exit_code,
            detail,
        } = *card;
        let expanded = self.expanded_ids.contains(id);
        let toggle_id = id.to_owned();
        let body = panel_text(summary, detail);
        let failed = outcome == BackgroundCommandOutcome::Failed;
        let (icon_color, text_color) = if failed {
            (hsla(self.tokens.destructive), hsla(self.tokens.destructive))
        } else {
            (muted_icon(&self.tokens), hsla(self.tokens.muted_foreground))
        };
        let icon_path = if failed {
            icons::ERROR_CIRCLE
        } else {
            icons::TERMINAL
        };

        let shown = label.map(command_one_line);
        let mono = shown.as_deref().is_some_and(is_command_text);
        let mut label_el = div()
            .flex_1()
            .min_w_0()
            // Centres the text line in the 24px icon box.
            .mt(px((24.0 - BODY_LINE_HEIGHT_PX) / 2.0))
            .overflow_hidden()
            .text_ellipsis()
            .whitespace_nowrap()
            .text_color(text_color);
        if mono {
            label_el = label_el
                .font_family(MONO_FONT_FAMILY)
                .text_size(px(13.0))
                .line_height(px(BODY_LINE_HEIGHT_PX));
        }
        let label_el = label_el.child(shown.unwrap_or_else(|| UNNAMED_LABEL.to_owned()));

        let ax_id = format!("timeline.background-command.{id}");
        let ax = ax_label(label, outcome, exit_code);
        let mut line = div()
            .id(SharedString::from(format!("bgcmd-{id}")))
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
                SharedString::from(format!("bgcmd-icon-{id}")),
                icons::icon(icon_path, 16.0, icon_color),
            ))
            .child(label_el)
            .child(
                div()
                    .flex_none()
                    .mt(px((24.0 - BODY_LINE_HEIGHT_PX) / 2.0))
                    .text_size(px(12.0))
                    .line_height(px(BODY_LINE_HEIGHT_PX))
                    .text_color(text_color)
                    .child(status_text(outcome, exit_code)),
            );

        line = if body.is_some() {
            line.a11y_button(ax_id.clone(), ax)
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
            line.a11y_group(ax_id.clone(), ax)
        };

        #[cfg(test)]
        let line = gpui_kit::TestSupportExt::test_support(line);
        let mut container = div().flex().flex_col().w_full().min_w_0().child(line);
        if expanded && let Some(body) = body {
            // Same panel as a command row's output: indented under the label, monospace.
            let panel = div()
                .id(SharedString::from(format!("bgcmd-detail-{id}")))
                .a11y_group(
                    format!("{ax_id}.detail"),
                    format!("Details: {}", ax_snippet(label.unwrap_or(UNNAMED_LABEL))),
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
                .text_color(hsla(self.tokens.muted_foreground))
                .child(body);
            #[cfg(test)]
            let panel = gpui_kit::TestSupportExt::test_support(panel);
            container = container.child(panel);
        }
        container.into_any_element()
    }
}

/// The label on one line, as a command row shows it: a `sh -c "…"` wrapper is unwrapped and every
/// whitespace run collapses.
fn command_one_line(label: &str) -> String {
    super::command_label::command_row_label(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use BackgroundCommandOutcome::{Failed, Finished, Stopped};

    #[test]
    fn the_status_names_the_outcome_and_the_exit_code() {
        assert_eq!(status_text(Finished, None), "Finished");
        assert_eq!(status_text(Finished, Some(0)), "Finished · exit 0");
        assert_eq!(status_text(Failed, Some(2)), "Failed · exit 2");
        assert_eq!(status_text(Failed, None), "Failed");
        assert_eq!(status_text(Stopped, None), "Stopped");
    }

    #[test]
    fn a_screen_reader_hears_the_label_and_the_status() {
        assert_eq!(
            ax_label(Some("npm test"), Failed, Some(2)),
            "Background command: npm test (Failed, exit 2)"
        );
        assert_eq!(
            ax_label(None, Finished, None),
            "Background command: Background command (Finished)"
        );
    }

    #[test]
    fn the_panel_opens_with_the_summary_then_the_output() {
        assert_eq!(
            panel_text("Command \"make\" finished", None).as_deref(),
            Some("Command \"make\" finished")
        );
        assert_eq!(
            panel_text("Command \"make\" finished", Some("  built 3 crates \n")).as_deref(),
            Some("Command \"make\" finished\n\nbuilt 3 crates")
        );
        assert_eq!(panel_text("  ", Some("   ")), None);
        assert_eq!(panel_text("", Some("out")).as_deref(), Some("out"));
    }

    #[test]
    fn descriptions_read_as_prose_and_commands_as_code() {
        assert!(!is_command_text("Wait for dev app rebuild"));
        assert!(is_command_text("npm test"));
        assert!(is_command_text("make"));
        assert!(is_command_text("Run"), "one word is not a sentence");
        assert!(is_command_text(
            "L=~/apps/conn-gpui-dev/apps/conn-gpui/.t3/dev-hot.log; N=$(( $(wc -l < $L) + 1 …"
        ));
        assert!(is_command_text("Check the build (fast)"), "shell syntax");
    }
}

#[cfg(test)]
mod render_tests {
    use conn_state::{BackgroundCommandOutcome, ItemStatus, ThreadState, TimelineEntry};
    use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
    use gpui_kit::{AnyWindowHandle, AppContext as _, TestAppContext};

    use super::super::WORK_ROW_MIN_HEIGHT_PX;

    const LONG_COMMAND: &str = "L=~/apps/conn-gpui-dev/apps/conn-gpui/.t3/dev-hot.log; N=$(( $(wc -l < $L) + 1 )); until tail -n +$N $L | grep -q 'build finished'; do sleep 2; done";

    fn card(
        id: &str,
        label: Option<&str>,
        outcome: BackgroundCommandOutcome,
        exit_code: Option<i64>,
        detail: Option<&str>,
    ) -> TimelineEntry {
        TimelineEntry::BackgroundCommand {
            id: id.to_owned(),
            summary: format!("Command \"{}\" ended", label.unwrap_or_default()),
            label: label.map(str::to_owned),
            outcome,
            exit_code,
            detail: detail.map(str::to_owned),
        }
    }

    fn thread() -> ThreadState {
        use BackgroundCommandOutcome::{Failed, Finished, Stopped};
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
            card(
                "bg-ok",
                Some("Wait for dev app rebuild"),
                Finished,
                Some(0),
                Some("build finished in 41s"),
            ),
            card(
                "bg-fail",
                Some("npm test"),
                Failed,
                Some(2),
                Some("1 failing: adds numbers"),
            ),
            card("bg-long", Some(LONG_COMMAND), Finished, None, None),
            card("bg-stopped", Some("sleep 600"), Stopped, None, None),
            card("bg-unnamed", None, Finished, None, None),
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
    fn each_outcome_reads_in_its_own_card(cx: &mut TestAppContext) {
        let window = mount(cx);
        for label in [
            // Exit 0, with a description.
            "Background command: Wait for dev app rebuild (Finished, exit 0)",
            // A non-zero exit.
            "Background command: npm test (Failed, exit 2)",
            // No exit code reported.
            "Background command: sleep 600 (Stopped)",
            // No description or command.
            "Background command: Background command (Finished)",
        ] {
            assert!(has_label(cx, window, label), "missing the card {label:?}");
        }
        assert!(
            !has_label(cx, window, "Notice: Command finished"),
            "no divider pill"
        );
    }

    #[gpui_kit::test]
    fn cards_sit_on_the_tool_row_edge_and_stay_one_line(cx: &mut TestAppContext) {
        let window = mount(cx);
        cx.update_window(window, |_, window, _| {
            let left = window.find("assistant-text-answer-1").bounds().left();
            let right = window.find("assistant-text-answer-1").bounds().right();
            for id in ["bg-ok", "bg-fail", "bg-long", "bg-stopped", "bg-unnamed"] {
                let row = window.find(format!("bgcmd-{id}")).bounds();
                assert_eq!(
                    f32::from(row.size.height),
                    WORK_ROW_MIN_HEIGHT_PX,
                    "{id} is one line, however long its command"
                );
                let icon = window.find(format!("bgcmd-icon-{id}")).bounds();
                assert!(
                    f32::from((icon.left() - left).abs()) < 0.01,
                    "{id} icon at {:?}, timeline edge at {left:?}",
                    icon.left()
                );
                assert!(
                    f32::from((row.left() - left).abs()) < 0.01,
                    "{id} is not a centred pill"
                );
                assert!(
                    f32::from((row.right() - right).abs()) < 0.01,
                    "{id} ends at the timeline's right edge"
                );
            }
        })
        .expect("a window");
    }

    #[gpui_kit::test]
    fn every_card_expands_to_its_summary_and_output_and_collapses_again(cx: &mut TestAppContext) {
        let window = mount(cx);
        for (id, label) in [
            ("bg-ok", "Wait for dev app rebuild"),
            ("bg-stopped", "sleep 600"),
        ] {
            let panel = format!("Details: {label}");
            assert!(!has_label(cx, window, &panel), "{id} collapsed at first");
            cx.update_window(window, |_, window, cx| {
                window.click(format!("bgcmd-{id}"), cx)
            })
            .expect("a window");
            settle(cx, window);
            assert!(has_label(cx, window, &panel), "{id} opens after a click");
            cx.update_window(window, |_, window, cx| {
                window.click(format!("bgcmd-{id}"), cx)
            })
            .expect("a window");
            settle(cx, window);
            assert!(!has_label(cx, window, &panel), "{id} collapses again");
        }
    }
}
