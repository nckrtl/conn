//! Thread links in chat text: finding them, and the title a chip shows for each.
//!
//! A thread link is `conn://thread/<environmentId>/<threadId>` (the older
//! `t3-thread://v2/<environmentId>/<threadId>` still reads). The parser lives in
//! `conn_desktop::control`, one place for both schemes; this module adds what chat needs on top:
//! bare links in prose, the thread directory chips look titles up in, and the chip label.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

pub(crate) use conn_desktop::control::{ThreadLink, format_thread_link, parse_thread_link};

/// How much of a thread id the fallback label shows.
const SHORT_ID_CHARS: usize = 8;

/// The text of a chip whose thread has no title: `Thread 1a2b3c4d`.
#[must_use]
pub(crate) fn short_label(link: &ThreadLink) -> String {
    let short: String = link.thread_id.chars().take(SHORT_ID_CHARS).collect();
    format!("Thread {short}")
}

/// Every thread chat knows, for chip titles: the primary server's and the linked environments'.
#[derive(Clone, Debug, Default)]
pub(crate) struct ThreadDirectory {
    by_thread_id: HashMap<String, Vec<DirectoryEntry>>,
    /// The ids the primary server goes by (its own environment id, its Orbit id).
    primary: Vec<String>,
}

#[derive(Clone, Debug)]
struct DirectoryEntry {
    /// The linked environment the thread lives on; `None` is the primary server.
    environment: Option<String>,
    title: String,
}

/// A thread a link points at, as the directory knows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedThread {
    pub(crate) thread_id: String,
    /// The linked environment it lives on; `None` is the primary server.
    pub(crate) environment: Option<String>,
    pub(crate) title: String,
}

/// A fingerprint of the threads a directory is built from, to rebuild it only when they change.
#[must_use]
pub(crate) fn fingerprint<'a>(
    primary: &[String],
    threads: impl IntoIterator<Item = (&'a str, Option<&'a str>, &'a str)>,
) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    primary.hash(&mut hasher);
    for (id, environment, title) in threads {
        id.hash(&mut hasher);
        environment.hash(&mut hasher);
        title.hash(&mut hasher);
    }
    hasher.finish()
}

impl ThreadDirectory {
    /// The directory of `threads` as `(id, linked environment, title)`.
    pub(crate) fn new<'a>(
        primary: Vec<String>,
        threads: impl IntoIterator<Item = (&'a str, Option<&'a str>, &'a str)>,
    ) -> Self {
        let mut by_thread_id: HashMap<String, Vec<DirectoryEntry>> = HashMap::new();
        for (id, environment, title) in threads {
            by_thread_id
                .entry(id.to_owned())
                .or_default()
                .push(DirectoryEntry {
                    environment: environment.map(str::to_owned),
                    title: title.trim().to_owned(),
                });
        }
        Self {
            by_thread_id,
            primary,
        }
    }

    /// The thread `link` names. A thread on the link's own environment wins. Else a thread id
    /// held once anywhere stands in, since ids are unique and a link may carry the id the server
    /// went by before it was linked (and a `v1` link names no environment at all).
    #[must_use]
    pub(crate) fn resolve(&self, link: &ThreadLink) -> Option<ResolvedThread> {
        let entries = self.by_thread_id.get(&link.thread_id)?;
        let on_environment = link.environment_id.as_deref().and_then(|wanted| {
            entries.iter().find(|entry| match &entry.environment {
                Some(environment) => environment == wanted,
                None => self.primary.iter().any(|id| id == wanted),
            })
        });
        let only = match entries.as_slice() {
            [only] => Some(only),
            _ => None,
        };
        let entry = on_environment.or(only)?;
        Some(ResolvedThread {
            thread_id: link.thread_id.clone(),
            environment: entry.environment.clone(),
            title: entry.title.clone(),
        })
    }
}

