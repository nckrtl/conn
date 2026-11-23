//! The `orchestration.*` reads beyond snapshots and streams: titles, families, archived and
//! older-settled shells, search, single turn items, worktree occupants.
//!
//! Each read runs one short query on the database thread and builds only its answer. Shell rows
//! come from the stored `threads.shell` column, so no read rebuilds a projection.

use std::collections::BTreeMap;

use rusqlite::params;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::store::{Store, StoreResult};
use crate::time::millis_from_iso;

/// `NEWEST_SETTLED_KEPT` in `ShellStream.ts`: the settled threads a bounded shell keeps.
const NEWEST_SETTLED_KEPT: usize = 25;
/// `searchThreads` scans at most this many newest messages, so one search cannot hold the
/// database thread for long.
const SEARCH_SCAN_LIMIT: i64 = 20_000;
const SNIPPET_CHARS: usize = 240;
/// `MESSAGE_CANDIDATE_LIMIT` in `ThreadSearch.ts`: the newest index hits the filters may pass
/// over, so a common word does not read every hit.
const SEARCH_CANDIDATE_LIMIT: i64 = 10_000;
/// `MESSAGE_HIT_LIMIT`: rows read after the filters.
const SEARCH_HIT_LIMIT: i64 = 2_000;
/// `MESSAGE_TOKEN_MIN_LENGTH` in `paletteSearch.ts`: a shorter Latin word is noise.
const MESSAGE_TOKEN_MIN_LENGTH: usize = 3;
/// `MESSAGE_WORD_START_LENGTH`: a shorter word must start a word, so "fts" does not find "drafts".
const MESSAGE_WORD_START_LENGTH: usize = 4;

/// The filters every search shares, after `hits(rowid)` names the candidate messages, newest
/// first. `CROSS JOIN` keeps the hits first, so the planner never scans `entities` or
/// `threads`. Deleted, archived, subagent and side-chat threads drop out before the limit, and
/// so do threads outside the project scope (`?6`) and threads the caller already lists (`?7`),
/// as `searchMessages` in `ThreadSearch.ts` applies them.
macro_rules! search_sql {
    ($hits:literal) => {
        concat!(
            "WITH hits AS MATERIALIZED (",
            $hits,
            ")
             SELECT k.thread_id,
                    json_object('projectId', json_extract(t.shell, '$.projectId'),
                                'message', json(e.body))
             FROM hits h
             CROSS JOIN message_keys k ON k.id = h.rowid
             CROSS JOIN message_search folded ON folded.rowid = h.rowid
             CROSS JOIN threads t ON t.id = k.thread_id
             CROSS JOIN entities e
               ON e.thread_id = k.thread_id AND e.kind = 'messages' AND e.id = k.message_id
             WHERE t.deleted = 0 AND t.shell IS NOT NULL
               AND json_extract(t.shell, '$.archivedAt') IS NULL
               AND json_extract(t.shell, '$.lineage.relationshipToParent') IS NOT 'subagent'
               AND json_extract(t.shell, '$.lineage.sideChat') IS NOT 1
               AND k.message_id NOT LIKE 'async-answer:%'
               AND (?6 IS NULL OR json_extract(t.shell, '$.projectId') = ?6)
               AND k.thread_id NOT IN (SELECT value FROM json_each(?7))
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?2) AS token
                 WHERE instr(folded.text, token.value) = 0
               )
             ORDER BY h.rowid DESC
             LIMIT ?5"
        )
    };
}

/// Long words that are all three characters or more: the trigram index answers `MATCH`.
const SEARCH_INDEXED_SQL: &str = search_sql!(
    "SELECT rowid FROM message_search WHERE message_search MATCH ?1
     ORDER BY rowid DESC LIMIT ?3"
);
/// A two-character CJK word is too short for trigrams: scan the newest indexed messages.
/// `?1` is unused here and bound as NULL.
const SEARCH_SCAN_SQL: &str =
    search_sql!("SELECT id AS rowid FROM message_keys WHERE ?1 IS NULL ORDER BY id DESC LIMIT ?4");

