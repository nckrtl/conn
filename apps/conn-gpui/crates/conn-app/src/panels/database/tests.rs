//! Headless tests of the Database panel's empty state, toolbar and connection form, and the
//! env-gated offscreen renders of each state (`render_design_screenshots`).

use std::path::Path;

use conn_database::api::{ConnectionSource, PanelConnection, new_connection};
use conn_database::{DatabaseConnection, DatabaseDriver};
use conn_theme::Tokens;
use gpui_kit::AppContext as _;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, Bounds, Entity, Pixels, Point, TestAppContext, WindowBounds, WindowOptions,
    px, size,
};

use super::picker::{PickerRows, menu_placement, step_row};
use super::store::{DatabaseStore, name_placeholder};
use super::{DISCONNECTED, DatabasePanel};
use crate::panels::chrome;
use crate::panels::empty_state::split_lines;

const PANEL_WIDTH_PX: f32 = 520.0;
const PANEL_HEIGHT_PX: f32 = 700.0;
const PROJECT: &str = "project-1";
const NO_ENV_DESCRIPTION: &str = "This project's .env has no DB_CONNECTION. Connect a database to browse its tables and run read-only queries.";

/// What the panel starts with.
#[derive(Clone, Copy, Default)]
struct Scenario {
    env: bool,
    saved: usize,
    vault: usize,
}

/// A saved connection. `reachable_looking` ones are Postgres on a host (for the renders); the
/// others are SQLite files that do not exist, which a test can open without any network.
fn saved_connection(index: usize, reachable_looking: bool) -> PanelConnection {
    let mut connection = new_connection(None);
    connection.id = format!("manual-{index}");
    connection.name = format!("Staging {index}");
    connection.source = ConnectionSource::Manual;
    if reachable_looking {
        connection.connection.driver = DatabaseDriver::Pgsql;
        connection.connection.host = "db.staging.example".to_owned();
        connection.connection.port = Some(5432);
        connection.connection.database = "app".to_owned();
    } else {
        connection.connection.driver = DatabaseDriver::Sqlite;
        connection.connection.database = "/nonexistent/staging.sqlite".to_owned();
    }
    connection
}

fn vault_connection(index: usize) -> PanelConnection {
    PanelConnection {
        id: format!("vault:{index}"),
        name: format!("Vault database {index}"),
        source: ConnectionSource::Vault,
        connection: DatabaseConnection {
            driver: DatabaseDriver::Pgsql,
            host: "10.0.0.5".to_owned(),
            port: Some(5432),
            database: format!("orders_{index}"),
            username: "reader".to_owned(),
            password: String::new(),
            vault_item_id: Some(format!("item-{index}")),
            ssh: None,
        },
        ssh_host: None,
        organization: None,
    }
}

fn tokens_for(theme: &str) -> Tokens {
    Tokens::derive(&conn_theme::theme_by_id(theme).expect("a built-in theme"))
}

/// A project folder, with a `.env` database when `env` is set.
fn project_folder(env: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a temp dir");
    if env {
        std::fs::write(
            dir.path().join(".env"),
            "DB_CONNECTION=sqlite\nDB_DATABASE=orders.sqlite\n",
        )
        .expect("a .env file");
    }
    dir
}

/// Opens a Database panel in a headless window and fills it from `scenario`.
fn open_panel(
    cx: &mut TestAppContext,
    scenario: Scenario,
    theme: &str,
) -> (AnyWindowHandle, Entity<DatabasePanel>, tempfile::TempDir) {
    open_panel_sized(cx, scenario, theme, PANEL_HEIGHT_PX)
}

/// [`open_panel`] in a window of another height.
fn open_panel_sized(
    cx: &mut TestAppContext,
    scenario: Scenario,
    theme: &str,
    height: f32,
) -> (AnyWindowHandle, Entity<DatabasePanel>, tempfile::TempDir) {
    let folder = project_folder(scenario.env);
    let root = folder.path().to_string_lossy().into_owned();
    let tokens = tokens_for(theme);
    let (window, panel) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(PANEL_WIDTH_PX), px(height)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| DatabasePanel::new(tokens, window, cx)),
        )
        .expect("a window")
    });
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            for index in 0..scenario.saved {
                panel
                    .store
                    .save_connection(PROJECT, saved_connection(index + 1, false));
            }
            // Saving one picks it; start from nothing picked, as a fresh project.
            if scenario.saved > 0 {
                panel
                    .store
                    .by_project_key
                    .entry(PROJECT.to_owned())
                    .and_modify(|s| {
                        s.connection = None;
                    });
            }
            panel.set_project(Some(PROJECT.to_owned()), Some(root), cx);
            if scenario.vault > 0 {
                let token = panel.begin_vault_load_for_test();
                panel.finish_vault_load_for_test(
                    token,
                    (1..=scenario.vault).map(vault_connection).collect(),
                    cx,
                );
            }
        })
    });
    frames(cx, window);
    (window, panel, folder)
}

fn frames(cx: &mut TestAppContext, window: AnyWindowHandle) {
    for _ in 0..3 {
        let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
        cx.run_until_parked();
    }
}

fn bounds(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) -> Bounds<Pixels> {
    cx.update_window(window, |_, w, _| w.find(id).bounds())
        .expect("a window")
}