/// What a chip says for `link`: the thread's current title; else the link's own text when it has
/// one (`[Title](conn://thread/…)`, which is not the link spelled out); else `Thread <short id>`.
#[must_use]
pub(crate) fn chip_label(
    directory: Option<&ThreadDirectory>,
    link: &ThreadLink,
    written: Option<&str>,
) -> String {
    let title = directory
        .and_then(|directory| directory.resolve(link))
        .map(|thread| thread.title)
        .filter(|title| !title.is_empty());
    if let Some(title) = title {
        return title;
    }
    let written = written
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty() && parse_thread_link(text).is_none());
    written.unwrap_or_else(|| short_label(link))
}

/// A run of prose: plain text, or a thread link written out in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProsePart {
    Text(String),
    ThreadLink(String),
}

const BARE_SCHEMES: [&str; 3] = ["conn://thread/", "t3-thread://v2/", "t3-thread://v1/"];

/// Splits `text` around the thread links written out in it (a bare `conn://thread/e/t`). A link
/// ends where whitespace or a bracket does; a sentence's closing punctuation stays out of it.
/// Text with no link comes back as one part.
#[must_use]
pub(crate) fn split_bare_links(text: &str) -> Vec<ProsePart> {
    let mut parts = Vec::new();
    let mut plain_from = 0;
    let mut at = 0;
    while at < text.len() {
        let Some(start) = next_scheme(text, at) else {
            break;
        };
        let after_word = text[..start]
            .chars()
            .next_back()
            .is_none_or(|before| !(before.is_alphanumeric() || matches!(before, '/' | '-' | '_')));
        let end = text[start..]
            .find(conn_desktop::control::is_thread_link_terminator)
            .map_or(text.len(), |offset| start + offset);
        let candidate = text[start..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ']']);
        if after_word && parse_thread_link(candidate).is_some() {
            if plain_from < start {
                parts.push(ProsePart::Text(text[plain_from..start].to_owned()));
            }
            parts.push(ProsePart::ThreadLink(candidate.to_owned()));
            plain_from = start + candidate.len();
            at = plain_from;
        } else {
            at = start + 1;
        }
    }
    if plain_from < text.len() {
        parts.push(ProsePart::Text(text[plain_from..].to_owned()));
    }
    parts
}

