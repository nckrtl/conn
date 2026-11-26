//! The site icons Chromium reported, kept in memory for the new-tab page's tiles.
//!
//! The Browser panel already receives each page's own icon as a PNG (`on_favicon`, for the inline
//! sign-in picker). The same bytes tile that site in "Recently used". Icons are never written to
//! `browser-history.json`: that file keeps the snapshot's format, and an icon returns the next
//! time its site is opened. Sites are matched by origin, with the loopback spellings of one dev
//! server read as one site.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use gpui_kit::{Image, ImageFormat};
use url::Url;

use super::history::is_local_loopback_host;

/// The most sites kept. A project's history holds 50 pages and the app keeps 20 projects.
const MAX_ICONS: usize = 64;

struct Cached {
    origin: String,
    png: Vec<u8>,
    image: Arc<Image>,
}

/// A cheap handle on the app-wide icons. Every clone shares one store.
#[derive(Clone)]
pub(super) struct Favicons {
    inner: Arc<Mutex<VecDeque<Cached>>>,
}

/// The icons every panel and window share.
pub(super) fn global() -> Favicons {
    static GLOBAL: OnceLock<Favicons> = OnceLock::new();
    GLOBAL.get_or_init(Favicons::new).clone()
}

impl Favicons {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    /// Keeps the icon of the site `page` belongs to. Returns `true` when what shows for that site
    /// changed. An empty icon, or a page that is not an http(s) address, changes nothing.
    pub(super) fn set(&self, page: &str, png: &[u8]) -> bool {
        let Some(origin) = origin_key(page) else {
            return false;
        };
        if png.is_empty() {
            return false;
        }
        let mut icons = self.lock();
        if let Some(position) = icons.iter().position(|icon| icon.origin == origin) {
            if icons[position].png == png {
                return false;
            }
            icons.remove(position);
        }
        icons.push_back(Cached {
            origin,
            png: png.to_vec(),
            image: Arc::new(Image::from_bytes(ImageFormat::Png, png.to_vec())),
        });
        while icons.len() > MAX_ICONS {
            icons.pop_front();
        }
        true
    }

    /// The icon for the site `page` belongs to. The same `Arc` comes back on every frame, so GPUI
    /// decodes and uploads each icon once.
    pub(super) fn get(&self, page: &str) -> Option<Arc<Image>> {
        let origin = origin_key(page)?;
        self.lock()
            .iter()
            .find(|icon| icon.origin == origin)
            .map(|icon| icon.image.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<Cached>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `scheme://host[:port]`, lowercase, with every loopback spelling as host `local`. None for an
/// address that is not http(s).
fn origin_key(page: &str) -> Option<String> {
    let parsed = Url::parse(page.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    let host = if is_local_loopback_host(&host) || host == "0.0.0.0" {
        "local".to_owned()
    } else {
        host
    };
    Some(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_one_origin_whatever_the_page() {
        let icons = Favicons::new();
        assert!(icons.set("https://Example.com/a?x=1#top", b"one"));
        assert!(icons.get("https://example.com/b").is_some());
        assert!(
            icons.get("http://example.com/").is_none(),
            "the scheme is part of the site"
        );
        assert!(icons.get("https://example.com:8443/").is_none());
        assert!(icons.get("https://other.test/").is_none());
    }

    #[test]
    fn loopback_spellings_are_one_site_but_ports_stay_apart() {
        let icons = Favicons::new();
        assert!(icons.set("http://localhost:5173/app", b"dev"));
        assert!(icons.get("http://127.0.0.1:5173/").is_some());
        assert!(icons.get("http://[::1]:5173/").is_some());
        assert!(icons.get("http://localhost:3000/").is_none());
    }

    #[test]
    fn only_a_new_icon_is_a_change_and_the_image_is_shared() {
        let icons = Favicons::new();
        assert!(icons.set("https://a.test/", b"one"));
        assert!(!icons.set("https://a.test/x", b"one"), "same bytes");
        let first = icons.get("https://a.test/");
        let again = icons.get("https://a.test/");
        assert!(matches!((&first, &again), (Some(a), Some(b)) if Arc::ptr_eq(a, b)));
        assert!(icons.set("https://a.test/", b"two"), "a changed icon");
        let replaced = icons.get("https://a.test/");
        assert!(matches!((&first, &replaced), (Some(a), Some(b)) if !Arc::ptr_eq(a, b)));
    }

    #[test]
    fn empty_icons_and_other_schemes_are_refused() {
        let icons = Favicons::new();
        assert!(!icons.set("https://a.test/", b""));
        assert!(!icons.set("about:blank", b"x"));
        assert!(!icons.set("file:///tmp/a.html", b"x"));
        assert!(!icons.set("not a url", b"x"));
        assert!(icons.get("https://a.test/").is_none());
    }

    #[test]
    fn the_oldest_sites_go_first() {
        let icons = Favicons::new();
        for i in 0..=MAX_ICONS {
            assert!(icons.set(&format!("https://site{i}.test/"), b"x"));
        }
        assert!(icons.get("https://site0.test/").is_none());
        assert!(icons.get("https://site1.test/").is_some());
        assert!(
            icons
                .get(&format!("https://site{MAX_ICONS}.test/"))
                .is_some()
        );
    }
}
