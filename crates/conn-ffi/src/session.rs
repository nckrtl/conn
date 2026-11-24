//! The app's one connection state machine. It owns the current attempt (its target, its
//! connection and its status), decides which events still count, when a failure re-pairs through
//! Orbit, and what Retry repeats. Swift renders [`FfiSessionState`] and calls the actions.

use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::Value;

use crate::OfflineReader;
use crate::core::{ConnCore, CoreListener};
use crate::orbit::{
    FfiOrbitConnectFailure, FfiOrbitConnectOutcome, FfiOrbitSession, OrbitCore,
    orbit_connect_failure,
};
use crate::types::{
    FfiConnectionStatus, FfiCredential, FfiError, FfiSavedSession, FfiShellSnapshot,
    FfiThreadSnapshot,
};

/// The cache directory's record of which server (identity) its contents belong to.
const IDENTITY_FILE: &str = "identity";

/// How long a thread link keeps trying a woken Instance: 12 tries, 5 s apart.
const LINK_TRIES: u32 = 12;
const LINK_RETRY_DELAY: Duration = Duration::from_secs(5);

/// What an attempt connects to; Retry repeats it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiSessionTarget {
    /// The primary `agent`-role Node, found through Orbit.
    PrimaryAgent,
    /// An Orbit environment, from a thread link or push (`thread_id`) or a saved linked
    /// environment.
    Environment {
        environment_id: String,
        thread_id: Option<String>,
    },
    /// A server paired by URL.
    Manual { server_url: String },
}

/// What the app shows.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiSessionPhase {
    /// No attempt: the pairing form, with the last manual failure if any.
    Idle { message: Option<String> },
    /// Finding the server; no connection yet.
    Connecting { target: FfiSessionTarget },
    /// A connection exists: the workspace, with its status.
    Live { status: FfiConnectionStatus },
    /// The attempt ended. `retry` is what Try again repeats.
    Failed {
        message: String,
        detail: Option<String>,
        retry: FfiSessionTarget,
    },
}

/// The one observable state. `revision` grows with every change, so an older state that
/// arrives late can be dropped.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiSessionState {
    pub revision: u64,
    /// The current attempt; snapshots carry it, and a change means the old data is gone.
    pub connection_id: u64,
    pub phase: FfiSessionPhase,
    pub server_url: Option<String>,
    /// The connected server's Conn environment id, once known.
    pub environment_id: Option<String>,
    /// A thread a link asked to show; take it with [`ConnSession::take_pending_thread`].
    pub pending_thread_id: Option<String>,
    /// The connection's offline thread cache is open; read it with [`ConnSession::offline_reader`].
    pub offline_ready: bool,
}

/// Implemented in Swift. Every method is called with no internal locks held.
#[uniffi::export(with_foreign)]
pub trait SessionListener: Send + Sync {
    fn on_state(&self, state: FfiSessionState);
    /// Store this session (or clear it with `None`) exactly as given.
    fn on_save(&self, session: Option<FfiSavedSession>);
    fn on_shell(&self, connection_id: u64, snapshot: FfiShellSnapshot);
    fn on_thread(&self, connection_id: u64, snapshot: FfiThreadSnapshot);
    fn on_error(&self, message: String);
    fn on_providers_changed(&self);
    /// The thread's stream reported `thread.deleted` on this connection.
    fn on_thread_deleted(&self, connection_id: u64, thread_id: String);
    /// A link for another environment: open it in that environment's own store and session.
    fn on_open_elsewhere(&self, environment_id: String, thread_id: String);
}

// ---------------------------------------------------------------------------
// The state machine (no I/O)
// ---------------------------------------------------------------------------

/// What the machine needs to know about a live connection.
pub(crate) trait SessionCore: Clone {
    fn auth_rejected(&self) -> bool;
    fn reused_bearer(&self) -> bool;
}

impl SessionCore for Arc<ConnCore> {
    fn auth_rejected(&self) -> bool {
        ConnCore::auth_rejected(self)
    }
    fn reused_bearer(&self) -> bool {
        ConnCore::reused_bearer(self)
    }
}

/// Side effects the runner carries out for the machine.
#[derive(Debug)]
pub(crate) enum Effect<C> {
    Start {
        id: u64,
        target: FfiSessionTarget,
        saved: Option<FfiSavedSession>,
        credential: Option<FfiCredential>,
    },
    Disconnect(C),
    Reconnect(C),
    Save(Option<FfiSavedSession>),
    FetchEnvironment {
        id: u64,
        server_url: String,
    },
    /// Open the offline thread cache of the server identified by `identity`.
    PrepareOffline {
        id: u64,
        core: C,
        identity: String,
    },
    /// Delete the offline thread cache: its server is no longer this session's.
    WipeCache,
    /// Subscribe to the thread the user has open.
    OpenThread {
        core: C,
        thread_id: String,
    },
    /// A link for another environment: the app opens it in that environment's own scope.
    OpenElsewhere {
        environment_id: String,
        thread_id: String,
    },
}

struct Attempt<C> {
    id: u64,
    target: FfiSessionTarget,
    core: Option<C>,
    status: FfiConnectionStatus,
    /// A `Failed` status that arrived before the connection was handed over.
    early_failure: Option<String>,
    /// The connection completed a handshake at least once.
    connected_once: bool,
    /// A rejected bearer may re-pair through Orbit. False for a re-pair attempt until it
    /// connects, so a fresh pairing that is rejected too can't loop.
    may_recover: bool,
    /// Which server this is (Orbit server id, or a manual server's environment id). The offline
    /// cache opens only once it is known, and belongs to it.
    identity: Option<String>,
    offline_ready: bool,
}

pub(crate) struct Machine<C> {
    revision: u64,
    next_id: u64,
    attempt: Option<Attempt<C>>,
    /// The phase while there is no attempt: `Idle` or `Failed`.
    rest: FfiSessionPhase,
    saved: Option<FfiSavedSession>,
    server_url: Option<String>,
    environment_id: Option<String>,
    pending_thread: Option<String>,
    /// Links that came while this session's environment was still unknown, oldest first.
    held_links: Vec<(String, String)>,
    /// The thread the user has open; subscribed on every connection this session attaches.
    open_thread: Option<String>,
}

impl<C> fmt::Debug for Machine<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Machine")
            .field("revision", &self.revision)
            .field("attempt", &self.attempt.as_ref().map(|a| a.id))
            .finish_non_exhaustive()
    }
}

type Effects<C> = Vec<Effect<C>>;

