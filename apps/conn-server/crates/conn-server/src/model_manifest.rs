//! The model manifest this server ships (`model_manifest/bundled.json`), and
//! `userdata/model-manifest.json`, which Orbit's task turns read to check a model before they
//! start a thread.
//!
//! The server never fetches a manifest. At start it writes the bundled one to the state folder
//! in the T3 server's cache format, `{"fetchedAtMs":<ms>,"manifest":<manifest>}`, and gives it
//! to the providers (`conn_provider::LiveManifest`). New models reach users through an audit
//! refresh of `bundled.json` (the `audit-t3-providers` skill) and a Conn Server release.
//!
//! `bundled.json` is hand-owned since upstream T3 Code `05e3674636`, where it equals
//! `apps/server/src/provider/model-manifest.json`.

use std::path::Path;

use serde_json::Value;

pub const FILE_NAME: &str = "model-manifest.json";

const BUNDLED: &str = include_str!("model_manifest/bundled.json");

/// The bundled manifest, for the providers.
pub fn live() -> conn_provider::LiveManifest {
    let live = conn_provider::LiveManifest::default();
    if let Ok(manifest) = serde_json::from_str::<Value>(BUNDLED) {
        live.set(manifest);
    }
    live
}

/// Writes the bundled manifest to `<state_dir>/model-manifest.json`, atomically. Returns
/// whether it wrote the file.
pub async fn write(state_dir: &Path) -> bool {
    let path = state_dir.join(FILE_NAME);
    let now = i64::try_from(conn_support::time::now_ms()).unwrap_or(i64::MAX);
    let Some(manifest) = compact_json(BUNDLED) else {
        return false;
    };
    let contents = cache_text(now, &manifest);
    let written = tokio::task::spawn_blocking(move || {
        conn_support::fs::write_atomic(&path, contents.as_bytes(), 0o644)
    })
    .await;
    matches!(written, Ok(Ok(())))
}

/// The cache file's text: `JSON.stringify({fetchedAtMs, manifest})`.
fn cache_text(fetched_at_ms: i64, compact_manifest: &str) -> String {
    format!("{{\"fetchedAtMs\":{fetched_at_ms},\"manifest\":{compact_manifest}}}")
}

/// The JSON text without the white space between tokens, in its own key order, as
/// `JSON.stringify` writes a value it parsed. `None` when it is not JSON.
fn compact_json(text: &str) -> Option<String> {
    serde_json::from_str::<serde::de::IgnoredAny>(text).ok()?;
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_ascii_whitespace() {
            out.push(c);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_json_keeps_order_and_strings() {
        assert_eq!(
            compact_json("{ \"b\" : [1, 2],\n \"a\": \"x y \\\" z\" }").unwrap(),
            r#"{"b":[1,2],"a":"x y \" z"}"#
        );
        assert!(compact_json("{nope").is_none());
    }

    /// The file Orbit reads holds the bundled manifest, and the providers get it too.
    #[tokio::test(flavor = "current_thread")]
    async fn start_writes_the_bundled_manifest_and_gives_it_to_the_providers() {
        let dir = std::env::temp_dir().join(format!("conn-manifest-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(write(&dir).await);
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert!(written["fetchedAtMs"].as_i64().unwrap() > 0);
        let bundled: Value = serde_json::from_str(BUNDLED).unwrap();
        assert_eq!(written["manifest"], bundled);
        assert_eq!(bundled["version"], 1);
        let live = live();
        assert!(matches!(live.provider_catalog("codex"), Some(Some(_))));
        assert!(matches!(
            live.provider_catalog("claudeAgent"),
            Some(Some(_))
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Each Claude model the bundled manifest lists decodes as the config's wire type, so an
    /// audit refresh that breaks the contract fails here, not in `server.getConfig`.
    #[test]
    fn the_bundled_claude_models_follow_the_contract() {
        let bundled: Value = serde_json::from_str(BUNDLED).unwrap();
        assert!(conn_provider_claude::catalog::manifest_adapters_are_valid(
            &bundled
        ));
        let models = conn_provider_claude::catalog::current_provider_models(&live(), 0);
        assert!(!models.is_empty());
        for model in models {
            let decoded: Result<conn_contract::ServerProvidersItemItemModelsItem, _> =
                conn_contract::from_json(model.clone());
            assert!(decoded.is_ok(), "{model}");
        }
    }
}
