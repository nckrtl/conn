//! Shell events at fleet scale: a burst of shell items merges the linked shells at most once,
//! a linked change updates the merged list in place, the offline cache watches only threads
//! whose stream can change, and its incremental expiry and watches match a full sweep.
//!
//! `shell_event_bench` (ignored) times one batch on a 4,800-thread fleet shaped like Nick's:
//! `cargo test --release -p conn-app --bin conn-app shell_event_bench -- --ignored --nocapture`.

use conn_cache::MessageCache;
use conn_client::ClientEvent;
use conn_contract::from_json;
use conn_state::{ShellState, ShellStreamItem};
use gpui_kit::{Entity, TestAppContext};
use serde_json::{Value, json};

use super::ConnApp;
use crate::live::RT;
use crate::ui_tests::mount_app;

const PRIMARY: &str = "http://primary.test";
const HOUR_MS: i64 = 60 * 60 * 1000;

fn now_ms() -> i64 {
    i64::try_from(super::now_ms()).unwrap_or(i64::MAX)
}

/// `ms` since the epoch as an RFC 3339 timestamp.
fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's days-to-civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        ms.rem_euclid(1000)
    )
}

/// How a fixture thread stands.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Run {
    Idle,
    Running,
    Completed,
}

/// The wire JSON of a thread. `parent` makes it a subagent; `settled_hours_ago` settles it.
fn thread_json(
    id: &str,
    project: &str,
    parent: Option<&str>,
    run: Run,
    settled_hours_ago: Option<i64>,
    updated_ms: i64,
) -> Value {
    let settled_at = settled_hours_ago.map(|hours| iso(now_ms() - hours * HOUR_MS));
    json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": id,
        "projectId": project,
        "title": format!("Thread {id}"),
        "providerInstanceId": "claude-default",
        "modelSelection": { "provider": "claude", "model": "claude-sonnet-4-6" },
        "runtimeMode": "auto-accept-edits",
        "interactionMode": "default",
        "branch": "main",
        "worktreePath": null,
        "lineage": {
            "parentThreadId": parent,
            "relationshipToParent": parent.map(|_| "subagent"),
            "rootThreadId": parent.unwrap_or(id)
        },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": "run-1",
        "activeRunId": null,
        "activityRunStatus": null,
        "status": match run {
            Run::Idle => "idle",
            Run::Running => "running",
            Run::Completed => "completed",
        },
        "pendingRuntimeRequest": null,
        "latestVisibleMessage": null,
        "latestUserMessageAt": null,
        "hasActionableProposedPlan": false,
        "itemCount": 2,
        "visibleItemCount": 2,
        "pinnedAt": null,
        "pinOrderKey": null,
        "settledOverride": settled_at.as_ref().map(|_| "settled"),
        "settledAt": settled_at,
        "archivedAt": null,
        "lastVisitedAt": null,
        "createdAt": iso(updated_ms - HOUR_MS),
        "updatedAt": iso(updated_ms),
    })
}

fn project_json(id: &str) -> Value {
    json!({
        "id": id, "title": id, "workspaceRoot": format!("/work/{id}"),
        "defaultModelSelection": null, "scripts": [],
        "createdAt": "2026-11-01T09:00:00.000Z", "updatedAt": "2026-11-01T09:00:00.000Z"
    })
}

fn snapshot(project: &str, threads: Vec<Value>) -> ShellStreamItem {
    from_json(json!({
        "kind": "snapshot",
        "snapshot": {
            "schemaVersion": 1,
            "snapshotSequence": 1,
            "projects": [project_json(project)],
            "threads": threads,
            "archivedThreads": []
        }
    }))
    .expect("snapshot decodes")
}

fn updated(sequence: i64, thread: Value) -> ShellStreamItem {
    from_json(json!({
        "kind": "thread.updated", "sequence": sequence, "location": "active", "thread": thread
    }))
    .expect("update decodes")
}

fn removed(sequence: i64, id: &str) -> ShellStreamItem {
    from_json(json!({
        "kind": "thread.removed", "sequence": sequence, "location": "active", "threadId": id
    }))
    .expect("removal decodes")
}

/// The shape of one environment's shell.
struct EnvShape {
    prefix: &'static str,
    top_level: usize,
    top_level_unsettled: usize,
    children: usize,
    children_running: usize,
    children_completed_unsettled: usize,
}

