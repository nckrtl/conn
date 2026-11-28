//! The device copy of the server's rows: what an event, a snapshot or a history page writes,
//! and the projection a window of stored rows reads back as. Pure functions, no I/O.
//!
//! A row is the server's own stored row (`entities` in `conn-engine`): its collection, its id,
//! and its body as the server sent it. Timeline rows carry `ord`, their place in the thread:
//! the server's `ordinal` for the thread's own items, and a fractional place between them for
//! rows the thread shows but does not own (inherited fork history, the fork marker).

use serde_json::{Value, json};

/// A thread's own timeline item.
pub(crate) const OWN: &str = "turnItems";
/// A timeline row the thread shows but does not own, stored as the whole visible row.
pub(crate) const SHOWN: &str = "visible";

/// One stored row.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub kind: String,
    pub id: String,
    /// Place in the timeline; `None` for a control row (runs, messages, ...).
    pub ord: Option<f64>,
    /// The run (or, for a provider turn, the run attempt) the row belongs to.
    pub run: Option<String>,
    /// Still in progress: loaded with every window.
    pub live: bool,
    pub body: Value,
}

/// What one event does to the device copy.
#[derive(Debug, PartialEq)]
pub(crate) enum Change {
    Row(Row),
    Delete {
        kind: &'static str,
        id: String,
    },
    /// The thread's own record (`thread.*`), whole.
    Record(Value),
    /// A visit: only these fields of the record change.
    RecordFields(Value),
    ThreadDeleted,
    /// Nothing stored changes (an event type this client does not keep).
    Nothing,
}

/// The collection an event type replaces a row in: the server's `collection_of`.
fn collection_of(event_type: &str) -> Option<&'static str> {
    Some(match event_type {
        "run.created" | "run.updated" => "runs",
        "run-attempt.created" | "run-attempt.updated" => "attempts",
        "node.updated" => "nodes",
        "subagent.updated" => "subagents",
        "provider-session.attached" | "provider-session.updated" => "providerSessions",
        "provider-thread.updated" => "providerThreads",
        "provider-turn.updated" => "providerTurns",
        "runtime-request.updated" => "runtimeRequests",
        "message.updated" => "messages",
        "plan.updated" => "plans",
        "turn-item.updated" => OWN,
        "checkpoint-scope.created" => "checkpointScopes",
        "checkpoint.captured" => "checkpoints",
        "context-handoff.updated" => "contextHandoffs",
        "context-transfer.created" | "context-transfer.updated" => "contextTransfers",
        _ => return None,
    })
}

/// Every control collection a projection carries, besides the timeline.
const CONTROL: [&str; 15] = [
    "runs",
    "attempts",
    "nodes",
    "subagents",
    "providerSessions",
    "providerThreads",
    "providerTurns",
    "runtimeRequests",
    "messages",
    "plans",
    "checkpointScopes",
    "checkpoints",
    "contextHandoffs",
    "contextTransfers",
    "turnItems",
];

/// Control rows every window loads whole: few, small, or needed to answer.
pub(crate) const ALWAYS: [&str; 8] = [
    "runs",
    "providerSessions",
    "providerThreads",
    "checkpointScopes",
    "contextHandoffs",
    "contextTransfers",
    "runtimeRequests",
    "plans",
];

