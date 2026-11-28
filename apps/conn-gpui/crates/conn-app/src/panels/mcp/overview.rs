//! Tool annotations and declared JSON Schema examples in the catalog Overview.

use conn_mcp_client::{servers::McpField, store::McpTool};
use conn_theme::{Appearance, Tokens, color_mix_srgb};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, FontWeight, SharedString, TestSupportExt as _, Window, div, prelude::*, px,
};
use serde_json::Value;
use std::collections::HashSet;

use super::helpers::field_type_label;
use super::widgets::code_block;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::{
    ConnTooltipExt as _, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::theme::MONO_FONT;

pub(super) fn tool_badges(tokens: &Tokens, tool: &McpTool) -> Vec<AnyElement> {
    let Some(hints) = &tool.annotations else {
        return Vec::new();
    };
    let strength = if tokens.appearance == Appearance::Dark {
        0.32
    } else {
        0.16
    };
    [
        (
            hints.read_only_hint,
            "read-only",
            "Reads data without making changes.",
            tokens.success,
            tokens.success_foreground,
        ),
        (
            hints.destructive_hint,
            "destructive",
            "May remove or overwrite data.",
            tokens.destructive,
            tokens.destructive_foreground,
        ),
        (
            hints.idempotent_hint,
            "idempotent",
            "Repeating the same call has no additional effect.",
            tokens.info,
            tokens.info_foreground,
        ),
        (
            hints.open_world_hint,
            "open world",
            "May interact with external systems.",
            tokens.muted_foreground,
            tokens.foreground,
        ),
    ]
    .into_iter()
    .filter(|(enabled, ..)| *enabled == Some(true))
    .map(|(_, label, description, fill, ink)| {
        let bg = color_mix_srgb(fill, strength, tokens.shell_card);
        h_flex()
            .id(label)
            .a11y_group(format!("panel.mcp.hint.{label}"), label)
            .aria_description(description)
            .conn_tooltip(description, tokens)
            .flex_shrink_0()
            .h(px(20.0))
            .px(px(8.0))
            .rounded_full()
            .bg(to_hsla(bg))
            .text_color(to_hsla(ink))
            .text_size(px(11.0))
            .line_height(px(18.0))
            .font_weight(FontWeight::MEDIUM)
            .items_center()
            .child(label)
            .into_any_element()
    })
    .collect()
}

fn field_examples<'a>(schema: &'a Value, name: &str) -> Option<&'a [Value]> {
    let values = schema
        .get("properties")?
        .get(name)?
        .get("examples")?
        .as_array()?;
    (!values.is_empty()).then_some(values.as_slice())
}

fn input_examples(schema: &Value) -> Vec<&Value> {
    let mut seen = HashSet::new();
    schema
        .get("examples")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|value| seen.insert(*value))
        .collect()
}

pub(super) fn render_tool_input(
    tokens: &Tokens,
    session_key: &str,
    tool: &McpTool,
    fields: &[McpField],
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let examples = input_examples(&tool.input_schema);
    if fields.is_empty() && examples.is_empty() {
        return None;
    }
    let mut body = v_flex().w_full().min_w_0().gap(px(16.0));
    if !fields.is_empty() {
        body = body.child(render_fields_list(tokens, fields, Some(&tool.input_schema)));
    }
    if !examples.is_empty() {
        let key = format!(
            "mcp-input-examples:{}:{session_key}:{}",
            session_key.len(),
            tool.name
        );
        let expanded = window.use_keyed_state(key, cx, |_, _| false);
        let is_open = *expanded.read(cx);
        let label = format!("Example inputs ({})", examples.len());
        let muted = to_hsla(tokens.muted_foreground);
        let summary = h_flex()
            .id("mcp-input-examples-toggle")
            .a11y_button("panel.mcp.example-inputs", label.clone())
            .aria_expanded(is_open)
            .tab_index(0)
            .cursor_pointer()
            .gap(px(4.0))
            .text_color(muted)
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .on_click(move |_, _, cx| {
                expanded.update(cx, |open, cx| {
                    *open = !*open;
                    cx.notify();
                })
            })
            .child(superhero_icon(
                if is_open {
                    "superhero/chevron-down.svg"
                } else {
                    "superhero/chevron-right.svg"
                },
                12.0,
                muted,
            ))
            .child(label)
            .test_support();
        let mut disclosure = v_flex().min_w_0().w_full().gap(px(8.0)).child(summary);
        if is_open {
            for (index, example) in examples.into_iter().enumerate() {
                let json = format!("{example:#}");
                disclosure = disclosure.child(
                    div()
                        .id(("mcp-example-input", index))
                        .a11y_group(
                            format!("panel.mcp.example-input.{index}"),
                            format!("Example input {}", index + 1),
                        )
                        .aria_description(json.clone())
                        .w_full()
                        .min_w_0()
                        .rounded(px(8.0))
                        .px(px(12.0))
                        .py(px(8.0))
                        .bg(to_hsla(tokens.shell_raised))
                        .child(code_block(tokens, &json, true)),
                );
            }
        }
        body = body.child(disclosure);
    }
    Some(body.into_any_element())
}

