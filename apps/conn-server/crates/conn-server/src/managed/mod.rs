//! Managed access: the target side of Orbit's "Managed grant revocation" contract
//! (`docs/managed-access.md`).
//!
//! A managed target serves Orbit callers on a managed ingress, separate from the native one.
//! A caller presents a Gateway-issued `conn_mt_` token. The target checks it with the Gateway
//! at each transport admission, binds it to the caller's TCP peer, and admits it only against
//! the authority revision it has applied. When the Gateway removes the caller's direct Node
//! edge, the target fences that edge: every socket, stream and queued frame of it ends, and
//! new calls and reconnects are refused. Other edges keep running. When the target loses the
//! Gateway (a failed probe, an expired lease, a closed notice link) it fails closed for all
//! managed access until a fresh snapshot with a live lease.
//!
//! - [`authority`]: the state and its rules, without I/O.
//! - [`gateway`]: the Gateway's target routes over HTTPS with the lab CA.
//! - [`notices`]: the Reverb subscription that wakes the target on a removal.
//! - [`ingress`]: the managed HTTP and WebSocket routes.

pub mod authority;
pub mod gateway;
pub mod ingress;
pub mod notices;
pub mod provision;

use std::sync::{Arc, Mutex};

use futures_core::future::BoxFuture;
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    sync::{Notify, watch},
    time::Instant,
};

use authority::{Authority, AuthorityReply, EdgeId, Effects, Loss, Notice, Refusal};
use gateway::{Gateway, GatewayError};

pub use provision::Provision;

/// The scopes of the `reader` purpose. The Gateway fixes them; the target admits a reader
/// only with exactly these.
pub const READER_SCOPES: [&str; 2] = ["orchestration:read", "terminal:read"];

/// The authority shared by the ingress, the probe loop, the notice link and every handler.
pub struct Shared {
    authority: Mutex<Authority>,
    /// Raised on every change, so waiters and the lease timer look again.
    changed: watch::Sender<u64>,
    wake_probe: Notify,
    wake_ack: Notify,
}

impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shared").finish_non_exhaustive()
    }
}

/// The verified claims of a managed token, as `/introspect` returns them.
#[derive(Clone, Debug, Deserialize)]
pub struct Claims {
    pub nonce: String,
    pub environment_id: String,
    pub generation: u64,
    pub token_id: Value,
    pub caller_node_id: u64,
    pub edge_id: EdgeId,
    pub scopes: Vec<String>,
    pub expires_at: String,
    pub revision: u64,
    /// Fields later contracts add (the task worker grant). Kept, never trusted unread.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// An admitted managed caller.
#[derive(Clone, Debug)]
pub struct ManagedPrincipal {
    pub token_id: String,
    pub caller_node_id: u64,
    pub edge_id: EdgeId,
    pub scopes: Vec<String>,
    pub expires_ms: u64,
    pub claims: Arc<Claims>,
}

/// Why an admission failed. Each maps to one response; none falls through to native auth.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdmitError {
    /// Not a managed token, or one the Gateway refused.
    Invalid,
    /// The token is valid but its edge is fenced, it expired, or its profile does not allow
    /// this ingress.
    Forbidden,
    /// Managed access is unavailable now (failed closed, recovering, Gateway unreachable).
    Unavailable,
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    conn_support::base64::url_encode(&bytes)
}

fn now_ms() -> u64 {
    conn_support::time::now_ms()
}

impl Shared {
    pub fn new(environment_id: String, generation: u64) -> Arc<Self> {
        Arc::new(Self {
            authority: Mutex::new(Authority::new(environment_id, generation)),
            changed: watch::channel(0).0,
            wake_probe: Notify::new(),
            wake_ack: Notify::new(),
        })
    }

    /// Runs `f` on the authority under the lock, then wakes whoever its effects name.
    pub fn with<T>(&self, f: impl FnOnce(&mut Authority) -> (T, Effects)) -> T {
        let (value, effects) = {
            let mut authority = crate::lock(&self.authority);
            f(&mut authority)
        };
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
        if effects.probe_now {
            self.wake_probe.notify_one();
        }
        if effects.ack {
            self.wake_ack.notify_one();
        }
        value
    }

    /// Reads the authority under the lock.
    pub fn read<T>(&self, f: impl FnOnce(&Authority) -> T) -> T {
        f(&crate::lock(&self.authority))
    }

    pub fn notice(&self, notice: &Notice) {
        self.with(|a| ((), a.notice(notice, Instant::now(), now_ms())));
    }

    pub fn set_notice_link(&self, up: bool) {
        self.with(|a| ((), a.set_notice_link(up)));
    }

    pub fn fail_closed(&self, loss: Loss) {
        self.with(|a| {
            a.fail_closed(loss);
            ((), Effects::default())
        });
    }

