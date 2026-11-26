//! Headless tests of the Pull requests panel's empty and error states, and the offscreen renders
//! of each (`render_notice_screenshots`).

use std::path::Path;
use std::rc::Rc;

use conn_theme::Tokens;
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, Bounds, Context, IntoElement, Pixels, Point, Render, TestAppContext, Window,
    WindowBounds, WindowOptions, px, size,
};

use super::header::render_unavailable_state;
use super::inbox::{InboxNotice, PullRequestInbox, inbox_notice, notice_state};
use super::logic::{CLI_MISSING_MESSAGE, SIGNED_OUT_MESSAGE, unavailable_notice};
use crate::panels::empty_state::{render_empty_state, shots};

const WIDTH_PX: f32 = 520.0;
const HEIGHT_PX: f32 = 700.0;

/// Shows one inbox notice the way the panel does.
struct NoticeHost {
    tokens: Tokens,
    notice: InboxNotice,
}

impl Render for NoticeHost {
    fn render(&mut self, window: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
        let retry: Rc<dyn Fn(&mut Window, &mut gpui_kit::App)> = Rc::new(|_, _| {});
        v_flex().size_full().child(render_empty_state(
            window,
            &self.tokens,
            notice_state(&self.notice, Some(retry)),
        ))
    }
}

/// Shows the detail panel's unavailable state with both of its buttons.
struct DetailHost {
    tokens: Tokens,
}

impl Render for DetailHost {
    fn render(&mut self, window: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
        let (icon, title) = unavailable_notice(SIGNED_OUT_MESSAGE);
        v_flex().size_full().child(render_unavailable_state(
            window,
            &self.tokens,
            icon,
            title,
            SIGNED_OUT_MESSAGE,
            Some(Rc::new(|_, _| {})),
            Some((
                "https://example.com/pull/1".to_owned(),
                "Open on GitHub",
                Rc::new(|_, _, _| {}),
            )),
        ))
    }
}

fn open_in(
    cx: &mut TestAppContext,
    build: impl FnOnce(&mut Window, &mut Context<'_, NoticeHost>) -> NoticeHost + 'static,
) -> AnyWindowHandle {
    let (window, _) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(WIDTH_PX), px(HEIGHT_PX)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| build(window, cx)),
        )
        .expect("a window")
    });
    frames(cx, window);
    window
}

fn frames(cx: &mut TestAppContext, window: AnyWindowHandle) {
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
}

fn bounds(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) -> Bounds<Pixels> {
    cx.update_window(window, |_, w, _| w.find(id).bounds())
        .expect("a window")
}

fn shown(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) -> bool {
    cx.update_window(window, |_, w, _| w.try_find(id).is_some())
        .expect("a window")
}

fn labelled(cx: &mut TestAppContext, window: AnyWindowHandle, label: &'static str) -> bool {
    cx.update_window(window, |_, w, _| w.try_find_by_label(label).is_some())
        .expect("a window")
}

#[test]
fn the_inbox_picks_its_whole_panel_state_from_what_it_has_loaded() {
    // (connection, failed, loaded, loading, has rows, error)
    assert_eq!(
        inbox_notice(false, false, false, false, false, None),
        Some(InboxNotice::NoServer)
    );
    assert_eq!(
        inbox_notice(true, false, false, false, false, None),
        None,
        "not loaded yet"
    );
    assert_eq!(
        inbox_notice(true, false, false, true, false, None),
        None,
        "loading"
    );
    assert_eq!(
        inbox_notice(true, false, true, false, false, None),
        Some(InboxNotice::NoPullRequests)
    );
    assert_eq!(
        inbox_notice(true, false, true, false, true, None),
        None,
        "has rows"
    );
    assert_eq!(
        inbox_notice(true, true, false, false, false, Some("down")),
        Some(InboxNotice::Failed("down".to_owned()))
    );
    assert_eq!(
        inbox_notice(true, true, false, false, true, Some("down")),
        None,
        "a failed refresh keeps the rows it has"
    );
    assert_eq!(
        inbox_notice(true, false, true, false, false, Some("a project failed")),
        None,
        "a partial failure shows in the list"
    );
}

#[test]
fn unavailable_messages_map_to_the_labs_titles_and_icons() {
    assert_eq!(
        unavailable_notice(SIGNED_OUT_MESSAGE),
        ("superhero/lock.svg", "Not signed in")
    );
    assert_eq!(
        unavailable_notice(CLI_MISSING_MESSAGE),
        ("superhero/terminal.svg", "Source-control CLI missing")
    );
    assert_eq!(
        unavailable_notice("This repository's host does not support pull requests here yet."),
        ("superhero/unplug.svg", "Pull requests unavailable")
    );
}