/// When the `n`th settled fixture thread settled: one in three within the last day, the rest
/// up to two months ago.
fn settled_hours_ago(n: usize) -> i64 {
    let n = i64::try_from(n).unwrap_or(0);
    if n % 3 == 0 {
        1 + n % 20
    } else {
        30 + n % 1400
    }
}

/// One environment's threads: top-level threads (a few unsettled, two of them running) and
/// subagents under the unsettled ones (some running, some finished but unsettled, the rest
/// settled). Settle times spread over two months, so most have passed their 24 hours.
fn env_threads(shape: &EnvShape) -> Vec<Value> {
    let now = now_ms();
    let project = format!("p-{}", shape.prefix);
    let mut threads = Vec::with_capacity(shape.top_level + shape.children);
    for n in 0..shape.top_level {
        let id = format!("{}-top-{n}", shape.prefix);
        let unsettled = n < shape.top_level_unsettled;
        let run = if unsettled && n < 2 {
            Run::Running
        } else {
            Run::Idle
        };
        let settled = (!unsettled).then(|| settled_hours_ago(n));
        threads.push(thread_json(
            &id,
            &project,
            None,
            run,
            settled,
            now - i64::try_from(n).unwrap_or(0) * 60_000,
        ));
    }
    let parents = shape.top_level_unsettled.max(1);
    for n in 0..shape.children {
        let id = format!("{}-child-{n}", shape.prefix);
        let parent = format!("{}-top-{}", shape.prefix, n % parents);
        let (run, settled) = if n < shape.children_running {
            (Run::Running, None)
        } else if n < shape.children_running + shape.children_completed_unsettled {
            (Run::Completed, None)
        } else {
            (Run::Completed, Some(settled_hours_ago(n)))
        };
        threads.push(thread_json(
            &id,
            &project,
            Some(&parent),
            run,
            settled,
            now - i64::try_from(n).unwrap_or(0) * 30_000,
        ));
    }
    threads
}

/// Nick's fleet as the reviews counted it: a primary shell of 3,074 threads (2,956 subagents,
/// 417 unsettled, 398 of those finished subagents) and linked shells of 1,710, 35 and 10.
fn fleet() -> (EnvShape, Vec<(&'static str, EnvShape)>) {
    (
        EnvShape {
            prefix: "nick",
            top_level: 118,
            top_level_unsettled: 19,
            children: 2956,
            children_running: 23,
            children_completed_unsettled: 375,
        },
        vec![
            (
                "mini",
                EnvShape {
                    prefix: "mini",
                    top_level: 160,
                    top_level_unsettled: 40,
                    children: 1550,
                    children_running: 9,
                    children_completed_unsettled: 70,
                },
            ),
            (
                "vm",
                EnvShape {
                    prefix: "vm",
                    top_level: 20,
                    top_level_unsettled: 12,
                    children: 15,
                    children_running: 2,
                    children_completed_unsettled: 12,
                },
            ),
            (
                "studio",
                EnvShape {
                    prefix: "studio",
                    top_level: 6,
                    top_level_unsettled: 3,
                    children: 4,
                    children_running: 0,
                    children_completed_unsettled: 2,
                },
            ),
        ],
    )
}

/// A small fleet of the same shape, for the behaviour tests.
fn small_fleet() -> (EnvShape, Vec<(&'static str, EnvShape)>) {
    let shape = |prefix| EnvShape {
        prefix,
        top_level: 8,
        top_level_unsettled: 4,
        children: 12,
        children_running: 2,
        children_completed_unsettled: 4,
    };
    (
        shape("nick"),
        vec![("mini", shape("mini")), ("vm", shape("vm"))],
    )
}

/// Mounts the app on `fleet`, with the offline cache on, and returns its cache directory.
fn mount_fleet(
    cx: &mut TestAppContext,
    (primary, linked): (EnvShape, Vec<(&'static str, EnvShape)>),
) -> (Entity<ConnApp>, tempfile::TempDir) {
    let (_, app) = mount_app(cx);
    let cache = tempfile::tempdir().expect("cache directory");
    let db = RT
        .block_on(MessageCache::open(&cache.path().join("messages.sqlite3")))
        .expect("cache");
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.server_url = Some(PRIMARY.to_owned());
            app.offline.enable_for_test(cache.path().to_owned(), db);
            for (env, shape) in &linked {
                let mut shell = ShellState::default();
                shell.apply(snapshot(&format!("p-{env}"), env_threads(shape)));
                app.add_linked_shell_for_test(env, env, shell, cx);
            }
            let primary_snapshot = snapshot("p-nick", env_threads(&primary));
            app.apply_batch_for_test(vec![ClientEvent::Shell(primary_snapshot)], cx);
        });
    });
    (app, cache)
}

