//! Cards in the timeline: their inner surface sits on the text column, and only that inner surface
//! takes the pointer.

use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{Bounds, HeadlessAppContext, Pixels, point, px};

use super::card_face::CARD_INSET_PX;
use super::card_shots::{
    AGENT_CARD_LABEL, bounds_of, hover, open_scene, open_thread_scene, subagent_card_id,
    subagent_scene,
};

/// An offscreen context for a test: `current_platform(true)` needs the main thread, which libtest
/// does not give a test.
fn headless() -> HeadlessAppContext {
    HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    )
}

fn left(bounds: Bounds<Pixels>) -> f32 {
    f32::from(bounds.left())
}

fn right(bounds: Bounds<Pixels>) -> f32 {
    f32::from(bounds.right())
}

fn assert_close(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 0.5,
        "{what}: {actual} is not {expected}"
    );
}

/// The inner surface of the agent card and of the code card sit on the paragraph's left and right
/// edges, and each frame reaches [`CARD_INSET_PX`] past them on each side, inside the window. It
/// holds at a wide window and at narrow ones.
#[test]
fn card_bodies_sit_on_the_text_column() {
    let mut ctx = headless();
    for width in [1100.0_f32, 640.0, 420.0] {
        let (window, _) = open_scene(&mut ctx, "dark-ocean", width, 1400.0);
        ctx.update_window(window, |_, window, _| {
            let elements = window.elements();
            let by_id = |prefix: &str| {
                elements
                    .iter()
                    .find(|e| {
                        e.path()
                            .last()
                            .is_some_and(|id| id.to_string().starts_with(prefix))
                    })
                    .unwrap_or_else(|| {
                        panic!("no element with an id starting `{prefix}` at {width}")
                    })
                    .bounds()
            };
            let by_label = |prefix: &str| {
                elements
                    .iter()
                    .find(|e| e.label().is_some_and(|l| l.starts_with(prefix)))
                    .unwrap_or_else(|| panic!("no element labelled `{prefix}…` at {width}"))
                    .bounds()
            };
            let text = by_id("assistant-text-answer-1");
            let second_text = by_id("assistant-text-answer-2");
            let agent = by_id("agent-msg-body-");
            let agent_frame = by_label(AGENT_CARD_LABEL);
            let code = by_id("code-body-");
            let code_frame = by_label("Code block");
            let at = |what: &str| format!("{what} at {width}px");

            assert!(
                right(text) > left(text) + 4.0 * CARD_INSET_PX,
                "{}",
                at("a text column")
            );
            assert_close(left(agent), left(text), &at("agent body left"));
            assert_close(right(agent), right(text), &at("agent body right"));
            assert_close(left(code), left(second_text), &at("code body left"));
            assert_close(right(code), right(second_text), &at("code body right"));
            assert_close(
                left(agent_frame),
                left(text) - CARD_INSET_PX,
                &at("agent frame left"),
            );
            assert_close(
                right(agent_frame),
                right(text) + CARD_INSET_PX,
                &at("agent frame right"),
            );
            assert_close(
                left(code_frame),
                left(second_text) - CARD_INSET_PX,
                &at("code frame left"),
            );
            assert_close(
                right(code_frame),
                right(second_text) + CARD_INSET_PX,
                &at("code frame right"),
            );
            for frame in [agent_frame, code_frame] {
                assert!(left(frame) >= 0.0, "{}", at("a frame leaves the window"));
                assert!(
                    right(frame) <= width,
                    "{}",
                    at("a frame runs past the window")
                );
            }
        })
        .expect("the window");
    }
}

/// `[r, g, b, a]` of the pixel under a window point in a capture drawn at `scale`.
fn pixel(image: &image::RgbaImage, scale: f32, x: f32, y: f32) -> [u8; 4] {
    image.get_pixel((x * scale) as u32, (y * scale) as u32).0
}

