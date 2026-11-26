//! Headless tests of the Database panel's empty state, toolbar and connection form, and the
//! env-gated offscreen renders of each state (`render_design_screenshots`).

use std::path::Path;

use conn_desktop::database::api::{ConnectionSource, PanelConnection, new_connection};
use conn_desktop::database::{DatabaseConnection, DatabaseDriver};
use conn_theme::Tokens;
use gpui_kit::AppContext as _;
use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, Bounds, Entity, Pixels, Point, TestAppContext, WindowBounds, WindowOptions,
    px, size,
};

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
    let folder = project_folder(scenario.env);
    let root = folder.path().to_string_lossy().into_owned();
    let tokens = tokens_for(theme);
    let (window, panel) = cx.update(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(PANEL_WIDTH_PX), px(PANEL_HEIGHT_PX)),
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