/// The SQL inputs of one message search (`buildMessageSearch` in `ThreadSearch.ts`), and the
/// words its matcher checks in each hit (`messageMatcher` in `paletteSearch.ts`).
struct MessageSearch {
    /// Quoted long words for FTS5 `MATCH`, or `None` when the index cannot serve them.
    fts_match: Option<String>,
    /// Folded words each hit's folded text must contain as a substring.
    substrings: Vec<String>,
    /// Every word, long ones first.
    tokens: Vec<MatchToken>,
}

/// One query word as the matcher reads it.
struct MatchToken {
    /// The word as the index folds it.
    folded: String,
    /// Shorter than `MESSAGE_WORD_START_LENGTH` once lowercased: it must start a word, so "fts"
    /// does not find "drafts".
    must_start_word: bool,
}

impl MessageSearch {
    /// `None` when the query has no word long enough to search (`messageSearchTokens`).
    fn new(query: &str) -> Option<Self> {
        let query: String = query
            .trim()
            .trim_matches(crate::fold::WRAPPING_QUOTES)
            .nfc()
            .collect();
        // `messageSearchTokens` counts a word's length lowercased, before the index folds it:
        // "İce" is four characters, though the index reads "ice".
        let words: Vec<(usize, String)> = query
            .split_whitespace()
            .map(|word| (word.to_lowercase().chars().count(), crate::fold::fold(word)))
            .filter(|(_, folded)| !folded.is_empty())
            .collect();
        let (long, short): (Vec<_>, Vec<_>) = words
            .into_iter()
            .partition(|(length, folded)| searchable(*length, folded));
        if long.is_empty() {
            return None;
        }
        let indexed = long
            .iter()
            .all(|(length, _)| *length >= MESSAGE_TOKEN_MIN_LENGTH);
        let fts_match = indexed.then(|| {
            long.iter()
                .map(|(_, token)| format!("\"{}\"", token.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ")
        });
        let mut substrings: Vec<String> = if indexed {
            vec![]
        } else {
            long.iter().map(|(_, token)| token.clone()).collect()
        };
        substrings.extend(short.iter().map(|(_, token)| token.clone()));
        let tokens = long
            .into_iter()
            .chain(short)
            .map(|(length, folded)| MatchToken {
                folded,
                must_start_word: length < MESSAGE_WORD_START_LENGTH,
            })
            .collect();
        Some(Self {
            fts_match,
            substrings,
            tokens,
        })
    }

    /// `messageMatcher`: where the snippet of a hit starts, as an index into its characters, or
    /// `None` when a word sits only inside a hex id, or a short word only inside words. The
    /// snippet starts at the shortest stretch that holds one best place of every word.
    fn accept(&self, text: &str) -> Option<usize> {
        let folded = crate::fold::Folded::new(text, crate::fold::push_indexed);
        let first_only = self.tokens.len() == 1;
        let mut places = Vec::with_capacity(self.tokens.len());
        for token in &self.tokens {
            let (placement, at) = folded.find_token(&token.folded, first_only)?;
            if placement == crate::fold::Placement::Inside && token.must_start_word {
                return None;
            }
            places.push(at);
        }
        Some(shortest_span(&places))
    }
}

/// `shortestSpan` in `paletteSearch.ts`: where the shortest stretch of text starts that holds
/// one place of each word, from each word's places in order.
fn shortest_span(places: &[Vec<usize>]) -> usize {
    let mut hits: Vec<(usize, usize)> = places
        .iter()
        .enumerate()
        .flat_map(|(word, at)| at.iter().map(move |&index| (index, word)))
        .collect();
    hits.sort_by_key(|&(index, _)| index);
    let mut counts = vec![0_usize; places.len()];
    let mut covered = 0;
    let mut best = (hits.first().map_or(0, |&(index, _)| index), usize::MAX);
    let mut left = 0;
    for &(index, word) in &hits {
        if let Some(count) = counts.get_mut(word) {
            *count += 1;
            if *count == 1 {
                covered += 1;
            }
        }
        while covered == places.len() {
            let Some(&(first, first_word)) = hits.get(left) else {
                break;
            };
            if index - first < best.1 {
                best = (first, index - first);
            }
            if let Some(count) = counts.get_mut(first_word) {
                *count -= 1;
                if *count == 0 {
                    covered -= 1;
                }
            }
            left += 1;
        }
    }
    best.0
}

/// Three characters or more, or two when one is a CJK word character.
fn searchable(length: usize, token: &str) -> bool {
    length >= MESSAGE_TOKEN_MIN_LENGTH || (length == 2 && token.chars().any(is_cjk_word))
}

/// `hasCjkWord` in `paletteSearch.ts`: kana, CJK ideographs and Hangul syllables.
fn is_cjk_word(c: char) -> bool {
    matches!(
        u32::from(c),
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af
    )
}

fn listed(row: &Value) -> bool {
    row["lineage"]["relationshipToParent"] != "subagent" && row["lineage"]["sideChat"] != true
}

fn settled_millis(row: &Value) -> Option<i64> {
    if row["settledOverride"] != "settled" {
        return None;
    }
    row["settledAt"].as_str().and_then(millis_from_iso)
}

/// `isOlderSettledThreadShell`: listed, settled before `before`.
fn older_settled(row: &Value, before: i64) -> bool {
    listed(row) && settled_millis(row).is_some_and(|at| at < before)
}

/// The settle time below which a thread is "older settled": the 25th newest settle time of
/// listed threads, or `None` with fewer than 25.
fn older_settled_cut(rows: &[Value]) -> Option<i64> {
    let mut times: Vec<i64> = rows
        .iter()
        .filter(|row| listed(row))
        .filter_map(settled_millis)
        .collect();
    if times.len() < NEWEST_SETTLED_KEPT {
        return None;
    }
    times.sort_unstable_by(|a, b| b.cmp(a));
    Some(times[NEWEST_SETTLED_KEPT - 1])
}

/// A live subagent row stays in a shell that omits idle subagents (`isLiveSubagentShell`).
fn live_subagent(row: &Value) -> bool {
    !row["activityRunStatus"].is_null()
        || matches!(
            row["status"].as_str(),
            Some("queued" | "preparing" | "starting" | "running" | "waiting")
        )
        || !row["pendingRuntimeRequest"].is_null()
        || row["pendingBackgroundTasks"]
            .as_array()
            .is_some_and(|tasks| !tasks.is_empty())
}

impl Store {
    /// The shell snapshot with the client's opt-ins (`omitIdleSubagents`, `omitOlderSettled`):
    /// idle subagent rows and older settled rows stay out, as `ShellStream.ts` trims them.
    pub(crate) fn shell_snapshot_trimmed(
        &self,
        omit_idle: bool,
        omit_older: bool,
    ) -> StoreResult<Value> {
        let mut snapshot = self.shell_snapshot()?;
        if !omit_idle && !omit_older {
            return Ok(snapshot);
        }
        let rows: Vec<Value> = snapshot["threads"].as_array().cloned().unwrap_or_default();
        let parent_of_subagent: Vec<Value> = rows
            .iter()
            .filter(|r| r["lineage"]["relationshipToParent"] == "subagent")
            .map(|r| r["lineage"]["parentThreadId"].clone())
            .collect();
        let mut keep: Vec<Value> = rows.clone();
        if omit_idle {
            keep.retain(|r| {
                r["lineage"]["relationshipToParent"] != "subagent"
                    || live_subagent(r)
                    || parent_of_subagent.contains(&r["id"])
            });
        }
        if omit_older {
            let now = i64::try_from(self.now_millis()).unwrap_or(i64::MAX);
            let before = older_settled_cut(&rows).unwrap_or(now);
            let ancestors: Vec<Value> = rows
                .iter()
                .filter(|r| !listed(r))
                .flat_map(|r| {
                    [
                        r["lineage"]["parentThreadId"].clone(),
                        r["lineage"]["rootThreadId"].clone(),
                    ]
                })
                .collect();
            let mut counts: BTreeMap<String, u64> = BTreeMap::new();
            for row in rows.iter().filter(|r| older_settled(r, before)) {
                *counts
                    .entry(row["projectId"].as_str().unwrap_or("").to_owned())
                    .or_default() += 1;
            }
            keep.retain(|r| {
                !older_settled(r, before)
                    || !r["pinnedAt"].is_null()
                    || r["snoozedUntil"]
                        .as_str()
                        .and_then(millis_from_iso)
                        .is_some_and(|until| until > now)
                    || live_subagent(r)
                    || ancestors.contains(&r["id"])
            });
            let counts: Vec<Value> = counts
                .into_iter()
                .map(|(project_id, count)| json!({"projectId": project_id, "count": count}))
                .collect();
            snapshot["olderSettled"] = json!({
                "before": crate::time::iso_from_millis(before),
                "asOfSequence": snapshot["snapshotSequence"],
                "counts": counts,
            });
        }
        snapshot["threads"] = json!(keep);
        Ok(snapshot)
    }

    /// Shell rows of every thread that is not deleted, archived ones included.
    pub(crate) fn shell_rows(&self) -> StoreResult<Vec<Value>> {
        self.query_json(
            "SELECT shell FROM threads WHERE deleted = 0 AND shell IS NOT NULL ORDER BY rowid",
            [],
        )
    }

    fn thread_records(&self, ids: &[String]) -> StoreResult<Vec<Value>> {
        let mut out = Vec::new();
        for id in ids {
            out.extend(self.query_json(
                "SELECT thread FROM threads WHERE id = ?1 AND deleted = 0",
                [id],
            )?);
        }
        Ok(out)
    }

    pub(crate) fn thread_titles(&self, ids: &[String]) -> StoreResult<Value> {
        let mut out = serde_json::Map::new();
        for thread in self.thread_records(ids)? {
            if let Some(id) = thread["id"].as_str() {
                out.insert(id.to_owned(), thread["title"].clone());
            }
        }
        Ok(Value::Object(out))
    }

    pub(crate) fn thread_link_metadata(&self, ids: &[String]) -> StoreResult<Value> {
        let mut out = serde_json::Map::new();
        for thread in self.thread_records(ids)? {
            if let Some(id) = thread["id"].as_str() {
                out.insert(
                    id.to_owned(),
                    json!({"title": thread["title"], "projectId": thread["projectId"]}),
                );
            }
        }
        Ok(Value::Object(out))
    }

    /// Active (not archived) threads sharing the root of `thread_id`'s family.
    pub(crate) fn thread_family(&self, thread_id: &str) -> StoreResult<Value> {
        let root: Option<String> = self
            .query_json("SELECT thread FROM threads WHERE id = ?1", [thread_id])?
            .first()
            .and_then(|t| t["lineage"]["rootThreadId"].as_str().map(str::to_owned));
        let threads: Vec<Value> = match root {
            Some(root) => self
                .shell_rows()?
                .into_iter()
                .filter(|row| row["lineage"]["rootThreadId"] == root.as_str())
                .filter(|row| row["archivedAt"].is_null())
                .collect(),
            None => vec![],
        };
        Ok(json!({"snapshotSequence": self.high_water(), "threads": threads}))
    }

    pub(crate) fn archived_shell_snapshot(&self) -> StoreResult<Value> {
        let mut snapshot = self.shell_snapshot()?;
        let threads: Vec<Value> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| !row["archivedAt"].is_null())
            .collect();
        snapshot["threads"] = json!(threads);
        if let Some(map) = snapshot.as_object_mut() {
            map.remove("archivedThreads");
        }
        Ok(snapshot)
    }

    pub(crate) fn worktree_thread_ids(&self, path: &str) -> StoreResult<Value> {
        let ids: Vec<Value> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| row["worktreePath"] == path && row["archivedAt"].is_null())
            .map(|row| row["id"].clone())
            .collect();
        Ok(json!({"threadIds": ids}))
    }

