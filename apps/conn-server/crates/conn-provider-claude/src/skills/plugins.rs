//! Resolve the CLI's inline, installed and account-synced plugin roots, in load order.

use super::{Root, Settings, files, json_file};
use crate::{launch, launch_args};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

pub(super) fn repo_root(cwd: &Path) -> Option<&Path> {
    cwd.ancestors().find(|d| d.join(".git").exists())
}

fn plugin_repo(cwd: &Path) -> Option<PathBuf> {
    let root = repo_root(cwd)?;
    let git = root.join(".git");
    let linked = || {
        let link = std::fs::read_to_string(&git).ok()?;
        let dir = root
            .join(link.trim().strip_prefix("gitdir:")?.trim())
            .canonicalize()
            .ok()?;
        let common = dir
            .join(std::fs::read_to_string(dir.join("commondir")).ok()?.trim())
            .canonicalize()
            .ok()?;
        let back = dir
            .join(std::fs::read_to_string(dir.join("gitdir")).ok()?.trim())
            .canonicalize()
            .ok()?;
        if dir.parent()? != common.join("worktrees") || back != git.canonicalize().ok()? {
            return None;
        }
        Some(if common.ends_with(".git") {
            common.parent()?.to_owned()
        } else {
            common
        })
    };
    linked().or_else(|| Some(root.to_owned()))
}

fn add(roots: &mut Vec<Root>, dir: &Path, scope: &'static str, prefix: &str, manifest: &Value) {
    let mut push = |path| {
        roots.push(Root {
            path,
            scope,
            prefix: Some(prefix.to_owned()),
        })
    };
    let default = dir.join("skills");
    if default.is_dir() {
        push(default);
    } else if manifest["skills"].is_null() && dir.join("SKILL.md").is_file() {
        push(dir.to_owned());
    }
    let Ok(base) = dir.canonicalize() else { return };
    for entry in manifest["skills"].as_str().into_iter().chain(
        manifest["skills"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str),
    ) {
        let path = dir.join(entry);
        if path.canonicalize().is_ok_and(|p| p.starts_with(&base)) {
            push(path);
        }
    }
}

fn manifest(dir: &Path) -> Value {
    json_file(&dir.join(".claude-plugin/plugin.json"))
}

fn inline_dirs(args: &str) -> Vec<PathBuf> {
    let mut args = launch_args::tokenize(args)
        .into_iter()
        .take_while(|a| a != "--")
        .peekable();
    let mut dirs = Vec::new();
    while let Some(arg) = args.next() {
        if let Some(dir) = arg.strip_prefix("--plugin-dir=").filter(|s| !s.is_empty()) {
            dirs.push(dir.into());
        } else if arg == "--plugin-dir"
            && args.peek().is_some_and(|s| !s.starts_with("--"))
            && let Some(dir) = args.next()
        {
            dirs.push(dir.into());
        }
    }
    dirs
}

fn inline_installations(path: PathBuf) -> Vec<PathBuf> {
    if [".claude-plugin/plugin.json", "skills", "SKILL.md"]
        .iter()
        .any(|part| path.join(part).exists())
    {
        vec![path]
    } else {
        files(&path)
            .into_iter()
            .filter(|p| p.join(".claude-plugin/plugin.json").is_file())
            .collect()
    }
}