/// The byte offset of the first thread link scheme in `text` from `from`.
fn next_scheme(text: &str, from: usize) -> Option<usize> {
    BARE_SCHEMES
        .iter()
        .filter_map(|scheme| text.get(from..)?.find(scheme).map(|offset| from + offset))
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(environment: Option<&str>, thread: &str) -> ThreadLink {
        ThreadLink {
            environment_id: environment.map(str::to_owned),
            thread_id: thread.to_owned(),
        }
    }

    fn directory() -> ThreadDirectory {
        ThreadDirectory::new(
            vec!["env-main".to_owned(), "orbit-main".to_owned()],
            [
                ("thr-main", None, "  Fix the build "),
                ("thr-remote", Some("env-box"), "Port the parser"),
                ("thr-untitled", None, "   "),
                ("thr-twin", None, "Twin on main"),
                ("thr-twin", Some("env-box"), "Twin on box"),
            ],
        )
    }

    #[test]
    fn both_schemes_name_the_same_thread() {
        assert_eq!(
            parse_thread_link("conn://thread/env-main/thr-main"),
            parse_thread_link("t3-thread://v2/env-main/thr-main"),
        );
    }

    #[test]
    fn a_chip_shows_the_stores_title_not_the_written_text() {
        let label = chip_label(
            Some(&directory()),
            &link(Some("env-main"), "thr-main"),
            Some("An old title"),
        );
        assert_eq!(label, "Fix the build");
    }

    #[test]
    fn a_linked_environments_thread_resolves_on_its_environment() {
        let found = directory()
            .resolve(&link(Some("env-box"), "thr-remote"))
            .unwrap();
        assert_eq!(found.environment.as_deref(), Some("env-box"));
        assert_eq!(found.title, "Port the parser");
    }

    #[test]
    fn the_links_environment_picks_between_twin_ids() {
        let directory = directory();
        let on_box = directory
            .resolve(&link(Some("env-box"), "thr-twin"))
            .unwrap();
        let on_main = directory
            .resolve(&link(Some("orbit-main"), "thr-twin"))
            .unwrap();
        assert_eq!(on_box.title, "Twin on box");
        assert_eq!(on_main.title, "Twin on main");
        // No environment and two threads: no guess.
        assert_eq!(directory.resolve(&link(None, "thr-twin")), None);
    }

    #[test]
    fn a_thread_id_held_once_resolves_whatever_environment_the_link_names() {
        let directory = directory();
        assert!(directory.resolve(&link(None, "thr-main")).is_some());
        assert!(
            directory
                .resolve(&link(Some("env-old-name"), "thr-main"))
                .is_some()
        );
        assert_eq!(directory.resolve(&link(Some("env-main"), "thr-gone")), None);
    }

    #[test]
    fn the_label_falls_back_to_the_written_text_then_a_short_id() {
        let unknown = link(Some("env-main"), "0123456789abcdef");
        assert_eq!(
            chip_label(Some(&directory()), &unknown, Some("  Handoff \n notes ")),
            "Handoff notes"
        );
        assert_eq!(
            chip_label(Some(&directory()), &unknown, None),
            "Thread 01234567"
        );
        assert_eq!(chip_label(None, &unknown, Some("")), "Thread 01234567");
        // The link spelled out is not a title.
        assert_eq!(
            chip_label(
                None,
                &unknown,
                Some("conn://thread/env-main/0123456789abcdef")
            ),
            "Thread 01234567"
        );
        // A thread without a title falls back too.
        assert_eq!(
            chip_label(
                Some(&directory()),
                &link(None, "thr-untitled"),
                Some("Written")
            ),
            "Written"
        );
    }

    #[test]
    fn the_short_label_handles_short_and_multibyte_ids() {
        assert_eq!(short_label(&link(None, "abc")), "Thread abc");
        assert_eq!(short_label(&link(None, "éééééééééé")), "Thread éééééééé");
    }

    #[test]
    fn bare_links_split_out_of_prose() {
        assert_eq!(
            split_bare_links("See conn://thread/e1/t1, then t3-thread://v2/e2/t2."),
            vec![
                ProsePart::Text("See ".to_owned()),
                ProsePart::ThreadLink("conn://thread/e1/t1".to_owned()),
                ProsePart::Text(", then ".to_owned()),
                ProsePart::ThreadLink("t3-thread://v2/e2/t2".to_owned()),
                ProsePart::Text(".".to_owned()),
            ]
        );
    }

    #[test]
    fn a_link_alone_is_one_part_and_prose_alone_stays_whole() {
        assert_eq!(
            split_bare_links("conn://thread/e1/t1"),
            vec![ProsePart::ThreadLink("conn://thread/e1/t1".to_owned())]
        );
        assert_eq!(
            split_bare_links("nothing to see"),
            vec![ProsePart::Text("nothing to see".to_owned())]
        );
        assert_eq!(split_bare_links(""), Vec::new());
    }

    #[test]
    fn bare_links_stop_at_brackets_and_skip_what_is_not_a_link() {
        assert_eq!(
            split_bare_links("(conn://thread/e1/t1) and conn://thread/only-one"),
            vec![
                ProsePart::Text("(".to_owned()),
                ProsePart::ThreadLink("conn://thread/e1/t1".to_owned()),
                ProsePart::Text(") and conn://thread/only-one".to_owned()),
            ]
        );
        // Inside a longer URL it is not a link of its own.
        assert_eq!(
            split_bare_links("https://x.test/?next=/conn://thread/e1/t1"),
            vec![ProsePart::Text(
                "https://x.test/?next=/conn://thread/e1/t1".to_owned()
            )]
        );
    }

    #[test]
    fn the_fingerprint_changes_with_a_title_or_the_primary_ids() {
        let primary = vec!["env-main".to_owned()];
        let a = fingerprint(&primary, [("t", None, "One")]);
        assert_eq!(a, fingerprint(&primary, [("t", None, "One")]));
        assert_ne!(a, fingerprint(&primary, [("t", None, "Two")]));
        assert_ne!(a, fingerprint(&["other".to_owned()], [("t", None, "One")]));
    }
}
