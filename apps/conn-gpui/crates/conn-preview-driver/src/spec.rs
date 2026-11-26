//! The browser behaviour T3 generates (`spec.json`) and Playwright's injected DOM engine
//! (`injected.js`). Both are the files `conn-preview` ships with `conn-server`: one copy in the
//! monorepo, so agents see the same snapshots, refs and key maps from every kind of tab.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::PageError;

/// Playwright's injected script, as `conn-preview` evaluates it in the page's utility world.
pub(crate) const INJECTED_JS: &str =
    include_str!("../../../../conn-server/crates/conn-preview/src/injected.js");

const SPEC_JSON: &str = include_str!("../../../../conn-server/crates/conn-preview/src/spec.json");

/// The parts of `spec.json` the desktop host uses.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spec {
    pub scripts: Scripts,
    pub keys: HashMap<String, serde_json::Value>,
    pub non_web_schemes: Vec<String>,
    pub presets: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Scripts {
    pub snapshot: String,
    pub sensitive: String,
    #[serde(rename = "credentialPrepare")]
    pub credential_prepare: String,
    #[serde(rename = "credentialInsert")]
    pub credential_insert: String,
    pub dotted: String,
    pub mask: String,
}

/// The decoded spec, read once.
pub(crate) fn spec() -> Result<&'static Spec, PageError> {
    static SPEC: OnceLock<Result<Spec, PageError>> = OnceLock::new();
    SPEC.get_or_init(|| serde_json::from_str(SPEC_JSON).map_err(|e| PageError(e.to_string())))
        .as_ref()
        .map_err(Clone::clone)
}
