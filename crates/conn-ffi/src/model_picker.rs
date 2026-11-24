//! The composer's model chip and the model list of Conn mobile's thread settings sheet
//! (`ThreadComposer.tsx` `ComposerModelControl`, `ThreadSettingsSheet.tsx`,
//! `thread-settings-sheet-state.ts`, `lib/modelOptions.ts`), so the SwiftUI views only draw.

use conn_state::providers::{ModelCatalog, ModelOption, ProviderGroup};

/// Drivers whose sections start expanded (`PRIMARY_PROVIDER_DRIVERS`).
const PRIMARY_DRIVERS: [&str; 3] = ["claudeAgent", "codex", "antigravity"];

/// One model row (`ModelRowContent`).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiModelPickerRow {
    pub instance_id: String,
    pub model: String,
    pub label: String,
    /// The sub-provider, or empty.
    pub subtitle: String,
    pub is_default: bool,
    pub is_legacy: bool,
    /// The checkmark: the pending pick, else the thread's model.
    pub selected: bool,
}

/// One provider section: its header and, unless collapsed, its rows.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiModelPickerSection {
    pub instance_id: String,
    pub driver: String,
    pub label: String,
    pub collapsible: bool,
    pub collapsed: bool,
    pub model_count: u32,
    pub models: Vec<FfiModelPickerRow>,
}

/// The chip and the sheet for one thread.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiModelPicker {
    /// False until the server's provider list arrived.
    pub loaded: bool,
    /// The thread's provider driver, for the chip's icon (`ProviderIcon`).
    pub selected_driver: Option<String>,
    /// The thread's model name, for the chip's accessibility label.
    pub selected_label: Option<String>,
    pub sections: Vec<FfiModelPickerSection>,
    /// The sheet's confirm button saves (`Save`) rather than closes (`Done`).
    pub has_pending: bool,
}

/// What [`build_model_picker`] needs from the thread.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PickerThread {
    pub instance_id: Option<String>,
    pub model: Option<String>,
    /// A started thread keeps its provider (`threadAllowsProviderSwitch` without a projection).
    pub started: bool,
}

/// The sheet's view state that lives in Swift.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PickerInput<'a> {
    pub query: &'a str,
    /// Sections the user toggled away from their default (`providerExpansionOverrides`).
    pub toggled: &'a [String],
    /// The row tapped but not saved yet, as `(instance_id, model)`.
    pub pending: Option<(&'a str, &'a str)>,
}

/// `buildModelOptions` + `buildThreadSettingsCatalogItems`, without favorites, hidden models,
/// filters and sub-provider headers.
pub(crate) fn build_model_picker(
    catalog: &ModelCatalog,
    loaded: bool,
    thread: &PickerThread,
    input: &PickerInput<'_>,
) -> FfiModelPicker {
    let applied = |m: &ModelOption| {
        thread.instance_id.as_deref() == Some(m.instance_id.as_str())
            && thread.model.as_deref() == Some(m.slug.as_str())
    };
    let displayed = |m: &ModelOption| match input.pending {
        Some((instance, model)) => m.instance_id == instance && m.slug == model,
        None => applied(m),
    };
    let locked = thread
        .started
        .then_some(thread.instance_id.as_deref())
        .flatten();
    let query = input.query.trim().to_lowercase();
    let narrowed = !query.is_empty();

    let sections = catalog
        .providers
        .iter()
        .filter(|group| offers_models(group) && locked.is_none_or(|id| id == group.instance_id))
        .filter_map(|group| {
            let models: Vec<&ModelOption> = group
                .models
                .iter()
                .filter(|m| !m.is_legacy || displayed(m))
                .filter(|m| matches_query(m, &group.display_name, &query))
                .collect();
            if models.is_empty() {
                return None;
            }
            let default_expanded = PRIMARY_DRIVERS.contains(&group.driver.as_str())
                || group.models.iter().any(applied);
            let overridden = input.toggled.iter().any(|key| *key == group.instance_id);
            let collapsed = !narrowed && (default_expanded == overridden);
            Some(FfiModelPickerSection {
                instance_id: group.instance_id.clone(),
                driver: group.driver.clone(),
                label: group.display_name.clone(),
                collapsible: !narrowed,
                collapsed,
                model_count: u32::try_from(models.len()).unwrap_or(u32::MAX),
                models: if collapsed {
                    Vec::new()
                } else {
                    models
                        .into_iter()
                        .map(|m| FfiModelPickerRow {
                            instance_id: m.instance_id.clone(),
                            model: m.slug.clone(),
                            label: m.name.clone(),
                            subtitle: m.sub_provider.clone().unwrap_or_default(),
                            is_default: m.is_default,
                            is_legacy: m.is_legacy,
                            selected: displayed(m),
                        })
                        .collect()
                },
            })
        })
        .collect();

    let selected_driver = thread
        .instance_id
        .as_deref()
        .and_then(|id| catalog.driver_for_instance(id))
        .map(str::to_owned);
    let selected_label = thread.model.as_deref().map(|slug| {
        catalog
            .find_model(thread.instance_id.as_deref(), slug)
            .map_or_else(|| slug.to_owned(), |m| m.name.clone())
    });
    let has_pending = input.pending.is_some_and(|(instance, model)| {
        thread.instance_id.as_deref() != Some(instance) || thread.model.as_deref() != Some(model)
    });

    FfiModelPicker {
        loaded,
        selected_driver,
        selected_label,
        sections,
        has_pending,
    }
}