fn is_live(body: &Value) -> bool {
    matches!(
        body["status"].as_str(),
        Some("pending" | "starting" | "running" | "waiting" | "queued" | "preparing")
    )
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// A control or own timeline row from a server body.
pub(crate) fn row(kind: &str, body: Value) -> Row {
    let ord = (kind == OWN).then(|| body["ordinal"].as_f64().unwrap_or(0.0));
    Row {
        kind: kind.to_owned(),
        id: text(&body["id"]).unwrap_or_default(),
        ord,
        run: text(&body["runId"]).or_else(|| text(&body["runAttemptId"])),
        live: is_live(&body),
        body,
    }
}

/// What a stored event (`{type, payload, ...}`) changes.
pub(crate) fn change_of(event: &Value) -> Change {
    let event_type = event["type"].as_str().unwrap_or_default();
    let payload = &event["payload"];
    if let Some(kind) = collection_of(event_type) {
        return Change::Row(row(kind, payload.clone()));
    }
    match event_type {
        "thread.deleted" => Change::ThreadDeleted,
        "thread.visit-recorded" => {
            let mut fields = json!({"lastVisitedAt": payload["lastVisitedAt"]});
            if let Some(opens) = payload.get("opens") {
                fields["opens"] = opens.clone();
            }
            Change::RecordFields(fields)
        }
        "provider-session.detached" => Change::Delete {
            kind: "providerSessions",
            id: text(&payload["providerSessionId"]).unwrap_or_default(),
        },
        t if t.starts_with("thread.") && payload["id"].is_string() => {
            Change::Record(payload.clone())
        }
        _ => Change::Nothing,
    }
}

/// Timeline rows of a visible-rows list (a snapshot window or a history page) in their order,
/// with places: own rows at their ordinal, the others just after the own row before them, or
/// below `floor` when no own row comes first.
pub(crate) fn timeline_rows(thread: &str, rows: &[Value], floor: f64) -> Vec<Row> {
    let mut sorted: Vec<&Value> = rows.iter().collect();
    sorted.sort_by_key(|row| row["position"].as_i64().unwrap_or(0));
    let leading = sorted.iter().take_while(|row| !is_own(thread, row)).count();
    let mut out = Vec::with_capacity(sorted.len());
    let mut last_own: Option<f64> = None;
    let mut after_own = 0u32;
    for (index, visible) in sorted.into_iter().enumerate() {
        if is_own(thread, visible) {
            let own = row(OWN, visible["item"].clone());
            last_own = own.ord;
            after_own = 0;
            out.push(own);
            continue;
        }
        after_own += 1;
        let ord = match last_own {
            Some(own) => own + f64::from(after_own) / 1024.0,
            None => floor - (leading - index) as f64,
        };
        out.push(Row {
            kind: SHOWN.to_owned(),
            id: format!(
                "{}\u{0}{}",
                visible["sourceThreadId"].as_str().unwrap_or_default(),
                visible["sourceItemId"].as_str().unwrap_or_default()
            ),
            ord: Some(ord),
            run: text(&visible["item"]["runId"]),
            live: false,
            body: visible.clone(),
        });
    }
    out
}

fn is_own(thread: &str, visible: &Value) -> bool {
    visible["sourceThreadId"] == thread
        && visible["visibility"] == "local"
        && visible["sourceItemId"] == visible["item"]["id"]
}

/// Every row a snapshot's projection holds, timeline and control. Bodies the server left out
/// of timeline items (`acceptDedupedBodies`) are filled in from the same snapshot's messages
/// and subagents, so the device stores whole rows.
pub(crate) fn snapshot_rows(thread: &str, projection: &Value) -> Vec<Row> {
    let visible = projection["visibleTurnItems"].as_array();
    let mut out = match visible.filter(|rows| !rows.is_empty()) {
        Some(rows) => timeline_rows(thread, rows, 0.0),
        None => projection["turnItems"]
            .as_array()
            .map(|items| items.iter().map(|item| row(OWN, item.clone())).collect())
            .unwrap_or_default(),
    };
    restore_bodies(projection, &mut out);
    for kind in CONTROL.iter().filter(|kind| **kind != OWN) {
        if let Some(rows) = projection[*kind].as_array() {
            out.extend(rows.iter().map(|body| row(kind, body.clone())));
        }
    }
    out
}

/// Fills in the text, prompt and result a deduped snapshot blanked in its timeline items.
fn restore_bodies(projection: &Value, timeline: &mut [Row]) {
    let index = |collection: &str| -> std::collections::HashMap<&str, &Value> {
        projection[collection]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| Some((row["id"].as_str()?, row)))
                    .collect()
            })
            .unwrap_or_default()
    };
    let (messages, subagents) = (index("messages"), index("subagents"));
    if messages.is_empty() && subagents.is_empty() {
        return;
    }
    for row in timeline {
        let item = if row.kind == SHOWN {
            &mut row.body["item"]
        } else {
            &mut row.body
        };
        let Some(fields) = item.as_object_mut() else {
            continue;
        };
        if fields.contains_key("textOmitted")
            && let Some(message) = fields
                .get("messageId")
                .and_then(Value::as_str)
                .and_then(|id| messages.get(id))
        {
            fields.insert("text".into(), message["text"].clone());
            fields.remove("textOmitted");
        }
        let subagent = fields
            .get("subagentId")
            .and_then(Value::as_str)
            .and_then(|id| subagents.get(id));
        if let Some(subagent) = subagent {
            if fields.remove("promptOmitted").is_some() {
                fields.insert("prompt".into(), subagent["prompt"].clone());
            }
            if fields.remove("resultOmitted").is_some() {
                fields.insert("result".into(), subagent["result"].clone());
            }
        }
    }
}

