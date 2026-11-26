//! What the Browser panel gives the project's history: the address the user explicitly opened, and
//! the title of that page once Chromium settles on it. Pure state, so it is tested without a
//! window or Chromium.
//!
//! Conn (`recordVisitForThread`) records the address that was submitted or opened, when it is
//! accepted, whether or not the page loads: a dev server that is down is still one click away.
//! Back, forward, reload, a warm start and a restored tab never record. Redirects and the pages a
//! site sends the user through (an auth callback) are not addresses the user opened, so Chromium's
//! final URL is never recorded. It only supplies a title, and only for the opened address.

use std::time::{SystemTime, UNIX_EPOCH};

/// `PENDING_MAX_PER_THREAD`: visits kept while the panel's project is not known yet.
const PENDING_MAX: usize = 10;

/// An address the user opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Visit {
    pub(super) url: String,
    /// Unix milliseconds.
    pub(super) at_ms: i64,
}

/// The loaded page whose title follows, and the title last sent for it.
#[derive(Debug)]
struct Watched {
    /// The document Chromium settled on.
    page_url: String,
    title: Option<String>,
}

#[derive(Debug, Default)]
pub(super) struct VisitTracker {
    project_key: Option<String>,
    environment_hostname: Option<String>,
    /// Visits opened before the project was known, oldest first.
    pending: Vec<Visit>,
    /// The address last opened, which the page's title belongs to.
    opened: Option<String>,
    watched: Option<Watched>,
}

impl VisitTracker {
    /// The project the history is kept under, once the app has named it.
    pub(super) fn project_key(&self) -> Option<&str> {
        self.project_key.as_deref()
    }

    pub(super) fn environment_hostname(&self) -> Option<&str> {
        self.environment_hostname.as_deref()
    }

    /// Takes the app's project and environment host. An absent or empty key means the context is
    /// still loading. Returns the visits that waited for the key, oldest first, once it is known.
    pub(super) fn set_context(
        &mut self,
        project_key: Option<String>,
        environment_hostname: Option<String>,
    ) -> Vec<Visit> {
        self.project_key = project_key.filter(|key| !key.is_empty());
        self.environment_hostname = environment_hostname.filter(|host| !host.is_empty());
        if self.project_key.is_some() {
            std::mem::take(&mut self.pending)
        } else {
            Vec::new()
        }
    }

    /// The panel accepted a navigation to `url`. Returns the visit to record now, or `None` for
    /// an address that is not a web page, or one held until the project is known.
    pub(super) fn opened(&mut self, url: &str, at_ms: i64) -> Option<Visit> {
        self.watched = None;
        if !is_web_url(url) {
            self.opened = None;
            return None;
        }
        self.opened = Some(url.to_owned());
        let visit = Visit {
            url: url.to_owned(),
            at_ms,
        };
        if self.project_key.is_some() {
            Some(visit)
        } else {
            self.pending.push(visit);
            if self.pending.len() > PENDING_MAX {
                self.pending.remove(0);
            }
            None
        }
    }

    /// The panel loads an address it was not asked to open: a tab restored at startup or made
    /// again after eviction. Nothing is recorded, and no title follows: there is no opened
    /// address for one to belong to.
    pub(super) fn restored(&mut self) {
        self.opened = None;
        self.watched = None;
    }

    /// The main frame began a new document: the last title no longer belongs to the page.
    pub(super) fn load_started(&mut self) {
        self.watched = None;
    }

    /// The main frame settled on `url` (CEF's `status`; `failed` when CEF reported a load error).
    /// Its title is followed only when it is the address that was opened, by `same_page`.
    pub(super) fn load_finished(
        &mut self,
        url: &str,
        status: i32,
        failed: bool,
        same_page: impl Fn(&str, &str) -> bool,
    ) {
        self.watched = None;
        if failed || status <= 0 || !is_web_url(url) {
            return;
        }
        if self
            .opened
            .as_deref()
            .is_some_and(|opened| same_page(opened, url))
        {
            self.watched = Some(Watched {
                page_url: url.to_owned(),
                title: None,
            });
        }
    }

