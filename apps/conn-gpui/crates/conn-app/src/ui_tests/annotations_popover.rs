//! The Browser toolbar's single Annotations button and the popover it opens: the Annotate and
//! Watch switches, the status dot on the numbered circle, and the `Cmd/Ctrl+Shift+A` shortcut.

use std::cell::RefCell;
use std::rc::Rc;

use conn_contract::AnnotationStatus;
use conn_contract::support::JsNumber;
use conn_state::{AnnotationQueueState, AnnotationRecord, AnnotationRecordSource};

use super::*;
use crate::panels::annotations::{
    AnnotationAction, NUMBER_BADGE_PX, annotation_status, is_annotation_toggle_shortcut,
};
use crate::panels::chrome::STATUS_DOT_OUTER_PX;

const BUTTON: &str = "browser-annotations-queue";

fn record(id: &str, number: i64, status: AnnotationStatus, question: bool) -> AnnotationRecord {
    AnnotationRecord {
        id: id.to_owned(),
        comment: format!("Fix #{number}"),
        source: Some(AnnotationRecordSource::Browser),
        url: Some("http://localhost:3000/settings".to_owned()),
        pathname: Some("/settings".to_owned()),
        element: Some("button".to_owned()),
        element_path: None,
        x: Some(JsNumber(50.0)),
        y: Some(JsNumber(25.0)),
        width: Some(JsNumber(1200.0)),
        height: Some(JsNumber(800.0)),
        bounding_box: None,
        is_fixed: None,
        timestamp: None,
        component: None,
        components: None,
        controller: None,
        route: None,
        react: None,
        screen_size: None,
        scroll_position: None,
        breakpoint: None,
        appearance: None,
        change: None,
        metadata: None,
        screenshot: None,
        project_id: "proj-1".to_owned(),
        number: JsNumber(number as f64),
        revision: JsNumber(1.0),
        status,
        summary: None,
        question: question.then_some(true),
        has_screenshot: false,
        created_at: "2026-11-21T18:00:00Z".to_owned(),
        claimed_at: None,
        completed_at: None,
    }
}

fn ann_id(prefix: &str, id: &str) -> gpui_kit::SharedString {
    gpui_kit::SharedString::from(format!("{prefix}-{id}"))
}

fn queue() -> Vec<AnnotationRecord> {
    vec![
        record("done", 37, AnnotationStatus::Done, false),
        record("wait", 8, AnnotationStatus::Todo, false),
        record("work", 12, AnnotationStatus::InProgress, false),
        record("ask", 9, AnnotationStatus::Todo, true),
    ]
}

type Page = gpui_kit::WeakEntity<crate::panels::BrowserPanelHandle>;

/// A Browser tab on screen with `records` in the project's queue.
fn mount_browser(
    cx: &mut TestAppContext,
    records: Vec<AnnotationRecord>,
    watching: bool,
    project_ready: bool,
) -> (AnyWindowHandle, Entity<ConnApp>, Page) {
    let (window, app) = mount_two_thread_app(cx);
    let (_, page) = open_thread_browser(cx, window, &app, "thread-selected");
    cx.update(|cx| {
        let panel = app.read(cx).right_panel_for_test().clone();
        panel.update(cx, |p, cx| {
            p.set_annotations(records, watching, project_ready, cx);
        });
    });
    render_frames(cx, window);
    (window, app, page)
}

fn click(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) {
    let _ = cx.update_window(window, |_, window, cx| {
        window.click(id, cx);
        window.render_frame(cx);
    });
    cx.run_until_parked();
}

fn state<R>(
    cx: &mut TestAppContext,
    page: &Page,
    read: impl FnOnce(&crate::panels::annotations::AnnotationUiState) -> R,
) -> R {
    cx.update(|cx| {
        let page = page.upgrade().expect("the browser is alive");
        read(page.read(cx).annotations_for_test())
    })
}

fn open_popover(cx: &mut TestAppContext, window: AnyWindowHandle, page: &Page) {
    click(cx, window, BUTTON);
    assert!(
        state(cx, page, |a| a.queue_open),
        "the Annotations button opens the popover"
    );
}

/// Focuses the page, as pressing on it does.
fn focus_page(cx: &mut TestAppContext, window: AnyWindowHandle, page: &Page) {
    let page = page.upgrade().expect("the browser is alive");
    let _ = cx.update_window(window, |_, window, cx| {
        page.update(cx, |p, cx| p.focus_for_test(window, cx));
        window.render_frame(cx);
    });
}

fn switch_checked(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> Option<bool> {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.find_by_label(label).checked()
    })
    .expect("the window is alive")
}