fn counts(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> super::linked::MergeCounts {
    cx.read(|cx| app.read(cx).merge_counts_for_test())
}

fn title(cx: &mut TestAppContext, app: &Entity<ConnApp>, id: &str) -> Option<String> {
    cx.read(|cx| app.read(cx).shell.find_thread(id).map(|t| t.title.clone()))
}

fn renamed(id: &str, project: &str, title: &str) -> Value {
    let mut thread = thread_json(id, project, None, Run::Running, None, now_ms());
    thread["title"] = json!(title);
    thread
}

#[gpui_kit::test]
fn a_burst_of_primary_shell_items_merges_the_linked_shells_at_most_once(cx: &mut TestAppContext) {
    let (app, _cache) = mount_fleet(cx, small_fleet());
    for expanded in [false, true] {
        cx.update(|cx| app.update(cx, |app, _| app.sidebar.settled_expanded = expanded));
        let before = counts(cx, &app);
        // Five updates of threads only the primary holds: the merged shell takes them in place.
        let burst: Vec<ClientEvent> = (0..5)
            .map(|n| {
                let id = format!("nick-top-{n}");
                let mut thread = renamed(&id, "p-nick", &format!("renamed {n}"));
                thread["updatedAt"] = json!(iso(now_ms() + (n + 1) * 60_000));
                ClientEvent::Shell(updated(100 + n, thread))
            })
            .collect();
        cx.update(|cx| app.update(cx, |app, cx| app.apply_batch_for_test(burst, cx)));
        assert_eq!(
            counts(cx, &app).full,
            before.full,
            "no merge for primary-only changes (shelf open: {expanded})"
        );
        assert_eq!(title(cx, &app, "nick-top-3").as_deref(), Some("renamed 3"));
        assert!(
            title(cx, &app, "mini-top-1").is_some(),
            "linked rows stay listed"
        );
        let first = cx.read(|cx| app.read(cx).shell.threads[0].id.clone());
        assert_eq!(first, "nick-top-4", "the latest update sorts first");
    }

    // A snapshot in a burst merges once, however many items follow it.
    let before = counts(cx, &app);
    let (primary, _) = small_fleet();
    let mut burst = vec![ClientEvent::Shell(snapshot(
        "p-nick",
        env_threads(&primary),
    ))];
    burst.extend((0..3).map(|n| {
        ClientEvent::Shell(updated(
            200 + n,
            renamed("nick-top-0", "p-nick", &format!("again {n}")),
        ))
    }));
    cx.update(|cx| app.update(cx, |app, cx| app.apply_batch_for_test(burst, cx)));
    assert_eq!(
        counts(cx, &app).full,
        before.full + 1,
        "one merge per burst"
    );
    assert_eq!(title(cx, &app, "nick-top-0").as_deref(), Some("again 2"));
    assert!(title(cx, &app, "vm-child-3").is_some());

    // A primary change to a thread a linked environment also holds lets the merge decide.
    let before = counts(cx, &app);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.apply_batch_for_test(
                vec![ClientEvent::Shell(updated(
                    300,
                    renamed("mini-top-2", "p-nick", "collides"),
                ))],
                cx,
            );
        });
    });
    assert_eq!(counts(cx, &app).full, before.full + 1);
}