fn shown(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) -> bool {
    cx.update_window(window, |_, w, _| w.try_find(id).is_some())
        .expect("a window")
}

fn labelled(cx: &mut TestAppContext, window: AnyWindowHandle, label: &'static str) -> bool {
    cx.update_window(window, |_, w, _| w.try_find_by_label(label).is_some())
        .expect("a window")
}

fn click(cx: &mut TestAppContext, window: AnyWindowHandle, id: &'static str) {
    cx.update_window(window, |_, w, cx| w.click(id, cx))
        .expect("a window");
    frames(cx, window);
}

fn selected_id(cx: &mut TestAppContext, panel: &Entity<DatabasePanel>) -> Option<String> {
    cx.update(|cx| panel.read(cx).selected_connection().map(|c| c.id))
}

#[test]
fn a_description_that_needs_two_lines_gets_two_even_ones() {
    let words = vec![px(30.0); 17];
    let lines = split_lines(&words, px(4.0), px(380.0));
    assert_eq!(lines.len(), 2);
    assert!(lines[0].len().abs_diff(lines[1].len()) <= 1, "{lines:?}");
    assert_eq!(split_lines(&words[..4], px(4.0), px(380.0)).len(), 1);
    // Three lines of words wrap greedily instead.
    assert_eq!(split_lines(&[px(100.0); 12], px(4.0), px(380.0)).len(), 4);
}

#[gpui_kit::test]
fn without_env_or_vault_the_empty_state_is_a_centred_block_near_the_top(cx: &mut TestAppContext) {
    let (window, _panel, _folder) = open_panel(cx, Scenario::default(), "dark-ocean");
    let block = bounds(cx, window, "db-empty");
    let mark = bounds(cx, window, "db-empty-mark");
    assert_eq!(mark.size, size(px(40.0), px(40.0)));
    let wanted_top = 32.0_f32.max(PANEL_HEIGHT_PX * 0.08);
    assert_eq!(mark.top() - block.top(), px(wanted_top));
    assert!((mark.center().x - px(PANEL_WIDTH_PX / 2.0)).abs() < px(0.5));
    assert!(labelled(cx, window, "No database connected"));
    assert!(labelled(cx, window, NO_ENV_DESCRIPTION));
    assert!(bounds(cx, window, "db-empty-description").size.width <= px(380.0));
    assert!(shown(cx, window, "db-empty-description-0"));
    let add = bounds(cx, window, "db-empty-add");
    assert_eq!(add.size.height, px(32.0));
    assert!((add.center().x - px(PANEL_WIDTH_PX / 2.0)).abs() < px(0.5));
    assert!(add.top() > mark.bottom());
    assert!(!shown(cx, window, "db-pick"));
    // Nothing is open, so the toolbar offers Add where Refresh would be, and no Disconnect.
    assert!(shown(cx, window, "db-add-btn"));
    assert!(!shown(cx, window, "db-refresh-btn"));
    assert!(!shown(cx, window, "db-disconnect-btn"));
}

#[gpui_kit::test]
fn a_disconnected_project_with_an_env_database_lists_it_and_shows_no_empty_state(
    cx: &mut TestAppContext,
) {
    let scenario = Scenario {
        env: true,
        ..Scenario::default()
    };
    let (window, panel, _folder) = open_panel(cx, scenario, "dark-ocean");
    assert_eq!(selected_id(cx, &panel).as_deref(), Some("env"));
    assert!(!shown(cx, window, "db-pick"));
    cx.update(|cx| panel.update(cx, |panel, cx| panel.disconnect(cx)));
    frames(cx, window);
    assert!(shown(cx, window, "db-pick"));
    assert!(!shown(cx, window, "db-empty"), "a database exists");
    assert!(!labelled(cx, window, "No database connected"));
    assert!(!shown(cx, window, "db-empty-add"));
    assert!(labelled(cx, window, "Connections"));
    assert!(shown(cx, window, "db-pick-row-env"));
    assert!(!shown(cx, window, "db-pick-vault"));
}

#[gpui_kit::test]
fn the_list_starts_16px_below_the_toolbar_and_has_no_add_button(cx: &mut TestAppContext) {
    let scenario = Scenario {
        env: true,
        saved: 1,
        vault: 2,
    };
    let (window, panel, _folder) = open_panel(cx, scenario, "dark-ocean");
    cx.update(|cx| panel.update(cx, |panel, cx| panel.disconnect(cx)));
    frames(cx, window);
    let toolbar = bounds(cx, window, "db-toolbar");
    let connections = bounds(cx, window, "db-pick-connections");
    let vault = bounds(cx, window, "db-pick-vault");
    assert_eq!(connections.top() - toolbar.bottom(), px(16.0));
    assert_eq!(connections.size.width, px(300.0));
    assert_eq!(vault.size.width, px(300.0));
    assert!((connections.center().x - px(PANEL_WIDTH_PX / 2.0)).abs() < px(0.5));
    assert_eq!(vault.top() - connections.bottom(), px(16.0));
    assert!(labelled(cx, window, "Connections"));
    assert!(labelled(cx, window, "Vault"));
    assert!(!labelled(cx, window, "Or pick one from Vault"));
    // The toolbar's + adds a connection, so there is no button under the list.
    assert!(!shown(cx, window, "db-empty-add"));
    assert!(shown(cx, window, "db-add-btn"));
    for id in [
        "db-pick-row-env",
        "db-pick-row-manual-1",
        "db-pick-row-vault:1",
        "db-pick-row-vault:2",
    ] {
        let row = bounds(cx, window, id);
        assert_eq!(row.size.width, px(300.0), "{id}");
        assert_eq!(row.size.height, px(34.0), "{id}");
    }
}

