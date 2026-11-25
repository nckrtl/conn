//! Native Claude skills. The first root providing a name wins, as in ClaudeSkills.ts.
use crate::{
    launch::{self, ClaudeConfig},
    launch_args,
};
use conn_provider_support::skill_mentions::{is_currency, is_skill_name};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
};

mod plugins;

struct Root {
    path: PathBuf,
    scope: &'static str,
    prefix: Option<String>,
}

#[derive(Default)]
struct Settings {
    overrides: HashMap<String, String>,
    plugins: HashMap<String, bool>,
    managed_plugins: HashSet<String>,
    plugin_dirs: Option<String>,
    hide_synced: bool,
}

fn text_file(path: &Path, limit: u64) -> Option<String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = options.open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub(super) fn json_file(path: &Path) -> Value {
    text_file(path, 16 * 1024 * 1024)
        .and_then(|text| conn_support::json::parse_lenient(&text))
        .unwrap_or_default()
}

fn files(path: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    entries.sort();
    entries
}

/// User, project, then local settings, in increasing precedence.
pub(super) fn settings_paths(home: &Path, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![home.join("settings.json")];
    if let Some(cwd) = cwd {
        paths.push(cwd.join(".claude/settings.json"));
        paths.push(cwd.join(".claude/settings.local.json"));
        if let Some(root) = plugins::plugin_repo(cwd).filter(|root| {
            !cfg!(windows)
                && *root != cwd
                && root.join(".git").exists()
                && std::env::var_os("HOME").as_deref() != Some(root.as_os_str())
        }) {
            paths.push(root.join(".claude/settings.local.json"));
        }
    }
    paths
}

fn settings(home: &Path, cwd: Option<&Path>, managed: Option<&Path>) -> Settings {
    let mut settings = Settings::default();
    let shared = cwd.map(|p| p.join(".claude/settings.json"));
    let mut paths = settings_paths(home, cwd);
    paths.extend(managed.map(Path::to_owned));
    for path in paths {
        let json = json_file(&path);
        let overrides = &json["skillOverrides"];
        // Claude drops the whole settings record on an unknown override mode.
        if !overrides.is_null()
            && !overrides.as_object().is_some_and(|entries| {
                entries.values().all(|v| {
                    matches!(
                        v.as_str(),
                        Some("on" | "off" | "user-invocable-only" | "name-only")
                    )
                })
            })
        {
            continue;
        }
        for (name, value) in overrides.as_object().into_iter().flatten() {
            if let Some(mode) = value.as_str() {
                settings.overrides.insert(name.clone(), mode.to_owned());
            }
        }
        for (name, value) in json["enabledPlugins"].as_object().into_iter().flatten() {
            if let Some(enabled) = value.as_bool() {
                settings.plugins.insert(name.clone(), enabled);
                if Some(path.as_path()) == managed
                    && let Some((name, _)) = name.split_once('@')
                {
                    settings.managed_plugins.insert(name.to_lowercase());
                }
            } else {
                settings.plugins.remove(name);
            }
        }
        if (path == home.join("settings.json") || Some(path.as_path()) == managed)
            && let Some(dirs) = json["env"]["CLAUDE_CODE_PLUGIN_DIRS"].as_str()
        {
            settings.plugin_dirs = Some(dirs.to_owned());
        }
        settings.hide_synced |=
            shared.as_ref() != Some(&path) && json["syncClaudeAiPlugins"] == false;
    }
    settings
}

fn skill_file(path: &Path) -> Option<Value> {
    let header = text_file(path, 64 * 1024)?;
    let mut skill = json!({"path":path,"enabled":true});
    let mut lines = header.lines();
    if lines.next() == Some("---") {
        let mut lines = lines.take_while(|s| s.trim_end() != "---").peekable();
        while let Some(line) = lines.next() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let raw = value.trim();
            let value = if raw.starts_with(['>', '|']) {
                let mut parts = Vec::new();
                while lines
                    .peek()
                    .is_some_and(|l| l.starts_with(' ') || l.trim().is_empty())
                {
                    parts.push(lines.next()?.trim());
                }
                parts
                    .join(if raw.starts_with('|') { "\n" } else { " " })
                    .trim()
                    .to_owned()
            } else if raw.starts_with('"') || raw.starts_with('\'') {
                raw.trim_matches(['\'', '"']).to_owned()
            } else {
                raw.split_once(" #")
                    .map_or(raw, |(v, _)| v)
                    .trim_end()
                    .to_owned()
            };
            match key {
                "description" | "name" if !value.is_empty() => skill[key] = json!(value),
                "disable-model-invocation"
                    if matches!(
                        value.to_ascii_lowercase().as_str(),
                        "true" | "yes" | "on" | "y" | "1"
                    ) =>
                {
                    skill["userInvocationOnly"] = json!(true)
                }
                "user-invocable"
                    if matches!(
                        value.to_ascii_lowercase().as_str(),
                        "false" | "no" | "off" | "n" | "0"
                    ) =>
                {
                    skill["userInvocable"] = json!(false)
                }
                _ => {}
            }
        }
    }
    Some(skill)
}