/// The window rows read back as a projection the thread reducer takes, oldest row first.
pub(crate) fn projection(thread: &str, record: &Value, timeline: &[Row], control: &[Row]) -> Value {
    let mut projection = serde_json::Map::new();
    projection.insert("thread".into(), record.clone());
    for kind in CONTROL {
        projection.insert(kind.into(), Value::Array(vec![]));
    }
    for row in control {
        if let Some(Value::Array(rows)) = projection.get_mut(row.kind.as_str()) {
            rows.push(row.body.clone());
        }
    }
    let visible: Vec<Value> = timeline
        .iter()
        .enumerate()
        .map(|(position, row)| visible_row(thread, position, row))
        .collect();
    projection.insert("visibleTurnItems".into(), Value::Array(visible));
    projection.insert("updatedAt".into(), record["updatedAt"].clone());
    Value::Object(projection)
}

/// A timeline row as the server's visible row at `position`.
pub(crate) fn visible_row(thread: &str, position: usize, row: &Row) -> Value {
    if row.kind == SHOWN {
        let mut visible = row.body.clone();
        visible["position"] = json!(position);
        return visible;
    }
    json!({
        "position": position,
        "visibility": "local",
        "sourceThreadId": thread,
        "sourceItemId": row.id,
        "item": row.body,
    })
}

