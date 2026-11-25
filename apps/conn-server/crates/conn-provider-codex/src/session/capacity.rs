//! Continue a failed root turn on the same Codex thread with empty input.
use super::*;
use tokio::time::Instant;

pub(super) struct Capacity {
    input: TurnInput,
    params: Value,
    attempts: u32,
    pending: Option<Pending>,
}

struct Pending {
    native: String,
    completion: Value,
    due: Instant,
    writing: bool,
    stopped: bool,
}

impl Capacity {
    pub(super) fn new(input: &TurnInput, params: &Value) -> Self {
        // Inline images can be large. Only retain the parameters reused for a continuation.
        let mut retained = Value::Object(
            params
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(k, _)| *k != "input")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        );
        retained["input"] = json!([]);
        Self {
            input: input.clone(),
            params: retained,
            attempts: 0,
            pending: None,
        }
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.pending.as_ref().filter(|p| !p.writing).map(|p| p.due)
    }
}

pub(super) fn schedule(state: &mut State, completion: &Value) -> bool {
    let Some(capacity) = state.capacity.as_mut() else {
        return false;
    };
    let Some(native) = completion["turn"]["id"].as_str() else {
        return false;
    };
    if completion["turn"]["status"] != "failed"
        || capacity.attempts >= 5
        || state.closed
        || !state.mapper.overloaded(
            native,
            capacity.input.run_id.as_str(),
            &completion["turn"]["error"]["codexErrorInfo"],
        )
    {
        if state
            .mapper
            .run_native_turn(capacity.input.run_id.as_str())
            .as_deref()
            == Some(native)
        {
            state.capacity = None;
        }
        return false;
    }
    if capacity.pending.is_none() {
        let delay = (2u64 << capacity.attempts).min(30);
        capacity.attempts += 1;
        capacity.pending = Some(Pending {
            native: native.to_owned(),
            completion: completion.clone(),
            due: Instant::now() + Duration::from_secs(delay),
            writing: false,
            stopped: false,
        });
    }
    true
}

pub(super) async fn continue_run(inner: &Inner) {
    let (thread, params) = {
        let mut state = inner.lock();
        if state.closed {
            state.capacity = None;
            return;
        }
        let Some(cap) = state.capacity.as_mut() else {
            return;
        };
        let Some(pending) = cap.pending.as_mut() else {
            return;
        };
        pending.writing = true;
        (
            cap.params["threadId"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            cap.params.clone(),
        )
    };
    let result = inner.server.request("turn/start", params).await;
    let new_native = result
        .as_ref()
        .ok()
        .and_then(|r| r["turn"]["id"].as_str())
        .map(str::to_owned);
    let (outs, stop_new) = {
        let mut state = inner.lock();
        let Some(mut cap) = state.capacity.take() else {
            return;
        };
        let Some(pending) = cap.pending.take() else {
            return;
        };
        if pending.stopped || state.closed {
            (vec![], true)
        } else if let (Ok(result), Some(_)) = (result, &new_native) {
            cap.input.provider_turn_ordinal += 1;
            let outs = state.mapper.hand_over_capacity(
                &pending.native,
                &pending.completion,
                &thread,
                &cap.input,
                &result,
            );
            state.capacity = Some(cap);
            (outs, false)
        } else {
            (state.mapper.capacity_failed(&pending.completion), false)
        }
    };
    if stop_new && let Some(turn) = new_native {
        tokio::spawn(interrupt(inner.server.clone(), thread, turn));
    }
    inner.deliver(outs).await;
}

pub(super) fn stop(state: &mut State, provider_turn: &str) -> Option<Vec<Out>> {
    let native = state.mapper.native_turn(provider_turn)?;
    let pending = state.capacity.as_mut()?.pending.as_mut()?;
    if native != pending.native {
        return None;
    }
    pending.stopped = true;
    if !pending.writing {
        state.capacity = None;
    }
    Some(state.mapper.end_interrupted(&native))
}

async fn wait_while(inner: &Inner, pending: impl Fn(&Capacity, &Pending) -> bool) {
    loop {
        let progress = inner.progressed.notified();
        tokio::pin!(progress);
        progress.as_mut().enable();
        {
            let state = inner.lock();
            if state.closed
                || !state
                    .capacity
                    .as_ref()
                    .is_some_and(|cap| cap.pending.as_ref().is_some_and(|p| pending(cap, p)))
            {
                return;
            }
        }
        progress.await;
    }
}

pub(super) async fn wait_for_continuation(inner: &Inner, run: &str) {
    wait_while(inner, |cap, _| cap.input.run_id.as_str() == run).await;
}

pub(super) async fn wait_for_writer(inner: &Inner) {
    wait_while(inner, |_, pending| pending.writing && pending.stopped).await;
}
