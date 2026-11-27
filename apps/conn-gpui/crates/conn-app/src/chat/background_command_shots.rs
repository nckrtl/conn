//! Env-gated offscreen renders of the background command card, before (the divider pill) and
//! after (the command card).

use std::path::Path;

use conn_state::{BackgroundCommandOutcome, ItemStatus, NoticeLevel, ThreadState, TimelineEntry};

use super::left_align_shots::render_pngs;

const LONG_COMMAND: &str = "L=~/apps/conn-gpui-dev/apps/conn-gpui/.t3/dev-hot.log; N=$(( $(wc -l < $L) + 1 )); until tail -n +$N $L | grep -q 'build finished'; do sleep 2; done";

fn base(entries: Vec<TimelineEntry>) -> ThreadState {
    let mut thread = ThreadState::new("thread-selected");
    thread.synchronized = true;
    let mut all = vec![
        TimelineEntry::User {
            id: "u-1".to_owned(),
            text: "Rebuild the dev app and tell me when it is up.".to_owned(),
            created_by_agent: false,
            sender: None,
            created_at: None,
            attachments: Vec::new(),
            is_steer: false,
            review_comments: Vec::new(),
            run_id: Some("run-1".to_owned()),
        },
        TimelineEntry::Assistant {
            id: "answer-1".to_owned(),
            markdown: "The rebuild runs in the background. I will report when it ends.".to_owned(),
            streaming: false,
            created_at: None,
            run_id: Some("run-1".to_owned()),
            status: ItemStatus::Completed,
        },
    ];
    all.extend(entries);
    thread.entries = all;
    thread
}

fn before() -> ThreadState {
    let pill = |id: &str, text: &str| TimelineEntry::Notice {
        id: id.to_owned(),
        text: text.to_owned(),
        level: NoticeLevel::Info,
    };
    base(vec![
        pill(
            "bg-long",
            &format!("Command \"{}…\" finished", &LONG_COMMAND[..73]),
        ),
        pill("bg-ok", "Command \"Wait for dev app rebuild\" finished"),
        pill("bg-fail", "Command \"npm test\" failed (exit 2)"),
        pill("bg-stopped", "Command \"sleep 600\" was stopped"),
    ])
}

fn after() -> ThreadState {
    use BackgroundCommandOutcome::{Failed, Finished, Stopped};
    let card = |id: &str, label: &str, outcome, exit_code, detail: Option<&str>| {
        TimelineEntry::BackgroundCommand {
            id: id.to_owned(),
            label: Some(label.to_owned()),
            outcome,
            exit_code,
            detail: detail.map(str::to_owned),
        }
    };
    base(vec![
        card(
            "bg-long",
            &format!("{}…", &LONG_COMMAND[..73]),
            Finished,
            None,
            None,
        ),
        card(
            "bg-ok",
            "Wait for dev app rebuild",
            Finished,
            Some(0),
            Some("build finished in 41s\n12 crates compiled, 0 warnings"),
        ),
        card(
            "bg-fail",
            "npm test",
            Failed,
            Some(2),
            Some("1 failing\n  1) adds numbers: expected 3, got 4"),
        ),
        card("bg-stopped", "sleep 600", Stopped, None, None),
    ])
}

/// `CONN_THREAD_SHOTS_DIR=<dir> cargo test -p conn-app render_background_command_screenshots --
/// --ignored`
#[test]
#[ignore = "writes PNGs; set CONN_THREAD_SHOTS_DIR"]
fn render_background_command_screenshots() {
    let Some(dir) = std::env::var_os("CONN_THREAD_SHOTS_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    render_pngs(dir, "before", &before, &|_, _| {});
    render_pngs(dir, "after", &after, &|_, _| {});
    render_pngs(dir, "after-expanded", &after, &|chat, cx| {
        chat.toggle_expanded("bg-ok", cx);
        chat.toggle_expanded("bg-fail", cx);
    });
}
