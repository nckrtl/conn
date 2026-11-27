//! The queued-message tray above the composer: where it sits, what its rows do, how it reorders
//! and how it scrolls.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use conn_client::{Credential, ServerConfig};
use conn_state::{ItemStatus, ThreadState, TimelineEntry};
use futures::{SinkExt as _, StreamExt as _};
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{AnyWindowHandle, AppContext as _, Entity, ScrollDelta, TestAppContext, point, px};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{
    kitchen_sink_shell, kitchen_sink_thread, mount_app, mount_app_with_server, settle_timeline,
};
use crate::app::ConnApp;
use crate::chat::{ChatEvent, ChatView};
use crate::live::RT;

/// A queued row is `ROW_HEIGHT_PX` tall, and the tray's bottom edge runs `TUCK_PX` behind the
/// composer card (`chat/queue_tray.rs`).
const ROW_HEIGHT: f32 = 30.0;
const TUCK: f32 = 16.0;
/// How far the tray's sides sit inside the composer's.
const TRAY_INSET: f32 = 20.0;

/// A running turn with `messages` queued behind it: `run-q-1` is first in line.
fn working_thread_with_queue(messages: &[&str]) -> ThreadState {
    let mut thread = kitchen_sink_thread();
    thread.working = true;
    thread.entries.truncate(1);
    thread.entries.push(TimelineEntry::Tool {
        id: "tool-live".to_owned(),
        kind: "command".to_owned(),
        title: "cargo test --workspace".to_owned(),
        detail: None,
        status: ItemStatus::Running,
        output_omitted: false,
    });
    for (index, text) in messages.iter().enumerate() {
        let n = index + 1;
        thread.entries.push(TimelineEntry::QueuedUser {
            id: format!("q-{n}"),
            run_id: format!("run-q-{n}"),
            message_id: format!("msg-q-{n}"),
            text: (*text).to_owned(),
            attachments: Vec::new(),
            created_at: "2026-11-22T15:05:00.000Z".to_owned(),
            created_by_agent: false,
        });
    }
    thread
}

struct Mounted {
    window: AnyWindowHandle,
    app: Entity<ConnApp>,
    chat: Entity<ChatView>,
    /// Every event the chat view emitted to the shell since it mounted.
    events: Rc<RefCell<Vec<ChatEvent>>>,
}

impl Mounted {
    fn take_events(&self) -> Vec<ChatEvent> {
        std::mem::take(&mut self.events.borrow_mut())
    }
}

fn mount_with_queue(cx: &mut TestAppContext, messages: &[&str]) -> Mounted {
    let (window, app) = mount_app(cx);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(
                "thread-selected".to_owned(),
                working_thread_with_queue(messages),
                cx,
            );
        })
    });
    let chat = app.read_with(cx, |app, _| app.chat_for_test());
    let events = Rc::new(RefCell::new(Vec::new()));
    cx.update(|cx| {
        let events = Rc::clone(&events);
        cx.subscribe(&chat, move |_, event: &ChatEvent, _| {
            events.borrow_mut().push(event.clone());
        })
        .detach();
    });
    settle_timeline(cx, window);
    Mounted {
        window,
        app,
        chat,
        events,
    }
}

/// The run ids the tray shows, top to bottom.
fn tray_order(cx: &mut TestAppContext, chat: &Entity<ChatView>) -> Vec<String> {
    chat.read_with(cx, |chat, _| chat.queue_tray_run_ids_for_test())
}

/// Clicks the element `id` and lets the view settle.
fn click(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.click(id, cx);
    })
    .expect("mounted window");
    settle_timeline(cx, window);
}

fn reorder(run_id: &str, before: Option<&str>) -> ChatEvent {
    ChatEvent::ReorderQueuedMessage {
        run_id: run_id.to_owned(),
        before_run_id: before.map(str::to_owned),
    }
}

fn row_label(n: usize, total: usize, text: &str) -> String {
    format!("Queued message {n} of {total}: {text}")
}