pub(super) fn discover(config: &ClaudeConfig, cwd: Option<&Path>) -> Vec<Value> {
    let mut env: HashMap<_, _> = conn_support::login_env::child_env().into_iter().collect();
    env.extend(config.instance_env.0.iter().cloned());
    let config_env = env
        .get("CLAUDE_CONFIG_DIR")
        .filter(|p| !p.trim().is_empty());
    let custom_home = config.home_path.is_some() || config_env.is_some();
    let home = config
        .home_path
        .clone()
        .or_else(|| config_env.map(|p| launch::expand_home(p)))
        .unwrap_or_else(|| launch::expand_home("~/.claude"));
    let base = cwd.unwrap_or_else(|| Path::new("."));
    let home = base.join(home);
    let managed = launch::managed_settings_path();
    let settings = settings(&home, cwd, managed.as_deref());
    let mut roots = Vec::new();
    let mut push = |path, scope| {
        roots.push(Root {
            path,
            scope,
            prefix: None,
        })
    };
    if let Some(dir) = managed.as_deref().and_then(Path::parent) {
        push(dir.join(".claude/skills"), "user");
    }
    push(home.join("skills"), "user");
    if let Some(cwd) = cwd {
        push(cwd.join(".claude/skills"), "project");
    }
    for dir in launch_args::add_dirs(&config.launch_args)
        .into_iter()
        .filter(|dir| cwd.is_some() || Path::new(dir).is_absolute())
    {
        push(base.join(dir).join(".claude/skills"), "project");
    }
    roots.extend(plugins::roots(
        &home,
        custom_home,
        cwd,
        &config.launch_args,
        &env,
        &settings,
    ));
    let mut found = BTreeMap::new();
    for root in roots {
        let single = root.prefix.is_some() && root.path.join("SKILL.md").is_file();
        for dir in if single {
            vec![root.path.clone()]
        } else {
            files(&root.path)
        } {
            let Some(entry) = dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some(mut skill) = skill_file(&dir.join("SKILL.md")) else {
                continue;
            };
            let name = if let Some(prefix) = root.prefix.as_ref() {
                let declared = single
                    .then(|| skill["name"].as_str())
                    .flatten()
                    .unwrap_or(entry);
                let declared = declared
                    .strip_prefix(&format!("{prefix}:"))
                    .unwrap_or(declared);
                let name = format!(
                    "{prefix}:{}",
                    declared.replace(
                        |c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-')),
                        "-"
                    )
                );
                if !is_skill_name(&name) {
                    continue;
                }
                name
            } else {
                match settings.overrides.get(entry).map(String::as_str) {
                    Some("off") => skill["enabled"] = json!(false),
                    Some("user-invocable-only") => skill["userInvocationOnly"] = json!(true),
                    _ => {}
                }
                entry.to_owned()
            };
            skill["name"] = json!(name);
            skill["scope"] = json!(root.scope);
            found.entry(name).or_insert(skill);
        }
    }
    found.into_values().collect()
}

pub(super) fn has_mention(text: &str) -> bool {
    text.split_whitespace().any(|word| {
        word.chars()
            .next()
            .is_some_and(|sigil| is_currency(sigil) && is_skill_name(&word[sigil.len_utf8()..]))
    })
}

