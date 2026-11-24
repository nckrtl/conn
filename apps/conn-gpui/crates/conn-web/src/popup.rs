//! Which page popups become Conn browser tabs (Conn's `previewWindowOpenAction`). A link with
//! `target=_blank`, or one opened with Cmd or the middle button, asks for a new tab; Conn opens
//! it as a peer browser tab. Anything else stays suppressed: the view is windowless, so it
//! cannot show a popup window.

/// How the page asked to open the URL (the parts of CEF's `WindowOpenDisposition` that matter).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disposition {
    ForegroundTab,
    BackgroundTab,
    Other,
}

/// A page's request for a new browser tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewTabRequest {
    pub url: String,
    /// Opened behind the current tab (Cmd-click, middle click).
    pub background: bool,
}

/// The new tab a popup asks for, if Conn opens one: only `http(s)` URLs (`POPUP_PROTOCOLS`).
pub(crate) fn new_tab_for(disposition: Disposition, url: &str) -> Option<NewTabRequest> {
    let background = match disposition {
        Disposition::ForegroundTab => false,
        Disposition::BackgroundTab => true,
        Disposition::Other => return None,
    };
    let lower = url.trim_start().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")).then(|| NewTabRequest {
        url: url.trim().to_owned(),
        background,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_dispositions_on_web_urls_open_tabs() {
        assert_eq!(
            new_tab_for(Disposition::ForegroundTab, "https://a.dev/x"),
            Some(NewTabRequest {
                url: "https://a.dev/x".into(),
                background: false
            })
        );
        assert_eq!(
            new_tab_for(Disposition::BackgroundTab, "HTTP://localhost:3000"),
            Some(NewTabRequest {
                url: "HTTP://localhost:3000".into(),
                background: true
            })
        );
    }

    #[test]
    fn popups_and_other_schemes_stay_suppressed() {
        assert_eq!(new_tab_for(Disposition::Other, "https://a.dev"), None);
        assert_eq!(new_tab_for(Disposition::ForegroundTab, "about:blank"), None);
        assert_eq!(
            new_tab_for(Disposition::ForegroundTab, "javascript:alert(1)"),
            None
        );
    }
}