#[gpui_kit::test]
fn the_tray_tucks_behind_the_composer_with_one_row_per_queued_message_in_send_order(
    cx: &mut TestAppContext,
) {
    let texts = ["first in line", "second in line", "third in line"];
    let mounted = mount_with_queue(cx, &texts);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        let tray = window.find_by_label("Queued messages").bounds();
        let composer = window.find_by_label("Message input card").bounds();

        // Narrower than the composer: inset on both sides, a card peeking out from behind it.
        let left_inset = f32::from(tray.left() - composer.left());
        let right_inset = f32::from(composer.right() - tray.right());
        assert!(
            (left_inset - TRAY_INSET).abs() <= 0.6,
            "the tray's left edge sits {left_inset}px inside the composer's, expected {TRAY_INSET}px"
        );
        assert!(
            (right_inset - TRAY_INSET).abs() <= 0.6,
            "the tray's right edge sits {right_inset}px inside the composer's, expected {TRAY_INSET}px"
        );
        assert!(
            (f32::from(composer.size.width - tray.size.width) - 2.0 * TRAY_INSET).abs() <= 1.2,
            "the tray is {TRAY_INSET}px narrower on each side"
        );
        assert!(
            tray.top() < composer.top(),
            "the tray starts above the composer"
        );
        // Its bottom edge runs behind the composer's top edge, so the two read as one unit.
        let tucked = f32::from(tray.bottom() - composer.top());
        assert!(
            (tucked - TUCK).abs() <= 0.6,
            "the tray tucks {tucked}px behind the composer, expected {TUCK}px"
        );

        let rows: Vec<_> = texts
            .iter()
            .enumerate()
            .map(|(index, text)| {
                window
                    .find_by_label(&row_label(index + 1, texts.len(), text))
                    .bounds()
            })
            .collect();
        for (index, row) in rows.iter().enumerate() {
            assert!(
                (f32::from(row.size.height) - ROW_HEIGHT).abs() <= 0.6,
                "row {index} is {}px tall",
                f32::from(row.size.height)
            );
            assert!(row.top() >= tray.top() && row.bottom() <= composer.top() + px(0.6));
        }
        for pair in rows.windows(2) {
            assert!(
                pair[0].bottom() <= pair[1].top() + px(0.6),
                "rows run top to bottom in send order"
            );
        }
    })
    .expect("mounted window");
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-1", "run-q-2", "run-q-3"]
    );
}

/// The hairlines between the tray's rows: how many show, and where.
fn tray_dividers(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
) -> Vec<(String, gpui_kit::Bounds<gpui_kit::Pixels>)> {
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window
            .elements()
            .iter()
            .filter_map(|element| {
                let label = element.label()?;
                label
                    .starts_with("Queued row divider")
                    .then(|| (label.to_string(), element.bounds()))
            })
            .collect()
    })
    .expect("mounted window")
}

#[gpui_kit::test]
fn a_hairline_divides_each_pair_of_rows_and_none_sits_at_the_ends(cx: &mut TestAppContext) {
    let texts = ["first in line", "second in line", "third in line"];
    let mut tray_heights = Vec::new();
    for count in 1..=texts.len() {
        let mounted = mount_with_queue(cx, &texts[..count]);
        let dividers = tray_dividers(cx, mounted.window);
        assert_eq!(
            dividers.len(),
            count - 1,
            "{count} rows draw {} dividers",
            dividers.len()
        );
        let (tray, rows) = cx
            .update_window(mounted.window, |_, window, cx| {
                window.render_frame(cx);
                let tray = window.find_by_label("Queued messages").bounds();
                let rows: Vec<_> = (0..count)
                    .map(|n| {
                        window
                            .find_by_label(&row_label(n + 1, count, texts[n]))
                            .bounds()
                    })
                    .collect();
                (tray, rows)
            })
            .expect("mounted window");
        for (index, (label, divider)) in dividers.iter().enumerate() {
            assert_eq!(label, "Queued row divider", "divider {index} shows");
            // On the boundary between two rows: none above the first or below the last.
            assert!(
                (f32::from(divider.top()) - f32::from(rows[index + 1].top())).abs() < 0.6,
                "divider {index} at {:?} is not on the top of row {}",
                divider.top(),
                index + 1
            );
            // One pixel, lined up with the row content, not the tray's edges.
            assert!((f32::from(divider.size.height) - 1.0).abs() < 0.01);
            assert!(divider.left() >= rows[index].left());
            assert!(divider.right() <= rows[index].right());
            assert!(divider.left() > tray.left() + px(8.0));
        }
        // The rows keep their height: no row grows or moves for the divider.
        for row in &rows {
            assert!((f32::from(row.size.height) - ROW_HEIGHT).abs() < 0.6);
        }
        tray_heights.push(f32::from(tray.size.height));
    }
    for pair in tray_heights.windows(2) {
        assert!(
            (pair[1] - pair[0] - ROW_HEIGHT).abs() < 0.6,
            "a row adds exactly one row height to the tray: {tray_heights:?}"
        );
    }
}

