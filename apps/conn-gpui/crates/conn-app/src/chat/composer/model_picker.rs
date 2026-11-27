//! Conn-styled floating model picker, sized from the lab's measured shell.
//!
//! Populated from the live `subscribeServerConfig` catalog (`conn_state::providers`). The shell is
//! a 3px-inset `rounded-xl` surface holding a provider rail and one bordered panel. The panel
//! holds the model column (search, list, provider notices) and, on its right, the settings column
//! that `picker_settings` draws. Search covers the model column only.

use conn_theme::{Appearance, Rgba, Tokens};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, div, px,
};

use super::super::color::{hsla, hsla_alpha, opaque};
use super::super::icons;
use super::Composer;
use super::actions::FollowUpBehavior;
use super::footer::RuntimeModeOption;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Shell corner radius (`rounded-xl`).
pub(super) const SHELL_RADIUS_PX: f32 = 12.0;
/// Panel corner radius.
const PANEL_RADIUS_PX: f32 = 9.0;
/// Model row corner radius. A row sits 7px inside the panel's curve, so the concentric rule would
/// square it off; it keeps the lab's 8px.
const ROW_RADIUS_PX: f32 = 8.0;
/// Space between the shell border and the rail or panel, and between the rail and the panel.
pub(super) const SHELL_INSET_PX: f32 = 3.0;
const SHELL_BORDER_PX: f32 = 1.0;
const PANEL_BORDER_PX: f32 = 1.0;
/// Provider rail: 40px wide, `1px 2px` padding, 4px gap, so each tile is 36px square.
const RAIL_WIDTH_PX: f32 = 40.0;
const RAIL_PAD_X_PX: f32 = 2.0;
const RAIL_PAD_Y_PX: f32 = 1.0;
const RAIL_GAP_PX: f32 = 4.0;
const RAIL_TILE_PX: f32 = RAIL_WIDTH_PX - 2.0 * RAIL_PAD_X_PX;
/// Rail tile radius, concentric with the shell: the shell radius minus the inset between the shell
/// and the tile (the shell inset plus the rail padding on the tighter axis). The panel follows the
/// same rule, so every rail item, ★ and providers alike, uses it.
pub(super) const RAIL_TILE_RADIUS_PX: f32 =
    SHELL_RADIUS_PX - (SHELL_INSET_PX + min_f32(RAIL_PAD_X_PX, RAIL_PAD_Y_PX));
/// Search row, including its bottom border. The first model row sits one list padding below it, so
/// its icon centre meets the first provider tile's centre: the favorites tile and its gap come
/// first in the rail, the search row and the list padding come first in the panel.
pub(super) const SEARCH_ROW_HEIGHT_PX: f32 =
    RAIL_PAD_Y_PX + RAIL_TILE_PX + RAIL_GAP_PX + RAIL_TILE_PX / 2.0
        - PANEL_BORDER_PX
        - LIST_PAD_PX
        - MODEL_ROW_HEIGHT_PX / 2.0;
/// Model list padding and row height.
const LIST_PAD_PX: f32 = 6.0;
const MODEL_ROW_HEIGHT_PX: f32 = 32.0;

const fn min_f32(a: f32, b: f32) -> f32 {
    if a < b { a } else { b }
}
/// Provider and favorites glyphs: the rail and the model rows draw them the same size (#327).
const PROVIDER_ICON_PX: f32 = 16.0;

/// Widest shell.
const SHELL_MAX_WIDTH_PX: f32 = 480.0;
/// The shell stays this far inside the room left of the composer's right edge.
const ROOM_MARGIN_PX: f32 = 52.0;
/// The shell stays this far inside the window.
const VIEWPORT_MARGIN_PX: f32 = 32.0;
/// Narrowest shell the room may squeeze it to.
const SHELL_MIN_WIDTH_PX: f32 = 280.0;
/// Keep the four-field Codex footprint when the model or provider changes.
const SHELL_HEIGHT_PX: f32 = 264.0;
const COMPACT_SHELL_HEIGHT_PX: f32 = 256.0;
const SHELL_MAX_HEIGHT_VH: f32 = 0.4725;
/// Settings column: `min(45%, 192px)` of the panel's content width.
const SETTINGS_MAX_WIDTH_PX: f32 = 192.0;
const SETTINGS_WIDTH_FRACTION: f32 = 0.45;
/// The lab's `max-width: 600px` breakpoint: 8px settings padding at or below it. It applies to
/// the window and to the room around the composer, so a narrow lane in a split window counts too.
const COMPACT_MAX_PX: f32 = 600.0;

