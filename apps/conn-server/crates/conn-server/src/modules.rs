//! Optional modules: the parts of the server that one process may leave out.
//!
//! One binary goes to every Orbit container, so a container picks its modules at start.
//! `CONN_SERVER_MODULES` lists them by name, with commas. Unset, every module is on, as before
//! the list existed. Set and empty, none is on: a bare server. A module that is off builds
//! nothing, registers nothing, starts nothing and advertises nothing.
//!
//! [`ALL`] is the one list of modules. A [`Module`] entry carries the whole module. The browser
//! and the device hosts have no entry: [`GUARDED`] names them and their tools, and `serve.rs`
//! guards the rest by hand.

use std::{
    path::Path,
    sync::{Arc, OnceLock},
};

use axum::Router;
use conn_contract::ExecutionEnvironmentCapabilities;
use conn_engine::{BoxFuture, Engine};

use crate::{AppState, host::Host, methods::Deps, table::MethodTable};

/// The variable that lists the enabled modules.
pub const VAR: &str = "CONN_SERVER_MODULES";

/// One optional module: all the server holds for it.
pub(crate) struct Module {
    /// Its name in [`VAR`].
    pub name: &'static str,
    /// Builds its service into `deps` and starts its jobs. A thread-close hook follows the
    /// `Host` slot it fills.
    pub start: for<'a> fn(&'a Boot<'a>, &'a mut Deps) -> BoxFuture<'a, ()>,
    /// Registers its RPC methods on the service `start` built.
    pub methods: fn(&mut MethodTable, &Deps),
    /// Its HTTP routes.
    pub routes: fn() -> Router<AppState>,
    /// Its `/mcp` tools. Off, no caller is offered them and a call finds none.
    pub tools: &'static [&'static str],
    /// Sets the capability flags that promise it.
    pub capabilities: fn(&mut ExecutionEnvironmentCapabilities),
}

/// What a module's `start` builds on.
pub(crate) struct Boot<'a> {
    pub state_dir: &'a Path,
    pub engine: &'a Arc<dyn Engine>,
    pub host: &'a Host,
}

/// Every module with an entry, in start order.
pub(crate) const ALL: &[&Module] = &[
    &crate::methods::annotations::MODULE,
    &crate::methods::scheduled::MODULE,
];

/// The browser: the Chrome on this machine and the desktop tab relay (`conn_preview`).
pub const BROWSER: &str = "browser";

/// Device hosts: simulators on this machine or on a Mac over SSH (`conn_devices`).
pub const DEVICES: &str = "devices";

/// The modules `serve.rs` guards by hand, each with the `/mcp` tools that need it.
const GUARDED: &[(&str, &[&str])] = &[
    (
        BROWSER,
        &[
            "html_preview",
            "fill_credential",
            "preview_open",
            "preview_status",
            "preview_navigate",
            "preview_resize",
            "preview_set_appearance",
            "preview_evaluate",
            "preview_dialog",
            "preview_cdp_endpoint",
            "conn_preview_close",
            "conn_preview_list",
            "preview_snapshot",
            "preview_act",
            "preview_wait_for",
            "preview_recording_start",
            "preview_recording_stop",
        ],
    ),
    (
        DEVICES,
        &[
            "device_list",
            "device_open",
            "device_screenshot",
            "device_close",
        ],
    ),
];

/// Whether this process serves the module `name`.
pub fn on(name: &str) -> bool {
    enabled().contains(&name)
}

/// The enabled modules that have an entry, in start order.
pub(crate) fn started() -> impl Iterator<Item = &'static Module> {
    ALL.iter().copied().filter(|module| on(module.name))
}

/// Starts every enabled module.
pub(crate) async fn start(boot: &Boot<'_>, deps: &mut Deps) {
    for module in started() {
        (module.start)(boot, deps).await;
    }
}

/// The `/mcp` tools of the modules that are off here.
pub fn withheld_tools() -> Vec<&'static str> {
    withheld(enabled())
}

/// Sets the capability flags of the modules in `enabled`.
pub fn capabilities(enabled: &[&str], capabilities: &mut ExecutionEnvironmentCapabilities) {
    for module in ALL.iter().filter(|module| enabled.contains(&module.name)) {
        (module.capabilities)(capabilities);
    }
}

/// Every module's name and tools: the entries, then the guarded ones.
fn known() -> impl Iterator<Item = (&'static str, &'static [&'static str])> {
    let entries = ALL.iter().map(|module| (module.name, module.tools));
    entries.chain(GUARDED.iter().copied())
}

fn withheld(enabled: &[&str]) -> Vec<&'static str> {
    known()
        .filter(|(name, _)| !enabled.contains(name))
        .flat_map(|(_, tools)| tools.iter().copied())
        .collect()
}

/// The enabled modules, read from [`VAR`] once: the list cannot change while the server runs.
pub fn enabled() -> &'static [&'static str] {
    static ENABLED: OnceLock<Vec<&'static str>> = OnceLock::new();
    ENABLED.get_or_init(|| {
        let Some(listed) = std::env::var_os(VAR) else {
            return known().map(|(name, _)| name).collect();
        };
        let listed = listed.to_string_lossy();
        let (enabled, unknown) = select(&listed);
        if !unknown.is_empty() {
            eprintln!(
                "conn-server: {VAR} names modules this build does not hold: {}",
                unknown.join(", ")
            );
        }
        let names = if enabled.is_empty() {
            "none".to_owned()
        } else {
            enabled.join(", ")
        };
        eprintln!("conn-server: modules: {names}");
        enabled
    })
}

/// The modules that `listed` names, and the names it holds that are no module of this build.
/// An unknown name is skipped, not refused, so one list serves an older and a newer binary.
fn select(listed: &str) -> (Vec<&'static str>, Vec<&str>) {
    let listed: Vec<&str> = listed
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    let enabled: Vec<&'static str> = known()
        .map(|(name, _)| name)
        .filter(|name| listed.contains(name))
        .collect();
    let unknown = listed
        .into_iter()
        .filter(|name| known().all(|(module, _)| module != *name))
        .collect();
    (enabled, unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_selects_modules_by_name() {
        assert_eq!(select(""), (vec![], vec![]));
        assert_eq!(select(" , "), (vec![], vec![]));
        assert_eq!(select("devices"), (vec![DEVICES], vec![]));
        assert_eq!(
            select(" devices ,later,browser,devices"),
            (vec![BROWSER, DEVICES], vec!["later"])
        );
    }

    #[test]
    fn a_module_that_is_off_takes_its_tools_with_it() {
        // Every tool a module names is in the catalog: a renamed tool fails here.
        for (module, tools) in known() {
            for tool in tools {
                assert!(
                    conn_mcp::tool_definition(tool).is_some(),
                    "{module}: {tool}"
                );
            }
        }
        let all: Vec<&str> = known().map(|(name, _)| name).collect();
        assert_eq!(withheld(&all), Vec::<&str>::new());
        let no_devices: Vec<&str> = all.iter().copied().filter(|n| *n != DEVICES).collect();
        assert_eq!(
            withheld(&no_devices),
            [
                "device_list",
                "device_open",
                "device_screenshot",
                "device_close"
            ]
        );
        assert!(withheld(&[]).contains(&"annotations_list"));
    }
}