#[gpui_kit::test]
fn a_linked_shell_change_updates_the_merged_list_in_place(cx: &mut TestAppContext) {
    let (app, _cache) = mount_fleet(cx, small_fleet());
    cx.update(|cx| app.update(cx, |app, _| app.sidebar.settled_expanded = true));
    let before = counts(cx, &app);
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.apply_linked_shell_batch_for_test(
                "mini",
                vec![
                    updated(10, renamed("mini-top-1", "p-mini", "mini renamed")),
                    updated(11, renamed("mini-new", "p-mini", "mini new")),
                    removed(12, "mini-top-3"),
                ],
                cx,
            );
        });
    });
    let after = counts(cx, &app);
    assert_eq!(after.full, before.full, "no full merge, shelf open or not");
    assert_eq!(
        after.in_place,
        before.in_place + 1,
        "one update for the batch"
    );
    assert_eq!(
        title(cx, &app, "mini-top-1").as_deref(),
        Some("mini renamed")
    );
    assert_eq!(title(cx, &app, "mini-new").as_deref(), Some("mini new"));
    assert!(title(cx, &app, "mini-top-3").is_none(), "the removal shows");
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test("mini-new")),
        Some("mini".to_owned())
    );

    // A linked thread with the id of a primary one stays hidden behind the primary's copy.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.apply_linked_shell_batch_for_test(
                "vm",
                vec![updated(13, renamed("nick-top-1", "p-vm", "vm's copy"))],
                cx,
            );
        });
    });
    assert_eq!(
        title(cx, &app, "nick-top-1").as_deref(),
        Some("Thread nick-top-1")
    );
    assert_eq!(
        cx.read(|cx| app.read(cx).thread_environment_for_test("nick-top-1")),
        None
    );
}

fn desired(cx: &mut TestAppContext, app: &Entity<ConnApp>) -> Vec<(String, String)> {
    cx.read(|cx| app.read(cx).offline.desired_for_test())
}

fn watched(desired: &[(String, String)], id: &str) -> bool {
    desired.iter().any(|(_, thread)| thread == id)
}

#[gpui_kit::test]
fn the_cache_watches_unsettled_threads_and_live_children_only(cx: &mut TestAppContext) {
    let (app, _cache) = mount_fleet(cx, small_fleet());
    let watching = desired(cx, &app);
    // Per environment: 4 unsettled top-level threads and 2 running children; the 4 finished
    // children and every settled thread are not watched.
    assert_eq!(watching.len(), 3 * 6, "{watching:#?}");
    assert!(watched(&watching, "nick-top-0"));
    assert!(watched(&watching, "nick-child-1"), "a running child");
    assert!(!watched(&watching, "nick-child-2"), "a finished child");
    assert!(!watched(&watching, "nick-top-5"), "a settled thread");
    assert!(watched(&watching, "mini-child-0"), "a linked running child");

    // A child finishes: it stays watched while its last items may arrive, and its watch ends
    // once they are saved (`a_subagent_that_just_finished_keeps_its_last_message_offline`). A
    // finished child runs again: it is watched again.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let done = thread_json(
                "nick-child-1",
                "p-nick",
                Some("nick-top-1"),
                Run::Completed,
                None,
                now_ms(),
            );
            let again = thread_json(
                "nick-child-2",
                "p-nick",
                Some("nick-top-2"),
                Run::Running,
                None,
                now_ms(),
            );
            app.apply_batch_for_test(
                vec![
                    ClientEvent::Shell(updated(50, done)),
                    ClientEvent::Shell(updated(51, again)),
                ],
                cx,
            );
        });
    });
    let watching = desired(cx, &app);
    assert!(
        watched(&watching, "nick-child-1"),
        "kept for its last items"
    );
    assert!(watched(&watching, "nick-child-2"));
    assert_eq!(watching.len(), 3 * 6 + 1);
    settle_after(cx, &app, std::time::Duration::from_secs(31));
    let watching = desired(cx, &app);
    assert!(!watched(&watching, "nick-child-1"), "a finished child");
    assert!(watched(&watching, "nick-child-2"));
    assert_eq!(watching.len(), 3 * 6);
}

/// Looks at the children that finished as the clock stands `after` from now.
fn settle_after(cx: &mut TestAppContext, app: &Entity<ConnApp>, after: std::time::Duration) {
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.settle_finishing_at(std::time::Instant::now() + after, cx);
        })
    });
}

fn finish(cx: &mut TestAppContext, app: &Entity<ConnApp>, id: &str, parent: &str) {
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            let done = thread_json(id, "p-nick", Some(parent), Run::Completed, None, now_ms());
            app.apply_batch_for_test(vec![ClientEvent::Shell(updated(50, done))], cx);
        });
    });
}