impl<C: SessionCore> Machine<C> {
    pub(crate) fn new() -> Self {
        Self {
            revision: 0,
            next_id: 1,
            attempt: None,
            rest: FfiSessionPhase::Idle { message: None },
            saved: None,
            server_url: None,
            environment_id: None,
            pending_thread: None,
            held_links: Vec::new(),
            open_thread: None,
        }
    }

    pub(crate) fn state(&self) -> FfiSessionState {
        let phase = match &self.attempt {
            None => self.rest.clone(),
            Some(a) if a.core.is_none() => FfiSessionPhase::Connecting {
                target: a.target.clone(),
            },
            Some(a) => FfiSessionPhase::Live {
                status: a.status.clone(),
            },
        };
        FfiSessionState {
            revision: self.revision,
            connection_id: self.attempt.as_ref().map_or(0, |a| a.id),
            phase,
            server_url: self.server_url.clone(),
            environment_id: self.environment_id.clone(),
            pending_thread_id: self.pending_thread.clone(),
            offline_ready: self.attempt.as_ref().is_some_and(|a| a.offline_ready),
        }
    }

    fn is_current(&self, id: u64) -> bool {
        self.attempt.as_ref().is_some_and(|a| a.id == id)
    }

    /// Ends the current attempt, if any.
    fn cancel(&mut self, fx: &mut Effects<C>) {
        if let Some(core) = self.attempt.take().and_then(|a| a.core) {
            fx.push(Effect::Disconnect(core));
        }
        self.server_url = None;
        self.environment_id = None;
        self.pending_thread = None;
    }

    fn begin(
        &mut self,
        target: FfiSessionTarget,
        credential: Option<FfiCredential>,
        may_recover: Recover,
    ) -> Effects<C> {
        let mut fx = Vec::new();
        self.cancel(&mut fx);
        let id = self.next_id;
        self.next_id += 1;
        if let FfiSessionTarget::Manual { server_url } = &target {
            self.server_url = Some(server_url.clone());
        }
        self.attempt = Some(Attempt {
            id,
            target: target.clone(),
            core: None,
            status: FfiConnectionStatus::Connecting,
            early_failure: None,
            connected_once: false,
            may_recover: may_recover == Recover::Allowed,
            identity: None,
            offline_ready: false,
        });
        fx.push(Effect::Start {
            id,
            target,
            saved: self.saved.clone(),
            credential,
        });
        fx
    }

    // -- user actions -------------------------------------------------------

    /// At launch: a manual session reconnects; anything else goes through Orbit.
    pub(crate) fn launch(&mut self, saved: Option<FfiSavedSession>) -> Effects<C> {
        self.saved = saved.clone();
        match saved {
            Some(s) if s.orbit_server_id.is_none() => self.begin(
                FfiSessionTarget::Manual {
                    server_url: s.server_url,
                },
                Some(FfiCredential::Bearer { token: s.bearer }),
                Recover::Allowed,
            ),
            _ => self.begin(FfiSessionTarget::PrimaryAgent, None, Recover::Allowed),
        }
    }

    /// A linked environment's session at launch: its saved environment or manual server.
    pub(crate) fn restore(&mut self, saved: Option<FfiSavedSession>) -> Effects<C> {
        self.saved = saved.clone();
        match saved {
            Some(FfiSavedSession {
                orbit_server_id: Some(environment_id),
                ..
            }) => self.begin(
                FfiSessionTarget::Environment {
                    environment_id,
                    thread_id: None,
                },
                None,
                Recover::Allowed,
            ),
            Some(s) => self.begin(
                FfiSessionTarget::Manual {
                    server_url: s.server_url,
                },
                Some(FfiCredential::Bearer { token: s.bearer }),
                Recover::Allowed,
            ),
            None => Vec::new(),
        }
    }

    pub(crate) fn connect_primary_agent(&mut self) -> Effects<C> {
        self.begin(FfiSessionTarget::PrimaryAgent, None, Recover::Allowed)
    }

    pub(crate) fn pair_manual(&mut self, server_url: String, pairing_code: String) -> Effects<C> {
        self.saved = None;
        let mut fx = vec![Effect::Save(None), Effect::WipeCache];
        fx.extend(self.begin(
            FfiSessionTarget::Manual { server_url },
            Some(FfiCredential::PairingCode { code: pairing_code }),
            Recover::Allowed,
        ));
        fx
    }

    /// "Connect manually": stop any attempt and show the pairing form.
    pub(crate) fn connect_manually(&mut self) -> Effects<C> {
        let mut fx = Vec::new();
        self.cancel(&mut fx);
        self.held_links.clear();
        self.rest = FfiSessionPhase::Idle { message: None };
        fx
    }

    pub(crate) fn sign_out(&mut self) -> Effects<C> {
        let mut fx = self.connect_manually();
        self.saved = None;
        self.open_thread = None;
        fx.push(Effect::Save(None));
        fx.push(Effect::WipeCache);
        fx
    }

    /// Try again: repeat a failed attempt's target, or nudge a live connection.
    pub(crate) fn retry(&mut self) -> Effects<C> {
        match &self.attempt {
            Some(a) => a.core.clone().map(Effect::Reconnect).into_iter().collect(),
            None => match self.rest.clone() {
                FfiSessionPhase::Failed { retry, .. } => self.begin(retry, None, Recover::Allowed),
                _ => Vec::new(),
            },
        }
    }

    /// The app came back to the foreground.
    pub(crate) fn foreground(&mut self) -> Effects<C> {
        self.retry()
    }

    /// The user opened a thread: subscribe now if connected, and on every later connection.
    pub(crate) fn open_thread(&mut self, thread_id: String) -> Effects<C> {
        self.open_thread = Some(thread_id.clone());
        self.attempt
            .as_ref()
            .and_then(|a| a.core.clone())
            .map(|core| Effect::OpenThread { core, thread_id })
            .into_iter()
            .collect()
    }

    pub(crate) fn close_thread(&mut self, thread_id: &str) -> Effects<C> {
        if self.open_thread.as_deref() == Some(thread_id) {
            self.open_thread = None;
        }
        Vec::new()
    }