#[gpui_kit::test]
fn with_only_vault_databases_the_list_has_just_the_vault_heading(cx: &mut TestAppContext) {
    let scenario = Scenario {
        vault: 1,
        ..Scenario::default()
    };
    let (window, _panel, _folder) = open_panel(cx, scenario, "dark-ocean");
    assert!(!shown(cx, window, "db-empty"));
    assert!(labelled(cx, window, "Vault"));
    assert!(!labelled(cx, window, "Or pick one from Vault"));
    assert!(!labelled(cx, window, "Connections"));
    assert!(!shown(cx, window, "db-pick-connections"));
    assert!(shown(cx, window, "db-pick-row-vault:1"));
    let toolbar = bounds(cx, window, "db-toolbar");
    let vault = bounds(cx, window, "db-pick-vault");
    assert_eq!(vault.top() - toolbar.bottom(), px(16.0));
    assert!(!shown(cx, window, "db-empty-add"));
}

#[gpui_kit::test]
fn a_locked_vault_keeps_its_unlock_row_in_the_list(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, Scenario::default(), "dark-ocean");
    assert!(shown(cx, window, "db-empty"), "nothing known yet");
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            panel.vault_status = Some(conn_desktop::vault::VaultErrorKind::Locked);
            cx.notify();
        })
    });
    frames(cx, window);
    assert!(!shown(cx, window, "db-empty"));
    assert!(labelled(cx, window, "Vault"));
    assert!(shown(cx, window, "db-pick-unlock-vault"));
    click(cx, window, "db-pick-unlock-vault");
    assert!(cx.update(|cx| panel.read(cx).allow_unlock_next));
    // An unavailable Vault holds nothing to pick, so the project is empty again.
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            panel.vault_status = Some(conn_desktop::vault::VaultErrorKind::Unavailable);
            cx.notify();
        })
    });
    frames(cx, window);
    assert!(!shown(cx, window, "db-pick-vault"));
    assert!(shown(cx, window, "db-empty"));
}

#[gpui_kit::test]
fn clicking_a_row_connects(cx: &mut TestAppContext) {
    let scenario = Scenario {
        env: true,
        saved: 1,
        vault: 1,
    };
    let (window, panel, _folder) = open_panel(cx, scenario, "dark-ocean");
    cx.update(|cx| panel.update(cx, |panel, cx| panel.disconnect(cx)));
    frames(cx, window);
    assert_eq!(selected_id(cx, &panel), None);
    click(cx, window, "db-pick-row-manual-1");
    assert_eq!(selected_id(cx, &panel).as_deref(), Some("manual-1"));
    assert!(!shown(cx, window, "db-pick"));
    assert!(shown(cx, window, "db-disconnect-btn"));
    click(cx, window, "db-disconnect-btn");
    click(cx, window, "db-pick-row-env");
    assert_eq!(selected_id(cx, &panel).as_deref(), Some("env"));
}

#[gpui_kit::test]
fn the_plus_button_and_the_empty_add_button_open_the_form(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, Scenario::default(), "dark-ocean");
    click(cx, window, "db-add-btn");
    assert!(cx.update(|cx| panel.read(cx).editing.is_some()));
    assert!(shown(cx, window, "db-connection-form"));
    assert!(shown(cx, window, "db-add-btn"), "the toolbar keeps Add");
    cx.update(|cx| panel.update(cx, |panel, cx| panel.cancel_editing(cx)));
    frames(cx, window);
    click(cx, window, "db-empty-add");
    assert!(cx.update(|cx| panel.read(cx).editing.is_some()));
}

#[gpui_kit::test]
fn disconnect_clears_the_selection_and_stays_cleared(cx: &mut TestAppContext) {
    let scenario = Scenario {
        env: true,
        ..Scenario::default()
    };
    let (window, panel, folder) = open_panel(cx, scenario, "dark-ocean");
    assert!(shown(cx, window, "db-refresh-btn"));
    assert!(!shown(cx, window, "db-add-btn"));
    let run = bounds(cx, window, "db-run-btn");
    let disconnect = bounds(cx, window, "db-disconnect-btn");
    assert_eq!(disconnect.size, size(px(32.0), px(32.0)));
    assert!(disconnect.left() >= run.right(), "after Run");
    click(cx, window, "db-disconnect-btn");
    assert_eq!(selected_id(cx, &panel), None);
    assert!(shown(cx, window, "db-pick"));
    assert!(!shown(cx, window, "db-disconnect-btn"));
    // A refresh, a reload of the `.env`, and a restart through the saved file keep it cleared.
    cx.update(|cx| panel.update(cx, |panel, cx| panel.refresh(cx)));
    frames(cx, window);
    assert_eq!(selected_id(cx, &panel), None);
    let json = cx.update(|cx| panel.read(cx).store.to_persisted_json().expect("json"));
    assert!(
        cx.update(|cx| panel.read(cx).store.remembered_connection(PROJECT) == Some(DISCONNECTED))
    );
    cx.update(|cx| {
        panel.update(cx, |panel, cx| {
            panel.store = DatabaseStore::from_persisted_json(&json).expect("a saved store");
            panel.set_project(None, None, cx);
            panel.set_project(
                Some(PROJECT.to_owned()),
                Some(folder.path().to_string_lossy().into_owned()),
                cx,
            );
        })
    });
    frames(cx, window);
    assert!(
        cx.update(|cx| panel.read(cx).env_connection.is_some()),
        "the .env database is still there"
    );
    assert_eq!(selected_id(cx, &panel), None);
    assert!(shown(cx, window, "db-pick"));
}