/// Under the pointer, the agent card's body changes colour and its frame and header do not, in
/// dark and light, whether the pointer is on the header or on the body. The frame's fill is
/// sampled in its inset ring and in the header's empty right end.
#[test]
fn only_the_inner_card_takes_the_hover() {
    let mut ctx = headless();
    for theme_id in ["dark-ocean", "t3-code-light"] {
        let width = 1100.0;
        let (window, _) = open_scene(&mut ctx, theme_id, width, 560.0);
        let frame = bounds_of(&mut ctx, window, AGENT_CARD_LABEL);
        let body = ctx
            .update_window(window, |_, w, _| w.find("agent-msg-body-agent-1").bounds())
            .expect("the card's body");

        let ring = (
            left(frame) + CARD_INSET_PX / 2.0,
            f32::from(frame.center().y),
        );
        let header = (
            right(frame) - 40.0,
            f32::from(frame.top()) + CARD_INSET_PX + 15.0,
        );
        let inner = (f32::from(body.center().x), f32::from(body.bottom()) - 4.0);
        let away = point(px(4.0), px(4.0));
        let on_header = point(px(header.0 - 120.0), px(header.1));
        let on_body = point(px(inner.0), px(inner.1));

        let sample = |ctx: &mut HeadlessAppContext, at| {
            hover(ctx, window, at);
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            let scale = image.width() as f32 / width;
            (
                pixel(&image, scale, ring.0, ring.1),
                pixel(&image, scale, header.0, header.1),
                pixel(&image, scale, inner.0, inner.1),
            )
        };
        let (ring_rest, header_rest, body_rest) = sample(&mut ctx, away);
        assert_ne!(
            ring_rest, body_rest,
            "{theme_id}: frame and body differ at rest"
        );
        for (name, at) in [("header", on_header), ("body", on_body)] {
            let (ring_hot, header_hot, body_hot) = sample(&mut ctx, at);
            assert_eq!(
                ring_hot, ring_rest,
                "{theme_id}: the frame keeps its fill with the pointer on the {name}"
            );
            assert_eq!(
                header_hot, header_rest,
                "{theme_id}: the header keeps its fill with the pointer on the {name}"
            );
            assert_ne!(
                body_hot, body_rest,
                "{theme_id}: the body takes the hover with the pointer on the {name}"
            );
            assert_ne!(
                body_hot, ring_rest,
                "{theme_id}: the hovered body does not melt into the frame ({name})"
            );
        }
    }
}

/// The accessibility label of the provider mark on the subagent card `driver` in the scene.
fn provider_mark_label(
    ctx: &mut HeadlessAppContext,
    window: gpui_kit::AnyWindowHandle,
    driver: &str,
) -> String {
    let prefix = format!("subagent-provider-{}", subagent_card_id(driver));
    ctx.update_window(window, |_, window, _| {
        window
            .elements()
            .iter()
            .find(|e| {
                e.path()
                    .last()
                    .is_some_and(|id| id.to_string().starts_with(&prefix))
            })
            .unwrap_or_else(|| panic!("no provider mark on the `{driver}` card"))
            .label()
            .unwrap_or_default()
            .to_owned()
    })
    .unwrap_or_else(|error| panic!("no window: {error}"))
}

/// A subagent card shows its provider's mark: Claude for a Claude agent, OpenAI for Codex. A task
/// on another machine has the driver `remote`, so its mark comes from the instance it runs; an
/// unknown provider keeps the generic agent glyph.
#[test]
fn subagent_card_shows_the_provider_mark() {
    let mut ctx = headless();
    let thread = subagent_scene(&[
        ("claudeAgent", "claudeAgent", "claude-opus-5-5", None),
        ("codex", "codex", "gpt-5.5", None),
        ("remote", "claudeAgent", "claude-opus-5-5", Some("nick")),
        ("mystery", "mystery", "mystery-1", None),
    ]);
    let (window, _) = open_thread_scene(&mut ctx, "dark-ocean", 900.0, 1200.0, thread);
    assert_eq!(
        provider_mark_label(&mut ctx, window, "claudeAgent"),
        "Claude"
    );
    assert_eq!(provider_mark_label(&mut ctx, window, "codex"), "OpenAI");
    assert_eq!(provider_mark_label(&mut ctx, window, "remote"), "Claude");
    assert_eq!(provider_mark_label(&mut ctx, window, "mystery"), "Agent");
}
