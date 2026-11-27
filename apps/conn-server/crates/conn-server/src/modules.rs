//! Optional modules: the parts of the server that one process may leave out.
//!
//! One binary goes to every Orbit container, so a container picks its modules at start.
//! `CONN_SERVER_MODULES` lists them by name, with commas. Unset, every module is on, as before
//! the list existed. Set and empty, none is on: a bare server. A module that is off builds
//! nothing, registers nothing, starts nothing and advertises nothing.

use std::sync::OnceLock;

/// The variable that lists the enabled modules.
pub const VAR: &str = "CONN_SERVER_MODULES";

/// The browser: the Chrome on this machine and the desktop tab relay (`conn_preview`).
pub const BROWSER: &str = "browser";

/// Device hosts: simulators on this machine or on a Mac over SSH (`conn_devices`).
pub const DEVICES: &str = "devices";

/// Every module this build holds.
const NAMES: &[&str] = &[BROWSER, DEVICES];

/// Whether this process serves the module `name`.
pub fn on(name: &str) -> bool {
    enabled().contains(&name)
}

/// The enabled modules, read from [`VAR`] once: the list cannot change while the server runs.
fn enabled() -> &'static [&'static str] {
    static ENABLED: OnceLock<Vec<&'static str>> = OnceLock::new();
    ENABLED.get_or_init(|| {
        let Some(listed) = std::env::var_os(VAR) else {
            return NAMES.to_vec();
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

/// The modules of [`NAMES`] that `listed` names, and the names it holds that are none of them.
/// An unknown name is skipped, not refused, so one list serves an older and a newer binary.
fn select(listed: &str) -> (Vec<&'static str>, Vec<&str>) {
    let listed: Vec<&str> = listed
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    let enabled = NAMES
        .iter()
        .copied()
        .filter(|name| listed.contains(name))
        .collect();
    let unknown = listed
        .into_iter()
        .filter(|name| !NAMES.contains(name))
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
}