fn account_bucket(
    config: &Path,
    custom_home: bool,
    env: &HashMap<String, String>,
) -> Option<String> {
    let profile = if custom_home {
        config.join(".claude.json")
    } else {
        config.parent()?.join(".claude.json")
    };
    let account = &json_file(&profile)["oauthAccount"];
    let uuid = |s: &str| {
        s.len() == 36
            && s.bytes().enumerate().all(|(i, c)| {
                if matches!(i, 8 | 13 | 18 | 23) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    };
    let org = env
        .get("CLAUDE_CODE_ORGANIZATION_UUID")
        .map(String::as_str)
        .or_else(|| account["organizationUuid"].as_str())
        .filter(|s| uuid(s))?;
    let id = if account.is_object()
        && !env
            .get("CLAUDE_CODE_OAUTH_TOKEN")
            .is_some_and(|v| !v.is_empty())
    {
        account["accountUuid"].as_str().filter(|s| uuid(s))?
    } else {
        env.get("CLAUDE_CODE_ACCOUNT_UUID")
            .map(String::as_str)
            .filter(|s| uuid(s))
            .unwrap_or("unbound")
    };
    Some(format!("{}_{}", org.to_lowercase(), id.to_lowercase()))
}

pub(super) fn roots(
    config: &Path,
    custom_home: bool,
    cwd: Option<&Path>,
    args: &str,
    env: &HashMap<String, String>,
    settings: &Settings,
) -> Vec<Root> {
    let mut roots = Vec::new();
    let mut inline_names = HashSet::new();
    let mut seen = HashSet::new();
    let base = cwd.unwrap_or_else(|| Path::new("."));
    let declared = inline_dirs(args)
        .into_iter()
        .filter(|p| cwd.is_some() || p.is_absolute())
        .map(|p| base.join(p));
    let env_dirs = settings
        .plugin_dirs
        .as_ref()
        .or_else(|| env.get("CLAUDE_CODE_PLUGIN_DIRS"))
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|dir| launch::expand_home(dir.to_string_lossy().trim()))
        .filter(|p| p.is_absolute());
    for dir in declared.chain(env_dirs).flat_map(inline_installations) {
        if !seen.insert(dir.clone()) {
            continue;
        }
        let manifest = manifest(&dir);
        let Some(prefix) = manifest["name"]
            .as_str()
            .or_else(|| dir.file_name()?.to_str())
        else {
            continue;
        };
        if settings.managed_plugins.contains(&prefix.to_lowercase())
            || !settings
                .plugins
                .get(&format!("{prefix}@inline"))
                .copied()
                .unwrap_or(manifest["defaultEnabled"] != false)
        {
            continue;
        }
        inline_names.insert(prefix.to_lowercase());
        add(&mut roots, &dir, "user", prefix, &manifest);
    }
    let cache = env
        .get("CLAUDE_CODE_PLUGIN_CACHE_DIR")
        .filter(|s| !s.is_empty())
        .map_or_else(
            || config.join("plugins"),
            |p| base.join(launch::expand_home(p)),
        );
    let installed = json_file(&cache.join("installed_plugins.json"));
    let workspace = cwd.map(|p| p.canonicalize().unwrap_or_else(|_| p.to_owned()));
    let repository = workspace.as_deref().and_then(plugin_repo);
    let mut project_repos = HashMap::new();
    let mut claimed = inline_names.clone();
    for (key, entries) in installed["plugins"].as_object().into_iter().flatten() {
        if settings.plugins.get(key) != Some(&true) {
            continue;
        }
        let applicable = entries
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| match row["scope"].as_str() {
                Some("user" | "managed") => true,
                Some("project" | "local") => row["projectPath"]
                    .as_str()
                    .zip(workspace.as_deref())
                    .is_some_and(|(project, ws)| {
                        Path::new(project) == ws
                            || repository.is_some()
                                && project_repos
                                    .entry(project.to_owned())
                                    .or_insert_with(|| plugin_repo(Path::new(project)))
                                    == &repository
                    }),
                _ => false,
            });
        let Some((scope, dir)) = applicable
            .filter_map(|row| {
                let dir = base.join(row["installPath"].as_str()?);
                let scope = match row["scope"].as_str()? {
                    "user" | "managed" => "user",
                    _ => "project",
                };
                dir.is_dir().then_some((scope, dir))
            })
            .next()
        else {
            continue;
        };
        let manifest = manifest(&dir);
        let Some(prefix) = manifest["name"]
            .as_str()
            .or_else(|| key.split('@').next())
            .filter(|p| !p.is_empty())
        else {
            continue;
        };
        if inline_names.contains(&prefix.to_lowercase()) {
            continue;
        }
        claimed.insert(prefix.to_lowercase());
        add(&mut roots, &dir, scope, prefix, &manifest);
    }
    let synced = config.join("plugins/synced");
    if settings.hide_synced || !synced.is_dir() {
        return roots;
    }
    let Some(bucket) = account_bucket(config, custom_home, env) else {
        return roots;
    };
    if !synced.join(format!(".bucket-{bucket}")).exists() {
        return roots;
    }
    let base = synced.join(bucket);
    let synced = json_file(&base.join("manifest.json"));
    let disabled: HashSet<_> = settings
        .plugins
        .iter()
        .filter_map(|(k, v)| {
            (!v).then(|| k.strip_suffix("@synced").map(str::to_lowercase))
                .flatten()
        })
        .collect();
    for row in synced["plugins"].as_array().into_iter().flatten() {
        let Some(name) = row["name"].as_str().filter(|_| row["pluginId"].is_string()) else {
            continue;
        };
        let directory = name.replace(['<', '>', ':', '"', '|', '?', '*', '\\', '/'], "_");
        let directory = directory.trim_end_matches(['.', ' ']);
        if directory.is_empty() || directory.starts_with('.') {
            continue;
        }
        let dir = match row["generation"].as_u64().filter(|n| *n >= 2) {
            Some(n) => base.join(format!("{directory}~g{n}")),
            None => base.join(directory),
        };
        let manifest = manifest(&dir);
        let prefix = manifest["name"].as_str().unwrap_or(directory);
        let key = prefix.to_lowercase();
        if disabled.contains(&key) || !claimed.insert(key) {
            continue;
        }
        add(&mut roots, &dir, "user", prefix, &manifest);
    }
    roots
}
