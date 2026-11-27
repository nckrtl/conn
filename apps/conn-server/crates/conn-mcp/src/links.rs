//! Thread links in tool results. Conn renders `conn://thread/<environmentId>/<threadId>` links as
//! thread chips (it still reads the older `t3-thread://v2/…` form); outside callers get the
//! hosted link, except another environment's peer link, which renders as a chip.

use crate::{Caller, McpConfig};

pub(crate) fn thread_link(
    config: &McpConfig,
    caller: &Caller,
    thread_id: &str,
    title: &str,
) -> String {
    match caller {
        // A peer link is another Conn environment: it renders thread chips too.
        Caller::Thread(_) | Caller::Client(crate::ClientCaller { linked: true, .. }) => {
            chip(&config.environment_id, thread_id, title)
        }
        Caller::Client(_) => format!(
            "{}/threads/{}/{}",
            config.hosted_app_url.trim_end_matches('/'),
            segment(&config.environment_id),
            segment(thread_id)
        ),
    }
}

/// A `conn://thread/<environmentId>/<threadId>` chip for a thread in `environment_id`: a Markdown
/// link labelled with the title, or an autolink when the title is blank.
pub(crate) fn chip(environment_id: &str, thread_id: &str, title: &str) -> String {
    let href = format!("conn://thread/{environment_id}/{thread_id}");
    let destination = if href.contains(['(', ')']) {
        format!("<{href}>")
    } else {
        href.clone()
    };
    let label = title
        .replace(['[', ']', '\\', '\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if label.is_empty() {
        format!("<{href}>")
    } else {
        format!("[{label}]({destination})")
    }
}

/// `encodeURIComponent`, then `.!~*'()` too: a sentence's closing period never joins an id.
fn segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{chip, segment};

    #[test]
    fn chip_is_a_conn_thread_link_labelled_with_the_title() {
        assert_eq!(
            chip("env-1", "thr-1", "Fix the build"),
            "[Fix the build](conn://thread/env-1/thr-1)"
        );
    }

    #[test]
    fn chip_label_drops_brackets_backslashes_and_line_breaks() {
        assert_eq!(
            chip("env-1", "thr-1", "  a [b]\\c\r\nd\t e  "),
            "[a b c d e](conn://thread/env-1/thr-1)"
        );
    }

    #[test]
    fn chip_without_a_title_is_an_autolink() {
        assert_eq!(
            chip("env-1", "thr-1", " \n "),
            "<conn://thread/env-1/thr-1>"
        );
    }

    #[test]
    fn chip_wraps_a_destination_with_parentheses_in_angle_brackets() {
        assert_eq!(
            chip("env-1", "thr(1)", "T"),
            "[T](<conn://thread/env-1/thr(1)>)"
        );
        assert_eq!(chip("env-1", "thr(1)", ""), "<conn://thread/env-1/thr(1)>");
    }

    #[test]
    fn chip_never_uses_the_old_t3_scheme() {
        assert!(!chip("e", "t", "T").contains("t3-thread"));
    }

    #[test]
    fn hosted_segments_escape_punctuation() {
        assert_eq!(segment("thread:a.b"), "thread%3Aa%2Eb");
        assert_eq!(segment("é"), "%C3%A9");
    }
}
