//! `settings.json` as T3's `loadSettingsFromDisk` reads it (`apps/server/src/serverSettings.ts`):
//! lenient JSON, the persisted-only values, the legacy fields decoded apart, and the legacy
//! provider map moved to provider instances with the provider history T3 kept.

use std::{fs, io, path::Path};

use serde_json::{Map, Value, json};

use conn_contract::ServerSettings;

use super::ensure_object;
use super::generated::{DEFAULT_DISABLED_DRIVERS, NULL_RULES};

/// T3's database beside the settings file; the provider history lives there.
const T3_STATE_FILE: &str = "statev2.sqlite";

/// `HISTORY_RESTORED_DRIVERS`: drivers off by default that T3 turns on when they ran before.
const HISTORY_RESTORED_DRIVERS: [&str; 3] = ["cursor", "grok", "opencode"];

/// The file as read.
pub(super) struct Decoded {
    /// The document to keep: the file's own keys, all source control hosts included, with the
    /// persisted-only values decoded and the legacy provider map moved. For an untrusted file,
    /// T3's conservative defaults (with the provider choices that could still be read) instead.
    pub doc: Map<String, Value>,
    /// The legacy provider map was moved: write `doc` back.
    pub migrated: bool,
    /// Why the file cannot be trusted. Then nothing may write it until the user repairs it.
    pub failure: Option<String>,
    /// The failure may pass by itself (a read or the provider history failed), so the next
    /// load tries again: T3 keeps a failed load for no time.
    pub retryable: bool,
}

/// Whole numbers T3 holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Reads and decodes `path`. Only reads: the caller decides what to write. Blocking.
pub(super) fn decode(path: &Path) -> Decoded {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Decoded {
                doc: Map::new(),
                migrated: false,
                failure: None,
                retryable: false,
            };
        }
        Err(error) => return untrusted(path, error.to_string(), None, None).retry(),
    };
    let mut doc = match parse_lenient(&raw) {
        Ok(Value::Object(doc)) => doc,
        Ok(_) => return untrusted(path, "the settings are not an object".into(), None, None),
        Err(error) => return untrusted(path, error, None, None),
    };
    // `LegacyProviderSettingsJson`: decoded apart, so a readable opt-out holds even when an
    // unrelated field does not decode.
    let legacy = legacy_providers(&doc);
    normalize_persisted(&mut doc);
    match (check(&doc), legacy) {
        (Ok(()), Ok(None)) => Decoded {
            doc,
            migrated: false,
            failure: None,
            retryable: false,
        },
        (Ok(()), Ok(Some(providers))) => match provider_history(path) {
            Ok(history) => {
                doc.remove("providers");
                migrate_legacy_providers(&mut doc, providers, &history);
                Decoded {
                    doc,
                    migrated: true,
                    failure: None,
                    retryable: false,
                }
            }
            // T3's load fails on `read-provider-history`; the file stays for the next load.
            // The instance map decoded, so its explicit choices hold meanwhile.
            Err(error) => {
                let instances = doc.get("providerInstances").cloned();
                let failure = format!("read-provider-history: {error}");
                untrusted(path, failure, Some(providers), instances).retry()
            }
        },
        (Err(error), legacy) => untrusted(path, error, legacy.ok().flatten(), None),
        (Ok(()), Err(error)) => untrusted(path, error, None, None),
    }
}

impl Decoded {
    fn retry(mut self) -> Self {
        self.retryable = true;
        self
    }
}

/// T3's fallback for a file it cannot trust: the defaults, with restart continuation off and
/// usage history kept, a provider instance map that decoded, and a legacy provider map it
/// could still read.
fn untrusted(
    path: &Path,
    failure: String,
    legacy: Option<Map<String, Value>>,
    instances: Option<Value>,
) -> Decoded {
    let mut doc = Map::new();
    // The file may hold an opt-out this server cannot read; never resume threads on a guess.
    doc.insert("continueThreadsAfterServerUpdate".into(), json!(false));
    doc.insert("usageHistoryRetentionDays".into(), json!("unlimited"));
    if let Some(instances) = instances {
        doc.insert("providerInstances".into(), instances);
    }
    if let Some(providers) = legacy {
        let history = provider_history(path).unwrap_or_default();
        migrate_legacy_providers(&mut doc, providers, &history);
    }
    Decoded {
        doc,
        migrated: false,
        failure: Some(failure),
        retryable: false,
    }
}

