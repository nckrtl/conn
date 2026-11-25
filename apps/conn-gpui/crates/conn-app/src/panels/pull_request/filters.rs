//! Native popup menus for the inbox and check status filters.
use super::super::color::to_hsla;
use conn_theme::Tokens;
use gpui_kit::component::{
    Icon,
    button::Button,
    menu::{DropdownMenu as _, PopupMenuItem},
};
use gpui_kit::{Anchor, AnyElement, App, IntoElement, Styled, px};
use std::rc::Rc;

pub(super) fn control<T: Copy + Eq + 'static>(
    tokens: &Tokens,
    id: &'static str,
    name: &'static str,
    current: T,
    choices: Vec<(T, String)>,
    on_select: impl Fn(T, &mut App) + 'static,
) -> AnyElement {
    let on_select = Rc::new(on_select);
    let caption = choices
        .iter()
        .find(|(value, _)| *value == current)
        .map(|(_, label)| label.clone())
        .unwrap_or_else(|| name.into());
    Button::new(id)
        .accessibility_id(id)
        .accessibility_label(name)
        .tab_index(0)
        .compact()
        .rounded(px(16.))
        .h(px(32.))
        .px(px(9.))
        .bg(to_hsla(tokens.shell_control))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider_header))
        .icon(Icon::default().path("superhero/filter.svg"))
        .label(caption)
        .dropdown_menu_with_anchor(Anchor::TopRight, move |mut menu, _, _| {
            for (value, label) in &choices {
                let value = *value;
                let on_select = on_select.clone();
                menu = menu.item(
                    PopupMenuItem::new(label.clone())
                        .checked(value == current)
                        .on_click(move |_, _, cx| on_select(value, cx)),
                );
            }
            menu
        })
        .into_any_element()
}