pub(super) fn render_fields_list(
    tokens: &Tokens,
    fields: &[McpField],
    schema: Option<&Value>,
) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let mono: SharedString = MONO_FONT.into();

    let mut card = v_flex().w_full().border_y_1().border_color(divider);

    for (idx, field) in fields.iter().enumerate() {
        let mut header = h_flex()
            .flex_wrap()
            .items_baseline()
            .gap(px(6.0))
            .child(
                div()
                    .font_family(mono.clone())
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(fg)
                    .child(field.name.clone()),
            )
            .child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(field_type_label(field.field_type)),
            );
        if field.required {
            header = header.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("required"),
            );
        }

        let mut row = v_flex()
            .id(format!("mcp-overview-field-{}", field.name))
            .a11y_group(
                format!("panel.mcp.overview.field.{}", field.name),
                field.name.clone(),
            )
            .w_full()
            .gap(px(2.0))
            .py(px(8.0))
            .when(idx > 0, |el| el.border_t_1().border_color(divider))
            .child(header);
        if let Some(description) = &field.description {
            row = row.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(description.clone()),
            );
        }
        if !field.options.is_empty() {
            row = row.child(
                div()
                    .font_family(mono.clone())
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(field.options.join(" | ")),
            );
        }
        if let Some(examples) = schema.and_then(|s| field_examples(s, &field.name)) {
            let label = if examples.len() == 1 {
                "Example"
            } else {
                "Examples"
            };
            let text = examples
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            row = row.child(
                h_flex()
                    .id(format!("mcp-field-examples-{}", field.name))
                    .a11y_group(
                        format!("panel.mcp.overview.field.{}.examples", field.name),
                        format!("{label} {text}"),
                    )
                    .min_w_0()
                    .flex_wrap()
                    .gap_x(px(4.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .child(div().text_color(muted).child(label))
                    .child(
                        div()
                            .min_w_0()
                            .font_family(mono.clone())
                            .text_color(fg)
                            .child(text),
                    ),
            );
        }
        card = card.child(row);
    }

    v_flex()
        .w_full()
        .gap(px(8.0))
        .child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("Input"),
        )
        .child(card)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{field_examples, input_examples};
    use serde_json::json;

    #[test]
    fn schema_examples_use_declared_json_in_order() {
        let schema = json!({
            "properties": {
                "a.b": {"examples": [null, false, "quoted", {"key": 2}]},
                "defaults": {"default": "default", "enum": ["choice"]},
                "malformed": {"examples": "single value"},
                "empty": {"examples": []}
            },
            "examples": [{"a.b": false}, null, {"a.b": false}, {}]
        });
        assert_eq!(
            field_examples(&schema, "a.b"),
            schema["properties"]["a.b"]["examples"]
                .as_array()
                .map(Vec::as_slice)
        );
        for name in ["defaults", "malformed", "empty", "missing"] {
            assert!(field_examples(&schema, name).is_none());
        }
        assert_eq!(
            input_examples(&schema),
            vec![&json!({"a.b": false}), &json!(null), &json!({})]
        );
        assert!(input_examples(&json!({"examples": {}})).is_empty());
        assert!(
            input_examples(&json!({"properties": {"message": {"examples": ["hello"]}}})).is_empty()
        );
    }
}

