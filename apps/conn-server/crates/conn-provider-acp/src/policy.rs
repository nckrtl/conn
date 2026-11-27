//! Whether a permission request is allowed, denied or asked (`acpPermissionDisposition` in
//! `packages/provider-acp/src/server/clientPolicy.ts`). Path checks touch the file system, so
//! the session calls [`disposition`] on a blocking thread.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::mapper::Disposition;

fn requires_approval(policy: &Value) -> bool {
    match policy.get("approvalPolicy").filter(|v| !v.is_null()) {
        None => policy["runtimeMode"] == "approval-required",
        Some(approval) => approval != "never",
    }
}

fn is_read_kind(kind: &str) -> bool {
    matches!(kind, "read" | "search" | "think")
}

fn is_mutation_kind(kind: &str) -> bool {
    matches!(kind, "edit" | "delete" | "move")
}

fn read_disposition(policy: &Value) -> Disposition {
    match policy["sandboxPolicy"]["type"].as_str() {
        None | Some("readOnly" | "workspaceWrite" | "dangerFullAccess" | "externalSandbox") => {
            Disposition::Allow
        }
        Some(_) => Disposition::Deny,
    }
}

fn resolve(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let trimmed = path;
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    let cwd = cwd.map(str::trim).filter(|c| !c.is_empty())?;
    Some(Path::new(cwd).join(trimmed))
}

/// `acpCanonicalPathForContainment`: the real path, with a missing tail kept as written.
fn canonical(path: &Path) -> Option<PathBuf> {
    let mut candidate = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&candidate) {
            Ok(real) => {
                let mut out = real;
                for part in missing.iter().rev() {
                    out.push(part);
                }
                return Some(out);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        if std::fs::symlink_metadata(&candidate).is_ok() {
            return None;
        }
        let name = candidate.file_name()?.to_owned();
        missing.push(name);
        if !candidate.pop() {
            return None;
        }
    }
}

fn within(path: &Path, root: &Path) -> bool {
    match path.strip_prefix(root) {
        Ok(rest) => !rest.components().any(|c| c == Component::ParentDir),
        Err(_) => false,
    }
}

/// Every changed path that the native call describes. An incomplete description
/// must never qualify a mutation for automatic approval.
pub(crate) fn changed_paths(call: &Value) -> Option<Vec<String>> {
    let mut paths = Vec::new();
    let mut add = |value: &Value| -> Option<()> {
        let path = value.as_str()?;
        if path.trim().is_empty()
            || path.contains('\0')
            || paths.len() >= 128
            || (!Path::new(path).is_absolute()
                && (path.starts_with('~') || path.contains([':', '\\'])))
        {
            return None;
        }
        paths.push(path.to_owned());
        Some(())
    };
    if !call["locations"].is_null() {
        for location in call["locations"].as_array()? {
            add(&location["path"])?;
        }
    }
    if !call["content"].is_null() {
        for part in call["content"].as_array()? {
            match part["type"].as_str()? {
                "content" | "terminal" => continue,
                "diff" if part["changes"].is_null() => add(&part["path"])?,
                "diff" => {
                    if !part["path"].is_null() {
                        add(&part["path"])?;
                    }
                    for change in part["changes"].as_array()? {
                        match change["operation"].as_str()? {
                            "move" => add(&change["oldPath"])?,
                            "add" | "modify" | "delete" | "copy" => (),
                            _ => return None,
                        }
                        add(&change["path"])?;
                    }
                }
                _ => return None,
            }
        }
    }
    for key in ["path", "filePath", "file_path"] {
        if !call["rawInput"][key].is_null() {
            add(&call["rawInput"][key])?;
        }
    }
    Some(paths)
}

fn workspace_write_allows(policy: &Value, locations: &[String]) -> bool {
    let cwd = policy["cwd"]
        .as_str()
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let mut roots = Vec::new();
    if let Some(cwd) = cwd
        && let Some(root) = canonical(Path::new(cwd))
    {
        roots.push(root);
    }
    for root in policy["sandboxPolicy"]["writableRoots"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            policy["workspace"]["extraRoots"]
                .as_array()
                .into_iter()
                .flatten(),
        )
    {
        if let Some(resolved) = root.as_str().and_then(|r| resolve(r, cwd))
            && let Some(root) = canonical(&resolved)
        {
            roots.push(root);
        }
    }
    if roots.is_empty() || locations.is_empty() {
        return false;
    }
    locations.iter().all(|location| {
        resolve(location, cwd)
            .and_then(|p| canonical(&p))
            .is_some_and(|p| roots.iter().any(|root| within(&p, root)))
    })
}

