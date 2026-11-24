//! The right panel's open tabs, as Conn's `rightPanelStore.ts`: an ordered list of surfaces and
//! the one that shows. Browser tabs are peers in that list (`browser:<tabId>`), so any number
//! of them can be open; every other kind opens once.

use crate::layout::{BrowserTabId, PanelSurface, RightPanelTab};

/// The right panel's open tabs and the active one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RightPanelTabs {
    tabs: Vec<PanelSurface>,
    active: Option<PanelSurface>,
    /// The browser tab shown last, which the Browser toggle brings back (`activeTabId`).
    last_browser: Option<BrowserTabId>,
    next_browser: BrowserTabId,
}

/// What [`RightPanelTabs::close`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedTab {
    /// The tab that shows now, if the closed one was active and another is left.
    pub activated: Option<PanelSurface>,
    /// No tab is left, so the panel closes (`isOpen: surfaces.length > 0`).
    pub was_last: bool,
}

impl RightPanelTabs {
    /// The open tabs, in strip order.
    #[must_use]
    pub fn tabs(&self) -> &[PanelSurface] {
        &self.tabs
    }

    /// The tab that shows, if any is open.
    #[must_use]
    pub fn active(&self) -> Option<&PanelSurface> {
        self.active.as_ref()
    }

    /// The browser tab the panel shows now or showed last, while it is still open.
    #[must_use]
    pub fn last_browser(&self) -> Option<BrowserTabId> {
        self.last_browser
            .filter(|id| self.tabs.contains(&PanelSurface::Browser(*id)))
    }

    /// The ids of the open browser tabs, in strip order.
    pub fn browser_ids(&self) -> impl Iterator<Item = BrowserTabId> + '_ {
        self.tabs.iter().filter_map(|tab| match tab {
            PanelSurface::Browser(id) => Some(*id),
            _ => None,
        })
    }

    /// Shows `surface`, appending it when it is not open yet (`upsertSurface`).
    pub fn activate(&mut self, surface: PanelSurface) {
        if let PanelSurface::Browser(id) = surface {
            self.last_browser = Some(id);
        }
        if !self.tabs.contains(&surface) {
            self.tabs.push(surface.clone());
        }
        self.active = Some(surface);
    }

    /// Appends a new, empty browser tab and shows it (`addBrowserSurface`).
    pub fn new_browser(&mut self) -> BrowserTabId {
        let id = self.allocate_browser();
        self.activate(PanelSurface::Browser(id));
        id
    }

    /// Appends a new browser tab behind the active one, as a page's background-tab link does
    /// (`openUrlInPreview` with `background`).
    pub fn new_background_browser(&mut self) -> BrowserTabId {
        let id = self.allocate_browser();
        self.tabs.push(PanelSurface::Browser(id));
        if self.active.is_none() {
            self.activate(PanelSurface::Browser(id));
        }
        id
    }

    /// The add menu's choice: Browser always adds a new tab (`createBrowserSurface`); other
    /// kinds show their one tab.
    pub fn add(&mut self, tab: RightPanelTab) -> PanelSurface {
        if tab == RightPanelTab::Browser {
            PanelSurface::Browser(self.new_browser())
        } else {
            self.open(tab)
        }
    }

    /// Shows the surface of kind `tab`. For Browser that is the tab shown last, else the first
    /// open one, else a new tab (`togglePreviewPanel`, `open(ref, "preview")`).
    pub fn open(&mut self, tab: RightPanelTab) -> PanelSurface {
        let surface = if tab == RightPanelTab::Browser {
            match self.last_browser().or_else(|| self.browser_ids().next()) {
                Some(id) => PanelSurface::Browser(id),
                None => PanelSurface::Browser(self.allocate_browser()),
            }
        } else {
            PanelSurface::Kind(tab)
        };
        self.activate(surface.clone());
        surface
    }

    /// Closes `surface` (`closeSurface`): the tab now at its place shows, else the last one.
    /// `None` when it was not open.
    pub fn close(&mut self, surface: &PanelSurface) -> Option<ClosedTab> {
        let index = self.tabs.iter().position(|tab| tab == surface)?;
        self.tabs.remove(index);
        let mut activated = None;
        if self.active.as_ref() == Some(surface) {
            let fallback = self
                .tabs
                .get(index.min(self.tabs.len().saturating_sub(1)))
                .cloned();
            self.active = None;
            if let Some(next) = fallback {
                self.activate(next.clone());
                activated = Some(next);
            }
        }
        Some(ClosedTab {
            activated,
            was_last: self.tabs.is_empty(),
        })
    }

    fn allocate_browser(&mut self) -> BrowserTabId {
        self.next_browser += 1;
        self.next_browser
    }
}