    /// A thread link. This session takes it only for its own environment. While that is still
    /// unknown the link waits; a link for another environment opens elsewhere.
    pub(crate) fn open_link(&mut self, environment_id: String, thread_id: String) -> Effects<C> {
        let Some(attempt) = &self.attempt else {
            // Nothing here yet: the link's environment becomes this session's.
            return self.begin_link(environment_id, thread_id);
        };
        let own = match &attempt.target {
            FfiSessionTarget::Environment {
                environment_id: env,
                ..
            } => Some(env.clone()),
            _ => self.environment_id.clone(),
        };
        match own {
            None => {
                self.held_links.push((environment_id, thread_id));
                Vec::new()
            }
            Some(own) => self.route(own, environment_id, thread_id),
        }
    }

    /// Sends a link to this session when it is its environment, else elsewhere.
    fn route(&mut self, own: String, environment_id: String, thread_id: String) -> Effects<C> {
        if own != environment_id {
            return vec![Effect::OpenElsewhere {
                environment_id,
                thread_id,
            }];
        }
        self.pending_thread = Some(thread_id.clone());
        self.open_thread(thread_id)
    }

    fn begin_link(&mut self, environment_id: String, thread_id: String) -> Effects<C> {
        self.open_thread = Some(thread_id.clone());
        self.begin(
            FfiSessionTarget::Environment {
                environment_id,
                thread_id: Some(thread_id),
            },
            None,
            Recover::Allowed,
        )
    }

    pub(crate) fn take_pending_thread(&mut self) -> Option<String> {
        self.pending_thread.take()
    }

    // -- events -------------------------------------------------------------

    /// The attempt's connection exists. `environment_id` is the Orbit server id for Orbit
    /// targets; a manual server's comes from its saved session, then from the server.
    pub(crate) fn attached(
        &mut self,
        id: u64,
        core: C,
        server_url: String,
        environment_id: Option<String>,
    ) -> Effects<C> {
        if !self.is_current(id) {
            return vec![Effect::Disconnect(core)];
        }
        let saved_identity = self
            .saved
            .as_ref()
            .filter(|s| s.server_url == server_url)
            .and_then(|s| s.environment_id.clone());
        let Some(attempt) = self.attempt.as_mut() else {
            return Vec::new();
        };
        attempt.core = Some(core.clone());
        if let Some(message) = attempt.early_failure.take() {
            return self.failed(id, message);
        }
        let link_thread = match &attempt.target {
            FfiSessionTarget::Environment { thread_id, .. } => thread_id.clone(),
            _ => None,
        };
        let manual = environment_id.is_none();
        self.server_url = Some(server_url.clone());
        if link_thread.is_some() {
            self.pending_thread = link_thread;
        }
        let mut fx: Effects<C> = self
            .open_thread
            .clone()
            .map(|thread_id| Effect::OpenThread {
                core: core.clone(),
                thread_id,
            })
            .into_iter()
            .collect();
        if manual {
            fx.push(Effect::FetchEnvironment { id, server_url });
        }
        fx.extend(self.identified(id, environment_id.or(saved_identity)));
        fx
    }

    /// The attempt could not produce a connection.
    pub(crate) fn start_failed(
        &mut self,
        id: u64,
        message: String,
        detail: Option<String>,
    ) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        let mut fx = Vec::new();
        let target = self.attempt.as_ref().map(|a| a.target.clone());
        self.cancel(&mut fx);
        let mut held = std::mem::take(&mut self.held_links).into_iter();
        if let Some((env, thread)) = held.next() {
            // This session never learned its environment; the first link's becomes its own,
            // and the rest are routed against it.
            fx.extend(self.begin_link(env, thread));
            for (env, thread) in held {
                fx.extend(self.open_link(env, thread));
            }
            return fx;
        }
        self.rest = match target {
            Some(FfiSessionTarget::Manual { .. }) | None => FfiSessionPhase::Idle {
                message: Some(detail.unwrap_or(message)),
            },
            Some(retry) => FfiSessionPhase::Failed {
                message,
                detail,
                retry,
            },
        };
        fx
    }

    pub(crate) fn status(&mut self, id: u64, status: FfiConnectionStatus) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        let Some(attempt) = self.attempt.as_mut() else {
            return Vec::new();
        };
        if let FfiConnectionStatus::Failed { message } = status {
            if attempt.core.is_none() {
                attempt.early_failure = Some(message);
                return Vec::new();
            }
            return self.failed(id, message);
        }
        if status == FfiConnectionStatus::Connected {
            attempt.connected_once = true;
            attempt.may_recover = true;
        }
        attempt.status = status;
        Vec::new()
    }

    /// The live connection ended for good.
    fn failed(&mut self, id: u64, message: String) -> Effects<C> {
        let Some(attempt) = self.attempt.as_ref() else {
            return Vec::new();
        };
        let target = attempt.target.clone();
        let rejected = attempt
            .core
            .as_ref()
            .is_some_and(SessionCore::auth_rejected);
        let reused = attempt
            .core
            .as_ref()
            .is_some_and(SessionCore::reused_bearer);
        let orbit = !matches!(target, FfiSessionTarget::Manual { .. });
        if orbit && rejected && attempt.may_recover && (attempt.connected_once || reused) {
            // The bearer is dead: forget it and pair again through Orbit, once.
            self.saved = None;
            let mut fx = vec![Effect::Save(None)];
            fx.extend(self.begin(target, None, Recover::AfterConnecting));
            return fx;
        }
        let headline = if rejected {
            "The server rejected this iPhone's sign-in."
        } else {
            "The connection to the server failed."
        };
        let (message, detail) = if orbit {
            (headline.to_owned(), Some(message))
        } else {
            (message, None)
        };
        self.start_failed(id, message, detail)
    }

    pub(crate) fn bearer(&mut self, id: u64, mut session: FfiSavedSession) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        if session.environment_id.is_none() {
            session.environment_id = self.attempt.as_ref().and_then(|a| a.identity.clone());
        }
        self.saved = Some(session.clone());
        vec![Effect::Save(Some(session))]
    }

    /// A manual server named its environment (`None`: it couldn't be asked).
    pub(crate) fn environment(&mut self, id: u64, environment_id: Option<String>) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        let Some(env) = environment_id else {
            return Vec::new();
        };
        let known = self.attempt.as_ref().and_then(|a| a.identity.clone());
        match known {
            Some(known) if known == env => Vec::new(),
            // Another server now answers at this URL: start over so nothing of the old one's
            // cache carries over.
            Some(_) => self.restart_as(env),
            None => {
                let mut fx = self.identified(id, Some(env.clone()));
                if let Some(saved) = self.saved.as_mut().filter(|s| s.environment_id.is_none()) {
                    saved.environment_id = Some(env);
                    fx.push(Effect::Save(Some(saved.clone())));
                }
                fx
            }
        }
    }

    fn restart_as(&mut self, env: String) -> Effects<C> {
        let Some(saved) = self.saved.as_mut() else {
            return Vec::new();
        };
        saved.environment_id = Some(env);
        let saved = saved.clone();
        let mut fx = vec![Effect::Save(Some(saved.clone()))];
        fx.extend(self.begin(
            FfiSessionTarget::Manual {
                server_url: saved.server_url,
            },
            Some(FfiCredential::Bearer {
                token: saved.bearer,
            }),
            Recover::Allowed,
        ));
        fx
    }

    /// The attempt's server is now known: open its cache and route a held link.
    fn identified(&mut self, id: u64, identity: Option<String>) -> Effects<C> {
        let Some(identity) = identity else {
            return Vec::new();
        };
        let Some(attempt) = self.attempt.as_mut().filter(|a| a.id == id) else {
            return Vec::new();
        };
        attempt.identity = Some(identity.clone());
        let mut fx = Vec::new();
        if let Some(core) = attempt.core.clone() {
            fx.push(Effect::PrepareOffline {
                id,
                core,
                identity: identity.clone(),
            });
        }
        self.environment_id = Some(identity.clone());
        for (env, thread) in std::mem::take(&mut self.held_links) {
            fx.extend(self.route(identity.clone(), env, thread));
        }
        fx
    }

    pub(crate) fn offline_ready(&mut self, id: u64) -> Effects<C> {
        if let Some(attempt) = self.attempt.as_mut().filter(|a| a.id == id) {
            attempt.offline_ready = true;
        }
        Vec::new()
    }

    fn bump(&mut self) {
        self.revision += 1;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Recover {
    Allowed,
    AfterConnecting,
}

// ---------------------------------------------------------------------------
// The runner: ConnSession
// ---------------------------------------------------------------------------

/// UniFFI handle to the app's connection: one state machine plus the Orbit client it uses.
#[derive(uniffi::Object)]
pub struct ConnSession {
    orbit: Arc<OrbitCore>,
    listener: Arc<dyn SessionListener>,
    machine: Mutex<Machine<Arc<ConnCore>>>,
    /// Where this session keeps its offline thread cache, if anywhere.
    cache_dir: Option<PathBuf>,
    /// The current attempt's offline reader.
    offline: Mutex<Option<(u64, Arc<OfflineReader>)>>,
    this: Weak<ConnSession>,
}

impl fmt::Debug for ConnSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnSession").finish_non_exhaustive()
    }
}