#[gpui_kit::test]
fn each_state_is_the_shared_block_near_the_top(cx: &mut TestAppContext) {
    for (notice, title, description, retry) in [
        (
            InboxNotice::NoPullRequests,
            "No pull requests",
            "Pull requests from this workspace's repositories show here.",
            false,
        ),
        (
            InboxNotice::Failed(SIGNED_OUT_MESSAGE.to_owned()),
            "Not signed in",
            SIGNED_OUT_MESSAGE,
            true,
        ),
        (
            InboxNotice::Failed(CLI_MISSING_MESSAGE.to_owned()),
            "Source-control CLI missing",
            CLI_MISSING_MESSAGE,
            true,
        ),
        (
            InboxNotice::NoServer,
            "Pull requests unavailable",
            "Connect to a Conn server to browse pull requests.",
            false,
        ),
    ] {
        let window = open_in(cx, move |_, _| NoticeHost {
            tokens: shots::tokens_for("dark-ocean"),
            notice,
        });
        let block = bounds(cx, window, "pr-inbox-empty");
        let mark = bounds(cx, window, "pr-inbox-empty-mark");
        assert_eq!(mark.size, size(px(40.0), px(40.0)), "{title}");
        assert_eq!(
            mark.top() - block.top(),
            px(32.0_f32.max(HEIGHT_PX * 0.08)),
            "{title}"
        );
        assert!(
            (mark.center().x - px(WIDTH_PX / 2.0)).abs() < px(0.5),
            "{title}"
        );
        assert!(labelled(cx, window, title), "{title}");
        assert!(labelled(cx, window, description), "{title}");
        assert!(bounds(cx, window, "pr-inbox-empty-description").size.width <= px(380.0));
        assert_eq!(shown(cx, window, "pr-inbox-retry"), retry, "{title}");
        if retry {
            let button = bounds(cx, window, "pr-inbox-retry");
            assert_eq!(button.size.height, px(32.0), "{title}");
            assert!(labelled(cx, window, "Try again"));
        }
    }
}

#[gpui_kit::test]
fn the_detail_state_lays_its_two_buttons_in_one_row(cx: &mut TestAppContext) {
    let (window, _) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(WIDTH_PX), px(HEIGHT_PX)),
                ))),
                ..Default::default()
            },
            cx,
            |_, cx| {
                cx.new(|_| DetailHost {
                    tokens: shots::tokens_for("dark-ocean"),
                })
            },
        )
        .expect("a window")
    });
    frames(cx, window);
    let retry = bounds(cx, window, "pr-unavailable-retry");
    let host = bounds(cx, window, "pr-unavailable-open-host");
    assert_eq!(retry.size.height, px(32.0));
    assert_eq!(retry.top(), host.top());
    assert_eq!(host.left() - retry.right(), px(8.0));
    assert!(labelled(cx, window, "Not signed in"));
}

#[gpui_kit::test]
fn the_inbox_without_a_server_shows_the_unavailable_state_and_no_toolbar(cx: &mut TestAppContext) {
    let (window, _) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(WIDTH_PX), px(HEIGHT_PX)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    PullRequestInbox::new(shots::tokens_for("dark-ocean"), None, window, cx)
                })
            },
        )
        .expect("a window")
    });
    frames(cx, window);
    assert!(shown(cx, window, "pr-inbox-empty"));
    assert!(labelled(cx, window, "Pull requests unavailable"));
    assert!(
        !shown(cx, window, "pr-inbox-rows"),
        "no list under the state"
    );
    assert!(
        !shown(cx, window, "pr-inbox-retry"),
        "nothing to retry without a server"
    );
}

/// Renders every Pull requests state offscreen to PNG, in Dark Ocean and Light.
///
/// `CONN_EMPTY_SHOTS_DIR=<dir> cargo test -p conn-app render_notice_screenshots -- --ignored`
#[test]
#[cfg(target_os = "macos")]
#[ignore = "writes PNGs; set CONN_EMPTY_SHOTS_DIR"]
fn render_notice_screenshots() {
    let Some(dir) = std::env::var_os("CONN_EMPTY_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir).join("pull-requests");
    std::fs::create_dir_all(&dir).expect("an output folder");
    let mut ctx = shots::context();
    for (theme, label) in shots::THEMES {
        let tokens = shots::tokens_for(theme);
        for (name, notice) in [
            ("a-none", InboxNotice::NoPullRequests),
            (
                "b-signed-out",
                InboxNotice::Failed(SIGNED_OUT_MESSAGE.to_owned()),
            ),
            (
                "c-no-cli",
                InboxNotice::Failed(CLI_MISSING_MESSAGE.to_owned()),
            ),
            ("d-unavailable", InboxNotice::NoServer),
            (
                "e-unsupported-host",
                InboxNotice::Failed(
                    "This repository's host does not support pull requests here yet.".to_owned(),
                ),
            ),
        ] {
            let host_tokens = tokens.clone();
            let (window, _) = shots::open(&mut ctx, &tokens, (WIDTH_PX, HEIGHT_PX), move |_, _| {
                NoticeHost {
                    tokens: host_tokens,
                    notice,
                }
            });
            shots::shoot(&mut ctx, window, &dir, name, label);
        }
        let host_tokens = tokens.clone();
        let (window, _) = shots::open(&mut ctx, &tokens, (WIDTH_PX, HEIGHT_PX), move |_, _| {
            DetailHost {
                tokens: host_tokens,
            }
        });
        shots::shoot(&mut ctx, window, &dir, "f-detail-signed-out", label);
    }
}
