//! `POST /api/settings/provider-instances` (ADR 0274): many `providerInstanceMutation`s of
//! `server.updateSettings`, applied in order and saved once.
//!
//! Each mutation is checked, made canonical (trimmed ids, driver and names, as the contract
//! decodes them) and applied to one staged copy of the settings. Its secrets are resolved
//! against the staged secret store, so a marker after a rotation or a removal in the same batch
//! means the staged value, not the saved one. Nothing reaches the file or the store until
//! every mutation passed. The save writes only when a slot's final value or the document
//! differs from disk, and publishes a revision whenever the served settings change, so the
//! provider registry follows an edit made on disk.
//!
//! Error messages name the field and the expected type, never a submitted value.

use serde_json::{Map, Value, json};

use conn_contract::ProviderInstanceMutation;
use conn_support::secret_store;

use super::{
    Loaded, SettingsError, SettingsStore, apply_provider_instance_mutation, file, secrets, served,
    write_settings,
};

/// The most mutations one request takes.
pub const MAX_MUTATIONS: usize = 32;

const SLUG_MAX_CHARS: usize = 64;
const ENVIRONMENT_NAME_MAX_CHARS: usize = 128;
const SECRET_REFERENCE_MAX_CHARS: usize = 1024;

#[derive(Debug)]
pub enum BatchError {
    /// The mutation at `index` is refused; nothing was saved.
    Invalid { index: usize, message: String },
    /// Reading or writing the settings failed; nothing was saved.
    Failed(SettingsError),
}

impl SettingsStore {
    /// Applies `mutations` as described in the module docs and returns the client view.
    /// Blocking: it reads and writes the secret store and the file.
    pub fn apply_provider_instances(&self, mutations: Vec<Value>) -> Result<Value, BatchError> {
        if mutations.len() > MAX_MUTATIONS {
            return Err(BatchError::Invalid {
                index: MAX_MUTATIONS,
                message: format!("at most {MAX_MUTATIONS} mutations"),
            });
        }
        let _writer = crate::lock(&self.writer);
        // A dry run on the file as it is, read only: a refused batch writes nothing, not even
        // the migrations `load` writes.
        let decoded = file::decode(&self.path);
        if let Some(detail) = decoded.failure {
            return Err(BatchError::Failed(self.error("read-file", detail)));
        }
        stage(&decoded.doc, mutations.clone())?;
        // The batch passes: load as every save does (`updateAndPersistSettings`), migrations
        // included, then apply it to what that load gives.
        let seen = self.lock().materialized.clone();
        let (loaded, failure, retry) = super::load(&self.path, &self.secrets_dir);
        self.retry
            .store(retry, std::sync::atomic::Ordering::Relaxed);
        if let Some(detail) = failure {
            return Err(BatchError::Failed(self.error("read-file", detail)));
        }
        let (staged, changes) = stage(&loaded.doc, mutations)?;
        let dir = &self.secrets_dir;
        let store_unchanged = changes.iter().all(|change| {
            secret_store::read(dir, &change.name).is_ok_and(|stored| stored == change.write)
        });
        if staged == loaded.doc && store_unchanged {
            // Nothing to write. The registry reconciles on a revision, so one is published
            // when the served settings differ from what it last saw (an edit on disk).
            let changed = loaded.materialized != seen;
            *self.lock() = loaded;
            if changed {
                self.revision.send_modify(|r| *r += 1);
            }
            return Ok(self.for_client());
        }
        let undo = secrets::apply(dir, &changes).map_err(|(operation, error)| {
            BatchError::Failed(self.error(operation, error.to_string()))
        })?;
        let materialized = match secrets::materialize(dir, &served(&staged)) {
            Ok(materialized) => materialized,
            Err((_, error)) => {
                undo.run(dir);
                return Err(BatchError::Failed(
                    self.error("read-secret", error.to_string()),
                ));
            }
        };
        if let Err(error) = write_settings(&self.path, &staged) {
            undo.run(dir);
            return Err(BatchError::Failed(self.error("write-file", error)));
        }
        *self.lock() = Loaded {
            doc: staged,
            materialized,
        };
        self.revision.send_modify(|r| *r += 1);
        Ok(self.for_client())
    }
}