/// A browser tab's title (`surfaceTitle`): the page title, else the page's host, else Browser.
/// Chromium reports the URL as the title of a page without one; that counts as none.
#[must_use]
pub fn browser_tab_title(title: &str, url: &str) -> String {
    let title = title.trim();
    if !title.is_empty() && title != url.trim() {
        return title.to_owned();
    }
    url_host(url).map_or_else(|| "Browser".to_owned(), str::to_owned)
}

/// The host of an absolute URL with an authority, such as `localhost:3000`.
fn url_host(url: &str) -> Option<&str> {
    let (_, rest) = url.trim().split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty()).then_some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: PanelSurface = PanelSurface::Kind(RightPanelTab::Files);

    #[test]
    fn adding_browser_twice_opens_two_tabs() {
        let mut tabs = RightPanelTabs::default();
        let first = tabs.add(RightPanelTab::Browser);
        let second = tabs.add(RightPanelTab::Browser);
        assert_ne!(first, second);
        assert_eq!(tabs.tabs(), [first, second.clone()]);
        assert_eq!(tabs.active(), Some(&second));
        assert_eq!(tabs.browser_ids().count(), 2);
    }

    #[test]
    fn other_kinds_open_once() {
        let mut tabs = RightPanelTabs::default();
        tabs.add(RightPanelTab::Files);
        tabs.add(RightPanelTab::Files);
        assert_eq!(tabs.tabs(), [FILES]);
    }

    #[test]
    fn opening_browser_brings_back_the_last_shown_tab() {
        let mut tabs = RightPanelTabs::default();
        // No browser tab yet: the toggle makes one.
        let first = tabs.open(RightPanelTab::Browser);
        let second = tabs.add(RightPanelTab::Browser);
        tabs.activate(first.clone());
        tabs.open(RightPanelTab::Files);
        assert_eq!(tabs.open(RightPanelTab::Browser), first);
        assert_eq!(tabs.tabs().len(), 3);
        // The last-shown tab closed: the first open browser tab shows.
        tabs.close(&first);
        assert_eq!(tabs.open(RightPanelTab::Browser), second);
    }

    #[test]
    fn a_background_tab_leaves_the_active_tab() {
        let mut tabs = RightPanelTabs::default();
        let page = tabs.add(RightPanelTab::Browser);
        let id = tabs.new_background_browser();
        assert_eq!(tabs.active(), Some(&page));
        assert_eq!(tabs.tabs().last(), Some(&PanelSurface::Browser(id)));
        // With nothing open, it shows.
        let mut empty = RightPanelTabs::default();
        let id = empty.new_background_browser();
        assert_eq!(empty.active(), Some(&PanelSurface::Browser(id)));
    }

    #[test]
    fn closing_the_active_tab_shows_the_one_at_its_place() {
        let mut tabs = RightPanelTabs::default();
        let a = tabs.add(RightPanelTab::Browser);
        let b = tabs.add(RightPanelTab::Browser);
        let c = tabs.add(RightPanelTab::Browser);
        tabs.activate(b.clone());
        let closed = tabs.close(&b);
        assert_eq!(
            closed,
            Some(ClosedTab {
                activated: Some(c.clone()),
                was_last: false
            })
        );
        // The last tab: the one before it shows.
        assert_eq!(tabs.close(&c).and_then(|c| c.activated), Some(a.clone()));
        // An inactive tab: the active one stays.
        tabs.add(RightPanelTab::Files);
        assert_eq!(tabs.close(&a).and_then(|c| c.activated), None);
        assert_eq!(tabs.active(), Some(&FILES));
        assert_eq!(
            tabs.close(&FILES),
            Some(ClosedTab {
                activated: None,
                was_last: true
            })
        );
        assert_eq!(tabs.active(), None);
        assert_eq!(tabs.close(&FILES), None);
    }

    #[test]
    fn browser_ids_are_never_reused() {
        let mut tabs = RightPanelTabs::default();
        let first = tabs.add(RightPanelTab::Browser);
        tabs.close(&first);
        assert_ne!(tabs.add(RightPanelTab::Browser), first);
    }

    #[test]
    fn browser_tabs_title_by_page_then_host() {
        assert_eq!(browser_tab_title(" Docs ", "https://a.dev/x"), "Docs");
        assert_eq!(
            browser_tab_title("", "http://user@localhost:3000/a?b"),
            "localhost:3000"
        );
        assert_eq!(browser_tab_title("", "about:blank"), "Browser");
        assert_eq!(browser_tab_title("about:blank", "about:blank"), "Browser");
        assert_eq!(
            browser_tab_title("localhost:3000/a", "http://localhost:3000/a"),
            "localhost:3000/a"
        );
        assert_eq!(browser_tab_title("", ""), "Browser");
    }
}
