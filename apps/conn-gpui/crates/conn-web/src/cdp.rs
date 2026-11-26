//! In-process Chrome DevTools Protocol (CDP), JavaScript dialog, and file chooser bridge types
//! exposed by [`crate::BrowserView`] for desktop tab automation.

use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

/// Pending JavaScript dialog (`alert`, `confirm`, `prompt`, or `beforeunload`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsDialogInfo {
    /// `"alert"`, `"confirm"`, `"prompt"`, or `"beforeunload"`.
    pub dialog_type: String,
    pub message: String,
    pub default_value: String,
}

/// Pending `<input type="file">` chooser intercepted for an agent action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChooserInfo {
    pub multiple: bool,
    pub accept: String,
}

/// Callback invoked when a CDP method call finishes.
pub type CdpReply = Box<dyn FnOnce(Result<Value, String>) + Send + 'static>;

/// Callback invoked for each CDP event `(method, params)`.
pub type CdpEventListener = Arc<dyn Fn(&str, &Value) + Send + Sync + 'static>;

/// Callback invoked when a JS dialog or file chooser state changes.
pub type DialogChangeListener = Arc<dyn Fn() + Send + Sync + 'static>;

/// Sender hook implemented by the platform backend to push raw CDP JSON bytes onto CEF's UI thread.
pub(crate) type CdpDispatch = Arc<dyn Fn(Vec<u8>) -> Result<(), String> + Send + Sync + 'static>;

/// Shared state tracking pending CDP replies and event listeners for one [`crate::BrowserView`].
pub(crate) struct CdpCore {
    pub(crate) next_id: i32,
    pub(crate) pending: HashMap<i32, CdpReply>,
    pub(crate) listeners: Vec<(u64, CdpEventListener)>,
    pub(crate) next_listener_id: u64,
    pub(crate) closed: bool,
}

impl Default for CdpCore {
    fn default() -> Self {
        Self {
            next_id: 1,
            pending: HashMap::new(),
            listeners: Vec::new(),
            next_listener_id: 1,
            closed: false,
        }
    }
}

impl CdpCore {
    /// Routes a raw CDP JSON message delivered by CEF's `DevToolsMessageObserver`.
    pub(crate) fn on_message(&mut self, bytes: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        if let Some(id) = value
            .get("id")
            .and_then(Value::as_i64)
            .and_then(|n| i32::try_from(n).ok())
        {
            if let Some(reply) = self.pending.remove(&id) {
                if let Some(error) = value.get("error") {
                    let msg = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("CDP command failed")
                        .to_owned();
                    reply(Err(msg));
                } else {
                    reply(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
                }
            }
            return;
        }
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            let listeners: Vec<CdpEventListener> =
                self.listeners.iter().map(|(_, cb)| cb.clone()).collect();
            for cb in listeners {
                cb(method, &params);
            }
        }
    }

    /// Fails all pending CDP calls (called on detach or view close).
    pub(crate) fn fail_all(&mut self, reason: &str) {
        self.closed = true;
        for (_, reply) in self.pending.drain() {
            reply(Err(reason.to_owned()));
        }
    }
}

/// Thread-safe handle to a [`crate::BrowserView`]'s in-process CDP channel.
///
/// Can be cloned and used from background Tokio tasks; requests are marshaled onto CEF's UI
/// thread automatically.
#[derive(Clone)]
pub struct CdpHandle {
    core: Arc<Mutex<CdpCore>>,
    dispatch: CdpDispatch,
}

impl fmt::Debug for CdpHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CdpHandle").finish_non_exhaustive()
    }
}

impl CdpHandle {
    pub(crate) fn new(core: Arc<Mutex<CdpCore>>, dispatch: CdpDispatch) -> Self {
        Self { core, dispatch }
    }