/// `fromLenientJson` (`packages/shared/src/schemaJson.ts`): JSON with `//` and `/* */`
/// comments and trailing commas outside strings.
pub(super) fn parse_lenient(input: &str) -> Result<Value, String> {
    let without_comments = strip_comments(input);
    let stripped = strip_trailing_commas(&without_comments);
    serde_json::from_str(&stripped).map_err(|error| error.to_string())
}

/// Copies a string literal that starts at `chars[start]` (a `"`); returns the index after it.
fn copy_string(chars: &[char], start: usize, out: &mut String) -> usize {
    out.push('"');
    let mut index = start + 1;
    while let Some(&c) = chars.get(index) {
        out.push(c);
        index += 1;
        match c {
            '\\' => {
                if let Some(&escaped) = chars.get(index) {
                    out.push(escaped);
                    index += 1;
                }
            }
            '"' => break,
            _ => {}
        }
    }
    index
}

/// Each comment becomes one space, so the tokens around it stay apart.
fn strip_comments(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(&c) = chars.get(index) {
        let next = chars.get(index + 1).copied();
        if c == '"' {
            index = copy_string(&chars, index, &mut out);
        } else if c == '/' && next == Some('/') {
            while chars.get(index).is_some_and(|&c| c != '\n' && c != '\r') {
                index += 1;
            }
            out.push(' ');
        } else if c == '/' && next == Some('*') {
            let end = (index + 2..chars.len().saturating_sub(1))
                .find(|&i| chars.get(i) == Some(&'*') && chars.get(i + 1) == Some(&'/'));
            match end {
                Some(end) => {
                    index = end + 2;
                    out.push(' ');
                }
                // An open block comment is left as it is; the JSON then fails to parse.
                None => {
                    out.push(c);
                    index += 1;
                }
            }
        } else {
            out.push(c);
            index += 1;
        }
    }
    out
}

/// A comma followed only by whitespace and a closing bracket is dropped.
fn strip_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(&c) = chars.get(index) {
        if c == '"' {
            index = copy_string(&chars, index, &mut out);
            continue;
        }
        if c == ',' {
            let after = chars
                .get(index + 1..)
                .unwrap_or_default()
                .iter()
                .copied()
                .find(|c| !c.is_whitespace());
            if matches!(after, Some('}' | ']')) {
                index += 1;
                continue;
            }
        }
        out.push(c);
        index += 1;
    }
    out
}

/// `LegacyProviderSettingsJson`: `providers`, `bitbucket` and `github` are objects when
/// present. Returns the legacy provider map.
fn legacy_providers(doc: &Map<String, Value>) -> Result<Option<Map<String, Value>>, String> {
    for key in ["providers", "bitbucket", "github"] {
        if doc.get(key).is_some_and(|value| !value.is_object()) {
            return Err(format!("the legacy `{key}` setting is not an object"));
        }
    }
    Ok(doc.get("providers").and_then(Value::as_object).cloned())
}

/// JSON has one number type: `30.0` is the whole number 30 to T3, but not to the generated
/// `i64` decoder. Whole numbers T3 holds exactly (`Number.isSafeInteger`) become integers.
pub(super) fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(number) if number.is_f64() => {
            if let Some(whole) = number
                .as_f64()
                .filter(|n| n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER)
            {
                // Exact: a whole number within the safe range converts without loss.
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "checked whole and in range"
                )]
                let whole = whole as i64;
                *value = json!(whole);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(fields) => fields.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

/// `PersistedServerSettings`: the retired `token` streaming mode reads as `paragraph`, for
/// the machine and for each project, and whole numbers are integers.
fn normalize_persisted(doc: &mut Map<String, Value>) {
    doc.values_mut().for_each(normalize_numbers);
    fn retire_token(settings: &mut Map<String, Value>) {
        if settings.get("responseStreamingMode") == Some(&json!("token")) {
            settings.insert("responseStreamingMode".into(), json!("paragraph"));
        }
    }
    retire_token(doc);
    if let Some(Value::Object(projects)) = doc.get_mut("projectSettingsOverrides") {
        for overrides in projects.values_mut() {
            if let Value::Object(overrides) = overrides {
                retire_token(overrides);
            }
        }
    }
}