const ICON_STAR: &str = "superhero/star.svg";
/// Superheroicons 16/solid paths used by the model picker.
pub(super) const ICON_SEARCH: &str = "superhero/search.svg";
pub(super) const ICON_CHECK: &str = "superhero/check.svg";

pub(crate) use conn_state::providers::{
    FAVORITES_TAB, ModelCatalog, ModelOption, OptionMap, ProviderGroup,
};

/// Colors the shell, rail, rows and settings column share, matched to the lab's `--line`,
/// `--selected`, `--hover` and `--pop`.
pub(super) struct PickerColors {
    pub(super) shell: Hsla,
    pub(super) panel: Hsla,
    pub(super) line: Hsla,
    pub(super) selected: Hsla,
    pub(super) hover: Hsla,
    pub(super) fg: Hsla,
    pub(super) muted: Hsla,
    pub(super) warning: Hsla,
}

pub(super) fn picker_colors(tokens: &Tokens) -> PickerColors {
    let (selected, hover) = match tokens.appearance {
        Appearance::Light => (0.05, 0.03),
        Appearance::Dark => (0.075, 0.05),
    };
    let tint = match tokens.appearance {
        Appearance::Light => 0.0,
        Appearance::Dark => 1.0,
    };
    PickerColors {
        // Opaque: no backdrop blur to hide the chat behind the glass (Nick, #332).
        shell: opaque(tokens.shell_overlay),
        panel: hsla_alpha(tokens.muted, 0.448),
        line: hsla(tokens.shell_inner_border),
        selected: hsla(Rgba::new(tint, tint, tint, selected)),
        hover: hsla(Rgba::new(tint, tint, tint, hover)),
        fg: hsla(tokens.foreground),
        muted: hsla(tokens.muted_foreground),
        warning: hsla(tokens.warning),
    }
}

/// Shell size the window and the room around the composer allow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PickerGeometry {
    pub(super) shell_width: f32,
    pub(super) shell_height: f32,
    /// 8px settings padding instead of 12px.
    pub(super) compact: bool,
}

impl PickerGeometry {
    /// `composer_px` is the composer's measured width, or `0.0` before the first paint. The room
    /// is the lab's `100cqw`: the composer plus the lane padding on both sides.
    pub(super) fn measure(viewport_w: f32, viewport_h: f32, composer_px: f32) -> Self {
        let room = if composer_px > 0.0 {
            composer_px + 2.0 * super::super::CHAT_LANE_PADDING_X_PX
        } else {
            viewport_w
        };
        let compact = viewport_w <= COMPACT_MAX_PX || room <= COMPACT_MAX_PX;
        let margin = if compact { 36.0 } else { ROOM_MARGIN_PX };
        let mut shell_width = SHELL_MAX_WIDTH_PX
            .min(room - margin)
            .max(SHELL_MIN_WIDTH_PX)
            .min(viewport_w - VIEWPORT_MARGIN_PX);
        if compact && composer_px > 0.0 {
            shell_width = shell_width.min(composer_px);
        }
        let height = if compact {
            COMPACT_SHELL_HEIGHT_PX
        } else {
            SHELL_HEIGHT_PX
        };
        Self {
            shell_width,
            shell_height: height.min(SHELL_MAX_HEIGHT_VH * viewport_h),
            compact,
        }
    }

    /// Width of the settings column, border included.
    pub(super) fn settings_width(&self) -> f32 {
        let panel = self.shell_width
            - 2.0 * SHELL_BORDER_PX
            - 2.0 * SHELL_INSET_PX
            - RAIL_WIDTH_PX
            - SHELL_INSET_PX;
        let content = panel - 2.0 * PANEL_BORDER_PX;
        (content * SETTINGS_WIDTH_FRACTION).clamp(0.0, SETTINGS_MAX_WIDTH_PX)
    }
}

