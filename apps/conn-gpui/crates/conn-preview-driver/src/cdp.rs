//! The one thing the page operations need from a browser: Chrome DevTools Protocol calls.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

/// A CDP call in flight.
pub type CdpFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;

/// Called for each CDP event with its method and params.
pub type EventListener = Arc<dyn Fn(&str, &Value) + Send + Sync + 'static>;

/// The page's CDP channel (the page's default target, with no session id).
pub trait Cdp: Send + Sync + 'static {
    /// Sends `method` and resolves with its result, or with the protocol's error message.
    fn send(&self, method: &str, params: Value) -> CdpFuture;
    /// Registers `listener` for CDP events until the returned [`Subscription`] drops.
    fn on_event(&self, listener: EventListener) -> Subscription;
}

/// Keeps an event listener registered; dropping it unregisters the listener.
#[must_use = "dropping a Subscription unregisters its listener"]
pub struct Subscription(Option<Box<dyn FnOnce() + Send + 'static>>);

impl Subscription {
    /// A subscription that runs `unsubscribe` when it drops.
    pub fn new(unsubscribe: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(unsubscribe)))
    }
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Subscription")
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(unsubscribe) = self.0.take() {
            unsubscribe();
        }
    }
}