#[gpui_kit::test]
fn the_toolbar_is_49px_tall_with_and_without_a_connection(cx: &mut TestAppContext) {
    let (window, _panel, _folder) = open_panel(cx, Scenario::default(), "dark-ocean");
    assert_eq!(bounds(cx, window, "db-toolbar").size.height, px(49.0));
    let scenario = Scenario {
        env: true,
        ..Scenario::default()
    };
    let (window, _panel, _folder) = open_panel(cx, scenario, "dark-ocean");
    assert_eq!(bounds(cx, window, "db-toolbar").size.height, px(49.0));
    // Tasks' navigation bar is 49px; Files and the others pad their bars with 8px too.
    assert_eq!(
        chrome::CONTROL_HEIGHT_PX + 2.0 * 8.0 + 1.0,
        49.0,
        "32px control, 8px padding, 1px border"
    );
}

#[gpui_kit::test]
fn the_form_is_centred_and_spaces_its_fields_and_buttons(cx: &mut TestAppContext) {
    let (window, _panel, _folder) = open_panel(cx, Scenario::default(), "dark-ocean");
    click(cx, window, "db-add-btn");
    let form = bounds(cx, window, "db-connection-form");
    assert_eq!(form.size.width, px(420.0));
    assert!((form.center().x - px(PANEL_WIDTH_PX / 2.0)).abs() < px(0.5));
    let username = bounds(cx, window, "db-form-row-username");
    let password = bounds(cx, window, "db-form-row-password");
    assert_eq!(password.top() - username.bottom(), px(12.0));
    let cancel = bounds(cx, window, "db-form-cancel");
    let save = bounds(cx, window, "db-form-save");
    assert_eq!(cancel.top() - password.bottom(), px(24.0));
    assert_eq!(save.top() - password.bottom(), px(24.0));
    assert_eq!(
        bounds(cx, window, "db-form-row-name").left(),
        form.left() + px(16.0)
    );
}

#[gpui_kit::test]
fn the_driver_dropdown_matches_the_field_and_marks_the_current_driver(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, Scenario::default(), "dark-ocean");
    click(cx, window, "db-add-btn");
    let select = bounds(cx, window, "db-driver-select");
    assert_eq!(select.size.height, px(32.0));
    assert_eq!(
        select.size.width,
        bounds(cx, window, "db-form-row-name").size.width
    );
    assert!(!shown(cx, window, "db-driver-menu"));

    click(cx, window, "db-driver-select");
    assert!(cx.update(|cx| {
        panel
            .read(cx)
            .editing
            .as_ref()
            .is_some_and(|f| f.driver_menu_open)
    }));
    let menu = bounds(cx, window, "db-driver-menu");
    assert_eq!(menu.size.width, select.size.width);
    assert_eq!(menu.left(), select.left());
    assert_eq!(menu.top() - select.bottom(), px(4.0));
    let current = cx.update(|cx| {
        panel
            .read(cx)
            .editing
            .as_ref()
            .map(|form| form.draft.connection.driver)
            .expect("a form")
    });
    for driver in DatabaseDriver::ALL {
        let item = format!("db-driver-{}", driver.label());
        let check = format!("db-driver-check-{}", driver.label());
        let (has_item, has_check) = cx
            .update_window(window, |_, w, _| {
                (
                    w.try_find(item.clone()).is_some(),
                    w.try_find(check.clone()).is_some(),
                )
            })
            .expect("a window");
        assert!(has_item, "{item}");
        assert_eq!(has_check, driver == current, "{check}");
    }

    // Choosing another driver closes the menu and moves the check.
    let other = DatabaseDriver::ALL
        .into_iter()
        .find(|driver| *driver != current)
        .expect("another driver");
    let other_item = format!("db-driver-{}", other.label());
    cx.update_window(window, |_, w, cx| w.click(other_item.clone(), cx))
        .expect("a window");
    frames(cx, window);
    let chosen = cx.update(|cx| {
        panel
            .read(cx)
            .editing
            .as_ref()
            .map(|form| (form.draft.connection.driver, form.driver_menu_open))
            .expect("a form")
    });
    assert_eq!(chosen, (other, false));
    assert!(!shown(cx, window, "db-driver-menu"));
}

