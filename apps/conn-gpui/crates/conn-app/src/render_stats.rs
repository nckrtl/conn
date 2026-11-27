//! Test-only counts of view renders on this thread, so a test can tell which parts of the window
//! a frame rebuilt. Tests run on their own threads, so the counts of one never mix with another's.

use std::cell::Cell;

/// Renders of each counted view since the thread started.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RenderCounts {
    /// `ConnApp`, the window's root: one per frame drawn.
    pub(crate) root: u64,
    /// The workspace rail and the thread sidebar.
    pub(crate) sidebar: u64,
    /// The thread header above the chat.
    pub(crate) header: u64,
    /// The right panel's surfaces.
    pub(crate) right_panel: u64,
    /// The chat view.
    pub(crate) chat: u64,
}

impl std::ops::Sub for RenderCounts {
    type Output = Self;

    fn sub(self, earlier: Self) -> Self {
        Self {
            root: self.root - earlier.root,
            sidebar: self.sidebar - earlier.sidebar,
            header: self.header - earlier.header,
            right_panel: self.right_panel - earlier.right_panel,
            chat: self.chat - earlier.chat,
        }
    }
}

thread_local! {
    static COUNTS: Cell<RenderCounts> = Cell::new(RenderCounts::default());
}

/// Counts one render of the view `count` picks.
pub(crate) fn rendered(count: impl FnOnce(&mut RenderCounts) -> &mut u64) {
    COUNTS.with(|counts| {
        let mut now = counts.get();
        *count(&mut now) += 1;
        counts.set(now);
    });
}

/// The counts so far.
pub(crate) fn snapshot() -> RenderCounts {
    COUNTS.with(Cell::get)
}