    /// Whether a settled page waits for its title to be followed.
    pub(super) fn is_watching(&self) -> bool {
        self.watched.is_some() && self.project_key.is_some()
    }

    /// The `(opened address, title)` to give the history, once per change. Nothing for another
    /// document, an empty or placeholder title, or while the project is unknown.
    pub(super) fn title_for(&mut self, page_url: &str, title: &str) -> Option<(String, String)> {
        self.project_key.as_ref()?;
        let opened = self.opened.clone()?;
        let watched = self.watched.as_mut()?;
        let title = title.trim();
        if watched.page_url != page_url
            || title.is_empty()
            || is_placeholder_title(page_url, title)
            || watched.title.as_deref() == Some(title)
        {
            return None;
        }
        watched.title = Some(title.to_owned());
        Some((opened, title.to_owned()))
    }
}

/// Unix milliseconds now.
pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Chromium titles a page without a `<title>` with its address.
fn is_placeholder_title(url: &str, title: &str) -> bool {
    let bare = url.split_once("://").map_or(url, |(_, rest)| rest);
    title == url || title == bare || title == bare.trim_end_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENED: &str = "http://localhost:3000";
    const PAGE: &str = "http://localhost:3000/";

    fn ready() -> VisitTracker {
        let mut tracker = VisitTracker::default();
        tracker.set_context(Some("env:/repo".to_owned()), None);
        tracker
    }

    /// Trailing-slash equality, standing in for the history store's page rules.
    fn same(a: &str, b: &str) -> bool {
        a.trim_end_matches('/') == b.trim_end_matches('/')
    }

    #[test]
    fn an_opened_address_is_recorded_when_accepted_before_any_page_loads() {
        let mut tracker = ready();
        assert_eq!(
            tracker.opened(OPENED, 7),
            Some(Visit {
                url: OPENED.to_owned(),
                at_ms: 7
            })
        );
    }

    #[test]
    fn only_web_addresses_are_recorded() {
        let mut tracker = ready();
        assert_eq!(tracker.opened("about:blank", 1), None);
        assert_eq!(tracker.opened("chrome://version", 1), None);
        assert_eq!(tracker.opened("file:///tmp/a.html", 1), None);
        assert!(tracker.opened("https://example.com/", 1).is_some());
    }

    #[test]
    fn loads_never_record_a_visit() {
        let mut tracker = ready();
        tracker.opened(OPENED, 1);
        // A redirect, a callback page, a back or a reload: the history is not told.
        tracker.load_finished("https://auth.example.com/callback?code=1", 200, false, same);
        assert!(!tracker.is_watching());
    }

    #[test]
    fn a_restored_address_follows_no_title() {
        let mut tracker = ready();
        tracker.opened(OPENED, 1);
        tracker.load_finished(PAGE, 200, false, same);
        assert!(tracker.is_watching());

        // The tab comes back on where its page ended up: nothing is opened, nothing is watched.
        tracker.restored();
        assert!(!tracker.is_watching());
        tracker.load_finished(PAGE, 200, false, same);
        assert!(!tracker.is_watching());
        assert_eq!(tracker.title_for(PAGE, "Dev"), None);

        // The user opening an address afterwards is recorded and follows a title as usual.
        assert!(tracker.opened(OPENED, 2).is_some());
        tracker.load_finished(PAGE, 200, false, same);
        assert_eq!(
            tracker.title_for(PAGE, "Dev"),
            Some((OPENED.to_owned(), "Dev".to_owned()))
        );
    }

    #[test]
    fn visits_wait_for_the_project_and_flush_oldest_first() {
        let mut tracker = VisitTracker::default();
        for at_ms in 0..12 {
            assert_eq!(
                tracker.opened(&format!("https://example.com/{at_ms}"), at_ms),
                None
            );
        }
        // An empty key is a context that is still loading.
        assert!(tracker.set_context(Some(String::new()), None).is_empty());
        assert_eq!(tracker.project_key(), None);
        let flushed = tracker.set_context(Some("env:/repo".to_owned()), Some("host".to_owned()));
        assert_eq!(flushed.len(), PENDING_MAX);
        assert_eq!(flushed.first().map(|visit| visit.at_ms), Some(2));
        assert_eq!(flushed.last().map(|visit| visit.at_ms), Some(11));
        assert_eq!(tracker.environment_hostname(), Some("host"));
        assert!(
            tracker
                .set_context(Some("env:/repo".to_owned()), None)
                .is_empty()
        );
    }

    #[test]
    fn the_title_belongs_to_the_opened_address_and_follows_once_per_change() {
        let mut tracker = ready();
        tracker.opened(OPENED, 1);
        assert!(!tracker.is_watching());
        tracker.load_finished(PAGE, 200, false, same);
        assert!(tracker.is_watching());

        assert_eq!(tracker.title_for(PAGE, " "), None);
        assert_eq!(tracker.title_for("http://other.test/", "Other"), None);
        // The title goes to the address the user opened, not to Chromium's spelling of it.
        assert_eq!(
            tracker.title_for(PAGE, " Dev "),
            Some((OPENED.to_owned(), "Dev".to_owned()))
        );
        assert_eq!(tracker.title_for(PAGE, "Dev"), None);
        assert_eq!(
            tracker.title_for(PAGE, "Dev 2"),
            Some((OPENED.to_owned(), "Dev 2".to_owned()))
        );
    }

    #[test]
    fn a_redirected_page_gets_no_title_and_a_failed_one_neither() {
        let mut tracker = ready();
        tracker.opened(OPENED, 1);
        tracker.load_finished("http://localhost:3000/login", 200, false, same);
        assert_eq!(
            tracker.title_for("http://localhost:3000/login", "Login"),
            None
        );

        tracker.load_finished(PAGE, 0, true, same);
        assert_eq!(tracker.title_for(PAGE, "localhost"), None);
        tracker.load_finished(PAGE, 0, false, same);
        assert!(!tracker.is_watching());
    }

    #[test]
    fn a_page_nobody_opened_has_no_title_to_follow() {
        let mut tracker = ready();
        tracker.load_finished(PAGE, 200, false, same);
        assert!(!tracker.is_watching());
        tracker.opened("about:blank", 1);
        tracker.load_finished(PAGE, 200, false, same);
        assert!(!tracker.is_watching());
    }

    #[test]
    fn a_placeholder_title_is_not_a_title() {
        let mut tracker = ready();
        tracker.opened(OPENED, 1);
        tracker.load_finished(PAGE, 200, false, same);
        assert_eq!(tracker.title_for(PAGE, "localhost:3000"), None);
        assert_eq!(tracker.title_for(PAGE, PAGE), None);
    }

    #[test]
    fn a_title_waits_for_the_project_and_a_new_document_resets_the_page() {
        let mut tracker = VisitTracker::default();
        tracker.opened(OPENED, 1);
        tracker.load_finished(PAGE, 200, false, same);
        assert!(!tracker.is_watching());
        assert_eq!(tracker.title_for(PAGE, "Dev"), None);
        tracker.set_context(Some("env:/repo".to_owned()), None);
        assert!(tracker.title_for(PAGE, "Dev").is_some());

        tracker.load_started();
        assert_eq!(tracker.title_for(PAGE, "Dev 2"), None);
    }

    #[test]
    fn opening_another_address_drops_the_old_page() {
        let mut tracker = ready();
        tracker.opened(OPENED, 1);
        tracker.load_finished(PAGE, 200, false, same);
        tracker.opened("http://localhost:4000", 2);
        assert!(!tracker.is_watching());
        assert_eq!(tracker.title_for(PAGE, "Dev"), None);
    }
}
