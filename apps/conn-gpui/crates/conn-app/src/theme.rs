//! Bridges `conn_theme::Tokens` into GPUI colors and `gpui-kit`'s global theme.
//!
//! Views must never hardcode hex literals; every color is read from [`Tokens`]
//! via these helpers.

use conn_theme::{Appearance, Rgba as ThemeRgba, Tokens};
use gpui_kit::{App, Hsla, Rgba as GpuiRgba, px};

/// Converts a `conn_theme::Rgba` into a GPUI `Rgba`.
#[must_use]
pub(crate) fn gpui_rgba(color: ThemeRgba) -> GpuiRgba {
    GpuiRgba {
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
    }
}

/// Converts a `conn_theme::Rgba` into a GPUI `Hsla`.
#[must_use]
pub(crate) fn hsla(color: ThemeRgba) -> Hsla {
    Hsla::from(gpui_rgba(color))
}

/// Converts a `conn_theme::Rgba` into a GPUI `Hsla` with an overridden alpha.
#[must_use]
pub(crate) fn hsla_alpha(color: ThemeRgba, alpha: f32) -> Hsla {
    hsla(color.with_alpha(alpha))
}

/// Fill alpha of a disabled primary button in a dark theme.
pub(crate) const DISABLED_PRIMARY_FILL_ALPHA_DARK: f32 = 0.40;
/// Fill alpha of a disabled primary button in a light theme.
pub(crate) const DISABLED_PRIMARY_FILL_ALPHA_LIGHT: f32 = 0.35;
/// Label alpha of a disabled primary button.
pub(crate) const DISABLED_PRIMARY_LABEL_ALPHA: f32 = 0.60;

/// The colours of a disabled primary button: the primary colour at reduced opacity for the fill
/// and a muted primary-foreground for the label, never fully transparent. It reads as the primary
/// action, not available yet. Every primary button uses this one rule when disabled; it also
/// takes the pointer cursor and the hover change away (Nick, 2026-11-26).
#[must_use]
pub(crate) fn disabled_primary_colors(tokens: &Tokens) -> (ThemeRgba, ThemeRgba) {
    let fill_alpha = match tokens.appearance {
        Appearance::Dark => DISABLED_PRIMARY_FILL_ALPHA_DARK,
        Appearance::Light => DISABLED_PRIMARY_FILL_ALPHA_LIGHT,
    };
    (
        tokens.primary.with_alpha(fill_alpha),
        tokens
            .primary_foreground
            .with_alpha(DISABLED_PRIMARY_LABEL_ALPHA),
    )
}

/// [`disabled_primary_colors`] as GPUI colours: `(fill, label)`.
#[must_use]
pub(crate) fn disabled_primary(tokens: &Tokens) -> (Hsla, Hsla) {
    let (fill, label) = disabled_primary_colors(tokens);
    (hsla(fill), hsla(label))
}

/// The app's monospace family: JetBrains Mono (embedded and registered by `crate::fonts`).
pub(crate) const MONO_FONT: &str = "JetBrains Mono";

/// The selected-text highlight: the theme's own focus colour (`focus`, the `ring` token), thin
/// enough that the text on it reads as well as on the page. A light page takes less of it, as
/// the focus colour of a light theme is dark.
#[must_use]
pub(crate) fn selection_highlight(tokens: &Tokens) -> Hsla {
    let alpha = match tokens.appearance {
        Appearance::Dark => 0.38,
        Appearance::Light => 0.2,
    };
    hsla_alpha(tokens.ring, alpha)
}