#[gpui_kit::test]
fn a_long_message_truncates_inside_the_narrower_row(cx: &mut TestAppContext) {
    let long = "word ".repeat(120);
    let long = long.trim();
    let mounted = mount_with_queue(cx, &[long, "short one"]);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        let tray = window.find_by_label("Queued messages").bounds();
        let composer = window.find_by_label("Message input card").bounds();
        let folded = long.split_whitespace().collect::<Vec<_>>().join(" ");
        let row = window
            .find_by_label(&row_label(1, 2, &folded[..folded.len().min(300)]))
            .bounds();
        assert!(
            row.left() >= tray.left() && row.right() <= tray.right(),
            "the long row stays inside the tray"
        );
        assert!(
            (f32::from(row.size.height) - ROW_HEIGHT).abs() <= 0.6,
            "the long row stays one line tall"
        );
        assert!(
            row.right() < composer.right() - px(TRAY_INSET - 1.0),
            "the long row ends inside the composer's right edge"
        );
    })
    .expect("mounted window");
}

#[gpui_kit::test]
fn an_empty_queue_has_no_tray(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &[]);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find_by_label("Queued messages").is_none());
        assert!(window.try_find_by_label("Message input card").is_some());
    })
    .expect("mounted window");
}

#[gpui_kit::test]
fn the_timeline_no_longer_renders_queued_bubbles(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line"]);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        let bubbles: Vec<String> = window
            .elements()
            .iter()
            .filter_map(|element| element.label())
            .filter(|label| {
                // The old bubble was `Queued message: <text>`; its marker was
                // `Waiting in the queue until the agent is free`.
                label.starts_with("Queued message:") || label.contains("Waiting in the queue")
            })
            .map(str::to_owned)
            .collect();
        assert!(
            bubbles.is_empty(),
            "queued bubbles in the timeline: {bubbles:?}"
        );
        // Only the tray shows them.
        assert!(
            window
                .try_find_by_label(&row_label(1, 2, "first in line"))
                .is_some()
        );
    })
    .expect("mounted window");
    // And the timeline list holds no row for them: the same thread without the queue has as many.
    let with_queue = mounted
        .chat
        .read_with(cx, |chat, _| chat.timeline_item_count_for_test());
    cx.update(|cx| {
        mounted.app.update(cx, |app, cx| {
            let mut thread = working_thread_with_queue(&[]);
            thread.revision += 1;
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        })
    });
    settle_timeline(cx, mounted.window);
    assert!(tray_order(cx, &mounted.chat).is_empty());
    let without_queue = mounted
        .chat
        .read_with(cx, |chat, _| chat.timeline_item_count_for_test());
    assert_eq!(with_queue, without_queue);
}

#[gpui_kit::test]
fn steer_sends_that_message_now_like_send_now_did(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line", "third in line"]);
    click(cx, mounted.window, "chat-queue-steer-q-2");
    assert_eq!(
        mounted.take_events(),
        vec![ChatEvent::PromoteQueuedMessage {
            run_id: "run-q-2".to_owned()
        }],
        "Steer promotes exactly the second message"
    );
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        // Every row's button reads `Steer`.
        assert_eq!(window.find_all_by_label("Steer").len(), 3);
    })
    .expect("mounted window");
}

