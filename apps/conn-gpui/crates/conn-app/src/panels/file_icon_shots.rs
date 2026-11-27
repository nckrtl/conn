//! Env-gated offscreen renders of the Pierre file icons (`render_pierre_icon_screenshots`): the
//! Files tree, a header file tab, the breadcrumb menu and a grid of every icon, in dark and light.

use std::path::Path;
use std::rc::Rc;

use conn_contract::{ProjectEntry, ProjectEntryKind};
use conn_state::{PanelSurface, RightPanelTab};
use conn_theme::Tokens;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Bounds, Context, IntoElement, Window, WindowBounds, WindowOptions, div, point,
    px, size,
};
use gpui_kit::{ParentElement as _, Render, Styled as _};

use super::{CrumbMenu, FilesPanel, MenuLoad, PreviewState};
use crate::file_icons::{self, FileIcon};
use crate::panels::color::to_hsla;
use crate::panels::header::{PanelHeaderCallbacks, PanelHeaderProps, render_panel_header};

fn entry(path: &str, directory: bool) -> ProjectEntry {
    ProjectEntry {
        path: path.to_owned(),
        kind: if directory {
            ProjectEntryKind::Directory
        } else {
            ProjectEntryKind::File
        },
        ignored: None,
    }
}

/// The lab's `filesFixture.ts` files (`fileSources`, `fileImages`, `fileDocuments`), plus the
/// dotfiles, config files and an unknown extension a real project has.
fn directories() -> Vec<(&'static str, Vec<ProjectEntry>)> {
    let dir = |path| entry(path, true);
    let file = |path| entry(path, false);
    vec![
        (
            "",
            vec![
                dir("app"),
                dir("docs"),
                dir("mock"),
                dir("public"),
                dir("resources"),
                file(".env"),
                file(".gitignore"),
                file("Dockerfile"),
                file("README.md"),
                file("composer.json"),
                file("mystery.zzz"),
                file("package.json"),
                file("tsconfig.json"),
                file("vite.config.ts"),
            ],
        ),
        ("app", vec![dir("app/Http"), dir("app/Models")]),
        ("app/Http", vec![dir("app/Http/Controllers")]),
        (
            "app/Http/Controllers",
            vec![file("app/Http/Controllers/OrderController.php")],
        ),
        ("app/Models", vec![file("app/Models/Order.php")]),
        ("docs", vec![file("docs/invoice.pdf")]),
        (
            "mock",
            vec![file("mock/fixtures.ts"), file("mock/main.tsx")],
        ),
        ("public", vec![dir("public/images")]),
        ("public/images", vec![file("public/images/logo.png")]),
        ("resources", vec![dir("resources/views")]),
        ("resources/views", vec![dir("resources/views/orders")]),
        (
            "resources/views/orders",
            vec![file("resources/views/orders/show.blade.php")],
        ),
    ]
}

fn files_panel(
    tokens: Tokens,
    window: &mut Window,
    cx: &mut Context<'_, FilesPanel>,
) -> FilesPanel {
    let mut files = FilesPanel::new(tokens, None, window, cx);
    files.workspace_root = Some("/project".into());
    for (directory, entries) in directories() {
        files.tree.set_directory_entries(directory, entries);
    }
    files
}

/// A bare view that shows one element, so a header or a grid renders on its own.
struct Stage {
    tokens: Tokens,
    content: Box<dyn Fn(&Tokens) -> gpui_kit::AnyElement>,
}

impl Render for Stage {
    fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(to_hsla(self.tokens.background))
            .text_color(to_hsla(self.tokens.foreground))
            .child((self.content)(&self.tokens))
    }
}

fn header(tokens: &Tokens) -> gpui_kit::AnyElement {
    let tabs = [
        PanelSurface::File("app/Models/Order.php".into()),
        PanelSurface::File("resources/views/orders/show.blade.php".into()),
        PanelSurface::File("README.md".into()),
        PanelSurface::File("package.json".into()),
        PanelSurface::Kind(RightPanelTab::Files),
    ];
    let noop = || Rc::new(|_: &mut Window, _: &mut gpui_kit::App| {});
    let callbacks = PanelHeaderCallbacks {
        on_select_tab: Rc::new(|_, _, _| {}),
        on_close_tab: None,
        on_toggle_add_menu: noop(),
        on_add_tab: Rc::new(|_, _, _| {}),
        on_toggle_maximize: noop(),
        on_toggle_panel: noop(),
        on_open_sidebar: noop(),
    };
    render_panel_header(
        PanelHeaderProps {
            open_tabs: &tabs,
            browser_titles: &[],
            active_tab: &tabs[1],
            maximized: false,
            owns_window_leading_edge: false,
            panel_open: true,
            add_menu_open: false,
            available_tabs: &[],
            has_project: true,
            terminal_machine: None,
            tokens,
        },
        callbacks,
    )
    .into_any_element()
}