    pub(crate) fn older_settled_threads(&self, input: &Value) -> StoreResult<Value> {
        let before = input["before"]["settledAt"]
            .as_str()
            .and_then(millis_from_iso)
            .unwrap_or(i64::MAX);
        let after_id = input["before"]["threadId"].as_str();
        let projects: Option<Vec<&str>> = input["projectIds"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect());
        let limit = input["limit"].as_u64().unwrap_or(0) as usize;
        let mut rows: Vec<(i64, Value)> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| row["archivedAt"].is_null() && listed(row))
            .filter(|row| {
                projects
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&row["projectId"].as_str().unwrap_or("")))
            })
            .filter_map(|row| settled_millis(&row).map(|at| (at, row)))
            .filter(|(at, row)| {
                *at < before
                    || (*at == before
                        && after_id.is_some_and(|id| row["id"].as_str().unwrap_or("") > id))
            })
            .collect();
        rows.sort_by(|(a, ra), (b, rb)| {
            b.cmp(a)
                .then_with(|| ra["id"].as_str().cmp(&rb["id"].as_str()))
        });
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        if limit == 0 {
            for (_, row) in &rows {
                *counts
                    .entry(row["projectId"].as_str().unwrap_or("").to_owned())
                    .or_default() += 1;
            }
        }
        let threads: Vec<Value> = rows.into_iter().take(limit).map(|(_, row)| row).collect();
        let counts: Vec<Value> = counts
            .into_iter()
            .map(|(project_id, count)| json!({"projectId": project_id, "count": count}))
            .collect();
        Ok(json!({"snapshotSequence": self.high_water(), "threads": threads, "counts": counts}))
    }

    pub(crate) fn turn_item(&self, thread_id: &str, item_id: &str) -> StoreResult<Option<Value>> {
        Ok(self
            .query_json(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems' AND id = ?2",
                params![thread_id, item_id],
            )?
            .into_iter()
            .next())
    }

    /// `searchThreads`: the newest message of each thread that holds every search word, newest
    /// first, as `ThreadSearch.ts`. Titles are the client's to match.
    pub(crate) fn search_threads(&self, input: &Value) -> StoreResult<Value> {
        let limit = input["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
        let mut matches: Vec<Value> = Vec::new();
        // Messages only: the client matches titles itself, and `titlesOnly` asks for no message
        // search at all. A query with no long word searches no messages (`buildMessageSearch`).
        let Some(search) = (input["titlesOnly"] != true)
            .then(|| MessageSearch::new(input["query"].as_str().unwrap_or_default()))
            .flatten()
        else {
            return Ok(json!({"matches": matches}));
        };
        let sql = match search.fts_match {
            Some(_) => SEARCH_INDEXED_SQL,
            None => SEARCH_SCAN_SQL,
        };
        let substrings = json!(search.substrings).to_string();
        // `projectId` and `excludedThreadIds` are the server's own options (`/mcp` search);
        // client calls carry neither.
        let project_id = input["projectId"].as_str();
        let excluded = match &input["excludedThreadIds"] {
            Value::Array(ids) => Value::Array(ids.clone()).to_string(),
            _ => "[]".to_owned(),
        };
        let rows = self.query_rows(
            sql,
            params![
                search.fts_match,
                substrings,
                SEARCH_CANDIDATE_LIMIT,
                SEARCH_SCAN_LIMIT,
                SEARCH_HIT_LIMIT,
                project_id,
                excluded
            ],
        )?;
        let mut seen: Vec<String> = Vec::new();
        for (thread_id, hit) in rows {
            if matches.len() >= limit {
                break;
            }
            if seen.contains(&thread_id) {
                continue;
            }
            let message = &hit["message"];
            let text = message["text"].as_str().unwrap_or_default();
            let Some(at) = search.accept(text) else {
                continue;
            };
            matches.push(json!({
                "threadId": thread_id,
                "projectId": hit["projectId"],
                "source": if message["role"] == "user" { "user" } else { "assistant" },
                "snippet": snippet(text, at),
                "messageCreatedAt": message["createdAt"],
                "messageId": message["id"],
            }));
            seen.push(thread_id);
        }
        Ok(json!({"matches": matches}))
    }

    /// In-thread find (`ThreadFind.ts`): occurrences of the query in the thread's user and
    /// assistant messages and plans, in transcript order.
    pub(crate) fn search_thread(&self, input: &Value) -> StoreResult<Value> {
        let thread_id = input["threadId"].as_str().unwrap_or_default();
        let needle = input["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let mut items = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
             AND json_extract(body, '$.type') IN ('user_message', 'assistant_message', 'proposed_plan')
             ORDER BY ordinal",
            [thread_id],
        )?;
        items.retain(|item| item["status"] != "pending");
        let documents: Vec<(Value, Value, u64)> = items
            .iter()
            .map(|item| {
                let text = item["text"]
                    .as_str()
                    .or(item["markdown"].as_str())
                    .unwrap_or("");
                let entry = if item["type"] == "proposed_plan" {
                    item["id"].clone()
                } else {
                    item["messageId"].clone()
                };
                (
                    entry,
                    item["runId"].clone(),
                    count_occurrences(text, &needle),
                )
            })
            .collect();
        let total: u64 = documents.iter().map(|d| d.2).sum();
        let mut requested = input["index"].as_u64().unwrap_or(0);
        if input.get("index").is_none()
            && let Some(start) = input.get("start")
            && let Some(pos) = documents.iter().position(|d| d.0 == start["entryId"])
        {
            requested = documents[..pos].iter().map(|d| d.2).sum::<u64>()
                + start["occurrence"]
                    .as_u64()
                    .unwrap_or(0)
                    .min(documents[pos].2);
            if requested >= total {
                requested = 0;
            }
        }
        let active = if input.get("index").is_none() && total > 0 {
            // The offset comes from the client: add in i128, where no `i64` can overflow.
            let offset = input["offset"].as_i64().unwrap_or(0);
            let moved = (i128::from(requested) + i128::from(offset)).rem_euclid(i128::from(total));
            // `rem_euclid` by a `u64` total leaves a value in `0..total`.
            u64::try_from(moved).unwrap_or(0)
        } else {
            requested.min(total.saturating_sub(1))
        };
        let mut occurrence = active;
        let mut selected = None;
        for document in &documents {
            if occurrence < document.2 {
                selected = Some(document);
                break;
            }
            occurrence -= document.2;
        }
        let mut start_index = 0;
        let entries: Vec<Value> = documents
            .iter()
            .filter_map(|(entry, run, count)| {
                let row = json!({"entryId": entry, "runId": run, "startIndex": start_index, "count": count});
                start_index += count;
                (*count > 0).then_some(row)
            })
            .collect();
        let navigation: Vec<Value> = if entries.len() <= 17 {
            entries
        } else {
            let at = selected
                .and_then(|s| entries.iter().position(|e| e["entryId"] == s.0))
                .map_or(-1, |p| p as i64);
            let n = entries.len() as i64;
            (0..17)
                .map(|i| entries[(at + i - 8).rem_euclid(n) as usize].clone())
                .collect()
        };
        Ok(json!({
            "complete": true,
            "snapshotSequence": self.high_water(),
            "totalMatches": total,
            "activeIndex": active,
            "navigation": navigation,
            "match": selected.map(|(entry, run, _)| json!({"entryId": entry, "runId": run, "occurrence": occurrence})),
        }))
    }
}

