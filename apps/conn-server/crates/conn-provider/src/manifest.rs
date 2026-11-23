//! [`LiveManifest`]: the model manifest the server accepted last (T3's `ModelManifest.current`),
//! shared with the providers that classify their models with it.

use std::sync::{Arc, RwLock};

use serde_json::Value;

/// The accepted manifest, or none: then the providers use the manifest bundled at build time.
/// The server sets it when it loads a newer disk cache or accepts a fetch; providers read it
/// on every probe, so the next probe shows it. Cheap to clone; clones share the manifest.
#[derive(Clone, Debug, Default)]
pub struct LiveManifest(Arc<RwLock<Option<Arc<Value>>>>);

impl LiveManifest {
    /// Replaces the manifest.
    pub fn set(&self, manifest: Value) {
        let mut current = self
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *current = Some(Arc::new(manifest));
    }

    /// `None` while no manifest was set (the bundled one holds). Otherwise the set manifest's
    /// catalog for `driver` (`manifest.providers[driver]`), `Some(None)` when it has none.
    pub fn provider_catalog(&self, driver: &str) -> Option<Option<Value>> {
        let current = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let manifest = current.as_ref()?;
        Some(
            manifest
                .get("providers")
                .and_then(|providers| providers.get(driver))
                .cloned(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clones_share_the_manifest() {
        let live = LiveManifest::default();
        assert_eq!(live.provider_catalog("codex"), None);
        let reader = live.clone();
        live.set(json!({"providers": {"codex": {"models": []}}}));
        assert_eq!(
            reader.provider_catalog("codex"),
            Some(Some(json!({"models": []})))
        );
        assert_eq!(reader.provider_catalog("antigravity"), Some(None));
    }
}
