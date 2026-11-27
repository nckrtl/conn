//! The saved theme paints the first frame, and a later Orbit sync changes it only when it differs.

use conn_theme::{Appearance, Tokens};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AnyWindowHandle, AppContext as _, Bounds, Entity, Point, TestAppContext, WindowBounds,
    WindowOptions, px, size,
};

use super::{TEST_WINDOW_HEIGHT, TEST_WINDOW_WIDTH};
use crate::app::{ConnApp, register_keybindings};
use crate::theme::{apply_kit_theme, hsla};
use crate::theme_boot::{BootTheme, startup_theme};

fn builtin(id: &str) -> conn_theme::ThemeDefinition {
    conn_theme::theme_by_id(id).unwrap_or_else(|| panic!("{id} must be built in"))
}

/// Mounts the app as `main` does: the theme for the first frame comes from `boot`.
fn mount_with_boot(
    cx: &mut TestAppContext,
    boot: BootTheme,
    system: Option<Appearance>,
) -> (AnyWindowHandle, Entity<ConnApp>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        let (theme, tokens) = startup_theme(&boot, None, system);
        apply_kit_theme(&tokens, cx);
        register_keybindings(cx);
        let bounds = Bounds::new(
            Point::default(),
            size(px(TEST_WINDOW_WIDTH), px(TEST_WINDOW_HEIGHT)),
        );
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let Ok(opened) = gpui_kit::open_window(options, cx, move |window, cx| {
            cx.new(|cx| ConnApp::new_with_boot_theme(theme.id, tokens, boot, None, window, cx))
        }) else {
            panic!("failed to open headless test window");
        };
        opened
    })
}

/// Renders the first frame and returns the theme id and tokens it painted with, plus the kit
/// background color then in force.
fn first_frame(
    cx: &mut TestAppContext,
    window: AnyWindowHandle,
    app: &Entity<ConnApp>,
) -> (String, Tokens, gpui_kit::Hsla) {
    let painted = cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        let app = app.read(cx);
        (
            app.theme_id_for_test().to_owned(),
            app.tokens_for_test().clone(),
            gpui_kit::component::Theme::global(cx).colors.background,
        )
    });
    painted.unwrap_or_else(|err| panic!("failed to render the first frame: {err}"))
}

fn theme_changes(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> u64 {
    cx.update(|cx| app.read(cx).theme_changes_for_test())
}

#[gpui_kit::test]
fn the_saved_theme_paints_the_first_frame(cx: &mut TestAppContext) {
    let saved = builtin("t3-code-light");
    let mut boot = BootTheme::default();
    boot.record(&saved, None);
    let (window, app) = mount_with_boot(cx, boot, Some(Appearance::Dark));

    let (id, tokens, kit_background) = first_frame(cx, window, &app);
    let expected = Tokens::derive(&saved);
    assert_eq!(id, "t3-code-light");
    assert_eq!(tokens, expected);
    assert_eq!(kit_background, hsla(expected.background));
    assert_eq!(theme_changes(cx, &app), 0);
}

#[gpui_kit::test]
fn a_follow_system_choice_paints_the_slot_for_the_macos_appearance(cx: &mut TestAppContext) {
    let light = builtin("t3-code-light");
    let dark = builtin("dark-ocean");
    let mut boot = BootTheme::default();
    boot.record(&dark, Some((&light, &dark)));
    let (window, app) = mount_with_boot(cx, boot, Some(Appearance::Light));

    let (id, tokens, _) = first_frame(cx, window, &app);
    assert_eq!(id, "t3-code-light");
    assert_eq!(tokens, Tokens::derive(&light));
}

#[gpui_kit::test]
fn the_same_theme_from_orbit_changes_nothing(cx: &mut TestAppContext) {
    let mut boot = BootTheme::default();
    boot.record(&builtin("t3-code-light"), None);
    let (window, app) = mount_with_boot(cx, boot, None);
    let (_, before, _) = first_frame(cx, window, &app);

    cx.update(|cx| {
        app.update(cx, |app, cx| {
            assert!(app.adopt_synced_theme("t3-code-light", false, cx));
        });
    });
    let (id, after, _) = first_frame(cx, window, &app);
    assert_eq!(id, "t3-code-light");
    assert_eq!(after, before);
    assert_eq!(theme_changes(cx, &app), 0);
}

#[gpui_kit::test]
fn a_different_theme_from_orbit_switches_once(cx: &mut TestAppContext) {
    let mut boot = BootTheme::default();
    boot.record(&builtin("t3-code-light"), None);
    let (window, app) = mount_with_boot(cx, boot, None);
    let _ = first_frame(cx, window, &app);

    for _ in 0..2 {
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                assert!(app.adopt_synced_theme("dark-ocean", false, cx));
            });
        });
    }
    let (id, tokens, kit_background) = first_frame(cx, window, &app);
    let expected = Tokens::derive(&builtin("dark-ocean"));
    assert_eq!(id, "dark-ocean");
    assert_eq!(tokens, expected);
    assert_eq!(kit_background, hsla(expected.background));
    assert_eq!(theme_changes(cx, &app), 1);
}

#[gpui_kit::test]
fn a_first_run_paints_the_default_theme(cx: &mut TestAppContext) {
    let (window, app) = mount_with_boot(cx, BootTheme::default(), Some(Appearance::Light));
    let (id, tokens, _) = first_frame(cx, window, &app);
    let default = crate::live::default_theme();
    assert_eq!(id, default.id);
    assert_eq!(tokens, Tokens::derive(&default));
}
