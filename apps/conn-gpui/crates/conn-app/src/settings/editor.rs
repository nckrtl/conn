use super::*;
use crate::editor_settings::{self, Palette};

impl SettingsModal {
    pub(super) fn render_editor_page(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let selected = editor_settings::current(cx).palette;
        let family = div()
            .id("editor-family-field")
            .a11y_group("settings.editor.font", "Editor font family")
            .w(px(220.))
            .h(px(28.))
            .child(Input::new(&self.editor_family_input))
            .into_any_element();
        let mut choices = div()
            .flex()
            .h(px(28.))
            .items_center()
            .bg(hsla(tokens.shell_control))
            .border_1()
            .border_color(hsla(tokens.shell_divider_header))
            .rounded(px(6.))
            .overflow_hidden();
        for palette in Palette::ALL {
            let id = SharedString::from(format!(
                "settings.editor.theme.{}",
                palette.label().to_lowercase()
            ));
            let mut button = div()
                .id(id.clone())
                .a11y_tab(id, palette.label(), palette == selected)
                .h_full()
                .px(px(10.))
                .flex()
                .items_center()
                .cursor_pointer()
                .child(palette.label());
            if palette == selected {
                button = button
                    .bg(hsla(tokens.shell_highlight))
                    .text_color(hsla(tokens.foreground));
            } else {
                let hover = hsla(tokens.shell_highlight);
                button = button
                    .text_color(hsla(tokens.muted_foreground))
                    .hover(move |s| s.bg(hover));
            }
            choices = choices.child(button.on_click(cx.listener(move |this, _, _, cx| {
                editor_settings::update(cx, &this.tokens, |s| s.palette = palette);
            })));
        }
        settings_section(
            "Editor",
            vec![
                settings_row(
                    "Font family",
                    Some("Enter an installed font family. Empty or unavailable families use JetBrains Mono."),
                    family,
                    tokens,
                    &self.geometry,
                ),
                settings_row(
                    "Syntax theme",
                    Some("Syntax colors follow the light or dark appearance of Files."),
                    choices.into_any_element(),
                    tokens,
                    &self.geometry,
                ),
            ],
            tokens,
            &self.geometry,
        )
        .into_any_element()
    }
}