impl ConnSession {
    pub(crate) fn with_orbit(
        orbit: Arc<OrbitCore>,
        cache_dir: Option<PathBuf>,
        listener: Arc<dyn SessionListener>,
    ) -> Arc<Self> {
        Arc::new_cyclic(|this| Self {
            orbit,
            listener,
            machine: Mutex::new(Machine::new()),
            cache_dir,
            offline: Mutex::new(None),
            this: this.clone(),
        })
    }

    /// Runs one machine step, carries out its effects, then publishes the new state.
    fn step(&self, f: impl FnOnce(&mut Machine<Arc<ConnCore>>) -> Effects<Arc<ConnCore>>) {
        let (fx, state) = {
            let mut machine = self.machine.lock().unwrap_or_else(|e| e.into_inner());
            let fx = f(&mut machine);
            machine.bump();
            (fx, machine.state())
        };
        for effect in fx {
            self.apply(effect);
        }
        self.listener.on_state(state);
    }

    fn is_current(&self, id: u64) -> bool {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_current(id)
    }

    fn apply(&self, effect: Effect<Arc<ConnCore>>) {
        match effect {
            Effect::Disconnect(core) => core.disconnect(),
            Effect::Reconnect(core) => core.reconnect(),
            Effect::Save(session) => self.listener.on_save(session),
            Effect::Start {
                id,
                target,
                saved,
                credential,
            } => {
                let Some(this) = self.this.upgrade() else {
                    return;
                };
                self.orbit
                    .handle()
                    .spawn(async move { this.run_attempt(id, target, saved, credential).await });
            }
            Effect::FetchEnvironment { id, server_url } => {
                let Some(this) = self.this.upgrade() else {
                    return;
                };
                self.orbit.handle().spawn(async move {
                    let env = fetch_environment_id(&server_url).await;
                    this.step(|m| m.environment(id, env));
                });
            }
            Effect::PrepareOffline { id, core, identity } => {
                let (Some(this), Some(dir)) = (self.this.upgrade(), self.cache_dir.clone()) else {
                    return;
                };
                if !self.claim_cache(id, &dir, &identity) {
                    return;
                }
                self.orbit.handle().spawn(async move {
                    this.open_offline(id, &core, dir, identity).await;
                });
            }
            Effect::OpenThread { core, thread_id } => core.open_thread(thread_id),
            Effect::OpenElsewhere {
                environment_id,
                thread_id,
            } => self.listener.on_open_elsewhere(environment_id, thread_id),
            Effect::WipeCache => {
                *self.offline.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if let Some(dir) = &self.cache_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
    }

    /// Makes the cache directory this attempt's server's, emptying it when it held another
    /// server's. Runs under the machine lock, so only the current attempt writes it.
    fn claim_cache(&self, id: u64, dir: &std::path::Path, identity: &str) -> bool {
        let machine = self.machine.lock().unwrap_or_else(|e| e.into_inner());
        if !machine.is_current(id) {
            return false;
        }
        claim_cache_dir(dir, identity).is_ok()
    }

    async fn open_offline(&self, id: u64, core: &ConnCore, dir: PathBuf, identity: String) {
        match core
            .prepare_offline(dir.to_string_lossy().into_owned(), identity)
            .await
        {
            Ok(reader) if self.is_current(id) => {
                *self.offline.lock().unwrap_or_else(|e| e.into_inner()) = Some((id, reader));
                self.step(|m| m.offline_ready(id));
            }
            Ok(_) => {}
            Err(err) => {
                if self.is_current(id) {
                    self.listener.on_error(err.to_string());
                }
            }
        }
    }

    fn listener_for(&self, id: u64) -> Arc<dyn CoreListener> {
        Arc::new(AttemptListener {
            session: self.this.clone(),
            id,
        })
    }

    async fn run_attempt(
        self: Arc<Self>,
        id: u64,
        target: FfiSessionTarget,
        saved: Option<FfiSavedSession>,
        credential: Option<FfiCredential>,
    ) {
        let listener = self.listener_for(id);
        match target {
            FfiSessionTarget::PrimaryAgent => {
                // Only a session saved for an Orbit environment can be reused here.
                let saved = saved.and_then(|s| {
                    s.orbit_server_id.map(|server_id| FfiOrbitSession {
                        server_id,
                        server_url: s.server_url,
                        bearer: s.bearer,
                    })
                });
                match self.orbit.connect_primary_agent(saved, listener).await {
                    FfiOrbitConnectOutcome::Connected {
                        core,
                        server_id,
                        server_url,
                        ..
                    } => self.step(|m| m.attached(id, core, server_url, Some(server_id))),
                    FfiOrbitConnectOutcome::Failed {
                        message, detail, ..
                    } => self.step(|m| m.start_failed(id, message, detail)),
                }
            }
            FfiSessionTarget::Environment { environment_id, .. } => {
                // A bearer saved for this environment is reused (and re-paired if refused).
                let cached = saved
                    .filter(|s| s.orbit_server_id.as_deref() == Some(environment_id.as_str()))
                    .map(|s| s.bearer);
                self.run_link(id, environment_id, cached, listener).await;
            }
            FfiSessionTarget::Manual { server_url } => {
                let Some(credential) = credential else {
                    self.step(|m| {
                        m.start_failed(id, "Paste a pairing URL to connect.".to_owned(), None)
                    });
                    return;
                };
                match ConnCore::connect(server_url, credential, listener) {
                    Ok(core) => {
                        let url = core.server_url();
                        self.step(|m| m.attached(id, core, url, None));
                    }
                    Err(err) => self.step(|m| m.start_failed(id, err.to_string(), None)),
                }
            }
        }
    }

    /// Finds the link's environment in the fleet, wakes it if it sleeps, then connects.
    async fn run_link(
        &self,
        id: u64,
        environment_id: String,
        mut cached: Option<String>,
        listener: Arc<dyn CoreListener>,
    ) {
        let fail = |err: &FfiError| match orbit_connect_failure(
            err,
            FfiOrbitConnectFailure::PairingRefused,
        ) {
            FfiOrbitConnectOutcome::Failed {
                message, detail, ..
            } => (message, detail),
            FfiOrbitConnectOutcome::Connected { core, .. } => {
                core.disconnect();
                (String::new(), None)
            }
        };
        let fleet = match self.orbit.fleet().await {
            Ok(fleet) => fleet,
            Err(err) => {
                let (message, detail) = fail(&err);
                self.step(|m| m.start_failed(id, message, detail));
                return;
            }
        };
        let Some(target) = fleet.into_iter().find(|t| t.server_id == environment_id) else {
            self.step(|m| {
                m.start_failed(
                    id,
                    "Orbit doesn't list the environment of that thread.".to_owned(),
                    None,
                )
            });
            return;
        };
        if let Some(instance_id) = target.instance_id
            && target.power_state == Some(crate::orbit::FfiOrbitPowerState::Stopped)
            && let Err(err) = self.orbit.wake_instance(instance_id).await
        {
            let (message, detail) = fail(&err);
            self.step(|m| m.start_failed(id, message, detail));
            return;
        }
        let mut last = None;
        for _ in 0..LINK_TRIES {
            if !self.is_current(id) {
                return;
            }
            match self
                .orbit
                .connect_environment(environment_id.clone(), cached.take(), Arc::clone(&listener))
                .await
            {
                Ok(core) => {
                    let url = core.server_url();
                    let env = environment_id.clone();
                    self.step(|m| m.attached(id, core, url, Some(env)));
                    return;
                }
                Err(err) => {
                    last = Some(err);
                    // A woken Instance takes a little while to serve.
                    tokio::time::sleep(LINK_RETRY_DELAY).await;
                }
            }
        }
        if let Some(err) = last {
            let (_, detail) = fail(&err);
            self.step(|m| {
                m.start_failed(
                    id,
                    "Couldn't open that thread through Orbit.".to_owned(),
                    detail,
                )
            });
        }
    }
}

#[uniffi::export]
impl ConnSession {
    /// Creates the session over an Orbit Gateway client (`gateway_url`, or the default).
    ///
    /// # Errors
    ///
    /// Returns the [`FfiError`] of [`OrbitCore::new`].
    #[uniffi::constructor]
    pub fn new(
        gateway_url: Option<String>,
        cache_directory: Option<String>,
        listener: Arc<dyn SessionListener>,
    ) -> Result<Arc<Self>, FfiError> {
        Ok(Self::with_orbit(
            OrbitCore::new(gateway_url)?,
            cache_directory.map(PathBuf::from),
            listener,
        ))
    }

    /// The app's main session at launch: a saved manual server, else the primary agent.
    pub fn launch(&self, saved: Option<FfiSavedSession>) {
        self.step(|m| m.launch(saved));
    }

    /// A linked environment's session at launch: its saved Orbit environment or manual server.
    pub fn restore(&self, saved: Option<FfiSavedSession>) {
        self.step(|m| m.restore(saved));
    }

    /// The current connection's offline thread cache, once open.
    #[must_use]
    pub fn offline_reader(&self) -> Option<Arc<OfflineReader>> {
        let slot = self.offline.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref()
            .filter(|(id, _)| self.is_current(*id))
            .map(|(_, reader)| Arc::clone(reader))
    }

    pub fn connect_primary_agent(&self) {
        self.step(Machine::connect_primary_agent);
    }

    pub fn pair_manual(&self, server_url: String, pairing_code: String) {
        self.step(|m| m.pair_manual(server_url, pairing_code));
    }

    pub fn connect_manually(&self) {
        self.step(Machine::connect_manually);
    }

    pub fn sign_out(&self) {
        self.step(Machine::sign_out);
    }

    pub fn retry(&self) {
        self.step(Machine::retry);
    }

    pub fn foreground(&self) {
        self.step(Machine::foreground);
    }

    pub fn open_link(&self, environment_id: String, thread_id: String) {
        self.step(|m| m.open_link(environment_id, thread_id));
    }

    /// The user opened this thread; it stays subscribed across this session's connections.
    pub fn open_thread(&self, thread_id: String) {
        self.step(|m| m.open_thread(thread_id));
    }

    pub fn close_thread(&self, thread_id: String) {
        if let Some(core) = self.core() {
            core.close_thread(thread_id.clone());
        }
        self.step(|m| m.close_thread(&thread_id));
    }

    /// The thread a link asked to show, once.
    pub fn take_pending_thread(&self) -> Option<String> {
        let mut taken = None;
        self.step(|m| {
            taken = m.take_pending_thread();
            Vec::new()
        });
        taken
    }

    /// The live connection, for thread and command calls.
    #[must_use]
    pub fn core(&self) -> Option<Arc<ConnCore>> {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .attempt
            .as_ref()
            .and_then(|a| a.core.clone())
    }

    #[must_use]
    pub fn state(&self) -> FfiSessionState {
        self.machine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state()
    }
}

/// Feeds one attempt's connection events into the session; events of an older attempt are
/// dropped there.
struct AttemptListener {
    session: Weak<ConnSession>,
    id: u64,
}

impl AttemptListener {
    fn current(&self) -> Option<Arc<ConnSession>> {
        self.session.upgrade().filter(|s| s.is_current(self.id))
    }
}

impl CoreListener for AttemptListener {
    fn on_status(&self, status: FfiConnectionStatus) {
        if let Some(session) = self.session.upgrade() {
            session.step(|m| m.status(self.id, status));
        }
    }

    fn on_bearer_issued(&self, session: FfiSavedSession) {
        if let Some(s) = self.session.upgrade() {
            s.step(|m| m.bearer(self.id, session));
        }
    }

    fn on_shell(&self, snapshot: FfiShellSnapshot) {
        if let Some(s) = self.current() {
            s.listener.on_shell(self.id, snapshot);
        }
    }

    fn on_thread(&self, snapshot: FfiThreadSnapshot) {
        if let Some(s) = self.current() {
            s.listener.on_thread(self.id, snapshot);
        }
    }

    fn on_error(&self, message: String) {
        if let Some(s) = self.current() {
            s.listener.on_error(message);
        }
    }

    fn on_providers_changed(&self) {
        if let Some(s) = self.current() {
            s.listener.on_providers_changed();
        }
    }

    fn on_thread_deleted(&self, thread_id: String) {
        if let Some(s) = self.current() {
            s.listener.on_thread_deleted(self.id, thread_id);
        }
    }
}

/// Empties `dir` unless it already belongs to `identity`, then marks it as `identity`'s.
fn claim_cache_dir(dir: &std::path::Path, identity: &str) -> std::io::Result<()> {
    let marker = dir.join(IDENTITY_FILE);
    if std::fs::read_to_string(&marker).ok().as_deref() != Some(identity) && dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(marker, identity)
}

/// Reads a server's Conn environment id (`/.well-known/t3/environment`).
async fn fetch_environment_id(server_url: &str) -> Option<String> {
    let url = url::Url::parse(server_url)
        .ok()?
        .join(".well-known/t3/environment")
        .ok()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let body: Value = client.get(url).send().await.ok()?.json().await.ok()?;
    body.get("environmentId")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use std::sync::Condvar;

    use conn_orbit::gateway::GatewayResponse;
    use serde_json::json;

    use super::*;
    use crate::orbit::tests::{MockGateway, spawn_mock_conn_server, spawn_rejecting_server};

    const AUTH: &str = "The server rejected this device's sign-in.";

    #[derive(Clone, Debug)]
    struct FakeCore {
        rejected: bool,
        reused: bool,
    }

    impl SessionCore for FakeCore {
        fn auth_rejected(&self) -> bool {
            self.rejected
        }
        fn reused_bearer(&self) -> bool {
            self.reused
        }
    }

    fn rejected() -> FakeCore {
        FakeCore {
            rejected: true,
            reused: false,
        }
    }

    fn failed(message: &str) -> FfiConnectionStatus {
        FfiConnectionStatus::Failed {
            message: message.to_owned(),
        }
    }

    fn starts(fx: &[Effect<FakeCore>]) -> Vec<(u64, FfiSessionTarget)> {
        fx.iter()
            .filter_map(|e| match e {
                Effect::Start { id, target, .. } => Some((*id, target.clone())),
                _ => None,
            })
            .collect()
    }

    fn link() -> FfiSessionTarget {
        FfiSessionTarget::Environment {
            environment_id: "inst-7".to_owned(),
            thread_id: Some("thread-1".to_owned()),
        }
    }

    #[test]
    fn a_rejection_before_the_connection_is_handed_over_still_ends_the_attempt() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        assert!(
            m.status(1, failed(AUTH)).is_empty(),
            "nothing to do before the handover"
        );
        let fx = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-agent".to_owned()),
        );
        assert!(
            starts(&fx).is_empty(),
            "a fresh pairing that is rejected doesn't re-pair"
        );
        assert!(
            matches!(
                m.state().phase,
                FfiSessionPhase::Failed {
                    retry: FfiSessionTarget::PrimaryAgent,
                    ..
                }
            ),
            "the handover doesn't turn the failure back into connecting: {:?}",
            m.state().phase
        );

        // The same early rejection of a reused bearer re-pairs at once.
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        let _ = m.status(1, failed(AUTH));
        let reused = FakeCore {
            rejected: true,
            reused: true,
        };
        let fx = m.attached(1, reused, "http://agent/".to_owned(), None);
        assert_eq!(
            starts(&fx),
            vec![(2, FfiSessionTarget::PrimaryAgent)],
            "a rejected reused bearer re-pairs through Orbit"
        );
    }