/// Synchronizes `gpui-kit`'s global theme with Conn's active [`Tokens`] so
/// default kit colors and radii never leak into Conn surfaces.
pub(crate) fn apply_kit_theme(tokens: &Tokens, cx: &mut App) {
    // The appearance goes first, in an update of its own: a mode change loads the kit's own theme
    // for that mode once the update's closure has run, over every color the closure set.
    let mode = match tokens.appearance {
        Appearance::Light => gpui_kit::component::ThemeMode::Light,
        Appearance::Dark => gpui_kit::component::ThemeMode::Dark,
    };
    gpui_kit::component::Theme::update(cx, |theme| theme.mode = mode);
    gpui_kit::component::Theme::update(cx, |theme| {
        theme.font_size = px(13.0);
        theme.mono_font_family = MONO_FONT.into();
        theme.radius = px(8.0);
        theme.radius_lg = px(14.0);
        theme.shadow = false;
        theme.cursor_blink = theme
            .cursor_blink
            .with_idle_timeout(std::time::Duration::from_secs(10));

        let c = &mut theme.colors;
        c.background = hsla(tokens.background);
        c.foreground = hsla(tokens.foreground);
        c.border = hsla(tokens.shell_divider);
        c.accent = hsla(tokens.shell_highlight);
        c.accent_foreground = hsla(tokens.accent_foreground);
        c.primary = hsla(tokens.primary);
        c.primary_foreground = hsla(tokens.primary_foreground);
        c.secondary = hsla(tokens.secondary);
        c.secondary_foreground = hsla(tokens.secondary_foreground);
        c.muted = hsla(tokens.muted);
        c.muted_foreground = hsla(tokens.muted_foreground);
        // Opaque: kit popups must not let content show through (Nick, #332).
        c.popover = hsla(tokens.shell_overlay.with_alpha(1.0));
        c.popover_foreground = hsla(tokens.popover_foreground);
        c.sidebar = hsla(tokens.shell_panel);
        c.sidebar_foreground = hsla(tokens.sidebar_foreground);
        c.sidebar_border = hsla(tokens.shell_divider);
        c.sidebar_accent = hsla(tokens.sidebar_row_hover);
        c.sidebar_accent_foreground = hsla(tokens.sidebar_foreground);
        c.danger = hsla(tokens.destructive);
        c.danger_foreground = hsla(tokens.destructive_foreground);
        c.warning = hsla(tokens.warning);
        c.warning_foreground = hsla(tokens.warning_foreground);
        c.info = hsla(tokens.info);
        c.info_foreground = hsla(tokens.info_foreground);
        c.success = hsla(tokens.success);
        c.success_foreground = hsla(tokens.success_foreground);
        c.ring = hsla(tokens.ring);
        c.input = hsla(tokens.shell_divider_header);
        c.caret = hsla(tokens.foreground);
        c.selection = selection_highlight(tokens);
    });
    crate::editor_settings::apply(tokens, cx);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens_of(theme_id: &str) -> Tokens {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        Tokens::derive(&theme)
    }

    #[test]
    fn a_disabled_primary_button_keeps_a_non_transparent_primary_fill() {
        for (theme_id, fill_alpha) in [("dark-ocean", 0.40), ("t3-code-light", 0.35)] {
            let tokens = tokens_of(theme_id);
            let (fill, label) = disabled_primary_colors(&tokens);
            // The fill is the primary colour itself at reduced opacity, never fully clear.
            assert_eq!(
                (fill.r, fill.g, fill.b),
                (tokens.primary.r, tokens.primary.g, tokens.primary.b),
                "{theme_id}: fill colour"
            );
            assert!((fill.a - fill_alpha).abs() < 1e-6, "{theme_id}: {fill:?}");
            assert!(fill.a > 0.0 && fill.a < tokens.primary.a);
            // The label is the primary foreground, muted.
            assert_eq!(
                (label.r, label.g, label.b),
                (
                    tokens.primary_foreground.r,
                    tokens.primary_foreground.g,
                    tokens.primary_foreground.b
                ),
                "{theme_id}: label colour"
            );
            assert!((label.a - DISABLED_PRIMARY_LABEL_ALPHA).abs() < 1e-6);
        }
    }

    #[test]
    fn a_disabled_primary_button_is_lighter_than_an_enabled_one() {
        for theme_id in ["dark-ocean", "t3-code-light"] {
            let tokens = tokens_of(theme_id);
            let (fill, label) = disabled_primary(&tokens);
            assert!(fill.a < hsla(tokens.primary).a, "{theme_id}");
            assert!(label.a < hsla(tokens.primary_foreground).a, "{theme_id}");
        }
    }
}
