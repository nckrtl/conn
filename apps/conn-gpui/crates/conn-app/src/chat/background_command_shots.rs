//! Env-gated offscreen renders of the background command card, before (the divider pill) and
//! after (the command card).

use std::path::Path;

use conn_state::{
    BackgroundCommandOutcome, BackgroundWorkItem, BackgroundWorkKind, ItemStatus, NoticeLevel,
    ThreadState, TimelineEntry,
};

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
    let card = |id: &str, label: &str, outcome, exit_code: Option<i64>, detail: Option<&str>| {
        let verb = match outcome {
            Finished => "finished",
            Failed => "failed",
            Stopped => "was stopped",
        };
        let suffix = exit_code.map_or_else(String::new, |code| format!(" (exit {code})"));
        TimelineEntry::BackgroundCommand {
            id: id.to_owned(),
            summary: format!("Command \"{label}\" {verb}{suffix}"),
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

const BUILD: &str = "Build baseline server with fake provider";
const CHECK: &str = "Run server tools/check.sh";

/// The several-work notices of the multi-command card, as `(id, summary, card)`.
fn several() -> Vec<(&'static str, String, TimelineEntry)> {
    use BackgroundCommandOutcome::{Failed, Finished};
    use BackgroundWorkKind::{Command, Monitor};
    let item = |kind, label: &str, exit_code| BackgroundWorkItem {
        kind,
        label: Some(label.to_owned()),
        exit_code,
    };
    let work = |id: &str, summary: &str, outcome, kind, items: Vec<BackgroundWorkItem>| {
        TimelineEntry::BackgroundWork {
            id: id.to_owned(),
            summary: summary.to_owned(),
            outcome,
            count: items.len(),
            kind,
            items,
            detail: None,
        }
    };
    let three = format!("Command \"{BUILD}\", command \"{BUILD}\" and command \"{CHECK}\" failed");
    let two = "Command \"make\" (exit 0) and command \"npm test\" (exit 2) failed".to_owned();
    let mixed = "Command \"cargo build --release\" and monitor \"CI checks\" finished".to_owned();
    vec![
        (
            "bg-three",
            three.clone(),
            work(
                "bg-three",
                &three,
                Failed,
                Some(Command),
                vec![
                    item(Command, BUILD, None),
                    item(Command, BUILD, None),
                    item(Command, CHECK, None),
                ],
            ),
        ),
        (
            "bg-two",
            two.clone(),
            work(
                "bg-two",
                &two,
                Failed,
                Some(Command),
                vec![
                    item(Command, "make", Some(0)),
                    item(Command, "npm test", Some(2)),
                ],
            ),
        ),
        (
            "bg-mixed",
            mixed.clone(),
            work(
                "bg-mixed",
                &mixed,
                Finished,
                None,
                vec![
                    item(Command, "cargo build --release", None),
                    item(Monitor, "CI checks", None),
                ],
            ),
        ),
    ]
}

fn several_before() -> ThreadState {
    base(
        several()
            .into_iter()
            .map(|(id, summary, _)| TimelineEntry::Notice {
                id: id.to_owned(),
                text: summary,
                level: NoticeLevel::Info,
            })
            .collect(),
    )
}

fn several_after() -> ThreadState {
    base(several().into_iter().map(|(_, _, card)| card).collect())
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
    render_pngs(dir, "multi-before", &several_before, &|_, _| {});
    render_pngs(dir, "multi-after", &several_after, &|_, _| {});
    render_pngs(dir, "multi-after-expanded", &several_after, &|chat, cx| {
        chat.toggle_expanded("bg-three", cx);
    });
}