#[cfg(test)]
mod native_tests {
    use conn_mcp_client::{
        McpCapabilities, McpServerInfo,
        servers::new_mcp_server,
        store::{McpStatus, McpTool},
    };
    use conn_theme::Tokens;
    use gpui_kit::test::{TestEventExt as _, TestQueryExt as _, TestWindowExt as _};
    use gpui_kit::{AppContext as _, MouseButton, TestAppContext, px};
    use serde_json::json;

    use super::super::McpPanel;

    #[gpui_kit::test]
    fn catalog_sidebar_aligns_with_search_and_examples_follow_the_selected_tool(
        cx: &mut TestAppContext,
    ) {
        let (window, _) = cx.update(|cx| {
            gpui_kit::init(cx);
            let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
            let tokens = Tokens::derive(&theme);
            crate::theme::apply_kit_theme(&tokens, cx);
            gpui_kit::open_window(Default::default(), cx, |window, cx| {
                cx.new(|cx| {
                    let mut panel = McpPanel::new(tokens, window, cx);
                    // Configure the loaded session in memory. No project/server settings are persisted.
                    panel.project_key = Some("fixture".to_owned());
                    let server = new_mcp_server(None);
                    panel.synced_server = Some(server.id.clone());
                    panel.store = Default::default();
                    panel.store.project_mut("fixture").add(server);
                    let key = panel.current_session_key().expect("selected server");
                    let session = panel.sessions.entry(key).or_default();
                    session.status = McpStatus::Connected;
                    session.info = Some(McpServerInfo {
                        name: "Fixture".to_owned(),
                        title: None,
                        version: "1".to_owned(),
                        protocol_version: None,
                        instructions: None,
                        capabilities: McpCapabilities {
                            tools: true,
                            ..Default::default()
                        },
                    });
                    session.tools = Some(vec![
                        McpTool {
                            name: "with-example".to_owned(),
                            input_schema: json!({
                                "type":"object", "examples":[{"message":"hello"}]
                            }),
                            ..Default::default()
                        },
                        McpTool {
                            name: "without-example".to_owned(),
                            ..Default::default()
                        },
                    ]);
                    panel
                })
            })
            .expect("inspector window")
        });
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            let search = w.find_by_label("Search tools").bounds();
            let first = w.find_by_label("with-example").bounds();
            let second = w.find_by_label("without-example").bounds();
            let sections = w.find_by_label("MCP sections").bounds();
            let detail = w.find_by_label("Item detail").bounds();
            assert_eq!(
                detail.top(),
                sections.bottom(),
                "detail starts below the section tabs"
            );
            assert_eq!(
                search.top() - sections.bottom(),
                px(8.0),
                "catalog search starts at its top inset"
            );
            assert_eq!(first.left(), search.left());
            assert_eq!(first.right(), search.right());
            assert_eq!(first.top() - search.bottom(), px(6.0));
            assert_eq!(first.size.height, px(32.0));
            assert_eq!(second.top() - first.bottom(), px(2.0));
            let summary = w.find_by_label("Example inputs (1)");
            assert_eq!(summary.expanded(), Some(false));
            let point = summary.bounds().center();
            w.pointer_move(point, None, cx);
            w.pointer_down(point, MouseButton::Left, cx);
            w.pointer_up(point, MouseButton::Left, cx);
        })
        .expect("inspector is mounted");
        cx.run_until_parked();
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            assert_eq!(w.find_by_label("Example inputs (1)").expanded(), Some(true));
            let point = w.find_by_label("without-example").bounds().center();
            w.pointer_move(point, None, cx);
            w.pointer_down(point, MouseButton::Left, cx);
            w.pointer_up(point, MouseButton::Left, cx);
        })
        .expect("open example");
        cx.run_until_parked();
        cx.update_window(window, |_, w, cx| {
            w.render_frame(cx);
            assert!(w.try_find_by_label("Example inputs (1)").is_none());
        })
        .expect("tool with no examples");
    }
}