/// How many of `newest_first` rows a window takes: whole turns, so a work group, its run
/// and its card sit together. It stops at a user message once it holds `min_turns` of them or
/// at least `min_rows` rows; `max_rows` and `max_bytes` stop it anywhere. The newest row is
/// always taken, however large.
pub(crate) fn window_len(
    newest_first: &[(Row, usize)],
    min_rows: usize,
    min_turns: usize,
    max_rows: usize,
    max_bytes: usize,
) -> usize {
    let (mut bytes, mut turns) = (0usize, 0usize);
    for (index, (row, size)) in newest_first.iter().enumerate() {
        bytes += size;
        let taken = index + 1;
        if taken >= max_rows || bytes >= max_bytes {
            return taken;
        }
        let item = if row.kind == SHOWN {
            &row.body["item"]
        } else {
            &row.body
        };
        if item["type"] == "user_message" {
            turns += 1;
            if turns >= min_turns || taken >= min_rows {
                return taken;
            }
        }
    }
    newest_first.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, ordinal: i64, kind: &str) -> Value {
        json!({"id": id, "ordinal": ordinal, "type": kind, "runId": "r1", "status": "completed"})
    }

    #[test]
    fn an_event_replaces_its_row_and_thread_events_replace_the_record() {
        let event =
            json!({"type": "turn-item.updated", "payload": item("a", 7, "assistant_message")});
        let Change::Row(row) = change_of(&event) else {
            panic!("a row")
        };
        assert_eq!(
            (row.kind.as_str(), row.id.as_str(), row.ord),
            (OWN, "a", Some(7.0))
        );
        let run = json!({"type": "run.updated", "payload": {"id": "r1", "status": "running"}});
        let Change::Row(row) = change_of(&run) else {
            panic!("a row")
        };
        assert!(row.live && row.ord.is_none());
        let renamed =
            json!({"type": "thread.metadata-updated", "payload": {"id": "t", "title": "x"}});
        assert_eq!(
            change_of(&renamed),
            Change::Record(json!({"id": "t", "title": "x"}))
        );
        let detached =
            json!({"type": "provider-session.detached", "payload": {"providerSessionId": "s"}});
        assert_eq!(
            change_of(&detached),
            Change::Delete {
                kind: "providerSessions",
                id: "s".into()
            }
        );
        assert_eq!(
            change_of(&json!({"type": "thread.deleted", "payload": {}})),
            Change::ThreadDeleted
        );
    }

    #[test]
    fn inherited_rows_and_the_fork_marker_keep_their_place() {
        let visible = |position: i64, source: &str, it: Value, visibility: &str| {
            json!({"position": position, "visibility": visibility, "sourceThreadId": source,
                "sourceItemId": it["id"], "item": it})
        };
        let rows = vec![
            visible(2, "t", item("own1", 5, "user_message"), "local"),
            visible(0, "parent", item("p1", 1, "user_message"), "inherited"),
            visible(1, "t", json!({"id": "fork", "type": "fork"}), "synthetic"),
            visible(3, "t", item("own2", 6, "assistant_message"), "local"),
        ];
        let out = timeline_rows("t", &rows, 0.0);
        let ids: Vec<_> = out
            .iter()
            .map(|r| (r.kind.as_str(), r.ord.unwrap()))
            .collect();
        assert_eq!(ids, [(SHOWN, -2.0), (SHOWN, -1.0), (OWN, 5.0), (OWN, 6.0)]);
        let back = projection("t", &json!({"id": "t"}), &out, &[]);
        assert_eq!(back["visibleTurnItems"][0]["sourceThreadId"], "parent");
        assert_eq!(back["visibleTurnItems"][2]["item"]["id"], "own1");
        assert_eq!(back["visibleTurnItems"][3]["position"], 3);
    }

    /// A snapshot that left message texts and subagent bodies out of its timeline items
    /// (`acceptDedupedBodies`) is stored with them filled in from its own messages and subagents.
    #[test]
    fn deduped_snapshot_bodies_are_stored_whole() {
        let own = |it: Value| {
            json!({"position": 0, "visibility": "local", "sourceThreadId": "t",
                "sourceItemId": it["id"], "item": it})
        };
        let projection = json!({
            "visibleTurnItems": [
                own(json!({"id": "u", "ordinal": 1, "type": "user_message", "messageId": "m1",
                    "text": "", "textOmitted": true})),
                {"position": 1, "visibility": "inherited", "sourceThreadId": "p",
                    "sourceItemId": "a", "item": {"id": "a", "ordinal": 9,
                    "type": "assistant_message", "messageId": "m2", "text": "",
                    "textOmitted": true}},
                own(json!({"id": "s", "ordinal": 2, "type": "subagent", "subagentId": "sa",
                    "prompt": "", "promptOmitted": true, "result": null, "resultOmitted": true})),
                own(json!({"id": "k", "ordinal": 3, "type": "user_message", "messageId": "m3",
                    "text": "kept as sent"})),
            ],
            "messages": [
                {"id": "m1", "text": "hello"},
                {"id": "m2", "text": "from the parent"},
                {"id": "m3", "text": "other"},
            ],
            "subagents": [{"id": "sa", "prompt": "look", "result": "found"}],
        });
        let rows = snapshot_rows("t", &projection);
        let item = |id: &str| {
            let row = rows
                .iter()
                .find(|r| r.body["id"] == id || r.body["item"]["id"] == id)
                .unwrap_or_else(|| panic!("{id}"));
            if row.kind == SHOWN {
                row.body["item"].clone()
            } else {
                row.body.clone()
            }
        };
        assert_eq!(item("u")["text"], "hello");
        assert!(item("u").get("textOmitted").is_none());
        assert_eq!(item("a")["text"], "from the parent");
        assert_eq!(item("s")["prompt"], "look");
        assert_eq!(item("s")["result"], "found");
        assert!(
            item("s").get("promptOmitted").is_none() && item("s").get("resultOmitted").is_none()
        );
        assert_eq!(item("k")["text"], "kept as sent", "not omitted: untouched");
    }

    #[test]
    fn a_window_ends_at_a_user_message_or_a_cap() {
        let rows: Vec<(Row, usize)> = [
            "assistant_message",
            "command_execution",
            "user_message",
            "assistant_message",
            "user_message",
            "assistant_message",
        ]
        .iter()
        .enumerate()
        .map(|(i, kind)| (row(OWN, item(&i.to_string(), 10 - i as i64, kind)), 10))
        .collect();
        assert_eq!(
            window_len(&rows, 100, 1, 100, 1000),
            3,
            "first user message"
        );
        assert_eq!(
            window_len(&rows, 4, 9, 100, 1000),
            5,
            "enough rows, then a user message"
        );
        assert_eq!(window_len(&rows, 100, 9, 100, 1000), 6, "all");
        assert_eq!(window_len(&rows, 100, 9, 2, 1000), 2, "row cap");
        assert_eq!(window_len(&rows, 100, 9, 100, 30), 3, "byte cap");
        assert_eq!(
            window_len(&rows, 100, 9, 100, 1),
            1,
            "the newest row always"
        );
    }
}