#[gpui_kit::test]
fn one_toolbar_button_opens_the_annotations_popover(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, queue(), false, true);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        // One button, named for the queue; the old annotate and list buttons are gone.
        assert_eq!(window.find_all_by_label("Annotations (1 waiting)").len(), 1);
        assert!(window.try_find_by_label("Annotate page").is_none());
        assert!(window.try_find_by_label("Stop annotating page").is_none());
        assert!(
            window
                .try_find_by_label("Annotations queue (1 waiting)")
                .is_none()
        );
        assert!(window.try_find_by_label("Annotations queue").is_none());
    });
    assert!(!state(cx, &page, |a| a.queue_open));

    open_popover(cx, window, &page);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find_by_label("Annotations queue").is_some());
        // The popover has no "Annotate page" button; the mode is a switch.
        assert!(window.try_find_by_label("Annotate page").is_none());
        assert!(window.try_find_by_label("Annotate").is_some());
    });

    click(cx, window, BUTTON);
    assert!(
        !state(cx, &page, |a| a.queue_open),
        "the same button closes it"
    );
}

#[gpui_kit::test]
fn the_annotate_switch_turns_annotation_mode_on_and_off(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, queue(), false, true);
    open_popover(cx, window, &page);
    assert_eq!(switch_checked(cx, window, "Annotate"), Some(false));

    click(cx, window, "annotations-annotate-switch");
    assert!(
        state(cx, &page, |a| a.annotating),
        "the switch starts the mode"
    );
    assert!(
        state(cx, &page, |a| a.queue_open),
        "the popover stays open to show the switch"
    );
    assert_eq!(switch_checked(cx, window, "Annotate"), Some(true));

    // The row toggles too, once per click.
    click(cx, window, "annotations-annotate-row");
    assert!(!state(cx, &page, |a| a.annotating));
    assert_eq!(switch_checked(cx, window, "Annotate"), Some(false));
}

#[gpui_kit::test]
fn the_shortcut_toggles_annotation_mode_and_the_switch_follows(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, queue(), false, true);
    open_popover(cx, window, &page);
    focus_page(cx, window, &page);

    // Option makes it another chord: T3's toggle excludes it.
    let _ = cx.update_window(window, |_, window, cx| {
        window.key_down("cmd-alt-shift-a", false, cx);
        window.render_frame(cx);
    });
    assert!(
        !state(cx, &page, |a| a.annotating),
        "Cmd+Option+Shift+A is not the shortcut"
    );

    let _ = cx.update_window(window, |_, window, cx| {
        window.key_down("cmd-shift-a", false, cx);
        window.render_frame(cx);
    });
    assert!(
        state(cx, &page, |a| a.annotating),
        "Cmd+Shift+A turns it on"
    );
    assert_eq!(switch_checked(cx, window, "Annotate"), Some(true));

    let _ = cx.update_window(window, |_, window, cx| {
        window.key_down("ctrl-shift-a", false, cx);
        window.render_frame(cx);
    });
    assert!(
        !state(cx, &page, |a| a.annotating),
        "Ctrl+Shift+A turns it off"
    );
    assert_eq!(switch_checked(cx, window, "Annotate"), Some(false));

    // A held key does not repeat the toggle.
    let _ = cx.update_window(window, |_, window, cx| {
        window.key_down("cmd-shift-a", true, cx);
    });
    assert!(!state(cx, &page, |a| a.annotating));
}

#[gpui_kit::test]
fn the_watch_switch_still_toggles_watch(cx: &mut TestAppContext) {
    let (window, app, page) = mount_browser(cx, queue(), false, true);
    let actions: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let sink = actions.clone();
    cx.update(|cx| {
        let page = page.upgrade().expect("alive");
        cx.subscribe(&page, move |_, event: &AnnotationAction, _| {
            if matches!(event, AnnotationAction::ToggleWatch) {
                sink.borrow_mut().push("watch");
            }
        })
        .detach();
    });
    open_popover(cx, window, &page);
    assert_eq!(switch_checked(cx, window, "Watch"), Some(false));

    click(cx, window, "annotations-watch-row");
    assert_eq!(actions.borrow().len(), 1, "the row toggles");
    assert!(state(cx, &page, |a| a.queue_open), "the popover stays open");
    // The app answers a toggle with a project sync, which has no project in this test: give the
    // popover its ready project back.
    cx.update(|cx| {
        let panel = app.read(cx).right_panel_for_test().clone();
        panel.update(cx, |p, cx| p.set_annotations(queue(), false, true, cx));
    });
    render_frames(cx, window);
    click(cx, window, "annotations-watch-switch");
    assert_eq!(
        actions.borrow().len(),
        2,
        "one click on the switch, one toggle"
    );

    // Watch on: the switch shows it.
    cx.update(|cx| {
        let panel = app.read(cx).right_panel_for_test().clone();
        panel.update(cx, |p, cx| p.set_annotations(queue(), true, true, cx));
    });
    render_frames(cx, window);
    assert_eq!(switch_checked(cx, window, "Watch"), Some(true));
}