    fn wait_change(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// Starts the probe loop, the lease timer and the ACK loop. They run for the life of the
    /// process.
    pub fn spawn(self: &Arc<Self>, gateway: Arc<dyn Gateway>) {
        tokio::spawn(probe_loop(self.clone(), gateway.clone()));
        tokio::spawn(lease_timer(self.clone()));
        tokio::spawn(ack_loop(self.clone(), gateway));
    }

    /// Checks a managed bearer with the Gateway and admits it, registering its handler in
    /// the same step. `allowed` checks the claims' profile for the route.
    pub async fn admit(
        self: &Arc<Self>,
        gateway: &Arc<dyn Gateway>,
        token: &str,
        peer_address: String,
        allowed: impl Fn(&Claims) -> bool,
    ) -> Result<(ManagedPrincipal, Handle), AdmitError> {
        if !provision::has_secret_shape(token, provision::MANAGED_TOKEN_PREFIX) {
            return Err(AdmitError::Invalid);
        }
        let (environment_id, generation) =
            self.read(|a| (a.environment_id().to_owned(), a.generation()));
        let mut changes = self.wait_change();
        // A barrier or a reconcile asks for a fresh introspection; a few rounds at most.
        for _ in 0..4 {
            let (epoch, available) = self.read(|a| (a.epoch(), a.available(Instant::now())));
            if !available {
                // Callers that arrive while the target recovers wait for it, up to a lease.
                if tokio::time::timeout(authority::LEASE, changes.changed())
                    .await
                    .is_err()
                {
                    return Err(AdmitError::Unavailable);
                }
                continue;
            }
            let nonce = random_nonce();
            let reply =
                bounded(gateway.introspect(nonce.clone(), token.to_owned(), peer_address.clone()))
                    .await;
            let claims = match reply {
                Ok(value) => match serde_json::from_value::<Claims>(value) {
                    Ok(claims) => claims,
                    Err(_) => {
                        self.fail_closed(Loss::ProbeFailed);
                        return Err(AdmitError::Unavailable);
                    }
                },
                Err(GatewayError::Refused { status, .. }) if (400..500).contains(&status) => {
                    return Err(AdmitError::Invalid);
                }
                Err(_) => {
                    // The Gateway cannot answer: a failed check.
                    self.fail_closed(Loss::ProbeFailed);
                    return Err(AdmitError::Unavailable);
                }
            };
            if claims.nonce != nonce {
                // Never sent or already consumed: drop it.
                return Err(AdmitError::Invalid);
            }
            if claims.environment_id != environment_id || claims.generation != generation {
                self.fail_closed(Loss::WrongIdentity);
                return Err(AdmitError::Unavailable);
            }
            let Some(expires_ms) = conn_support::time::millis_from_iso(&claims.expires_at)
                .and_then(|ms| u64::try_from(ms).ok())
            else {
                return Err(AdmitError::Invalid);
            };
            if !allowed(&claims) {
                return Err(AdmitError::Forbidden);
            }
            let admitted = self.with(|a| {
                (
                    a.admit(
                        claims.edge_id,
                        claims.revision,
                        expires_ms,
                        epoch,
                        Instant::now(),
                        now_ms(),
                    ),
                    Effects::default(),
                )
            });
            match admitted {
                Ok((id, closed)) => {
                    let principal = ManagedPrincipal {
                        token_id: id_text(&claims.token_id),
                        caller_node_id: claims.caller_node_id,
                        edge_id: claims.edge_id,
                        scopes: claims.scopes.clone(),
                        expires_ms,
                        claims: Arc::new(claims),
                    };
                    let handle = Handle {
                        shared: self.clone(),
                        id,
                        expires_ms,
                        closed,
                    };
                    return Ok((principal, handle));
                }
                Err(Refusal::Fenced | Refusal::Expired) => return Err(AdmitError::Forbidden),
                Err(Refusal::Stale) => {}
                Err(Refusal::Reconcile) => {
                    // The Gateway is ahead of us: reconcile first, then introspect again.
                    self.wake_probe.notify_one();
                    let target = claims.revision;
                    let caught_up = tokio::time::timeout(authority::LEASE, async {
                        loop {
                            if self.read(|a| a.applied().is_some_and(|r| r >= target)) {
                                return;
                            }
                            if changes.changed().await.is_err() {
                                return std::future::pending().await;
                            }
                        }
                    })
                    .await;
                    if caught_up.is_err() {
                        return Err(AdmitError::Unavailable);
                    }
                }
                Err(Refusal::Unavailable) => {}
            }
        }
        Err(AdmitError::Unavailable)
    }
}

/// A Gateway call that answers within [`gateway::CALL_TIMEOUT`], or a transport failure.
async fn bounded(
    call: BoxFuture<'static, Result<Value, GatewayError>>,
) -> Result<Value, GatewayError> {
    tokio::time::timeout(gateway::CALL_TIMEOUT, call)
        .await
        .unwrap_or_else(|_| Err(GatewayError::Transport("timeout".into())))
}

fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// One registered managed handler: a socket, a stream or one HTTP request. It is the gate
/// that the RPC session and the media stream check at every boundary. Dropping it records
/// the close.
pub struct Handle {
    shared: Arc<Shared>,
    id: u64,
    expires_ms: u64,
    closed: watch::Receiver<bool>,
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle").field("id", &self.id).finish()
    }
}

