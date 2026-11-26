use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::clock::{Clock, ManualClock};
use crate::store::{Draft, Store};

const T0: u64 = 1_795_000_000_000;

struct Fixture {
    store: Store,
    clock: Arc<ManualClock>,
    path: std::path::PathBuf,
    thread: Value,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-shm"));
    }
}

fn iso(ms: u64) -> String {
    conn_support::time::iso_from_ms(ms)
}

fn open(path: &std::path::Path, clock: &Arc<ManualClock>, on: bool) -> Store {
    let mut store = Store::open(path).unwrap();
    store.set_clock(clock.clone());
    if on {
        store.thread_push = Some(Arc::new(tokio::sync::Notify::new()));
    }
    store
}

impl Fixture {
    fn new(on: bool) -> Self {
        Self::with_thread(on, json!({}))
    }

    /// A thread with `extra` laid over a plain top-level thread, created idle.
    fn with_thread(on: bool, extra: Value) -> Self {
        let path = std::env::temp_dir().join(format!(
            "conn-thread-push-{}.sqlite",
            conn_support::uuid_v4()
        ));
        let clock = Arc::new(ManualClock::at(T0));
        let store = open(&path, &clock, on);
        let mut thread = json!({
            "id": "t",
            "projectId": "p",
            "title": "New thread",
            "lineage": {"parentThreadId": null, "relationshipToParent": null, "rootThreadId": "t"},
            "createdAt": iso(T0),
            "archivedAt": null,
            "deletedAt": null,
            "lastVisitedAt": null,
        });
        for (key, value) in extra.as_object().unwrap() {
            thread[key] = value.clone();
        }
        let mut fixture = Self {
            store,
            clock,
            path,
            thread,
        };
        let thread = fixture.thread.clone();
        fixture.write(|tx| {
            tx.append(Draft::new("t", "thread.created", thread))
                .unwrap();
        });
        fixture
    }

    fn tick(&self, ms: u64) {
        self.clock.advance(Duration::from_millis(ms));
    }

    fn now(&self) -> u64 {
        self.clock.now_millis()
    }

    fn write(&mut self, f: impl FnOnce(&mut crate::store::Tx<'_>)) {
        let mut tx = self.store.tx().unwrap();
        f(&mut tx);
        tx.commit(None).unwrap();
    }

    fn run(&mut self, id: &str, ordinal: u64, status: &str) {
        self.tick(1_000);
        let at = iso(self.now());
        let done = matches!(status, "completed" | "failed" | "cancelled");
        let run = json!({
            "id": id, "ordinal": ordinal, "status": status,
            "requestedAt": at, "startedAt": at,
            "completedAt": if done { json!(at) } else { Value::Null },
        });
        self.write(|tx| {
            tx.append(Draft::new("t", "run.updated", run)).unwrap();
        });
    }

    fn update_thread(&mut self, change: Value) {
        self.tick(1_000);
        for (key, value) in change.as_object().unwrap() {
            self.thread[key] = value.clone();
        }
        let thread = self.thread.clone();
        self.write(|tx| {
            tx.append(Draft::new("t", "thread.updated", thread))
                .unwrap();
        });
    }

    fn outbox(&self) -> Vec<ThreadPushRow> {
        due(self.store.raw(), u64::MAX >> 2, 100).unwrap()
    }

    fn titles(&self) -> Vec<String> {
        self.outbox().into_iter().map(|row| row.title).collect()
    }
}

#[test]
fn the_first_run_writes_one_row_and_later_runs_none() {
    let mut f = Fixture::new(true);
    assert!(
        f.outbox().is_empty(),
        "a thread that has not run is not sent"
    );
    f.run("r1", 1, "running");
    assert_eq!(
        f.outbox(),
        [ThreadPushRow {
            thread_id: "t".into(),
            title: "New thread".into(),
            attempts: 0,
        }]
    );
    delivered(f.store.raw(), "t", "New thread").unwrap();
    f.run("r1", 1, "completed");
    f.run("r2", 2, "running");
    assert!(f.outbox().is_empty());
}

#[test]
fn a_title_change_after_the_first_run_replaces_the_row() {
    let mut f = Fixture::new(true);
    f.update_thread(json!({"title": "Before the run"}));
    assert!(
        f.outbox().is_empty(),
        "a rename before the run sends nothing"
    );
    f.run("r1", 1, "running");
    retry(f.store.raw(), "t", "Before the run", 3, T0 + 999_999).unwrap();
    f.update_thread(json!({"title": "  Fix the build  "}));
    assert_eq!(
        f.outbox(),
        [ThreadPushRow {
            thread_id: "t".into(),
            title: "Fix the build".into(),
            attempts: 0,
        }],
        "the newer title replaces the row and clears its wait"
    );
    f.update_thread(json!({"title": "Fix the build"}));
    f.update_thread(json!({"title": "   "}));
    assert_eq!(f.titles(), ["Fix the build"], "a blank title sends nothing");
}

#[test]
fn nothing_is_written_when_thread_push_is_off() {
    let mut f = Fixture::new(false);
    f.run("r1", 1, "running");
    f.update_thread(json!({"title": "Fix the build"}));
    assert!(f.outbox().is_empty());
}

#[test]
fn delegated_children_side_chats_and_archived_threads_are_skipped() {
    let subagent = json!({"lineage": {"parentThreadId": "p", "relationshipToParent": "subagent", "rootThreadId": "p"}});
    let delegated = json!({"delegatedFrom": {"environmentId": "e", "threadId": "x"}});
    let side_chat = json!({"lineage": {"parentThreadId": "p", "relationshipToParent": "fork", "rootThreadId": "p", "sideChat": true}});
    let archived = json!({"archivedAt": iso(T0)});
    let untitled = json!({"title": ""});
    for extra in [subagent, delegated, side_chat, archived, untitled] {
        let mut f = Fixture::with_thread(true, extra.clone());
        f.run("r1", 1, "running");
        assert!(f.outbox().is_empty(), "{extra}");
    }
}

#[test]
fn the_outbox_survives_a_restart() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    retry(f.store.raw(), "t", "New thread", 2, T0 + 5_000).unwrap();
    let reopened = open(&f.path, &f.clock, true);
    f.store = reopened;
    assert_eq!(next_due(f.store.raw()).unwrap(), Some(T0 + 5_000));
    assert!(due(f.store.raw(), T0 + 4_999, 10).unwrap().is_empty());
    let rows = due(f.store.raw(), T0 + 5_000, 10).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].attempts, 2);
}

#[test]
fn delivery_and_retry_leave_a_newer_title_alone() {
    let mut f = Fixture::new(true);
    f.run("r1", 1, "running");
    f.update_thread(json!({"title": "Fix the build"}));
    let conn = f.store.raw();
    delivered(conn, "t", "New thread").unwrap();
    retry(conn, "t", "New thread", 4, T0 + 999_999).unwrap();
    assert_eq!(
        due(conn, f.now(), 10).unwrap(),
        [ThreadPushRow {
            thread_id: "t".into(),
            title: "Fix the build".into(),
            attempts: 0,
        }]
    );
    delivered(conn, "t", "Fix the build").unwrap();
    assert_eq!(next_due(conn).unwrap(), None);
}
