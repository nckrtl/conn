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

/// Files in the cache directory: the server it belongs to, and that server's environment id.
const SERVER_FILE: &str = "server";
const ENVIRONMENT_FILE: &str = "environment";

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
    /// Open the connection's offline thread cache.
    PrepareOffline {
        id: u64,
        core: C,
    },
    /// Delete the offline thread cache: its server is no longer this session's.
    WipeCache,
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
    /// A link that came while the current server's environment was still unknown.
    deferred_link: Option<(String, String)>,
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
            deferred_link: None,
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
        self.deferred_link = None;
        self.rest = FfiSessionPhase::Idle { message: None };
        fx
    }

    pub(crate) fn sign_out(&mut self) -> Effects<C> {
        let mut fx = self.connect_manually();
        self.saved = None;
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

    pub(crate) fn open_link(&mut self, environment_id: String, thread_id: String) -> Effects<C> {
        if self.environment_id.as_deref() == Some(environment_id.as_str())
            && self.attempt.as_ref().is_some_and(|a| a.core.is_some())
        {
            self.pending_thread = Some(thread_id);
            return Vec::new();
        }
        // An attempt whose environment isn't known yet decides once it is, unless it is
        // already a link to another environment.
        let wait = self.environment_id.is_none()
            && self
                .attempt
                .as_ref()
                .is_some_and(|a| !matches!(&a.target, FfiSessionTarget::Environment { .. }));
        if wait {
            self.deferred_link = Some((environment_id, thread_id));
            return Vec::new();
        }
        self.begin_link(environment_id, thread_id)
    }

    fn begin_link(&mut self, environment_id: String, thread_id: String) -> Effects<C> {
        self.deferred_link = None;
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

    /// The attempt's connection exists. `environment_id` is known for Orbit targets.
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
        let Some(attempt) = self.attempt.as_mut() else {
            return Vec::new();
        };
        attempt.core = Some(core);
        let early = attempt.early_failure.take();
        let link_thread = match &attempt.target {
            FfiSessionTarget::Environment { thread_id, .. } => thread_id.clone(),
            _ => None,
        };
        let core = attempt.core.clone();
        if let Some(message) = early {
            return self.failed(id, message);
        }
        self.server_url = Some(server_url.clone());
        if link_thread.is_some() {
            self.pending_thread = link_thread;
        }
        let mut fx = match environment_id {
            Some(env) => self.environment(id, Some(env)),
            None => vec![Effect::FetchEnvironment { id, server_url }],
        };
        if let Some(core) = core {
            fx.push(Effect::PrepareOffline { id, core });
        }
        fx
    }

    /// The offline cache remembered this server's environment; use it until the server says.
    pub(crate) fn cached_environment(&mut self, id: u64, environment_id: String) -> Effects<C> {
        if !self.is_current(id) || self.environment_id.is_some() {
            return Vec::new();
        }
        self.environment(id, Some(environment_id))
    }

    pub(crate) fn offline_ready(&mut self, id: u64) -> Effects<C> {
        if let Some(attempt) = self.attempt.as_mut().filter(|a| a.id == id) {
            attempt.offline_ready = true;
        }
        Vec::new()
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
        if let Some((env, thread)) = self.deferred_link.take() {
            fx.extend(self.begin_link(env, thread));
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

    pub(crate) fn bearer(&mut self, id: u64, session: FfiSavedSession) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        self.saved = Some(session.clone());
        vec![Effect::Save(Some(session))]
    }

    pub(crate) fn environment(&mut self, id: u64, environment_id: Option<String>) -> Effects<C> {
        if !self.is_current(id) {
            return Vec::new();
        }
        self.environment_id = environment_id;
        match self.deferred_link.take() {
            Some((env, thread)) if self.environment_id.as_deref() == Some(env.as_str()) => {
                self.pending_thread = Some(thread);
                Vec::new()
            }
            Some((env, thread)) => self.begin_link(env, thread),
            None => Vec::new(),
        }
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
                    // Offline, the cache's remembered environment stands in.
                    if let Some(env) = fetch_environment_id(&server_url).await {
                        if let Some(dir) = &this.cache_dir {
                            let _ = std::fs::write(dir.join(ENVIRONMENT_FILE), &env);
                        }
                        this.step(|m| m.environment(id, Some(env)));
                    }
                });
            }
            Effect::PrepareOffline { id, core } => {
                let (Some(this), Some(dir)) = (self.this.upgrade(), self.cache_dir.clone()) else {
                    return;
                };
                self.orbit
                    .handle()
                    .spawn(async move { this.prepare_offline(id, &core, dir).await });
            }
            Effect::WipeCache => {
                *self.offline.lock().unwrap_or_else(|e| e.into_inner()) = None;
                if let Some(dir) = &self.cache_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        }
    }

    /// Opens the cache for this connection's server, starting it afresh when the server changed.
    async fn prepare_offline(&self, id: u64, core: &ConnCore, dir: PathBuf) {
        let server_url = core.server_url();
        let marker = dir.join(SERVER_FILE);
        if std::fs::read_to_string(&marker).ok().as_deref() != Some(server_url.as_str()) {
            let _ = std::fs::remove_dir_all(&dir);
        }
        if std::fs::create_dir_all(&dir).is_err() || std::fs::write(&marker, &server_url).is_err() {
            return;
        }
        if let Ok(env) = std::fs::read_to_string(dir.join(ENVIRONMENT_FILE)) {
            self.step(|m| m.cached_environment(id, env));
        }
        match core
            .prepare_offline(dir.to_string_lossy().into_owned())
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
    use crate::orbit::tests::{MockGateway, spawn_rejecting_server};

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
    }

    #[test]
    fn a_delete_from_a_superseded_attempt_clears_nothing() {
        let gateway = MockGateway::new(|_| {
            Err(conn_orbit::gateway::GatewayError::Network(
                "offline".to_owned(),
            ))
        });
        let recorder = Arc::new(Recorder::default());
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            None,
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
        let session = ConnSession::with_orbit(
            OrbitCore::with_transport(gateway).expect("orbit"),
            None,
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
}