/// The shell reports a subagent completed before its final message reaches the cache. The
/// cache keeps following it, saves the message, and then drops the watch.
#[gpui_kit::test]
fn a_subagent_that_just_finished_keeps_its_last_message_offline(cx: &mut TestAppContext) {
    use super::reconnect_tests::thread_snapshot;

    let (app, _cache) = mount_fleet(cx, small_fleet());
    let id = "nick-child-1";
    // The thread snapshot at `sequence` with `turns` turns; its run has ended when `ended`.
    let stream = |sequence, turns, ended: bool| {
        let mut snapshot = thread_snapshot(id, sequence, turns);
        if ended {
            let run = &mut snapshot["projection"]["runs"][0];
            run["status"] = json!("completed");
            run["completedAt"] = json!("2026-11-13T13:37:20.000Z");
        }
        from_json(snapshot).expect("snapshot")
    };
    cx.update(|cx| {
        app.update(cx, |app, _| {
            app.apply_cache_stream(PRIMARY, id, stream(20, 1, false));
            app.save_offline_now_for_test();
        })
    });
    let before = cx.read(|cx| app.read(cx).cached_rows_for_test(id));
    assert!(before > 0, "the first turn is cached");

    finish(cx, &app, id, "nick-top-1");
    assert!(watched(&desired(cx, &app), id), "still watched");

    // The final message arrives after the status flip, while the stream's run still runs.
    cx.update(|cx| {
        app.update(cx, |app, _| {
            app.apply_cache_stream(PRIMARY, id, stream(21, 2, false));
            app.save_offline_now_for_test();
        })
    });
    settle_after(cx, &app, std::time::Duration::from_secs(3));
    assert!(
        watched(&desired(cx, &app), id),
        "the stream has not shown the run end"
    );

    // The run ends. Unsaved, it holds the watch.
    cx.update(|cx| {
        app.update(cx, |app, _| {
            app.apply_cache_stream(PRIMARY, id, stream(22, 2, true))
        })
    });
    settle_after(cx, &app, std::time::Duration::from_secs(3));
    assert!(watched(&desired(cx, &app), id), "the end is unsaved");

    // Saved: the watch ends, and the cache holds the message.
    cx.update(|cx| app.update(cx, |app, _| app.save_offline_now_for_test()));
    settle_after(cx, &app, std::time::Duration::from_secs(3));
    assert!(!watched(&desired(cx, &app), id), "no longer watched");
    let after = cx.read(|cx| app.read(cx).cached_rows_for_test(id));
    assert!(
        after > before,
        "the final message is cached: {before} → {after}"
    );
}

/// A finished subagent whose stream says nothing is not watched for good.
#[gpui_kit::test]
fn a_finished_subagent_with_a_silent_stream_is_dropped_after_a_while(cx: &mut TestAppContext) {
    let (app, _cache) = mount_fleet(cx, small_fleet());
    finish(cx, &app, "nick-child-1", "nick-top-1");
    settle_after(cx, &app, std::time::Duration::from_secs(3));
    assert!(
        watched(&desired(cx, &app), "nick-child-1"),
        "within the grace"
    );
    settle_after(cx, &app, std::time::Duration::from_secs(31));
    assert!(
        !watched(&desired(cx, &app), "nick-child-1"),
        "past the grace"
    );
}

/// After `step`, the incremental expiry and watches hold what a full sweep decides.
fn assert_matches_sweep(cx: &mut TestAppContext, app: &Entity<ConnApp>, step: &str) {
    let incremental = cx.read(|cx| {
        let app = app.read(cx);
        (
            app.offline.expiry_for_test(),
            app.offline.desired_for_test(),
        )
    });
    let swept = cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.offline.note_all_threads();
            app.offline_follow_shell(cx);
            (
                app.offline.expiry_for_test(),
                app.offline.desired_for_test(),
            )
        })
    });
    assert_eq!(incremental, swept, "after {step}");
}