#[test]
fn the_name_placeholder_is_my_database_until_a_database_is_typed() {
    let mut draft = new_connection(None);
    assert_eq!(name_placeholder(&draft), "My database");
    draft.connection.database = "   ".to_owned();
    assert_eq!(name_placeholder(&draft), "My database");
    draft.connection.database = "orders".to_owned();
    assert_eq!(name_placeholder(&draft), "127.0.0.1/orders");
}

// The connection menu: a search field, a list that scrolls, and a height that fits the window.

const MAX_MENU_HEIGHT_PX: f32 = 420.0;

fn open_menu(cx: &mut TestAppContext, window: AnyWindowHandle) {
    click(cx, window, "db-connection-trigger");
}

fn press(cx: &mut TestAppContext, window: AnyWindowHandle, key: &str) {
    cx.update_window(window, |_, w, cx| w.press(key, cx))
        .expect("a window");
    frames(cx, window);
}

fn type_text(cx: &mut TestAppContext, window: AnyWindowHandle, text: &str) {
    cx.update_window(window, |_, w, cx| w.input(text, cx))
        .expect("a window");
    frames(cx, window);
}

/// The ids of the connections the open menu lists, top to bottom.
fn menu_rows(cx: &mut TestAppContext, panel: &Entity<DatabasePanel>) -> Vec<String> {
    cx.update(|cx| {
        let rows = panel.read(cx).menu_rows();
        (0..rows.len())
            .filter_map(|row| rows.get(row).map(|c| c.id.clone()))
            .collect()
    })
}

fn menu_scenario() -> Scenario {
    Scenario {
        env: true,
        saved: 2,
        vault: 40,
    }
}

#[gpui_kit::test]
fn the_menu_is_capped_and_its_list_scrolls(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    let menu = bounds(cx, window, "db-connection-menu");
    let list = bounds(cx, window, "db-connection-list");
    assert!(menu.size.height <= px(MAX_MENU_HEIGHT_PX), "{menu:?}");
    assert!(menu.bottom() <= px(PANEL_HEIGHT_PX), "inside the window");
    assert!(list.size.height < px(43.0 * 28.0), "the list is cut short");
    assert!(
        cx.update(|cx| panel.read(cx).menu_scroll.max_offset().y) > px(0.0),
        "and scrolls"
    );
    assert!(shown(cx, window, "db-menu-add"), "the actions stay in view");
    assert!(bounds(cx, window, "db-menu-add").bottom() <= menu.bottom());
    assert!(shown(cx, window, "db-connection-heading"));
    assert!(labelled(cx, window, "Vault"));
}

#[gpui_kit::test]
fn a_short_window_shrinks_the_menu_to_the_room_below_the_trigger(cx: &mut TestAppContext) {
    let (window, _panel, _folder) = open_panel_sized(cx, menu_scenario(), "dark-ocean", 300.0);
    open_menu(cx, window);
    let trigger = bounds(cx, window, "db-connection-trigger");
    let menu = bounds(cx, window, "db-connection-menu");
    assert!(menu.bottom() <= px(300.0 - 8.0), "{menu:?}");
    assert!(menu.top() >= trigger.bottom());
    assert!(menu.size.height < px(MAX_MENU_HEIGHT_PX));
}

#[gpui_kit::test]
fn the_search_has_the_keyboard_when_the_menu_opens(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    assert!(shown(cx, window, "db-connection-search"));
    type_text(cx, window, "vault database 12");
    assert_eq!(
        cx.update(|cx| panel.read(cx).menu_query.clone()),
        "vault database 12"
    );
    assert_eq!(menu_rows(cx, &panel), vec!["vault:12".to_owned()]);
    // Opened again, the search starts empty.
    click(cx, window, "db-connection-trigger");
    open_menu(cx, window);
    assert_eq!(cx.update(|cx| panel.read(cx).menu_query.clone()), "");
}

#[gpui_kit::test]
fn typing_filters_both_groups_by_name_and_by_host_or_database(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    assert_eq!(menu_rows(cx, &panel).len(), 43);

    // By name, in the saved group only: the Vault heading goes.
    type_text(cx, window, "STAGING");
    assert_eq!(
        menu_rows(cx, &panel),
        vec!["manual-1".to_owned(), "manual-2".to_owned()]
    );
    assert!(shown(cx, window, "db-connection-heading"));
    assert!(!shown(cx, window, "db-vault-heading"));
    assert!(!shown(cx, window, "db-connection-no-matches"));

    // By database, which the Vault rows show as their target.
    press_clear(cx, window);
    type_text(cx, window, "orders_7");
    assert_eq!(menu_rows(cx, &panel), vec!["vault:7".to_owned()]);
    assert!(!shown(cx, window, "db-connection-heading"));
    assert!(shown(cx, window, "db-vault-heading"));

    // By host, in both groups: both headings stay.
    press_clear(cx, window);
    type_text(cx, window, "ORDERS");
    let rows = menu_rows(cx, &panel);
    assert_eq!(
        rows.first().map(String::as_str),
        Some("env"),
        ".env's database is orders.sqlite"
    );
    assert_eq!(rows.len(), 41);
    assert!(shown(cx, window, "db-connection-heading"));
    assert!(shown(cx, window, "db-vault-heading"));
}