#[gpui_kit::test]
fn the_trash_button_removes_the_message_from_the_queue(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line", "third in line"]);
    click(cx, mounted.window, "chat-queue-remove-q-2");
    assert_eq!(
        mounted.take_events(),
        vec![ChatEvent::CancelQueuedMessage {
            run_id: "run-q-2".to_owned()
        }],
        "trash cancels exactly the second message"
    );
    // The server answers with the queue minus that run, and the tray drops the row.
    cx.update(|cx| {
        mounted.app.update(cx, |app, cx| {
            let mut thread = working_thread_with_queue(&["first in line", "second in line", "third in line"]);
            thread
                .entries
                .retain(|entry| !matches!(entry, TimelineEntry::QueuedUser { run_id, .. } if run_id == "run-q-2"));
            thread.revision += 1;
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        })
    });
    settle_timeline(cx, mounted.window);
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-1", "run-q-3"]);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window
                .try_find_by_label(&row_label(2, 2, "third in line"))
                .is_some()
        );
        assert!(
            window
                .try_find_by_label(&row_label(2, 3, "second in line"))
                .is_none()
        );
    })
    .expect("mounted window");
}

#[gpui_kit::test]
fn the_more_menu_lists_edit_and_edit_opens_the_message_in_the_composer(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line"]);
    click(cx, mounted.window, "chat-queue-more-q-2");
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        for label in ["Edit", "Move up", "Move down"] {
            assert!(
                window.try_find_by_label(label).is_some(),
                "the menu has `{label}`"
            );
        }
        assert!(window.try_find("chat-queue-cancel-edit-q-2").is_none());
    })
    .expect("mounted window");
    assert_eq!(
        mounted
            .chat
            .read_with(cx, |chat, _| chat.editing_queued_run_id_for_test()),
        None
    );

    click(cx, mounted.window, "chat-queue-menu-0");
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window.try_find_by_label("Edit").is_none(),
            "the menu closes after its row runs"
        );
        // The row says where the text went, and offers to give it back.
        assert!(window.try_find("chat-queue-cancel-edit-q-2").is_some());
        assert!(window.try_find("chat-queue-steer-q-2").is_none());
    })
    .expect("mounted window");
    assert_eq!(
        mounted
            .chat
            .read_with(cx, |chat, _| chat.editing_queued_run_id_for_test()),
        Some("run-q-2".to_owned()),
        "Edit opens the second message for editing"
    );
    let composer = mounted
        .chat
        .read_with(cx, |chat, _| chat.composer_for_test());
    assert_eq!(
        composer.read_with(cx, |composer, cx| composer.draft_text_for_test(cx)),
        "second in line",
        "the message's text is in the composer"
    );
    assert!(
        mounted.take_events().is_empty(),
        "editing sends nothing until it is saved"
    );

    // Cancel gives the row back its buttons and empties the composer.
    click(cx, mounted.window, "chat-queue-cancel-edit-q-2");
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("chat-queue-steer-q-2").is_some());
    })
    .expect("mounted window");
    assert_eq!(
        mounted
            .chat
            .read_with(cx, |chat, _| chat.editing_queued_run_id_for_test()),
        None
    );
}

#[gpui_kit::test]
fn move_down_and_move_up_reorder_and_stop_at_the_ends(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line", "third in line"]);

    // Move down on the first message: before the run after the next one.
    click(cx, mounted.window, "chat-queue-more-q-1");
    click(cx, mounted.window, "chat-queue-menu-2");
    assert_eq!(
        mounted.take_events(),
        vec![reorder("run-q-1", Some("run-q-3"))]
    );
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-2", "run-q-1", "run-q-3"],
        "the tray shows the new order at once"
    );

    // Move up on the last message: before the run above it (now `run-q-1`).
    click(cx, mounted.window, "chat-queue-more-q-3");
    click(cx, mounted.window, "chat-queue-menu-1");
    assert_eq!(
        mounted.take_events(),
        vec![reorder("run-q-3", Some("run-q-1"))]
    );
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-2", "run-q-3", "run-q-1"]
    );

    // Move down on the middle message (`run-q-3` now) goes past the last one, to the end.
    click(cx, mounted.window, "chat-queue-more-q-3");
    click(cx, mounted.window, "chat-queue-menu-2");
    assert_eq!(mounted.take_events(), vec![reorder("run-q-3", None)]);
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-2", "run-q-1", "run-q-3"]
    );
}