/// Parameters for rendering the docked model picker popup.
pub(super) struct ModelPickerView<'a> {
    pub(super) catalog: &'a ModelCatalog,
    pub(super) loading: bool,
    pub(super) active_instance_id: Option<&'a str>,
    pub(super) active_model: &'a str,
    pub(super) selected_provider: Option<&'a str>,
    pub(super) search_input: &'a Entity<InputState>,
    pub(super) query: &'a str,
    pub(super) highlighted_index: usize,
    pub(super) tokens: &'a Tokens,
    /// The selected model, whose settings the right column lists.
    pub(super) selected: Option<&'a ModelOption>,
    pub(super) selected_options: Option<&'a OptionMap>,
    pub(super) runtime_mode: &'a str,
    pub(super) runtime_options: &'a [RuntimeModeOption],
    pub(super) follow_up: FollowUpBehavior,
    /// Open menu, keyboard cursor and focus of the settings column.
    pub(super) settings: &'a super::picker_settings::SettingsState,
    pub(super) geometry: PickerGeometry,
}

/// Model-specific settings apply on its provider tab, Favorites, and during search.
pub(super) fn traits_model<'a>(
    selected: Option<&'a ModelOption>,
    provider: Option<&str>,
    query: &str,
) -> Option<&'a ModelOption> {
    let selected = selected?;
    let browsing = provider
        .filter(|tab| *tab != FAVORITES_TAB)
        .filter(|_| query.trim().is_empty());
    shows_selected_traits(&selected.instance_id, browsing).then_some(selected)
}

/// Whether the selected model's traits show: it belongs to the provider tab being browsed, or no
/// provider tab is (Favorites, a search, or the picker's default tab, which is the selected one).
fn shows_selected_traits(selected_instance: &str, browsing_instance: Option<&str>) -> bool {
    browsing_instance.is_none_or(|tab| tab == selected_instance)
}

impl Composer {
    /// A rail tile ends a search, as in the lab, before it opens its tab.
    fn clear_picker_search(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let searching = !self
            .model_search_input
            .read(cx)
            .value()
            .to_string()
            .trim()
            .is_empty();
        if searching {
            self.model_search_input
                .update(cx, |input, cx| input.set_value(String::new(), window, cx));
        }
    }
}

/// A 36px square rail tile. The pressed tile takes the selected fill; the others hover.
fn rail_tile(
    id: impl Into<SharedString>,
    pressed: bool,
    colors: &PickerColors,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let hover = colors.hover;
    let selected = colors.selected;
    div()
        .id(id.into())
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(RAIL_TILE_PX))
        .rounded(px(RAIL_TILE_RADIUS_PX))
        .when(pressed, move |el| el.bg(selected))
        .when(!pressed, move |el| el.hover(move |s| s.bg(hover)))
}

