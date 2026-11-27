//! The cards' test scene, and env-gated offscreen renders of it (`render_card_screenshots`).
//!
//! The scene is a message paragraph directly above an agent card, and one above a code card, so
//! the shots show whether a card's inner surface sits on the paragraph's edges.

use std::path::Path;

use conn_state::{ItemStatus, SubagentModel, ThreadState, TimelineEntry, TurnItemStatus};
use conn_theme::Tokens;
use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, HeadlessAppContext, Pixels, Point, WindowBounds,
    WindowOptions, point, px, size,
};

use crate::app::{ConnApp, register_keybindings};

const WIDTH_PX: f32 = 1100.0;
const HEIGHT_PX: f32 = 800.0;

/// The label of the agent card's button, which is the whole card.
pub(super) const AGENT_CARD_LABEL: &str = "Expand agent message";

/// A paragraph, an agent card, a paragraph, and a code card.
pub(super) fn scene() -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    thread.entries = vec![
        TimelineEntry::Assistant {
            id: "answer-1".to_owned(),
            markdown: "This paragraph sits directly above the agent card. Its text starts on the \
                       same left edge as the card's inner surface, and the lines end on the same \
                       right edge, while the darker frame reaches a little past both."
                .to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
        TimelineEntry::User {
            id: "agent-1".to_owned(),
            text: "Please check the card hover state. Only the inner card should light up under \
                   the pointer. The frame and its header keep their own fill, and this preview \
                   runs onto a second line."
                .to_owned(),
            created_by_agent: true,
            sender: None,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: Some("run-1".to_owned()),
        },
        TimelineEntry::Assistant {
            id: "answer-2".to_owned(),
            markdown: "A second paragraph sits directly above a code card, whose code surface \
                       lines up with it in the same way.\n\n```rust\nfn main() {\n    \
                       println!(\"hello\");\n}\n```"
                .to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
    ];
    thread
}

/// The id of the subagent card for `driver` in [`subagent_scene`].
pub(super) fn subagent_card_id(driver: &str) -> String {
    format!("sub-{driver}")
}

/// One delegated subagent card for each of `rows`: a driver, the instance and model it runs, and
/// the machine it runs on, if not this one.
pub(super) fn subagent_scene(rows: &[(&str, &str, &str, Option<&str>)]) -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    for (driver, instance, model, machine) in rows {
        let id = subagent_card_id(driver);
        thread.entries.push(TimelineEntry::Subagent {
            id: id.clone(),
            child_thread_id: machine.is_none().then(|| format!("child-{driver}")),
            title: format!("Check the {driver} card header"),
            role: (*driver).to_owned(),
            status: TurnItemStatus::Running,
            summary: Some("Looking at the header icon.".to_owned()),
            remote_child: machine.map(|label| {
                serde_json::from_value(serde_json::json!({
                    "environmentId": "nick",
                    "threadId": format!("remote-{driver}"),
                    "label": label,
                }))
                .unwrap_or_else(|error| panic!("no remote child: {error}"))
            }),
            created_at: Some("2026-11-26T10:00:00.000Z".to_owned()),
            started_at: Some("2026-11-26T10:00:00.000Z".to_owned()),
            completed_at: None,
        });
        // The projection's subagent behind the card, and the model it runs.
        let subagent = format!("subagent-{driver}");
        thread.subagent_of_entry.insert(id, subagent.clone());
        thread.subagent_models.insert(
            subagent,
            SubagentModel {
                model: Some((*model).to_owned()),
                instance_id: Some((*instance).to_owned()),
                options: [("reasoningEffort".to_owned(), "medium".to_owned())].into(),
            },
        );
    }
    thread
}

/// A hidden offscreen window of `width` × `height` on `theme_id`, showing [`scene`]. It opens
/// nothing on screen and takes no focus.
pub(super) fn open_scene(
    ctx: &mut HeadlessAppContext,
    theme_id: &str,
    width: f32,
    height: f32,
) -> (AnyWindowHandle, Tokens) {
    open_thread_scene(ctx, theme_id, width, height, scene())
}

