//! The pure parts of the Database panel's connection picker: which connections a search keeps,
//! which row a key lands on, and how tall the menu may be so it stays inside the window.

use conn_desktop::database::api::{ConnectionSource, PanelConnection, connection_target};
use gpui_kit::{Bounds, Pixels};

/// The tallest the menu grows: about 17 rows of 28px and the search field.
pub(super) const MENU_MAX_HEIGHT_PX: f32 = 420.0;
/// Space kept between the menu and the window edge.
pub(super) const MENU_WINDOW_MARGIN_PX: f32 = 8.0;
/// Gap between the trigger and the menu (`sideOffset={6}`).
pub(super) const MENU_SIDE_OFFSET_PX: f32 = 6.0;
/// The menu never gets shorter than this, even in a tiny window.
const MENU_MIN_HEIGHT_PX: f32 = 96.0;

/// The rows a search keeps, in the order the menu shows them: `.env` and saved connections, then
/// Vault databases.
#[derive(Debug, Clone, Default)]
pub(super) struct PickerRows {
    pub(super) connections: Vec<PanelConnection>,
    pub(super) vault: Vec<PanelConnection>,
}

impl PickerRows {
    /// Keeps the connections whose name or host/database string holds `query`, ignoring case.
    pub(super) fn new(all: &[PanelConnection], query: &str) -> Self {
        let needle = query.trim().to_lowercase();
        let (vault, connections) = all
            .iter()
            .filter(|connection| matches_query(connection, &needle))
            .cloned()
            .partition(|connection| connection.source == ConnectionSource::Vault);
        Self { connections, vault }
    }

    pub(super) fn len(&self) -> usize {
        self.connections.len() + self.vault.len()
    }

    pub(super) fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The `row`th connection, counting across both groups.
    pub(super) fn get(&self, row: usize) -> Option<&PanelConnection> {
        match row.checked_sub(self.connections.len()) {
            None => self.connections.get(row),
            Some(vault_row) => self.vault.get(vault_row),
        }
    }

    /// The position of `row` among the list's children, which the group headings also take.
    pub(super) fn child_index(&self, row: usize) -> usize {
        let connections_heading = usize::from(!self.connections.is_empty());
        if row < self.connections.len() {
            row + connections_heading
        } else {
            row + connections_heading + 1
        }
    }
}

/// Whether a connection matches the lower-cased `needle`: by name, host or database.
fn matches_query(connection: &PanelConnection, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let target = connection_target(&connection.connection, connection.ssh_host.as_deref());
    [
        connection.name.as_str(),
        target.as_str(),
        connection.connection.host.as_str(),
        connection.connection.database.as_str(),
    ]
    .iter()
    .any(|field| field.to_lowercase().contains(needle))
}

/// Moves a highlight by `delta` rows and wraps at both ends.
pub(super) fn step_row(current: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let len = isize::try_from(len).unwrap_or(isize::MAX);
    let current = isize::try_from(current).unwrap_or(0);
    usize::try_from((current + delta).rem_euclid(len)).unwrap_or(0)
}

/// Where the menu opens and how tall it may grow.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct MenuPlacement {
    pub(super) opens_up: bool,
    pub(super) max_height: f32,
}

/// Keeps the menu inside the window: about 420px, or the room on the chosen side of the trigger
/// less a margin, whichever is smaller. It opens upwards only when the content would not fit
/// below the trigger and there is more room above.
///
/// `wanted_height` is the menu's height with every row shown. `trigger` is unknown on the first
/// frame; the menu then opens downwards and fits the window itself.
pub(super) fn menu_placement(
    trigger: Option<Bounds<Pixels>>,
    window_height: f32,
    wanted_height: f32,
) -> MenuPlacement {
    let Some(trigger) = trigger else {
        let room = window_height - 2.0 * MENU_WINDOW_MARGIN_PX;
        return MenuPlacement {
            opens_up: false,
            max_height: MENU_MAX_HEIGHT_PX.min(room).max(MENU_MIN_HEIGHT_PX),
        };
    };
    let reserved = MENU_SIDE_OFFSET_PX + MENU_WINDOW_MARGIN_PX;
    let below = window_height - trigger.bottom().as_f32() - reserved;
    let above = trigger.top().as_f32() - reserved;
    let wanted = wanted_height.min(MENU_MAX_HEIGHT_PX);
    let opens_up = wanted > below && above > below;
    let room = if opens_up { above } else { below };
    MenuPlacement {
        opens_up,
        max_height: MENU_MAX_HEIGHT_PX.min(room).max(MENU_MIN_HEIGHT_PX),
    }
}