/// Whether the whole document decodes as `ServerSettings`, hosts this server does not serve
/// included, with the checks the generated decoder does not make.
pub(super) fn check(doc: &Map<String, Value>) -> Result<(), String> {
    check_refinements(doc)?;
    let doc = Value::Object(doc.clone());
    check_nulls(&doc, null_rules(), "")?;
    conn_contract::from_json::<ServerSettings>(doc)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// [`NULL_RULES`], parsed once.
fn null_rules() -> &'static Value {
    static RULES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    RULES.get_or_init(|| serde_json::from_str(NULL_RULES).unwrap_or(Value::Null))
}

/// Refuses an explicit `null` where T3's persisted schema takes none, at any depth
/// ([`NULL_RULES`]); serde would read it as absent. A key the schema does not know is
/// ignored, as T3 ignores excess keys.
fn check_nulls(value: &Value, rule: &Value, path: &str) -> Result<(), String> {
    let visit = |value: &Value, rule: &Value, at: String| -> Result<(), String> {
        if value.is_null() {
            return if rule.get("n").is_some() {
                Ok(())
            } else {
                Err(format!("`{at}` may not be null"))
            };
        }
        check_nulls(value, rule, &at)
    };
    match value {
        Value::Object(fields) => {
            for (key, field) in fields {
                let known = rule
                    .get("f")
                    .and_then(|fields| fields.get(key))
                    .or_else(|| rule.get("v"));
                if let Some(known) = known {
                    let at = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    visit(field, known, at)?;
                }
            }
        }
        Value::Array(items) => {
            if let Some(known) = rule.get("i") {
                for (index, item) in items.iter().enumerate() {
                    visit(item, known, format!("{path}[{index}]"))?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Checks the generated decoder does not make: `usageHistoryRetentionDays` is a positive
/// safe integer or `"unlimited"` (`UsageHistoryRetentionDays`,
/// `packages/contracts/src/settings.ts`).
pub(super) fn check_refinements(settings: &Map<String, Value>) -> Result<(), String> {
    match settings.get("usageHistoryRetentionDays") {
        None => Ok(()),
        Some(Value::String(days)) if days == "unlimited" => Ok(()),
        Some(Value::Number(days))
            if days.as_f64().is_some_and(|days| {
                days > 0.0 && days.fract() == 0.0 && days <= MAX_SAFE_INTEGER
            }) =>
        {
            Ok(())
        }
        Some(other) => Err(format!(
            "usageHistoryRetentionDays must be a positive whole number or \"unlimited\", not {other}"
        )),
    }
}

/// `(providerName, providerInstanceId)` of the cursor, grok and opencode sessions T3 recorded
/// in `statev2.sqlite` beside the settings file, read-only. Empty only when there is no such
/// file; an error when anything there cannot be read.
fn provider_history(settings_path: &Path) -> Result<Vec<(String, Option<String>)>, String> {
    let Some(db) = settings_path.parent().map(|dir| dir.join(T3_STATE_FILE)) else {
        return Ok(Vec::new());
    };
    match fs::metadata(&db) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{}: {error}", db.display())),
        Ok(meta) if !meta.is_file() => return Err(format!("{}: not a file", db.display())),
        Ok(_) => {}
    }
    let read = || -> rusqlite::Result<Vec<(String, Option<String>)>> {
        let conn = rusqlite::Connection::open_with_flags(
            &db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut statement = conn.prepare(
            "SELECT DISTINCT provider_name, provider_instance_id FROM projection_thread_sessions
               WHERE provider_name IN ('cursor', 'grok', 'opencode')
             UNION
             SELECT DISTINCT provider_name, provider_instance_id FROM provider_session_runtime
               WHERE provider_name IN ('cursor', 'grok', 'opencode')",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    };
    read().map_err(|error| format!("{}: {error}", db.display()))
}

/// `migrateLegacyProviderSettings`. An instance of a driver T3 turns on from history that
/// ran before is turned on unless it says otherwise. Each legacy entry whose key is a driver
/// becomes that driver's default instance, unless the settings name that instance already;
/// an entry that only restates the driver's default is dropped.
fn migrate_legacy_providers(
    settings: &mut Map<String, Value>,
    legacy: Map<String, Value>,
    history: &[(String, Option<String>)],
) {
    let used_driver = |driver: &str| history.iter().any(|(name, _)| name == driver);
    let used_instance = |id: &str| {
        history
            .iter()
            .any(|(name, instance)| instance.as_deref().unwrap_or(name) == id)
    };
    let named = settings.contains_key("providerInstances");
    let instances = ensure_object(
        settings
            .entry("providerInstances")
            .or_insert_with(|| json!({})),
    );
    for (id, instance) in instances.iter_mut() {
        let restored = instance["driver"]
            .as_str()
            .is_some_and(|driver| HISTORY_RESTORED_DRIVERS.contains(&driver));
        if let Value::Object(instance) = instance
            && !instance.contains_key("enabled")
            && restored
            && used_instance(id)
        {
            instance.insert("enabled".into(), json!(true));
        }
    }
    let mut entries: Vec<(String, Value)> = legacy.into_iter().collect();
    for driver in HISTORY_RESTORED_DRIVERS {
        if !entries.iter().any(|(kind, _)| kind == driver) {
            entries.push((driver.to_owned(), json!({})));
        }
    }
    for (driver, blob) in entries {
        let Value::Object(mut config) = blob else {
            continue;
        };
        if !is_slug(&driver) || instances.contains_key(&driver) {
            continue;
        }
        let restored = HISTORY_RESTORED_DRIVERS.contains(&driver.as_str());
        let enabled = config
            .remove("enabled")
            .and_then(|enabled| enabled.as_bool())
            .or_else(|| (restored && used_driver(&driver)).then_some(true));
        let driver_default = !DEFAULT_DISABLED_DRIVERS.contains(&driver.as_str());
        if config.is_empty() && enabled.is_none_or(|enabled| enabled == driver_default) {
            continue;
        }
        let mut instance = Map::new();
        instance.insert("driver".into(), json!(driver));
        if let Some(enabled) = enabled {
            instance.insert("enabled".into(), json!(enabled));
        }
        instance.insert("config".into(), Value::Object(config));
        instances.insert(driver, Value::Object(instance));
    }
    if !named && instances.is_empty() {
        settings.remove("providerInstances");
    }
}

/// `ProviderDriverKind`: a slug of at most 64 characters.
fn is_slug(value: &str) -> bool {
    let mut chars = value.chars();
    value.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `schemaJson.test.ts`: comments and trailing commas outside strings, never inside.
    #[test]
    fn lenient_json_drops_comments_and_trailing_commas_outside_strings() {
        let parsed = parse_lenient(
            "{\n  // a note\n  \"url\": \"http://x//y\", /* block */\n  \"list\": [1, 2,],\n  \"text\": \"a,}\",\n}",
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({"url": "http://x//y", "list": [1, 2], "text": "a,}"})
        );
        assert!(parse_lenient("{\"a\": 1 /* open").is_err());
    }

    #[test]
    fn whole_floats_become_integers_within_the_safe_range() {
        let mut value = json!({"a": 30.0, "b": [1.5, 2.0], "c": 1e300, "d": -4.0});
        normalize_numbers(&mut value);
        assert_eq!(value, json!({"a": 30, "b": [1.5, 2], "c": 1e300, "d": -4}));
    }

    #[test]
    fn retention_is_a_positive_whole_number_or_unlimited() {
        let check = |value: Value| {
            let mut settings = Map::new();
            settings.insert("usageHistoryRetentionDays".into(), value);
            check_refinements(&settings).is_ok()
        };
        assert!(check(json!(30)));
        assert!(check(json!("unlimited")));
        assert!(check(json!(9_007_199_254_740_991_u64)));
        for bad in [
            json!(9_007_199_254_740_992_u64),
            json!(0),
            json!(-1),
            json!(1.5),
            json!("forever"),
            json!(null),
        ] {
            assert!(!check(bad.clone()), "{bad}");
        }
    }
}