/// Renders Conn's docked model picker: provider rail, model column, settings column.
pub(super) fn render_model_picker(
    view: &ModelPickerView<'_>,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let tokens = view.tokens;
    let colors = picker_colors(tokens);
    let geometry = view.geometry;
    let fg = colors.fg;
    let muted = colors.muted;
    let line = colors.line;
    let selected_bg = colors.selected;

    let is_searching = !view.query.trim().is_empty();
    let favorites_tab = view.selected_provider == Some(FAVORITES_TAB);
    let effective_provider = view
        .selected_provider
        .or(view.active_instance_id)
        .or_else(|| {
            view.catalog
                .picker_providers()
                .next()
                .map(|p| p.instance_id.as_str())
        });
    let models = view.catalog.filtered_models(effective_provider, view.query);
    let setup_notice = (!is_searching)
        .then(|| {
            view.catalog
                .picker_providers()
                .find(|p| Some(p.instance_id.as_str()) == effective_provider)
                .and_then(|p| {
                    p.setup_notice()
                        .map(|notice| (p.instance_id.clone(), notice))
                })
        })
        .flatten();

    // The rail stays while searching; no tile is pressed then, and no tile has a tooltip.
    let mut rail = div()
        .id("model-picker-providers")
        .a11y_group("composer.model-picker.providers", "Providers")
        .flex()
        .flex_col()
        .flex_none()
        .w(px(RAIL_WIDTH_PX))
        .gap(px(RAIL_GAP_PX))
        .px(px(RAIL_PAD_X_PX))
        .py(px(RAIL_PAD_Y_PX))
        .overflow_y_scroll();

    let favorites_pressed = favorites_tab && !is_searching;
    rail = rail.child(
        rail_tile(
            "model-picker-provider-favorites",
            favorites_pressed,
            &colors,
        )
        .a11y_tab(
            "composer.model-picker.provider.favorites",
            "Favorites",
            favorites_pressed,
        )
        .cursor_pointer()
        .on_click(cx.listener(|composer, _, window, cx| {
            composer.clear_picker_search(window, cx);
            composer.select_picker_provider(FAVORITES_TAB.to_owned(), cx);
        }))
        .child(icons::icon(
            ICON_STAR,
            PROVIDER_ICON_PX,
            if favorites_pressed { fg } else { muted },
        )),
    );

    for provider in view.catalog.picker_providers() {
        let pressed = !is_searching && effective_provider == Some(provider.instance_id.as_str());
        let provider_id = provider.instance_id.clone();
        let label = provider.rail_label();
        let tile = rail_tile(
            format!("model-picker-provider-{}", provider.instance_id),
            pressed,
            &colors,
        )
        .a11y_tab(
            format!("composer.model-picker.provider.{}", provider.instance_id),
            label,
            pressed,
        )
        .child(crate::icons::provider_mark(
            &provider.driver,
            PROVIDER_ICON_PX,
            if pressed { fg } else { muted },
        ));
        rail = rail.child(if provider.rail_disabled() {
            tile.opacity(0.5).cursor_not_allowed()
        } else {
            tile.cursor_pointer()
                .on_click(cx.listener(move |composer, _, window, cx| {
                    composer.clear_picker_search(window, cx);
                    composer.select_picker_provider(provider_id.clone(), cx);
                }))
        });
    }

    let search_row = div()
        .flex()
        .flex_row()
        .flex_none()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .h(px(SEARCH_ROW_HEIGHT_PX))
        .px(px(10.0))
        .py(px(6.0))
        .border_b_1()
        .border_color(line)
        .child(icons::icon(ICON_SEARCH, 14.0, muted))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(view.search_input)
                    .appearance(false)
                    .pl(px(0.0))
                    .text_size(px(13.0))
                    .line_height(px(20.0)),
            ),
        );

    let mut list = div()
        .id("model-picker-list")
        .a11y_group("composer.model-picker.list", "Models")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .p(px(LIST_PAD_PX))
        .flex_1()
        .min_h_0()
        .overflow_y_scroll();

    let empty_note = |text: &'static str| {
        div()
            .px(px(8.0))
            .py(px(4.0))
            .text_size(px(13.0))
            .line_height(px(20.0))
            .text_color(muted)
            .child(text)
    };
    if view.loading && models.is_empty() {
        list = list.child(empty_note("Loading models..."));
    } else if models.is_empty() && setup_notice.is_none() {
        list = list.child(empty_note(if favorites_tab && !is_searching {
            "No favorites yet"
        } else {
            "No models found"
        }));
    } else {
        for (idx, model) in models.iter().enumerate() {
            let is_active = model.slug == view.active_model
                && view
                    .active_instance_id
                    .is_none_or(|id| id == model.instance_id);
            let is_highlighted = idx == view.highlighted_index;
            let instance_id = model.instance_id.clone();
            let slug = model.slug.clone();
            let is_favorite = view.catalog.is_favorite(model);
            let group_name = SharedString::from(format!(
                "model-picker-row-group-{}-{}",
                model.instance_id, model.slug
            ));
            let star = {
                let instance_id = model.instance_id.clone();
                let slug = model.slug.clone();
                let label = if is_favorite {
                    "Remove from favorites"
                } else {
                    "Add to favorites"
                };
                let star_hover = colors.hover;
                div()
                    .id(SharedString::from(format!(
                        "model-picker-favorite-{}-{}",
                        model.instance_id, model.slug
                    )))
                    .a11y_button(
                        format!(
                            "composer.model-picker.favorite.{}.{}",
                            model.instance_id, model.slug
                        ),
                        format!("{label}: {}", model.display_label()),
                    )
                    .conn_tooltip(label, tokens)
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(18.0))
                    .rounded(px(4.0))
                    .cursor_pointer()
                    // A favorite's star always shows; the others show on row hover.
                    .when(!is_favorite, |el| {
                        el.opacity(0.0)
                            .hover(move |s| s.bg(star_hover))
                            .group_hover(group_name.clone(), |s| s.opacity(1.0))
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        cx.stop_propagation();
                        composer.toggle_model_favorite(instance_id.clone(), slug.clone(), cx);
                    }))
                    .child(icons::icon(
                        ICON_STAR,
                        12.0,
                        if is_favorite { colors.warning } else { muted },
                    ))
            };

            let mut row = div()
                .group(group_name.clone())
                .id(SharedString::from(format!(
                    "model-picker-row-{}-{}",
                    model.instance_id, model.slug
                )))
                .a11y(
                    gpui_kit::Role::ListBoxOption,
                    format!(
                        "composer.model-picker.model.{}.{}",
                        model.instance_id, model.slug
                    ),
                    model.display_label(),
                )
                .aria_selected(is_active)
                .flex()
                .flex_row()
                .flex_none()
                .items_center()
                .gap(px(8.0))
                .w_full()
                .min_w_0()
                .h(px(MODEL_ROW_HEIGHT_PX))
                .px(px(8.0))
                .rounded(px(ROW_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(selected_bg))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |composer, _, _, cx| {
                    composer.pick_model(instance_id.clone(), slug.clone(), cx);
                }))
                .child(crate::icons::provider_mark(
                    &model.driver,
                    PROVIDER_ICON_PX,
                    fg,
                ));

            if is_highlighted {
                row = row.bg(selected_bg);
            }

            let mut label_group = div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .font_weight(if is_active {
                            FontWeight::MEDIUM
                        } else {
                            FontWeight::NORMAL
                        })
                        .text_color(fg)
                        .child(model.display_label()),
                );

            if let Some(sub) = model.sub_provider.as_deref() {
                label_group = label_group.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(muted)
                        .child(sub.to_owned()),
                );
            }

            if model.is_new {
                label_group = label_group.child(
                    div()
                        .flex_none()
                        .px(px(4.0))
                        .py(px(1.0))
                        .rounded(px(4.0))
                        .bg(hsla_alpha(tokens.info, 0.15))
                        .text_size(px(10.0))
                        .line_height(px(14.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hsla(tokens.info_foreground))
                        .child("New"),
                );
            }

            row = row.child(label_group).child(star).child(
                div()
                    .flex_none()
                    .size(px(14.0))
                    .when(is_active, |el| el.child(icons::icon(ICON_CHECK, 14.0, fg))),
            );
            list = list.child(row);
        }
    }

    let model_column = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .child(search_row)
        .child(list)
        .when_some(setup_notice, |column, (instance_id, notice)| {
            let link = hsla(tokens.primary);
            let link_hover = hsla_alpha(tokens.primary, 0.12);
            column.child(
                div()
                    .id("composer.model-picker.provider-notice")
                    .a11y_group("composer.model-picker.provider-notice", notice.clone())
                    .flex_none()
                    .max_h(px(176.0))
                    .overflow_hidden()
                    .p(px(8.0))
                    .border_t_1()
                    .border_color(line)
                    .child(
                        div()
                            .px(px(4.0))
                            .pt(px(6.0))
                            .text_size(px(12.0))
                            .line_height(px(16.5))
                            .line_clamp(3)
                            .text_color(muted)
                            .child(notice),
                    )
                    .child(
                        div()
                            .id("composer.model-picker.open-provider-setup")
                            .a11y_button(
                                "composer.model-picker.open-provider-setup",
                                "Open provider setup",
                            )
                            .mx(px(4.0))
                            .mt(px(4.0))
                            .px(px(4.0))
                            .rounded(px(4.0))
                            .self_start()
                            .text_size(px(12.0))
                            .line_height(px(16.5))
                            .text_color(link)
                            .cursor_pointer()
                            .hover(move |s| s.bg(link_hover))
                            .on_click(cx.listener(move |composer, _, _, cx| {
                                composer.open_provider_setup(instance_id.clone(), cx);
                            }))
                            .child("Open provider setup"),
                    ),
            )
        });

    // `updateRequiredNotices`: for the selected provider, or every provider while searching.
    let update_notices: Vec<(String, String)> = view
        .catalog
        .picker_providers()
        .filter(|provider| {
            is_searching || Some(provider.instance_id.as_str()) == effective_provider
        })
        .filter_map(|provider| {
            provider
                .update_required_notice(view.query)
                .map(|notice| (provider.instance_id.clone(), notice))
        })
        .collect();
    let model_column =
        model_column.children(update_notices.into_iter().map(|(instance_id, notice)| {
            div()
                .id(SharedString::from(format!(
                    "composer.model-picker.update-required.{instance_id}"
                )))
                .a11y_group(
                    format!("composer.model-picker.update-required.{instance_id}"),
                    notice.clone(),
                )
                .flex_none()
                .border_t_1()
                .border_color(line)
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(13.0))
                .line_height(px(18.0))
                .text_color(muted)
                .child(notice)
        }));

    let settings = div()
        .id("model-picker-settings")
        .a11y_group("composer.model-picker.settings", "Model settings")
        .flex()
        .flex_col()
        .flex_none()
        .w(px(geometry.settings_width()))
        .border_l_1()
        .border_color(line)
        .overflow_y_scroll()
        .track_scroll(view.settings.column_scroll())
        .child(
            div()
                .flex_none()
                .child(super::picker_settings::render(view, cx)),
        );

    let panel = div()
        .flex()
        .flex_row()
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .rounded(px(PANEL_RADIUS_PX))
        .border_1()
        .border_color(line)
        .bg(colors.panel)
        .child(model_column)
        .child(settings);

    div()
        .id("composer-model-picker-popup")
        .key_context("ComposerModelPicker")
        .on_action(
            cx.listener(|composer, _: &crate::app::PickerNextField, window, cx| {
                composer.navigate_settings(super::picker_settings::Key::Tab, window, cx);
            }),
        )
        .on_action(cx.listener(
            |composer, _: &crate::app::PickerPreviousField, window, cx| {
                composer.navigate_settings(super::picker_settings::Key::ShiftTab, window, cx);
            },
        ))
        .a11y_group("composer.model-picker", "Model picker")
        .flex()
        .flex_row()
        .gap(px(SHELL_INSET_PX))
        .p(px(SHELL_INSET_PX))
        .w(px(geometry.shell_width))
        .h(px(geometry.shell_height))
        .rounded(px(SHELL_RADIUS_PX))
        .bg(colors.shell)
        .border_1()
        .border_color(line)
        .shadow_lg()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(rail)
        .child(panel)
        .into_any_element()
}