/// `acpOperationDisposition` for a tool kind and its locations under a runtime policy
/// (`ProviderAdapterV2RuntimePolicy` as JSON).
pub(crate) fn disposition(policy: &Value, kind: Option<&str>, locations: &[String]) -> Disposition {
    let kind = kind.unwrap_or("other");
    if is_read_kind(kind) {
        return read_disposition(policy);
    }
    if requires_approval(policy) {
        return Disposition::Ask;
    }
    match policy["sandboxPolicy"]["type"].as_str() {
        Some("readOnly") => Disposition::Deny,
        Some("workspaceWrite") => {
            if is_mutation_kind(kind) && workspace_write_allows(policy, locations) {
                Disposition::Allow
            } else {
                Disposition::Deny
            }
        }
        Some("dangerFullAccess" | "externalSandbox") => Disposition::Allow,
        None => {
            if policy["runtimeMode"] == "approval-required" {
                Disposition::Deny
            } else if policy["runtimeMode"] == "auto-accept-edits"
                && policy.get("approvalPolicy").is_none_or(Value::is_null)
                && !(is_mutation_kind(kind) && workspace_write_allows(policy, locations))
            {
                Disposition::Ask
            } else {
                Disposition::Allow
            }
        }
        Some(_) => Disposition::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn follows_the_ts_rules() {
        let full = json!({"runtimeMode": "full-access", "cwd": "/tmp"});
        assert_eq!(
            disposition(&full, Some("edit"), &[]),
            Disposition::Allow,
            "full access"
        );
        let ask = json!({"runtimeMode": "approval-required", "cwd": "/tmp"});
        assert_eq!(
            disposition(&ask, Some("edit"), &[]),
            Disposition::Ask,
            "supervised"
        );
        assert_eq!(
            disposition(&ask, Some("read"), &[]),
            Disposition::Allow,
            "reads never ask"
        );
        let never = json!({"runtimeMode": "approval-required", "approvalPolicy": "never", "sandboxPolicy": {"type": "readOnly"}});
        assert_eq!(
            disposition(&never, Some("edit"), &[]),
            Disposition::Deny,
            "read-only sandbox"
        );
        let edits = json!({"runtimeMode": "auto-accept-edits", "cwd": "/tmp"});
        assert_eq!(
            disposition(&edits, Some("execute"), &[]),
            Disposition::Ask,
            "edits only"
        );
        let dir = std::env::temp_dir().join(format!("acp-policy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ws = json!({"runtimeMode": "full-access", "approvalPolicy": "never", "cwd": dir.to_str(), "sandboxPolicy": {"type": "workspaceWrite", "writableRoots": []}});
        let edit_policy = json!({"runtimeMode":"auto-accept-edits","cwd":dir});
        assert_eq!(
            disposition(&edit_policy, Some("edit"), &["new.txt".into()]),
            Disposition::Allow
        );
        assert_eq!(
            disposition(&edit_policy, Some("edit"), &[]),
            Disposition::Ask
        );
        let paths = changed_paths(&json!({"content":[{"type":"diff","changes":[{"operation":"move","oldPath":"before","path":"../other"}]}]})).unwrap();
        assert_eq!(
            disposition(&edit_policy, Some("move"), &paths),
            Disposition::Ask
        );
        assert!(changed_paths(&json!({"locations":[{"path":"known"},{}]})).is_none());
        let inside = dir.join("new/file.txt").display().to_string();
        assert_eq!(
            disposition(&ws, Some("edit"), &[inside]),
            Disposition::Allow,
            "inside the workspace"
        );
        assert_eq!(
            disposition(&ws, Some("edit"), &["/etc/x".into()]),
            Disposition::Deny,
            "outside"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