/// Empties the search field the way a user does: select all, delete.
fn press_clear(cx: &mut TestAppContext, window: AnyWindowHandle) {
    press(cx, window, "cmd-a");
    press(cx, window, "backspace");
}

#[gpui_kit::test]
fn nothing_matching_says_so_and_keeps_the_actions(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    type_text(cx, window, "no such database");
    assert!(menu_rows(cx, &panel).is_empty());
    assert!(shown(cx, window, "db-connection-no-matches"));
    assert!(labelled(cx, window, "No matches"));
    assert!(!shown(cx, window, "db-connection-heading"));
    assert!(!shown(cx, window, "db-vault-heading"));
    assert!(shown(cx, window, "db-menu-add"));
    // Enter with nothing to pick keeps the menu open.
    press(cx, window, "enter");
    assert!(cx.update(|cx| panel.read(cx).menu_open));
}

#[gpui_kit::test]
fn the_arrow_keys_move_the_highlight_and_enter_picks_the_row(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    // "database 1" keeps Vault databases 1 and 10 to 19, in that order.
    type_text(cx, window, "database 1");
    let rows = menu_rows(cx, &panel);
    assert_eq!(rows.len(), 11);
    assert_eq!(cx.update(|cx| panel.read(cx).menu_highlight), 0);
    press(cx, window, "down");
    press(cx, window, "down");
    assert_eq!(cx.update(|cx| panel.read(cx).menu_highlight), 2);
    press(cx, window, "up");
    assert_eq!(cx.update(|cx| panel.read(cx).menu_highlight), 1);
    press(cx, window, "up");
    press(cx, window, "up");
    assert_eq!(
        cx.update(|cx| panel.read(cx).menu_highlight),
        10,
        "wraps to the last row"
    );
    press(cx, window, "down");
    press(cx, window, "down");
    assert_eq!(cx.update(|cx| panel.read(cx).menu_highlight), 1);
    press(cx, window, "enter");
    assert_eq!(selected_id(cx, &panel).as_deref(), Some(rows[1].as_str()));
    assert!(
        !cx.update(|cx| panel.read(cx).menu_open),
        "picking closes it"
    );
}

#[gpui_kit::test]
fn the_highlight_scrolls_into_view(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    // Up from the first row wraps to the last, 43 rows down and out of sight.
    press(cx, window, "up");
    assert_eq!(cx.update(|cx| panel.read(cx).menu_highlight), 42);
    let list = bounds(cx, window, "db-connection-list");
    let last = bounds(cx, window, "db-conn-item-vault:40");
    assert!(
        last.bottom() <= list.bottom() && last.top() >= list.top(),
        "{last:?} in {list:?}"
    );
    press(cx, window, "down");
    let first = bounds(cx, window, "db-conn-item-env");
    assert!(first.top() >= list.top(), "back at the top");
}

#[gpui_kit::test]
fn escape_clears_the_search_first_then_closes_the_menu(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    type_text(cx, window, "orders");
    assert!(!cx.update(|cx| panel.read(cx).menu_query.is_empty()));
    press(cx, window, "escape");
    assert!(
        cx.update(|cx| panel.read(cx).menu_open),
        "the first Escape keeps the menu"
    );
    assert_eq!(cx.update(|cx| panel.read(cx).menu_query.clone()), "");
    assert_eq!(
        cx.update(|cx| panel.read(cx).menu_input.read(cx).value().to_string()),
        ""
    );
    assert_eq!(menu_rows(cx, &panel).len(), 43, "the full list is back");
    press(cx, window, "escape");
    assert!(!cx.update(|cx| panel.read(cx).menu_open));
    assert!(!shown(cx, window, "db-connection-menu"));
}

#[gpui_kit::test]
fn a_click_in_the_search_keeps_the_menu_open(cx: &mut TestAppContext) {
    let (window, panel, _folder) = open_panel(cx, menu_scenario(), "dark-ocean");
    open_menu(cx, window);
    click(cx, window, "db-connection-search");
    assert!(cx.update(|cx| panel.read(cx).menu_open));
    click(cx, window, "db-conn-item-vault:3");
    assert_eq!(selected_id(cx, &panel).as_deref(), Some("vault:3"));
    assert!(!cx.update(|cx| panel.read(cx).menu_open));
}

#[gpui_kit::test]
fn the_plain_list_scrolls_inside_the_panel(cx: &mut TestAppContext) {
    let scenario = Scenario {
        vault: 40,
        ..Scenario::default()
    };
    let (window, _panel, _folder) = open_panel(cx, scenario, "dark-ocean");
    let pick = bounds(cx, window, "db-pick");
    assert!(
        pick.bottom() <= px(PANEL_HEIGHT_PX),
        "inside the window: {pick:?}"
    );
    let vault = bounds(cx, window, "db-pick-vault");
    assert!(
        vault.size.height > pick.size.height,
        "the list is longer than the panel"
    );
    let before = vault.top();
    cx.update_window(window, |_, w, cx| {
        w.scroll(
            "db-pick",
            gpui_kit::ScrollDelta::Pixels(gpui_kit::point(px(0.0), px(-200.0))),
            cx,
        )
    })
    .expect("a window");
    frames(cx, window);
    assert!(
        bounds(cx, window, "db-pick-vault").top() < before,
        "it scrolled"
    );
}