#[cfg(test)]
mod traits_tests {
    use super::{PickerGeometry, shows_selected_traits};

    /// The selected model's traits show on its own provider's tab and on provider-less views.
    #[test]
    fn traits_follow_the_provider_being_browsed() {
        assert!(shows_selected_traits("codex", Some("codex")));
        assert!(
            !shows_selected_traits("codex", Some("grok")),
            "no Ultrafast on Grok's tab"
        );
        assert!(
            shows_selected_traits("codex", None),
            "Favorites, search, default tab"
        );
    }

    /// Wide windows take the full shell; a narrow lane or a 570px window goes compact.
    #[test]
    fn geometry_follows_viewport_and_composer_room() {
        let wide = PickerGeometry::measure(1440.0, 900.0, 736.0);
        assert_eq!(wide.shell_width, 480.0);
        assert_eq!(wide.shell_height, 264.0);
        assert!(!wide.compact);
        assert_eq!(wide.settings_width(), 192.0);

        let lane = PickerGeometry::measure(900.0, 700.0, 300.0);
        assert_eq!(lane.shell_width, 300.0);
        assert!(lane.compact);

        let tiny = PickerGeometry::measure(570.0, 700.0, 0.0);
        assert!(tiny.compact);
        assert_eq!(tiny.shell_width, 480.0);
        assert_eq!(tiny.shell_height, 256.0);
        let short = PickerGeometry::measure(900.0, 480.0, 736.0);
        assert!((short.shell_height - 226.8).abs() < 0.01);
    }
}