#[gpui_kit::test]
fn the_ends_of_the_queue_cannot_move_past_the_ends(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line", "third in line"]);

    // The first message: `Move up` is off.
    click(cx, mounted.window, "chat-queue-more-q-1");
    click(cx, mounted.window, "chat-queue-menu-1");
    assert!(
        mounted.take_events().is_empty(),
        "the first message cannot move up"
    );
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-1", "run-q-2", "run-q-3"]
    );
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        assert!(
            window.try_find_by_label("Move up").is_some(),
            "a disabled row stays in the menu"
        );
    })
    .expect("mounted window");
    // A press outside the menu closes it; this one opens the last message's menu.
    // The last message: `Move down` is off.
    click(cx, mounted.window, "chat-queue-more-q-3");
    click(cx, mounted.window, "chat-queue-menu-2");
    assert!(
        mounted.take_events().is_empty(),
        "the last message cannot move down"
    );
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-1", "run-q-2", "run-q-3"]
    );
}

#[gpui_kit::test]
fn dragging_a_row_to_another_reorders_the_queue(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line", "third in line"]);

    // Drop the first row on the middle of the third: the gap above the third row.
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        window.drag_to("chat-queue-row-q-1", "chat-queue-row-q-3", cx);
    })
    .expect("mounted window");
    settle_timeline(cx, mounted.window);
    assert_eq!(
        mounted.take_events(),
        vec![reorder("run-q-1", Some("run-q-3"))]
    );
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-2", "run-q-1", "run-q-3"]
    );

    // And back up: the last row dropped on the first goes to the top.
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        window.drag_to("chat-queue-row-q-3", "chat-queue-row-q-2", cx);
    })
    .expect("mounted window");
    settle_timeline(cx, mounted.window);
    assert_eq!(
        mounted.take_events(),
        vec![reorder("run-q-3", Some("run-q-2"))]
    );
    assert_eq!(
        tray_order(cx, &mounted.chat),
        ["run-q-3", "run-q-2", "run-q-1"]
    );
}

#[gpui_kit::test]
fn dropping_a_row_back_where_it_was_sends_nothing(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line"]);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        window.drag_to("chat-queue-row-q-1", "chat-queue-row-q-1", cx);
    })
    .expect("mounted window");
    settle_timeline(cx, mounted.window);
    assert!(mounted.take_events().is_empty());
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-1", "run-q-2"]);
}

#[gpui_kit::test]
fn a_reorder_the_server_refuses_puts_the_servers_order_back(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line"]);
    click(cx, mounted.window, "chat-queue-more-q-1");
    click(cx, mounted.window, "chat-queue-menu-2");
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-2", "run-q-1"]);
    mounted
        .chat
        .update(cx, |chat, cx| chat.queue_reorder_failed(cx));
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-1", "run-q-2"]);
}

#[gpui_kit::test]
fn the_servers_new_order_replaces_the_optimistic_one(cx: &mut TestAppContext) {
    let mounted = mount_with_queue(cx, &["first in line", "second in line"]);
    click(cx, mounted.window, "chat-queue-more-q-1");
    click(cx, mounted.window, "chat-queue-menu-2");
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-2", "run-q-1"]);
    // The server's queue now has them the other way round, as it was asked.
    cx.update(|cx| {
        mounted.app.update(cx, |app, cx| {
            let mut thread = working_thread_with_queue(&["first in line", "second in line"]);
            let queued: Vec<TimelineEntry> = thread.entries.drain(2..).rev().collect();
            thread.entries.extend(queued);
            thread.revision += 1;
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        })
    });
    settle_timeline(cx, mounted.window);
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-2", "run-q-1"]);
    // A later order from the server is not held back by the one that came before it.
    cx.update(|cx| {
        mounted.app.update(cx, |app, cx| {
            let mut thread = working_thread_with_queue(&["first in line", "second in line"]);
            thread.revision += 2;
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        })
    });
    settle_timeline(cx, mounted.window);
    assert_eq!(tray_order(cx, &mounted.chat), ["run-q-1", "run-q-2"]);
}