#[test]
fn the_search_matches_names_hosts_and_databases_without_case() {
    let mut saved = saved_connection(1, true);
    saved.name = "Billing Replica".to_owned();
    let mut vault = vault_connection(1);
    vault.name = "Orders".to_owned();
    let all = vec![saved, vault];
    let ids = |query: &str| -> Vec<String> {
        let rows = PickerRows::new(&all, query);
        (0..rows.len())
            .filter_map(|row| rows.get(row).map(|c| c.id.clone()))
            .collect()
    };
    assert_eq!(ids(""), ["manual-1", "vault:1"]);
    assert_eq!(ids("  billing  "), ["manual-1"], "trimmed");
    assert_eq!(ids("REPLICA"), ["manual-1"]);
    assert_eq!(ids("db.staging"), ["manual-1"], "by host");
    assert_eq!(ids("10.0.0.5"), ["vault:1"], "by host");
    assert_eq!(ids("orders_1"), ["vault:1"], "by database");
    assert!(ids("nothing").is_empty());
    let rows = PickerRows::new(&all, "");
    assert_eq!((rows.connections.len(), rows.vault.len()), (1, 1));
    // The headings are list children too: heading, row, heading, row.
    assert_eq!((rows.child_index(0), rows.child_index(1)), (1, 3));
    let vault_only = PickerRows::new(&all, "orders");
    assert_eq!(vault_only.child_index(0), 1, "one heading above");
}

#[test]
fn stepping_wraps_and_an_empty_list_stays_at_the_first_row() {
    assert_eq!(step_row(0, 1, 3), 1);
    assert_eq!(step_row(2, 1, 3), 0);
    assert_eq!(step_row(0, -1, 3), 2);
    assert_eq!(step_row(5, 1, 0), 0);
}

#[test]
fn the_menu_height_is_the_smaller_of_420_and_the_room_it_has() {
    let trigger = Bounds::new(Point::new(px(8.0), px(8.0)), size(px(200.0), px(32.0)));
    let tall = menu_placement(Some(trigger), 900.0, 2000.0);
    assert!(!tall.opens_up);
    assert_eq!(tall.max_height, 420.0, "capped");
    // 300px window: below the trigger there are 300 - 40 - 6 - 8 = 246px.
    let short = menu_placement(Some(trigger), 300.0, 2000.0);
    assert!(!short.opens_up, "no more room above");
    assert_eq!(short.max_height, 246.0);
    // A menu that fits needs no flip, wherever the trigger is.
    let low = Bounds::new(Point::new(px(8.0), px(500.0)), size(px(200.0), px(32.0)));
    assert!(!menu_placement(Some(low), 600.0, 40.0).opens_up);
    // Near the bottom with a long list: more room above, so it opens upwards and fits there.
    let up = menu_placement(Some(low), 600.0, 2000.0);
    assert!(up.opens_up);
    assert_eq!(up.max_height, 420.0_f32.min(500.0 - 14.0));
    // Before the trigger is measured, the window still bounds it.
    let first = menu_placement(None, 300.0, 2000.0);
    assert_eq!(first.max_height, 284.0);
}

/// Renders each approved state offscreen to PNG, in Dark Ocean and Light. It opens no window on
/// screen and takes no focus: GPUI's headless renderer draws into a texture.
///
/// `CONN_DB_SHOTS_DIR=<dir> cargo test -p conn-app render_design_screenshots -- --ignored`
#[test]
#[cfg(target_os = "macos")]
#[ignore = "writes PNGs; set CONN_DB_SHOTS_DIR"]
fn render_design_screenshots() {
    let Some(dir) = std::env::var_os("CONN_DB_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        // `current_platform(true)` needs the main thread, which libtest does not give a test.
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (theme, label) in [("dark-ocean", "dark-ocean"), ("t3-code-light", "light")] {
        let tokens = tokens_for(theme);
        let (window, panel) = ctx.update(|cx| {
            gpui_kit::init(cx);
            crate::fonts::register(cx);
            crate::theme::apply_kit_theme(&tokens, cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::default(),
                        size(px(PANEL_WIDTH_PX), px(PANEL_HEIGHT_PX)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    let tokens = tokens.clone();
                    cx.new(|cx| DatabasePanel::new(tokens, window, cx))
                },
            )
            .expect("a window")
        });
        let env_folder = project_folder(true);
        let bare_folder = project_folder(false);
        let shoot = |ctx: &mut gpui_kit::HeadlessAppContext, name: &str| {
            for _ in 0..3 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("{name}-{label}.png")))
                .expect("a saved PNG");
        };
        let set = |ctx: &mut gpui_kit::HeadlessAppContext,
                   root: &Path,
                   edit: &dyn Fn(&mut DatabasePanel, &mut gpui_kit::Context<'_, DatabasePanel>)| {
            ctx.update(|cx| {
                panel.update(cx, |panel, cx| {
                    panel.store = DatabaseStore::default();
                    panel.vault_connections.clear();
                    panel.vault_status = None;
                    panel.editing = None;
                    panel.project_key = None;
                    panel.set_project(
                        Some(PROJECT.to_owned()),
                        Some(root.to_string_lossy().into_owned()),
                        cx,
                    );
                    edit(panel, cx);
                });
            });
        };
        // (a) no .env, no Vault.
        set(&mut ctx, bare_folder.path(), &|_, _| {});
        shoot(&mut ctx, "a-empty-no-env");
        // (b) .env, a saved connection and Vault databases, disconnected: the plain list.
        set(&mut ctx, env_folder.path(), &|panel, cx| {
            panel
                .store
                .save_connection(PROJECT, saved_connection(1, true));
            let token = panel.begin_vault_load_for_test();
            panel.finish_vault_load_for_test(token, (1..=2).map(vault_connection).collect(), cx);
            panel.disconnect(cx);
        });
        shoot(&mut ctx, "b-pick-connections-and-vault");
        // (c) Vault only: the list with just the Vault heading.
        set(&mut ctx, bare_folder.path(), &|panel, cx| {
            let token = panel.begin_vault_load_for_test();
            panel.finish_vault_load_for_test(token, vec![vault_connection(1)], cx);
        });
        shoot(&mut ctx, "c-pick-vault-only");
        // (d) a connection open: the toolbar with Disconnect.
        set(&mut ctx, env_folder.path(), &|_, _| {});
        shoot(&mut ctx, "d-connected-toolbar");
        // (e) the Add connection form, driver menu open, a field focused.
        set(&mut ctx, bare_folder.path(), &|_, _| {});
        ctx.update_window(window, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel.begin_add_connection(false, window, cx);
                if let Some(form) = panel.editing.as_mut() {
                    form.driver_menu_open = true;
                    form.focus_field_for_test(window, cx);
                }
            });
        })
        .expect("a window");
        shoot(&mut ctx, "e-add-connection-form");
    }
}

