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

use std::{
    io,
    path::{Path, PathBuf},
};

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
        // The batch passes. Every save loads first, and that load writes its migrations; the
        // snapshot lets any later failure undo them with the batch's own writes, so a failed
        // batch leaves the file, the store and the running settings as they were.
        let snapshot = Snapshot::take(&self.path, &self.secrets_dir)
            .map_err(|error| BatchError::Failed(self.error("read-file", error.to_string())))?;
        let result = self.commit(mutations);
        if result.is_err() {
            snapshot.restore(&self.path, &self.secrets_dir);
        }
        result
    }

    fn commit(&self, mutations: Vec<Value>) -> Result<Value, BatchError> {
        let failed = |operation: &'static str, detail: String| {
            BatchError::Failed(self.error(operation, detail))
        };
        let seen = self.lock().materialized.clone();
        let (loaded, failure, retry) = super::load(&self.path, &self.secrets_dir);
        if let Some(detail) = failure {
            return Err(failed("read-file", detail));
        }
        // `load` serves the markers when a stored secret cannot be read; a save never installs
        // that over the credentials the server runs with.
        let dir = &self.secrets_dir;
        let materialized = secrets::materialize(dir, &served(&loaded.doc))
            .map_err(|(_, error)| failed("read-secret", error.to_string()))?;
        let (staged, changes) = stage(&loaded.doc, mutations)?;
        let store_unchanged = changes.iter().all(|change| {
            secret_store::read(dir, &change.name).is_ok_and(|stored| stored == change.write)
        });
        if staged == loaded.doc && store_unchanged {
            // Nothing to write. The registry reconciles on a revision, so one is published
            // when the served settings differ from what it last saw (an edit on disk).
            let changed = materialized != seen;
            self.install(loaded.doc, materialized, retry);
            if changed {
                self.revision.send_modify(|r| *r += 1);
            }
            return Ok(self.for_client());
        }
        secrets::apply(dir, &changes)
            .map_err(|(operation, error)| failed(operation, error.to_string()))?;
        let materialized = secrets::materialize(dir, &served(&staged))
            .map_err(|(_, error)| failed("read-secret", error.to_string()))?;
        write_settings(&self.path, &staged).map_err(|error| failed("write-file", error))?;
        self.install(staged, materialized, retry);
        self.revision.send_modify(|r| *r += 1);
        Ok(self.for_client())
    }

    /// The settings the server runs with, and the retry flag of the load they came from:
    /// both change together, only once the batch is saved.
    fn install(&self, doc: Map<String, Value>, materialized: Map<String, Value>, retry: bool) {
        *self.lock() = Loaded { doc, materialized };
        self.retry
            .store(retry, std::sync::atomic::Ordering::Relaxed);
    }
}

/// The settings file and the secret store as they were before a batch's writes.
struct Snapshot {
    file: Option<Vec<u8>>,
    secrets: Vec<(PathBuf, Vec<u8>)>,
}

impl Snapshot {
    fn take(path: &Path, dir: &Path) -> io::Result<Self> {
        let file = match std::fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let mut secrets = Vec::new();
        for path in secret_files(dir)? {
            let bytes = std::fs::read(&path)?;
            secrets.push((path, bytes));
        }
        Ok(Self { file, secrets })
    }

    /// Puts both back; a step that fails is logged by path, never with a value.
    fn restore(self, path: &Path, dir: &Path) {
        let mut failed: Vec<PathBuf> = Vec::new();
        for current in secret_files(dir).unwrap_or_default() {
            if !self.secrets.iter().any(|(kept, _)| *kept == current)
                && std::fs::remove_file(&current).is_err()
            {
                failed.push(current);
            }
        }
        for (kept, bytes) in &self.secrets {
            if std::fs::read(kept).ok().as_ref() != Some(bytes)
                && conn_support::fs::write_private(kept, bytes).is_err()
            {
                failed.push(kept.clone());
            }
        }
        let file = match &self.file {
            Some(bytes) => conn_support::fs::resolve_symlink_target(path)
                .and_then(|target| conn_support::fs::write_private(&target, bytes)),
            None => std::fs::remove_file(path).or_else(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            }),
        };
        if file.is_err() {
            failed.push(path.to_owned());
        }
        for path in failed {
            eprintln!(
                "conn-server: failed to restore {} after a refused provider-instance batch",
                path.display()
            );
        }
    }
}

/// The `<name>.bin` files of the secret store; none when the folder does not exist.
fn secret_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut files = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_some_and(|extension| extension == "bin") && path.is_file() {
            files.push(path);
        }
    }
    Ok(files)
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
                .map(super::contract_trim)
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
    match instance.get_mut("config") {
        None => {}
        Some(Value::Object(config)) => {
            for field in secrets::provider_secret_fields(&driver) {
                if let Some(value) = config.get_mut(*field) {
                    secret_value(value).map_err(|()| {
                        format!("instance.config.{field} must be a string or a secret reference")
                    })?;
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
                .map(super::contract_trim)
                .filter(|name| environment_name(name))
                .ok_or_else(|| {
                    format!(
                        "{at}.name must be a variable name of at most \
                         {ENVIRONMENT_NAME_MAX_CHARS} letters, digits or `_`"
                    )
                })?
                .to_owned();
            variable.insert("name".into(), json!(name));
            if let Some(value) = variable.get_mut("value") {
                secret_value(value)
                    .map_err(|()| format!("{at}.value must be a string or a secret reference"))?;
            }
            for flag in ["sensitive", "valueRedacted"] {
                if variable.get(flag).is_some_and(|value| !value.is_boolean()) {
                    return Err(format!("{at}.{flag} must be a boolean"));
                }
            }
            if let Some(secret) = variable.get_mut("secret") {
                *secret = secret_reference(secret)
                    .ok_or_else(|| format!("{at}.secret must be a secret reference"))?;
            }
        }
    }
    Ok(Value::Object(instance))
}

/// A provider slug (`PROVIDER_SLUG_PATTERN`), trimmed.
fn slug(value: &Value, field: &str) -> Result<String, String> {
    let text = value.as_str().map(super::contract_trim).unwrap_or_default();
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

/// A secret slot's value: a string as it is, or a valid reference stored in its canonical form.
fn secret_value(value: &mut Value) -> Result<(), ()> {
    if value.is_string() {
        return Ok(());
    }
    *value = secret_reference(value).ok_or(())?;
    Ok(())
}

/// `SecretReference`, as the contract decodes it: a secret provider slug and a one-line path,
/// each trimmed and non-empty, lengths in UTF-16 units as JavaScript counts them. Returns the
/// trimmed reference to store.
fn secret_reference(value: &Value) -> Option<Value> {
    let provider = super::contract_trim(value.get("provider")?.as_str()?);
    let reference = super::contract_trim(value.get("reference")?.as_str()?);
    let mut chars = provider.chars();
    let provider_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && provider.len() <= SLUG_MAX_CHARS;
    let reference_ok = !reference.is_empty()
        && reference.encode_utf16().count() <= SECRET_REFERENCE_MAX_CHARS
        && !reference.contains(['\r', '\n']);
    (provider_ok && reference_ok).then(|| json!({ "provider": provider, "reference": reference }))
}