/// Every icon the lookup can return, named, for the active appearance.
fn grid(tokens: &Tokens) -> gpui_kit::AnyElement {
    let mut icons: Vec<FileIcon> = file_icons::all_icons(tokens.appearance);
    icons.sort_by_key(|icon| icon.asset);
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let mut cells = div().flex().flex_row().flex_wrap().gap(px(8.0)).p(px(16.0));
    for icon in icons {
        let label = icon
            .asset
            .trim_start_matches(file_icons::ASSET_PREFIX)
            .trim_end_matches(".svg")
            .to_owned();
        cells = cells.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(10.0))
                .w(px(200.0))
                .h(px(40.0))
                .px(px(10.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(muted.opacity(0.25))
                .child(file_icons::icon_img(icon.asset, 24.0))
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(fg)
                        .truncate()
                        .child(label),
                ),
        );
    }
    cells.into_any_element()
}

fn bounds(width: f32, height: f32) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::new(
            gpui_kit::Point::default(),
            size(px(width), px(height)),
        ))),
        focus: false,
        show: false,
        ..Default::default()
    }
}

/// Renders the Pierre icon screens offscreen to PNG in Dark Ocean and Light. It opens no window on
/// screen and takes no focus: GPUI's headless renderer draws into a texture.
///
/// `CONN_ICON_SHOTS_DIR=<dir> cargo test -p conn-app render_pierre_icon_screenshots -- --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_ICON_SHOTS_DIR"]
fn render_pierre_icon_screenshots() {
    let Some(dir) = std::env::var_os("CONN_ICON_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::create_dir_all(dir).expect("an output folder");
    // `current_platform(true)` needs the main thread, which libtest does not give a test.
    let mut ctx = gpui_kit::HeadlessAppContext::with_platform(
        std::sync::Arc::new(gpui_apple::AppleTextSystem::new()),
        std::sync::Arc::new(crate::superhero::AppAssets),
        gpui_kit::platform::current_headless_renderer,
    );
    for (theme_id, label) in [("dark-ocean", "dark"), ("t3-code-light", "light")] {
        let theme = conn_theme::theme_by_id(theme_id).expect("a built-in theme");
        let tokens = Tokens::derive(&theme);
        ctx.update(|cx| {
            gpui_kit::init(cx);
            crate::fonts::register(cx);
            crate::theme::apply_kit_theme(&tokens, cx);
        });
        let capture = |ctx: &mut gpui_kit::HeadlessAppContext, window, name: &str| {
            for _ in 0..4 {
                ctx.update_window(window, |_, w, c| w.render_frame(c))
                    .expect("a frame");
                ctx.run_until_parked();
            }
            ctx.capture_screenshot(window)
                .expect("a screenshot")
                .save(dir.join(format!("{name}-{label}.png")))
                .expect("a saved PNG");
        };

        // The Files tree: folders open and closed, dotfiles, an unknown extension.
        let (window, _files) = ctx.update(|cx| {
            let tokens = tokens.clone();
            gpui_kit::open_window(bounds(320.0, 760.0), cx, |window, cx| {
                cx.new(|cx| {
                    let mut files = files_panel(tokens, window, cx);
                    for open in [
                        "app",
                        "app/Http",
                        "app/Http/Controllers",
                        "mock",
                        "public",
                        "public/images",
                        "resources",
                        "resources/views",
                        "resources/views/orders",
                    ] {
                        files.tree.expand(open);
                    }
                    files.tree.select(Some("README.md".to_owned()));
                    files
                })
            })
            .expect("a window")
        });
        capture(&mut ctx, window, "files-tree");

        // The breadcrumb menu, open over a file's breadcrumb.
        let (window, _files) = ctx.update(|cx| {
            let tokens = tokens.clone();
            gpui_kit::open_window(bounds(420.0, 420.0), cx, |window, cx| {
                cx.new(|cx| {
                    let mut files = files_panel(tokens, window, cx);
                    files.showing_preview = true;
                    files.preview = PreviewState::Loaded {
                        path: "docs/notes/README.md".into(),
                        raw_contents: "# Notes\n".into(),
                        truncated: false,
                    };
                    let entries = directories()
                        .into_iter()
                        .find(|(dir, _)| dir.is_empty())
                        .map(|(_, entries)| entries)
                        .unwrap_or_default();
                    files.crumb_menu = Some(CrumbMenu {
                        root: String::new(),
                        directory: String::new(),
                        position: point(px(60.0), px(48.0)),
                        load: MenuLoad::Ready(entries),
                    });
                    files
                })
            })
            .expect("a window")
        });
        capture(&mut ctx, window, "breadcrumb-menu");

        // The header file tabs.
        for (name, width, height, content) in [
            (
                "header-tabs",
                760.0,
                44.0,
                header as fn(&Tokens) -> gpui_kit::AnyElement,
            ),
            ("icon-grid", 1000.0, 940.0, grid),
        ] {
            let window = ctx.update(|cx| {
                let tokens = tokens.clone();
                gpui_kit::open_window(bounds(width, height), cx, |_, cx| {
                    cx.new(|_| Stage {
                        tokens,
                        content: Box::new(content),
                    })
                })
                .expect("a window")
                .0
            });
            capture(&mut ctx, window, name);
        }
    }
}