/// Renders the open connection menu offscreen, in Dark Ocean and Light, with 40 Vault databases:
/// unfiltered, and filtered by a search.
///
/// `CONN_DB_SHOTS_DIR=<dir> cargo test -p conn-app render_connection_menu_screenshots -- --ignored`
#[test]
#[cfg(target_os = "macos")]
#[ignore = "writes PNGs; set CONN_DB_SHOTS_DIR"]
fn render_connection_menu_screenshots() {
    let Some(dir) = std::env::var_os("CONN_DB_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (theme, label) in [("dark-ocean", "dark-ocean"), ("t3-code-light", "light")] {
        let tokens = tokens_for(theme);
        let (window, panel) = ctx.update(|cx| {
            gpui_kit::init(cx);
            crate::fonts::register(cx);
            crate::theme::apply_kit_theme(&tokens, cx);
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                        Point::default(),
                        size(px(PANEL_WIDTH_PX), px(PANEL_HEIGHT_PX)),
                    ))),
                    focus: false,
                    show: false,
                    ..Default::default()
                },
                cx,
                |window, cx| {
                    let tokens = tokens.clone();
                    cx.new(|cx| DatabasePanel::new(tokens, window, cx))
                },
            )
            .expect("a window")
        });
        let folder = project_folder(true);
        ctx.update(|cx| {
            panel.update(cx, |panel, cx| {
                panel.store = DatabaseStore::default();
                panel
                    .store
                    .save_connection(PROJECT, saved_connection(1, true));
                panel.set_project(
                    Some(PROJECT.to_owned()),
                    Some(folder.path().to_string_lossy().into_owned()),
                    cx,
                );
                let token = panel.begin_vault_load_for_test();
                panel.finish_vault_load_for_test(
                    token,
                    (1..=40).map(vault_connection).collect(),
                    cx,
                );
            });
        });
        let shoot = |ctx: &mut gpui_kit::HeadlessAppContext, name: &str| {
            for _ in 0..3 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            let image = ctx.capture_screenshot(window).expect("a screenshot");
            image
                .save(dir.join(format!("{name}-{label}.png")))
                .expect("a saved PNG");
        };
        ctx.update_window(window, |_, window, cx| {
            panel.update(cx, |panel, cx| panel.toggle_menu(window, cx));
        })
        .expect("a window");
        shoot(&mut ctx, "menu-unfiltered");
        // Scrolled to the end with the keyboard: the highlight stays in view.
        ctx.update(|cx| panel.update(cx, |panel, cx| panel.move_menu_highlight(-1, cx)));
        shoot(&mut ctx, "menu-scrolled-to-end");
        ctx.update_window(window, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel.reset_menu_search(window, cx);
                panel.menu_input.update(cx, |input, cx| {
                    input.set_value("orders_1", window, cx);
                });
                panel.menu_query = "orders_1".to_owned();
                panel.menu_highlight = 0;
                cx.notify();
            });
        })
        .expect("a window");
        shoot(&mut ctx, "menu-filtered");
        ctx.update_window(window, |_, window, cx| {
            panel.update(cx, |panel, cx| {
                panel
                    .menu_input
                    .update(cx, |input, cx| input.set_value("zzz", window, cx));
                panel.menu_query = "zzz".to_owned();
                cx.notify();
            });
        })
        .expect("a window");
        shoot(&mut ctx, "menu-no-matches");
    }
}