#[gpui_kit::test]
fn a_long_queue_caps_the_tray_height_and_scrolls(cx: &mut TestAppContext) {
    let texts: Vec<String> = (1..=8).map(|n| format!("message number {n}")).collect();
    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
    let mounted = mount_with_queue(cx, &refs);

    let (tray_height, first_top) = cx
        .update_window(mounted.window, |_, window, cx| {
            window.render_frame(cx);
            let tray = window.find_by_label("Queued messages").bounds();
            let first = window
                .find_by_label(&row_label(1, texts.len(), &texts[0]))
                .bounds();
            (f32::from(tray.size.height), f32::from(first.top()))
        })
        .expect("mounted window");
    let all_rows = ROW_HEIGHT * texts.len() as f32;
    assert!(
        tray_height < all_rows,
        "{} rows would be {all_rows}px tall, the tray is {tray_height}px",
        texts.len()
    );
    // About four and a half rows, plus the padding and the tucked part.
    assert!(
        tray_height <= ROW_HEIGHT * 5.0 + 8.0 + TUCK + 2.0,
        "the tray is {tray_height}px tall"
    );
    assert!(
        mounted
            .chat
            .read_with(cx, |chat, _| chat.queue_tray_max_scroll_for_test())
            > 0.0
    );

    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        window.scroll(
            "chat-queue-rows",
            ScrollDelta::Pixels(point(px(0.0), px(-ROW_HEIGHT * 2.0))),
            cx,
        );
        window.render_frame(cx);
    })
    .expect("mounted window");
    settle_timeline(cx, mounted.window);
    assert!(
        mounted
            .chat
            .read_with(cx, |chat, _| chat.queue_tray_scrolled_for_test())
            > 0.0,
        "the rows scroll"
    );
    let scrolled_top = cx
        .update_window(mounted.window, |_, window, cx| {
            window.render_frame(cx);
            f32::from(
                window
                    .find_by_label(&row_label(1, texts.len(), &texts[0]))
                    .bounds()
                    .top(),
            )
        })
        .expect("mounted window");
    assert!(
        scrolled_top < first_top,
        "the first row moved up out of the tray ({first_top} -> {scrolled_top})"
    );
    // The last row can be reached.
    cx.update_window(mounted.window, |_, window, cx| {
        window.scroll(
            "chat-queue-rows",
            ScrollDelta::Pixels(point(px(0.0), px(-ROW_HEIGHT * 20.0))),
            cx,
        );
        window.render_frame(cx);
    })
    .expect("mounted window");
    settle_timeline(cx, mounted.window);
    cx.update_window(mounted.window, |_, window, cx| {
        window.render_frame(cx);
        let tray = window.find_by_label("Queued messages").bounds();
        let last = window
            .find_by_label(&row_label(
                texts.len(),
                texts.len(),
                &texts[texts.len() - 1],
            ))
            .bounds();
        assert!(
            last.bottom() <= tray.bottom() + px(0.6),
            "the last row scrolled into the tray"
        );
    })
    .expect("mounted window");
}

#[gpui_kit::test]
fn the_tray_leaves_the_last_timeline_row_clear_of_the_composer(cx: &mut TestAppContext) {
    // The timeline pads its end by the composer lane's height, and the tray is in that lane, so
    // the work above the tray is never covered by it.
    let queued = mount_with_queue(cx, &["first in line", "second in line", "third in line"]);
    let (tray_top, work_bottom) = cx
        .update_window(queued.window, |_, window, cx| {
            window.render_frame(cx);
            let tray = window.find_by_label("Queued messages").bounds();
            let work = window
                .elements()
                .iter()
                .filter(|element| {
                    element
                        .label()
                        .is_some_and(|label| label.contains("cargo test --workspace"))
                })
                .map(|element| f32::from(element.bounds().bottom()))
                .fold(f32::MIN, f32::max);
            (f32::from(tray.top()), work)
        })
        .expect("mounted window");
    assert!(
        work_bottom <= tray_top + 0.6,
        "the live work row ends at {work_bottom}, the tray starts at {tray_top}"
    );
}

// ---------------------------------------------------------------------------------------------
// The reorder reaches the server, in order.
// ---------------------------------------------------------------------------------------------