    #[test]
    fn a_manual_pair_supersedes_a_pending_link_which_never_saves() {
        let mut m = Machine::<FakeCore>::new();
        assert_eq!(
            starts(&m.open_link("inst-7".to_owned(), "thread-1".to_owned())),
            vec![(1, link())],
            "the link starts an attempt"
        );
        let fx = m.pair_manual("http://mac:3773".to_owned(), "code".to_owned());
        assert_eq!(
            starts(&fx).len(),
            1,
            "the manual pair starts its own attempt"
        );

        // The link's work finishes late.
        let fx = m.attached(
            1,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert!(
            matches!(fx.as_slice(), [Effect::Disconnect(_)]),
            "the late link connection is closed, not taken over"
        );
        let session = FfiSavedSession {
            server_url: "http://inst/".to_owned(),
            bearer: "late".to_owned(),
            orbit_server_id: Some("inst-7".to_owned()),
            environment_id: Some("inst-7".to_owned()),
        };
        assert!(
            m.bearer(1, session).is_empty(),
            "the late link never saves a bearer"
        );
        assert!(
            m.status(1, FfiConnectionStatus::Connected).is_empty(),
            "nor changes the status"
        );
        assert_eq!(
            m.state().connection_id,
            2,
            "the manual attempt stays current"
        );
        assert!(
            matches!(
                m.state().phase,
                FfiSessionPhase::Connecting {
                    target: FfiSessionTarget::Manual { .. }
                }
            ),
            "still pairing manually"
        );
    }

    #[test]
    fn retry_after_a_failed_link_repeats_the_link() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.open_link("inst-7".to_owned(), "thread-1".to_owned());
        let _ = m.start_failed(
            1,
            "Couldn't open that thread through Orbit.".to_owned(),
            None,
        );
        assert!(
            matches!(&m.state().phase, FfiSessionPhase::Failed { retry, .. } if *retry == link()),
            "the failure keeps the link as its retry target"
        );
        assert_eq!(
            starts(&m.retry()),
            vec![(2, link())],
            "Try again opens the same Instance and thread"
        );
        let _ = m.attached(
            2,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert_eq!(
            m.take_pending_thread().as_deref(),
            Some("thread-1"),
            "the thread opens once connected"
        );
    }

    #[test]
    fn a_bearer_revoked_after_success_re_pairs_exactly_once() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.connect_primary_agent();
        let _ = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-agent".to_owned()),
        );
        let _ = m.status(1, FfiConnectionStatus::Connected);