impl Handle {
    /// Whether the handler may still send or dispatch.
    pub fn open(&self) -> bool {
        if *self.closed.borrow() {
            return false;
        }
        let now = Instant::now();
        let expired_lease = self
            .shared
            .read(|a| a.is_open() && a.lease_until().is_none_or(|t| now >= t));
        if expired_lease {
            self.shared.with(|a| {
                a.check_lease(now);
                ((), Effects::default())
            });
        }
        self.shared
            .read(|a| a.handler_allowed(self.id, self.expires_ms, now, now_ms()))
    }

    /// Resolves when the fence closes this handler or its token expires.
    pub fn closed(&self) -> BoxFuture<'static, ()> {
        let mut closed = self.closed.clone();
        let left = self.expires_ms.saturating_sub(now_ms());
        Box::pin(async move {
            tokio::select! {
                _ = closed.wait_for(|c| *c) => {}
                () = tokio::time::sleep(std::time::Duration::from_millis(left)) => {}
            }
        })
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        let id = self.id;
        self.shared.with(|a| ((), a.unregister(id, now_ms())));
    }
}

impl crate::session::Gate for Handle {
    fn open(&self) -> bool {
        Handle::open(self)
    }

    fn closed(&self) -> BoxFuture<'static, ()> {
        Handle::closed(self)
    }
}

async fn probe_loop(shared: Arc<Shared>, gateway: Arc<dyn Gateway>) {
    loop {
        let now = Instant::now();
        let probe = shared.with(|a| (a.begin_probe(random_nonce(), now), Effects::default()));
        let mut next = now + authority::PROBE_EVERY;
        if let Some(probe) = probe {
            next = probe.sent + authority::PROBE_EVERY;
            let result =
                bounded(gateway.authority(probe.nonce.clone(), probe.after_revision)).await;
            let reply = result
                .ok()
                .and_then(|value| serde_json::from_value::<AuthorityReply>(value).ok());
            let again = shared.with(|a| match &reply {
                Some(reply) => {
                    let effects = a.apply_reply(reply, Instant::now(), now_ms());
                    (effects.probe_now, effects)
                }
                None => {
                    a.probe_failed(&probe.nonce);
                    (false, Effects::default())
                }
            });
            if again {
                continue;
            }
        }
        tokio::select! {
            () = tokio::time::sleep_until(next) => {}
            () = shared.wake_probe.notified() => {}
        }
    }
}

/// Fences at the end of the lease even when no frame or call looks.
async fn lease_timer(shared: Arc<Shared>) {
    let mut changes = shared.wait_change();
    loop {
        let until = shared.read(|a| a.is_open().then(|| a.lease_until()).flatten());
        match until {
            Some(until) => tokio::select! {
                () = tokio::time::sleep_until(until) => {
                    shared.with(|a| {
                        a.check_lease(Instant::now());
                        ((), Effects::default())
                    });
                }
                _ = changes.changed() => {}
            },
            None => {
                if changes.changed().await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn ack_loop(shared: Arc<Shared>, gateway: Arc<dyn Gateway>) {
    loop {
        let ack = shared.with(|a| {
            let ack = a.next_ack();
            if let Some(ack) = &ack {
                a.ack_started(ack.revision);
            }
            (ack, Effects::default())
        });
        let Some(ack) = ack else {
            tokio::select! {
                () = shared.wake_ack.notified() => {}
                () = tokio::time::sleep(authority::PROBE_EVERY) => {}
            }
            continue;
        };
        let iso = |ms: Option<u64>| ms.map(conn_support::time::iso_from_ms);
        let body = serde_json::json!({
            "revision": ack.revision,
            "kind": match ack.kind {
                authority::AckKind::Observed => "observed",
                authority::AckKind::Recovered => "recovered",
            },
            "notice_received_at": iso(ack.notice_received_ms),
            "fenced_at": iso(ack.fenced_ms),
            "handlers_closed_at": iso(ack.handlers_closed_ms),
            "recovered_at": iso(ack.recovered_ms),
        });
        let result = bounded(gateway.ack(body)).await;
        if let Err(GatewayError::Refused { code, .. }) = &result
            && code == "conn.managed_generation_mismatch"
        {
            shared.fail_closed(Loss::WrongIdentity);
        }
        // An ACK the Gateway does not know is not owed: stop sending it. A lost one stays owed.
        let ok = match &result {
            Ok(_) => true,
            Err(GatewayError::Refused { code, .. }) => code == "conn.managed_ack_unknown",
            Err(GatewayError::Transport(_)) => false,
        };
        shared.with(|a| ((), a.ack_finished(ack.revision, ok)));
        if !ok {
            tokio::time::sleep(authority::PROBE_EVERY).await;
        }
    }
}

#[cfg(test)]
mod tests;