/// [`open_scene`] showing `thread`.
pub(super) fn open_thread_scene(
    ctx: &mut HeadlessAppContext,
    theme_id: &str,
    width: f32,
    height: f32,
    thread: ThreadState,
) -> (AnyWindowHandle, Tokens) {
    let theme = conn_theme::theme_by_id(theme_id)
        .unwrap_or_else(|| panic!("{theme_id} is not a built-in theme"));
    let tokens = Tokens::derive(&theme);
    let (window, app) = ctx.update(|cx| {
        gpui_kit::init(cx);
        crate::fonts::register(cx);
        crate::theme::apply_kit_theme(&tokens, cx);
        register_keybindings(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(width), px(height)),
                ))),
                focus: false,
                show: false,
                ..Default::default()
            },
            cx,
            {
                let tokens = tokens.clone();
                move |window, cx| cx.new(|cx| ConnApp::new(theme.id, tokens, None, window, cx))
            },
        )
        .unwrap_or_else(|error| panic!("no window: {error}"))
    });
    ctx.update(|cx| {
        app.update(cx, |app, cx| {
            app.set_shell(crate::ui_tests::kitchen_sink_shell(), cx);
            app.set_thread_for_test("thread-selected".to_owned(), thread, cx);
        });
    });
    settle(ctx, window);
    (window, tokens)
}

/// Draws until nothing is left to draw.
pub(super) fn settle(ctx: &mut HeadlessAppContext, window: AnyWindowHandle) {
    for _ in 0..4 {
        ctx.update_window(window, |_, w, c| w.render_frame(c))
            .unwrap_or_else(|error| panic!("no frame: {error}"));
        ctx.run_until_parked();
    }
}

/// Moves the pointer to `at` and draws the frame that shows it.
pub(super) fn hover(ctx: &mut HeadlessAppContext, window: AnyWindowHandle, at: Point<Pixels>) {
    ctx.update_window(window, |_, w, c| w.pointer_move(at, None, c))
        .unwrap_or_else(|error| panic!("no pointer move: {error}"));
    settle(ctx, window);
}

/// The bounds of the element labelled `label`.
pub(super) fn bounds_of(
    ctx: &mut HeadlessAppContext,
    window: AnyWindowHandle,
    label: &str,
) -> Bounds<Pixels> {
    ctx.update_window(window, |_, w, _| w.find_by_label(label).bounds())
        .unwrap_or_else(|error| panic!("no window: {error}"))
}

/// Renders [`scene`] offscreen to PNG in dark and light, with the pointer away, on the agent card's
/// header, and on its body. It opens no window on screen and takes no focus.
///
/// `CONN_CARD_SHOTS_DIR=<dir> CONN_CARD_SHOTS_PREFIX=after cargo test -p conn-app
/// render_card_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_CARD_SHOTS_DIR"]
fn render_card_screenshots() {
    let Some(dir) = std::env::var_os("CONN_CARD_SHOTS_DIR") else {
        return;
    };
    let prefix = std::env::var("CONN_CARD_SHOTS_PREFIX").unwrap_or_else(|_| "shot".to_owned());
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let (window, _) = open_scene(&mut ctx, theme_id, WIDTH_PX, HEIGHT_PX);
        let card = bounds_of(&mut ctx, window, AGENT_CARD_LABEL);
        let away = point(px(4.0), px(4.0));
        let header = point(
            card.origin.x + card.size.width * 0.6,
            card.origin.y + px(18.0),
        );
        let body = point(
            card.origin.x + card.size.width * 0.5,
            card.origin.y + card.size.height - px(14.0),
        );
        for (state, at) in [
            ("rest", away),
            ("header-hover", header),
            ("body-hover", body),
        ] {
            hover(&mut ctx, window, at);
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("{prefix}-{label}-{state}.png")))
                .expect("a saved PNG");
        }
    }
}

/// Renders delegated subagent cards offscreen to PNG in dark and light: Claude, Codex, and a Claude
/// task on another machine, whose driver is `remote`.
///
/// `CONN_CARD_SHOTS_DIR=<dir> cargo test -p conn-app render_subagent_icon_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_CARD_SHOTS_DIR"]
fn render_subagent_icon_screenshots() {
    let Some(dir) = std::env::var_os("CONN_CARD_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let thread = subagent_scene(&[
            ("claudeAgent", "claudeAgent", "claude-opus-5-5", None),
            ("codex", "codex", "gpt-5.5", None),
            ("remote", "claudeAgent", "claude-opus-5-5", Some("nick")),
            ("remote-codex", "codex", "gpt-5.5", Some("nick")),
            ("mystery", "mystery", "mystery-1", None),
        ]);
        let (window, _) = open_thread_scene(&mut ctx, theme_id, 760.0, 900.0, thread);
        let image = ctx.capture_screenshot(window).expect("a screenshot");
        image
            .save(dir.join(format!("agent-card-icon-{label}.png")))
            .expect("a saved PNG");
    }
}
