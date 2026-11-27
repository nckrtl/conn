//! Where a thread's terminal runs, and which session belongs to which thread.
//!
//! A terminal belongs to the thread on screen. A thread on this Mac's own server gets a local
//! PTY. A thread on a linked environment (or on a primary server that runs elsewhere) gets a
//! shell on that machine, through that connection's `terminal.*` RPCs (T3 Conn's terminal
//! protocol). Sessions are keyed by environment and thread, so one thread's terminal never shows
//! on another.

use conn_contract::TerminalAttachInput;

/// The id T3 Conn gives a thread's first terminal (`DEFAULT_THREAD_TERMINAL_ID`).
pub(crate) const DEFAULT_TERMINAL_ID: &str = "term-1";

/// The most characters one `terminal.write` may carry: the contract allows 65 536 UTF-16 units.
const WRITE_CHUNK_CHARS: usize = 16_384;

/// Which terminal session a thread owns: its environment (`None`: the primary one) and the thread
/// (or draft) it belongs to. `thread` is `None` before any thread is open.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) struct SessionKey {
    pub(crate) environment: Option<String>,
    pub(crate) thread: Option<String>,
}

/// What the terminal should show now: the thread's machine, folder and label.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TerminalTarget {
    pub(crate) key: SessionKey,
    /// The thread's worktree or workspace root on its own machine.
    pub(crate) cwd: Option<String>,
    /// The machine's name, for the header (`Terminal · agent`).
    pub(crate) label: Option<String>,
    /// The shell runs on the thread's server through its connection, not on this Mac.
    pub(crate) remote: bool,
}

/// Whether the primary server at `url` runs on this Mac. An unknown address counts as local, as
/// the terminal did before it followed the thread.
pub(crate) fn is_local_server_url(url: Option<&str>) -> bool {
    let Some(host) = url
        .and_then(|url| url::Url::parse(url).ok())
        .and_then(|url| url.host_str().map(str::to_owned))
    else {
        return true;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The tab title: `Terminal`, or `Terminal · agent` when the machine is known.
pub(crate) fn header_title(base: &str, machine: Option<&str>) -> String {
    match machine.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!("{base} · {name}"),
        None => base.to_owned(),
    }
}

/// The `terminal.attach` payload that joins (or starts) the thread's terminal in `cwd`.
pub(crate) fn attach_input(
    thread_id: &str,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> TerminalAttachInput {
    TerminalAttachInput {
        thread_id: thread_id.to_owned(),
        terminal_id: DEFAULT_TERMINAL_ID.to_owned(),
        cwd: cwd.map(str::to_owned),
        worktree_path: None,
        cols: Some(i64::from(cols)),
        rows: Some(i64::from(rows)),
        env: None,
        provider_instance_id: None,
        stop_on_settle: None,
        restart_if_not_running: None,
        resume: None,
        max_history_bytes: None,
    }
}

/// `bytes` as `terminal.write` payloads, none longer than the contract allows and none empty.
pub(crate) fn write_chunks(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0;
    for ch in text.chars() {
        if count == WRITE_CHUNK_CHARS {
            chunks.push(std::mem::take(&mut current));
            count = 0;
        }
        current.push(ch);
        count += 1;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_servers_are_local_and_others_are_not() {
        assert!(is_local_server_url(Some("http://127.0.0.1:3780/")));
        assert!(is_local_server_url(Some("http://localhost:3780")));
        assert!(is_local_server_url(Some("http://[::1]:3780")));
        assert!(is_local_server_url(None));
        assert!(!is_local_server_url(Some("https://agent.example.com")));
        assert!(!is_local_server_url(Some("http://10.0.0.8:3780")));
    }

    #[test]
    fn the_title_names_the_machine() {
        assert_eq!(header_title("Terminal", Some("agent")), "Terminal · agent");
        assert_eq!(header_title("Terminal", Some("  ")), "Terminal");
        assert_eq!(header_title("Terminal", None), "Terminal");
    }

    #[test]
    fn attach_carries_the_thread_folder_and_size() {
        let input = attach_input("thread-1", Some("/srv/work"), 100, 30);
        let json = serde_json::to_value(&input).expect("serialises");
        assert_eq!(json["threadId"], "thread-1");
        assert_eq!(json["terminalId"], DEFAULT_TERMINAL_ID);
        assert_eq!(json["cwd"], "/srv/work");
        assert_eq!(json["cols"], 100);
        assert_eq!(json["rows"], 30);
    }

    #[test]
    fn long_writes_split_on_character_boundaries() {
        assert!(write_chunks(b"").is_empty());
        assert_eq!(write_chunks(b"ls\r"), vec!["ls\r".to_owned()]);
        let long = "é".repeat(WRITE_CHUNK_CHARS * 2 + 5);
        let chunks = write_chunks(long.as_bytes());
        assert_eq!(chunks.len(), 3);
        assert!(
            chunks
                .iter()
                .all(|c| c.chars().count() <= WRITE_CHUNK_CHARS)
        );
        assert_eq!(chunks.concat(), long);
    }
}