fn count_occurrences(text: &str, needle: &str) -> u64 {
    if needle.is_empty() {
        return 0;
    }
    text.to_lowercase().matches(needle).count() as u64
}

/// Up to 240 characters of the original text around the match that starts at character `at`.
fn snippet(text: &str, at: usize) -> String {
    let start = at.saturating_sub(SNIPPET_CHARS / 3);
    text.chars()
        .skip(start)
        .take(SNIPPET_CHARS)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(text: &str, needle: &str) -> String {
        let folded = crate::fold::Folded::new(text, crate::fold::push_indexed);
        snippet(text, folded.find(needle).unwrap_or(0))
    }

    /// `İ` (U+0130) lowercases to two characters, so a lowercase index is not an index into
    /// the original text. Before the fix this panicked (`range start index 320 out of range`).
    #[test]
    fn snippet_survives_lowercase_expansion() {
        let text = format!("{}abc tail", "İ".repeat(200));
        let got = snip(&text, "abc");
        assert!(got.contains("abc tail"), "{got}");
        assert!(got.starts_with('İ'), "{got}");
        // The match sits 80 characters into the snippet, as for plain text.
        assert_eq!(got.chars().position(|c| c == 'a'), Some(SNIPPET_CHARS / 3));
    }

    fn plan(sql: &str, fts: Option<&str>) -> Vec<String> {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-plan-{}",
            std::process::id(),
            fts.is_some()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let plan = store.query_plan(
            sql,
            params![
                fts,
                "[]",
                SEARCH_CANDIDATE_LIMIT,
                SEARCH_SCAN_LIMIT,
                SEARCH_HIT_LIMIT,
                Some("project"),
                "[\"t\"]"
            ],
        );
        let _ = std::fs::remove_dir_all(&dir);
        plan
    }

    /// The bundled SQLite reads the trigram index through `MATCH` (an `M` plan, not the full
    /// `INDEX 0:` scan that `LIKE ... ESCAPE` gave), and every join after it is a key lookup.
    #[test]
    fn search_reads_the_index_first_and_never_scans_the_store() {
        let indexed = plan(SEARCH_INDEXED_SQL, Some("\"abc\""));
        println!(
            "indexed plan ({}):\n{}",
            rusqlite::version(),
            indexed.join("\n")
        );
        assert!(
            indexed.iter().any(
                |step| step.starts_with("SCAN message_search VIRTUAL TABLE INDEX")
                    && step.contains(":M")
            ),
            "{indexed:?}"
        );
        let scan = plan(SEARCH_SCAN_SQL, None);
        println!("scan plan:\n{}", scan.join("\n"));
        for steps in [&indexed, &scan] {
            assert!(
                steps.iter().any(|s| s == "SCAN h"),
                "hits come first: {steps:?}"
            );
            assert!(
                !steps
                    .iter()
                    .any(|s| ["SCAN e", "SCAN t", "SCAN k", "SCAN entities"]
                        .iter()
                        .any(|table| s == table || s.starts_with(&format!("{table} ")))),
                "{steps:?}"
            );
        }
    }

    #[test]
    fn short_words_follow_message_search_tokens() {
        assert!(MessageSearch::new("ch").is_none());
        assert!(MessageSearch::new("  ").is_none());
        // Quotes around the whole query go, as `WRAPPING_QUOTES`.
        let s = MessageSearch::new("“Snake_case is”").unwrap();
        assert_eq!(s.fts_match.as_deref(), Some("\"snake_case\""));
        assert_eq!(s.substrings, ["is"]);
        let s = MessageSearch::new("東京 say\"x").unwrap();
        assert_eq!(
            s.fts_match, None,
            "two CJK characters are too short for trigrams"
        );
        assert_eq!(s.substrings, ["東京", "say\"x"]);
        let s = MessageSearch::new("a\"bc").unwrap();
        assert_eq!(s.fts_match.as_deref(), Some("\"a\"\"bc\""));
    }

    #[test]
    fn snippet_handles_every_expanding_position() {
        for before in 0..300 {
            let text = format!("{}needle{}", "İ".repeat(before), "İ".repeat(before));
            assert!(snip(&text, "needle").contains("needle"));
            assert!(snip(&text, "absent").chars().count() <= SNIPPET_CHARS);
            assert_eq!(count_occurrences(&text, "needle"), 1);
        }
    }
}