#[gpui_kit::test]
fn the_two_switches_sit_together_below_the_list(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, queue(), false, true);
    open_popover(cx, window, &page);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let annotate = window.find("annotations-annotate-row").bounds();
        let watch = window.find("annotations-watch-row").bounds();
        let last_row = window.find(ann_id("ann-badge", "ask")).bounds();
        assert_eq!(
            f32::from(annotate.bottom()),
            f32::from(watch.top()),
            "no gap between the two rows"
        );
        assert!(annotate.top() < watch.top(), "Annotate comes first");
        assert!(
            last_row.bottom() < annotate.top(),
            "the list is above the switches"
        );
    });
}

#[gpui_kit::test]
fn done_annotations_show_a_status_dot_not_text(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, queue(), false, true);
    open_popover(cx, window, &page);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        // The status is readable through the row's accessible name, and is no label of its own.
        assert!(window.try_find_by_label("Annotation #37, Done").is_some());
        assert!(
            window
                .try_find_by_label("Annotation #12, Working")
                .is_some()
        );
        assert!(
            window
                .try_find_by_label("Annotation #9, Question")
                .is_some()
        );
        assert!(window.try_find_by_label("Annotation #8, Waiting").is_some());
        assert!(window.find_all_by_label("Done").is_empty());

        // Done, working and question rows have a dot on the circle's top right; waiting has none.
        for id in ["done", "work", "ask"] {
            let badge = window.find(ann_id("ann-badge", id)).bounds();
            let dot = window.find(ann_id("ann-status-dot", id)).bounds();
            assert!(
                (f32::from(dot.size.width) - STATUS_DOT_OUTER_PX).abs() < 0.5,
                "the dot is the shared 10px cutout disc"
            );
            assert!(
                dot.center().x > badge.center().x && dot.center().y < badge.center().y,
                "the dot sits at the circle's top right ({id})"
            );
        }
        assert!(window.try_find(ann_id("ann-status-dot", "wait")).is_none());
    });
}

#[gpui_kit::test]
fn the_number_circle_keeps_its_size_for_one_and_two_digits(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, queue(), false, true);
    open_popover(cx, window, &page);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        for id in ["done", "wait", "work", "ask"] {
            let size = window.find(ann_id("ann-badge", id)).bounds().size;
            assert_eq!(f32::from(size.width), NUMBER_BADGE_PX, "{id} width");
            assert_eq!(f32::from(size.height), NUMBER_BADGE_PX, "{id} height");
        }
    });
}

#[gpui_kit::test]
fn the_toolbar_button_shows_the_waiting_count_and_stays_one_button(cx: &mut TestAppContext) {
    let (window, _app, page) = mount_browser(cx, Vec::new(), false, true);
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find_all_by_label("Annotations").len(), 1);
    });
    open_popover(cx, window, &page);
    // Nothing queued: the empty state points at the switch, not at the removed button.
    let _ = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(
            window.find_all_by_label("Annotations").len(),
            2,
            "button and heading"
        );
        assert!(window.try_find_by_label("Annotate").is_some());
    });
}

#[test]
fn status_dots_follow_the_status_mapping_of_conn() {
    let theme = conn_theme::theme_by_id("dark-ocean").expect("dark-ocean is built in");
    let tokens = Tokens::derive(&theme);
    let (label, dot) = annotation_status(AnnotationQueueState::Done, &tokens);
    assert_eq!((label, dot), ("Done", Some(tokens.success)));
    let (label, dot) = annotation_status(AnnotationQueueState::Working, &tokens);
    assert_eq!((label, dot), ("Working", Some(tokens.info)));
    let (label, dot) = annotation_status(AnnotationQueueState::Question, &tokens);
    assert_eq!((label, dot), ("Question", Some(tokens.warning)));
    let (label, dot) = annotation_status(AnnotationQueueState::Waiting, &tokens);
    assert_eq!((label, dot), ("Waiting", None));
}

#[test]
fn the_shortcut_is_cmd_or_ctrl_shift_a_without_option() {
    let key = |text: &'static str| gpui_kit::Keystroke::parse(text).expect("a valid keystroke");
    assert!(is_annotation_toggle_shortcut(&key("cmd-shift-a")));
    assert!(is_annotation_toggle_shortcut(&key("ctrl-shift-a")));
    assert!(!is_annotation_toggle_shortcut(&key("cmd-alt-shift-a")));
    assert!(!is_annotation_toggle_shortcut(&key("cmd-a")));
    assert!(!is_annotation_toggle_shortcut(&key("shift-a")));
    assert!(!is_annotation_toggle_shortcut(&key("cmd-shift-b")));
}