/// A loopback `conn-server` that records every `orchestration.dispatchCommand` payload and
/// answers it, and reports every request tag.
fn spawn_dispatch_server() -> (
    url::Url,
    std::sync::mpsc::Receiver<String>,
    std::sync::mpsc::Receiver<serde_json::Value>,
) {
    let (tags_tx, tags_rx) = std::sync::mpsc::channel::<String>();
    let (dispatch_tx, dispatch_rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let addr = RT.block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback listener");
        let addr = listener.local_addr().expect("a listener address");
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let tags_tx = tags_tx.clone();
                let dispatch_tx = dispatch_tx.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = ws.next().await {
                        for frame in conn_wire::decode_client_message(&text).unwrap_or_default() {
                            if let conn_wire::FromClient::Request(req) = frame {
                                if req.tag == "orchestration.dispatchCommand" {
                                    let _ = dispatch_tx.send(req.payload);
                                    let reply = conn_wire::FromServer::Exit {
                                        request_id: req.id,
                                        exit: conn_wire::Exit::success(
                                            serde_json::json!({"sequence": 1}),
                                        ),
                                    };
                                    ws.send(Message::Text(
                                        conn_wire::encode_server_frame(&reply).into(),
                                    ))
                                    .await
                                    .expect("answer the command");
                                }
                                let _ = tags_tx.send(req.tag);
                            }
                        }
                    }
                });
            }
        });
        addr
    });
    (
        url::Url::parse(&format!("http://{addr}")).expect("a loopback URL"),
        tags_rx,
        dispatch_rx,
    )
}

#[gpui_kit::test]
async fn a_drag_and_the_menu_send_queued_run_reorder_to_the_server_in_that_order(
    cx: &mut TestAppContext,
) {
    cx.executor().allow_parking();
    let (http_base_url, tags, dispatched) = spawn_dispatch_server();
    let (window, app) = mount_app_with_server(
        cx,
        Some(crate::live::StartupServer {
            config: ServerConfig {
                http_base_url,
                credential: Credential::Bearer("test-token".to_owned()),
            },
            label: None,
            orbit_server_id: None,
        }),
    );
    while tags
        .recv_timeout(Duration::from_secs(5))
        .expect("a request from the app")
        != "subscribeServerConfig"
    {}
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(kitchen_sink_shell(), cx);
            app.set_thread_for_test(
                "thread-selected".to_owned(),
                working_thread_with_queue(&["first in line", "second in line", "third in line"]),
                cx,
            );
        })
    });
    settle_timeline(cx, window);

    // Drag the first message down onto the third: before `run-q-3`.
    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        window.drag_to("chat-queue-row-q-1", "chat-queue-row-q-3", cx);
    })
    .expect("mounted window");
    settle_timeline(cx, window);
    // Then `Move up` on the last message (now `run-q-3`, below `run-q-1`): before `run-q-1`.
    click(cx, window, "chat-queue-more-q-3");
    click(cx, window, "chat-queue-menu-1");

    let mut commands = Vec::new();
    while commands.len() < 2 {
        cx.run_until_parked();
        match dispatched.recv_timeout(Duration::from_millis(50)) {
            Ok(command) => commands.push(command),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(err) => panic!("the server stopped hearing commands: {err}"),
        }
    }
    let wire: Vec<(String, String, Option<String>)> = commands
        .iter()
        .map(|command| {
            assert_eq!(command["type"], "queued-run.reorder");
            assert_eq!(command["threadId"], "thread-selected");
            (
                command["type"].as_str().unwrap_or_default().to_owned(),
                command["runId"].as_str().unwrap_or_default().to_owned(),
                command["beforeRunId"].as_str().map(str::to_owned),
            )
        })
        .collect();
    assert_eq!(
        wire,
        vec![
            (
                "queued-run.reorder".to_owned(),
                "run-q-1".to_owned(),
                Some("run-q-3".to_owned())
            ),
            (
                "queued-run.reorder".to_owned(),
                "run-q-3".to_owned(),
                Some("run-q-1".to_owned())
            ),
        ],
        "the server gets the moves in the order they were made, each naming the run it goes before"
    );
}