    /// Sends one CDP command (`method`, `params`) and delivers its result to `reply`.
    pub fn send(&self, method: &str, params: Value, reply: CdpReply) {
        let id = {
            let Ok(mut core) = self.core.lock() else {
                reply(Err("CDP state lock poisoned.".to_owned()));
                return;
            };
            if core.closed {
                reply(Err("Browser view is closed.".to_owned()));
                return;
            }
            let id = core.next_id;
            core.next_id = core.next_id.wrapping_add(1).max(1);
            core.pending.insert(id, reply);
            id
        };
        let payload = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let bytes = match serde_json::to_vec(&payload) {
            Ok(b) => b,
            Err(err) => {
                if let Ok(mut core) = self.core.lock()
                    && let Some(cb) = core.pending.remove(&id)
                {
                    cb(Err(format!("Failed to encode CDP message: {err}")));
                }
                return;
            }
        };
        if let Err(err) = (self.dispatch)(bytes)
            && let Ok(mut core) = self.core.lock()
            && let Some(cb) = core.pending.remove(&id)
        {
            cb(Err(err));
        }
    }

    /// Registers a listener for CDP events and returns its unsubscribe id.
    #[must_use]
    pub fn add_event_listener(&self, listener: CdpEventListener) -> u64 {
        let Ok(mut core) = self.core.lock() else {
            return 0;
        };
        let id = core.next_listener_id;
        core.next_listener_id = core.next_listener_id.saturating_add(1);
        core.listeners.push((id, listener));
        id
    }

    /// Removes a previously registered CDP event listener.
    pub fn remove_event_listener(&self, listener_id: u64) {
        if let Ok(mut core) = self.core.lock() {
            core.listeners.retain(|(id, _)| *id != listener_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn cdp_core_routes_results_errors_and_events() {
        let core = Arc::new(Mutex::new(CdpCore::default()));
        let sent = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sent_clone = sent.clone();
        let handle = CdpHandle::new(
            core.clone(),
            Arc::new(move |bytes| {
                sent_clone.lock().expect("lock").push(bytes);
                Ok(())
            }),
        );

        let ok_result = Arc::new(Mutex::new(None::<Result<Value, String>>));
        let ok_clone = ok_result.clone();
        handle.send(
            "Runtime.evaluate",
            serde_json::json!({ "expression": "1+1" }),
            Box::new(move |res| {
                *ok_clone.lock().expect("lock") = Some(res);
            }),
        );

        let err_result = Arc::new(Mutex::new(None::<Result<Value, String>>));
        let err_clone = err_result.clone();
        handle.send(
            "Page.bad",
            serde_json::json!({}),
            Box::new(move |res| {
                *err_clone.lock().expect("lock") = Some(res);
            }),
        );

        let event_count = Arc::new(AtomicUsize::new(0));
        let ev_clone = event_count.clone();
        let listener_id = handle.add_event_listener(Arc::new(move |method, _| {
            if method == "Page.loadEventFired" {
                ev_clone.fetch_add(1, Ordering::SeqCst);
            }
        }));

        assert_eq!(sent.lock().expect("lock").len(), 2, "two CDP calls sent");

        {
            let mut guard = core.lock().expect("lock");
            guard.on_message(br#"{"id":1,"result":{"value":2}}"#);
            guard.on_message(br#"{"id":2,"error":{"code":-32601,"message":"not found"}}"#);
            guard.on_message(br#"{"method":"Page.loadEventFired","params":{"timestamp":1.0}}"#);
        }

        assert_eq!(
            *ok_result.lock().expect("lock"),
            Some(Ok(serde_json::json!({"value": 2}))),
            "result routed by id"
        );
        assert_eq!(
            *err_result.lock().expect("lock"),
            Some(Err("not found".to_owned())),
            "error routed by id"
        );
        assert_eq!(
            event_count.load(Ordering::SeqCst),
            1,
            "CDP event delivered to listener"
        );

        handle.remove_event_listener(listener_id);
        {
            let mut guard = core.lock().expect("lock");
            guard.on_message(br#"{"method":"Page.loadEventFired","params":{"timestamp":2.0}}"#);
        }
        assert_eq!(
            event_count.load(Ordering::SeqCst),
            1,
            "removed listener stops receiving events"
        );
    }
}