pub(super) fn dispatch(text: &str, skills: &[Value]) -> Option<(Option<String>, String)> {
    let mut mentions = Vec::new();
    for (at, c) in text.char_indices() {
        if !is_currency(c) || at != 0 && !text[..at].ends_with(char::is_whitespace) {
            continue;
        }
        let start = at + c.len_utf8();
        let name = text[start..]
            .split(char::is_whitespace)
            .next()
            .unwrap_or_default();
        if !is_skill_name(name) {
            continue;
        }
        if let Some(skill) = skills
            .iter()
            .find(|s| s["name"] == name && s["enabled"] == true && s["userInvocable"] != false)
        {
            mentions.push((at, start + name.len(), name, skill));
        }
    }
    let &(last, tail, name, _) = mentions.last()?;
    let mut seen = HashSet::from([name]);
    let mut full = String::new();
    let mut cursor = 0;
    for (at, end, name, skill) in mentions {
        full.push_str(text.get(cursor..at)?);
        full.push('/');
        full.push_str(name);
        if skill["userInvocationOnly"] == true
            && seen.insert(name)
            && let Some(path) = skill["path"].as_str()
        {
            full.push_str(&format!(
                " [The user invoked this skill. Follow the instructions at: {path}]"
            ));
        }
        cursor = end;
    }
    full.push_str(text.get(cursor..)?);
    Some((
        (!text.get(..last)?.trim().is_empty()).then(|| full.trim_end().to_owned()),
        format!("/{name}{}", text.get(tail..)?)
            .trim_end()
            .to_owned(),
    ))
}

pub(super) async fn list(config: ClaudeConfig, cwd: Option<String>) -> Vec<Value> {
    tokio::task::spawn_blocking(move || discover(&config, cwd.as_deref().map(Path::new)))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinct_profiles_and_workspaces_use_only_their_enabled_plugin_skills() {
        let root = std::env::temp_dir().join(format!("conn-plugin-{}", conn_support::uuid_v4()));
        let home = root.join("home");
        let project = root.join("project");
        let other = root.join("other");
        let user = home.join("skills/regular");
        let inline = project.join("injected/custom");
        let installed = home.join("plugins/cache/pkg/skills/song");
        for dir in [&user, &inline, &installed] {
            std::fs::create_dir_all(dir).unwrap();
        }
        for dir in [&project, &other] {
            std::fs::create_dir_all(dir.join(".claude")).unwrap();
        }
        std::fs::create_dir_all(project.join("injected/.claude-plugin")).unwrap();
        std::fs::write(user.join("SKILL.md"), "regular").unwrap();
        std::fs::write(
            inline.join("SKILL.md"),
            "---\nname: act\ndisable-model-invocation: yes\n---\n",
        )
        .unwrap();
        std::fs::write(installed.join("SKILL.md"), "installed").unwrap();
        std::fs::write(
            project.join("injected/.claude-plugin/plugin.json"),
            r#"{"name":"inline","skills":"custom"}"#,
        )
        .unwrap();
        std::fs::write(
            project.join(".claude/settings.local.json"),
            r#"{"skillOverrides":{"regular":"off"}, "enabledPlugins":{"music@market":true}}"#,
        )
        .unwrap();
        std::fs::write(home.join("plugins/installed_plugins.json"),json!({"plugins":{"music@market":[{"scope":"local","projectPath":project.canonicalize().unwrap(), "installPath":home.join("plugins/cache/pkg")}]}}).to_string()).unwrap();
        let config = ClaudeConfig {
            home_path: Some(home),
            launch_args: "--plugin-dir injected".into(),
            ..Default::default()
        };
        let found = discover(&config, Some(&project));
        assert!(
            found
                .iter()
                .any(|s| s["name"] == "music:song" && s["scope"] == "project")
        );
        assert!(
            found
                .iter()
                .any(|s| s["name"] == "regular" && s["enabled"] == false)
        );
        assert_eq!(
            dispatch("€inline:act exact $", &found),
            Some((None, "/inline:act exact $".into()))
        );
        let other = discover(&config, Some(&other));
        assert!(
            other
                .iter()
                .all(|s| s["name"] != "music:song" && s["name"] != "inline:act")
        );
        assert!(
            other
                .iter()
                .any(|s| s["name"] == "regular" && s["enabled"] == true)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_project_skill_becomes_the_final_command_block() {
        let root = std::env::temp_dir().join(format!("conn-skill-{}", conn_support::uuid_v4()));
        let skill = root.join(".claude/skills/review");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\ndisable-model-invocation: true\ndescription: Review a patch\n---\n",
        )
        .unwrap();
        let found = discover(
            &ClaudeConfig {
                home_path: Some(root.join("home")),
                ..Default::default()
            },
            Some(&root),
        );
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(found[0]["userInvocationOnly"], true);
        assert_eq!(
            dispatch("$review some arguments", &found),
            Some((None, "/review some arguments".into()))
        );
        assert_eq!(
            dispatch("Use $review here", &found),
            Some((Some("Use /review here".into()), "/review here".into()))
        );
    }
}