/// The batch applied in order to a copy of `current`, and the store changes it makes; or the
/// first mutation it refuses.
fn stage(
    current: &Map<String, Value>,
    mutations: Vec<Value>,
) -> Result<(Map<String, Value>, Vec<secrets::Change>), BatchError> {
    let mut staged = current.clone();
    let mut store = Staged::default();
    for (index, raw) in mutations.into_iter().enumerate() {
        let invalid = |message: String| BatchError::Invalid { index, message };
        let mut mutation = canonical(raw).map_err(invalid)?;
        // `30.0` is a whole number to T3: read it as the file stores it.
        file::normalize_numbers(&mut mutation);
        if conn_contract::from_json::<ProviderInstanceMutation>(mutation.clone()).is_err() {
            return Err(invalid(
                "the mutation does not decode as providerInstanceMutation".into(),
            ));
        }
        let id = mutation["instanceId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let exists = staged
            .get("providerInstances")
            .and_then(|instances| instances.get(&id))
            .is_some();
        if mutation["operation"] == "create" && exists {
            return Err(invalid(format!("the provider instance `{id}` exists")));
        }
        let before = staged.clone();
        apply_provider_instance_mutation(&mut staged, mutation).map_err(invalid)?;
        secrets::restore_echoed_unstored(&before, &mut staged);
        if file::check(&staged).is_err() {
            return Err(invalid(
                "the settings would not decode after this mutation".into(),
            ));
        }
        store.stage(secrets::persist(&before, &mut staged));
    }
    Ok((staged, store.into_changes()))
}

/// The store as the batch leaves it: the last change to each secret, in first-seen order.
#[derive(Default)]
struct Staged(Vec<secrets::Change>);

impl Staged {
    fn stage(&mut self, changes: Vec<secrets::Change>) {
        for change in changes {
            match self.0.iter_mut().find(|staged| staged.name == change.name) {
                Some(staged) => staged.write = change.write,
                None => self.0.push(change),
            }
        }
    }

    fn into_changes(self) -> Vec<secrets::Change> {
        self.0
    }
}

/// The mutation with the contract's shape checked and its names trimmed, or what is wrong.
fn canonical(raw: Value) -> Result<Value, String> {
    let Value::Object(mutation) = raw else {
        return Err("the mutation is not an object".into());
    };
    let operation = match mutation.get("operation").and_then(Value::as_str) {
        Some(op @ ("upsert" | "create" | "remove")) => op.to_owned(),
        _ => return Err("unknown operation".into()),
    };
    let id = match mutation.get("instanceId") {
        None => return Err("missing instanceId".into()),
        Some(id) => slug(id, "instanceId")?,
    };
    if operation == "remove" {
        if mutation.contains_key("instance") {
            return Err("a remove carries no instance".into());
        }
        return Ok(json!({ "operation": operation, "instanceId": id }));
    }
    let instance = match mutation.get("instance") {
        None => return Err("missing instance".into()),
        Some(Value::Object(instance)) => instance_config(instance.clone())?,
        Some(_) => return Err("instance must be an object".into()),
    };
    Ok(json!({ "operation": operation, "instanceId": id, "instance": instance }))
}

/// `ProviderInstanceConfig`'s fields that the batch reads or stores secrets by.
fn instance_config(mut instance: Map<String, Value>) -> Result<Value, String> {
    let driver = match instance.get("driver") {
        None => return Err("instance.driver is missing".into()),
        Some(driver) => slug(driver, "instance.driver")?,
    };
    instance.insert("driver".into(), json!(driver));
    for field in ["displayName", "accentColor"] {
        if let Some(value) = instance.get(field) {
            let trimmed = value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .ok_or_else(|| format!("instance.{field} must be a non-empty string"))?
                .to_owned();
            instance.insert(field.into(), json!(trimmed));
        }
    }
    if instance
        .get("enabled")
        .is_some_and(|enabled| !enabled.is_boolean())
    {
        return Err("instance.enabled must be a boolean".into());
    }
    match instance.get("config") {
        None => {}
        Some(Value::Object(config)) => {
            for field in secrets::provider_secret_fields(&driver) {
                if let Some(value) = config.get(*field)
                    && !value.is_string()
                    && !secret_reference(value)
                {
                    return Err(format!(
                        "instance.config.{field} must be a string or a secret reference"
                    ));
                }
            }
        }
        // Drivers decode their own config: any other JSON passes as it is.
        Some(_) => {}
    }
    if let Some(environment) = instance.get_mut("environment") {
        let Value::Array(variables) = environment else {
            return Err("instance.environment must be a list".into());
        };
        for (position, variable) in variables.iter_mut().enumerate() {
            let at = format!("instance.environment[{position}]");
            let Value::Object(variable) = variable else {
                return Err(format!("{at} must be an object"));
            };
            let name = variable
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| environment_name(name))
                .ok_or_else(|| {
                    format!(
                        "{at}.name must be a variable name of at most \
                         {ENVIRONMENT_NAME_MAX_CHARS} letters, digits or `_`"
                    )
                })?
                .to_owned();
            variable.insert("name".into(), json!(name));
            if let Some(value) = variable.get("value")
                && !value.is_string()
                && !secret_reference(value)
            {
                return Err(format!("{at}.value must be a string or a secret reference"));
            }
            for flag in ["sensitive", "valueRedacted"] {
                if variable.get(flag).is_some_and(|value| !value.is_boolean()) {
                    return Err(format!("{at}.{flag} must be a boolean"));
                }
            }
            if variable
                .get("secret")
                .is_some_and(|secret| !secret_reference(secret))
            {
                return Err(format!("{at}.secret must be a secret reference"));
            }
        }
    }
    Ok(Value::Object(instance))
}

/// A provider slug (`PROVIDER_SLUG_PATTERN`), trimmed.
fn slug(value: &Value, field: &str) -> Result<String, String> {
    let text = value.as_str().map(str::trim).unwrap_or_default();
    let mut chars = text.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && text.chars().count() <= SLUG_MAX_CHARS;
    if valid {
        Ok(text.to_owned())
    } else {
        Err(format!(
            "{field} must be a slug of at most {SLUG_MAX_CHARS} letters, digits, `_` or `-`, \
             starting with a letter"
        ))
    }
}

/// `ENVIRONMENT_VARIABLE_NAME_PATTERN`, at most 128 characters.
fn environment_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.chars().count() <= ENVIRONMENT_NAME_MAX_CHARS
}

/// `SecretReference`: a secret provider slug and a one-line path, each trimmed and non-empty.
fn secret_reference(value: &Value) -> bool {
    let (Some(provider), Some(reference)) = (
        value.get("provider").and_then(Value::as_str).map(str::trim),
        value
            .get("reference")
            .and_then(Value::as_str)
            .map(str::trim),
    ) else {
        return false;
    };
    let mut chars = provider.chars();
    let provider_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && provider.chars().count() <= SLUG_MAX_CHARS;
    let reference_ok = !reference.is_empty()
        && reference.chars().count() <= SECRET_REFERENCE_MAX_CHARS
        && !reference.contains(['\r', '\n']);
    provider_ok && reference_ok
}