#[gpui_kit::test]
fn incremental_expiry_and_watches_match_a_full_sweep(cx: &mut TestAppContext) {
    let (app, _cache) = mount_fleet(cx, small_fleet());
    assert_matches_sweep(cx, &app, "the snapshot");
    let (expired, deadlines) = cx.read(|cx| {
        let (deadlines, expired) = app.read(cx).offline.expiry_for_test();
        (expired.len(), deadlines.len())
    });
    assert!(expired > 0, "settled more than a day ago");
    assert!(deadlines > 0, "settled less than a day ago");

    let steps: Vec<(&str, Vec<ShellStreamItem>)> = vec![
        (
            "a thread settles two days ago",
            vec![updated(
                60,
                thread_json("nick-top-0", "p-nick", None, Run::Idle, Some(48), now_ms()),
            )],
        ),
        (
            "an expired thread is unsettled",
            vec![updated(
                61,
                thread_json("nick-top-5", "p-nick", None, Run::Idle, None, now_ms()),
            )],
        ),
        (
            "a thread settles an hour ago and another is removed",
            vec![
                updated(
                    62,
                    thread_json("nick-top-1", "p-nick", None, Run::Idle, Some(1), now_ms()),
                ),
                removed(63, "nick-top-6"),
            ],
        ),
    ];
    for (step, items) in steps {
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.apply_batch_for_test(items.into_iter().map(ClientEvent::Shell).collect(), cx);
            });
        });
        assert_matches_sweep(cx, &app, step);
    }

    // A linked environment's change goes the same way.
    cx.update(|cx| {
        app.update(cx, |app, cx| {
            app.apply_linked_shell_batch_for_test(
                "mini",
                vec![
                    updated(
                        70,
                        thread_json("mini-top-0", "p-mini", None, Run::Idle, Some(30), now_ms()),
                    ),
                    updated(
                        71,
                        thread_json(
                            "mini-child-3",
                            "p-mini",
                            Some("mini-top-3"),
                            Run::Running,
                            None,
                            now_ms(),
                        ),
                    ),
                ],
                cx,
            );
        });
    });
    assert_matches_sweep(cx, &app, "a linked change");
}

/// One batch on Nick's fleet: how often it merges, how long it takes and how many streams the
/// cache watches.
#[gpui_kit::test]
#[ignore = "bench: run with --release --ignored --nocapture"]
fn shell_event_bench(cx: &mut TestAppContext) {
    let (app, _cache) = mount_fleet(cx, fleet());
    cx.update(|cx| app.update(cx, |app, _| app.sidebar.settled_expanded = true));
    let (threads, watching) = cx.read(|cx| {
        let app = app.read(cx);
        (
            app.shell.threads.len(),
            app.offline.desired_for_test().len(),
        )
    });
    println!("merged threads: {threads}");
    println!("watched streams: {watching}");
    const ROUNDS: i64 = 50;
    let start = std::time::Instant::now();
    let listed = cx.read(|cx| {
        let app = app.read(cx);
        let mut listed = 0;
        for _ in 0..ROUNDS {
            listed =
                crate::sidebar::thread_list::sidebar_lists(&app.shell, &[], None, "", &[], None)
                    .listed_settled
                    .len();
        }
        listed
    });
    println!(
        "{:<40} {:>8.3} ms/call  ({listed} settled rows listed)",
        "sidebar_lists",
        start.elapsed().as_secs_f64() * 1000.0 / ROUNDS as f64
    );
    let mut time_batch = |label: &str, linked: Option<&str>| {
        let before = counts(cx, &app);
        let start = std::time::Instant::now();
        for round in 0..ROUNDS {
            cx.update(|cx| {
                app.update(cx, |app, cx| match linked {
                    None => {
                        let thread = renamed("nick-top-0", "p-nick", &format!("round {round}"));
                        app.apply_batch_for_test(
                            vec![ClientEvent::Shell(updated(1000 + round, thread))],
                            cx,
                        );
                    }
                    Some(env) => {
                        let id = format!("{env}-top-0");
                        let thread = renamed(&id, &format!("p-{env}"), &format!("round {round}"));
                        app.apply_linked_shell_batch_for_test(
                            env,
                            vec![updated(1000 + round, thread)],
                            cx,
                        );
                    }
                });
            });
        }
        let per = start.elapsed().as_secs_f64() * 1000.0 / ROUNDS as f64;
        let after = counts(cx, &app);
        println!(
            "{label:<40} {per:>8.3} ms/batch  full merges/batch {:.2}  in-place/batch {:.2}",
            (after.full - before.full) as f64 / ROUNDS as f64,
            (after.in_place - before.in_place) as f64 / ROUNDS as f64,
        );
    };
    time_batch("primary: one thread.updated", None);
    time_batch("linked (1,710 threads): one thread.updated", Some("mini"));
    time_batch("linked (35 threads): one thread.updated", Some("vm"));
}