        // The bearer is revoked: the reconnect handshake gets 401.
        let fx = m.status(1, failed(AUTH));
        assert!(
            fx.iter().any(|e| matches!(e, Effect::Save(None))),
            "the dead bearer is forgotten"
        );
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::Start {
                    id: 2,
                    saved: None,
                    ..
                }
            )),
            "it pairs again through Orbit without the dead bearer"
        );

        // The fresh pairing is rejected too, before it ever connects: no second re-pair.
        let _ = m.attached(
            2,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-agent".to_owned()),
        );
        assert!(
            starts(&m.status(2, failed(AUTH))).is_empty(),
            "no mint-then-reject loop"
        );
        assert!(
            matches!(m.state().phase, FfiSessionPhase::Failed { .. }),
            "it ends as failed, with Try again"
        );
    }

    #[derive(Default)]
    struct Recorder {
        states: Mutex<Vec<FfiSessionState>>,
        deleted: Mutex<Vec<(u64, String)>>,
        notify: Condvar,
    }

    impl Recorder {
        fn wait_for(&self, pred: impl Fn(&FfiSessionState) -> bool) -> bool {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut guard = self.states.lock().expect("states");
            loop {
                if guard.iter().any(&pred) {
                    return true;
                }
                let Some(rem) = deadline.checked_duration_since(std::time::Instant::now()) else {
                    return false;
                };
                guard = self.notify.wait_timeout(guard, rem).expect("wait").0;
            }
        }
    }

    impl SessionListener for Recorder {
        fn on_state(&self, state: FfiSessionState) {
            self.states.lock().expect("states").push(state);
            self.notify.notify_all();
        }
        fn on_save(&self, _session: Option<FfiSavedSession>) {}
        fn on_shell(&self, _connection_id: u64, _snapshot: FfiShellSnapshot) {}
        fn on_thread(&self, _connection_id: u64, _snapshot: FfiThreadSnapshot) {}
        fn on_error(&self, _message: String) {}
        fn on_providers_changed(&self) {}
        fn on_thread_deleted(&self, connection_id: u64, thread_id: String) {
            self.deleted
                .lock()
                .expect("deleted")
                .push((connection_id, thread_id));
        }
        fn on_open_elsewhere(&self, _environment_id: String, _thread_id: String) {}
    }

    #[test]
    fn a_delete_from_a_superseded_attempt_clears_nothing() {
        let gateway = MockGateway::new(|_| {
            Err(conn_orbit::gateway::GatewayError::Network(
                "offline".to_owned(),
            ))
        });
        let recorder = Arc::new(Recorder::default());
        let cache = tempfile::tempdir().expect("cache dir");
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(cache.path().join("thread-cache")),
            recorder.clone(),
        );
        session.pair_manual("http://127.0.0.1:9".to_owned(), "old".to_owned());
        let old = session.state().connection_id;
        session.pair_manual("http://127.0.0.1:9".to_owned(), "new".to_owned());
        let new = session.state().connection_id;
        assert_ne!(old, new, "the second pair is a new attempt");

        let listener_of = |id| AttemptListener {
            session: Arc::downgrade(&session),
            id,
        };
        listener_of(old).on_thread_deleted("thread-1".to_owned());
        assert!(
            recorder.deleted.lock().expect("deleted").is_empty(),
            "a late delete from the old connection clears no draft"
        );
        listener_of(new).on_thread_deleted("thread-1".to_owned());
        assert_eq!(
            *recorder.deleted.lock().expect("deleted"),
            vec![(new, "thread-1".to_owned())],
            "the current connection's delete reaches its store, with its id"
        );
    }

    #[test]
    fn a_linked_environment_restores_its_own_target() {
        let mut m = Machine::<FakeCore>::new();
        let saved = FfiSavedSession {
            server_url: "http://inst/".to_owned(),
            bearer: "b".to_owned(),
            orbit_server_id: Some("inst-7".to_owned()),
            environment_id: Some("inst-7".to_owned()),
        };
        assert_eq!(
            starts(&m.restore(Some(saved))),
            vec![(
                1,
                FfiSessionTarget::Environment {
                    environment_id: "inst-7".to_owned(),
                    thread_id: None,
                }
            )],
            "a linked environment reconnects to itself, not the primary agent"
        );
    }

    #[test]
    fn a_session_whose_server_refuses_ends_failed_not_connecting() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let gw_url = rt.block_on(spawn_rejecting_server());
        let gateway = MockGateway::new(move |req| {
            let body = match req.path.as_str() {
                "/environments" => json!({ "data": [{
                    "environment_id": "node-agent",
                    "label": "agent",
                    "url": gw_url,
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null,
                    "roles": ["agent"]
                }]}),
                _ => json!({ "data": {
                    "pairing_url": format!("{gw_url}/pair#token=code"),
                    "pairing": { "environment_id": "node-agent" }
                }}),
            };
            Ok(GatewayResponse {
                status: 200,
                body: body.to_string(),
            })
        });
        let recorder = Arc::new(Recorder::default());
        let cache = tempfile::tempdir().expect("cache dir");
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(cache.path().join("thread-cache")),
            recorder.clone(),
        );
        session.connect_primary_agent();
        assert!(
            recorder.wait_for(|s| matches!(s.phase, FfiSessionPhase::Failed { .. })),
            "a refused pairing ends as failed"
        );
        let last = session.state();
        assert!(
            matches!(
                last.phase,
                FfiSessionPhase::Failed {
                    retry: FfiSessionTarget::PrimaryAgent,
                    ..
                }
            ),
            "and stays failed, with Try again: {last:?}"
        );
        assert!(session.core().is_none(), "no connection is left behind");
    }

    fn has_open_thread(fx: &[Effect<FakeCore>], thread: &str) -> bool {
        fx.iter()
            .any(|e| matches!(e, Effect::OpenThread { thread_id, .. } if thread_id == thread))
    }

    #[test]
    fn a_link_for_another_environment_before_this_one_is_known_opens_elsewhere() {
        let mut m = Machine::<FakeCore>::new();
        let saved = FfiSavedSession {
            server_url: "http://agent/".to_owned(),
            bearer: "a-bearer".to_owned(),
            orbit_server_id: Some("node-a".to_owned()),
            environment_id: Some("node-a".to_owned()),
        };
        let _ = m.launch(Some(saved.clone()));
        assert!(
            m.open_link("env-b".to_owned(), "thread-b".to_owned())
                .is_empty(),
            "the link waits while this session doesn't know its environment"
        );
        let _ = m.open_link("node-a".to_owned(), "thread-a".to_owned());
        let fx = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-a".to_owned()),
        );
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::OpenElsewhere { environment_id, .. } if environment_id == "env-b"
            )),
            "the held link for B goes to B's scope"
        );
        assert!(
            starts(&fx).is_empty(),
            "the main session doesn't reconnect elsewhere"
        );
        assert!(
            !fx.iter().any(|e| matches!(e, Effect::Save(_))),
            "A's bearer stays as it is"
        );
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::PrepareOffline { identity, .. } if identity == "node-a"
            )),
            "A's cache stays A's"
        );
        assert_eq!(
            m.take_pending_thread().as_deref(),
            Some("thread-a"),
            "a link for A opens in A"
        );

        // Now known: a link for B goes to B's own scope.
        let fx = m.open_link("env-b".to_owned(), "thread-b".to_owned());
        assert!(
            matches!(
                fx.as_slice(),
                [Effect::OpenElsewhere { environment_id, thread_id }]
                    if environment_id == "env-b" && thread_id == "thread-b"
            ),
            "a link for B opens in its own scope: {fx:?}"
        );
        assert_eq!(m.state().connection_id, 1, "A's connection stays current");

        // B held before A was known is routed elsewhere once A is.
        let mut m = Machine::<FakeCore>::new();
        let _ = m.launch(Some(saved));
        let _ = m.open_link("env-b".to_owned(), "thread-b".to_owned());
        let fx = m.attached(
            1,
            rejected(),
            "http://agent/".to_owned(),
            Some("node-a".to_owned()),
        );
        assert!(
            fx.iter().any(|e| matches!(
                e,
                Effect::OpenElsewhere { environment_id, .. } if environment_id == "env-b"
            )),
            "the held link for B goes to B's scope"
        );
        assert_eq!(
            m.state().environment_id.as_deref(),
            Some("node-a"),
            "this stays A"
        );
    }

    #[test]
    fn a_link_to_a_sleeping_environment_subscribes_its_thread_once_connected() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.open_link("inst-7".to_owned(), "thread-1".to_owned());
        // The user is already on the thread while the Instance wakes.
        assert!(
            !has_open_thread(&m.open_thread("thread-1".to_owned()), "thread-1"),
            "nothing to subscribe yet"
        );
        let fx = m.attached(
            1,
            rejected(),
            "http://inst/".to_owned(),
            Some("inst-7".to_owned()),
        );
        assert!(
            has_open_thread(&fx, "thread-1"),
            "the thread is subscribed as soon as the connection exists"
        );
    }

    #[test]
    fn a_superseded_environment_lookup_writes_nothing() {
        let mut m = Machine::<FakeCore>::new();
        let _ = m.pair_manual("http://a:3773".to_owned(), "code-a".to_owned());
        let fx = m.attached(1, rejected(), "http://a:3773/".to_owned(), None);
        assert!(
            fx.iter()
                .any(|e| matches!(e, Effect::FetchEnvironment { id: 1, .. })),
            "a manual server is asked for its environment"
        );
        assert!(
            !fx.iter()
                .any(|e| matches!(e, Effect::PrepareOffline { .. })),
            "no cache before the server's identity is known"
        );
        let _ = m.pair_manual("http://b:3773".to_owned(), "code-b".to_owned());
        assert!(
            m.environment(1, Some("env-a".to_owned())).is_empty(),
            "A's late answer opens, saves and writes nothing"
        );
        assert_eq!(m.state().environment_id, None, "B's environment isn't A's");
    }

    #[test]
    fn a_new_node_at_the_same_url_starts_with_an_empty_cache() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio rt");
        let (gw_url, server) = rt.block_on(spawn_mock_conn_server(
            "good",
            "code",
            "fresh",
            "/srv/workspace",
        ));
        let gateway = MockGateway::new(move |req| {
            let body = match req.path.as_str() {
                "/environments" => json!({ "data": [{
                    "environment_id": "node-new",
                    "label": "agent",
                    "url": gw_url,
                    "status": "registered",
                    "cleanup_pending": false,
                    "instance_id": null,
                    "roles": ["agent"]
                }]}),
                _ => json!({ "data": {
                    "pairing_url": format!("{gw_url}/pair#token=code"),
                    "pairing": { "environment_id": "node-new" }
                }}),
            };
            Ok(GatewayResponse {
                status: 200,
                body: body.to_string(),
            })
        });
        // The old Node at this URL left its cache behind.
        let cache = tempfile::tempdir().expect("cache dir");
        let dir = cache.path().join("thread-cache");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join(IDENTITY_FILE), "node-old").expect("marker");
        std::fs::write(dir.join("shell.json"), "old node's inbox").expect("old shell");

        let recorder = Arc::new(Recorder::default());
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            Some(dir.clone()),
            recorder.clone(),
        );
        session.connect_primary_agent();
        assert!(
            recorder.wait_for(|s| s.offline_ready),
            "the new Node's cache opens"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(IDENTITY_FILE))
                .expect("marker")
                .as_str(),
            "node-new",
            "the cache now belongs to the new Node"
        );
        assert!(
            !dir.join("shell.json").exists(),
            "nothing of the old Node's cache carries over"
        );
        if let Some(core) = session.core() {
            core.disconnect();
        }
        server.abort();
    }
}