/// `buildModelOptions` skips providers that are off, not installed or signed out.
fn offers_models(group: &ProviderGroup) -> bool {
    group.enabled && group.installed && !group.unauthenticated && group.available
}

/// `modelMatchesCatalogQuery`: label, sub-provider, slug or provider name.
fn matches_query(model: &ModelOption, provider_label: &str, query: &str) -> bool {
    query.is_empty()
        || [
            model.name.as_str(),
            model.sub_provider.as_deref().unwrap_or_default(),
            model.slug.as_str(),
            provider_label,
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(query))
}

#[cfg(test)]
mod tests {
    use conn_contract::ServerProvidersItemItem;
    use serde_json::{Value, json};

    use super::*;

    fn provider(
        id: &str,
        driver: &str,
        name: &str,
        models: Value,
    ) -> Option<ServerProvidersItemItem> {
        let value = json!({
            "instanceId": id,
            "driver": driver,
            "displayName": name,
            "enabled": true,
            "installed": true,
            "status": "ready",
            "auth": { "status": "authenticated" },
            "checkedAt": "2026-11-24T00:00:00Z",
            "models": models,
        });
        Some(serde_json::from_value(value).expect("provider decodes"))
    }

    fn catalog() -> ModelCatalog {
        ModelCatalog::from_providers(&[
            provider(
                "claudeAgent",
                "claudeAgent",
                "Claude",
                json!([
                    { "slug": "sonnet", "name": "Claude Sonnet 4.5", "isCustom": false, "isDefault": true },
                    { "slug": "opus-3", "name": "Claude Opus 3", "isCustom": false, "isLegacy": true },
                ]),
            ),
            provider(
                "grok",
                "grok",
                "Grok",
                json!([{ "slug": "grok-build", "name": "Grok Build", "isCustom": false }]),
            ),
        ])
    }

    fn thread(instance: &str, model: &str, started: bool) -> PickerThread {
        PickerThread {
            instance_id: Some(instance.to_owned()),
            model: Some(model.to_owned()),
            started,
        }
    }

    #[test]
    fn primary_sections_open_and_others_fold_until_toggled() {
        let picker = build_model_picker(
            &catalog(),
            true,
            &thread("claudeAgent", "sonnet", false),
            &PickerInput::default(),
        );
        assert_eq!(
            picker.selected_driver.as_deref(),
            Some("claudeAgent"),
            "chip icon follows the instance"
        );
        assert_eq!(
            picker.selected_label.as_deref(),
            Some("Claude Sonnet 4.5"),
            "chip names the model"
        );
        let claude = &picker.sections[0];
        assert!(!claude.collapsed, "a primary driver starts expanded");
        assert_eq!(
            claude.models.len(),
            1,
            "legacy models stay out unless selected"
        );
        assert!(
            claude.models[0].selected && claude.models[0].is_default,
            "the applied model is checked"
        );
        let grok = &picker.sections[1];
        assert!(
            grok.collapsed && grok.models.is_empty(),
            "other drivers start folded"
        );
        assert_eq!(
            grok.model_count, 1,
            "a folded section still counts its models"
        );

        let toggled = ["grok".to_owned()];
        let opened = build_model_picker(
            &catalog(),
            true,
            &thread("claudeAgent", "sonnet", false),
            &PickerInput {
                toggled: &toggled,
                ..PickerInput::default()
            },
        );
        assert!(
            !opened.sections[1].collapsed,
            "a toggle opens a folded section"
        );
    }

    #[test]
    fn pending_pick_moves_the_check_and_search_opens_everything() {
        let picker = build_model_picker(
            &catalog(),
            true,
            &thread("claudeAgent", "sonnet", false),
            &PickerInput {
                query: " build ",
                pending: Some(("grok", "grok-build")),
                ..PickerInput::default()
            },
        );
        assert!(
            picker.has_pending,
            "a pick that differs from the thread is pending"
        );
        assert_eq!(
            picker.sections.len(),
            1,
            "search keeps only matching sections"
        );
        let grok = &picker.sections[0];
        assert!(
            !grok.collapsible && !grok.collapsed,
            "a search shows every match"
        );
        assert!(
            grok.models[0].selected,
            "the pending pick carries the check"
        );
    }

    #[test]
    fn a_started_thread_keeps_its_provider() {
        let picker = build_model_picker(
            &catalog(),
            true,
            &thread("grok", "grok-build", true),
            &PickerInput::default(),
        );
        let ids: Vec<_> = picker
            .sections
            .iter()
            .map(|s| s.instance_id.as_str())
            .collect();
        assert_eq!(ids, ["grok"], "only the thread's provider is offered");
        assert!(
            !picker.sections[0].collapsed,
            "the section with the applied model opens"
        );
    }
}
