//! Drives the engine against a running Conn Server, for the spike's proofs and timings.
//!
//! `cargo run -p conn-cache --example engine_probe -- <server-url> <bearer> <db-file> <thread>`
//!
//! Opens the thread from the device file (if it holds it), catches up, then compares what the
//! engine draws with a fresh window the server builds for a plain subscriber. Prints one JSON
//! line: open-from-device time, catch-up time, rows drawn, and rows that differ.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a probe, not product code"
)]

use std::time::Instant;

use conn_cache::{Engine, Settings};
use conn_client::{ClientEvent, Connection, Credential, ServerConfig};
use conn_contract::OrchestrationV2ThreadStreamItem as Item;
use conn_state::ThreadState;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (url, bearer, path, thread) = (&args[1], &args[2], &args[3], &args[4]);
    let config = ServerConfig {
        http_base_url: url::Url::parse(url).unwrap(),
        credential: Credential::Bearer(bearer.clone()),
    };
    let rt = tokio::runtime::Handle::current();
    let (connection, mut events) = Connection::start(config.clone(), &rt);
    let start = Instant::now();
    let mut engine = Engine::open(
        path.as_ref(),
        "probe",
        connection.clone(),
        Settings::default(),
    )
    .await
    .unwrap();
    // PROBE_DISPATCH='<command json>': dispatch it first (for a rollback).
    if let Ok(command) = std::env::var("PROBE_DISPATCH") {
        let command: serde_json::Value = serde_json::from_str(&command).unwrap();
        let answer = connection
            .call_json("orchestration.dispatchCommand", command)
            .await;
        eprintln!("dispatch: {answer:?}");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let stored = engine.stored(thread);
    if let Some(pending) = engine.open_thread(thread) {
        let window = pending.await.ok().flatten();
        engine.finish_open(thread, window);
    }
    let open_ms = start.elapsed().as_secs_f64() * 1000.0;
    let drawn_at_open = engine.thread(thread).map_or(0, |s| s.entries.len());
    let mut items = 0usize;
    let mut snapshot = false;
    while let Some(event) = events.recv().await {
        match event {
            ClientEvent::Thread { thread_id, item } if &thread_id == thread => {
                let done = matches!(item, Item::Synchronized(_));
                snapshot |= matches!(item, Item::Snapshot(_));
                items += 1;
                engine.handle(&thread_id, item);
                if done {
                    break;
                }
            }
            ClientEvent::ThreadStale { thread_id } => engine.mark_stale(&thread_id),
            _ => {}
        }
    }
    let caught_up_ms = start.elapsed().as_secs_f64() * 1000.0;

    // PROBE_OLDER=subagent: page older rows (device first, then server) until a subagent card
    // shows, and report whether its record came with it.
    let mut card = serde_json::Value::Null;
    if std::env::var("PROBE_OLDER").as_deref() == Ok("subagent") {
        let mut pages = 0;
        loop {
            let found = engine.thread(thread).and_then(|state| {
                state.entries.iter().find_map(|entry| match entry {
                    conn_state::TimelineEntry::Subagent { id, .. } => Some(id.clone()),
                    _ => None,
                })
            });
            if let Some(id) = found {
                let state = engine.thread(thread).unwrap();
                let record = state
                    .subagent_of_entry
                    .get(&id)
                    .and_then(|sub| state.subagents.get(sub));
                card = serde_json::json!({"pages": pages, "entry": id,
                    "rows_above_newest": state.entries.len() - 1
                        - state.entries.iter().position(|e| e.id() == id).unwrap_or(0),
                    "record": record.is_some(),
                    "status": record.map(|r| format!("{:?}", r.status))});
                break;
            }
            let Some(pending) = engine.older(thread) else {
                break;
            };
            let window = pending.await.ok().flatten();
            engine.finish_older(thread, window);
            pages += 1;
        }
    }

    // A fresh window, as a client without a device copy gets it.
    let (fresh_conn, mut fresh_events) = Connection::start(config, &rt);
    fresh_conn.subscribe_thread(thread);
    let mut fresh = ThreadState::new(thread);
    while let Some(event) = fresh_events.recv().await {
        if let ClientEvent::Thread { item, .. } = event {
            let done = matches!(item, Item::Synchronized(_));
            fresh.apply(item);
            if done {
                break;
            }
        }
    }
    let ours = engine.thread(thread).unwrap();
    let mine: std::collections::HashMap<&str, String> = ours
        .entries
        .iter()
        .map(|e| (e.id(), format!("{e:?}")))
        .collect();
    // Every row of the server's fresh window from our oldest drawn row on must be drawn, and
    // drawn the same. Rows older than our window stay on the device (a smaller window).
    let from = ours
        .entries
        .first()
        .and_then(|first| fresh.entries.iter().position(|e| e.id() == first.id()))
        .unwrap_or(0);
    let older_on_device = from;
    let missing = fresh.entries[from..]
        .iter()
        .filter(|e| !mine.contains_key(e.id()))
        .count();
    let differ: Vec<&str> = fresh
        .entries
        .iter()
        .filter(|e| mine.get(e.id()).is_some_and(|m| *m != format!("{e:?}")))
        .map(|e| e.id())
        .collect();
    // Let the database task commit before the process ends.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    println!(
        "{}",
        serde_json::json!({
            "thread": thread, "stored_before": stored, "open_ms": open_ms,
            "drawn_at_open": drawn_at_open, "catch_up_ms": caught_up_ms,
            "catch_up_items": items, "got_snapshot": snapshot,
            "drawn": ours.entries.len(), "fresh_rows": fresh.entries.len(),
            "missing": missing, "older_on_device": older_on_device, "differ": differ.len(), "differ_ids": differ.iter().take(5).collect::<Vec<_>>(),
            "subagent_card": card, "working": ours.working, "fresh_working": fresh.working,
        })
    );
    connection.close();
    fresh_conn.close();
}
